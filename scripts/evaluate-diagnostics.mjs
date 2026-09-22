// Run after npm run build. Only the checked-in synthetic cases are sent to the endpoint.
import { readFileSync } from "node:fs";
import { runReview, reviewExitCode } from "../dist/review.js";
import { diagnoseCompatibility, DIAGNOSTIC_POLICY } from "../dist/diagnostics.js";
import { resolveConfig } from "../dist/config.js";
import { RULE_DEFINITIONS } from "../dist/rules.js";
import { makeSnapshot, localContext, hash } from "../dist/snapshot.js";
import { candidatesFor, buildState } from "../dist/state.js";
import { runJevReview } from "../dist/jev.js";

const endpoint = process.env.EVAL_ENDPOINT;
const apiKey = process.env.TYPESAFE_API_KEY;
const model = process.env.EVAL_MODEL;
const repeat = Number(process.env.EVAL_REPEAT ?? 1);
const split = process.env.EVAL_SPLIT;
if (!endpoint || !apiKey || !model) throw new Error("Set EVAL_ENDPOINT (exact systemone URL), EVAL_MODEL, and TYPESAFE_API_KEY");
const url = new URL(endpoint);
if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash || !url.pathname.endsWith("/systemone")) throw new Error("EVAL_ENDPOINT must be an exact systemone HTTP(S) URL without credentials, query, or fragment");
if (!Number.isInteger(repeat) || repeat < 1 || repeat > 10) throw new Error("EVAL_REPEAT must be 1 to 10");
if (split && !["tune", "holdout"].includes(split)) throw new Error("EVAL_SPLIT must be tune or holdout");
const manifest = JSON.parse(readFileSync(new URL("../samples/diagnostics.json", import.meta.url), "utf8"));
const samples = manifest.samples.filter(sample => !split || sample.split === split);
if (!samples.length) throw new Error("No evaluation cases selected");
const discover = async () => {
  const response = await fetch(endpoint.replace(/\/systemone$/, "/models"), { headers: { Authorization: `Bearer ${apiKey}` }, signal: AbortSignal.timeout(60_000) });
  if (!response.ok) throw new Error(`Model discovery failed: HTTP ${response.status}`);
  return response.json();
};
const modelsBefore = await discover();
const records = [];
const actualModels = new Set();
const started = performance.now();
for (const sample of samples) for (let run = 0; run < repeat; run++) {
  console.error(`${model}: ${sample.id} (${run + 1}/${repeat})`);
  let requests = 0, inputTokens = 0, outputTokens = 0;
  const captured = new Map();
  const timings = [];
  const transport = async (requestUrl, init) => {
    // The SDK appends /v1/systemone. Exact-URL routing supports versioned passthroughs
    // without duplicating /v1 or sending credentials to a guessed host.
    if (new URL(String(requestUrl)).pathname !== "/v1/systemone" || init?.method !== "POST") throw new Error("Unexpected SDK operation");
    const body = String(init.body);
    const parsed = JSON.parse(body);
    const screening = Object.hasOwn(parsed.questions, "breaking-change");
    if (screening && captured.has(body)) return new Response(captured.get(body), { headers: { "content-type": "application/json" } });
    requests++;
    const begin = performance.now();
    const response = await fetch(endpoint, { ...init, redirect: "error" });
    const text = await response.text();
    timings.push(performance.now() - begin);
    if (response.ok) {
      const result = JSON.parse(text);
      actualModels.add(result.model);
      inputTokens += result.usage?.input_tokens ?? 0;
      outputTokens += result.usage?.output_tokens ?? 0;
      if (screening) captured.set(body, text);
    }
    return new Response(text, { status: response.status, headers: { "content-type": "application/json" } });
  };
  const file = { path: sample.path, status: "modified", additions: 1, deletions: 1, patch: sample.patch };
  const config = resolveConfig({ model, mode: "required", rules: Object.fromEntries(RULE_DEFINITIONS.map(rule => [rule.name, { enabled: rule.name === "breaking-change" }])) });
  const baselineSnapshot = makeSnapshot(localContext([file], { title: "Evaluation change" }), [file], config, "diagnostic-evaluation");
  const request = { apiKey, baseURL: url.origin, fetchImpl: transport, timeoutMs: 60_000, retry: { maxRetries: 0 } };
  const baseline = await runReview({ ...request, snapshot: baselineSnapshot });
  const diagnosticSnapshot = makeSnapshot(baselineSnapshot.pr, [file], { ...config, diagnostics: { enabled: true, maxRequests: 16 } }, "diagnostic-evaluation");
  const enriched = await runReview({ ...request, snapshot: diagnosticSnapshot });
  let diagnostic = enriched.findings.find(f => f.rule === "breaking-change")?.diagnostic;
  // Probe baseline negatives too, so an early screening rejection cannot hide follow-up errors.
  if (!diagnostic && baseline.health === "complete") {
    const candidate = candidatesFor(file, 12_000)[0];
    diagnostic = await diagnoseCompatibility(candidate, buildState(baselineSnapshot.pr, candidate, [file]), async (state, questions) => {
      const response = await runJevReview({ ...request, provider: "typesafe", model, state, questions });
      if (response.model !== baseline.model) throw new Error("Model changed during diagnostic probe");
      return response.answers;
    });
  }
  const invariants = hash(baseline.decisions) === hash(enriched.decisions) && reviewExitCode(baseline) === reviewExitCode(enriched) && hash(baseline.failedGates) === hash(enriched.failedGates);
  records.push({ sample: sample.id, split: sample.split, sampleHash: hash(sample), run, expected: sample.expected,
    screeningReplayed: true, invariants, contentHash: baselineSnapshot.contentHash, baselinePolicy: baselineSnapshot.policyHash, diagnosticPolicy: diagnosticSnapshot.policyHash,
    screening: baseline.decisions, baselineHealth: baseline.health, diagnostic, errors: [...baseline.errors, ...enriched.errors],
    gateBefore: reviewExitCode(baseline), gateAfter: reviewExitCode(enriched), requests, inputTokens, outputTokens, requestMs: timings });
}
const modelsAfter = await discover();
const modelStable = hash(modelsBefore) === hash(modelsAfter) && actualModels.size === 1;
const summarize = rows => {
  const screening = { tp: 0, fp: 0, tn: 0, fn: 0, unavailable: 0 };
  const diagnostics = { supportedPositive: 0, supportedNegative: 0, rejectedPositive: 0, rejectedNegative: 0, abstained: 0, unavailable: 0, mechanismCorrect: 0, mechanismAssessed: 0 };
  for (const row of rows) {
    const positive = row.expected.issue;
    if (row.baselineHealth !== "complete") screening.unavailable++;
    else screening[row.screening.some(d => d.exceeded) ? positive ? "tp" : "fp" : positive ? "fn" : "tn"]++;
    const d = row.diagnostic;
    if (!d || ["unavailable", "skipped"].includes(d.status)) diagnostics.unavailable++;
    else if (d.status === "insufficient-context") diagnostics.abstained++;
    else if (d.status === "supported") {
      diagnostics[positive ? "supportedPositive" : "supportedNegative"]++;
      if (row.expected.mechanism) {
        diagnostics.mechanismAssessed++;
        if (d.mechanism?.choice === row.expected.mechanism) diagnostics.mechanismCorrect++;
      }
    } else diagnostics[positive ? "rejectedPositive" : "rejectedNegative"]++;
  }
  return { cases: rows.length, screening, diagnostics };
};
const valid = modelStable && records.every(row => row.invariants && row.baselineHealth === "complete" && row.diagnostic && !["unavailable", "skipped"].includes(row.diagnostic.status));
console.log(JSON.stringify({ schema: 1, ranAt: new Date().toISOString(), requestedModel: model, resolvedModels: [...actualModels], endpoint, modelsBefore, modelsAfter, modelStable,
  manifestHash: hash(manifest), diagnosticPolicyHash: hash(DIAGNOSTIC_POLICY), repeat, valid,
  summary: summarize(records), holdout: summarize(records.filter(row => row.split === "holdout")),
  elapsedMs: performance.now() - started, totalRequests: records.reduce((sum, row) => sum + row.requests, 0), inputTokens: records.reduce((sum, row) => sum + row.inputTokens, 0), outputTokens: records.reduce((sum, row) => sum + row.outputTokens, 0), records }, null, 2));
process.exitCode = valid ? 0 : 2;
