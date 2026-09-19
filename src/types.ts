/** Everything the review needs to know about one pull request. */
export interface PullRequestContext {
  owner: string;
  repo: string;
  number: number;
  title: string;
  body: string;
  author: string;
  baseRef: string;
  baseSha: string;
  headSha: string;
  changedFiles: number;
  additions: number;
  deletions: number;
  commits: number;
  htmlUrl: string;
}

/** One changed file, with its unified diff when GitHub provides one. */
export interface DiffFile {
  path: string;
  status: string;
  additions: number;
  deletions: number;
  patch: string | null;
}

export type RuleKind = "noul" | "score";

/** A decisions provider that serves Jev models. */
export type Provider = "typesafe" | "openrouter";

/** A rule as authored in this repository: the question and how it is read. */
export interface RuleDefinition {
  name: string;
  /** Short heading used in the comment and documentation. */
  title: string;
  kind: RuleKind;
  /** The question text sent to Jev. Written as a statement of the concern. */
  instructions: string;
  /** For score rules: ordered rubric, least concerning level first. */
  rubric?: readonly string[];
  /** Default gating behavior; a config file can override it. */
  gate: boolean;
  /** Default threshold on the concern probability, 0..1. */
  threshold: number;
}

/** Rule overrides as they appear in `.jev-gate.yml`. */
export interface RuleConfigOverride {
  enabled?: boolean;
  gate?: boolean;
  threshold?: number;
}

/** The parsed shape of `.jev-gate.yml`. */
export interface ConfigDocument {
  provider?: Provider;
  model?: string;
  maxStateTokens?: number;
  borderlineMargin?: number;
  ignore?: string[];
  comment?: boolean;
  rules?: Record<string, RuleConfigOverride>;
  openrouter?: { referer?: string; title?: string };
}

/** A rule with its config overrides applied. */
export interface ResolvedRule extends RuleDefinition {
  enabled: boolean;
}

export interface ResolvedConfig {
  provider: Provider;
  model: string;
  maxStateTokens: number;
  /** Distance from the threshold inside which a gated rule gets a second ask, 0..0.3. */
  borderlineMargin: number;
  ignore: readonly string[];
  comment: boolean;
  rules: readonly ResolvedRule[];
  /** Ranking headers OpenRouter accepts; other providers ignore them. */
  openrouter: { referer?: string; title?: string };
}

/** One rule's answer, reduced to the numbers the comment shows. */
export interface RuleDecision {
  name: string;
  title: string;
  kind: RuleKind;
  gate: boolean;
  threshold: number;
  /** Concern probability, 0..1, or null when the rule could not be graded. */
  probability: number | null;
  /** Score rules: the expected level as Jev returned it, before normalization. */
  level?: number;
  /** Score rules: number of rubric levels. */
  levels?: number;
  /** Reported confidence for score rules. */
  confidence?: number;
  /**
   * Gated rules that landed within `borderlineMargin` of the threshold are asked twice.
   * This carries the individual asks, first first; `probability` is their mean.
   */
  samples?: number[];
  /** Probability at or above the threshold. */
  exceeded: boolean;
  /** Exceeded and gating; this is what fails the check. */
  failed: boolean;
  /** Why the rule could not be graded, or null when it was. */
  error: string | null;
}

/** The complete result of one review run, and the payload of the hidden data block. */
export interface ReviewOutcome {
  schema: 1;
  headSha: string;
  baseSha: string;
  prNumber: number;
  model: string;
  /** SHA-256 prefix of the enabled rules' wording, so records stay comparable across edits. */
  rulesHash: string;
  latencyMs: number;
  inputTokens: number;
  outputTokens: number;
  costUSD: number;
  ranAt: string;
  truncated: boolean;
  decisions: RuleDecision[];
  passed: boolean;
  failedGates: string[];
  /** Gated rules that could not be graded; the check fails while this is non-empty. */
  erroredGates: string[];
}

/** The state object sent to Jev. */
export interface ReviewState {
  pr: {
    title: string;
    description: string;
    author: string;
    base: string;
    head: string;
  };
  totals: {
    files: number;
    additions: number;
    deletions: number;
    commits: number;
  };
  files: Array<{
    path: string;
    status: string;
    additions: number;
    deletions: number;
    patch?: string;
  }>;
  truncated: boolean;
}
