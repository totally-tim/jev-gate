import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ConfigError } from "./config.js";
import { localDiff } from "./gitdiff.js";

/** Git with a fixed identity and no user or system config, so tests stay hermetic. */
function git(dir: string, args: readonly string[]): string {
  return execFileSync("git", [...args], {
    cwd: dir,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_AUTHOR_NAME: "test",
      GIT_AUTHOR_EMAIL: "test@example.test",
      GIT_COMMITTER_NAME: "test",
      GIT_COMMITTER_EMAIL: "test@example.test",
    },
  });
}

/** A repository on `main` with one commit. */
function scratchRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "jev-gate-git-"));
  git(dir, ["init", "-b", "main"]);
  writeFileSync(join(dir, "app.ts"), "export const version = 1;\n");
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-m", "init"]);
  return dir;
}

test("the local diff spans branch commits, tracked edits, and untracked files", async () => {
  const dir = scratchRepo();
  try {
    git(dir, ["checkout", "-b", "feature"]);
    writeFileSync(join(dir, "app.ts"), "export const version = 2;\n");
    git(dir, ["commit", "-am", "bump"]);
    writeFileSync(join(dir, "app.ts"), "export const version = 3;\n");
    writeFileSync(join(dir, "note.md"), "fresh file\n");

    const local = await localDiff(undefined, dir);
    assert.equal(local.baseRef, "main");
    assert.equal(local.headSha.length, 40);
    // One diff against the merge base, so intermediate commits collapse into the net change.
    assert.match(local.diff, /\+export const version = 3;/);
    assert.doesNotMatch(local.diff, /\+export const version = 2;/);
    // Untracked files are newcomers to the change set and must appear.
    assert.match(local.diff, /^diff --git .* b\/note\.md$/m);
    assert.match(local.diff, /\+fresh file/);
    assert.deepEqual(local.warnings, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an explicit base ref wins over detection", async () => {
  const dir = scratchRepo();
  try {
    writeFileSync(join(dir, "app.ts"), "export const version = 2;\n");
    git(dir, ["commit", "-am", "bump"]);
    const local = await localDiff("HEAD~1", dir);
    assert.equal(local.baseRef, "HEAD~1");
    assert.match(local.diff, /\+export const version = 2;/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a clean checkout produces an empty diff", async () => {
  const dir = scratchRepo();
  try {
    const local = await localDiff(undefined, dir);
    assert.equal(local.diff.trim(), "");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the ledger directory never feeds back into the diff", async () => {
  const dir = scratchRepo();
  try {
    mkdirSync(join(dir, ".jev-gate"), { recursive: true });
    writeFileSync(join(dir, ".jev-gate", "ledger.jsonl"), "{\"run\":1}\n");
    assert.equal((await localDiff(undefined, dir)).diff.trim(), "");
    // The ledger changes on every review; without the exclusion each write would change
    // the diff hash and trigger the next review.
    writeFileSync(join(dir, ".jev-gate", "ledger.jsonl"), "{\"run\":1}\n{\"run\":2}\n");
    assert.equal((await localDiff(undefined, dir)).diff.trim(), "");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an untracked flood is skipped with a warning instead of reviewed", async () => {
  const dir = scratchRepo();
  try {
    mkdirSync(join(dir, "generated"), { recursive: true });
    assert.equal((await localDiff(undefined, dir)).diff.trim(), "");
    for (let index = 0; index <= 500; index += 1) {
      writeFileSync(join(dir, "generated", `file-${index}.txt`), "x\n");
    }
    const local = await localDiff(undefined, dir);
    assert.equal(local.diff.trim(), "", "no untracked patch enters the diff");
    assert.equal(local.warnings.length, 1);
    assert.match(local.warnings[0] ?? "", /skipped 501 untracked files/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("bad refs and non-repositories fail with a fixable error", async () => {
  const dir = scratchRepo();
  try {
    await assert.rejects(localDiff("does-not-exist", dir), ConfigError);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  const empty = mkdtempSync(join(tmpdir(), "jev-gate-git-empty-"));
  try {
    await assert.rejects(localDiff(undefined, empty), ConfigError);
  } finally {
    rmSync(empty, { recursive: true, force: true });
  }
});
