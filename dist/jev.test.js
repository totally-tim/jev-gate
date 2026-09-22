import assert from "node:assert/strict";
import { test } from "node:test";
import { noul } from "@typesafe-ai/sdk";
import { JevProviderError, runJevReview } from "./jev.js";
const questions = { urgent: noul("Is it urgent?") };
function response(status, payload) {
    return new Response(JSON.stringify(payload), {
        status,
        headers: { "content-type": "application/json" },
    });
}
const request = {
    provider: "openrouter",
    apiKey: "key",
    model: "typesafe/jev-1.13",
    state: "x",
    questions,
    baseURL: "http://openrouter.test",
};
test("openrouter retries retryable failures and parses the answers", async () => {
    let calls = 0;
    const fetchImpl = async () => {
        calls += 1;
        if (calls === 1)
            return response(500, { error: { message: "upstream failed" } });
        return response(200, {
            model: "typesafe/jev-1.13",
            answers: { urgent: { type: "noul", noul: 0.9 } },
            usage: { input_tokens: 12, output_tokens: 0 },
        });
    };
    const result = await runJevReview({
        ...request,
        fetchImpl,
        retry: { maxRetries: 1, backoffInitialMs: 0 },
    });
    assert.equal(calls, 2);
    assert.equal(result.inputTokens, 12);
    assert.equal(result.model, "typesafe/jev-1.13");
    assert.equal(result.answers.urgent.noul, 0.9);
});
test("openrouter does not retry an authentication failure", async () => {
    let calls = 0;
    const fetchImpl = async () => {
        calls += 1;
        return response(401, { error: { message: "invalid key" } });
    };
    await assert.rejects(runJevReview({
        ...request,
        fetchImpl,
        retry: { maxRetries: 2, backoffInitialMs: 0 },
    }), (error) => error instanceof JevProviderError &&
        error.status === 401 &&
        /invalid key/.test(error.message));
    assert.equal(calls, 1);
});
test("openrouter tolerates an absent usage block", async () => {
    const fetchImpl = async () => response(200, { answers: { urgent: { type: "noul", noul: 0.5 } } });
    const result = await runJevReview({ ...request, fetchImpl });
    assert.equal(result.inputTokens, 0);
    assert.equal(result.outputTokens, 0);
    assert.equal(result.model, "typesafe/jev-1.13");
});
test("an unknown provider is refused", async () => {
    await assert.rejects(runJevReview({ ...request, provider: "nonsense" }), /unknown provider/);
});
test("local-decide uses the native gateway and keeps the requested model", async () => {
    const saved = process.env.TYPESAFE_BASE_URL;
    delete process.env.TYPESAFE_BASE_URL;
    try {
        let target = "";
        const result = await runJevReview({
            provider: "typesafe", apiKey: "test", model: "local-decide", state: "x", questions,
            fetchImpl: async (url, init) => {
                target = String(url);
                assert.equal(JSON.parse(String(init?.body)).model, "local-decide");
                return response(200, {
                    model: "kev-latest", answers: { urgent: { type: "noul", noul: 0.9 } },
                    usage: { input_tokens: 12, output_tokens: 0 },
                });
            },
        });
        assert.equal(target, "https://inference.svpg.dev/svpg/kev/v1/systemone");
        assert.equal(result.model, "kev-latest");
    }
    finally {
        if (saved === undefined)
            delete process.env.TYPESAFE_BASE_URL;
        else
            process.env.TYPESAFE_BASE_URL = saved;
    }
});
