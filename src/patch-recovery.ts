import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GitHubClient } from "./github.js";
import { isIgnored } from "./state.js";
import type { DiffFile, PullRequestContext } from "./types.js";

const MAX_FILES = 100;
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_TOTAL_BYTES = 16 * 1024 * 1024;

/** Diff inert text in fixed-name temporary files; never check out or execute PR code. */
export function patchFromContents(before: string, after: string): string {
  const dir = mkdtempSync(join(tmpdir(), "jev-patch-"));
  try {
    writeFileSync(join(dir, "before"), before, { mode: 0o600 });
    writeFileSync(join(dir, "after"), after, { mode: 0o600 });
    const result = spawnSync("git", [
      "-c", "core.attributesFile=/dev/null", "diff", "--no-index", "--no-ext-diff",
      "--no-textconv", "--text", "--unified=3", "--", "before", "after",
    ], {
      cwd: dir,
      env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_ATTR_NOSYSTEM: "1" },
      encoding: "utf8", timeout: 5000, maxBuffer: 8 * 1024 * 1024,
    });
    if (result.error || (result.status !== 0 && result.status !== 1))
      throw new Error("Git could not reconstruct the textual patch");
    if (result.status === 0) return "";
    const start = result.stdout.indexOf("@@ ");
    if (start < 0) throw new Error("Git returned no textual hunks");
    return result.stdout.slice(start).replace(/\n$/, "");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** GitHub can omit patches and even report zero line counts after its PR diff limit. */
export async function recoverPatches(
  client: Pick<GitHubClient, "getFileAtRef" | "getMergeBase">,
  pr: PullRequestContext,
  files: readonly DiffFile[],
  ignore: readonly string[],
): Promise<DiffFile[]> {
  let mergeBase: Promise<string> | undefined;
  let recovered = 0;
  let remaining = MAX_TOTAL_BYTES;
  const deadline = Date.now() + 120_000;
  const read = async (path: string, ref: string) => {
    if (remaining <= 0) throw new Error("Patch recovery reached its total byte limit");
    if (Date.now() >= deadline) throw new Error("Patch recovery reached its time limit");
    const allowance = Math.min(MAX_FILE_BYTES, remaining);
    const text = await client.getFileAtRef(pr.owner, pr.repo, path, ref, allowance, {
      regularOnly: true,
      onBytes: count => { remaining -= count; },
    });
    if (text === null) throw new Error("File was unavailable at the pinned revision");
    return text;
  };
  const result: DiffFile[] = [];
  for (const file of files) {
    if (isIgnored(file.path, ignore) || (file.patch && !file.patchWarning)) {
      result.push(file);
      continue;
    }
    try {
      if (recovered++ >= MAX_FILES) throw new Error("Patch recovery reached its file limit");
      if (file.previousPath && isIgnored(file.previousPath, ignore))
        throw new Error("The previous path is excluded by policy");
      if (!["added", "removed", "modified", "renamed", "copied", "changed"].includes(file.status))
        throw new Error("File status is not supported for patch recovery");
      let before = "";
      if (file.status !== "added" && file.status !== "copied") {
        mergeBase ??= client.getMergeBase(pr.owner, pr.repo, pr.baseSha, pr.headSha);
        before = await read(file.previousPath ?? file.path, await mergeBase);
      }
      const after = file.status === "removed" ? "" : await read(file.path, pr.headSha);
      const patch = patchFromContents(before, after);
      if (!patch) throw new Error("No textual change; file metadata was not reviewed");
      result.push({
        ...file, patch, patchWarning: undefined,
        additions: patch.split("\n").filter(line => line.startsWith("+")).length,
        deletions: patch.split("\n").filter(line => line.startsWith("-")).length,
      });
    } catch (error) {
      result.push({ ...file, patchWarning: `Patch recovery incomplete: ${error instanceof Error ? error.message : String(error)}` });
    }
  }
  return result;
}
