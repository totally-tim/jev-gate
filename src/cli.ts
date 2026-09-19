import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { ConfigError, DEFAULT_MODELS, resolveConfig, validateConfigDocument } from "./config.js";
import { isMainModule } from "./entry.js";
import { localDiff } from "./gitdiff.js";
import { PROVIDER_ENV_KEYS } from "./jev.js";
import { renderPlainTable } from "./render.js";
import { rulesHashFor, runReview } from "./review.js";
import type { DiffFile, PullRequestContext, ResolvedConfig } from "./types.js";

const USAGE = `jev-gate: Jev-powered PR review rules

Usage:
  jev-gate review [--diff <file>|-] [--base <ref>] [--title <text>] [--description <file>]
                  [--config <file>] [--provider <name>] [--model <name>] [--json] [--no-gate]
  jev-gate diff [--base <ref>]
  jev-gate calibrate --dir <dir> [--config <file>] [--provider <name>]
                     [--repeat <n>] [--solo] [--json]

review reads a unified diff from --diff (a file, or - for stdin), or builds the local change
set when --diff is absent: the merge base with --base, the branch commits on top, and any
uncommitted changes, in one diff. --base defaults to the repository's main branch
(origin/HEAD, then origin/main, origin/master, main, or master). review prints one concern
probability per rule and exits 1 when a gated rule reaches its threshold unless --no-gate is
passed. The provider is typesafe (the default) or openrouter. The API key comes from
--api-key, or from TYPESAFE_API_KEY for typesafe and OPENROUTER_API_KEY for openrouter.

diff prints that local change set as a unified diff without calling Jev, for piping into
review or another tool. Nothing to print means no changes against the base.

calibrate runs the same rules over a directory of *.diff samples so thresholds can be set
from data instead of guesses. --repeat runs each sample n times to show run-to-run spread.
--solo sends one question per request instead of the production batched request, to check
whether answers lean on each other; compare its JSON output with the batched one.
`;

interface ParsedArgs {
  positionals: string[];
  flags: Map<string, string | true>;
}

function parseArgs(argv: readonly string[]): ParsedArgs {
  const positionals: string[] = [];
  const flags = new Map<string, string | true>();
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index] as string;
    if (arg.startsWith("--")) {
      const name = arg.slice(2);
      const next = argv[index + 1];
      if (next !== undefined && !next.startsWith("--")) {
        flags.set(name, next);
        index += 1;
      } else {
        flags.set(name, true);
      }
    } else {
      positionals.push(arg);
    }
  }
  return { positionals, flags };
}

function flagString(args: ParsedArgs, name: string): string | undefined {
  const value = args.flags.get(name);
  return typeof value === "string" ? value : undefined;
}

function loadConfigFile(path: string | undefined): ResolvedConfig {
  if (!path) return resolveConfig({});
  const text = readFileSync(path, "utf8");
  const warnings: string[] = [];
  const config = resolveConfig(validateConfigDocument(parseYaml(text) as unknown, warnings));
  for (const message of warnings) process.stderr.write(`warning: ${message}\n`);
  return config;
}

export function parseDiff(text: string): DiffFile[] {
  const files: DiffFile[] = [];
  const chunks = text.split(/^(?=diff --git )/m).filter((chunk) => chunk.startsWith("diff --git "));
  for (const chunk of chunks) {
    const headerEnd = chunk.indexOf("\n");
    const header = headerEnd === -1 ? chunk : chunk.slice(0, headerEnd);
    const match = /^diff --git a\/(.+) b\/(.+)$/.exec(header);
    if (!match) continue;
    let additions = 0;
    let deletions = 0;
    for (const line of chunk.split("\n")) {
      if (/^\+(?!\+\+)/.test(line)) additions += 1;
      if (/^-(?!--)/.test(line)) deletions += 1;
    }
    const status = /^new file mode/m.test(chunk) ? "added" : /^deleted file mode/m.test(chunk) ? "removed" : "modified";
    files.push({ path: match[2] as string, status, additions, deletions, patch: chunk });
  }
  return files;
}

function syntheticPullRequest(
  title: string,
  description: string,
  files: readonly DiffFile[],
  overrides: Partial<PullRequestContext> = {},
): PullRequestContext {
  return {
    owner: "local",
    repo: "local",
    number: 0,
    title,
    body: description,
    author: "local",
    baseRef: "local-base",
    baseSha: "local-base",
    headSha: "local-head",
    changedFiles: files.length,
    additions: files.reduce((sum, file) => sum + file.additions, 0),
    deletions: files.reduce((sum, file) => sum + file.deletions, 0),
    commits: 1,
    htmlUrl: "local",
    ...overrides,
  };
}

/** Apply --provider, keeping an explicitly configured model unless --model also arrives. */
function applyProviderFlag(args: ParsedArgs, config: ResolvedConfig): ResolvedConfig {
  const provider = flagString(args, "provider");
  if (!provider) return config;
  if (provider !== "typesafe" && provider !== "openrouter") {
    throw new ConfigError(`provider must be typesafe or openrouter, not ${provider}`);
  }
  return {
    ...config,
    provider,
    model: flagString(args, "model") || (provider !== config.provider ? DEFAULT_MODELS[provider] : config.model),
  };
}

function requireApiKey(args: ParsedArgs, provider: ResolvedConfig["provider"]): string {
  const envKey = PROVIDER_ENV_KEYS[provider];
  const key = flagString(args, "api-key") ?? process.env[envKey] ?? "";
  if (!key) throw new ConfigError(`no API key: set ${envKey} or pass --api-key`);
  return key;
}

async function commandReview(args: ParsedArgs): Promise<number> {
  const diffPath = flagString(args, "diff");
  const baseFlag = flagString(args, "base");
  if (diffPath !== undefined && baseFlag !== undefined) {
    process.stderr.write("pass either --diff or --base, not both\n");
    return 2;
  }
  const config = applyProviderFlag(args, loadConfigFile(flagString(args, "config")));
  const model = flagString(args, "model");
  if (model) config.model = model;
  const descriptionPath = flagString(args, "description");
  const description = descriptionPath ? readFileSync(descriptionPath, "utf8") : "";

  // No --diff means local mode: the change set against the base ref, uncommitted work included.
  let diffText: string;
  let overrides: Partial<PullRequestContext> = {};
  if (diffPath === undefined) {
    const local = await localDiff(baseFlag);
    if (local.diff.trim() === "") {
      process.stderr.write(`no changes against ${local.baseRef} (${local.baseSha.slice(0, 12)})\n`);
      return 0;
    }
    diffText = local.diff;
    overrides = { baseRef: local.baseRef, baseSha: local.baseSha, headSha: local.headSha };
    for (const warning of local.warnings) process.stderr.write(`warning: ${warning}\n`);
  } else {
    diffText = diffPath === "-" ? readFileSync(0, "utf8") : readFileSync(diffPath, "utf8");
  }
  const files = parseDiff(diffText);
  if (files.length === 0) {
    process.stderr.write("the diff contains no file changes\n");
    return 2;
  }
  const fallbackTitle = diffPath === undefined ? `local diff against ${overrides.baseRef}` : "local diff";
  const pr = syntheticPullRequest(flagString(args, "title") ?? fallbackTitle, description, files, overrides);
  const outcome = await runReview({ pr, files, config, apiKey: requireApiKey(args, config.provider) });
  if (args.flags.has("json")) {
    process.stdout.write(`${JSON.stringify(outcome, null, 2)}\n`);
  } else {
    process.stdout.write(`${renderPlainTable(outcome)}\n`);
    process.stdout.write(
      `\nmodel ${outcome.model} · ${Math.round(outcome.latencyMs)} ms · ${outcome.inputTokens} input tokens\n`,
    );
    if (outcome.failedGates.length > 0) {
      process.stdout.write(`gated rules failed: ${outcome.failedGates.join(", ")}\n`);
    }
    if (outcome.erroredGates.length > 0) {
      process.stdout.write(`gated rules that could not be graded: ${outcome.erroredGates.join(", ")}\n`);
    }
  }
  if ((outcome.failedGates.length > 0 || outcome.erroredGates.length > 0) && !args.flags.has("no-gate")) return 1;
  return 0;
}

/** Print the local change set as a unified diff; no model call, safe to pipe. */
async function commandDiff(args: ParsedArgs): Promise<number> {
  const local = await localDiff(flagString(args, "base"));
  for (const warning of local.warnings) process.stderr.write(`warning: ${warning}\n`);
  if (local.diff.trim() === "") {
    process.stderr.write(`no changes against ${local.baseRef} (${local.baseSha.slice(0, 12)})\n`);
    return 0;
  }
  process.stdout.write(local.diff);
  return 0;
}

/** Every *.diff under a directory, as paths relative to it, sorted for a stable report. */
function listDiffSamples(dir: string): string[] {
  const found: string[] = [];
  const walk = (current: string, prefix: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        walk(join(current, entry.name), relative);
      } else if (entry.name.endsWith(".diff")) {
        found.push(relative);
      }
    }
  };
  walk(dir, "");
  return found.sort();
}

interface DecisionSummary {
  name: string;
  values: Array<number | null>;
  mean: number | null;
  min: number | null;
  max: number | null;
}

interface SampleResult {
  sample: string;
  mode: "batched" | "solo";
  repeat: number;
  rulesHash: string;
  decisions: DecisionSummary[];
}

function summarize(name: string, values: Array<number | null>): DecisionSummary {
  const numbers = values.filter((value): value is number => value !== null);
  if (numbers.length === 0) return { name, values, mean: null, min: null, max: null };
  const mean = numbers.reduce((sum, value) => sum + value, 0) / numbers.length;
  return { name, values, mean, min: Math.min(...numbers), max: Math.max(...numbers) };
}

async function commandCalibrate(args: ParsedArgs): Promise<number> {
  const dir = flagString(args, "dir");
  if (!dir) {
    process.stderr.write("calibrate needs --dir <dir>\n");
    return 2;
  }
  const repeat = Number(flagString(args, "repeat") ?? "1");
  if (!Number.isInteger(repeat) || repeat < 1) {
    process.stderr.write("--repeat must be a positive integer\n");
    return 2;
  }
  const solo = args.flags.has("solo");
  const config = applyProviderFlag(args, loadConfigFile(flagString(args, "config")));
  const apiKey = requireApiKey(args, config.provider);
  const enabledRules = config.rules.filter((rule) => rule.enabled);
  if (enabledRules.length === 0) {
    process.stderr.write("no rules are enabled\n");
    return 2;
  }
  const rulesHash = rulesHashFor(enabledRules);
  const samples = listDiffSamples(dir);
  if (samples.length === 0) {
    process.stderr.write(`no *.diff samples under ${resolve(dir)}\n`);
    return 2;
  }
  const results: SampleResult[] = [];
  for (const sample of samples) {
    const files = parseDiff(readFileSync(join(dir, sample), "utf8"));
    const pr = syntheticPullRequest(sample, "", files);
    const values = new Map<string, Array<number | null>>(enabledRules.map((rule) => [rule.name, []]));
    for (let run = 0; run < repeat; run += 1) {
      if (solo) {
        for (const rule of enabledRules) {
          const outcome = await runReview({ pr, files, config: { ...config, rules: [rule] }, apiKey });
          values.get(rule.name)?.push(outcome.decisions[0]?.probability ?? null);
        }
      } else {
        const outcome = await runReview({ pr, files, config, apiKey });
        for (const decision of outcome.decisions) {
          values.get(decision.name)?.push(decision.probability);
        }
      }
    }
    results.push({
      sample,
      mode: solo ? "solo" : "batched",
      repeat,
      rulesHash,
      decisions: enabledRules.map((rule) => summarize(rule.name, values.get(rule.name) ?? [])),
    });
  }
  if (args.flags.has("json")) {
    process.stdout.write(`${JSON.stringify(results, null, 2)}\n`);
    return 0;
  }
  const header = ["sample", ...enabledRules.map((rule) => rule.name), "gates"];
  const rows = results.map((result) => [
    result.sample,
    ...result.decisions.map((decision) => (decision.mean === null ? "n/a" : (decision.mean * 100).toFixed(1))),
    (() => {
      const failed = enabledRules.filter((rule) => {
        if (!rule.gate) return false;
        const decision = result.decisions.find((entry) => entry.name === rule.name);
        return decision?.mean !== null && decision?.mean !== undefined && decision.mean >= rule.threshold;
      });
      return failed.length === 0 ? "ok" : failed.map((rule) => rule.name).join(",");
    })(),
  ]);
  const widths = header.map((title, index) => Math.max(title.length, ...rows.map((row) => (row[index] as string).length)));
  const format = (row: readonly string[]): string =>
    row.map((cell, index) => cell.padEnd(widths[index] as number)).join("  ").trimEnd();
  process.stdout.write(`${format(header)}\n${format(widths.map((width) => "-".repeat(width)))}\n`);
  for (const row of rows) process.stdout.write(`${format(row)}\n`);
  const mode = solo ? "solo" : "batched";
  process.stdout.write(`\n${mode} requests, ${repeat} run${repeat === 1 ? "" : "s"} per sample, rules ${rulesHash}.\n`);
  if (repeat > 1) {
    const spreads = enabledRules.map((rule) => {
      let worst = 0;
      let worstSample = "-";
      let observed = false;
      for (const result of results) {
        const decision = result.decisions.find((entry) => entry.name === rule.name);
        if (!decision || decision.min === null || decision.max === null || decision.values.length < 2) continue;
        observed = true;
        if (decision.max - decision.min > worst) {
          worst = decision.max - decision.min;
          worstSample = result.sample;
        }
      }
      return { rule, worst, worstSample, observed };
    });
    for (const spread of spreads.filter((entry) => entry.observed)) {
      process.stdout.write(
        `max run-to-run spread: ${spread.rule.name} ${(spread.worst * 100).toFixed(1)}pp (${spread.worstSample})\n`,
      );
    }
  }
  process.stdout.write("\nValues are mean concern probabilities in percent. Set thresholds from these, not from guesses.\n");
  return 0;
}

export async function runCli(argv: readonly string[]): Promise<number> {
  const args = parseArgs(argv);
  const command = args.positionals[0];
  try {
    if (command === "review") return await commandReview(args);
    if (command === "diff") return await commandDiff(args);
    if (command === "calibrate") return await commandCalibrate(args);
    process.stdout.write(USAGE);
    return command === undefined ? 0 : 2;
  } catch (error) {
    if (error instanceof ConfigError) {
      process.stderr.write(`${error.message}\n`);
      return 2;
    }
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

const isMain = isMainModule();
if (isMain) {
  runCli(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    });
}
