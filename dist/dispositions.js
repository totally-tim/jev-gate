import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { finishOutcome } from "./review.js";
import { ConfigError } from "./config.js";
export function readDispositions(root) {
    let text;
    try {
        text = readFileSync(join(root, ".jev-gate/dispositions.jsonl"), "utf8");
    }
    catch (error) {
        if (error.code === "ENOENT")
            return new Map();
        throw error;
    }
    const result = new Map();
    for (const line of text.split("\n").filter(Boolean)) {
        let d;
        try {
            d = JSON.parse(line);
        }
        catch {
            throw new ConfigError("Invalid disposition ledger; repair its JSON before reviewing");
        }
        if (!/^[a-f0-9]{24}$/.test(d.id) ||
            !["accepted", "dismissed"].includes(d.status) ||
            typeof d.reason !== "string" ||
            !d.reason.trim() ||
            typeof d.at !== "string")
            throw new ConfigError("Invalid disposition record");
        result.set(d.id, d);
    }
    return result;
}
export function writeDisposition(root, id, status, reason) {
    if (!/^[a-f0-9]{24}$/.test(id) ||
        !["accepted", "dismissed"].includes(status) ||
        !reason.trim())
        throw new ConfigError("resolve needs a finding id, --status accepted|dismissed, and a nonempty --reason");
    const file = join(root, ".jev-gate/dispositions.jsonl");
    mkdirSync(dirname(file), { recursive: true });
    appendFileSync(file, JSON.stringify({
        id,
        status,
        reason: reason.trim(),
        at: new Date().toISOString(),
    }) + "\n", { mode: 0o600 });
}
export function applyDispositions(outcome, records) {
    outcome.findings = outcome.findings.map((f) => {
        const d = records.get(f.id);
        return d
            ? { ...f, status: d.status, disposition: { reason: d.reason, at: d.at } }
            : f;
    });
    return finishOutcome(outcome);
}
