import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { ConfigError, resolveConfig, validateConfigDocument } from "./config.js";
import { isMainModule } from "./entry.js";
import { renderPlainTable } from "./render.js";
import { runReview } from "./review.js";
const USAGE = `jev-gate: Jev-powered PR review rules

Usage:
  jev-gate review --diff <file> [--title <text>] [--description <file>]
                  [--config <file>] [--model <name>] [--json] [--no-gate]
  jev-gate calibrate --dir <dir> [--config <file>] [--json]

review reads a unified diff (for example \`git diff main...HEAD\`) and prints one concern
probability per rule. It exits 1 when a gated rule reaches its threshold unless --no-gate
is passed. The API key comes from TYPESAFE_API_KEY or --api-key.

calibrate runs the same rules over a directory of *.diff samples so thresholds can be set
from data instead of guesses.
`;
function parseArgs(argv) {
    const positionals = [];
    const flags = new Map();
    for (let index = 0; index < argv.length; index += 1) {
        const arg = argv[index];
        if (arg.startsWith("--")) {
            const name = arg.slice(2);
            const next = argv[index + 1];
            if (next !== undefined && !next.startsWith("--")) {
                flags.set(name, next);
                index += 1;
            }
            else {
                flags.set(name, true);
            }
        }
        else {
            positionals.push(arg);
        }
    }
    return { positionals, flags };
}
function flagString(args, name) {
    const value = args.flags.get(name);
    return typeof value === "string" ? value : undefined;
}
function loadConfigFile(path) {
    if (!path)
        return resolveConfig({});
    const text = readFileSync(path, "utf8");
    return resolveConfig(validateConfigDocument(parseYaml(text)));
}
export function parseDiff(text) {
    const files = [];
    const chunks = text.split(/^(?=diff --git )/m).filter((chunk) => chunk.startsWith("diff --git "));
    for (const chunk of chunks) {
        const headerEnd = chunk.indexOf("\n");
        const header = headerEnd === -1 ? chunk : chunk.slice(0, headerEnd);
        const match = /^diff --git a\/(.+) b\/(.+)$/.exec(header);
        if (!match)
            continue;
        let additions = 0;
        let deletions = 0;
        for (const line of chunk.split("\n")) {
            if (/^\+(?!\+\+)/.test(line))
                additions += 1;
            if (/^-(?!--)/.test(line))
                deletions += 1;
        }
        const status = /^new file mode/m.test(chunk) ? "added" : /^deleted file mode/m.test(chunk) ? "removed" : "modified";
        files.push({ path: match[2], status, additions, deletions, patch: chunk });
    }
    return files;
}
function syntheticPullRequest(title, description, files) {
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
    };
}
function requireApiKey(args) {
    const key = flagString(args, "api-key") ?? process.env.TYPESAFE_API_KEY ?? "";
    if (!key)
        throw new ConfigError("no API key: set TYPESAFE_API_KEY or pass --api-key");
    return key;
}
async function commandReview(args) {
    const diffPath = flagString(args, "diff");
    if (!diffPath) {
        process.stderr.write("review needs --diff <file>\n");
        return 2;
    }
    const config = loadConfigFile(flagString(args, "config"));
    const model = flagString(args, "model");
    if (model)
        config.model = model;
    const diffText = readFileSync(diffPath, "utf8");
    const files = parseDiff(diffText);
    if (files.length === 0) {
        process.stderr.write("the diff contains no file changes\n");
        return 2;
    }
    const descriptionPath = flagString(args, "description");
    const description = descriptionPath ? readFileSync(descriptionPath, "utf8") : "";
    const pr = syntheticPullRequest(flagString(args, "title") ?? "local diff", description, files);
    const outcome = await runReview({ pr, files, config, apiKey: requireApiKey(args) });
    if (args.flags.has("json")) {
        process.stdout.write(`${JSON.stringify(outcome, null, 2)}\n`);
    }
    else {
        process.stdout.write(`${renderPlainTable(outcome)}\n`);
        process.stdout.write(`\nmodel ${outcome.model} · ${Math.round(outcome.latencyMs)} ms · ${outcome.inputTokens} input tokens\n`);
        if (outcome.failedGates.length > 0) {
            process.stdout.write(`gated rules failed: ${outcome.failedGates.join(", ")}\n`);
        }
    }
    if (outcome.failedGates.length > 0 && !args.flags.has("no-gate"))
        return 1;
    return 0;
}
async function commandCalibrate(args) {
    const dir = flagString(args, "dir");
    if (!dir) {
        process.stderr.write("calibrate needs --dir <dir>\n");
        return 2;
    }
    const config = loadConfigFile(flagString(args, "config"));
    const apiKey = requireApiKey(args);
    const samples = readdirSync(dir)
        .filter((name) => name.endsWith(".diff"))
        .sort();
    if (samples.length === 0) {
        process.stderr.write(`no *.diff samples in ${resolve(dir)}\n`);
        return 2;
    }
    const results = [];
    for (const sample of samples) {
        const files = parseDiff(readFileSync(join(dir, sample), "utf8"));
        const pr = syntheticPullRequest(sample, "", files);
        const outcome = await runReview({ pr, files, config, apiKey });
        results.push({ sample, outcome });
    }
    if (args.flags.has("json")) {
        process.stdout.write(`${JSON.stringify(results.map(({ sample, outcome }) => ({
            sample,
            decisions: outcome.decisions.map((decision) => ({
                name: decision.name,
                probability: decision.probability,
                threshold: decision.threshold,
                failed: decision.failed,
            })),
        })), null, 2)}\n`);
        return 0;
    }
    const ruleNames = results[0]?.outcome.decisions.map((decision) => decision.name) ?? [];
    const header = ["sample", ...ruleNames, "gates"];
    const rows = results.map(({ sample, outcome }) => [
        sample,
        ...ruleNames.map((name) => {
            const decision = outcome.decisions.find((entry) => entry.name === name);
            return decision ? (decision.probability * 100).toFixed(1) : "-";
        }),
        outcome.failedGates.length === 0 ? "ok" : outcome.failedGates.join(","),
    ]);
    const widths = header.map((title, index) => Math.max(title.length, ...rows.map((row) => row[index].length)));
    const format = (row) => row.map((cell, index) => cell.padEnd(widths[index])).join("  ").trimEnd();
    process.stdout.write(`${format(header)}\n${format(widths.map((width) => "-".repeat(width)))}\n`);
    for (const row of rows)
        process.stdout.write(`${format(row)}\n`);
    process.stdout.write("\nValues are concern probabilities in percent. Set thresholds from these, not from guesses.\n");
    return 0;
}
export async function runCli(argv) {
    const args = parseArgs(argv);
    const command = args.positionals[0];
    try {
        if (command === "review")
            return await commandReview(args);
        if (command === "calibrate")
            return await commandCalibrate(args);
        process.stdout.write(USAGE);
        return command === undefined ? 0 : 2;
    }
    catch (error) {
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
        .catch((error) => {
        process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
        process.exitCode = 1;
    });
}
