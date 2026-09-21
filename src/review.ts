import { buildQuestions, evaluate, rulesForPath } from "./rules.js";
import {
  buildState,
  candidatesFor,
  estimateTokens,
  isIgnored,
} from "./state.js";
import { costUSD, runJevReview, type JevReviewRequest } from "./jev.js";
import { hash, rulesHashFor, STATE_VERSION } from "./snapshot.js";
import { scanSecrets, redactText } from "./secrets.js";
import { ConfigError } from "./config.js";
import type {
  Candidate,
  CoverageEntry,
  Finding,
  ReviewOutcome,
  ReviewSnapshot,
  RuleDecision,
} from "./types.js";
import type { Fetch, RetryPolicy } from "@typesafe-ai/sdk";
export { rulesHashFor } from "./snapshot.js";
export interface ReviewCoreInput {
  snapshot: ReviewSnapshot;
  apiKey: string;
  fetchImpl?: Fetch;
  baseURL?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  retry?: Partial<RetryPolicy>;
}
export function finishOutcome(outcome: ReviewOutcome): ReviewOutcome {
  const active = outcome.findings.filter((f) => f.status === "open");
  const gated = new Set(
    outcome.decisions.filter((d) => d.gate).map((d) => d.name),
  );
  // A deterministic secret finding uses the same configured gate as the semantic rule.
  outcome.failedGates = [
    ...new Set(active.filter((f) => gated.has(f.rule)).map((f) => f.rule)),
  ];
  outcome.status =
    outcome.health === "unavailable"
      ? "unavailable"
      : outcome.health === "partial"
        ? "incomplete"
        : active.length
          ? "needs-review"
          : "clear";
  outcome.passed =
    outcome.health === "complete" &&
    (outcome.mode === "advisory" || outcome.failedGates.length === 0);
  return outcome;
}
export function reviewExitCode(outcome: ReviewOutcome, noGate = false): number {
  if (outcome.health !== "complete") return 2;
  return !noGate && outcome.mode === "required" && outcome.failedGates.length
    ? 1
    : 0;
}
export async function runReview(
  input: ReviewCoreInput,
): Promise<ReviewOutcome> {
  const { snapshot } = input,
    { config, pr } = snapshot;
  const enabled = config.rules.filter((r) => r.enabled);
  if (!enabled.length) throw new ConfigError("no rules are enabled");
  const ruleHash = rulesHashFor(enabled);
  const scanned = scanSecrets(
    snapshot.files.filter((f) => !isIgnored(f.path, config.ignore)),
  );
  const secretRule = enabled.find((r) => r.name === "danger-secret-material");
  const outcome: ReviewOutcome = {
    schema: 2,
    snapshotId: snapshot.id,
    contentHash: snapshot.contentHash,
    policyHash: snapshot.policyHash,
    configSource: snapshot.configSource,
    headSha: pr.headSha,
    baseSha: pr.baseSha,
    prNumber: pr.number,
    provider: config.provider,
    model: config.model,
    rulesHash: ruleHash,
    stateVersion: STATE_VERSION,
    mode: config.mode,
    latencyMs: 0,
    inputTokens: 0,
    outputTokens: 0,
    costUSD: 0,
    ranAt: new Date().toISOString(),
    health: "complete",
    status: "clear",
    coverage: { files: [], warnings: [...snapshot.warnings] },
    findings: secretRule
      ? scanned.findings.map((f) => ({
          ...f,
          id: hash({ id: f.id, policy: snapshot.policyHash }).slice(0, 24),
        }))
      : [],
    decisions: [],
    passed: false,
    failedGates: [],
    erroredGates: [],
    errors: [],
  };
  const safePr = {
    ...pr,
    title: redactText(pr.title),
    body: redactText(pr.body),
    author: redactText(pr.author),
    baseRef: redactText(pr.baseRef),
  };
  if (pr.changedFiles > snapshot.files.length)
    outcome.coverage.warnings.push(
      `Collected ${snapshot.files.length} of ${pr.changedFiles} changed files.`,
    );
  const safeFiles = new Map(scanned.files.map((f) => [f.path, f]));
  const jobs: Array<{
    candidate: Candidate;
    coverage: CoverageEntry;
    rules: typeof enabled;
  }> = [];
  for (const original of snapshot.files) {
    if (isIgnored(original.path, config.ignore)) {
      outcome.coverage.files.push({
        path: original.path,
        status: "excluded",
        reason: "Excluded by policy",
        reviewedChunks: 0,
        totalChunks: 0,
      });
      continue;
    }
    if (original.patchWarning)
      outcome.coverage.warnings.push(
        `${original.path}: ${original.patchWarning}`,
      );
    const rules = rulesForPath(enabled, original.path);
    if (!rules.length) {
      outcome.coverage.files.push({
        path: original.path,
        status: "excluded",
        reason: "No enabled rules apply to this path",
        reviewedChunks: 0,
        totalChunks: 0,
      });
      continue;
    }
    const file = safeFiles.get(original.path)!;
    const candidates = candidatesFor(
      file,
      Math.max(512, Math.min(12_000, config.maxStateTokens - 2500)),
    );
    const coverage: CoverageEntry = {
      path: file.path,
      status: "unavailable",
      reason: candidates.length ? null : (original.patchWarning ?? "No textual patch was available"),
      reviewedChunks: 0,
      totalChunks: candidates.length,
    };
    outcome.coverage.files.push(coverage);
    for (const candidate of candidates)
      jobs.push({ candidate, coverage, rules });
  }
  let requests = 0,
    successful = 0,
    resolvedModel: string | undefined;
  const decisionsFor = async (
    candidate: Candidate,
    rules: typeof enabled,
  ): Promise<RuleDecision[]> => {
    if (!input.apiKey)
      throw new Error(`No API key is available for ${config.provider}`);
    if (input.signal?.aborted) throw new Error("Review cancelled");
    if (requests >= config.maxRequests)
      throw new Error(`Request budget of ${config.maxRequests} reached`);
    const state = buildState(safePr, candidate, scanned.files);
    // Optional context must not make an otherwise reviewable candidate exceed its budget.
    if (estimateTokens(JSON.stringify(state)) > config.maxStateTokens)
      delete state.fileContext;
    if (estimateTokens(JSON.stringify(state)) > config.maxStateTokens)
      throw new Error(
        "Candidate exceeds the state budget; its content was not sent",
      );
    requests++;
    const request: JevReviewRequest = {
      provider: config.provider,
      apiKey: input.apiKey,
      model: config.model,
      state,
      questions: buildQuestions(rules),
      baseURL: input.baseURL,
      fetchImpl: input.fetchImpl,
      timeoutMs: input.timeoutMs,
      signal: input.signal,
      retry: input.retry,
      app: config.openrouter,
    };
    const response = await runJevReview(request);
    outcome.inputTokens += response.inputTokens;
    outcome.outputTokens += response.outputTokens;
    outcome.latencyMs += response.latencyMs;
    if (resolvedModel && response.model !== resolvedModel)
      throw new Error(
        "The provider changed models during this review; pin a model and retry",
      );
    resolvedModel = response.model;
    outcome.model = response.model;
    const { patch: _, ...location } = candidate;
    return evaluate(rules, response.answers, location);
  };
  // Bounded parallelism keeps large reviews responsive and preserves deterministic output order.
  const results: Array<{ decisions: RuleDecision[]; error?: string }> =
    new Array(jobs.length);
  let next = 0;
  const worker = async () => {
    while (next < jobs.length) {
      const index = next++,
        { candidate, rules } = jobs[index]!;
      try {
        const decisions = await decisionsFor(candidate, rules);
        const borderline = rules.filter(
          (r) =>
            r.gate &&
            config.borderlineMargin > 0 &&
            decisions.some(
              (d) =>
                d.name === r.name &&
                d.value !== null &&
                Math.abs(d.value - r.threshold) <= config.borderlineMargin,
            ),
        );
        if (borderline.length) {
          const second = await decisionsFor(candidate, borderline);
          for (const d of decisions) {
            const again = second.find((a) => a.name === d.name);
            if (!again) continue;
            if (again.error || again.value === null || d.value === null) {
              d.error = again.error ?? "Second observation unavailable";
              continue;
            }
            d.samples = [d.value, again.value];
            d.value = (d.value + again.value) / 2;
            if (d.kind === "noul") d.probability = d.value;
            else d.level = d.value * ((d.levels ?? 2) - 1);
            d.exceeded = d.value >= d.threshold;
            d.failed = d.gate && d.exceeded;
          }
        }
        results[index] = { decisions };
      } catch (error) {
        results[index] = {
          decisions: [],
          error: redactText(
            error instanceof Error ? error.message : String(error),
          ),
        };
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(4, jobs.length) }, () => worker()),
  );
  for (let index = 0; index < jobs.length; index++) {
    const { candidate, coverage } = jobs[index]!,
      result = results[index]!;
    outcome.decisions.push(...result.decisions);
    const errors = result.error
      ? [result.error]
      : result.decisions
          .filter((d) => d.error)
          .map((d) => `${d.name}: ${d.error}`);
    if (errors.length) {
      coverage.reason = [coverage.reason, ...errors].filter(Boolean).join("; ");
      outcome.errors.push(...errors.map((e) => `${candidate.path}: ${e}`));
    } else {
      coverage.reviewedChunks++;
      successful++;
    }
    for (const d of result.decisions.filter(
      (d) => d.exceeded && d.error === null,
    )) {
      const rule = enabled.find((r) => r.name === d.name)!;
      outcome.findings.push({
        id: hash({
          rule: d.name,
          rules: ruleHash,
          policy: snapshot.policyHash,
          candidate: candidate.id,
          model: outcome.model,
        }).slice(0, 24),
        rule: d.name,
        title: d.title,
        category:
          d.name === "danger-sensitive-area"
            ? "review-request"
            : "potential-issue",
        path: candidate.path,
        startLine: candidate.startLine,
        endLine: candidate.endLine,
        side: candidate.side,
        evidence:
          "Jev flagged this candidate. The location identifies reviewed code; it does not establish a defect or identify an exact causal line.",
        verification: rule.verification,
        value: d.value!,
        kind: d.kind,
        source: "jev",
        status: "open",
      });
    }
  }
  // Preserve the local secret rule's policy even if the remote provider is unavailable.
  if (
    secretRule &&
    outcome.findings.some((f) => f.source === "local") &&
    !outcome.decisions.some((d) => d.name === secretRule.name)
  ) {
    outcome.decisions.push({
      name: secretRule.name,
      title: secretRule.title,
      kind: "noul",
      gate: secretRule.gate,
      threshold: secretRule.threshold,
      value: 1,
      probability: 1,
      exceeded: true,
      failed: secretRule.gate,
      error: null,
      candidate: {
        id: "local-secret-scan",
        path: "",
        startLine: null,
        endLine: null,
        side: "new",
        status: "local",
      },
    });
  }
  for (const c of outcome.coverage.files)
    if (c.status !== "excluded")
      c.status =
        c.totalChunks > 0 && c.reviewedChunks === c.totalChunks
          ? "reviewed"
          : c.reviewedChunks > 0
            ? "partial"
            : "unavailable";
  const incomplete =
    outcome.coverage.warnings.length > 0 ||
    outcome.coverage.files.some(
      (c) => c.status === "partial" || c.status === "unavailable",
    );
  outcome.health = incomplete
    ? successful > 0
      ? "partial"
      : "unavailable"
    : "complete";
  outcome.erroredGates = [
    ...new Set(
      outcome.decisions.filter((d) => d.gate && d.error).map((d) => d.name),
    ),
  ];
  outcome.costUSD = costUSD(outcome.inputTokens);
  outcome.findings = [
    ...new Map(outcome.findings.map((f) => [f.id, f])).values(),
  ];
  outcome.errors = [...new Set(outcome.errors)];
  return finishOutcome(outcome);
}
