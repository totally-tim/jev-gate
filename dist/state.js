/** Rough token estimate from characters, used only for the state budget. */
export function estimateTokens(text) {
    return Math.ceil(text.length / 4);
}
/** Largest patch kept per file before the global budget trims further. */
export const MAX_PATCH_CHARS_PER_FILE = 8_000;
const MAX_TITLE_CHARS = 300;
const MAX_DESCRIPTION_CHARS = 4_000;
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
function isIgnored(path, ignore) {
    return ignore.some((pattern) => matchGlob(pattern, path));
}
function clip(text, limit) {
    return text.length <= limit ? text : `${text.slice(0, limit)}\n[clipped]`;
}
/**
 * Build the state sent to Jev. Files are filtered by the ignore globs and sorted for
 * determinism; when the estimate exceeds the token budget, patches are dropped from the
 * largest files first until the state fits, and the truncation is reported in the state.
 */
export function buildState(pr, files, config) {
    const kept = files
        .filter((file) => !isIgnored(file.path, config.ignore))
        .slice()
        .sort((a, b) => a.path.localeCompare(b.path));
    const entries = kept.map((file) => {
        const entry = {
            path: file.path,
            status: file.status,
            additions: file.additions,
            deletions: file.deletions,
        };
        if (file.patch !== null && file.patch.trim() !== "") {
            entry.patch = clip(file.patch, MAX_PATCH_CHARS_PER_FILE);
        }
        return entry;
    });
    const state = {
        pr: {
            title: clip(pr.title, MAX_TITLE_CHARS),
            description: clip(pr.body.trim(), MAX_DESCRIPTION_CHARS),
            author: pr.author,
            base: pr.baseRef,
            head: pr.headSha.slice(0, 12),
        },
        totals: {
            files: kept.length,
            additions: pr.additions,
            deletions: pr.deletions,
            commits: pr.commits,
        },
        files: entries,
        truncated: false,
    };
    const fits = () => estimateTokens(JSON.stringify(state)) <= config.maxStateTokens;
    const truncatedPaths = [];
    if (!fits()) {
        // Drop patches from the largest first; a file's metadata stays.
        const byPatchSize = entries
            .filter((entry) => entry.patch !== undefined)
            .sort((a, b) => (b.patch?.length ?? 0) - (a.patch?.length ?? 0));
        for (const entry of byPatchSize) {
            delete entry.patch;
            truncatedPaths.push(entry.path);
            if (fits())
                break;
        }
    }
    if (!fits()) {
        // Even metadata-heavy states must fit: drop the tail of the file list.
        while (entries.length > 0 && !fits()) {
            const dropped = entries.pop();
            if (dropped)
                truncatedPaths.push(dropped.path);
        }
    }
    state.truncated = truncatedPaths.length > 0;
    return { state, truncatedPaths };
}
