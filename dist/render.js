import { concernMap, estimate, estimateGraphic, html, isModelDecision, peakDecision, REVIEW_ASSETS, reviewTopics, ruleLabel, thresholdLabel } from "./presentation.js";
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
function location(f, outcome, repository, labelOverride) {
    const label = labelOverride ?? `${f.path}${f.startLine === null ? "" : `:${f.startLine}`}${f.side === "old" ? " (before change)" : ""}`;
    const url = locationUrl(f, outcome, repository);
    return url ? `[${escape(label)}](${url})` : escape(label);
}
function locationUrl(f, outcome, repository) {
    const sha = f.side === "old" ? outcome.baseSha : outcome.headSha;
    if (!repository || !/^[\w.-]+\/[\w.-]+$/.test(repository) || !/^[a-f0-9]{40}$/i.test(sha))
        return undefined;
    const path = f.path.split("/").map(p => encodeURIComponent(p).replace(/[!'()*]/g, c => `%${c.charCodeAt(0).toString(16)}`)).join("/");
    return `https://github.com/${repository}/blob/${sha}/${path}${f.startLine === null ? "" : `#L${f.startLine}`}`;
}
function workflowLink(url) {
    return url && /^https:\/\/[a-z0-9.-]+\/[\w.-]+\/[\w.-]+\/actions\/runs\/\d+$/i.test(url)
        ? `[Full report](${url})` : "Full report in the workflow summary";
}
function topicTitle(topic) {
    if (topic.source === "local")
        return "Verify credential matches";
    const titles = {
        "danger-secret-material": "Check possible secret material",
        "danger-sensitive-area": "Verify sensitive changes",
        "breaking-change": "Check caller compatibility",
        "danger-deleted-tests": "Check removed test coverage",
        "comment-drift": "Update comments that describe old behavior",
        "test-meaningfulness": "Check what the tests prove",
        "change-hygiene": "Check whether these edits belong together",
    };
    return titles[topic.rule] ?? topic.findings[0].title;
}
function htmlLocation(f, outcome, repository, labelOverride) {
    const label = labelOverride ?? `${f.path}${f.startLine === null ? "" : `:${f.startLine}`}${f.side === "old" ? " (before change)" : ""}`;
    const url = locationUrl(f, outcome, repository);
    return url ? `<a href="${html(url)}">${html(label)}</a>` : html(label);
}
function topicRow(topic, outcome, previous, repository, limit) {
    const first = topic.findings[0];
    const paths = [...new Set(topic.findings.map(f => f.path))];
    const displayed = topic.findings.slice(0, limit);
    const peak = peakDecision(topic, outcome);
    const context = paths.length === 1 ? htmlLocation({ ...first, startLine: null }, outcome, repository, first.path.split("/").slice(-2).join("/")) : `${paths.length} files`;
    const signal = topic.source === "local"
        ? `<img src="${REVIEW_ASSETS}/match.svg" width="24" height="24" alt=""><br><strong>${topic.findings.length}&nbsp;match${topic.findings.length === 1 ? "" : "es"}</strong><br><sub>local&nbsp;scan</sub>`
        : peak ? `${estimateGraphic(peak, topic.rule === "danger-sensitive-area")}<br><sub>review&nbsp;at&nbsp;${html(thresholdLabel(peak))}</sub>` : "Estimate unavailable";
    const evidence = displayed.map(f => {
        const known = previous?.policyHash === outcome.policyHash && previous?.model === outcome.model && previous.findings.some(p => p.id === f.id);
        return `<li>${htmlLocation(f, outcome, repository)}<br>${html(f.evidence)}<br><sub>${html(f.category)}; ${html(f.status)}${known ? "; existing" : ""}. Finding <code>${html(f.id)}</code>.</sub></li>`;
    }).join("");
    const details = `<details><summary>${html(topicTitle(topic))}</summary><p>${html(first.verification)}</p>${topic.source === "local" ? "<p>Matched values are withheld from model requests and review output. Verify each match locally.</p>" : ""}<ul>${evidence}</ul>${displayed.length < topic.findings.length ? `<p>${topic.findings.length - displayed.length} more locations in the full report.</p>` : ""}</details>`;
    return `<tr><td><strong>${html(ruleLabel(topic.rule))}</strong><br><sub>${context}</sub></td><td align="center">${signal}</td><td>${details}<sub>${topic.findings.length} ${topic.source === "local" ? "location" : "signal"}${topic.findings.length === 1 ? "" : "s"}</sub></td></tr>`;
}
function fileMap(outcome, repository) {
    const map = concernMap(outcome);
    const headers = map.rules.map(rule => `<th align="center">${html(ruleLabel(rule))}</th>`).join("");
    const rows = map.rows.map(row => `<tr><td>${htmlLocation({ path: row.path, startLine: null, side: "new" }, outcome, repository, row.path.split("/").slice(-2).join("/"))}</td>${row.cells.map(cell => {
        const graphic = cell.decision && (cell.tone === "sensitive" || cell.tone === "concern") ? `${estimateGraphic(cell.decision, cell.tone === "sensitive")}${cell.text.endsWith(" *") ? " *" : ""}` : html(cell.text);
        return `<td align="center">${graphic}</td>`;
    }).join("")}</tr>`).join("\n");
    return ["<details>", `<summary>Explore by file (${map.rows.length} of ${map.totalFiles} files with findings)</summary>`, "",
        "Highest model estimate per file and question. Blue marks sensitive changes; amber marks potential issues. Local matches are counts. Not assessed means no usable estimate; * marks missing estimates for some sections.", "",
        `<table><thead><tr><th align="left">File</th>${headers}</tr></thead><tbody>`, rows, "</tbody></table>", "", "</details>", ""].join("\n");
}
function renderBody(outcome, previous, repository, reportUrl, options) {
    const topics = reviewTopics(outcome);
    const files = outcome.coverage.files;
    const reviewed = files.filter(f => f.status === "reviewed").length;
    const excluded = files.filter(f => f.status === "excluded").length;
    const gaps = files.filter(f => f.status === "partial" || f.status === "unavailable").length;
    const sections = files.reduce((sum, f) => sum + f.reviewedChunks, 0);
    const total = files.reduce((sum, f) => sum + f.totalChunks, 0);
    const title = outcome.health === "unavailable" ? "Review unavailable"
        : outcome.health !== "complete" ? "Review incomplete"
            : topics.length ? `Review ${topics.length} topic${topics.length === 1 ? "" : "s"}` : "No findings to review";
    const actionable = topics.some(t => t.rule !== "danger-sensitive-area");
    const alert = outcome.health !== "complete" ? "WARNING" : topics.length ? actionable ? "WARNING" : "NOTE" : "TIP";
    const policy = outcome.mode === "required"
        ? `Required policy: ${outcome.health !== "complete" ? "unavailable" : outcome.passed ? "passed" : "blocked"}.${outcome.failedGates.length ? ` Gates needing attention: ${outcome.failedGates.map(ruleLabel).map(escape).join(", ")}.` : ""}`
        : "Advisory · does not block merging";
    const lines = [`### <img src="${REVIEW_ASSETS}/mark.svg" width="24" height="24" alt=""> JEV review`, "",
        `> [!${alert}]`, `> **${title}**`, ">", `> ${policy}`, ""];
    if (outcome.health !== "complete")
        lines.push("Coverage is incomplete. Findings cover only the available input; an empty list does not establish that the change was reviewed.", "");
    if (topics.length) {
        lines.push("<table>", '<thead><tr><th align="left">Review focus</th><th align="center">Signal</th><th align="left">What to check · expand for evidence</th></tr></thead>', "<tbody>");
        let remaining = options.maxFindings;
        for (const topic of topics) {
            if (!remaining)
                break;
            lines.push(topicRow(topic, outcome, previous, repository, remaining));
            remaining -= Math.min(topic.findings.length, remaining);
        }
        lines.push("</tbody></table>", "", "<sub>Percentages are peak model estimates for a review question, not verified defect probabilities. A local match is a pattern detection, not a model estimate.</sub>", "");
    }
    else
        lines.push(outcome.health === "complete" ? "No open findings in the reviewed scope." : "No open findings were produced for the available scope.", "");
    lines.push(`Review health: **${outcome.health}** · ${reviewed} files reviewed · ${sections}/${total} change sections assessed${excluded || gaps ? ` · ${excluded} excluded · ${gaps} with gaps` : ""}`, "");
    if (topics.length && options.map)
        lines.push(fileMap(outcome, repository));
    const open = topics.reduce((sum, t) => sum + t.findings.length, 0);
    if (open > options.maxFindings)
        lines.push(`${open - options.maxFindings} additional findings are in the full workflow summary.`, "");
    const settled = outcome.findings.filter(f => f.status !== "open");
    if (settled.length) {
        lines.push("<details>", `<summary>Accepted, dismissed, or fixed findings (${settled.length})</summary>`, "");
        for (const f of settled.slice(0, options.maxFindings))
            lines.push(`- ${location(f, outcome, repository)}: ${f.status}. ${escape(f.disposition?.reason ?? "")} Finding \`${escape(f.id)}\`.`);
        if (settled.length > options.maxFindings)
            lines.push(`${settled.length - options.maxFindings} additional dispositions are in the full workflow summary.`);
        lines.push("", "</details>", "");
    }
    if (previous?.health === "complete" && outcome.health === "complete" && previous.policyHash === outcome.policyHash && previous.model === outcome.model) {
        const gone = previous.findings.filter(f => f.status === "open" && !outcome.findings.some(n => n.id === f.id));
        if (gone.length)
            lines.push(`${gone.length} previous finding(s) are no longer present. This does not by itself verify a fix.`, "");
    }
    const notes = [
        ...files.filter(f => f.status !== "reviewed" || f.reason).map(f => `${f.path}: ${f.status}. ${f.reason ?? ""}`),
        ...outcome.coverage.warnings, ...outcome.errors,
    ];
    if (notes.length) {
        lines.push("<details>", `<summary>Coverage notes and errors (${notes.length})</summary>`, "");
        for (const note of notes.slice(0, options.observations ? undefined : 20))
            lines.push(`- ${escape(note)}`);
        if (!options.observations && notes.length > 20)
            lines.push(`- ${notes.length - 20} more notes are in the full workflow summary.`);
        lines.push("", "</details>", "");
    }
    if (options.observations) {
        const model = outcome.decisions.filter(isModelDecision);
        lines.push("<details>", `<summary>Individual model observations (${model.length})</summary>`, "", "Estimates describe the rule's question. They are not calibrated measures of defect likelihood.", "", "| Question | Location | Observation | Review threshold | Result |", "| --- | --- | --- | --- | --- |");
        for (const d of model) {
            const threshold = thresholdLabel(d);
            lines.push(`| ${escape(ruleLabel(d.name))} | ${location(d.candidate, outcome, repository)} | ${estimate(d)} | ${threshold} | ${d.error ? "unavailable" : d.exceeded ? "review requested" : "below threshold"} |`);
        }
        lines.push("", "</details>", "");
    }
    lines.push("<details>", "<summary>Run details</summary>", "", `- Reviewed head: ${escape(outcome.headSha || "uncommitted input")}.`, `- Snapshot: ${escape(outcome.snapshotId)}.`, `- Policy: ${escape(outcome.configSource)} (${outcome.mode}).`, `- Provider: ${escape(outcome.provider)}. Model: ${escape(outcome.model)}.`, `- Rules: ${escape(outcome.rulesHash)}.`, `- ${outcome.inputTokens} input tokens; estimated $${outcome.costUSD.toFixed(6)}; ${Math.round(outcome.latencyMs)} ms across model calls.`, "", "</details>", "");
    if (reportUrl)
        lines.push(workflowLink(reportUrl), "");
    return lines.join("\n");
}
export function renderComment(outcome, previous, repository, reportUrl) {
    const body = renderBody(outcome, previous, repository, reportUrl, { maxFindings: outcome.findings.length, observations: false, map: true });
    const data = JSON.stringify(outcome).replaceAll("<", "\\u003c").replaceAll(">", "\\u003e");
    const result = `${COMMENT_MARKER}\n${body}\n${DATA_OPEN}\n${data}\n${DATA_CLOSE}\n`;
    if (result.length <= 60_000)
        return result;
    const footer = `\n<sub>The JSON assessment exceeds the comment limit. Full model observations are in the workflow summary; JSON is available through the Action outputs and any configured report artifact.</sub>\n`;
    if (body.length + footer.length + COMMENT_MARKER.length + 1 <= 60_000)
        return `${COMMENT_MARKER}\n${body}${footer}`;
    let maxFindings = outcome.findings.length;
    while (maxFindings > 0) {
        maxFindings = Math.floor(maxFindings / 2);
        const compact = `${COMMENT_MARKER}\n${renderBody(outcome, previous, repository, reportUrl, { maxFindings, observations: false, map: false })}${footer}`;
        if (compact.length <= 60_000)
            return compact;
    }
    return `${COMMENT_MARKER}\n### JEV review: ${outcome.status}\n\nReview health: ${outcome.health}. ${outcome.findings.length} findings. Snapshot \`${outcome.snapshotId}\`.\n\nThe coverage notes exceed the comment size limit. ${workflowLink(reportUrl)} contains the full assessment.\n`;
}
export function renderSummary(outcome, repository) {
    return renderBody(outcome, null, repository, undefined, { maxFindings: outcome.findings.length, observations: true, map: true }) + "\n";
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
    for (const f of outcome.coverage.files.filter((f) => f.status !== "reviewed" || f.reason))
        lines.push(`${f.status}: ${f.path}: ${f.reason}`);
    lines.push(...outcome.coverage.warnings, ...outcome.errors);
    return lines.join("\n");
}
