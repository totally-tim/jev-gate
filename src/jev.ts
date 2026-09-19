import { TypeSafeClient, type EntryType, type Fetch, type Questions, type RetryPolicy } from "@typesafe-ai/sdk";
import type { Provider } from "./types.js";

/** Input price from the TypeSafe docs and the OpenRouter model page, read 2026-09-19. Output is free. */
export const USD_PER_INPUT_TOKEN = 0.042 / 1_000_000;

export const costUSD = (inputTokens: number): number => inputTokens * USD_PER_INPUT_TOKEN;

/** Environment variable each provider reads when no api-key input is given. */
export const PROVIDER_ENV_KEYS: Record<Provider, string> = {
  typesafe: "TYPESAFE_API_KEY",
  openrouter: "OPENROUTER_API_KEY",
};

/** API root override for tests and self-hosted gateways. */
export const PROVIDER_BASE_URL_ENV: Record<Provider, string> = {
  typesafe: "TYPESAFE_BASE_URL",
  openrouter: "OPENROUTER_BASE_URL",
};

export class JevProviderError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
  ) {
    super(message);
  }
}

export interface JevReviewRequest {
  provider: Provider;
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
  /** OpenRouter ranking headers; ignored by other providers. */
  app?: { referer?: string; title?: string };
}

export interface JevReviewResponse {
  model: string;
  answers: Record<string, unknown>;
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
}

/**
 * One batched decisions request. Every enabled rule is a question about the same state,
 * so the fixed request overhead is paid once and the questions run in parallel server-side.
 */
export async function runJevReview(request: JevReviewRequest): Promise<JevReviewResponse> {
  if (request.provider === "typesafe") return runTypeSafe(request);
  if (request.provider === "openrouter") return runOpenRouter(request);
  throw new JevProviderError(`unknown provider: ${String(request.provider)}`, null);
}

async function runTypeSafe(request: JevReviewRequest): Promise<JevReviewResponse> {
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

const OPENROUTER_DEFAULT_BASE = "https://openrouter.ai";
const RETRYABLE_STATUSES = new Set([408, 429, 500, 502, 503, 504, 529]);

interface OpenRouterPayload {
  model?: unknown;
  answers?: unknown;
  usage?: {
    input_tokens?: unknown;
    prompt_tokens?: unknown;
    output_tokens?: unknown;
    completion_tokens?: unknown;
  };
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const numberOr = (value: unknown, fallback: number): number =>
  typeof value === "number" && Number.isFinite(value) ? value : fallback;

function withTimeout(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  if (!signal) return timeout;
  return typeof AbortSignal.any === "function" ? AbortSignal.any([signal, timeout]) : timeout;
}

async function errorDetail(response: Response): Promise<string> {
  try {
    const payload = (await response.json()) as { error?: { message?: string }; message?: string };
    const message = payload.error?.message ?? payload.message;
    return message ? `: ${message}` : "";
  } catch {
    return "";
  }
}

async function runOpenRouter(request: JevReviewRequest): Promise<JevReviewResponse> {
  const base = (request.baseURL ?? process.env.OPENROUTER_BASE_URL ?? OPENROUTER_DEFAULT_BASE).replace(
    /\/+$/,
    "",
  );
  const url = `${base}/api/alpha/decisions`;
  const maxRetries = request.retry?.maxRetries ?? 2;
  const backoffMs = request.retry?.backoffInitialMs ?? 500;
  const timeoutMs = request.timeoutMs ?? 20_000;
  const fetchImpl = request.fetchImpl ?? fetch;
  const headers: Record<string, string> = {
    Authorization: `Bearer ${request.apiKey}`,
    "Content-Type": "application/json",
    Accept: "application/json",
    "User-Agent": "jev-gate",
  };
  if (request.app?.referer) headers["HTTP-Referer"] = request.app.referer;
  if (request.app?.title) {
    headers["X-Title"] = request.app.title;
    headers["X-OpenRouter-Title"] = request.app.title;
  }
  const body = JSON.stringify({ model: request.model, state: request.state, questions: request.questions });
  const started = performance.now();

  let lastError: JevProviderError | null = null;
  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    if (attempt > 0) await sleep(backoffMs * 2 ** (attempt - 1));
    let response: Response;
    try {
      response = await fetchImpl(url, {
        method: "POST",
        headers,
        body,
        signal: withTimeout(request.signal, timeoutMs),
      });
    } catch (error) {
      lastError = new JevProviderError(
        `OpenRouter request failed: ${error instanceof Error ? error.message : String(error)}`,
        null,
      );
      if (attempt === maxRetries) break;
      continue;
    }
    if (!response.ok) {
      lastError = new JevProviderError(`OpenRouter answered ${response.status}${await errorDetail(response)}`, response.status);
      if (!RETRYABLE_STATUSES.has(response.status) || attempt === maxRetries) throw lastError;
      continue;
    }
    const payload = (await response.json()) as OpenRouterPayload;
    if (typeof payload.answers !== "object" || payload.answers === null || Array.isArray(payload.answers)) {
      throw new JevProviderError("OpenRouter response carried no answers object", null);
    }
    return {
      model: typeof payload.model === "string" ? payload.model : request.model,
      answers: payload.answers as Record<string, unknown>,
      inputTokens: numberOr(payload.usage?.input_tokens ?? payload.usage?.prompt_tokens, 0),
      outputTokens: numberOr(payload.usage?.output_tokens ?? payload.usage?.completion_tokens, 0),
      latencyMs: performance.now() - started,
    };
  }
  throw lastError ?? new JevProviderError("OpenRouter request failed", null);
}
