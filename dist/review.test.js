import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveConfig, validateConfigDocument } from "./config.js";
import { costUSD } from "./jev.js";
import { runReview } from "./review.js";
function pullRequest() {
    return {
        owner: "o",
        repo: "r",
        number: 3,
        title: "Change auth flow",
        body: "Updates the login path.",
        author: "dev",
        baseRef: "main",
        baseSha: "b".repeat(40),
        headSha: "h".repeat(40),
        changedFiles: 1,
        additions: 4,
        deletions: 1,
        commits: 1,
        htmlUrl: "https://example.test/pr/3",
    };
}
const files = [
    {
        path: "src/auth.ts",
        status: "modified",
        additions: 4,
        deletions: 1,
        patch: "@@ -1,2 +1,5 @@\n-old\n+new\n",
    },
];
/** A fake decisions endpoint that answers every question with the supplied probability. */
function fakeEndpoint(calls, probability) {
    return async (input, init) => {
        const body = JSON.parse(String(init?.body));
        calls.push({ url: String(input), headers: (init?.headers ?? {}), body });
        const answers = {};
        for (const [name, question] of Object.entries(body.questions)) {
            const value = name === "danger-sensitive-area" ? probability : 0.1;
            answers[name] =
                question.type === "noul"
                    ? { type: "noul", noul: value }
                    : {
                        type: "score",
                        // test-meaningfulness gets a weak-tests answer so the advisory warn path is exercised.
                        score: name === "test-meaningfulness" ? 1.8 : value * 2,
                        confidence: 0.9,
                    };
        }
        return new Response(JSON.stringify({ model: "jev-test", answers, usage: { input_tokens: 900, output_tokens: 0 } }), { status: 200, headers: { "content-type": "application/json" } });
    };
}
test("a full review batches every rule into one request and fails only gated rules", async () => {
    const calls = [];
    const outcome = await runReview({
        pr: pullRequest(),
        files,
        config: resolveConfig(validateConfigDocument({})),
        apiKey: "test-key",
        fetchImpl: fakeEndpoint(calls, 0.8),
    });
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.url.endsWith("/v1/systemone"), true);
    assert.equal(calls[0]?.body.model, "jev-latest");
    assert.equal(Object.keys(calls[0]?.body.questions ?? {}).length, 7);
    assert.equal(calls[0]?.body.state.files[0]?.path, "src/auth.ts");
    assert.equal(calls[0]?.body.state.pr.title, "Change auth flow");
    assert.deepEqual(outcome.failedGates, ["danger-sensitive-area"]);
    assert.equal(outcome.passed, false);
    assert.equal(outcome.truncated, false);
    assert.ok(Math.abs(outcome.costUSD - costUSD(900)) < 1e-12);
    const advisory = outcome.decisions.find((decision) => decision.name === "test-meaningfulness");
    assert.equal(advisory?.exceeded, true);
    assert.equal(advisory?.failed, false, "advisory rules never fail the run");
});
test("a clean review passes all gates", async () => {
    const outcome = await runReview({
        pr: pullRequest(),
        files,
        config: resolveConfig(validateConfigDocument({})),
        apiKey: "test-key",
        fetchImpl: fakeEndpoint([], 0.1),
    });
    assert.equal(outcome.passed, true);
    assert.deepEqual(outcome.failedGates, []);
});
test("the openrouter provider uses the decisions endpoint and the provider model", async () => {
    const calls = [];
    const outcome = await runReview({
        pr: pullRequest(),
        files,
        config: resolveConfig(validateConfigDocument({ provider: "openrouter" })),
        apiKey: "test-key",
        baseURL: "http://openrouter.test",
        fetchImpl: fakeEndpoint(calls, 0.8),
    });
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.url, "http://openrouter.test/api/alpha/decisions");
    assert.equal(calls[0]?.headers["Authorization"], "Bearer test-key");
    assert.equal(calls[0]?.body.model, "~typesafe/jev-latest");
    assert.equal(Object.keys(calls[0]?.body.questions ?? {}).length, 7);
    assert.deepEqual(outcome.failedGates, ["danger-sensitive-area"]);
});
test("a missing answer becomes an errored gate while the others keep their verdicts", async () => {
    const fetchImpl = async (_input, init) => {
        const body = JSON.parse(String(init?.body));
        const answers = {};
        for (const [name, question] of Object.entries(body.questions)) {
            if (name === "danger-deleted-tests")
                continue;
            answers[name] =
                question.type === "noul"
                    ? { type: "noul", noul: 0.05 }
                    : { type: "score", score: 0.1, confidence: 0.9 };
        }
        return new Response(JSON.stringify({ model: "jev-test", answers, usage: { input_tokens: 100, output_tokens: 0 } }), { status: 200, headers: { "content-type": "application/json" } });
    };
    const outcome = await runReview({
        pr: pullRequest(),
        files,
        config: resolveConfig(validateConfigDocument({})),
        apiKey: "test-key",
        fetchImpl,
    });
    assert.equal(outcome.passed, false);
    assert.deepEqual(outcome.erroredGates, ["danger-deleted-tests"]);
    assert.deepEqual(outcome.failedGates, []);
    assert.equal(outcome.decisions.find((decision) => decision.name === "comment-drift")?.error, null);
    assert.equal(outcome.rulesHash.length, 12);
});
test("an API failure surfaces instead of passing silently", async () => {
    const fetchImpl = async () => new Response("nope", { status: 500 });
    await assert.rejects(runReview({
        pr: pullRequest(),
        files,
        config: resolveConfig(validateConfigDocument({})),
        apiKey: "test-key",
        fetchImpl,
        retry: { maxRetries: 0 },
    }), 
    // The SDK raises its own API error type; the message carries the status.
    /500/);
});
