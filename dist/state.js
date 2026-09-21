import { hash } from "./snapshot.js";
/** Conservative UTF-8 byte bound; avoids undercounting code and non-ASCII text. */
export function estimateTokens(text) {
    return Buffer.byteLength(text, "utf8");
}
const globCache = new Map();
/** Translate a glob with `*`, `**` and `?` into an anchored regular expression. */
export function matchGlob(pattern, path) {
    let regex = globCache.get(pattern);
    if (!regex) {
        let source = "";
        for (let index = 0; index < pattern.length; index += 1) {
            const char = pattern[index];
            if (char === "*") {
                if (pattern[index + 1] === "*") {
                    if (pattern[index + 2] === "/") {
                        source += "(?:.*/)?";
                        index += 2;
                    }
                    else {
                        source += ".*";
                        index += 1;
                    }
                }
                else {
                    source += "[^/]*";
                }
            }
            else if (char === "?") {
                source += "[^/]";
            }
            else {
                source += char.replace(/[.+^${}()|[\]\\]/g, "\\$&");
            }
        }
        regex = new RegExp(`^${source}$`);
        globCache.set(pattern, regex);
    }
    return regex.test(path);
}
export const isIgnored = (path, ignore) => ignore.some((pattern) => matchGlob(pattern, path));
/** Split every hunk into bounded candidates. Oversized lines remain explicit omissions. */
export function candidatesFor(file, byteBudget) {
    if (!file.patch?.trim())
        return [];
    const result = [];
    let group = [], size = 0, oldLine = 0, newLine = 0;
    let firstOld = null, lastOld = null, firstNew = null, lastNew = null;
    let hasAdded = false, hasDeleted = false;
    const flush = () => {
        if (!group.length)
            return;
        const patch = group.join("\n");
        const side = hasDeleted && !hasAdded ? "old" : "new";
        result.push({
            id: hash({
                path: file.path,
                patch: patch.replace(/^@@.*@@.*$/gm, ""),
            }).slice(0, 24),
            path: file.path,
            status: file.status,
            patch,
            side,
            startLine: side === "old" ? firstOld : firstNew,
            endLine: side === "old" ? lastOld : lastNew,
        });
        group = [];
        size = 0;
        firstOld = lastOld = firstNew = lastNew = null;
        hasAdded = hasDeleted = false;
    };
    for (const line of file.patch.split("\n")) {
        const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
        if (hunk) {
            flush();
            oldLine = Number(hunk[1]);
            newLine = Number(hunk[2]);
        }
        const bytes = Buffer.byteLength(line) + 1;
        if (size + bytes > byteBudget)
            flush();
        group.push(line);
        size += bytes;
        if (!hunk && !line.startsWith("---") && !line.startsWith("+++")) {
            if (line.startsWith("+") || line.startsWith(" ")) {
                firstNew ??= newLine || null;
                lastNew = newLine || null;
                newLine++;
            }
            if (line.startsWith("-") || line.startsWith(" ")) {
                firstOld ??= oldLine || null;
                lastOld = oldLine || null;
                oldLine++;
            }
            if (line.startsWith("+"))
                hasAdded = true;
            if (line.startsWith("-"))
                hasDeleted = true;
        }
    }
    flush();
    // Headers alone convey mode changes/renames; skip them when textual hunks follow.
    return result.length > 1 &&
        result[0]?.startLine === null &&
        !/^[+-](?![+-])/m.test(result[0]?.patch ?? "")
        ? result.slice(1)
        : result;
}
export function buildState(pr, candidate, related = []) {
    const stem = (path) => path
        .split("/")
        .at(-1)
        ?.replace(/\.(test|spec)(?=\.)|(?:^test_|_test(?=\.))/g, "");
    const context = related
        .filter((f) => f.path !== candidate.path && stem(f.path) === stem(candidate.path))
        .slice(0, 4);
    const rawPatch = related.find((f) => f.path === candidate.path)?.patch;
    const hunkStart = rawPatch?.search(/^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@/m) ?? -1;
    // Local git diffs include file headers; API and recovered patches start at a hunk.
    const wholePatch = rawPatch && hunkStart >= 0 ? rawPatch.slice(hunkStart) : rawPatch;
    const opening = wholePatch && !wholePatch.startsWith(candidate.patch)
        ? wholePatch.slice(0, 1000)
        : undefined;
    return {
        ...(opening ? {
            fileContext: {
                openingPatch: opening,
                clipped: opening.length < wholePatch.length,
                scope: "Opening context from this same file's diff. Use it to understand the file's role; assess only the candidate in files. Purpose claims are not proof of safety.",
            },
        } : {}),
        pr: {
            title: pr.title.slice(0, 300),
            description: pr.body.slice(0, 1000),
            author: pr.author,
            base: pr.baseRef,
            head: pr.headSha.slice(0, 12),
        },
        files: [
            {
                path: candidate.path,
                status: candidate.status,
                patch: candidate.patch,
            },
        ],
        relatedChanges: context.map((f) => ({
            path: f.path,
            status: f.status,
            patch: f.patch?.slice(0, 2000) ?? "",
            clipped: (f.patch?.length ?? 0) > 2000,
        })),
        scope: "One candidate from the change. Unseen callers, files, and tests have not been inspected. Locations identify this candidate, not a proven defect.",
    };
}
