/** Decode Git's C-quoted byte paths, including UTF-8 octal escapes. */
export function decodeGitPath(value) {
    if (!value.startsWith('"'))
        return value;
    if (!value.endsWith('"'))
        throw new Error("unterminated Git path");
    const bytes = [];
    const text = value.slice(1, -1);
    for (let i = 0; i < text.length;) {
        if (text[i] !== "\\") {
            const point = String.fromCodePoint(text.codePointAt(i));
            bytes.push(...Buffer.from(point));
            i += point.length;
            continue;
        }
        const octal = /^[0-7]{1,3}/.exec(text.slice(i + 1));
        if (octal) {
            bytes.push(parseInt(octal[0], 8));
            i += 1 + octal[0].length;
            continue;
        }
        const escaped = text[++i];
        const escapes = {
            n: "\n",
            r: "\r",
            t: "\t",
            b: "\b",
            f: "\f",
            v: "\v",
            a: "\x07",
            '"': '"',
            "\\": "\\",
        };
        if (escaped === undefined || escapes[escaped] === undefined)
            throw new Error("invalid Git path escape");
        bytes.push(...Buffer.from(escapes[escaped]));
        i++;
    }
    return new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(bytes));
}
function headerPaths(header) {
    const quoted = /^diff --git ("(?:[^"\\]|\\.)*"|a\/.+) ("(?:[^"\\]|\\.)*"|b\/.+)$/.exec(header);
    if (!quoted)
        return null;
    return [
        decodeGitPath(quoted[1]).replace(/^a\//, ""),
        decodeGitPath(quoted[2]).replace(/^b\//, ""),
    ];
}
export function parseUnifiedDiff(text) {
    const files = [], warnings = [];
    const chunks = text
        .split(/^(?=diff --git )/m)
        .filter((s) => s.startsWith("diff --git "));
    if (text.trim() && !chunks.length)
        warnings.push("Input is nonempty but contains no supported Git diff headers.");
    for (const [index, chunk] of chunks.entries()) {
        try {
            const paths = headerPaths(chunk.split("\n")[0]);
            if (!paths)
                throw new Error("unrecognized Git header");
            const status = /^new file mode/m.test(chunk)
                ? "added"
                : /^deleted file mode/m.test(chunk)
                    ? "removed"
                    : /^rename from /m.test(chunk)
                        ? "renamed"
                        : "modified";
            const lines = chunk.split("\n");
            const marker = lines.find((line) => line.startsWith(status === "removed" ? "--- " : "+++ "));
            const markedPath = marker
                ? decodeGitPath(marker.slice(4).split("\t")[0]).replace(/^[ab]\//, "")
                : null;
            const path = markedPath && markedPath !== "/dev/null" ? markedPath : paths[1];
            files.push({
                path,
                status,
                previousPath: paths[0] !== path ? paths[0] : undefined,
                additions: lines.filter((l) => /^\+(?!\+\+)/.test(l)).length,
                deletions: lines.filter((l) => /^-(?!--)/.test(l)).length,
                patch: /^Binary files |^GIT binary patch/m.test(chunk) ? null : chunk,
            });
        }
        catch (error) {
            const path = `(unparsed diff ${index + 1})`;
            warnings.push(`${path}: ${error instanceof Error ? error.message : String(error)}`);
            files.push({
                path,
                status: "unknown",
                additions: 0,
                deletions: 0,
                patch: null,
            });
        }
    }
    return { files, warnings };
}
export const parseDiff = (text) => parseUnifiedDiff(text).files;
