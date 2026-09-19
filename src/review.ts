import { createHash } from "node:crypto";
import { buildQuestions, evaluate } from "./rules.js";
import { buildState } from "./state.js";
import { costUSD, runJevReview } from "./jev.js";
import type { ResolvedConfig, ResolvedRule, ReviewOutcome, DiffFile, PullRequestContext } from "./types.js";
import type { Fetch, RetryPolicy } from "@typesafe-ai/sdk";

export interface ReviewCoreInput {
  pr: PullRequestContext;
  files: readonly DiffFile[];
  config: ResolvedConfig;
  apiKey: string;
  fetchImpl?: Fetch;
  baseURL?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  retry?: Partial<RetryPolicy>;
}

/** Fingerprint the rule wording so field records survive rule edits. */
export function rulesHashFor(rules: readonly ResolvedRule[]): string {
  return createHash("sha256")
    .update(rules.map((rule) => `${rule.name}:${rule.instructions}`).join("\n"))
    .digest("hex")
    .slice(0, 12);
}

/** The deterministic core both entry points share: state in, calibrated decisions out. */
export async function runReview(input: ReviewCoreInput): Promise<ReviewOutcome> {
  const enabled = input.config.rules.filter((rule) => rule.enabled);
  if (enabled.length === 0) {
    throw new Error("no rules are enabled; enable at least one rule in the config");
  }
  const { state, truncatedPaths } = buildState(input.pr, input.files, input.config);
  const questions = buildQuestions(enabled);
  const response = await runJevReview({
    provider: input.config.provider,
    apiKey: input.apiKey,
    model: input.config.model,
    state,
    questions,
    baseURL: input.baseURL,
    fetchImpl: input.fetchImpl,
    timeoutMs: input.timeoutMs,
    signal: input.signal,
    retry: input.retry,
    app: input.config.openrouter,
  });
  const decisions = evaluate(enabled, response.answers);
  const failedGates = decisions.filter((decision) => decision.failed).map((decision) => decision.name);
  const erroredGates = decisions
    .filter((decision) => decision.gate && decision.error !== null)
    .map((decision) => decision.name);
  return {
    schema: 1,
    headSha: input.pr.headSha,
    baseSha: input.pr.baseSha,
    prNumber: input.pr.number,
    model: response.model,
    rulesHash: rulesHashFor(enabled),
    latencyMs: response.latencyMs,
    inputTokens: response.inputTokens,
    outputTokens: response.outputTokens,
    costUSD: costUSD(response.inputTokens),
    ranAt: new Date().toISOString(),
    truncated: state.truncated || truncatedPaths.length > 0,
    decisions,
    passed: failedGates.length === 0 && erroredGates.length === 0,
    failedGates,
    erroredGates,
  };
}
