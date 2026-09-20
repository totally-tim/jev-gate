import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { collectSnapshot } from "./snapshot.js";
import { parseUnifiedDiff } from "./diff.js";
const env = {
    ...process.env,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: "test",
    GIT_AUTHOR_EMAIL: "test@example.test",
    GIT_COMMITTER_NAME: "test",
    GIT_COMMITTER_EMAIL: "test@example.test",
};
test("quoted Unicode, spaces, renames, and binary paths remain in the collected scope", () => {
    const d = parseUnifiedDiff('diff --git "a/\\303\\274ber.ts" "b/\\303\\274ber.ts"\n--- "a/\\303\\274ber.ts"\n+++ "b/\\303\\274ber.ts"\n@@ -1 +1 @@\n-old\n+new\ndiff --git a/a b/a b/a b/a\n--- a/a b/a\n+++ b/a b/a\n@@ -1 +1 @@\n-old\n+new\ndiff --git a/p.png b/p.png\nBinary files a/p.png and b/p.png differ\n');
    assert.equal(d.files[0]?.path, "über.ts");
    assert.equal(d.files[1]?.path, "a b/a");
    assert.equal(d.files[2]?.patch, null);
    assert.equal(d.warnings.length, 0);
});
test("local config discovery and base policy use explicit distinct identities", async () => {
    const dir = mkdtempSync(join(tmpdir(), "jev-config-"));
    const git = (...args) => execFileSync("git", args, { cwd: dir, env, stdio: "ignore" });
    try {
        git("init", "-b", "main");
        writeFileSync(join(dir, "a.ts"), "export const a=1;\n");
        writeFileSync(join(dir, ".jev-gate.yml"), "rules:\n  breaking-change:\n    enabled: false\n");
        git("add", ".");
        git("commit", "-m", "base");
        writeFileSync(join(dir, ".jev-gate.yml"), "rules:\n  breaking-change:\n    enabled: true\n");
        mkdirSync(join(dir, "sub"));
        const working = await collectSnapshot({
            cwd: join(dir, "sub"),
            base: "main",
        });
        const base = await collectSnapshot({
            cwd: dir,
            base: "main",
            policySource: "base",
        });
        assert.equal(working.config.rules.find((r) => r.name === "breaking-change")?.enabled, true);
        assert.equal(base.config.rules.find((r) => r.name === "breaking-change")?.enabled, false);
        assert.notEqual(working.policyHash, base.policyHash);
    }
    finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
