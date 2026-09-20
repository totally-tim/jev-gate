import { readFileSync } from "node:fs";
import { ConfigError } from "./config.js";
import { isMainModule } from "./entry.js";
import { localDiff } from "./gitdiff.js";
import { PROVIDER_ENV_KEYS } from "./jev.js";
import { renderPlainTable } from "./render.js";
import { reviewExitCode, runReview } from "./review.js";
import { collectSnapshot, loadLocalConfig, parseSnapshot, projectRoot, localFeedbackHash, } from "./snapshot.js";
import { applyDispositions, readDispositions, writeDisposition, } from "./dispositions.js";
import { calibrate } from "./calibrate.js";
export { parseDiff } from "./diff.js";
const USAGE = `jev-gate: a review companion for GitHub and coding agents

  jev-gate review [--base REF | --diff FILE | --snapshot FILE] [--json] [--no-gate]
  jev-gate snapshot [--base REF] [--json]
  jev-gate diff [--base REF]
  jev-gate calibrate --dir DIR [--split tune|holdout] [--repeat N] [--solo] [--json]
  jev-gate resolve ID --status accepted|dismissed --reason TEXT

Shared options: --config FILE, --policy-source working|base, --provider typesafe|openrouter,
--model NAME, --mode advisory|required, --title TEXT, --description FILE.
Configuration is discovered at the repository root. Base policy uses the merge-base commit.
Use - for stdin. JSON review output is schema 2, including empty or unavailable reviews.
Exit 0: complete advisory review or passing required review. Exit 1: required gate findings.
Exit 2: invalid configuration, incomplete coverage, or unavailable review; --no-gate does not hide errors.
`;
const booleans = new Set(["json", "no-gate", "solo", "help"]);
const values = new Set([
    "base",
    "diff",
    "snapshot",
    "config",
    "policy-source",
    "provider",
    "model",
    "mode",
    "title",
    "description",
    "dir",
    "split",
    "repeat",
    "status",
    "reason",
]);
function parseArgs(argv) {
    const positionals = [], flags = new Map();
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (!arg.startsWith("--")) {
            positionals.push(arg);
            continue;
        }
        const name = arg.slice(2);
        if (flags.has(name))
            throw new ConfigError(`duplicate flag --${name}`);
        if (booleans.has(name)) {
            flags.set(name, true);
            continue;
        }
        if (!values.has(name))
            throw new ConfigError(`unknown flag --${name}`);
        const value = argv[++i];
        if (value === undefined || value.startsWith("--"))
            throw new ConfigError(`--${name} needs a value`);
        flags.set(name, value);
    }
    return { positionals, flags };
}
const read = (path) => readFileSync(path === "-" ? 0 : path, "utf8");
export async function runCli(argv) {
    const wantsJson = argv.includes("--json");
    try {
        const { positionals, flags } = parseArgs(argv), command = positionals[0];
        const str = (key) => typeof flags.get(key) === "string"
            ? flags.get(key)
            : undefined;
        if (!command || flags.has("help")) {
            process.stdout.write(USAGE);
            return 0;
        }
        if (positionals.length > (command === "resolve" ? 2 : 1))
            throw new ConfigError("unexpected positional argument");
        if (!["review", "snapshot", "diff", "calibrate", "resolve"].includes(command))
            throw new ConfigError(`unknown command ${command}`);
        const common = ["config", "provider", "model", "mode", "json"];
        const local = [
            ...common,
            "base",
            "diff",
            "policy-source",
            "title",
            "description",
        ];
        const allowed = {
            review: [...local, "snapshot", "no-gate"],
            snapshot: local,
            diff: ["base"],
            calibrate: [...common, "dir", "split", "repeat", "solo"],
            resolve: ["status", "reason"],
        };
        for (const flag of flags.keys())
            if (!allowed[command].includes(flag))
                throw new ConfigError(`--${flag} is not supported by ${command}`);
        const policySource = str("policy-source");
        if (policySource && policySource !== "working" && policySource !== "base")
            throw new ConfigError("policy-source must be working or base");
        const options = {
            base: str("base"),
            config: str("config"),
            policySource: policySource,
            provider: str("provider"),
            model: str("model"),
            mode: str("mode"),
            title: str("title"),
            description: str("description") ? read(str("description")) : undefined,
        };
        if (command === "diff") {
            const d = await localDiff(options.base);
            for (const w of d.warnings)
                process.stderr.write(`warning: ${w}\n`);
            process.stdout.write(d.diff);
            return d.warnings.length ? 2 : 0;
        }
        if (command === "resolve") {
            writeDisposition(projectRoot(), positionals[1] ?? "", str("status") ?? "", str("reason") ?? "");
            process.stdout.write("Disposition recorded for this finding identity.\n");
            return 0;
        }
        if (command === "calibrate") {
            if (!str("dir"))
                throw new ConfigError("calibrate needs --dir");
            const { config } = loadLocalConfig(options);
            const key = process.env[PROVIDER_ENV_KEYS[config.provider]] ?? "";
            const result = await calibrate(str("dir"), config, key, Number(str("repeat") ?? 1), str("split"), flags.has("solo"));
            process.stdout.write(wantsJson
                ? JSON.stringify(result, null, 2) + "\n"
                : `${result.valid ? "Valid" : "INVALID"} evaluation: ${result.records.length} sample runs, ${result.invalidRuns} unavailable or inconsistent runs.\n${JSON.stringify(result.metrics, null, 2)}\n`);
            return result.valid ? 0 : 2;
        }
        if ([str("diff"), str("base"), str("snapshot")].filter((v) => v !== undefined)
            .length > 1)
            throw new ConfigError("pass only one of --diff, --base, or --snapshot");
        if (str("snapshot") &&
            [
                "config",
                "policy-source",
                "provider",
                "model",
                "mode",
                "title",
                "description",
            ].some((k) => flags.has(k)))
            throw new ConfigError("snapshot reviews use the captured policy and context; collect a new snapshot to change them");
        const snapshot = str("snapshot")
            ? parseSnapshot(read(str("snapshot")))
            : await collectSnapshot(options, str("diff") ? read(str("diff")) : undefined);
        if (command === "snapshot") {
            process.stdout.write(JSON.stringify(snapshot) + "\n");
            return 0;
        }
        if (snapshot.feedbackHash !== localFeedbackHash())
            throw new ConfigError("finding dispositions changed; collect a fresh snapshot");
        const dispositions = readDispositions(projectRoot());
        const outcome = applyDispositions(await runReview({
            snapshot,
            apiKey: process.env[PROVIDER_ENV_KEYS[snapshot.config.provider]] ?? "",
        }), dispositions);
        process.stdout.write(wantsJson
            ? JSON.stringify(outcome, null, 2) + "\n"
            : renderPlainTable(outcome) + "\n");
        return reviewExitCode(outcome, flags.has("no-gate"));
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (wantsJson)
            process.stdout.write(JSON.stringify({
                schema: 2,
                error: { kind: "input", message },
                health: "unavailable",
            }) + "\n");
        else
            process.stderr.write(message + "\n");
        return 2;
    }
}
if (isMainModule(import.meta.url))
    runCli(process.argv.slice(2))
        .then((code) => {
        process.exitCode = code;
    })
        .catch((error) => {
        process.stderr.write(String(error) + "\n");
        process.exitCode = 2;
    });
