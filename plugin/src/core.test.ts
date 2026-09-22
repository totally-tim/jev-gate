import assert from "node:assert/strict";
import { test } from "node:test";
import {
  resolveOptions,
  parseOutcome,
  formatBriefing,
  type OutcomeView,
} from "./core.js";
import { ReviewMonitor, type SnapshotView } from "./monitor.js";
const id = (s: string) => s.repeat(64);
function outcome(
  snapshotId = id("a"),
  finding = true,
  health: OutcomeView["health"] = "complete",
): OutcomeView {
  return {
    schema: 2,
    snapshotId,
    health,
    status: finding ? "needs-review" : "clear",
    policyHash: id("b"),
    model: "mock",
    errors: health === "complete" ? [] : ["provider unavailable"],
    findings: finding
      ? [
          {
            id: "1".repeat(24),
            rule: "danger-sensitive-area",
            title: "Sensitive change",
            path: "auth.ts",
            startLine: 1,
            status: "open",
            verification:
              "Check the session invariant; an intentional change can be correct.",
            category: "review-request",
          },
        ]
      : [],
  };
}
function fixture() {
  let current = id("a"),
    bad = true,
    health: OutcomeView["health"] = "complete",
    now = 0,
    calls = 0;
  const ledger: string[] = [];
  const io = {
    collect: async (): Promise<SnapshotView> => ({
      id: current,
      text: current,
      provider: "typesafe",
    }),
    review: async (s: SnapshotView) => {
      calls++;
      return outcome(s.id, bad, health);
    },
    read: () => ledger.join("\n"),
    append: (r: unknown) => {
      ledger.push(JSON.stringify(r));
    },
    now: () => now,
    backoffMs: 100,
  };
  return {
    io,
    ledger,
    set: (s: string, b: boolean, h: OutcomeView["health"] = "complete") => {
      current = id(s);
      bad = b;
      health = h;
    },
    advance: () => {
      now += 101;
    },
    calls: () => calls,
  };
}
test("agent briefings preserve diagnostic abstention without resolving the finding", () => {
  const review = outcome();
  review.findings[0]!.diagnostic = { status: "no-issue", reason: "Migration supplied", verification: "Test an existing caller" };
  const parsed = parseOutcome(JSON.stringify(review));
  assert.ok(parsed);
  assert.equal(parsed.findings[0]!.status, "open");
  assert.match(formatBriefing(parsed)!, /no-issue/);
  assert.match(formatBriefing(parsed)!, /does not resolve the finding/);
  (review.findings[0]!.diagnostic as any).reason = 123;
  assert.equal(parseOutcome(JSON.stringify(review)), null);
});
test("options accept argv arrays with paths containing spaces and reject invalid options", () => {
  const o = resolveOptions(
    { cli: ["node", "/a path/cli.cjs"], policySource: "base" },
    { directory: "/repo" },
  );
  assert.deepEqual(o.cliArgs, ["/a path/cli.cjs"]);
  assert.equal(o.inject, false);
  assert.throws(() => resolveOptions({ timeoutMs: 0 }, { directory: "/repo" }));
  assert.throws(() => resolveOptions({ wat: true }, { directory: "/repo" }));
  assert.throws(() =>
    resolveOptions({ cli: 'node "unfinished' }, { directory: "/repo" }),
  );
  assert.throws(() =>
    resolveOptions({ ledger: "src/ledger.jsonl" }, { directory: "/repo" }),
  );
  assert.throws(() =>
    resolveOptions(
      { ledger: ".jev-gate/dispositions.jsonl" },
      { directory: "/repo" },
    ),
  );
});

test("a transport failure is persisted, delivered once, and retried after backoff", async () => {
  const f = fixture();
  let calls = 0;
  f.io.review = async () => {
    calls++;
    throw new Error("CLI timed out");
  };
  const m = new ReviewMonitor(f.io);
  const delivered: string[] = [];
  await m.deliver("s", (text) => delivered.push(text));
  await m.deliver("s", (text) => delivered.push(text));
  assert.equal(calls, 1);
  assert.equal(delivered.length, 1);
  assert.match(delivered[0]!, /unavailable/);
  f.advance();
  await m.poll();
  assert.equal(calls, 2);
  await m.dispose();
});

test("briefing limits never acknowledge findings the recipient did not receive", async () => {
  const f = fixture();
  f.io.review = async (s) => {
    const o = outcome(s.id);
    o.findings = Array.from({ length: 12 }, (_, i) => ({
      ...o.findings[0]!,
      id: i.toString(16).padStart(24, "0"),
    }));
    return o;
  };
  const m = new ReviewMonitor(f.io);
  const messages: string[] = [];
  await m.deliver("s", (text) => messages.push(text));
  await m.deliver("s", (text) => messages.push(text));
  await m.deliver("s", (text) => messages.push(text));
  assert.equal(messages.length, 2);
  for (let i = 0; i < 12; i++)
    assert.ok(messages.join("\n").includes(i.toString(16).padStart(24, "0")));
  await m.dispose();
});
test("only schema 2 complete result shapes are accepted", () => {
  assert.ok(parseOutcome(JSON.stringify(outcome())));
  assert.equal(
    parseOutcome('{"schema":1,"decisions":[],"failedGates":[]}'),
    null,
  );
  assert.equal(
    parseOutcome(JSON.stringify({ ...outcome(), findings: [{}] })),
    null,
  );
  assert.ok(formatBriefing(outcome())?.includes('"auth.ts":1'));
  assert.ok(
    formatBriefing(outcome(id("a"), false, "unavailable"))?.includes(
      "unavailable",
    ),
  );
});
test("a newer clean review invalidates a queued warning", async () => {
  const f = fixture(),
    m = new ReviewMonitor(f.io);
  await m.poll();
  f.set("b", false);
  await m.poll();
  const sent: string[] = [];
  await m.deliver("session", (s) => sent.push(s));
  assert.deepEqual(sent, []);
  await m.dispose();
});
test("restart restores an undelivered assessment and deduplicates by recipient", async () => {
  const f = fixture(),
    m = new ReviewMonitor(f.io);
  await m.poll();
  await m.dispose();
  const restarted = new ReviewMonitor(f.io),
    sent: string[] = [];
  await restarted.deliver("s1", (s) => sent.push(s));
  await restarted.deliver("s1", (s) => sent.push(s));
  await restarted.deliver("s2", (s) => sent.push(s));
  assert.equal(sent.length, 2);
  assert.equal(f.calls(), 1);
  await restarted.dispose();
  const again = new ReviewMonitor(f.io);
  await again.deliver("s1", (s) => sent.push(s));
  assert.equal(sent.length, 2);
  await again.dispose();
});
test("incomplete assessments are briefed and retried after backoff", async () => {
  const f = fixture();
  f.set("a", false, "unavailable");
  const m = new ReviewMonitor(f.io),
    sent: string[] = [];
  await m.deliver("s", (s) => sent.push(s));
  await m.poll();
  assert.equal(f.calls(), 1);
  assert.equal(sent.length, 1);
  f.advance();
  await m.poll();
  assert.equal(f.calls(), 2);
  await m.deliver("s", (s) => sent.push(s));
  assert.equal(sent.length, 1);
  await m.dispose();
});
test("unchanged findings are not re-injected after unrelated snapshot changes", async () => {
  const f = fixture(),
    m = new ReviewMonitor(f.io),
    sent: string[] = [];
  await m.deliver("s", (s) => sent.push(s));
  f.set("b", true);
  await m.deliver("s", (s) => sent.push(s));
  assert.equal(sent.length, 1);
  await m.dispose();
});
test("a change while the provider runs discards that assessment", async () => {
  const f = fixture();
  const io = {
    ...f.io,
    review: async (s: SnapshotView) => {
      f.set("b", false);
      return outcome(s.id);
    },
  };
  const m = new ReviewMonitor(io);
  await m.poll();
  assert.equal(f.ledger.length, 0);
  await m.dispose();
});
test("concurrent hooks deliver once and disposal cancels active work before persistence", async () => {
  const f = fixture(),
    m = new ReviewMonitor(f.io),
    sent: string[] = [];
  await Promise.all([
    m.deliver("s", (s) => sent.push(s)),
    m.deliver("s", (s) => sent.push(s)),
  ]);
  assert.equal(sent.length, 1);
  await m.dispose();
  let started!: () => void;
  const ready = new Promise<void>((r) => (started = r));
  const g = fixture();
  const pending = new ReviewMonitor({
    ...g.io,
    review: async (s, signal) => {
      started();
      await new Promise<void>((r) =>
        signal.addEventListener("abort", () => r(), { once: true }),
      );
      return outcome(s.id);
    },
  });
  const poll = pending.poll();
  await ready;
  await pending.dispose();
  await poll;
  assert.equal(g.ledger.length, 0);
});
