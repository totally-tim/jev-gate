import { TypeSafeClient } from "@typesafe-ai/sdk";
/** Input price from the TypeSafe docs, read 2026-09-19. Output tokens are free. */
export const USD_PER_INPUT_TOKEN = 0.042 / 1_000_000;
export const costUSD = (inputTokens) => inputTokens * USD_PER_INPUT_TOKEN;
/**
 * One batched call: every enabled rule is a question about the same state, so the fixed
 * request overhead is paid once and the questions run in parallel server-side.
 */
export async function runJevReview(request) {
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
    const result = await client.systemOne({ state: request.state, questions: request.questions }, { signal: request.signal });
    return {
        model: result.model,
        answers: result.answers,
        inputTokens: result.usage.input_tokens,
        outputTokens: result.usage.output_tokens,
        latencyMs: performance.now() - started,
    };
}
