import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import plugin, { runProcess } from "./index.js";

test("the plugin runtime invokes its CLI, injects current findings, and restores delivery state", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "jev-plugin-runtime-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const cli = join(dir, "fake cli.cjs");
  writeFileSync(
    cli,
    `
const snapshot = {schema: 1, id: 'a'.repeat(64), config: {provider: 'openrouter'}};
if (process.argv[2] === 'snapshot') console.log(JSON.stringify(snapshot));
else {
 let input = ''; process.stdin.on('data', c => input += c); process.stdin.on('end', () => {
 if (JSON.parse(input).id !== snapshot.id || process.env.OPENROUTER_API_KEY !== 'adapter-test') process.exit(3);
 console.log(JSON.stringify({schema: 2, snapshotId: snapshot.id, policyHash: 'b'.repeat(64), model: 'mock', health: 'complete', status: 'needs-review', errors: [], findings: [{id: '1'.repeat(24), rule: 'breaking-change', title: 'Contract change', path: 'api.ts', startLine: 3, status: 'open', verification: 'Inspect callers', category: 'potential-issue'}]}));
 });
}
`,
  );
  type Context = Parameters<typeof plugin.setup>[0];
  let hook: (event: {
    sessionID: string;
    system: Array<{ type: string; text: string }>;
  }) => Promise<void>;
  const ctx = {
    location: { directory: dir },
    options: {
      cli: [process.execPath, cli],
      apiKey: "adapter-test",
      inject: true,
    },
    session: {
      hook: async (_: string, fn: typeof hook) => {
        hook = fn;
      },
    },
  } as unknown as Context;
  const stop = await plugin.setup(ctx);
  const first = {
    sessionID: "one",
    system: [] as Array<{ type: string; text: string }>,
  };
  await hook!(first);
  assert.equal(first.system.length, 1);
  assert.match(first.system[0]!.text, /api.ts/);
  await stop();
  const stopAgain = await plugin.setup(ctx);
  const same = {
    sessionID: "one",
    system: [] as Array<{ type: string; text: string }>,
  };
  await hook!(same);
  assert.equal(same.system.length, 0);
  const next = { ...same, sessionID: "two" };
  await hook!(next);
  assert.equal(next.system.length, 1);
  await stopAgain();
  const records = readFileSync(join(dir, ".jev-gate/ledger.jsonl"), "utf8");
  assert.equal(records.split('"type":"assessment"').length - 1, 1);
  assert.equal(records.split('"type":"delivery"').length - 1, 2);
});

test(
  "process timeout cancels the owned child and its descendant",
  { skip: process.platform === "win32" },
  async (t) => {
    const dir = mkdtempSync(join(tmpdir(), "jev-process-runtime-"));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const pidFile = join(dir, "pid");
    await assert.rejects(
      runProcess(
        process.execPath,
        [
          "-e",
          `const {spawn}=require('node:child_process'); const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'inherit'}); require('node:fs').writeFileSync(process.argv[1],String(child.pid)); setInterval(()=>{},1000);`,
          pidFile,
        ],
        {
          cwd: dir,
          env: process.env,
          timeoutMs: 500,
          signal: new AbortController().signal,
        },
      ),
      /timed out/,
    );
    const pid = Number(readFileSync(pidFile, "utf8"));
    assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
  },
);
