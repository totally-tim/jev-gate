import { createHash } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { resolve, join } from "node:path";
import { parse as parseYaml } from "yaml";
import {
  ConfigError,
  DEFAULT_MODELS,
  resolveConfig,
  validateConfigDocument,
} from "./config.js";
import { localDiff } from "./gitdiff.js";
import { parseUnifiedDiff } from "./diff.js";
import { buildQuestions } from "./rules.js";
import { DIAGNOSTIC_POLICY } from "./diagnostics.js";
import { isLocalDecide } from "./jev.js";
import type {
  DiffFile,
  PullRequestContext,
  ResolvedConfig,
  ResolvedRule,
  ReviewSnapshot,
} from "./types.js";
export const STATE_VERSION = "candidate-v5";
export const hash = (value: unknown): string =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
export function rulesHashFor(rules: readonly ResolvedRule[]): string {
  return hash(buildQuestions(rules.filter((r) => r.enabled))).slice(0, 16);
}
export function policyHashFor(config: ResolvedConfig): string {
  return hash({
    version: STATE_VERSION,
    ...(isLocalDecide(config.provider, config.model) ? { modelProfile: "local-decide-v2" } : {}),
    questions: rulesHashFor(config.rules),
    ...(config.diagnostics?.enabled ? { diagnostics: DIAGNOSTIC_POLICY } : {}),
    config,
  });
}
export function localFeedbackHash(cwd = process.cwd()): string {
  try {
    return hash(
      readFileSync(
        join(projectRoot(cwd), ".jev-gate/dispositions.jsonl"),
        "utf8",
      ),
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return hash("");
    throw error;
  }
}
export function makeSnapshot(
  pr: PullRequestContext,
  files: readonly DiffFile[],
  config: ResolvedConfig,
  configSource = "defaults",
  warnings: string[] = [],
  feedbackHash = hash(""),
): ReviewSnapshot {
  const contentHash = hash({ pr, files, warnings });
  const policyHash = policyHashFor(config);
  return {
    schema: 1,
    id: hash({ contentHash, policyHash, feedbackHash }),
    contentHash,
    policyHash,
    feedbackHash,
    configSource,
    pr,
    files: [...files],
    warnings,
    config,
  };
}
export interface LocalOptions {
  cwd?: string;
  base?: string;
  config?: string;
  policySource?: "working" | "base";
  provider?: string;
  model?: string;
  mode?: string;
  title?: string;
  description?: string;
}
export function configFromText(text: string): ResolvedConfig {
  return resolveConfig(validateConfigDocument(parseYaml(text)));
}
export function applyOverrides(
  config: ResolvedConfig,
  options: Pick<LocalOptions, "provider" | "model" | "mode">,
): ResolvedConfig {
  const provider = options.provider ?? config.provider;
  const mode = options.mode ?? config.mode;
  if (provider !== "typesafe" && provider !== "openrouter")
    throw new ConfigError("provider must be typesafe or openrouter");
  if (mode !== "advisory" && mode !== "required")
    throw new ConfigError("mode must be advisory or required");
  return {
    ...config,
    provider,
    mode,
    model:
      options.model ??
      (provider !== config.provider ? DEFAULT_MODELS[provider] : config.model),
  };
}
export function projectRoot(cwd = process.cwd()): string {
  try {
    return execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return resolve(cwd);
  }
}
export function loadLocalConfig(
  options: LocalOptions,
  baseSha?: string,
): { config: ResolvedConfig; source: string } {
  const root = projectRoot(options.cwd);
  let config = resolveConfig({}),
    source = "defaults";
  if (options.policySource === "base") {
    if (!baseSha)
      throw new ConfigError("base policy requires a local --base snapshot");
    if (options.config)
      throw new ConfigError(
        "--config and --policy-source base cannot be combined",
      );
    const listing = execFileSync(
      "git",
      ["ls-tree", "--name-only", baseSha, "--", ".jev-gate.yml"],
      { cwd: root, encoding: "utf8" },
    );
    if (listing.trim())
      config = configFromText(
        execFileSync("git", ["show", `${baseSha}:.jev-gate.yml`], {
          cwd: root,
          encoding: "utf8",
        }),
      );
    source = `.jev-gate.yml@${baseSha}${listing.trim() ? "" : " (defaults)"}`;
  } else {
    const path = options.config
      ? resolve(options.cwd ?? process.cwd(), options.config)
      : join(root, ".jev-gate.yml");
    if (options.config || existsSync(path)) {
      config = configFromText(readFileSync(path, "utf8"));
      source = path;
    }
  }
  return { config: applyOverrides(config, options), source };
}
export function localContext(
  files: readonly DiffFile[],
  options: Partial<PullRequestContext> = {},
): PullRequestContext {
  return {
    owner: "local",
    repo: "local",
    number: 0,
    title: "Local changes",
    body: "",
    author: "local",
    baseRef: "provided-diff",
    baseSha: "",
    headSha: "",
    changedFiles: files.length,
    additions: files.reduce((n, f) => n + f.additions, 0),
    deletions: files.reduce((n, f) => n + f.deletions, 0),
    commits: 1,
    htmlUrl: "",
    ...options,
  };
}
export async function collectSnapshot(
  options: LocalOptions,
  diffText?: string,
): Promise<ReviewSnapshot> {
  const local =
    diffText === undefined ? await localDiff(options.base, options.cwd) : null;
  const parsed = parseUnifiedDiff(diffText ?? local!.diff);
  const policy = loadLocalConfig(options, local?.baseSha);
  const pr = localContext(parsed.files, {
    title: options.title ?? "Local changes",
    body: options.description ?? "",
    ...(local
      ? {
          baseRef: local.baseRef,
          baseSha: local.baseSha,
          headSha: local.headSha,
        }
      : {}),
  });
  return makeSnapshot(
    pr,
    parsed.files,
    policy.config,
    policy.source,
    [...(local?.warnings ?? []), ...parsed.warnings],
    localFeedbackHash(options.cwd),
  );
}
/** Snapshots are process input, never executable configuration. Validate and recompute identity. */
export function parseSnapshot(text: string): ReviewSnapshot {
  const value = JSON.parse(text) as ReviewSnapshot;
  if (
    value?.schema !== 1 ||
    !Array.isArray(value.files) ||
    !Array.isArray(value.warnings) ||
    !value.pr ||
    !value.config
  )
    throw new ConfigError("invalid snapshot");
  if (
    typeof value.feedbackHash !== "string" ||
    !/^[a-f0-9]{64}$/.test(value.feedbackHash)
  )
    throw new ConfigError("invalid snapshot feedback identity");
  for (const file of value.files)
    if (
      typeof file.path !== "string" ||
      typeof file.status !== "string" ||
      !(
        file.patchWarning === undefined || typeof file.patchWarning === "string"
      ) ||
      !(
        file.previousPath === undefined || typeof file.previousPath === "string"
      ) ||
      !(file.patch === null || typeof file.patch === "string") ||
      !Number.isFinite(file.additions) ||
      !Number.isFinite(file.deletions)
    )
      throw new ConfigError("invalid snapshot file");
  for (const key of [
    "owner",
    "repo",
    "title",
    "body",
    "author",
    "baseRef",
    "baseSha",
    "headSha",
    "htmlUrl",
  ] as const)
    if (typeof value.pr[key] !== "string")
      throw new ConfigError("invalid snapshot context");
  for (const key of [
    "number",
    "changedFiles",
    "additions",
    "deletions",
    "commits",
  ] as const)
    if (!Number.isInteger(value.pr[key]) || value.pr[key] < 0)
      throw new ConfigError("invalid snapshot counts");
  if (
    value.warnings.some((w) => typeof w !== "string") ||
    typeof value.configSource !== "string"
  )
    throw new ConfigError("invalid snapshot metadata");
  const c = value.config;
  if (!Array.isArray(c.rules)) throw new ConfigError("invalid snapshot rules");
  const config = resolveConfig(
    validateConfigDocument({
      provider: c.provider,
      model: c.model,
      mode: c.mode,
      maxStateTokens: c.maxStateTokens,
      maxRequests: c.maxRequests,
      borderlineMargin: c.borderlineMargin,
      ...(c.diagnostics !== undefined ? { diagnostics: c.diagnostics } : {}),
      ignore: c.ignore,
      comment: c.comment,
      openrouter: c.openrouter,
      rules: Object.fromEntries(
        c.rules.map((r) => [
          r.name,
          { enabled: r.enabled, gate: r.gate, threshold: r.threshold },
        ]),
      ),
    }),
  );
  if (policyHashFor(c) !== policyHashFor(config))
    throw new ConfigError("snapshot rules changed; collect a fresh snapshot");
  const rebuilt = makeSnapshot(
    value.pr,
    value.files,
    config,
    value.configSource,
    value.warnings,
    value.feedbackHash,
  );
  if (rebuilt.id !== value.id)
    throw new ConfigError(
      "snapshot content or installed rules changed; collect a fresh snapshot",
    );
  return rebuilt;
}
