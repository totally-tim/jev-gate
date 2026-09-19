import { createHash } from "node:crypto";
import { buildQuestions, evaluate } from "./rules.js";
import { buildState } from "./state.js";
import { costUSD, runJevReview } from "./jev.js";
/** Fingerprint the rule wording so field records survive rule edits. */
export function rulesHashFor(rules) {
    return createHash("sha256")
        .update(rules.map((rule) => `${rule.name}:${rule.instructions}`).join("\n"))
        .digest("hex")
        .slice(0, 12);
}
/** The deterministic core both entry points share: state in, calibrated decisions out. */
export async function runReview(input) {
    const enabled = input.config.rules.filter((rule) => rule.enabled);
    if (enabled.length === 0) {
        throw new Error("no rules are enabled; enable at least one rule in the config");
    }
    const { state, truncatedPaths } = buildState(input.pr, input.files, input.config);
    const baseRequest = {
        provider: input.config.provider,
        apiKey: input.apiKey,
        model: input.config.model,
        state,
        baseURL: input.baseURL,
        fetchImpl: input.fetchImpl,
        timeoutMs: input.timeoutMs,
        signal: input.signal,
        retry: input.retry,
        app: input.config.openrouter,
    };
    const response = await runJevReview({ ...baseRequest, questions: buildQuestions(enabled) });
    const decisions = evaluate(enabled, response.answers);
    let inputTokens = response.inputTokens;
    let outputTokens = response.outputTokens;
    let latencyMs = response.latencyMs;
    // A gated rule whose answer lands within the margin of its threshold would otherwise flip
    // between runs on noise alone, so it gets one more ask and the mean decides. The second
    // request is optional: when it fails, the first answer stands instead of failing the review.
    const borderline = borderlineRules(enabled, decisions, input.config.borderlineMargin);
    if (borderline.length > 0) {
        try {
            const second = await runJevReview({ ...baseRequest, questions: buildQuestions(borderline) });
            inputTokens += second.inputTokens;
            outputTokens += second.outputTokens;
            latencyMs += second.latencyMs;
            mergeSecondAsk(decisions, evaluate(borderline, second.answers));
        }
        catch {
            // Keep the first answers; a failed second ask must not fail an already-graded review.
        }
    }
    const failedGates = decisions.filter((decision) => decision.failed).map((decision) => decision.name);
    const erroredGates = decisions
        .filter((decision) => decision.gate && decision.error !== null)
        .map((decision) => decision.name);
    return {
        schema: 1,
        headSha: input.pr.headSha,
        baseSha: input.pr.baseSha,
        prNumber: input.pr.number,
        model: response.model,
        rulesHash: rulesHashFor(enabled),
        latencyMs,
        inputTokens,
        outputTokens,
        costUSD: costUSD(inputTokens),
        ranAt: new Date().toISOString(),
        truncated: state.truncated || truncatedPaths.length > 0,
        decisions,
        passed: failedGates.length === 0 && erroredGates.length === 0,
        failedGates,
        erroredGates,
    };
}
/** Gated rules whose answer sits within the margin of the threshold, in rule order. */
function borderlineRules(rules, decisions, margin) {
    if (margin <= 0)
        return [];
    const byName = new Map(decisions.map((decision) => [decision.name, decision]));
    return rules.filter((rule) => {
        const decision = byName.get(rule.name);
        return (rule.gate &&
            decision !== undefined &&
            decision.error === null &&
            decision.probability !== null &&
            Math.abs(decision.probability - rule.threshold) <= margin);
    });
}
/** Fold a second ask into the first decisions: the mean decides, and both asks stay visible. */
function mergeSecondAsk(decisions, second) {
    const byName = new Map(second.map((decision) => [decision.name, decision]));
    for (let index = 0; index < decisions.length; index += 1) {
        const decision = decisions[index];
        const again = byName.get(decision.name);
        if (again === undefined ||
            again.error !== null ||
            again.probability === null ||
            decision.probability === null) {
            continue;
        }
        const probability = (decision.probability + again.probability) / 2;
        decisions[index] = {
            ...decision,
            probability,
            samples: [decision.probability, again.probability],
            exceeded: probability >= decision.threshold,
            failed: decision.gate && probability >= decision.threshold,
        };
    }
}
