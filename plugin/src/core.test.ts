import assert from "node:assert/strict";
import { test } from "node:test";
import { deliveryLine, formatBriefing, hashDiff, lastLedgerHash, ledgerLine, parseOutcome, resolveOptions } from "./core.js";

const DIRECTORY = "/work/tree";

function sampleOutcome() {
  const outcome = parseOutcome(
    JSON.stringify({
      model: "jev-test",
      rulesHash: "abc123abc123",
      headSha: "local-head",
      inputTokens: 2106,
      costUSD: 0.00009,
      failedGates: ["danger-sensitive-area"],
      erroredGates: [],
      decisions: [
        {
          name: "danger-sensitive-area",
          gate: true,
          threshold: 0.6,
          probability: 0.98,
          exceeded: true,
          failed: true,
          error: null,
        },
        {
          name: "breaking-change",
          gate: true,
          threshold: 0.6,
          probability: 0.51,
          exceeded: false,
          failed: false,
          error: null,
          samples: [0.52, 0.5],
        },
        {
          name: "test-meaningfulness",
          gate: false,
          threshold: 0.7,
          probability: 0.9,
          exceeded: true,
          failed: false,
          error: null,
        },
      ],
    }),
  );
  assert.ok(outcome !== null);
  return outcome;
}

test("options default to a two-minute ledger watch with the CLI on PATH", () => {
  const options = resolveOptions(undefined, { directory: DIRECTORY });
  assert.equal(options.cli, "jev-gate");
  assert.deepEqual(options.cliArgs, []);
  assert.equal(options.intervalMs, 120_000);
  assert.equal(options.inject, false);
  assert.equal(options.ledgerPath, `${DIRECTORY}/.jev-gate/ledger.jsonl`);
  assert.equal(options.provider, undefined);
  assert.equal(options.apiKey, undefined);
});

test("options accept a command string, a relative ledger, and provider settings", () => {
  const options = resolveOptions(
    {
      cli: "node /opt/jev-gate/dist/bundle/cli.cjs",
      intervalMs: 5_000,
      inject: true,
      ledger: "logs/jev.jsonl",
      provider: "openrouter",
      model: "typesafe/jev-1.13",
      apiKey: "test-key",
      base: "origin/main",
      timeoutMs: 30_000,
    },
    { directory: DIRECTORY },
  );
  assert.equal(options.cli, "node");
  assert.deepEqual(options.cliArgs, ["/opt/jev-gate/dist/bundle/cli.cjs"]);
  assert.equal(options.intervalMs, 5_000);
  assert.equal(options.inject, true);
  assert.equal(options.ledgerPath, `${DIRECTORY}/logs/jev.jsonl`);
  assert.equal(options.provider, "openrouter");
  assert.equal(options.base, "origin/main");

  const absolute = resolveOptions({ ledger: "/var/tmp/jev.jsonl" }, { directory: DIRECTORY });
  assert.equal(absolute.ledgerPath, "/var/tmp/jev.jsonl");
});

test("malformed options fail loudly instead of silently disabling the watch", () => {
  assert.throws(() => resolveOptions({ intervalMs: 10 }, { directory: DIRECTORY }), /intervalMs/);
  assert.throws(() => resolveOptions({ intervalMs: "5000" }, { directory: DIRECTORY }), /intervalMs/);
  assert.throws(() => resolveOptions({ inject: "yes" }, { directory: DIRECTORY }), /inject/);
  assert.throws(() => resolveOptions({ provider: "gemini" }, { directory: DIRECTORY }), /provider/);
  assert.throws(() => resolveOptions({ cli: "  " }, { directory: DIRECTORY }), /cli/);
  assert.throws(() => resolveOptions({ watch: true }, { directory: DIRECTORY }), /not a known setting/);
});

test("diff hashes are short, stable, and content-addressed", () => {
  const a = hashDiff("diff --git a/x b/x\n+one\n");
  assert.equal(a.length, 12);
  assert.equal(a, hashDiff("diff --git a/x b/x\n+one\n"));
  assert.notEqual(a, hashDiff("diff --git a/x b/x\n+two\n"));
});

test("outcome parsing keeps the decisions and drops unrecognizable shapes", () => {
  const outcome = sampleOutcome();
  assert.equal(outcome.model, "jev-test");
  assert.equal(outcome.decisions.length, 3);
  assert.deepEqual(outcome.decisions[1]?.samples, [0.52, 0.5]);
  assert.deepEqual(outcome.failedGates, ["danger-sensitive-area"]);

  assert.equal(parseOutcome("not json"), null);
  assert.equal(parseOutcome("{}"), null);
  assert.equal(parseOutcome('{"decisions":[],"failedGates":[]}')?.decisions.length, 0);
});

test("the briefing names the diff, the numbers, and the fallibility; it skips advisory-only runs", () => {
  const outcome = sampleOutcome();
  const briefing = formatBriefing(outcome, "abc123abc123");
  assert.ok(briefing !== null);
  assert.match(briefing, /diff abc123abc123/);
  assert.match(briefing, /danger-sensitive-area: 98% concern against a 60% threshold/);
  assert.match(briefing, /Do not edit code just to move the number/);
  assert.doesNotMatch(briefing, /test-meaningfulness/);

  const clean = { ...outcome, decisions: outcome.decisions.filter((decision) => !decision.failed) };
  assert.equal(formatBriefing(clean, "abc123abc123"), null);
});

test("a ledger line round-trips with the hash, verdicts, and injection flag", () => {
  const outcome = sampleOutcome();
  const line = ledgerLine(outcome, "abc123abc123", { injected: true });
  assert.equal(line.endsWith("\n"), true);
  const record = JSON.parse(line) as Record<string, unknown>;
  assert.equal(record["diffHash"], "abc123abc123");
  assert.equal(record["injected"], true);
  assert.deepEqual(record["failedGates"], ["danger-sensitive-area"]);
  assert.equal((record["decisions"] as unknown[]).length, 3);
  assert.equal(typeof record["ranAt"], "string");
});

test("the last reviewed hash comes from the ledger tail only", () => {
  assert.equal(lastLedgerHash(""), null);
  assert.equal(lastLedgerHash("not json\n"), null);
  assert.equal(lastLedgerHash('{"diffHash":"one"}\n'), "one");
  assert.equal(lastLedgerHash('{"diffHash":"one"}\n{"diffHash":"two"}\n'), "two");
  assert.equal(lastLedgerHash('{"diffHash":"one"}\n{"broken":'), "one");
  // A delivery record carries the hash too, so cross-session dedupe still sees it.
  assert.equal(lastLedgerHash(`{"diffHash":"one"}\n${deliveryLine("two", { agent: "build", messages: 2 })}`), "two");
});

test("a delivery line records the hash and the delivered flag", () => {
  const record = JSON.parse(deliveryLine("abc123abc123", { agent: "build", messages: 4 })) as Record<string, unknown>;
  assert.equal(record["diffHash"], "abc123abc123");
  assert.equal(record["delivered"], true);
  assert.equal(record["agent"], "build");
  assert.equal(typeof record["ranAt"], "string");
});
