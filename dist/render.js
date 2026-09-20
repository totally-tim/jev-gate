export const COMMENT_MARKER = "<!-- jev-gate:report -->";
const DATA_OPEN = "<!-- jev-gate:data", DATA_CLOSE = "-->";
export function parsePreviousOutcome(body) {
    const start = body.indexOf(DATA_OPEN), end = body.indexOf(DATA_CLOSE, start + DATA_OPEN.length);
    if (start < 0 || end < 0)
        return null;
    try {
        const v = JSON.parse(body.slice(start + DATA_OPEN.length, end));
        if (v?.schema !== 2 ||
            typeof v.snapshotId !== "string" ||
            typeof v.model !== "string" ||
            typeof v.policyHash !== "string" ||
            !Array.isArray(v.findings) ||
            !Array.isArray(v.decisions))
            return null;
        if (v.findings.some((f) => !f ||
            typeof f.id !== "string" ||
            typeof f.rule !== "string" ||
            typeof f.path !== "string"))
            return null;
        if (v.decisions.some((d) => !d ||
            typeof d.name !== "string" ||
            !(d.value === null || typeof d.value === "number")))
            return null;
        return v;
    }
    catch {
        return null;
    }
}
const escape = (s) => s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replace(/[\\`*_[\]{}()|!]/g, (c) => `&#${c.charCodeAt(0)};`)
    .replaceAll("\n", " ")
    .replaceAll("\r", "");
export function displayValue(d) {
    return d.kind === "noul"
        ? d.probability === null
            ? "unavailable"
            : `${(d.probability * 100).toFixed(1)}% probability`
        : d.level === undefined
            ? "not applicable"
            : `${d.level.toFixed(2)} / ${(d.levels ?? 2) - 1} rubric score`;
}
function location(f, outcome, repository) {
    const label = `${f.path}${f.startLine === null ? "" : `:${f.startLine}`}${f.side === "old" ? " (before change)" : ""}`;
    const sha = f.side === "old" ? outcome.baseSha : outcome.headSha;
    if (!repository || !/^[a-f0-9]{40}$/i.test(sha))
        return `\`${escape(label)}\``;
    const path = f.path.split("/").map(encodeURIComponent).join("/");
    return `[${escape(label)}](https://github.com/${repository}/blob/${sha}/${path}${f.startLine === null ? "" : `#L${f.startLine}`})`;
}
function renderBody(outcome, previous, repository, compact) {
    const coverage = outcome.coverage.files, active = outcome.findings.filter((f) => f.status === "open");
    const lines = [
        `### JEV review: ${outcome.status}`,
        "",
        `Review health: **${outcome.health}**. ${coverage.filter((f) => f.status === "reviewed").length} files reviewed, ${coverage.filter((f) => f.status === "excluded").length} excluded, ${coverage.filter((f) => f.status === "partial" || f.status === "unavailable").length} with gaps.`,
        `Snapshot \`${outcome.snapshotId.slice(0, 12)}\`; head \`${outcome.headSha.slice(0, 12) || "uncommitted input"}\`. Policy: ${escape(outcome.configSource)} (${outcome.mode}).`,
        "",
    ];
    if (outcome.health !== "complete")
        lines.push("This review is incomplete. An empty finding list does not establish that the change was reviewed.", "");
    if (!active.length)
        lines.push(outcome.health === "complete"
            ? "No open findings in the reviewed scope."
            : "No open findings were produced for the available scope.", "");
    const displayedFindings = outcome.findings.slice(0, compact?.maxFindings);
    for (const f of displayedFindings) {
        const freshness = previous?.findings.some((p) => p.id === f.id)
            ? "existing"
            : "new";
        lines.push(`- **${escape(f.title)}** (${f.category}; ${f.status}; ${freshness}) at ${location(f, outcome, repository)}.`, `  ${escape(f.evidence)} ${escape(f.verification)}`, `  Finding \`${f.id}\`.${f.disposition ? ` Disposition: ${escape(f.disposition.reason)}.` : ""}`, "");
    }
    if (displayedFindings.length < outcome.findings.length)
        lines.push(`${outcome.findings.length - displayedFindings.length} additional findings are in the full workflow summary.`, "");
    if (previous &&
        previous.policyHash === outcome.policyHash &&
        previous.model === outcome.model &&
        outcome.health === "complete") {
        const gone = previous.findings.filter((f) => !outcome.findings.some((n) => n.id === f.id));
        if (gone.length)
            lines.push(`${gone.length} previous finding(s) are no longer present in this assessment.`, "");
    }
    const coverageNotes = coverage.filter((f) => f.status !== "reviewed");
    for (const file of coverageNotes.slice(0, compact?.maxCoverage))
        lines.push(`- Coverage: \`${escape(file.path)}\` ${file.status}: ${escape(file.reason ?? "")}.`);
    if (compact && coverageNotes.length > compact.maxCoverage)
        lines.push(`- ${coverageNotes.length - compact.maxCoverage} additional coverage notes are in the full workflow summary.`);
    for (const w of outcome.coverage.warnings.slice(0, compact?.maxCoverage))
        lines.push(`- Coverage warning: ${escape(w)}`);
    if (compact && outcome.coverage.warnings.length > compact.maxCoverage)
        lines.push(`- ${outcome.coverage.warnings.length - compact.maxCoverage} additional coverage warnings are in the full workflow summary.`);
    for (const error of outcome.errors.slice(0, 20))
        lines.push(`- Review error: ${escape(error)}`);
    if (compact)
        return lines.join("\n");
    lines.push("", "<details>", "<summary>Assessment details</summary>", "", "| Rule | Candidate | Observation | Result |", "| --- | --- | --- | --- |");
    for (const d of outcome.decisions)
        lines.push(`| ${escape(d.name)} | ${escape(d.candidate.path)} | ${displayValue(d)} | ${d.error ? "unavailable" : d.exceeded ? "review requested" : "below threshold"} |`);
    lines.push("", `Provider ${outcome.provider}; model ${escape(outcome.model)}; rules \`${outcome.rulesHash}\`; ${outcome.inputTokens} input tokens; estimated $${outcome.costUSD.toFixed(6)}; ${Math.round(outcome.latencyMs)} ms across model calls.`, "", "</details>");
    return lines.join("\n");
}
export function renderComment(outcome, previous, repository, reportUrl) {
    const data = JSON.stringify(outcome)
        .replaceAll("<", "\\u003c")
        .replaceAll(">", "\\u003e");
    const result = `${COMMENT_MARKER}\n${renderBody(outcome, previous, repository)}\n\n${DATA_OPEN}\n${data}\n${DATA_CLOSE}\n`;
    if (result.length <= 60_000)
        return result;
    // Drop verbose observations and embedded JSON before sacrificing actionable findings.
    // A compact comment has no machine-data block; the full result stays in job outputs.
    const report = reportUrl && /^https:\/\/[a-z0-9.-]+\/[\w.-]+\/[\w.-]+\/actions\/runs\/\d+$/i.test(reportUrl)
        ? `[full workflow summary](${reportUrl})`
        : "full workflow summary";
    const footer = `\n\nThis comment omits individual model observations and embedded result data to fit GitHub's size limit. Read the ${report} for all findings and coverage. Snapshot \`${outcome.snapshotId}\`.\n`;
    let maxFindings = outcome.findings.length;
    while (true) {
        const compact = `${COMMENT_MARKER}\n${renderBody(outcome, previous, repository, { maxFindings, maxCoverage: 20 })}${footer}`;
        if (compact.length <= 60_000)
            return compact;
        if (maxFindings === 0)
            break;
        maxFindings = Math.floor(maxFindings / 2);
    }
    return `${COMMENT_MARKER}\nJEV review: ${outcome.status}. Review health: ${outcome.health}. ${outcome.findings.length} findings; the coverage notes exceed the comment size limit.${footer}`;
}
export function renderSummary(outcome) {
    return renderBody(outcome, null) + "\n";
}
export function renderPlainTable(outcome) {
    const lines = [
        `JEV review: ${outcome.status} (health: ${outcome.health}, mode: ${outcome.mode})`,
        `snapshot ${outcome.snapshotId}`,
        `policy ${outcome.configSource} (${outcome.policyHash.slice(0, 12)})`,
        "",
    ];
    for (const f of outcome.findings)
        lines.push(`${f.status} ${f.rule} ${f.path}${f.startLine === null ? "" : `:${f.startLine}`} [${f.id}]`, `  ${f.verification}`);
    if (!outcome.findings.length)
        lines.push("No findings in the available scope.");
    lines.push("", `Coverage: ${outcome.coverage.files.filter((f) => f.status === "reviewed").length} reviewed / ${outcome.coverage.files.length} collected files.`);
    for (const f of outcome.coverage.files.filter((f) => f.status !== "reviewed"))
        lines.push(`${f.status}: ${f.path}: ${f.reason}`);
    lines.push(...outcome.coverage.warnings, ...outcome.errors);
    return lines.join("\n");
}
