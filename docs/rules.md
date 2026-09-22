# Review rules

Each rule asks a narrow question about a candidate diff. The engine supplies related
implementation/test changes when available. The model treats PR descriptions, comments,
and source strings as data. Adversarial content still needs evaluation; typed answers do
not guarantee correct judgments.

A Noul answer is a binary probability. A Score answer is an expected rubric level. The
engine normalizes scores only for threshold comparisons and retains their original units
for display. Missing, out-of-range, or incorrectly typed answers make coverage incomplete.

`danger-sensitive-area` requests focused review and is not a default blocking gate.
`test-meaningfulness` is experimental and disabled because live evaluation produced
false positives on setup helpers. Opt-in scoring is restricted to recognized test-code paths.
`change-hygiene` is experimental and disabled because candidate-level review cannot establish
whole-change coherence. The default mode is advisory. Required mode applies enabled gates
and rejects incomplete review.

To change a rule:

1. Define an observable concern, its exclusions, and a useful verification step.
2. Add tuning cases with labels in `samples/labels.json`.
3. Run local checks and evaluate the tuning split with a pinned model.
4. Evaluate untouched holdout cases. Retain raw results and inspect false positives and misses.
5. Update documentation and the model/rule identity used in any deployment.

The rule fingerprint includes names, question kinds, instructions, and rubric criteria.
Policy identity also includes thresholds, gates, model, provider, and input-building version.
Old schema 1 comments and ledgers are not reused as schema 2 assessments.

Optional repeated observations retain both values. Their mean is a threshold input; repeated
answers from the same model do not supply independent verification. Errors in either
observation remain visible.

Optional compatibility diagnostics retain the original screening finding and its gate.
They select a source region, classify a mechanism, and estimate impact. The diagnostic
policy fingerprint includes the questions, criteria, confidence threshold, and region
limits. A diagnostic disagreement is evidence for investigation, not a disposition.
Missing context, skipped work, and provider failures have separate statuses. Evaluate
both supported positives and rejected positives before changing any gate policy.

Local acceptance records belong to the exact finding identity. GitHub loads configuration
from the PR base commit. A policy edit inside a PR cannot override that PR's review. Use the
repository's existing merge-approval process for an authorized exception.

Before adding rule packs or incremental-only review, verify finding precision, review
coverage, recipient delivery, and resolution behavior on real changes. An assessment cache
must include relevant content, policy, context, and model identity.
