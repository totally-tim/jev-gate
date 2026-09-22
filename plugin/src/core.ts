import { isAbsolute, relative, resolve } from "node:path";
export interface ResolvedOptions {
  base?: string;
  config?: string;
  policySource?: "working" | "base";
  cli: string;
  cliArgs: string[];
  intervalMs: number;
  inject: boolean;
  ledgerPath: string;
  provider?: "typesafe" | "openrouter";
  model?: string;
  apiKey?: string;
  timeoutMs: number;
}
export function resolveOptions(
  raw: unknown,
  defaults: { directory: string },
): ResolvedOptions {
  if (
    raw !== undefined &&
    (!raw || typeof raw !== "object" || Array.isArray(raw))
  )
    throw new Error("options must be a mapping");
  const o = (raw ?? {}) as Record<string, unknown>;
  for (const key of Object.keys(o))
    if (
      ![
        "base",
        "config",
        "policySource",
        "cli",
        "intervalMs",
        "inject",
        "ledger",
        "provider",
        "model",
        "apiKey",
        "timeoutMs",
      ].includes(key)
    )
      throw new Error(`unknown option ${key}`);
  const string = (key: string): string | undefined => {
    const v = o[key];
    if (v === undefined) return undefined;
    if (typeof v !== "string" || !v.trim())
      throw new Error(`${key} must be a nonempty string`);
    return v;
  };
  const integer = (key: string, fallback: number, min: number, max: number) => {
    const v = o[key] ?? fallback;
    if (typeof v !== "number" || !Number.isInteger(v) || v < min || v > max)
      throw new Error(`invalid ${key}`);
    return v;
  };
  const cli = o.cli ?? "jev-gate";
  let parts: string[];
  if (
    Array.isArray(cli) &&
    cli.length &&
    cli.every((p) => typeof p === "string" && p.length)
  )
    parts = cli as string[];
  else if (typeof cli === "string" && cli.trim()) {
    parts = [];
    let token = "",
      quote = "",
      started = false;
    for (let i = 0; i < cli.length; i++) {
      const c = cli[i]!;
      if (c === "\\" && quote !== "'") {
        if (++i === cli.length)
          throw new Error("invalid cli escape; prefer an argv array");
        token += cli[i];
        started = true;
      } else if (quote) {
        if (c === quote) quote = "";
        else token += c;
      } else if (c === '"' || c === "'") {
        quote = c;
        started = true;
      } else if (/\s/.test(c)) {
        if (started) parts.push(token);
        token = "";
        started = false;
      } else {
        token += c;
        started = true;
      }
    }
    if (quote) throw new Error("unclosed cli quote; prefer an argv array");
    if (started) parts.push(token);
  } else
    throw new Error(
      "cli must be an executable or an array of executable and arguments",
    );
  if (o.inject !== undefined && typeof o.inject !== "boolean")
    throw new Error("inject must be boolean");
  if (
    o.provider !== undefined &&
    o.provider !== "typesafe" &&
    o.provider !== "openrouter"
  )
    throw new Error("invalid provider");
  if (
    o.policySource !== undefined &&
    o.policySource !== "working" &&
    o.policySource !== "base"
  )
    throw new Error("invalid policySource");
  const ledger = string("ledger") ?? ".jev-gate/ledger.jsonl";
  const ledgerPath = resolve(defaults.directory, ledger);
  const localLedger = relative(
    resolve(defaults.directory),
    ledgerPath,
  ).replaceAll("\\", "/");
  if (
    localLedger !== ".." &&
    !localLedger.startsWith("../") &&
    !isAbsolute(localLedger) &&
    (!localLedger.startsWith(".jev-gate/") ||
      localLedger === ".jev-gate/dispositions.jsonl")
  )
    throw new Error(
      "a project ledger must be under .jev-gate/ and separate from dispositions.jsonl",
    );
  if (!parts[0]) throw new Error("empty cli command");
  return {
    cli: parts[0],
    cliArgs: parts.slice(1),
    base: string("base"),
    config: string("config"),
    policySource: o.policySource as ResolvedOptions["policySource"],
    intervalMs: integer("intervalMs", 120000, 1000, 86400000),
    timeoutMs: integer("timeoutMs", 120000, 1000, 600000),
    inject: o.inject === true,
    ledgerPath,
    provider: o.provider as ResolvedOptions["provider"],
    model: string("model"),
    apiKey: string("apiKey"),
  };
}
export interface FindingView {
  id: string;
  rule: string;
  title: string;
  path: string;
  startLine: number | null;
  status: string;
  verification: string;
  category: string;
  diagnostic?: { status: string; reason: string; verification?: string };
}
export interface OutcomeView {
  schema: 2;
  snapshotId: string;
  health: "complete" | "partial" | "unavailable";
  status: string;
  findings: FindingView[];
  errors: string[];
  policyHash: string;
  model: string;
}
export function parseOutcome(text: string): OutcomeView | null {
  try {
    const v = JSON.parse(text) as OutcomeView;
    if (
      v?.schema !== 2 ||
      !/^[a-f0-9]{64}$/.test(v.snapshotId) ||
      !["complete", "partial", "unavailable"].includes(v.health) ||
      !["clear", "needs-review", "incomplete", "unavailable"].includes(
        v.status,
      ) ||
      !/^[a-f0-9]{64}$/.test(v.policyHash) ||
      typeof v.model !== "string" ||
      !Array.isArray(v.findings) ||
      !Array.isArray(v.errors) ||
      v.errors.some((e) => typeof e !== "string")
    )
      return null;
    for (const f of v.findings)
      if (
        !f ||
        !/^[a-f0-9]{24}$/.test(f.id) ||
        ![
          f.id,
          f.rule,
          f.title,
          f.path,
          f.status,
          f.verification,
          f.category,
        ].every((s) => typeof s === "string") ||
        !(
          f.startLine === null ||
          (Number.isInteger(f.startLine) && f.startLine > 0)
        ) ||
        !["open", "accepted", "dismissed", "fixed"].includes(f.status) ||
        (f.diagnostic !== undefined && (!f.diagnostic ||
          !["supported", "no-match", "no-issue", "insufficient-context", "skipped", "unavailable"].includes(f.diagnostic.status) ||
          typeof f.diagnostic.reason !== "string" ||
          (f.diagnostic.verification !== undefined && typeof f.diagnostic.verification !== "string")))
      )
        return null;
    return v;
  } catch {
    return null;
  }
}
export function formatBriefing(
  outcome: OutcomeView,
  findings = outcome.findings.filter((f) => f.status === "open"),
): string | null {
  if (!findings.length && outcome.health === "complete") return null;
  const lines = [
    `JEV review for current snapshot ${outcome.snapshotId.slice(0, 12)}. Review health: ${outcome.health}.`,
  ];
  if (outcome.health !== "complete")
    lines.push(
      "Review coverage is incomplete or unavailable. Do not describe this change as reviewed. Check the ledger for coverage and error details.",
    );
  for (const f of findings.slice(0, 10))
    lines.push(
      `- ${f.rule} at ${JSON.stringify(f.path)}${f.startLine === null ? "" : `:${f.startLine}`} [${f.id}]: ${f.verification}`,
      ...(f.diagnostic ? [`  Optional follow-up data: ${JSON.stringify({ status: f.diagnostic.status, reason: f.diagnostic.reason, verification: f.diagnostic.verification })}. This does not resolve the finding or independently verify it.`] : []),
    );
  if (findings.length > 10)
    lines.push(
      `${findings.length - 10} additional findings are in the ledger.`,
    );
  lines.push(
    "Locations identify reviewed candidates, not proven defects. Verify the relevant behavior. A sensitive change can be intentional. Record a reason when accepting or dismissing a finding; do not change code merely to lower a score.",
  );
  return lines.join("\n");
}
