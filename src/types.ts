/** Repository metadata for an immutable review input. */
export interface PullRequestContext {
  state?: string;
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
export interface DiffFile {
  path: string;
  status: string;
  additions: number;
  deletions: number;
  patch: string | null;
  previousPath?: string;
  patchWarning?: string;
}
export type RuleKind = "noul" | "score";
export type Provider = "typesafe" | "openrouter";
export type ReviewMode = "advisory" | "required";
export interface RuleDefinition {
  name: string;
  title: string;
  kind: RuleKind;
  instructions: string;
  rubric?: readonly string[];
  gate: boolean;
  threshold: number;
  verification: string;
  enabled?: boolean;
}
export interface RuleConfigOverride {
  enabled?: boolean;
  gate?: boolean;
  threshold?: number;
}
export interface ConfigDocument {
  provider?: Provider;
  model?: string;
  mode?: ReviewMode;
  maxStateTokens?: number;
  maxRequests?: number;
  borderlineMargin?: number;
  ignore?: string[];
  comment?: boolean;
  rules?: Record<string, RuleConfigOverride>;
  openrouter?: { referer?: string; title?: string };
}
export interface ResolvedRule extends RuleDefinition {
  enabled: boolean;
}
export interface ResolvedConfig {
  provider: Provider;
  model: string;
  mode: ReviewMode;
  maxStateTokens: number;
  maxRequests: number;
  borderlineMargin: number;
  ignore: readonly string[];
  comment: boolean;
  rules: readonly ResolvedRule[];
  openrouter: { referer?: string; title?: string };
}
export interface CoverageEntry {
  path: string;
  status: "reviewed" | "excluded" | "partial" | "unavailable";
  reason: string | null;
  reviewedChunks: number;
  totalChunks: number;
}
export interface Coverage {
  files: CoverageEntry[];
  warnings: string[];
}
export interface Candidate {
  id: string;
  path: string;
  startLine: number | null;
  endLine: number | null;
  side: "old" | "new";
  patch: string;
  status: string;
}
export interface RuleDecision {
  name: string;
  title: string;
  kind: RuleKind;
  gate: boolean;
  threshold: number;
  /** Normalized value used for thresholds; a score value is not a probability. */
  value: number | null;
  probability: number | null;
  level?: number;
  levels?: number;
  confidence?: number;
  samples?: number[];
  exceeded: boolean;
  failed: boolean;
  error: string | null;
  candidate: Omit<Candidate, "patch">;
}
export interface Finding {
  id: string;
  rule: string;
  title: string;
  category: "review-request" | "potential-issue" | "secret";
  path: string;
  startLine: number | null;
  endLine: number | null;
  side: "old" | "new";
  evidence: string;
  verification: string;
  value: number;
  kind: RuleKind;
  source: "local" | "jev";
  status: "open" | "accepted" | "fixed" | "dismissed";
  disposition?: { reason: string; at: string };
}
export interface ReviewSnapshot {
  schema: 1;
  id: string;
  contentHash: string;
  policyHash: string;
  feedbackHash: string;
  configSource: string;
  pr: PullRequestContext;
  files: DiffFile[];
  warnings: string[];
  config: ResolvedConfig;
}
export interface ReviewOutcome {
  schema: 2;
  snapshotId: string;
  contentHash: string;
  policyHash: string;
  configSource: string;
  headSha: string;
  baseSha: string;
  prNumber: number;
  provider: Provider;
  model: string;
  rulesHash: string;
  stateVersion: string;
  mode: ReviewMode;
  latencyMs: number;
  inputTokens: number;
  outputTokens: number;
  costUSD: number;
  ranAt: string;
  health: "complete" | "partial" | "unavailable";
  status: "clear" | "needs-review" | "incomplete" | "unavailable";
  coverage: Coverage;
  findings: Finding[];
  decisions: RuleDecision[];
  passed: boolean;
  failedGates: string[];
  erroredGates: string[];
  errors: string[];
}
export interface ReviewState {
  pr: {
    title: string;
    description: string;
    author: string;
    base: string;
    head: string;
  };
  files: Array<{ path: string; status: string; patch: string }>;
  fileContext?: { openingPatch: string; clipped: boolean; scope: string };
  scope: string;
  relatedChanges?: Array<{
    path: string;
    status: string;
    patch: string;
    clipped: boolean;
  }>;
}
