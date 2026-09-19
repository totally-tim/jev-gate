import { buildQuestions, evaluate } from "./rules.js";
import { buildState } from "./state.js";
import { costUSD, runJevReview } from "./jev.js";
import type { ResolvedConfig, ReviewOutcome, DiffFile, PullRequestContext } from "./types.js";
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

/** The deterministic core both entry points share: state in, calibrated decisions out. */
export async function runReview(input: ReviewCoreInput): Promise<ReviewOutcome> {
  const enabled = input.config.rules.filter((rule) => rule.enabled);
  if (enabled.length === 0) {
    throw new Error("no rules are enabled; enable at least one rule in the config");
  }
  const { state, truncatedPaths } = buildState(input.pr, input.files, input.config);
  const questions = buildQuestions(enabled);
  const response = await runJevReview({
    apiKey: input.apiKey,
    model: input.config.model,
    state,
    questions,
    baseURL: input.baseURL,
    fetchImpl: input.fetchImpl,
    timeoutMs: input.timeoutMs,
    signal: input.signal,
    retry: input.retry,
  });
  const decisions = evaluate(enabled, response.answers);
  const failedGates = decisions.filter((decision) => decision.failed).map((decision) => decision.name);
  return {
    schema: 1,
    headSha: input.pr.headSha,
    baseSha: input.pr.baseSha,
    prNumber: input.pr.number,
    model: response.model,
    latencyMs: response.latencyMs,
    inputTokens: response.inputTokens,
    outputTokens: response.outputTokens,
    costUSD: costUSD(response.inputTokens),
    ranAt: new Date().toISOString(),
    truncated: state.truncated || truncatedPaths.length > 0,
    decisions,
    passed: failedGates.length === 0,
    failedGates,
  };
}
