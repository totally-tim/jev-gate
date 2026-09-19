export const COMMENT_MARKER = "<!-- jev-gate:report -->";
const DATA_OPEN = "<!-- jev-gate:data";
const DATA_CLOSE = "-->";
/** Read the previous run out of the sticky comment's hidden data block. */
export function parsePreviousOutcome(commentBody) {
    const open = commentBody.indexOf(DATA_OPEN);
    if (open === -1)
        return null;
    const close = commentBody.indexOf(DATA_CLOSE, open + DATA_OPEN.length);
    if (close === -1)
        return null;
    try {
        const parsed = JSON.parse(commentBody.slice(open + DATA_OPEN.length, close).trim());
        if (parsed.schema !== 1 || !Array.isArray(parsed.decisions))
            return null;
        return parsed;
    }
    catch {
        return null;
    }
}
const percent = (value) => `${(value * 100).toFixed(1)}%`;
const bar = (value) => {
    const filled = Math.round(Math.min(1, Math.max(0, value)) * 10);
    return "█".repeat(filled) + "░".repeat(10 - filled);
};
function delta(current, previous) {
    if (previous === undefined)
        return "-";
    const diff = (current - previous) * 100;
    if (Math.abs(diff) < 0.05)
        return "0.0pp";
    return `${diff > 0 ? "+" : "-"}${Math.abs(diff).toFixed(1)}pp`;
}
function status(decision) {
    if (decision.failed)
        return "**fail**";
    return decision.exceeded ? "warn" : "ok";
}
function detail(decision) {
    if (!decision.exceeded)
        return null;
    const level = decision.kind === "score" && decision.level !== undefined && decision.levels !== undefined
        ? ` (expected level ${decision.level.toFixed(2)} of ${decision.levels - 1})`
        : "";
    const kind = decision.failed ? "failed" : "warn";
    return `- \`${decision.name}\` ${kind} at ${percent(decision.probability)}${level} — ${decision.title}.`;
}
function renderBody(outcome, previous) {
    const previousByName = new Map((previous?.decisions ?? []).map((decision) => [decision.name, decision.probability]));
    const lines = [];
    lines.push(`### Jev gate — \`${outcome.headSha.slice(0, 12)}\``);
    lines.push("");
    if (outcome.failedGates.length > 0) {
        lines.push(`**${outcome.failedGates.length} gated rule${outcome.failedGates.length === 1 ? "" : "s"} failed:** ` +
            outcome.failedGates.map((name) => `\`${name}\``).join(", ") +
            ". This check fails until they clear or the change is overridden.");
    }
    else {
        lines.push("All gated rules passed.");
    }
    lines.push("");
    lines.push("| Rule | Concern | Threshold | Result | Δ |");
    lines.push("| --- | --- | ---: | :---: | ---: |");
    for (const decision of outcome.decisions) {
        const name = decision.gate ? `${decision.name} (gate)` : decision.name;
        lines.push(`| ${name} | \`${bar(decision.probability)}\` ${percent(decision.probability)} | ` +
            `${percent(decision.threshold)} | ${status(decision)} | ` +
            `${delta(decision.probability, previousByName.get(decision.name))} |`);
    }
    lines.push("");
    const details = outcome.decisions.map(detail).filter((line) => line !== null);
    if (details.length > 0) {
        lines.push(...details);
        lines.push("");
    }
    if (outcome.truncated) {
        lines.push("The diff was larger than the state budget, so some file patches were dropped before review.");
        lines.push("");
    }
    const cost = outcome.costUSD < 0.00001 ? "$<0.00001" : `$${outcome.costUSD.toFixed(5)}`;
    lines.push(`<sub>model ${outcome.model} · ${Math.round(outcome.latencyMs)} ms · ` +
        `${outcome.inputTokens.toLocaleString("en-US")} input tokens (${cost}) · ` +
        `base ${outcome.baseSha.slice(0, 12)} → head ${outcome.headSha.slice(0, 12)} · ` +
        `advisory rules report only and never fail this check.</sub>`);
    return lines.join("\n");
}
function dataBlock(outcome) {
    return `${DATA_OPEN}\n${JSON.stringify(outcome)}\n${DATA_CLOSE}`;
}
/** The sticky PR comment: rendered body plus the machine-readable block. */
export function renderComment(outcome, previous) {
    return `${COMMENT_MARKER}\n${renderBody(outcome, previous)}\n\n${dataBlock(outcome)}\n`;
}
/** The job summary written to GITHUB_STEP_SUMMARY. */
export function renderSummary(outcome) {
    return `${renderBody(outcome, null)}\n`;
}
/** A plain-text table for CLI output. */
export function renderPlainTable(outcome) {
    const rows = outcome.decisions.map((decision) => [
        `${decision.name}${decision.gate ? " (gate)" : ""}`,
        percent(decision.probability),
        percent(decision.threshold),
        status(decision).replaceAll("*", ""),
    ]);
    const header = ["rule", "concern", "threshold", "result"];
    const widths = header.map((title, index) => Math.max(title.length, ...rows.map((row) => row[index].length)));
    const format = (row) => row.map((cell, index) => cell.padEnd(widths[index])).join("  ").trimEnd();
    const lines = [format(header), format(widths.map((width) => "-".repeat(width)))];
    for (const row of rows)
        lines.push(format(row));
    return lines.join("\n");
}
