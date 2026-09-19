import assert from "node:assert/strict";
import { test } from "node:test";
import { COMMENT_MARKER, parsePreviousOutcome, renderComment, renderPlainTable, renderSummary } from "./render.js";
import type { ReviewOutcome } from "./types.js";

function outcome(overrides: Partial<ReviewOutcome> = {}): ReviewOutcome {
  const decisions = [
    {
      name: "danger-sensitive-area",
      title: "Touches security-sensitive logic",
      kind: "noul" as const,
      gate: true,
      threshold: 0.5,
      probability: 0.12,
      exceeded: false,
      failed: false,
      error: null,
    },
    {
      name: "test-meaningfulness",
      title: "Tests are weak",
      kind: "score" as const,
      gate: false,
      threshold: 0.7,
      probability: 0.75,
      level: 1.5,
      levels: 3,
      confidence: 0.8,
      exceeded: true,
      failed: false,
      error: null,
    },
  ];
  return {
    schema: 1,
    headSha: "abcdef1234567890",
    baseSha: "0123456789abcdef",
    prNumber: 7,
    model: "jev-test",
    rulesHash: "abc123def456",
    latencyMs: 321,
    inputTokens: 1500,
    outputTokens: 0,
    costUSD: 0.000063,
    ranAt: "2026-09-19T10:00:00.000Z",
    truncated: false,
    decisions,
    passed: true,
    failedGates: [],
    erroredGates: [],
    ...overrides,
  };
}

test("comments carry the marker, a table, and a parseable data block", () => {
  const body = renderComment(outcome(), null);
  assert.ok(body.startsWith(COMMENT_MARKER));
  assert.ok(body.includes("danger-sensitive-area (gate)"));
  assert.ok(body.includes("50.0%"), "threshold 0.5 renders as 50.0%");
  assert.ok(body.includes("70.0%"), "threshold 0.7 renders as 70.0%");
  assert.ok(body.includes("warn"));
  assert.ok(!body.includes(".jev-gate.yml"), "a passing comment does not carry the override hint");
  const parsed = parsePreviousOutcome(body);
  assert.equal(parsed?.headSha, "abcdef1234567890");
  assert.equal(parsed?.decisions.length, 2);
});

test("deltas compare against the previous run", () => {
  const previous = outcome();
  const current = outcome({
    decisions: [
      { ...previous.decisions[0]!, probability: 0.17 },
      { ...previous.decisions[1]!, probability: 0.5 },
    ],
  });
  const body = renderComment(current, previous);
  assert.ok(body.includes("+5.0pp"));
  assert.ok(body.includes("-25.0pp"));
});

test("failed gates are named, point at the override valve, and stay out of the summary", () => {
  const failing = outcome({ passed: false, failedGates: ["breaking-change"] });
  const body = renderComment(failing, null);
  assert.ok(body.includes("1 gated rule failed"));
  assert.ok(body.includes(".jev-gate.yml"), "a failing comment names where to adjust the grading");
  const summary = renderSummary(failing);
  assert.ok(!summary.includes(COMMENT_MARKER));
  assert.ok(summary.includes("Jev gate"));
});

test("a rule that could not be graded shows an error row and fails through erroredGates", () => {
  const base = outcome();
  const broken = outcome({
    passed: false,
    erroredGates: ["danger-sensitive-area"],
    decisions: [
      { ...base.decisions[0]!, probability: null, error: "the model returned no answer" },
      base.decisions[1]!,
    ],
  });
  const body = renderComment(broken, null);
  assert.ok(body.includes("could not be graded"));
  assert.ok(body.includes("1 gated rule could not be graded"));
  assert.ok(body.includes("n/a"));
  const table = renderPlainTable(broken);
  assert.ok(table.includes("error"));
});

test("the plain table renders one row per rule", () => {
  const table = renderPlainTable(outcome());
  const lines = table.split("\n");
  assert.equal(lines.length, 4);
  assert.ok(lines[0]?.includes("concern"));
  assert.ok(lines[2]?.startsWith("danger-sensitive-area"));
});
