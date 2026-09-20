import assert from "node:assert/strict";
import { test } from "node:test";
import {
  parsePreviousOutcome,
  renderComment,
  renderSummary,
  displayValue,
} from "./render.js";
import { runReview } from "./review.js";
import { snapshot, endpoint, file } from "./test-fixtures.js";
test("comments carry located findings, current coverage, and schema 2 data", async () => {
  const o = await runReview({
    snapshot: snapshot(),
    apiKey: "test",
    fetchImpl: endpoint({ "danger-sensitive-area": 0.99 }),
  });
  const body = renderComment(o, null, "o/r");
  assert.ok(body.includes("src/auth.ts"));
  assert.ok(body.includes("Review health: **complete**"));
  assert.ok(body.includes("review-request"));
  assert.equal(parsePreviousOutcome(body)?.snapshotId, o.snapshotId);
  assert.ok(!renderSummary(o).includes("jev-gate:data"));
});
test("scores retain their rubric units and never masquerade as probabilities", () => {
  assert.equal(
    displayValue({ kind: "score", probability: null, level: 1.5, levels: 3 }),
    "1.50 / 2 rubric score",
  );
});
test("large comments retain located findings and link to the complete workflow report", async () => {
  const o = await runReview({
    snapshot: snapshot(),
    apiKey: "test",
    fetchImpl: endpoint({ "danger-sensitive-area": 0.99 }),
  });
  o.decisions = Array.from({ length: 500 }, () => o.decisions[0]!);
  const body = renderComment(o, null, "o/r", "https://github.com/o/r/actions/runs/123");
  assert.ok(body.length <= 60_000);
  assert.ok(body.includes("src/auth.ts"));
  assert.ok(body.includes(o.findings[0]!.verification));
  assert.ok(body.includes("Review health: **complete**"));
  assert.ok(body.includes("https://github.com/o/r/actions/runs/123"));
  assert.ok(body.includes(o.snapshotId));
  assert.equal(parsePreviousOutcome(body), null);
  o.findings = Array.from({ length: 1000 }, (_, index) => ({ ...o.findings[0]!, id: `finding-${index}` }));
  const capped = renderComment(o, null, "o/r");
  assert.ok(capped.length <= 60_000);
  assert.ok(capped.includes("finding-0"));
  assert.ok(capped.includes("additional findings are in the full workflow summary"));
});
test("untrusted markup stays text and cannot close the machine data block", async () => {
  const o = await runReview({
    snapshot: snapshot([file(undefined, "<script>|`-->.ts")]),
    apiKey: "test",
    fetchImpl: endpoint({ "breaking-change": 0.9 }),
  });
  const body = renderComment(o, null);
  assert.ok(!body.includes("<script>"));
  assert.equal(
    parsePreviousOutcome(body)?.findings[0]?.path,
    "<script>|`-->.ts",
  );
  assert.equal(
    parsePreviousOutcome(
      '<!-- jev-gate:data\n{"schema":1,"decisions":[]}\n-->',
    ),
    null,
  );
});
