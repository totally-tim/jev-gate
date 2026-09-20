import { randomUUID } from "node:crypto";
import { appendFileSync, readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import { ConfigError, resolveConfig, validateConfigDocument, } from "./config.js";
import { isMainModule } from "./entry.js";
import { GitHubClient } from "./github.js";
import { PROVIDER_ENV_KEYS } from "./jev.js";
import { renderComment, renderSummary } from "./render.js";
import { finishOutcome, reviewExitCode, runReview } from "./review.js";
import { applyOverrides, makeSnapshot } from "./snapshot.js";
/** Read an action input; both the dashed and underscore variants of the environment name are accepted. */
export function getInput(name) {
    const upper = name.toUpperCase();
    const candidates = [`INPUT_${upper}`, `INPUT_${upper.replaceAll("-", "_")}`];
    for (const candidate of candidates) {
        const value = process.env[candidate];
        if (value !== undefined && value.trim() !== "")
            return value.trim();
    }
    return "";
}
function escapeAnnotation(message) {
    return message
        .replaceAll("%", "%25")
        .replaceAll("\r", "%0D")
        .replaceAll("\n", "%0A");
}
export function warn(message) {
    process.stdout.write(`::warning::${escapeAnnotation(message)}\n`);
}
export function notice(message) {
    process.stdout.write(`::notice::${escapeAnnotation(message)}\n`);
}
export function fail(message) {
    process.stdout.write(`::error::${escapeAnnotation(message)}\n`);
}
function setOutput(name, value) {
    const file = process.env.GITHUB_OUTPUT;
    if (!file)
        return;
    if (!value.includes("\n")) {
        appendFileSync(file, `${name}=${value}\n`);
        return;
    }
    const delimiter = `__JEV_GATE_${randomUUID()}__`;
    appendFileSync(file, `${name}<<${delimiter}\n${value}\n${delimiter}\n`);
}
function writeSummary(markdown) {
    const file = process.env.GITHUB_STEP_SUMMARY;
    if (!file)
        return;
    appendFileSync(file, markdown);
}
function unavailableInput(message) {
    fail(message);
    setOutput("passed", "unavailable");
    setOutput("health", "unavailable");
    setOutput("status", "unavailable");
    setOutput("result", JSON.stringify({
        schema: 2,
        health: "unavailable",
        status: "unavailable",
        error: { kind: "input", message },
    }));
    return 2;
}
function readEvent() {
    const path = process.env.GITHUB_EVENT_PATH;
    if (!path)
        throw new Error("GITHUB_EVENT_PATH is not set; this entry point runs inside GitHub Actions");
    return JSON.parse(readFileSync(path, "utf8"));
}
function loadConfigText(text, warnings) {
    const parsed = parseYaml(text);
    return resolveConfig(validateConfigDocument(parsed, warnings));
}
function applyInputOverrides(config) {
    const numeric = getInput("max-state-tokens");
    if (numeric)
        validateConfigDocument({ maxStateTokens: Number(numeric) });
    return {
        ...applyOverrides(config, {
            provider: getInput("provider") || undefined,
            model: getInput("model") || undefined,
            mode: getInput("mode") || undefined,
        }),
        maxStateTokens: numeric ? Number(numeric) : config.maxStateTokens,
    };
}
function checkedBoolean(name, fallback) {
    const value = getInput(name);
    if (!value)
        return fallback;
    if (value !== "true" && value !== "false")
        throw new ConfigError(`${name} must be true or false`);
    return value === "true";
}
export async function runAction() {
    const eventName = process.env.GITHUB_EVENT_NAME ?? "";
    if (eventName !== "pull_request" && eventName !== "pull_request_target") {
        notice(`No PR review for event ${eventName || "(none)"}`);
        setOutput("status", "not-applicable");
        return 0;
    }
    const event = readEvent();
    const repository = event.repository?.full_name ?? process.env.GITHUB_REPOSITORY ?? "";
    const number = event.pull_request?.number;
    if (!repository || !number)
        throw new ConfigError("the event payload carries no pull request");
    const token = getInput("github-token") || process.env.GITHUB_TOKEN || "";
    if (!token) {
        return unavailableInput("no github-token input or GITHUB_TOKEN environment variable is available");
    }
    const [owner, repo] = repository.split("/");
    if (!owner || !repo) {
        return unavailableInput(`GITHUB_REPOSITORY is malformed: ${repository}`);
    }
    const client = new GitHubClient(token, fetch, process.env.GITHUB_API_URL ?? "https://api.github.com");
    const pr = await client.getPullRequest(owner, repo, number);
    const files = await client.listChangedFiles(owner, repo, number);
    const afterCollection = await client.getPullRequest(owner, repo, number);
    const sameRevision = (a, b) => a.headSha === b.headSha && a.baseSha === b.baseSha;
    const collectionWarnings = [];
    if (!sameRevision(pr, afterCollection) ||
        (event.pull_request?.head?.sha &&
            event.pull_request.head.sha !== pr.headSha) ||
        (event.pull_request?.base?.sha &&
            event.pull_request.base.sha !== pr.baseSha))
        collectionWarnings.push("The PR revision changed during collection or no longer matches this event. Rerun on the current revision.");
    const configPath = getInput("config-path") || ".jev-gate.yml";
    const configText = await client.getFileAtRef(owner, repo, configPath, pr.baseSha);
    const configWarnings = [];
    let config = resolveConfig({});
    let configurationError;
    let publishComment = getInput("comment") !== "false";
    let timeoutMs = 30000;
    try {
        config = applyInputOverrides(configText === null
            ? resolveConfig({})
            : loadConfigText(configText, configWarnings));
        if (!config.rules.some((rule) => rule.enabled))
            throw new ConfigError("no rules are enabled");
        publishComment = checkedBoolean("comment", true);
        timeoutMs = Number(getInput("timeout-ms") || "30000");
        if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 300000)
            throw new ConfigError("timeout-ms must be an integer between 1000 and 300000");
    }
    catch (error) {
        configurationError = `The review configuration at ${configPath}@${pr.baseSha.slice(0, 12)} or its Action overrides are invalid: ${error instanceof Error ? error.message : String(error)}`;
        fail(configurationError);
        collectionWarnings.push(configurationError);
        config = resolveConfig({});
    }
    for (const message of configWarnings)
        warn(`config: ${message}`);
    const keyEnv = PROVIDER_ENV_KEYS[config.provider];
    const apiKey = getInput("api-key") || process.env[keyEnv] || "";
    const started = Date.now();
    const snapshot = makeSnapshot(pr, collectionWarnings.length ? [] : files, config, `${configPath}@${pr.baseSha}${configurationError ? " (invalid; no review ran)" : configText === null ? " (defaults)" : ""}`, collectionWarnings);
    const outcome = await runReview({ snapshot, apiKey, timeoutMs });
    const beforePublish = await client.getPullRequest(owner, repo, number);
    if (!sameRevision(pr, beforePublish)) {
        outcome.health = "unavailable";
        outcome.errors.push("The PR changed while review was running. This result is obsolete and was not posted.");
        finishOutcome(outcome);
    }
    else if (config.comment &&
        publishComment &&
        collectionWarnings.every((warning) => warning === configurationError)) {
        try {
            const existing = await client.findPreviousRun(owner, repo, number);
            const current = await client.getPullRequest(owner, repo, number);
            if (!sameRevision(pr, current)) {
                outcome.health = "unavailable";
                outcome.errors.push("The PR changed before comment publication. This result is obsolete and was not posted.");
                finishOutcome(outcome);
            }
            else
                await client.upsertComment(owner, repo, number, existing?.id ?? null, renderComment(outcome, existing?.previous ?? null, repository));
        }
        catch (error) {
            warn(`The review finished but its comment could not be posted: ${error instanceof Error ? error.message : String(error)}`);
        }
    }
    writeSummary(renderSummary(outcome));
    setOutput("passed", outcome.health !== "complete"
        ? "unavailable"
        : outcome.passed
            ? "true"
            : "false");
    setOutput("health", outcome.health);
    setOutput("status", outcome.status);
    setOutput("failed-gates", outcome.failedGates.join(","));
    setOutput("result", JSON.stringify(outcome));
    notice(`jev-gate reviewed ${outcome.decisions.length} rules in ${Date.now() - started} ms ` +
        `(model call ${Math.round(outcome.latencyMs)} ms, ${outcome.inputTokens} input tokens)`);
    return reviewExitCode(outcome);
}
const isMain = isMainModule(import.meta.url);
if (isMain) {
    runAction()
        .then((code) => {
        process.exitCode = code;
    })
        .catch((error) => {
        process.exitCode = unavailableInput(`JEV review is unavailable: ${error instanceof Error ? error.message : String(error)}`);
    });
}
