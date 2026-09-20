import { hash } from "./snapshot.js";
const PATTERNS = [
    /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{30,}|sk_live_[A-Za-z0-9]{16,}|sk-[A-Za-z0-9_-]{20,}|AKIA[0-9A-Z]{16})\b/g,
    /\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:[^\s/@]+@/gi,
];
const ASSIGNMENT = /((?:api[_-]?key|secret|password|(?:access|auth|bearer)[_-]?token)["']?\s*[:=]\s*)(?:"([^"\r\n]*)"|'([^'\r\n]*)'|([A-Za-z0-9_./+=-]{16,}))/gi;
const placeholder = (value) => /(?:example|placeholder|your[-_]|redacted|dummy|changeme|test[-_]key)/i.test(value);
export function redactText(text) {
    let insideKey = false;
    return text
        .split("\n")
        .map((line) => {
        const begin = /-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----/.test(line);
        const end = /-----END (?:[A-Z]+ )?PRIVATE KEY-----/.test(line);
        if (begin)
            insideKey = true;
        if (insideKey) {
            if (end)
                insideKey = false;
            return `${/^[ +\-]/.exec(line)?.[0] ?? ""}[REDACTED private key]`;
        }
        line = line.replace(ASSIGNMENT, (whole, prefix, double, single, bare) => {
            const value = double ?? single ?? bare ?? "";
            if (value.length < 16 ||
                placeholder(value) ||
                /^(?:process\.env\.|import\.meta\.env\.|os\.getenv\b)/.test(value))
                return whole;
            const quote = double !== undefined ? '"' : single !== undefined ? "'" : "";
            return `${prefix}${quote}[REDACTED]${quote}`;
        });
        for (const regex of PATTERNS)
            line = line.replace(regex, "[REDACTED credential]");
        return line;
    })
        .join("\n");
}
/** Scan before any provider request; results never contain credential values. */
export function scanSecrets(files) {
    const findings = [];
    return {
        findings,
        files: files.map((file) => {
            if (file.patch === null)
                return file;
            const redacted = redactText(file.patch);
            const originalLines = file.patch.split("\n"), safeLines = redacted.split("\n");
            let newLine = 0;
            for (let i = 0; i < originalLines.length; i++) {
                const line = originalLines[i];
                const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
                if (hunk) {
                    newLine = Number(hunk[1]);
                    continue;
                }
                if (line.startsWith("+") && !line.startsWith("+++")) {
                    if (line !== safeLines[i])
                        findings.push({
                            id: hash({
                                rule: "local-secret",
                                path: file.path,
                                lineHash: hash(line),
                            }).slice(0, 24),
                            rule: "danger-secret-material",
                            title: "Added credential material",
                            category: "secret",
                            path: file.path,
                            startLine: newLine || null,
                            endLine: newLine || null,
                            side: "new",
                            evidence: "A local credential pattern matched an added line. The value was withheld from provider requests and review output.",
                            verification: "Verify the credential locally. Remove it from source and rotate it if it was exposed. Do not paste its value into a review.",
                            value: 1,
                            kind: "noul",
                            source: "local",
                            status: "open",
                        });
                    newLine++;
                }
                else if (line.startsWith(" "))
                    newLine++;
            }
            return { ...file, patch: redacted };
        }),
    };
}
