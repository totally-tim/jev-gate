import { RULE_DEFINITIONS } from "./rules.js";
import type { ConfigDocument, Provider, ResolvedConfig, ResolvedRule, RuleConfigOverride } from "./types.js";

/** Thrown for a config file that exists but cannot be used. The action fails closed on this. */
export class ConfigError extends Error {}

/** Default model per provider; OpenRouter aliases the latest Jev release with a tilde. */
export const DEFAULT_MODELS: Record<Provider, string> = {
  typesafe: "jev-latest",
  openrouter: "~typesafe/jev-latest",
};

export const PROVIDERS: readonly Provider[] = ["typesafe", "openrouter"];

const DEFAULT_IGNORE: readonly string[] = [
  "**/node_modules/**",
  "**/package-lock.json",
  "**/bun.lock",
  "**/bun.lockb",
  "**/pnpm-lock.yaml",
  "**/yarn.lock",
  "**/Cargo.lock",
  "**/poetry.lock",
  "**/composer.lock",
  "**/Gemfile.lock",
  "**/*.min.js",
  "**/*.min.css",
  "**/*.map",
  "**/dist/**",
];

export const DEFAULT_MODEL = DEFAULT_MODELS.typesafe;
export const DEFAULT_MAX_STATE_TOKENS = 24_000;
export const MIN_STATE_TOKENS = 2_000;
export const MAX_STATE_TOKENS = 30_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Validate one rule override; unknown keys and bad types are config errors, not defaults. */
function readRuleOverride(name: string, raw: unknown, warnings: string[]): RuleConfigOverride {
  if (!isRecord(raw)) throw new ConfigError(`rules.${name} must be a mapping`);
  const override: RuleConfigOverride = {};
  for (const [key, value] of Object.entries(raw)) {
    if (key === "enabled" || key === "gate") {
      if (typeof value !== "boolean") throw new ConfigError(`rules.${name}.${key} must be a boolean`);
      override[key] = value;
    } else if (key === "threshold") {
      if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
        throw new ConfigError(`rules.${name}.threshold must be a number between 0 and 1`);
      }
      override.threshold = value;
      if (value === 0) {
        warnings.push(`rules.${name}.threshold is 0, so the rule fires on every diff`);
      } else if (value === 1) {
        warnings.push(`rules.${name}.threshold is 1, so the rule fires only on a certain answer`);
      }
    } else {
      throw new ConfigError(`rules.${name}.${key} is not a known setting`);
    }
  }
  return override;
}

/** Validate the optional OpenRouter settings block. */
function readOpenRouterSettings(raw: unknown): { referer?: string; title?: string } {
  if (!isRecord(raw)) throw new ConfigError("openrouter must be a mapping");
  const settings: { referer?: string; title?: string } = {};
  for (const [key, value] of Object.entries(raw)) {
    if (key !== "referer" && key !== "title") {
      throw new ConfigError(`openrouter.${key} is not a known setting`);
    }
    if (typeof value !== "string" || value.trim() === "") {
      throw new ConfigError(`openrouter.${key} must be a non-empty string`);
    }
    settings[key] = value.trim();
  }
  return settings;
}

/** Validate the parsed YAML document. Unknown top-level or rule keys are errors. */
export function validateConfigDocument(raw: unknown, warnings: string[] = []): ConfigDocument {
  if (raw === null || raw === undefined) return {};
  if (!isRecord(raw)) throw new ConfigError("the config file must be a YAML mapping");
  const doc: ConfigDocument = {};
  const knownRules = new Set(RULE_DEFINITIONS.map((rule) => rule.name));
  for (const [key, value] of Object.entries(raw)) {
    if (key === "provider") {
      if (value !== "typesafe" && value !== "openrouter") {
        throw new ConfigError("provider must be typesafe or openrouter");
      }
      doc.provider = value;
    } else if (key === "openrouter") {
      doc.openrouter = readOpenRouterSettings(value);
    } else if (key === "model") {
      if (typeof value !== "string" || value.trim() === "") throw new ConfigError("model must be a non-empty string");
      doc.model = value.trim();
    } else if (key === "maxStateTokens") {
      if (
        typeof value !== "number" ||
        !Number.isInteger(value) ||
        value < MIN_STATE_TOKENS ||
        value > MAX_STATE_TOKENS
      ) {
        throw new ConfigError(
          `maxStateTokens must be an integer between ${MIN_STATE_TOKENS} and ${MAX_STATE_TOKENS}`,
        );
      }
      doc.maxStateTokens = value;
    } else if (key === "ignore") {
      if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
        throw new ConfigError("ignore must be a list of glob strings");
      }
      doc.ignore = value as string[];
    } else if (key === "comment") {
      if (typeof value !== "boolean") throw new ConfigError("comment must be a boolean");
      doc.comment = value;
    } else if (key === "rules") {
      if (!isRecord(value)) throw new ConfigError("rules must be a mapping of rule name to settings");
      const rules: Record<string, RuleConfigOverride> = {};
      for (const [name, entry] of Object.entries(value)) {
        if (!knownRules.has(name)) throw new ConfigError(`rules.${name} is not a known rule`);
        rules[name] = readRuleOverride(name, entry, warnings);
      }
      doc.rules = rules;
    } else {
      throw new ConfigError(`${key} is not a known setting`);
    }
  }
  return doc;
}

/** Apply a validated document over the built-in rule definitions. */
export function resolveConfig(doc: ConfigDocument): ResolvedConfig {
  const overrides = doc.rules ?? {};
  const rules: ResolvedRule[] = RULE_DEFINITIONS.map((definition) => {
    const override = overrides[definition.name];
    return {
      ...definition,
      enabled: override?.enabled ?? true,
      gate: override?.gate ?? definition.gate,
      threshold: override?.threshold ?? definition.threshold,
    };
  });
  return {
    provider: doc.provider ?? "typesafe",
    model: doc.model ?? DEFAULT_MODELS[doc.provider ?? "typesafe"],
    maxStateTokens: doc.maxStateTokens ?? DEFAULT_MAX_STATE_TOKENS,
    ignore: doc.ignore ?? DEFAULT_IGNORE,
    comment: doc.comment ?? true,
    rules,
    openrouter: doc.openrouter ?? {},
  };
}
