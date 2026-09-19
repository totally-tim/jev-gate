# Rules

A rule is one question about the diff with a threshold. Rules live in
[`src/rules.ts`](../src/rules.ts) and the whole set is sent in one batched Jev request.

## The concern convention

Every rule is phrased so that a higher probability means a worse diff. A Noul rule returns
`P(yes)`; a Score rule returns an expected level which is normalized by dividing by the
highest level index, so a level-2 answer on a three-level rubric becomes 1.0. There is no
"goodness" polarity to remember: high is always the concern.

This convention lets the gate and the comment treat every rule identically:

- `probability >= threshold` and `gate: true` → the check fails.
- `probability >= threshold` and `gate: false` → the comment shows `warn`.
- otherwise the rule shows `ok`.

## Writing a rule

1. Write the instruction as a statement of the concern, with the boundary spelled out in
   both directions. `danger-sensitive-area` does this: "not merely when the file sits near
   such code" removes the most common false positive, and "tests and documentation alone
   are not sensitive" removes the second.
2. Prefer one narrow judgment over a broad one. The calibration bench found that a
   boundary-specific `not_for` clause moved errors from 24 to 6 on a 300-row task, but also
   moved 4 errors the other way; narrow wording sharpens, it does not remove.
3. Decide the kind. Noul when the answer is genuinely binary. Score when you want the
   model to express a degree, and write the rubric so every level is observable in the
   diff, not in the reviewer's taste.
4. Set a default threshold from data, not from intuition. See below.
5. Add the rule to `src/rules.ts`, run `npm test`, and use `jev-gate calibrate` before
   making it a gate.

## Thresholds

A threshold is a decision rule, so it inherits the cost of being wrong. Sensitive gates
should fail loudly and rarely: a false "contains secrets" verdict costs a look from a
human, a false negative costs a leaked key. Advisory rules can sit lower because a warning
does not block anything.

Practical calibration, from a checkout after `npm run build`:

```sh
# Sample 20-50 diffs that you would and would not have blocked, name them meaningfully.
node dist/bundle/cli.cjs calibrate --dir samples/ --json > calibration.json
```

Read the JSON as a table of per-rule probabilities, then pick the threshold where the two
groups separate. If they do not separate, tighten the rule wording before lowering the
value to make it look calibrated.

## What is verified and what is not

The calibration bench in the Jev playground measured Noul calibration on three tasks
(97.0%, 94.0%, and 84.3% accuracy, with ECE between 3.3% and 11.8% at n = 300) and found
that fewer than 15% of answers land between 0.2 and 0.8. Those numbers are for generic
judgments on public datasets, not for these review rules, and they are the vendor's model
trained for calibration, not a guarantee per question.

What that means here: treat a gated rule as a fast, consistent first pass that a human can
verify in thirty seconds, not as an authorization boundary. The gate fails the check, and a
maintainer overrides by merging anyway or by raising the threshold in the same PR that
provoked it.

## Roadmap

- Incremental review: send only the diff since the last reviewed SHA and accumulate
  findings in the sticky comment.
- Per-rule check runs so branch protection can require one rule and not another.
- Rule packs per ecosystem (for example migration safety for SQL repositories).
- Publish the CLI to npm so calibration runs without a checkout.
