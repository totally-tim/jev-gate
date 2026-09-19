import assert from "node:assert/strict";
import { test } from "node:test";
import { buildState, estimateTokens, matchGlob } from "./state.js";
function pullRequest(overrides = {}) {
    return {
        owner: "o",
        repo: "r",
        number: 1,
        title: "Add feature",
        body: "Body text",
        author: "a",
        baseRef: "main",
        baseSha: "base",
        headSha: "head",
        changedFiles: 0,
        additions: 0,
        deletions: 0,
        commits: 1,
        htmlUrl: "url",
        ...overrides,
    };
}
function file(path, patch) {
    return { path, status: "modified", additions: 1, deletions: 0, patch };
}
test("glob matching handles doublestar, single star, and exact paths", () => {
    assert.equal(matchGlob("**/*.lock", "Cargo.lock"), true);
    assert.equal(matchGlob("**/*.lock", "deep/dir/Cargo.lock"), true);
    assert.equal(matchGlob("**/node_modules/**", "node_modules/x.js"), true);
    assert.equal(matchGlob("**/node_modules/**", "a/node_modules/x.js"), true);
    assert.equal(matchGlob("src/*.ts", "src/a.ts"), true);
    assert.equal(matchGlob("src/*.ts", "src/deep/a.ts"), false);
    assert.equal(matchGlob("**/dist/**", "src/dist"), false);
});
test("ignored files are filtered and the rest sorted", () => {
    const { state } = buildState(pullRequest(), [file("b.ts", "patch b"), file("bun.lock", "x"), file("a.ts", "patch a")], {
        ignore: ["**/bun.lock"],
        maxStateTokens: 10_000,
    });
    assert.deepEqual(state.files.map((entry) => entry.path), ["a.ts", "b.ts"]);
    assert.equal(state.truncated, false);
});
test("over-budget states drop patches from the largest files first", () => {
    const bigPatch = "x".repeat(9_000);
    const { state, truncatedPaths } = buildState(pullRequest(), [file("big.ts", bigPatch), file("small.ts", "y".repeat(100))], { ignore: [], maxStateTokens: 1_200 });
    assert.equal(state.truncated, true);
    assert.deepEqual(truncatedPaths, ["big.ts"]);
    assert.equal(state.files.find((entry) => entry.path === "big.ts")?.patch, undefined);
    assert.ok(state.files.find((entry) => entry.path === "small.ts")?.patch);
    assert.ok(estimateTokens(JSON.stringify(state)) <= 1_200);
});
test("descriptions are clipped", () => {
    const { state } = buildState(pullRequest({ body: "d".repeat(9_000) }), [], { ignore: [], maxStateTokens: 10_000 });
    assert.ok(state.pr.description.length < 4_100);
});
