const LABELS = {
    "danger-secret-material": "Credentials",
    "danger-sensitive-area": "Sensitive logic",
    "breaking-change": "Compatibility",
    "danger-deleted-tests": "Test removal",
    "comment-drift": "Comment drift",
    "test-meaningfulness": "Test quality",
    "change-hygiene": "Change scope",
};
export const ruleLabel = (name) => LABELS[name] ?? name;
export const isModelDecision = (decision) => decision.candidate.id !== "local-secret-scan" && decision.candidate.status !== "local";
function priority(f) {
    return f.source === "local" ? 0 : f.category === "secret" ? 1 : f.category === "potential-issue" ? 2 : 3;
}
/** Group repeated advice, while keeping every finding and location available. */
export function reviewTopics(outcome) {
    const groups = new Map();
    for (const finding of outcome.findings.filter(f => f.status === "open")) {
        const key = JSON.stringify([finding.rule, finding.source, finding.source === "local" ? finding.path : null]);
        const group = groups.get(key) ?? { rule: finding.rule, source: finding.source, findings: [] };
        group.findings.push(finding);
        groups.set(key, group);
    }
    return [...groups.values()].sort((a, b) => priority(a.findings[0]) - priority(b.findings[0]) || a.findings[0].path.localeCompare(b.findings[0].path));
}
export function estimate(decision) {
    if (decision.error || decision.value === null)
        return "Unavailable";
    return decision.kind === "noul"
        ? `${Math.round((decision.probability ?? decision.value) * 100)}%`
        : `${(decision.level ?? decision.value * ((decision.levels ?? 2) - 1)).toFixed(1)} / ${(decision.levels ?? 2) - 1}`;
}
/** A peak is a locator for a question, never an aggregate probability of a defect. */
export function concernMap(outcome) {
    const topics = reviewTopics(outcome);
    const rules = [...new Set(topics.map(t => t.rule))].sort((a, b) => Object.keys(LABELS).indexOf(a) - Object.keys(LABELS).indexOf(b));
    const paths = [...new Set(topics.flatMap(t => t.findings.map(f => f.path)))];
    const model = outcome.decisions.filter(isModelDecision);
    return {
        rules,
        totalFiles: paths.length,
        rows: paths.slice(0, 6).map(path => ({
            path,
            cells: rules.map(rule => {
                const local = outcome.findings.filter(f => f.path === path && f.rule === rule && f.source === "local" && f.status === "open");
                if (local.length)
                    return { text: `${local.length} match${local.length === 1 ? "" : "es"}`, tone: "concern" };
                const decisions = model.filter(d => d.candidate.path === path && d.name === rule);
                const best = decisions.filter(d => !d.error && d.value !== null && Number.isFinite(d.value)).sort((a, b) => b.value - a.value)[0];
                if (!best)
                    return { text: "Not assessed", tone: "missing" };
                const missing = decisions.some(d => d.error || d.value === null);
                return {
                    text: estimate(best) + (missing ? " *" : ""),
                    tone: best.exceeded ? rule === "danger-sensitive-area" ? "sensitive" : "concern" : "quiet",
                    decision: best,
                };
            }),
        })),
    };
}
/** Generic, versioned artwork only. No repository data is sent to an image service. */
export const REVIEW_ASSETS = "https://raw.githubusercontent.com/totally-tim/jev-gate/main/assets/review/v1";
export function peakDecision(topic, outcome) {
    return outcome.decisions.filter(d => isModelDecision(d) && d.name === topic.rule && !d.error && d.value !== null && Number.isFinite(d.value) && topic.findings.some(f => f.path === d.candidate.path && f.startLine === d.candidate.startLine && f.side === d.candidate.side))
        .sort((a, b) => b.value - a.value)[0];
}
export function thresholdLabel(d) {
    return d.kind === "noul" ? `${Math.round(d.threshold * 100)}%` : `${(d.threshold * ((d.levels ?? 2) - 1)).toFixed(1)} / ${(d.levels ?? 2) - 1}`;
}
export const html = (value) => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;").replace(/[\r\n]/g, " ");
export function estimateGraphic(d, sensitive = false) {
    // Rubric scores retain their units; a local scanner's sentinel never becomes a gauge.
    if (!isModelDecision(d) || d.error || d.value === null)
        return "Unavailable";
    if (d.kind !== "noul")
        return `<strong>${html(estimate(d))}</strong><br><sub>rubric score</sub>`;
    const percent = Math.round((d.probability ?? d.value) * 100);
    if (!Number.isFinite(percent) || percent < 0 || percent > 100)
        return "Unavailable";
    return `<img src="${REVIEW_ASSETS}/${sensitive ? "blue" : "amber"}/${percent}.svg" width="44" height="44" alt="${percent}% model estimate"><br><sub>model estimate</sub>`;
}
