import assert from "node:assert/strict";
import { test } from "node:test";
import { diagnoseCompatibility, diagnosticRegions, DIAGNOSTIC_POLICY } from "./diagnostics.js";
import { runReview, reviewExitCode } from "./review.js";
import { file, snapshot, endpoint } from "./test-fixtures.js";
import { buildState, candidatesFor } from "./state.js";
import { parseSnapshot, policyHashFor } from "./snapshot.js";
import { resolveConfig, validateConfigDocument } from "./config.js";
import { renderComment, renderPlainTable, renderSummary } from "./render.js";
import type { Fetch } from "@typesafe-ai/sdk";

const change = file("@@ -1,2 +1,2 @@\n-export function read() { return 1; }\n+export function load() { return 1; }\n // Public API", "src/api.ts");
const config = { mode: "required" as const, diagnostics: { enabled: true } };

function choiceAnswer(label: string, keys: string[], confidence = 0.9) {
  return { type: "choice", choice: label, confidence, probabilities: Object.fromEntries(keys.map(key => [key, key === label ? 1 : 0])) };
}
function impactAnswer() {
  return { type: "score", score: 2, confidence: 0.9, probabilities: { "0": 0, "1": 0, "2": 1, "3": 0 } };
}
function model(options: { selection?: string; mechanism?: string; confidence?: number; missingImpact?: boolean; badChoice?: boolean; drift?: boolean } = {}, calls: any[] = []): Fetch {
  const screening = endpoint({ "breaking-change": 0.9 });
  return async (url, init) => {
    const body = JSON.parse(String(init?.body));
    calls.push(body);
    if (!body.questions.evidence && !body.questions.mechanism) return screening(url, init);
    let answers: Record<string, unknown>;
    if (body.questions.evidence) {
      answers = { evidence: choiceAnswer(options.selection ?? "R1", Object.keys(body.questions.evidence.criteria), options.confidence) };
      if (options.badChoice) (answers.evidence as any).choice = "hallucinated-region";
    } else {
      answers = { mechanism: choiceAnswer(options.mechanism ?? "api", Object.keys(DIAGNOSTIC_POLICY.mechanisms)) };
      if (!options.missingImpact) answers.impact = impactAnswer();
    }
    return new Response(JSON.stringify({ model: options.drift ? "different-model" : "jev-test", answers, usage: { input_tokens: 10, output_tokens: 0 } }));
  };
}
const review = (fetchImpl = model(), overrides = {}) => runReview({ snapshot: snapshot([change], { ...config, ...overrides }), apiKey: "test", fetchImpl });

test("diagnostics are opt-in, strictly validated, and included in snapshot identity", () => {
  assert.deepEqual(resolveConfig({}).diagnostics, { enabled: false, maxRequests: 16 });
  for (const diagnostics of [true, { enabled: 1 }, { maxRequests: 0 }, { maxRequests: 1.1 }, { maxRequests: 501 }, { secretSetting: true }])
    assert.throws(() => validateConfigDocument({ diagnostics }));
  const s = snapshot([change], config);
  assert.deepEqual(parseSnapshot(JSON.stringify(s)), s);
  assert.notEqual(s.policyHash, snapshot([change]).policyHash);
  const changed = structuredClone(s);
  changed.config.diagnostics.maxRequests++;
  assert.throws(() => parseSnapshot(JSON.stringify(changed)), /changed/);
});

test("stage-one criterion changes invalidate diagnostic snapshots", () => {
  const s = snapshot([change], config);
  const original = DIAGNOSTIC_POLICY.selectionCriteria.noMatch;
  try {
    DIAGNOSTIC_POLICY.selectionCriteria.noMatch = "Changed selection criterion";
    assert.notEqual(policyHashFor(s.config), s.policyHash);
    assert.throws(() => parseSnapshot(JSON.stringify(s)), /collect a fresh snapshot/);
  } finally {
    DIAGNOSTIC_POLICY.selectionCriteria.noMatch = original;
  }
});

test("snapshots without diagnostics request recollection instead of reporting invalid config", () => {
  const old = JSON.parse(JSON.stringify(snapshot([change])));
  delete old.config.diagnostics;
  assert.throws(() => parseSnapshot(JSON.stringify(old)), /collect a fresh snapshot/);
});

test("successful follow-up selects source evidence and impact without altering screening or gates", async () => {
  const calls: any[] = [];
  const outcome = await review(model({}, calls));
  const baseline = await runReview({ snapshot: snapshot([change], { mode: "required" }), apiKey: "test", fetchImpl: model() });
  assert.deepEqual(outcome.decisions, baseline.decisions);
  assert.deepEqual(outcome.failedGates, baseline.failedGates);
  assert.equal(outcome.findings.length, baseline.findings.length);
  assert.equal(outcome.health, "complete");
  assert.equal(reviewExitCode(outcome), 1);
  assert.equal(calls.length, 3);
  const d = outcome.findings[0]!.diagnostic!;
  assert.equal(d.status, "supported");
  assert.equal(d.mechanism?.choice, "api");
  assert.equal(d.impact?.score, 2);
  assert.equal(d.evidence?.patch, change.patch);
  assert.equal(d.evidence?.startLine, 1);
  assert.match(d.verification!, /existing caller/);
  assert.deepEqual(outcome.diagnostics, { version: "compatibility-v1", health: "complete", eligible: 1, completed: 1, requests: 2 });
  assert.equal(outcome.inputTokens, 120);
});

for (const [options, status, requestCount] of [
  [{ selection: "noMatch" }, "no-match", 1],
  [{ selection: "insufficientContext" }, "insufficient-context", 1],
  [{ confidence: 0.1 }, "insufficient-context", 1],
  [{ mechanism: "noIssue", missingImpact: true }, "no-issue", 2],
  [{ mechanism: "insufficientContext" }, "insufficient-context", 2],
] as const) test(`${status} preserves an open required finding`, async () => {
  const outcome = await review(model(options));
  assert.equal(outcome.findings[0]!.diagnostic!.status, status);
  assert.equal(outcome.findings[0]!.status, "open");
  assert.equal(outcome.diagnostics?.requests, requestCount);
  assert.equal(outcome.diagnostics?.health, "complete");
  assert.equal(reviewExitCode(outcome), 1);
});

for (const options of [{ badChoice: true }, { missingImpact: true }, { drift: true }])
  test(`invalid diagnostic response stays unavailable: ${JSON.stringify(options)}`, async () => {
    const outcome = await review(model(options));
    assert.equal(outcome.findings[0]!.diagnostic!.status, "unavailable");
    assert.equal(outcome.diagnostics?.health, "partial");
    assert.equal(outcome.health, "complete");
    assert.equal(outcome.model, "jev-test");
    assert.equal(reviewExitCode(outcome), 1);
  });

test("screening takes priority and every budget-limited finding retains its skip", async () => {
  const calls: any[] = [];
  const outcome = await runReview({
    snapshot: snapshot([change, { ...change, path: "src/second.ts" }], { ...config, maxRequests: 3 }),
    apiKey: "test", fetchImpl: model({}, calls),
  });
  assert.equal(calls.length, 3);
  assert.ok(calls.slice(0, 2).every(call => call.questions["breaking-change"]));
  assert.equal(outcome.coverage.files.filter(f => f.status === "reviewed").length, 2);
  assert.deepEqual(outcome.findings.map(f => f.diagnostic?.status), ["skipped", "skipped"]);
  assert.ok(outcome.findings[0]!.diagnostic?.selection);
  assert.equal(outcome.diagnostics?.health, "partial");
  assert.equal(reviewExitCode(outcome), 1);
  const limited = await review(model(), { diagnostics: { enabled: true, maxRequests: 1 } });
  assert.equal(limited.diagnostics?.requests, 1);
  assert.equal(limited.findings[0]!.diagnostic?.status, "skipped");
});

test("large diagnostic candidates are skipped whole instead of silently clipped", async () => {
  const huge = file("@@ -1,80 +1,80 @@\n" + Array.from({ length: 80 }, (_, i) => `+export const value${i} = 1;`).join("\n"));
  const outcome = await runReview({ snapshot: snapshot([huge], config), apiKey: "test", fetchImpl: model() });
  assert.equal(outcome.health, "complete");
  assert.equal(outcome.diagnostics?.requests, 0);
  assert.equal(outcome.findings[0]!.diagnostic?.status, "skipped");
  assert.match(outcome.findings[0]!.diagnostic!.reason, /no evidence was clipped/);
});

test("diagnostic regions retain every line and use the original side and line numbers", () => {
  for (const candidate of [
    { id: "x", path: "a", status: "removed", side: "old" as const, startLine: 90, endLine: 105, patch: Array.from({ length: 16 }, (_, i) => `-const x${i} = 1;`).join("\n") },
    { id: "x", path: "a", status: "modified", side: "new" as const, startLine: 20, endLine: 35, patch: "@@ -1,16 +20,16 @@\n" + Array.from({ length: 16 }, (_, i) => `+const x${i} = 1;`).join("\n") },
  ]) {
    const regions = diagnosticRegions(candidate);
    assert.equal(regions.map(r => r.patch).join("\n"), candidate.patch);
    assert.equal(regions[0]!.startLine, candidate.startLine);
    assert.ok(regions.every(region => region.side === candidate.side));
    assert.equal(regions.at(-1)!.endLine, candidate.endLine);
  }
});

test("redacted credentials stay out of follow-up state and copied evidence", async () => {
  const secret = "postgres://user:real-password@db.internal/prod";
  const calls: any[] = [];
  const outcome = await runReview({ snapshot: snapshot([file(`@@ -1 +1 @@\n-old\n+const db = '${secret}';`)], config), apiKey: "test", fetchImpl: model({}, calls) });
  assert.equal(calls.length, 3);
  assert.ok(!JSON.stringify(calls).includes("real-password"));
  assert.ok(!JSON.stringify(outcome).includes("real-password"));
});

test("diagnostic probability validation rejects NaN and unknown entries, tolerating rounded totals", async () => {
  const candidate = candidatesFor(change, 4000)[0]!;
  const context = buildState(snapshot([change]).pr, candidate, [change]);
  for (const probabilities of [{ R1: 0.34, noMatch: 0.33, insufficientContext: 0.32 }, { R1: NaN, noMatch: 0, insufficientContext: 0 }, { R1: 1, noMatch: 0, insufficientContext: 0, invented: 0 }]) {
    const result = await diagnoseCompatibility(candidate, context, async () => ({ evidence: { type: "choice", choice: "noMatch", confidence: 0.9, probabilities } }));
    assert.equal(result.status, probabilities.R1 === 0.34 ? "no-match" : "unavailable");
  }
});

test("choice validation preserves distinct confidence but rejects a contradictory selected label", async () => {
  const candidate = candidatesFor(change, 4000)[0]!;
  const context = buildState(snapshot([change]).pr, candidate, [change]);
  const probabilities = { R1: 0.2, noMatch: 0.73, insufficientContext: 0.07 };
  const run = (choice: string) => diagnoseCompatibility(candidate, context, async () => ({
    evidence: { type: "choice", choice, confidence: 0.59, probabilities },
  }));
  assert.equal((await run("noMatch")).status, "no-match");
  const invalid = await run("R1");
  assert.equal(invalid.status, "unavailable");
  assert.match(invalid.reason, /contradicts/);
});

test("CLI and GitHub reports show diagnostic status, separate impact units, and escaped evidence", async () => {
  const outcome = await review();
  for (const text of [renderPlainTable(outcome), renderComment(outcome, null), renderSummary(outcome)]) {
    assert.match(text, /supported/);
    assert.match(text, /2.00 \/ 3 rubric score/);
    assert.match(text, /existing caller/);
  }
  outcome.findings[0]!.diagnostic!.reason = '<script>alert("x")</script>';
  assert.ok(!renderComment(outcome, null).includes("<script>"));
  assert.match(renderComment(outcome, null), /&lt;script&gt;/);
});

test("local-decide is accounted as local inference", async () => {
  const calls: any[] = [];
  const outcome = await review(model({}, calls), { model: "local-decide" });
  assert.equal(outcome.costUSD, 0);
  assert.ok(outcome.inputTokens > 0);
  assert.equal(outcome.health, "complete");
  assert.equal(outcome.findings[0]!.diagnostic?.status, "supported");
  assert.equal(calls.length, 3, "one packed screening request and two diagnostic requests");
  assert.equal(Object.keys(calls[0].questions).length, 5);
});

test("diagnostics skip evidence that exceeds the state budget instead of clipping it", async () => {
  // Screening drops the optional file opening to fit; diagnostics keep it and must skip.
  const opening = Array.from({ length: 30 }, (_, i) => `+export const label${i} = "éééééééééééé";`).join("\n");
  const patch = `@@ -1,1 +1,31 @@\n${opening}\n-export function read() { return 1; }\n+export function load() { return 1; }`;
  const outcome = await runReview({ snapshot: snapshot([file(patch, "src/api.ts")], { ...config, maxStateTokens: 2000 }), apiKey: "test", fetchImpl: model() });
  const skipped = outcome.findings.filter(f => f.diagnostic?.status === "skipped");
  assert.ok(skipped.length > 0);
  assert.match(skipped[0]!.diagnostic!.reason, /state budget/);
  assert.equal(outcome.diagnostics?.health, "partial");
});
