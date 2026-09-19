import { TypeSafeClient, type EntryType, type Fetch, type Questions, type RetryPolicy } from "@typesafe-ai/sdk";

/** Input price from the TypeSafe docs, read 2026-09-19. Output tokens are free. */
export const USD_PER_INPUT_TOKEN = 0.042 / 1_000_000;

export const costUSD = (inputTokens: number): number => inputTokens * USD_PER_INPUT_TOKEN;

export interface JevReviewRequest {
  apiKey: string;
  model: string;
  /** JSON-serializable state; typed loosely so callers need no index signature. */
  state: unknown;
  questions: Questions;
  baseURL?: string;
  fetchImpl?: Fetch;
  timeoutMs?: number;
  signal?: AbortSignal;
  retry?: Partial<RetryPolicy>;
}

export interface JevReviewResponse {
  model: string;
  answers: Record<string, unknown>;
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
}

/**
 * One batched call: every enabled rule is a question about the same state, so the fixed
 * request overhead is paid once and the questions run in parallel server-side.
 */
export async function runJevReview(request: JevReviewRequest): Promise<JevReviewResponse> {
  const client = new TypeSafeClient({
    apiKey: request.apiKey,
    baseURL: request.baseURL,
    defaultModel: request.model,
    fetch: request.fetchImpl,
    timeout: request.timeoutMs ?? 20_000,
    retry: request.retry,
    logLevel: "off",
  });
  const started = performance.now();
  const result = await client.systemOne(
    { state: request.state as EntryType, questions: request.questions },
    { signal: request.signal },
  );
  return {
    model: result.model,
    answers: result.answers as Record<string, unknown>,
    inputTokens: result.usage.input_tokens,
    outputTokens: result.usage.output_tokens,
    latencyMs: performance.now() - started,
  };
}
