import assert from "node:assert/strict";
import { test } from "node:test";
import { runReview, reviewExitCode } from "./review.js";
import { file, snapshot, endpoint } from "./test-fixtures.js";
import { rulesHashFor, parseSnapshot } from "./snapshot.js";
import { applyDispositions } from "./dispositions.js";
import { RULE_DEFINITIONS } from "./rules.js";
test("local-decide packs each candidate's rules into one request, four in flight, with full context", async () => {
    const calls = [];
    let active = 0, peak = 0;
    const respond = endpoint();
    const input = snapshot([
        file("@@ -1 +1 @@\n-old\n+new\n", "src/auth.ts"),
        file("@@ -1 +1 @@\n+" + "related ".repeat(300), "src/auth.test.ts"),
        ...["a", "b", "c", "d"].map((name) => file(undefined, `src/${name}.ts`)),
    ], { model: "local-decide" });
    input.pr.body = "description ".repeat(100);
    const outcome = await runReview({
        snapshot: input,
        apiKey: "test",
        fetchImpl: async (url, init) => {
            active++;
            peak = Math.max(peak, active);
            const request = JSON.parse(String(init?.body));
            assert.equal(request.model, "local-decide");
            calls.push(request);
            await new Promise((resolve) => setTimeout(resolve, 5));
            const response = await respond(url, init);
            active--;
            return response;
        },
    });
    assert.equal(peak, 4);
    assert.equal(calls.length, 6);
    assert.ok(calls.every((call) => Object.keys(call.questions).length === 5));
    // The shared state budget keeps optional context that the old 2,000-byte cap removed.
    const auth = calls.find((call) => call.state.relatedChanges.length);
    assert.ok(Buffer.byteLength(JSON.stringify(auth.state)) > 2000);
    assert.equal(auth.state.pr.description.length, 1000);
    assert.equal(outcome.decisions.length, 30);
    assert.equal(outcome.health, "complete");
    assert.equal(outcome.inputTokens, 600);
    assert.equal(outcome.costUSD, 0);
});
test("local-decide retries 529 and 429 answers after their Retry-After delay", async () => {
    const statuses = [];
    const respond = endpoint();
    const started = performance.now();
    const outcome = await runReview({
        snapshot: snapshot(undefined, { model: "local-decide" }),
        apiKey: "test",
        // The one-second server delay must replace this backoff, or the test takes a minute.
        retry: { backoffInitialMs: 30_000, backoffMaxMs: 30_000 },
        fetchImpl: async (url, init) => {
            const status = [529, 429][statuses.length] ?? 200;
            statuses.push(status);
            if (status !== 200)
                return new Response(JSON.stringify({
                    error: { type: "overloaded_error", message: "busy" },
                }), { status, headers: { "retry-after": "1" } });
            return respond(url, init);
        },
    });
    assert.deepEqual(statuses, [529, 429, 200]);
    const elapsed = performance.now() - started;
    assert.ok(elapsed >= 1900 && elapsed < 10_000, `waited ${elapsed} ms`);
    assert.equal(outcome.health, "complete");
    assert.equal(outcome.decisions.filter((d) => !d.error).length, 5);
});
test("local-decide reports a context-limit rejection as a gap without hiding other candidates", async () => {
    let calls = 0;
    const respond = endpoint({ "danger-sensitive-area": 0.99 });
    const outcome = await runReview({
        snapshot: snapshot([file(undefined, "src/auth.ts"), file(undefined, "src/big.ts")], { model: "local-decide" }),
        apiKey: "test",
        fetchImpl: async (url, init) => {
            calls++;
            if (String(init?.body).includes("src/big.ts"))
                return new Response(JSON.stringify({
                    error: { type: "max_tokens_exceeded", message: "max_tokens_exceeded" },
                }), { status: 400 });
            return respond(url, init);
        },
    });
    assert.equal(calls, 2, "a 400 is not retried");
    assert.equal(outcome.health, "partial");
    assert.equal(outcome.coverage.files.find((f) => f.path === "src/big.ts")?.status, "unavailable");
    assert.equal(outcome.coverage.files.find((f) => f.path === "src/auth.ts")?.status, "reviewed");
    assert.equal(outcome.findings[0]?.rule, "danger-sensitive-area");
    assert.ok(outcome.errors.some((error) => /src\/big\.ts: 400 max_tokens_exceeded/.test(error)));
});
test("test-quality scoring is opt-in and documentation stays outside its scope", async () => {
    const defaults = await runReview({
        snapshot: snapshot([file(undefined, "auth.test.ts")]),
        apiKey: "test",
        fetchImpl: endpoint({ "test-meaningfulness": 0.99 }),
    });
    assert.ok(!defaults.decisions.some((d) => d.name === "test-meaningfulness"));
    const rules = Object.fromEntries(RULE_DEFINITIONS.map((r) => [
        r.name,
        { enabled: r.name === "test-meaningfulness" },
    ]));
    const docs = await runReview({
        snapshot: snapshot([file("+These tests assert behavior", "docs/tests.md")], { rules }),
        apiKey: "",
    });
    assert.equal(docs.health, "complete");
    assert.equal(docs.coverage.files[0]?.status, "excluded");
    assert.match(docs.coverage.files[0]?.reason ?? "", /No enabled rules/);
    const optedIn = await runReview({
        snapshot: snapshot([file(undefined, "auth.test.ts")], { rules }),
        apiKey: "test",
        fetchImpl: endpoint({ "test-meaningfulness": 0.99 }),
    });
    assert.equal(optedIn.findings[0]?.rule, "test-meaningfulness");
});
test("sensitive changes produce located review requests without default blocking", async () => {
    const o = await runReview({
        snapshot: snapshot(),
        apiKey: "test",
        fetchImpl: endpoint({ "danger-sensitive-area": 0.99 }),
    });
    assert.equal(o.health, "complete");
    assert.equal(o.status, "needs-review");
    assert.equal(reviewExitCode(o), 0);
    assert.equal(o.findings[0]?.path, "src/auth.ts");
    assert.equal(o.findings[0]?.category, "review-request");
    assert.ok(o.findings[0]?.verification.includes("can be correct"));
});
test("required mode blocks configured findings, and explicit dispositions resolve them", async () => {
    const o = await runReview({
        snapshot: snapshot(undefined, { mode: "required" }),
        apiKey: "test",
        fetchImpl: endpoint({ "breaking-change": 0.99 }),
    });
    assert.equal(reviewExitCode(o), 1);
    const f = o.findings[0];
    applyDispositions(o, new Map([
        [
            f.id,
            {
                id: f.id,
                status: "accepted",
                reason: "Callers migrated in the coordinated release",
                at: new Date().toISOString(),
            },
        ],
    ]));
    assert.equal(reviewExitCode(o), 0);
    assert.equal(o.findings[0]?.status, "accepted");
});
test("every byte of a large textual patch enters a candidate or is declared unavailable", async () => {
    const calls = [], patch = "@@ -1 +1,1000 @@\n" +
        Array.from({ length: 1000 }, (_, i) => `+line${i} = ${i};`).join("\n");
    const o = await runReview({
        snapshot: snapshot([file(patch)]),
        apiKey: "test",
        fetchImpl: endpoint({}, calls),
    });
    assert.equal(o.health, "complete");
    assert.ok(calls.length > 1);
    assert.ok(JSON.stringify(calls).includes("line999"));
    const limited = await runReview({
        snapshot: snapshot([file(patch)], { maxRequests: 1 }),
        apiKey: "test",
        fetchImpl: endpoint(),
    });
    assert.equal(limited.health, "partial");
    assert.equal(reviewExitCode(limited, true), 2);
    assert.ok(limited.coverage.files[0].reviewedChunks <
        limited.coverage.files[0].totalChunks);
});
test("missing patches and provider errors cannot produce complete reviews", async () => {
    const missing = await runReview({
        snapshot: snapshot([{ ...file(), patch: null }]),
        apiKey: "",
        fetchImpl: endpoint(),
    });
    assert.equal(missing.health, "unavailable");
    assert.equal(missing.passed, false);
    const failure = await runReview({
        snapshot: snapshot(),
        apiKey: "test",
        fetchImpl: async () => new Response("bad key", { status: 401 }),
        retry: { maxRetries: 0 },
    });
    assert.equal(failure.health, "unavailable");
    assert.equal(reviewExitCode(failure), 2);
    const malformed = await runReview({
        snapshot: snapshot(),
        apiKey: "test",
        fetchImpl: endpoint({ "danger-deleted-tests": null }),
    });
    assert.equal(malformed.health, "unavailable");
    assert.deepEqual(malformed.erroredGates, ["danger-deleted-tests"]);
});
test("empty and excluded changes produce structured complete results without a provider", async () => {
    const o = await runReview({ snapshot: snapshot([]), apiKey: "" });
    assert.equal(o.schema, 2);
    assert.equal(o.status, "clear");
    const ignored = await runReview({
        snapshot: snapshot([file("+content", "dist/generated.js")]),
        apiKey: "",
    });
    assert.equal(ignored.coverage.files[0]?.status, "excluded");
    assert.equal(ignored.health, "complete");
});
test("secret values are withheld before provider calls while local findings retain locations", async () => {
    const credential = "ghp_" + "aB12".repeat(10), calls = [];
    const o = await runReview({
        snapshot: snapshot([
            file(`@@ -1 +1 @@\n-old\n+const token = '${credential}';`),
        ]),
        apiKey: "test",
        fetchImpl: endpoint({}, calls),
    });
    assert.ok(!JSON.stringify(calls).includes(credential));
    assert.ok(!JSON.stringify(o).includes(credential));
    assert.equal(o.findings[0]?.source, "local");
    assert.equal(o.findings[0]?.startLine, 1);
    const removed = await runReview({
        snapshot: snapshot([
            file(`@@ -1 +1 @@\n-const token = '${credential}';\n+useEnvironment();`),
        ]),
        apiKey: "test",
        fetchImpl: endpoint(),
    });
    assert.equal(removed.findings.filter((f) => f.source === "local").length, 0);
});
test("rubric, policy, model, and content changes invalidate snapshot identity", () => {
    const config = { rules: { "test-meaningfulness": { enabled: true } } };
    const a = snapshot(undefined, config), b = snapshot(undefined, config);
    assert.equal(a.id, b.id);
    assert.equal(parseSnapshot(JSON.stringify(a)).id, a.id);
    b.config.rules = b.config.rules.map((r) => r.rubric ? { ...r, rubric: ["changed", "criteria"] } : r);
    assert.notEqual(rulesHashFor(a.config.rules), rulesHashFor(b.config.rules));
    assert.throws(() => parseSnapshot(JSON.stringify(b)), /changed/);
    assert.notEqual(a.id, snapshot(undefined, { model: "different" }).id);
    assert.notEqual(a.id, snapshot([file("+different")]).id);
});
test("optional second observations retain raw values and fail transparently when missing", async () => {
    let n = 0;
    const calls = [];
    const o = await runReview({
        snapshot: snapshot(undefined, { mode: "required", borderlineMargin: 0.1 }),
        apiKey: "test",
        fetchImpl: async (url, init) => endpoint({ "breaking-change": ++n === 1 ? 0.55 : 0.65 }, calls)(url, init),
    });
    const d = o.decisions.find((d) => d.name === "breaking-change");
    assert.deepEqual(d.samples, [0.55, 0.65]);
    assert.ok(Math.abs(d.value - 0.6) < 1e-12);
    assert.equal(reviewExitCode(o), 1);
});
