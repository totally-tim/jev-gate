import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { ConfigError } from "./config.js";
const execGit = promisify(execFile);
/** Confidence that a candidate base branch exists locally or as a remote-tracking ref. */
const CANDIDATE_BASES = ["origin/HEAD", "origin/main", "origin/master", "main", "master"];
/** Untracked files are diffed one by one; past this many, they are skipped with a warning. */
const MAX_UNTRACKED_FILES = 500;
const MAX_BUFFER = 64 * 1024 * 1024;
async function git(args, cwd) {
    try {
        const { stdout } = await execGit("git", [...args], { cwd, maxBuffer: MAX_BUFFER });
        return stdout;
    }
    catch (error) {
        const stderr = error.stderr?.trim();
        const detail = stderr && stderr !== "" ? stderr.replace(/^fatal:\s*/i, "") : error.message;
        throw new ConfigError(`git ${args[0]} failed: ${detail}`);
    }
}
/** Resolve a ref to a commit id, or null when it does not exist. */
async function revParse(ref, cwd) {
    try {
        const { stdout } = await execGit("git", ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], { cwd });
        return stdout.trim() === "" ? null : stdout.trim();
    }
    catch {
        return null;
    }
}
/** The base ref to compare against: the explicit one, or the first default-branch candidate. */
export async function resolveBaseRef(explicit, cwd) {
    if (explicit !== undefined) {
        if ((await revParse(explicit, cwd)) === null) {
            throw new ConfigError(`base ref ${explicit} does not resolve to a commit`);
        }
        return explicit;
    }
    for (const candidate of CANDIDATE_BASES) {
        if ((await revParse(candidate, cwd)) !== null)
            return candidate;
    }
    throw new ConfigError(`cannot detect a base branch (tried ${CANDIDATE_BASES.join(", ")}); pass --base <ref>`);
}
/** Patches for files git does not track yet; `git diff` alone never shows them. */
async function untrackedPatches(cwd) {
    const listed = (await git(["ls-files", "-z", "--others", "--exclude-standard"], cwd))
        .split("\0")
        .filter((path) => path !== "");
    if (listed.length === 0)
        return { patch: "", warning: null };
    const warning = listed.length > MAX_UNTRACKED_FILES
        ? `skipped ${listed.length} untracked files (cap is ${MAX_UNTRACKED_FILES}); ` +
            "git add or gitignore them to bring them into the review"
        : null;
    const paths = warning === null ? listed : listed.slice(0, MAX_UNTRACKED_FILES);
    let patch = "";
    for (const path of paths) {
        try {
            const { stdout } = await execGit("git", ["diff", "--no-index", "--no-color", "--", "/dev/null", path], {
                cwd,
                maxBuffer: MAX_BUFFER,
            });
            patch += stdout;
        }
        catch (error) {
            // `--no-index` exits 1 whenever the files differ, which is the normal case.
            patch += error.stdout ?? "";
        }
    }
    return { patch, warning };
}
/**
 * The local change set: everything committed on this branch since the merge base with the
 * base ref, plus staged, unstaged, and untracked working-tree files, as one unified diff.
 * That is the same shape GitHub shows for a pull request, with uncommitted work included.
 */
export async function localDiff(explicitBase, cwd) {
    // Fail with git's own message when this is not a repository or HEAD has no commit yet.
    const headSha = (await git(["rev-parse", "HEAD"], cwd)).trim();
    const baseRef = await resolveBaseRef(explicitBase, cwd);
    const baseSha = (await git(["merge-base", baseRef, "HEAD"], cwd)).trim();
    const tracked = await git(["diff", "--no-color", "--no-ext-diff", baseSha], cwd);
    const untracked = await untrackedPatches(cwd);
    return {
        diff: tracked + untracked.patch,
        baseRef,
        baseSha,
        headSha,
        warnings: untracked.warning === null ? [] : [untracked.warning],
    };
}
