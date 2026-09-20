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
import { concernMap, estimateGraphic, reviewTopics } from "./presentation.js";
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

test("a quiet review stays short and moves individual observations to the full report", async () => {
  const outcome = await runReview({ snapshot: snapshot(), apiKey: "test", fetchImpl: endpoint({}) });
  const visible = renderComment(outcome, null).split("<!-- jev-gate:data")[0]!;
  assert.ok(visible.includes("No findings to review"));
  assert.ok(visible.includes("1/1 change sections assessed"));
  assert.ok(!visible.includes("```mermaid"));
  assert.ok(!visible.includes("below threshold"));
  assert.ok(visible.length < 1600);
  assert.ok(renderSummary(outcome).includes("Individual model observations"));
});

test("grouped local matches preserve evidence without presenting certainty percentages", async () => {
  const outcome = await runReview({
    snapshot: snapshot(), apiKey: "test",
    fetchImpl: endpoint({ "danger-sensitive-area": 0.91, "breaking-change": 0.61 }),
  });
  const template = outcome.findings[0]!;
  outcome.findings.unshift(...[1, 2, 3, 4, 5].map(line => ({
    ...template, id: `local-${line}`, rule: "danger-secret-material", source: "local" as const,
    category: "secret" as const, path: "deploy/dev/run.sh", startLine: line,
    evidence: "A credential pattern matched.", verification: "Check these development credentials.", value: 1,
  })));
  const before = JSON.stringify(outcome);
  const topics = reviewTopics(outcome);
  assert.equal(topics.filter(t => t.source === "local").length, 1);
  const map = concernMap(outcome);
  assert.equal(map.rows.find(r => r.path === "deploy/dev/run.sh")?.cells[0]?.text, "5 matches");
  assert.ok(map.rows.find(r => r.path === "deploy/dev/run.sh")?.cells.some(c => c.text === "Not assessed"));
  const body = renderComment(outcome, null).split("<!-- jev-gate:data")[0]!;
  assert.equal(body.split("Check these development credentials.").length - 1, 1);
  for (const f of outcome.findings) assert.ok(body.includes(f.id));
  assert.ok(!body.includes("100%"));
  assert.equal(JSON.stringify(outcome), before, "presentation must not change the assessment");
});

test("the concern map uses per-file peaks, actual thresholds, and distinguishes missing evidence", async () => {
  const outcome = await runReview({ snapshot: snapshot(), apiKey: "test", fetchImpl: endpoint({ "breaking-change": 0.61 }) });
  const first = outcome.decisions.find(d => d.name === "breaking-change")!;
  outcome.decisions.push({ ...first, value: 0.2, probability: 0.2, exceeded: false });
  outcome.decisions.push({ ...first, value: null, probability: null, error: "No answer", exceeded: false });
  const cell = concernMap(outcome).rows[0]!.cells[0]!;
  assert.equal(cell.text, "61% *");
  assert.equal(cell.tone, "concern");
  first.threshold = 0.8;
  first.exceeded = false;
  assert.equal(concernMap(outcome).rows[0]!.cells[0]!.tone, "quiet");
  first.error = "No answer";
  outcome.decisions = [first];
  assert.equal(concernMap(outcome).rows[0]!.cells[0]!.text, "Not assessed");
  outcome.health = "partial";
  const body = renderComment(outcome, null);
  assert.ok(body.includes("Review incomplete"));
  assert.ok(body.includes("Coverage is incomplete"));
});

test("filenames cannot inject HTML or break out of evidence links", async () => {
  const path = 'src/evil\")\n```\nclick f0 \"https://example.invalid\"\n.svg';
  const outcome = await runReview({ snapshot: snapshot([file(undefined, path)]), apiKey: "test", fetchImpl: endpoint({ "breaking-change": 0.9 }) });
  const body = renderComment(outcome, null, "o/r");
  assert.ok(body.includes("%22%29%0A"));
  assert.ok(!body.includes('](https://example.invalid'));
  assert.ok(!body.includes('href="https://example.invalid'));
  assert.ok(!body.includes("```mermaid"));
  outcome.findings[0]!.verification = '<img src=x onerror="alert(1)">';
  const escaped = renderComment(outcome, null, "o/r");
  assert.ok(escaped.includes("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;"));
  assert.ok(!escaped.includes('<img src=x'));
});

test("gauges keep rubric units and never turn local sentinel values into model confidence", async () => {
  const outcome = await runReview({ snapshot: snapshot(), apiKey: "test", fetchImpl: endpoint({ "breaking-change": 0.61 }) });
  const d = outcome.decisions.find(d => d.name === "breaking-change")!;
  assert.ok(estimateGraphic(d).includes('/amber/61.svg'));
  assert.ok(estimateGraphic(d).includes('alt="61% model estimate"'));
  assert.ok(estimateGraphic(d, true).includes('/blue/61.svg'));
  assert.equal(estimateGraphic({ ...d, value: null }), "Unavailable");
  assert.equal(estimateGraphic({ ...d, candidate: { ...d.candidate, id: "local-secret-scan", status: "local" } }), "Unavailable");
  const rubric = estimateGraphic({ ...d, kind: "score", probability: null, value: 0.75, level: 1.5, levels: 3 });
  assert.ok(rubric.includes("1.5 / 2"));
  assert.ok(!rubric.includes("svg"));
  const visible = renderComment(outcome, null).split("<!-- jev-gate:data")[0]!;
  assert.ok(visible.includes("<table>"));
  assert.ok(visible.includes("<details><summary>Check caller compatibility"));
  assert.ok(visible.includes("review at 60%"));
});
