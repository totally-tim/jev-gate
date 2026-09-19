import { appendFileSync, readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import { ConfigError, resolveConfig, validateConfigDocument } from "./config.js";
import { isMainModule } from "./entry.js";
import { GitHubClient, GitHubError } from "./github.js";
import { renderComment, renderSummary } from "./render.js";
import { runReview } from "./review.js";
import type { ResolvedConfig } from "./types.js";

/** Read an action input; both the dashed and underscore variants of the environment name are accepted. */
export function getInput(name: string): string {
  const upper = name.toUpperCase();
  const candidates = [`INPUT_${upper}`, `INPUT_${upper.replaceAll("-", "_")}`];
  for (const candidate of candidates) {
    const value = process.env[candidate];
    if (value !== undefined && value.trim() !== "") return value.trim();
  }
  return "";
}

function escapeAnnotation(message: string): string {
  return message.replaceAll("%", "%25").replaceAll("\r", "%0D").replaceAll("\n", "%0A");
}

export function warn(message: string): void {
  process.stdout.write(`::warning::${escapeAnnotation(message)}\n`);
}

export function notice(message: string): void {
  process.stdout.write(`::notice::${escapeAnnotation(message)}\n`);
}

export function fail(message: string): void {
  process.stdout.write(`::error::${escapeAnnotation(message)}\n`);
}

function setOutput(name: string, value: string): void {
  const file = process.env.GITHUB_OUTPUT;
  if (!file) return;
  if (!value.includes("\n")) {
    appendFileSync(file, `${name}=${value}\n`);
    return;
  }
  const delimiter = `__JEV_GATE_${name.toUpperCase().replaceAll("-", "_")}__`;
  appendFileSync(file, `${name}<<${delimiter}\n${value}\n${delimiter}\n`);
}

function writeSummary(markdown: string): void {
  const file = process.env.GITHUB_STEP_SUMMARY;
  if (!file) return;
  appendFileSync(file, markdown);
}

interface PullRequestEvent {
  pull_request?: { number: number };
  repository?: { full_name: string; owner?: { login: string } };
}

function readEvent(): PullRequestEvent {
  const path = process.env.GITHUB_EVENT_PATH;
  if (!path) throw new Error("GITHUB_EVENT_PATH is not set; this entry point runs inside GitHub Actions");
  return JSON.parse(readFileSync(path, "utf8")) as PullRequestEvent;
}

function loadConfigText(text: string): ResolvedConfig {
  const parsed = parseYaml(text) as unknown;
  return resolveConfig(validateConfigDocument(parsed));
}

function applyInputOverrides(config: ResolvedConfig): ResolvedConfig {
  const model = getInput("model");
  const maxStateTokens = getInput("max-state-tokens");
  return {
    ...config,
    model: model || config.model,
    maxStateTokens: maxStateTokens ? Number(maxStateTokens) : config.maxStateTokens,
  };
}

async function skip(message: string): Promise<number> {
  warn(`jev-gate skipped: ${message}`);
  writeSummary(`### Jev gate skipped\n\n${message}\n`);
  setOutput("passed", "skipped");
  return 0;
}

export async function runAction(): Promise<number> {
  const eventName = process.env.GITHUB_EVENT_NAME ?? "";
  if (eventName !== "pull_request" && eventName !== "pull_request_target") {
    return skip(`unsupported event ${eventName || "(none)"}; only pull_request and pull_request_target run.`);
  }
  const event = readEvent();
  const repository = event.repository?.full_name ?? process.env.GITHUB_REPOSITORY ?? "";
  const number = event.pull_request?.number;
  if (!repository || !number) return skip("the event payload carries no pull request");

  const apiKey = getInput("api-key");
  if (!apiKey) {
    const onMissing = getInput("on-missing-key") || "skip";
    if (onMissing === "fail") {
      fail("no api-key input was provided and on-missing-key is fail");
      setOutput("passed", "failed");
      return 1;
    }
    return skip("no api-key input was provided (expected for fork pull requests under the pull_request event)");
  }
  const token = getInput("github-token") || process.env.GITHUB_TOKEN || "";
  if (!token) {
    fail("no github-token input or GITHUB_TOKEN environment variable is available");
    setOutput("passed", "failed");
    return 1;
  }

  const [owner, repo] = repository.split("/");
  if (!owner || !repo) {
    fail(`GITHUB_REPOSITORY is malformed: ${repository}`);
    return 1;
  }
  const client = new GitHubClient(token, fetch, process.env.GITHUB_API_URL ?? "https://api.github.com");
  const pr = await client.getPullRequest(owner, repo, number);
  const files = await client.listChangedFiles(owner, repo, number);

  const configPath = getInput("config-path") || ".jev-gate.yml";
  const configText = await client.getFileAtRef(owner, repo, configPath, pr.baseSha);
  let config: ResolvedConfig;
  try {
    config = applyInputOverrides(configText === null ? resolveConfig({}) : loadConfigText(configText));
  } catch (error) {
    if (error instanceof ConfigError) {
      fail(`the config at ${configPath}@${pr.baseSha.slice(0, 12)} is invalid: ${error.message}`);
      setOutput("passed", "failed");
      return 1;
    }
    throw error;
  }

  const timeoutMs = Number(getInput("timeout-ms") || "30000");
  const started = Date.now();
  let outcome;
  try {
    outcome = await runReview({ pr, files, config, apiKey, timeoutMs });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const onApiError = getInput("on-api-error") || "skip";
    if (onApiError === "fail") {
      fail(`the Jev review failed: ${message}`);
      setOutput("passed", "failed");
      return 1;
    }
    return skip(`the Jev review failed: ${message}`);
  }

  const commentEnabled = config.comment && (getInput("comment") || "true") !== "false";
  if (commentEnabled) {
    try {
      const existing = await client.findPreviousRun(owner, repo, number);
      const body = renderComment(outcome, existing?.previous ?? null);
      await client.upsertComment(owner, repo, number, existing?.id ?? null, body);
    } catch (error) {
      const message = error instanceof GitHubError ? `${error.status} ${error.message}` : String(error);
      warn(`the review finished but the sticky comment could not be posted: ${message}`);
    }
  }

  writeSummary(renderSummary(outcome));
  setOutput("passed", outcome.passed ? "true" : "false");
  setOutput("failed-gates", outcome.failedGates.join(","));
  setOutput("result", JSON.stringify(outcome));
  notice(
    `jev-gate reviewed ${outcome.decisions.length} rules in ${Date.now() - started} ms ` +
      `(model call ${Math.round(outcome.latencyMs)} ms, ${outcome.inputTokens} input tokens)`,
  );
  return outcome.passed ? 0 : 1;
}

const isMain = isMainModule();
if (isMain) {
  runAction()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      fail(`jev-gate crashed: ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
    });
}
