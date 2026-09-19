import assert from "node:assert/strict";
import { test } from "node:test";
import { parseDiff } from "./cli.js";
const SAMPLE = [
    "diff --git a/src/auth.ts b/src/auth.ts",
    "index 1111111..2222222 100644",
    "--- a/src/auth.ts",
    "+++ b/src/auth.ts",
    "@@ -1,3 +1,4 @@",
    " export function login() {",
    "-  return oldPath();",
    "+  const user = currentUser();",
    "+  return loginWith(user);",
    " }",
    "diff --git a/src/new.test.ts b/src/new.test.ts",
    "new file mode 100644",
    "index 0000000..3333333",
    "--- /dev/null",
    "+++ b/src/new.test.ts",
    "@@ -0,0 +1,2 @@",
    "+test('works', () => {",
    "+  expect(login()).toBe(true);",
    "+});",
    "diff --git a/old.ts b/old.ts",
    "deleted file mode 100644",
    "--- a/old.ts",
    "+++ /dev/null",
    "@@ -1 +0,0 @@",
    "-export const old = true;",
    "",
].join("\n");
test("the diff parser keeps paths, statuses, and line counts", () => {
    const files = parseDiff(SAMPLE);
    assert.equal(files.length, 3);
    assert.deepEqual(files.map((file) => [file.path, file.status]), [
        ["src/auth.ts", "modified"],
        ["src/new.test.ts", "added"],
        ["old.ts", "removed"],
    ]);
    assert.equal(files[0]?.additions, 2);
    assert.equal(files[0]?.deletions, 1);
    assert.equal(files[1]?.additions, 3);
    assert.equal(files[2]?.deletions, 1);
});
test("text without diff headers yields no files", () => {
    assert.deepEqual(parseDiff("just some text\n"), []);
});
