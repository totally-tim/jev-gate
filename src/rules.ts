import { noul, score, type Question, type Questions } from "@typesafe-ai/sdk";
import { ConfigError } from "./config.js";
import type { ResolvedRule, RuleDecision, RuleDefinition } from "./types.js";

/**
 * The rule set is the product. Every rule is a single question scored as a "concern":
 * higher probability means the concern is more likely present. Gated rules fail the
 * check at or above their threshold; advisory rules report the same number without failing.
 *
 * Thresholds here are starting points from the calibration bench's findings, not truths.
 * Run `jev-gate calibrate` on your own diffs before trusting a threshold inside 0.2-0.8.
 */
export const RULE_DEFINITIONS: readonly RuleDefinition[] = [
  {
    name: "danger-sensitive-area",
    title: "Touches security-sensitive logic",
    kind: "noul",
    gate: true,
    threshold: 0.5,
    instructions:
      "This diff in `files` changes security-sensitive logic: authentication, authorization, session or token handling, payment flows, handling of personal data, or database migrations. A change is sensitive when a mistake could weaken a protection, leak data, or corrupt data, not merely when the file sits near such code. Tests and documentation alone are not sensitive.",
  },
  {
    name: "danger-deleted-tests",
    title: "Deletes or disables existing tests",
    kind: "noul",
    gate: true,
    threshold: 0.6,
    instructions:
      "This diff in `files` deletes, disables, or skips existing test cases instead of updating them together with the behavior they cover. Examples: removing a test file or a test body, adding skip or only markers, or weakening assertions so they always pass. Adding tests is not this.",
  },
  {
    name: "danger-secret-material",
    title: "Contains secret material",
    kind: "noul",
    gate: true,
    threshold: 0.6,
    instructions:
      "This diff in `files` contains secret material: credentials, API keys, tokens, private keys, or connection strings with embedded passwords, in source, configuration, fixtures, or examples. Placeholder values such as `example` or `<your-key>` are not secrets.",
  },
  {
    name: "breaking-change",
    title: "Changes behavior existing callers rely on",
    kind: "noul",
    gate: true,
    threshold: 0.6,
    instructions:
      "This diff in `files` changes existing behavior that callers or deployments depend on: API signatures, configuration keys, CLI flags, output formats, file formats, or defaults. Judge whether an existing user could break without an edit on their side, and whether the same diff provides a migration or compatibility path. Additive changes and purely internal refactors are not breaking.",
  },
  {
    name: "test-meaningfulness",
    title: "Tests are weak",
    kind: "score",
    gate: false,
    threshold: 0.7,
    instructions:
      "How weak are the tests that this diff adds or changes? Judge only tests present in the diff; absent tests are not this question. Level 0: tests pin specific observable behavior or outputs. Level 1: tests assert something, but several different behaviors would still pass them. Level 2: tests mostly assert that code runs, mirror the implementation, or snapshot without intent.",
    rubric: [
      "Tests assert specific observable behavior or outputs",
      "Tests assert something, but several different behaviors would still pass them",
      "Tests mostly assert that code runs, mirror the implementation, or snapshot without intent",
    ],
  },
  {
    name: "change-hygiene",
    title: "Bundles unrelated changes",
    kind: "score",
    gate: false,
    threshold: 0.6,
    instructions:
      "How much does the diff in `files` bundle unrelated changes or diverge from what `pr` describes? Level 0: one coherent change matching the description. Level 1: mostly one change with some unrelated edits mixed in. Level 2: unrelated changes bundled together, or the content does not match the description.",
    rubric: [
      "One coherent change that matches the description",
      "Mostly one change, with some unrelated edits mixed in",
      "Unrelated changes are bundled together, or the content does not match the description",
    ],
  },
  {
    name: "comment-drift",
    title: "Comments describe the old behavior",
    kind: "noul",
    gate: false,
    threshold: 0.6,
    instructions:
      "This diff in `files` changes behavior, interfaces, or configuration while leaving comments, docstrings, or documentation that the diff itself touches still describing the old behavior.",
  },
];

/** Build the named questions for the enabled rules. */
export function buildQuestions(rules: readonly ResolvedRule[]): Questions {
  const questions: Record<string, Question> = {};
  for (const rule of rules) {
    if (rule.kind === "noul") {
      questions[rule.name] = noul(rule.instructions);
    } else {
      if (!rule.rubric || rule.rubric.length < 2) {
        throw new ConfigError(`rule ${rule.name} is a score rule and needs at least two rubric levels`);
      }
      const rubric = rule.rubric as readonly [string, string, ...string[]];
      questions[rule.name] = score(rule.instructions, rubric);
    }
  }
  return questions;
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

/** Reduce Jev's answers to one decision per enabled rule. */
export function evaluate(rules: readonly ResolvedRule[], answers: Record<string, unknown>): RuleDecision[] {
  return rules.map((rule) => {
    const answer = answers[rule.name] as { type?: string; noul?: number; score?: number; confidence?: number } | undefined;
    if (!answer || typeof answer !== "object") {
      throw new Error(`Jev returned no answer for rule ${rule.name}`);
    }
    const base = {
      name: rule.name,
      title: rule.title,
      kind: rule.kind,
      gate: rule.gate,
      threshold: rule.threshold,
    };
    if (rule.kind === "noul") {
      if (typeof answer.noul !== "number" || !Number.isFinite(answer.noul)) {
        throw new Error(`answer for ${rule.name} is not a noul`);
      }
      const probability = clamp01(answer.noul);
      return { ...base, probability, exceeded: probability >= rule.threshold, failed: rule.gate && probability >= rule.threshold };
    }
    if (typeof answer.score !== "number" || !Number.isFinite(answer.score)) {
      throw new Error(`answer for ${rule.name} is not a score`);
    }
    const levels = rule.rubric?.length ?? 2;
    const probability = clamp01(answer.score / (levels - 1));
    return {
      ...base,
      probability,
      level: answer.score,
      levels,
      confidence: typeof answer.confidence === "number" ? answer.confidence : undefined,
      exceeded: probability >= rule.threshold,
      failed: rule.gate && probability >= rule.threshold,
    };
  });
}
