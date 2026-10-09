import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveConfig, rulesForReturnedModel, validateConfigDocument } from "./config.js";
import { runReview, reviewExitCode } from "./review.js";
import { parseSnapshot } from "./snapshot.js";
import { renderSummary, renderPlainTable, renderComment } from "./render.js";
import { endpoint, file, snapshot } from "./test-fixtures.js";
const b50 = "djev-run8-run9-blend50-caa15c0b-9a12c814-nvfp4";
const thresholds = {
    "breaking-change": 0.39000000000000007,
    "comment-drift": 0.31000000000000005,
    "danger-deleted-tests": 0.5800000000000001,
    "danger-secret-material": 0.23000000000000004,
    "danger-sensitive-area": 0.11000000000000001,
};
const policy = { unknown: "unavailable", models: { [b50]: thresholds } };
const config = { model: "flex-decide", modelThresholds: policy };
function responseWithModel(model, values = {}, calls = []) {
    const respond = endpoint(values, calls);
    return async (url, init) => {
        const response = await respond(url, init);
        const body = await response.json();
        assert.ok(typeof body === "object" && body !== null);
        return new Response(JSON.stringify({ ...body, model }), { status: 200 });
    };
}
test("returned identity selects exact thresholds without changing shared base rules", async () => {
    const input = snapshot(undefined, config);
    const calls = [];
    const result = await runReview({ snapshot: input, apiKey: "test", fetchImpl: responseWithModel(b50, {
            "breaking-change": 0.39,
            "danger-sensitive-area": 0.12,
        }, calls) });
    assert.equal(result.health, "complete");
    assert.equal(result.model, b50);
    assert.equal(calls.length, 1);
    assert.ok(JSON.stringify(calls[0]).includes('"model":"flex-decide"'));
    assert.equal(result.decisions.find(d => d.name === "breaking-change")?.exceeded, false);
    assert.equal(result.decisions.find(d => d.name === "breaking-change")?.threshold, thresholds["breaking-change"]);
    assert.equal(result.decisions.find(d => d.name === "danger-sensitive-area")?.exceeded, true);
    assert.ok(input.config.rules.filter(r => r.enabled).every(r => r.threshold === 0.6));
    const atBoundary = await runReview({ snapshot: input, apiKey: "test", fetchImpl: responseWithModel(b50, {
            "breaking-change": thresholds["breaking-change"],
        }) });
    assert.equal(atBoundary.decisions.find(d => d.name === "breaking-change")?.exceeded, true);
});
test("Clef and unknown models follow the explicit unknown policy", async () => {
    for (const returned of ["clef", "unregistered", "constructor", "__proto__"]) {
        const unavailable = await runReview({ snapshot: snapshot(undefined, config), apiKey: "test", fetchImpl: responseWithModel(returned) });
        assert.equal(unavailable.health, "unavailable");
        assert.equal(reviewExitCode(unavailable), 2);
        assert.equal(unavailable.findings.length, 0);
        assert.ok(unavailable.errors.some(error => error.includes("No threshold policy")));
        const fallback = await runReview({ snapshot: snapshot(undefined, {
                ...config, modelThresholds: { ...policy, unknown: "base-thresholds" },
            }), apiKey: "test", fetchImpl: responseWithModel(returned, { "breaking-change": 0.4 }) });
        assert.equal(fallback.health, "complete");
        assert.equal(fallback.decisions.find(d => d.name === "breaking-change")?.threshold, 0.6);
        assert.equal(fallback.decisions.find(d => d.name === "breaking-change")?.exceeded, false);
        assert.equal(fallback.thresholdSource, "base-fallback");
        assert.match(renderSummary(fallback), /no fitted thresholds/);
        assert.match(renderPlainTable(fallback), /no fitted thresholds/);
    }
});
test("an omitted provider model ID cannot inherit the requested alias or its thresholds", async () => {
    const credential = "ghp_" + "aB12".repeat(10);
    for (const provider of ["typesafe", "openrouter"]) {
        for (const unknown of ["unavailable", "base-thresholds"]) {
            const result = await runReview({ snapshot: snapshot([file(`@@ -1 +1 @@\n-old\n+const token = '${credential}';`)], {
                    ...config, provider, model: b50, modelThresholds: { ...policy, unknown },
                }), apiKey: "test", fetchImpl: responseWithModel(undefined) });
            assert.equal(result.health, "unavailable");
            assert.equal(reviewExitCode(result), 2);
            assert.ok(result.findings.some(f => f.source === "local" && f.rule === "danger-secret-material"));
            assert.ok(result.failedGates.includes("danger-secret-material"));
            for (const output of [renderSummary(result), renderComment(result, null)]) {
                assert.match(output, /returned model ID/);
                assert.ok(!output.includes(credential));
            }
        }
    }
});
test("missing identity in a diagnostic follow-up leaves the finding and reports unavailable", async () => {
    let calls = 0;
    const result = await runReview({ snapshot: snapshot(undefined, {
            ...config, provider: "openrouter", model: b50, diagnostics: { enabled: true },
        }), apiKey: "test", fetchImpl: (url, init) => responseWithModel(calls++ ? undefined : b50, { "breaking-change": 0.8 })(url, init) });
    assert.ok(calls > 1);
    assert.equal(result.health, "complete");
    assert.equal(result.findings.find(f => f.rule === "breaking-change")?.diagnostic?.status, "unavailable");
    assert.equal(result.diagnostics?.health, "partial");
});
test("without a policy an initially omitted ID does not become a requested-model change", async () => {
    let calls = 0;
    const result = await runReview({ snapshot: snapshot([
            file(undefined, "src/a.ts"), file(undefined, "src/b.ts"),
        ], { provider: "typesafe", model: "flex-decide" }), apiKey: "test",
        fetchImpl: (url, init) => responseWithModel(calls++ ? b50 : undefined)(url, init) });
    assert.equal(calls, 2);
    assert.equal(result.health, "complete");
    assert.equal(result.model, b50);
    assert.equal(result.errors.length, 0);
});
test("the size-limited comment retains the base-threshold fallback notice", async () => {
    const result = await runReview({ snapshot: snapshot(undefined, {
            ...config, modelThresholds: { ...policy, unknown: "base-thresholds" },
        }), apiKey: "test", fetchImpl: responseWithModel("clef") });
    result.coverage.warnings.push("Synthetic coverage note ".repeat(5000));
    const comment = renderComment(result, null);
    assert.ok(comment.length < 60_000);
    assert.match(comment, /coverage notes exceed/);
    assert.match(comment, /no fitted thresholds/);
});
test("borderline repeats use the selected threshold and preserve it", async () => {
    const calls = [];
    const result = await runReview({ snapshot: snapshot(undefined, { ...config, borderlineMargin: 0.02 }),
        apiKey: "test", fetchImpl: responseWithModel(b50, { "breaking-change": 0.4 }, calls) });
    assert.equal(result.health, "complete");
    assert.equal(calls.length, 2);
    assert.equal(result.decisions.find(d => d.name === "breaking-change")?.threshold, thresholds["breaking-change"]);
});
test("mixed returned models remain incomplete even when both have policies", async () => {
    let count = 0;
    const result = await runReview({ snapshot: snapshot([file(undefined, "src/a.ts"), file(undefined, "src/b.ts")], {
            ...config, modelThresholds: { ...policy, models: { ...policy.models, second: thresholds } },
        }), apiKey: "test", fetchImpl: (url, init) => responseWithModel(count++ ? "second" : b50)(url, init) });
    assert.equal(result.health, "partial");
    assert.equal(reviewExitCode(result), 2);
    assert.ok(result.errors.some(error => /model/i.test(error)));
});
test("model tables validate full enabled rule coverage and their numeric domain", () => {
    for (const modelThresholds of [
        {}, { models: { [b50]: thresholds } }, { ...policy, extra: true },
        { ...policy, models: {} }, { ...policy, models: { " ": thresholds } },
        { ...policy, models: { [b50]: { "breaking-change": 0.2 } } },
        ...[NaN, Infinity, -0.1, 1.1, "0.4"].map(value => ({ ...policy, models: { [b50]: { ...thresholds, "breaking-change": value } } })),
        { ...policy, models: { [b50]: { ...thresholds, typo: 0.4 } } },
    ])
        assert.throws(() => resolveConfig(validateConfigDocument({ modelThresholds })));
    assert.throws(() => resolveConfig(validateConfigDocument({ ...config,
        rules: { "test-meaningfulness": { enabled: true } },
    })), /lacks enabled rule/);
    const rules = resolveConfig({}).rules.filter(r => r.enabled);
    assert.equal(rulesForReturnedModel(rules, undefined, undefined), rules);
});
test("snapshot hashes bind the complete model policy and preserve legacy snapshots", () => {
    const input = snapshot(undefined, config);
    assert.deepEqual(parseSnapshot(JSON.stringify(input)), input);
    const old = snapshot();
    assert.deepEqual(parseSnapshot(JSON.stringify(old)), old);
    assert.notEqual(input.policyHash, old.policyHash);
    const changed = structuredClone(input);
    changed.config.modelThresholds = { ...policy, unknown: "base-thresholds" };
    assert.throws(() => parseSnapshot(JSON.stringify(changed)), /changed/);
    const altered = structuredClone(input);
    altered.config.modelThresholds = { ...policy, models: { [b50]: { ...thresholds, "breaking-change": 0.4 } } };
    assert.throws(() => parseSnapshot(JSON.stringify(altered)), /changed/);
});
