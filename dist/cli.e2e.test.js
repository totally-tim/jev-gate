import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
const exec = promisify(execFile);
const bundle = resolve("dist/bundle/cli.cjs");
const diff = "diff --git a/auth.ts b/auth.ts\n--- a/auth.ts\n+++ b/auth.ts\n@@ -1 +1 @@\n-export const check = true;\n+export const check = false;\n";
async function fixture(t) {
    const dir = mkdtempSync(join(tmpdir(), "jev-cli-runtime-"));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    let mode = "finding", requests = 0;
    const server = createServer(async (req, res) => {
        const chunks = [];
        for await (const chunk of req)
            chunks.push(chunk);
        const body = JSON.parse(Buffer.concat(chunks).toString());
        requests++;
        const answers = Object.fromEntries(Object.entries(body.questions).map(([name, q]) => [
            name,
            q.type === "noul"
                ? { type: "noul", noul: name === "breaking-change" ? 0.99 : 0.01 }
                : { type: "score", score: 0, confidence: 1 },
        ]));
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({
            model: "jev-test",
            answers: mode === "missing" ? {} : answers,
        }));
    });
    await new Promise((done) => server.listen(0, "127.0.0.1", done));
    t.after(() => new Promise((done) => server.close(() => done())));
    const address = server.address();
    const env = {
        ...process.env,
        OPENROUTER_API_KEY: "runtime-test",
        OPENROUTER_BASE_URL: `http://127.0.0.1:${address.port}`,
        TYPESAFE_API_KEY: "",
    };
    writeFileSync(join(dir, "change.diff"), diff);
    writeFileSync(join(dir, ".jev-gate.yml"), "provider: openrouter\nmode: required\n");
    async function run(...args) {
        try {
            const r = await exec(process.execPath, [bundle, ...args], {
                cwd: dir,
                env,
            });
            return { ...r, code: 0 };
        }
        catch (e) {
            const r = e;
            return { stdout: r.stdout, stderr: r.stderr, code: r.code };
        }
    }
    return {
        dir,
        run,
        requests: () => requests,
        missing: () => {
            mode = "missing";
        },
    };
}
test("bundled CLI discovers policy, preserves snapshot identity, and refreshes resolved findings", async (t) => {
    const f = await fixture(t);
    const first = await f.run("review", "--diff", "change.diff", "--json");
    assert.equal(first.code, 1);
    const o = JSON.parse(first.stdout);
    assert.equal(o.health, "complete");
    const captured = await f.run("snapshot", "--diff", "change.diff");
    const snapshot = JSON.parse(captured.stdout);
    assert.equal(snapshot.id, o.snapshotId);
    writeFileSync(join(f.dir, "snapshot.json"), captured.stdout);
    assert.equal((await f.run("resolve", o.findings[0].id, "--status", "accepted", "--reason", "Callers migrate together")).code, 0);
    const stale = await f.run("review", "--snapshot", "snapshot.json", "--json");
    assert.equal(stale.code, 2);
    assert.match(stale.stdout, /dispositions changed/);
    const resolved = await f.run("review", "--diff", "change.diff", "--json");
    assert.equal(resolved.code, 0);
    const next = JSON.parse(resolved.stdout);
    assert.notEqual(next.snapshotId, o.snapshotId);
    assert.equal(next.findings[0].status, "accepted");
    assert.equal(next.findings[0].id, o.findings[0].id);
    assert.equal(f.requests(), 2);
});
test("bundled CLI emits structured empty, malformed, and unavailable results", async (t) => {
    const f = await fixture(t);
    writeFileSync(join(f.dir, "empty.diff"), "");
    const empty = await f.run("review", "--diff", "empty.diff", "--json");
    assert.equal(empty.code, 0);
    assert.equal(JSON.parse(empty.stdout).status, "clear");
    writeFileSync(join(f.dir, "bad.diff"), "not a git diff");
    const bad = await f.run("review", "--diff", "bad.diff", "--json");
    assert.equal(bad.code, 2);
    assert.ok(JSON.parse(bad.stdout).coverage.warnings.length);
    assert.equal(f.requests(), 0);
    f.missing();
    const missing = await f.run("review", "--diff", "change.diff", "--json", "--no-gate");
    assert.equal(missing.code, 2);
    assert.equal(JSON.parse(missing.stdout).health, "unavailable");
    assert.equal((await f.run("diff", "--mode", "required")).code, 2);
});
test("calibration rejects missing answers instead of reporting a clean evaluation", async (t) => {
    const f = await fixture(t);
    mkdirSync(join(f.dir, "samples"));
    writeFileSync(join(f.dir, "samples", "one.diff"), diff);
    writeFileSync(join(f.dir, "samples", "labels.json"), JSON.stringify({
        schema: 1,
        samples: {
            "one.diff": { split: "holdout", expected: { "breaking-change": true } },
        },
    }));
    f.missing();
    const result = await f.run("calibrate", "--dir", "samples", "--split", "holdout", "--json");
    const evaluation = JSON.parse(result.stdout);
    assert.equal(result.code, 2);
    assert.equal(evaluation.valid, false);
    assert.equal(evaluation.metrics["breaking-change"].unavailable, 1);
    assert.equal(evaluation.metrics["breaking-change"].tp, 0);
    assert.equal(evaluation.metrics["breaking-change"].precision, null);
});
