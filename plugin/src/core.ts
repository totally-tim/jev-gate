import { createHash } from "node:crypto";
import { isAbsolute, join } from "node:path";

/** Everything the plugin needs after options are validated and defaults are applied. */
export interface ResolvedOptions {
  /** Explicit base ref for `jev-gate diff`; detection happens in the CLI when unset. */
  base: string | undefined;
  /** Executable for the jev-gate CLI; a bare name resolves on PATH. */
  cli: string;
  /** Arguments baked into the `cli` string, if it carried any. */
  cliArgs: string[];
  intervalMs: number;
  /** False records findings in the ledger only; true also briefs the agent. */
  inject: boolean;
  /** Absolute path of the JSONL ledger. */
  ledgerPath: string;
  provider: "typesafe" | "openrouter" | undefined;
  model: string | undefined;
  /** Passed to the child environment under the provider's key name. */
  apiKey: string | undefined;
  timeoutMs: number;
}

export const MIN_INTERVAL_MS = 1_000;
export const MAX_INTERVAL_MS = 24 * 60 * 60 * 1_000;
export const DEFAULT_INTERVAL_MS = 120_000;
export const DEFAULT_TIMEOUT_MS = 60_000;
export const DEFAULT_CLI = "jev-gate";
export const DEFAULT_LEDGER_SUFFIX = join(".jev-gate", "ledger.jsonl");

function stringOption(options: Record<string, unknown>, key: string): string | undefined {
  const value = options[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`options.${key} must be a non-empty string`);
  }
  return value.trim();
}

/**
 * Validate the plugin options from opencode.json(c). Anything malformed throws, because a
 * plugin that silently stops watching is worse than one that fails to load.
 */
export function resolveOptions(raw: unknown, defaults: { directory: string }): ResolvedOptions {
  if (raw !== undefined && raw !== null && (typeof raw !== "object" || Array.isArray(raw))) {
    throw new Error("options must be a mapping");
  }
  const options = (raw ?? {}) as Record<string, unknown>;

  const base = stringOption(options, "base");
  const cli = stringOption(options, "cli") ?? DEFAULT_CLI;
  const cliParts = cli.split(/\s+/);
  const cliCommand = cliParts[0] as string;

  const intervalRaw = options.intervalMs;
  if (
    intervalRaw !== undefined &&
    (typeof intervalRaw !== "number" ||
      !Number.isInteger(intervalRaw) ||
      intervalRaw < MIN_INTERVAL_MS ||
      intervalRaw > MAX_INTERVAL_MS)
  ) {
    throw new Error(`options.intervalMs must be an integer between ${MIN_INTERVAL_MS} and ${MAX_INTERVAL_MS}`);
  }
  const intervalMs = (intervalRaw as number | undefined) ?? DEFAULT_INTERVAL_MS;

  const injectRaw = options.inject;
  if (injectRaw !== undefined && typeof injectRaw !== "boolean") {
    throw new Error("options.inject must be a boolean");
  }

  const providerRaw = options.provider;
  if (providerRaw !== undefined && providerRaw !== "typesafe" && providerRaw !== "openrouter") {
    throw new Error("options.provider must be typesafe or openrouter");
  }

  const timeoutRaw = options.timeoutMs;
  if (
    timeoutRaw !== undefined &&
    (typeof timeoutRaw !== "number" || !Number.isInteger(timeoutRaw) || timeoutRaw < 1_000)
  ) {
    throw new Error("options.timeoutMs must be an integer of at least 1000");
  }

  const ledger = stringOption(options, "ledger");
  for (const key of Object.keys(options)) {
    if (!["base", "cli", "intervalMs", "inject", "ledger", "provider", "model", "apiKey", "timeoutMs"].includes(key)) {
      throw new Error(`options.${key} is not a known setting`);
    }
  }

  return {
    base,
    cli: cliCommand,
    cliArgs: cliParts.slice(1),
    intervalMs,
    inject: injectRaw ?? false,
    ledgerPath: ledger === undefined || ledger === "" ? join(defaults.directory, DEFAULT_LEDGER_SUFFIX) : isAbsolute(ledger) ? ledger : join(defaults.directory, ledger),
    provider: providerRaw as ResolvedOptions["provider"],
    model: stringOption(options, "model"),
    apiKey: stringOption(options, "apiKey"),
    timeoutMs: (timeoutRaw as number | undefined) ?? DEFAULT_TIMEOUT_MS,
  };
}

/** Stable short fingerprint of one diff, used to dedupe reviews and label the ledger. */
export function hashDiff(diff: string): string {
  return createHash("sha256").update(diff).digest("hex").slice(0, 12);
}

/** The parts of a review outcome the plugin reads; everything else is ignored on purpose. */
export interface DecisionView {
  name: string;
  gate: boolean;
  threshold: number;
  probability: number | null;
  exceeded: boolean;
  failed: boolean;
  error: string | null;
  samples?: number[];
}

export interface OutcomeView {
  model: string;
  rulesHash: string;
  headSha: string;
  inputTokens: number;
  costUSD: number;
  failedGates: string[];
  erroredGates: string[];
  decisions: DecisionView[];
}

const numberOr = (value: unknown, fallback: number): number =>
  typeof value === "number" && Number.isFinite(value) ? value : fallback;

/**
 * Read `jev-gate review --json` output defensively: the plugin acts on child-process
 * output, so a shape it does not recognize becomes null instead of a crash.
 */
export function parseOutcome(stdout: string): OutcomeView | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const record = parsed as Record<string, unknown>;
  if (!Array.isArray(record.decisions) || !Array.isArray(record.failedGates)) return null;

  const decisions: DecisionView[] = [];
  for (const entry of record.decisions) {
    if (typeof entry !== "object" || entry === null) continue;
    const decision = entry as Record<string, unknown>;
    if (typeof decision.name !== "string") continue;
    decisions.push({
      name: decision.name,
      gate: decision.gate === true,
      threshold: numberOr(decision.threshold, 0),
      probability: typeof decision.probability === "number" ? decision.probability : null,
      exceeded: decision.exceeded === true,
      failed: decision.failed === true,
      error: typeof decision.error === "string" ? decision.error : null,
      samples: Array.isArray(decision.samples)
        ? decision.samples.filter((value): value is number => typeof value === "number")
        : undefined,
    });
  }
  return {
    model: typeof record.model === "string" ? record.model : "unknown",
    rulesHash: typeof record.rulesHash === "string" ? record.rulesHash : "",
    headSha: typeof record.headSha === "string" ? record.headSha : "",
    inputTokens: numberOr(record.inputTokens, 0),
    costUSD: numberOr(record.costUSD, 0),
    failedGates: record.failedGates.filter((name): name is string => typeof name === "string"),
    erroredGates: Array.isArray(record.erroredGates)
      ? record.erroredGates.filter((name): name is string => typeof name === "string")
      : [],
    decisions,
  };
}

const percent = (value: number): string => `${Math.round(value * 100)}%`;

/**
 * The briefing the agent receives before its next model call. It deliberately names the
 * diff it judged, says the judgment is whole-diff and fallible, and asks for a check rather
 * than a score fix, because the failure mode of an injected score is an agent gaming it.
 */
export function formatBriefing(outcome: OutcomeView, diffHash: string): string | null {
  const failed = outcome.decisions.filter((decision) => decision.failed);
  if (failed.length === 0) return null;
  const headline =
    failed.length === 1
      ? `jev-gate reviewed the local change set (diff ${diffHash}) and one gated rule is at or above its threshold:`
      : `jev-gate reviewed the local change set (diff ${diffHash}) and ${failed.length} gated rules are at or above their thresholds:`;
  const lines = [headline];
  for (const decision of failed) {
    const asks =
      decision.samples !== undefined && decision.samples.length > 1
        ? ` (two asks: ${decision.samples.map(percent).join(", ")})`
        : "";
    const probability = decision.probability === null ? "n/a" : percent(decision.probability);
    lines.push(`- ${decision.name}: ${probability} concern against a ${percent(decision.threshold)} threshold${asks}.`);
  }
  lines.push(
    "Treat this as a prompt to check the change, not as a verdict: jev-gate judges the whole diff, not specific lines, and its numbers can be wrong. If the finding is real, fix it; if it is not, say why. Do not edit code just to move the number.",
  );
  return lines.join("\n");
}

/** The diff hash recorded by the previous review, so a new session does not pay for it again. */
export function lastLedgerHash(ledgerText: string): string | null {
  const lines = ledgerText.split("\n");
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = (lines[index] ?? "").trim();
    if (line === "") continue;
    try {
      const record = JSON.parse(line) as { diffHash?: unknown };
      if (typeof record.diffHash === "string" && record.diffHash !== "") return record.diffHash;
    } catch {
      // A partial trailing write is not a record; keep looking upward.
    }
  }
  return null;
}

/** A delivery record: the briefing for this diff reached a model call. */
export function deliveryLine(diffHash: string, detail: { agent: string; messages: number }): string {
  return `${JSON.stringify({
    ranAt: new Date().toISOString(),
    diffHash,
    delivered: true,
    agent: detail.agent,
    messages: detail.messages,
  })}\n`;
}

/** One JSONL ledger record; the raw material for tuning intervals and confirmation rules. */
export function ledgerLine(
  outcome: OutcomeView,
  diffHash: string,
  extra: { injected: boolean },
): string {
  return `${JSON.stringify({
    ranAt: new Date().toISOString(),
    diffHash,
    model: outcome.model,
    rulesHash: outcome.rulesHash,
    headSha: outcome.headSha,
    failedGates: outcome.failedGates,
    erroredGates: outcome.erroredGates,
    decisions: outcome.decisions,
    inputTokens: outcome.inputTokens,
    costUSD: outcome.costUSD,
    injected: extra.injected,
  })}\n`;
}
