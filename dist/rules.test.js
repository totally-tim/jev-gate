import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveConfig, validateConfigDocument } from "./config.js";
import { buildQuestions, evaluate } from "./rules.js";
const config = resolveConfig(validateConfigDocument({}));
const rules = config.rules;
const candidate = {
    id: "test",
    path: "test.ts",
    startLine: 1,
    endLine: 1,
    side: "new",
    status: "modified",
};
test("questions carry one entry per enabled rule", () => {
    const questions = buildQuestions(rules);
    assert.equal(Object.keys(questions).length, rules.length);
    assert.equal(questions["danger-sensitive-area"]?.type, "noul");
    assert.equal(questions["test-meaningfulness"]?.type, "score");
});
test("one request with every rule stays within local-decide's measured packing bound", () => {
    // Eight questions per request matched single-question accuracy; 16 and 32 did not.
    // A ninth rule needs split requests before local-decide can review it reliably.
    assert.ok(Object.keys(buildQuestions(rules)).length <= 8);
});
test("noul decisions gate at the threshold", () => {
    const answers = Object.fromEntries(rules.map((rule) => [
        rule.name,
        rule.kind === "noul"
            ? { type: "noul", noul: 0.61 }
            : { type: "score", score: 0, confidence: 0.9 },
    ]));
    const decisions = evaluate(rules, answers, candidate);
    const deletedTests = decisions.find((decision) => decision.name === "danger-deleted-tests");
    assert.equal(deletedTests?.failed, true);
    const commentDrift = decisions.find((decision) => decision.name === "comment-drift");
    assert.equal(commentDrift?.failed, false);
    assert.equal(commentDrift?.exceeded, true);
});
test("score decisions normalize against the rubric length", () => {
    const answers = {
        "test-meaningfulness": { type: "score", score: 1.5, confidence: 0.8 },
    };
    const decision = evaluate(rules.filter((rule) => rule.name === "test-meaningfulness"), answers, candidate)[0];
    assert.equal(decision?.kind, "score");
    assert.equal(decision?.levels, 3);
    assert.equal(decision?.level, 1.5);
    assert.ok(Math.abs((decision?.value ?? 0) - 0.75) < 1e-9);
    assert.equal(decision?.exceeded, true);
    assert.equal(decision?.failed, false);
});
test("missing or malformed answers become error rows instead of throwing", () => {
    const decisions = evaluate(rules, {}, candidate);
    assert.ok(decisions.every((decision) => decision.error !== null && decision.probability === null));
    assert.ok(decisions.every((decision) => !decision.failed && !decision.exceeded));
    const malformed = evaluate(rules.filter((rule) => rule.name === "breaking-change"), { "breaking-change": { type: "score", score: 1 } }, candidate);
    assert.match(malformed[0]?.error ?? "", /wrong answer type/);
    const healthy = evaluate(rules, {
        ...Object.fromEntries(rules.map((rule) => [rule.name, { type: "noul", noul: 0.1 }])),
        "breaking-change": { type: "noul", noul: 0.9 },
    }, candidate);
    assert.equal(healthy.find((decision) => decision.name === "breaking-change")?.failed, true);
    assert.equal(healthy.find((decision) => decision.name === "comment-drift")?.error, null);
});
