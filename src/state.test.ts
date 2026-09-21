import assert from "node:assert/strict";
import { test } from "node:test";
import {
  candidatesFor,
  matchGlob,
  estimateTokens,
  buildState,
} from "./state.js";
import { localContext } from "./snapshot.js";
import { file } from "./test-fixtures.js";
test("glob matching covers root paths, nested paths, and literal punctuation", () => {
  assert.ok(matchGlob("**/dist/**", "dist/a.js"));
  assert.ok(matchGlob("**/*.test.ts", "a/b.test.ts"));
  assert.equal(matchGlob("src/*.ts", "src/nested/a.ts"), false);
  assert.ok(matchGlob("a[1].ts", "a[1].ts"));
});
test("test candidates receive bounded context from their related implementation", () => {
  const testFile = file(
    "@@ -1 +0,0 @@\n-test('legacy', run);",
    "src/auth.test.ts",
  );
  const implementation = file(
    "@@ -1 +0,0 @@\n-export function legacy() {}",
    "src/auth.ts",
  );
  const state = buildState(
    localContext([testFile, implementation]),
    candidatesFor(testFile, 1000)[0]!,
    [testFile, implementation],
  );
  assert.equal(state.relatedChanges?.[0]?.path, "src/auth.ts");
  assert.match(state.relatedChanges?.[0]?.patch ?? "", /legacy/);
});
test("candidate locations distinguish deleted code from added code", () => {
  const candidates = candidatesFor(
    file("@@ -15,2 +15,0 @@\n-old\n-code"),
    1000,
  );
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0]?.side, "old");
  assert.equal(candidates[0]?.startLine, 15);
  assert.equal(candidates[0]?.endLine, 16);
  const added = candidatesFor(file("@@ -0,0 +1,2 @@\n+one\n+two"), 1000);
  assert.equal(added[0]?.side, "new");
  assert.equal(added[0]?.startLine, 1);
});
test("candidate splitting preserves oversized lines for explicit budget errors", () => {
  const patch = "@@ -0,0 +1,3 @@\n+one\n+" + "x".repeat(5000) + "\n+last";
  const candidates = candidatesFor(file(patch), 1000);
  assert.ok(candidates.some((c) => c.patch.includes("x".repeat(5000))));
  assert.ok(candidates.some((c) => c.patch.includes("+last")));
  assert.equal(estimateTokens("ü"), 2);
});

test("later chunks retain bounded opening context from the same file", () => {
  const report = file(
    '@@ -0,0 +1,20 @@\n+{"purpose":"review report, not executable code"}\n' +
      Array.from({ length: 19 }, (_, i) => `+{"reviewed_security_item":${i}}`).join("\n"),
    "reports/review.json",
  );
  const candidates = candidatesFor(report, 150);
  assert.ok(candidates.length > 1);
  const last = candidates.at(-1)!;
  const state = buildState(localContext([report]), last, [report]);
  assert.match(
    state.fileContext?.openingPatch ?? "",
    /review report, not executable code/,
  );
  assert.ok((state.fileContext?.openingPatch.length ?? Infinity) <= 1000);
  assert.equal(state.files[0]?.patch, last.patch);
  assert.equal(
    buildState(localContext([report]), candidates[0]!, [report]).fileContext,
    undefined,
  );
});
