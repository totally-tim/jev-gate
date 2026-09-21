import assert from "node:assert/strict";
import { test } from "node:test";
import { patchFromContents, recoverPatches } from "./patch-recovery.js";
import { GitHubClient } from "./github.js";
import { localContext } from "./snapshot.js";
import { file } from "./test-fixtures.js";
test("reconstruction preserves changed lines, whitespace, and missing final newlines", () => {
    const patch = patchFromContents("old\n", "new  ");
    assert.match(patch, /-old\n\+new  \n\\ No newline at end of file/);
    assert.equal(patchFromContents("same\n", "same\n"), "");
});
test("missing patches and zero GitHub counts recover from exact head and merge-base", async () => {
    const files = [{ ...file("", "src/a.ts"), patch: null, additions: 0, deletions: 0 }];
    const pr = localContext(files);
    pr.baseSha = "b".repeat(40);
    pr.headSha = "c".repeat(40);
    const reads = [];
    const results = await recoverPatches({
        getMergeBase: async (_o, _r, base, head) => {
            assert.equal(base, pr.baseSha);
            assert.equal(head, pr.headSha);
            return "a".repeat(40);
        },
        getFileAtRef: async (_o, _r, path, ref) => { reads.push(`${path}@${ref}`); return ref === pr.headSha ? "new\n" : "old\n"; },
    }, pr, files, []);
    assert.deepEqual(reads, [`src/a.ts@${"a".repeat(40)}`, `src/a.ts@${pr.headSha}`]);
    assert.equal(results[0]?.additions, 1);
    assert.equal(results[0]?.deletions, 1);
    assert.match(results[0]?.patch ?? "", /-old\n\+new/);
    assert.equal(results[0]?.patchWarning, undefined);
});
test("added, removed, and renamed files use the correct side and path", async () => {
    const files = [
        { ...file("", "new.ts"), status: "added", patch: null },
        { ...file("", "gone.ts"), status: "removed", patch: null },
        { ...file("", "renamed.ts"), status: "renamed", previousPath: "old.ts", patch: null },
    ];
    const pr = localContext(files);
    pr.headSha = "c".repeat(40);
    const reads = [];
    let merges = 0;
    const result = await recoverPatches({
        getMergeBase: async () => { merges++; return "a".repeat(40); },
        getFileAtRef: async (_o, _r, path, ref) => { reads.push(path); return ref === pr.headSha ? "after\n" : "before\n"; },
    }, pr, files, []);
    assert.deepEqual(reads, ["new.ts", "gone.ts", "old.ts", "renamed.ts"]);
    assert.equal(merges, 1);
    assert.equal(result[0]?.deletions, 0);
    assert.equal(result[1]?.additions, 0);
    assert.equal(result[2]?.previousPath, "old.ts");
});
test("ignored files never fetch content and failed recovery preserves existing partial evidence", async () => {
    const files = [
        { ...file("", "private/data.txt"), patch: null },
        { ...file("@@ -1 +1 @@\n-old\n+new"), patchWarning: "incomplete" },
    ];
    let reads = 0;
    const result = await recoverPatches({
        getMergeBase: async () => "a".repeat(40),
        getFileAtRef: async () => { reads++; throw new Error("unavailable"); },
    }, localContext(files), files, ["private/**"]);
    assert.equal(reads, 1);
    assert.deepEqual(result[0], files[0]);
    assert.equal(result[1]?.patch, files[1]?.patch);
    assert.match(result[1]?.patchWarning ?? "", /recovery incomplete/);
});
test("recovery stops at file and byte budgets without claiming completion", async () => {
    const files = Array.from({ length: 102 }, (_, i) => ({ ...file("", `${i}.ts`), status: "added", patch: null }));
    let reads = 0;
    const client = {
        getMergeBase: async () => { throw new Error("unexpected merge-base call"); },
        getFileAtRef: async () => { reads++; return "x\n"; },
    };
    const result = await recoverPatches(client, localContext(files), files, []);
    assert.equal(reads, 100);
    assert.match(result[100]?.patchWarning ?? "", /file limit/);
    reads = 0;
    const limited = await recoverPatches({ ...client, getFileAtRef: async (_o, _r, _p, _s, _max, options) => { reads++; options?.onBytes?.(2 * 1024 * 1024); throw new Error("too large"); } }, localContext(files), files, []);
    assert.equal(reads, 8);
    assert.match(limited[8]?.patchWarning ?? "", /total byte limit/);
});
test("raw GitHub content rejects binary, invalid UTF-8, and oversized streamed responses", async () => {
    for (const bytes of [Buffer.from([0, 1]), Buffer.from([0xff]), Buffer.alloc(9, 65)]) {
        const client = new GitHubClient("test", async () => new Response(bytes));
        await assert.rejects(client.getFileAtRef("o", "r", "a", "b".repeat(40), 8));
    }
    const client = new GitHubClient("test", async () => new Response("hello\n"));
    assert.equal(await client.getFileAtRef("o", "r", "a", "b".repeat(40), 8), "hello\n");
    const bom = new GitHubClient("test", async () => new Response("\uFEFFtext\n"));
    assert.equal(await bom.getFileAtRef("o", "r", "a", "b".repeat(40), 8), "\uFEFFtext\n");
});
test("small failed reads do not consume full per-file byte allowances", async () => {
    const files = Array.from({ length: 9 }, (_, i) => ({ ...file("", `${i}.ts`), status: "added", patch: null }));
    let reads = 0;
    const result = await recoverPatches({
        getMergeBase: async () => { throw new Error("unexpected"); },
        getFileAtRef: async (_o, _r, _p, _s, _max, options) => {
            options?.onBytes?.(4);
            reads++;
            if (reads < 9)
                throw new Error("Binary file");
            return "new\n";
        },
    }, localContext(files), files, []);
    assert.equal(reads, 9);
    assert.match(result[8]?.patch ?? "", /\+new/);
});
test("a rename from an ignored path is not fetched for recovery", async () => {
    const files = [{ ...file("", "public.ts"), status: "renamed", previousPath: "private/a.ts", patch: null }];
    const result = await recoverPatches({
        getMergeBase: async () => { throw new Error("must not fetch"); },
        getFileAtRef: async () => { throw new Error("must not fetch"); },
    }, localContext(files), files, ["private/**"]);
    assert.match(result[0]?.patchWarning ?? "", /previous path is excluded/);
});
test("recovery never follows symlinks or submodules through the contents API", async () => {
    let contentReads = 0;
    let treeReads = 0;
    const client = new GitHubClient("test", async (url) => {
        if (String(url).includes("/git/trees/")) {
            treeReads++;
            return new Response(JSON.stringify({ truncated: false, tree: [
                    { path: "alias", type: "blob", mode: "120000" },
                    { path: "module", type: "commit", mode: "160000" },
                ] }));
        }
        contentReads++;
        return new Response("ignored target content");
    });
    for (const path of ["alias", "module"])
        await assert.rejects(client.getFileAtRef("o", "r", path, "a".repeat(40), 100, { regularOnly: true }), /regular files only/);
    assert.equal(treeReads, 1);
    assert.equal(contentReads, 0);
    const truncated = new GitHubClient("test", async () => new Response(JSON.stringify({ truncated: true, tree: [] })));
    await assert.rejects(truncated.getFileAtRef("o", "r", "a", "a".repeat(40), 100, { regularOnly: true }), /tree is incomplete/);
});
