import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ConfigError } from "./config.js";
import { parseUnifiedDiff } from "./diff.js";
import { localContext, makeSnapshot, hash, rulesHashFor, STATE_VERSION, } from "./snapshot.js";
import { runReview } from "./review.js";
export async function calibrate(dir, config, apiKey, repeat, split, solo = false) {
    if (!Number.isInteger(repeat) || repeat < 1 || repeat > 100)
        throw new ConfigError("--repeat must be between 1 and 100");
    if (config.model.includes("latest"))
        throw new ConfigError("calibration requires a pinned model, not a latest alias");
    let labels;
    try {
        labels = JSON.parse(readFileSync(join(dir, "labels.json"), "utf8"));
    }
    catch {
        throw new ConfigError("calibration needs a valid labels.json manifest");
    }
    if (labels.schema !== 1 ||
        !labels.samples ||
        typeof labels.samples !== "object" ||
        Array.isArray(labels.samples))
        throw new ConfigError("invalid labels manifest");
    if (split && split !== "tune" && split !== "holdout")
        throw new ConfigError("--split must be tune or holdout");
    const names = config.rules.filter((r) => r.enabled).map((r) => r.name), metrics = {};
    for (const name of names)
        metrics[name] = {
            tp: 0,
            fp: 0,
            tn: 0,
            fn: 0,
            unavailable: 0,
            precision: null,
            recall: null,
        };
    const records = [];
    let invalid = 0;
    const models = new Set();
    for (const [sample, label] of Object.entries(labels.samples).sort(([a], [b]) => a.localeCompare(b))) {
        if (!label ||
            !["tune", "holdout"].includes(label.split) ||
            !label.expected ||
            typeof label.expected !== "object" ||
            Array.isArray(label.expected) ||
            !Object.keys(label.expected).length)
            throw new ConfigError(`invalid label for ${sample}`);
        if (sample.startsWith("/") ||
            sample.split(/[\\/]/).includes("..") ||
            !sample.endsWith(".diff"))
            throw new ConfigError("sample paths must stay within the evaluation directory");
        for (const [rule, value] of Object.entries(label.expected))
            if (!config.rules.some((r) => r.name === rule) ||
                typeof value !== "boolean")
                throw new ConfigError(`invalid expected label ${sample}: ${rule}`);
        if (split && label.split !== split)
            continue;
        const text = readFileSync(join(dir, sample), "utf8"), parsed = parseUnifiedDiff(text);
        if (!parsed.files.length || parsed.warnings.length)
            throw new ConfigError(`invalid sample diff ${sample}`);
        const pr = localContext(parsed.files, { title: "Evaluation change" });
        for (let run = 0; run < repeat; run++) {
            const configs = solo
                ? config.rules
                    .filter((r) => r.enabled)
                    .map((rule) => ({ ...config, rules: [rule] }))
                : [config];
            const outcomes = [];
            for (const c of configs)
                outcomes.push(await runReview({
                    snapshot: makeSnapshot(pr, parsed.files, c, "calibration"),
                    apiKey,
                }));
            const complete = outcomes.every((o) => o.health === "complete");
            if (!complete)
                invalid++;
            for (const o of outcomes)
                models.add(o.model);
            const observations = Object.fromEntries(names.map((name) => [
                name,
                outcomes
                    .flatMap((o) => o.decisions)
                    .filter((d) => d.name === name)
                    .map((d) => ({
                    value: d.value,
                    error: d.error,
                    candidate: d.candidate.id,
                })),
            ]));
            const predicted = new Set(outcomes.flatMap((o) => o.findings).map((f) => f.rule));
            for (const [name, expected] of Object.entries(label.expected)) {
                const m = metrics[name];
                if (!m)
                    continue;
                if (!complete) {
                    m.unavailable++;
                    continue;
                }
                if (predicted.has(name)) {
                    if (expected)
                        m.tp++;
                    else
                        m.fp++;
                }
                else {
                    if (expected)
                        m.fn++;
                    else
                        m.tn++;
                }
            }
            records.push({
                sample,
                sampleHash: hash(text),
                split: label.split,
                run,
                health: complete ? "complete" : "unavailable",
                expected: label.expected,
                findings: [...predicted],
                observations,
                errors: outcomes.flatMap((o) => o.errors),
            });
        }
    }
    if (!records.length)
        throw new ConfigError("no labeled samples match the requested split");
    for (const m of Object.values(metrics)) {
        m.precision = m.tp + m.fp ? m.tp / (m.tp + m.fp) : null;
        m.recall = m.tp + m.fn ? m.tp / (m.tp + m.fn) : null;
    }
    if (models.size > 1)
        invalid++;
    return {
        schema: 1,
        valid: invalid === 0,
        invalidRuns: invalid,
        provider: config.provider,
        requestedModel: config.model,
        resolvedModels: [...models],
        rulesHash: rulesHashFor(config.rules),
        policyHash: makeSnapshot(localContext([]), [], config).policyHash,
        stateVersion: STATE_VERSION,
        mode: solo ? "solo" : "batched",
        repeat,
        metrics,
        records,
    };
}
