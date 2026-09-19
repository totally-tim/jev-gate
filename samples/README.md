# Boundary suite

Hand-built diffs with a known expected direction, used to pick thresholds and keep them
honest. They are engineered to sit near the decision boundary, because natural pull requests
are mostly clean and random sampling never populates the band where a threshold actually
decides.

Each `.diff` is a unified diff that `calibrate` reads directly. The expected direction below
is for the person picking thresholds; the CLI does not enforce it.

| Sample | Expected | Rule it probes |
| --- | --- | --- |
| `sensitive-area/noop-auth-refactor.diff` | below | danger-sensitive-area |
| `sensitive-area/session-ttl.diff` | above | danger-sensitive-area |
| `sensitive-area/md5-swap.diff` | above | danger-sensitive-area |
| `sensitive-area/comment-only.diff` | below | danger-sensitive-area |
| `deleted-tests/delete-with-feature.diff` | below | danger-deleted-tests |
| `deleted-tests/delete-test-only.diff` | above | danger-deleted-tests |
| `deleted-tests/skip-marker.diff` | above | danger-deleted-tests |
| `deleted-tests/weaken-assertion.diff` | above | danger-deleted-tests |
| `secret-material/fixture-key.diff` | above | danger-secret-material |
| `secret-material/placeholder.diff` | below | danger-secret-material |
| `secret-material/public-key.diff` | below | danger-secret-material |
| `secret-material/connection-string.diff` | above | danger-secret-material |
| `breaking-change/rename-no-shim.diff` | above | breaking-change |
| `breaking-change/deprecation-shim.diff` | below | breaking-change |
| `breaking-change/default-change.diff` | above | breaking-change |
| `breaking-change/add-optional.diff` | below | breaking-change |
| `controls/clean-format-helper.diff` | all below | all gates |
| `controls/danger-kitchen-sink.diff` | all above | all gates |

## Running the suite

From a checkout, after `npm run build` and with one provider key set:

```sh
# Batched, five runs per sample, to see run-to-run spread
node dist/bundle/cli.cjs calibrate --dir samples --repeat 5

# One question per request, to check whether answers lean on each other
node dist/bundle/cli.cjs calibrate --dir samples --solo --json > /tmp/solo.json
node dist/bundle/cli.cjs calibrate --dir samples --json > /tmp/batched.json
```

Each JSON record carries `rulesHash`, the fingerprint of the enabled rule wording. A record
is comparable only to runs with the same hash. Re-run the suite after every rule wording
change and compare probabilities; a move of more than 10 points on a fixed sample means the
wording moved the boundary.

## First measurements, 2026-09-19, jev-1.13.0, rules `f916bd551e8d`

- Five runs per sample, batched: the largest run-to-run spread on any rule was 10 points
  (`breaking-change` on `sensitive-area/md5-swap.diff`); most rules stayed under 6 points.
- Designed positives cleared their gates at 92 to 99 percent. Designed negatives stayed
  below, with one exception worth watching: `sensitive-area/noop-auth-refactor.diff` scored
  47.6 against the 50 percent gate, so a no-op rename in an auth file sits close to the line.
- Other near-threshold cases: `sensitive-area/session-ttl.diff` at 61.4 for
  `breaking-change` against 60, and `deleted-tests/delete-with-feature.diff` at 54.6 for
  `breaking-change`, below but close.
- `test-meaningfulness` scored 79 to 85 on diffs that change no tests, although its
  instruction says level 0 when no tests are added or changed. The rule is advisory, and the
  wording is not being followed on these samples.
- Solo versus batched across 126 rule-sample pairs: one pair differed by 5 points
  (`danger-deleted-tests` on the kitchen-sink control) and the rest by less. No batch effect
  was detectable at this resolution.

## Second measurements, 2026-09-19, jev-1.13.0, rules `ecc13761bf17`

Recorded after acting on the first review: `danger-sensitive-area` moved to a 0.60 gate,
`test-meaningfulness` was reworded around its no-tests clause, and gated rules answering
within `borderlineMargin` of the threshold are now asked twice and averaged.

- `test-meaningfulness` on diffs that change no tests fell from 79 to 85 percent to 3 to 47
  percent, all below its 0.70 advisory threshold; the no-tests clause now holds. Diffs that
  change tests still separate: `weaken-assertion` 96.5, `delete-test-only` 75.5,
  `delete-with-feature` 25.3.
- `sensitive-area/noop-auth-refactor.diff` scored 47.5 on `danger-sensitive-area`, now 12.5
  points below the 0.60 gate instead of a near miss at the old 0.50. Designed positives
  scored 89 to 98 on the rules they probe.
- `sensitive-area/session-ttl.diff` still crosses `breaking-change` (61.5 against 60), and
  `sensitive-area/md5-swap.diff` scores 70.0 there; both were called out in the first
  measurements and remain the cases to watch.
- Two runs per sample: the largest run-to-run spread was 6.5 points (`test-meaningfulness` on
  `md5-swap`), the rest at or under 6 points. Part of that drop against the first run's 10
  points is the averaging: borderline gated answers are already averaged before a run is
  recorded.
- Observation outside the labeled axes: `secret-material/public-key.diff` scores 93.5 on
  `danger-sensitive-area` because it adds a PEM public-key constant to an auth file. The
  suite labels it only for `danger-secret-material`, where it scores 7.5, below. Treat it as
  a candidate false positive for the sensitive-area wording, not a passing case.

Postscript: `secret-material/fixture-key.diff` and `controls/danger-kitchen-sink.diff`
originally carried Stripe-shaped `sk_live_` values, which GitHub push protection rejects
even in a fixture. Both now use `acme_live_` strings. Re-measured over three runs at rules
`ecc13761bf17`: `fixture-key.diff` scores 88.3 on `danger-secret-material` and
`danger-kitchen-sink.diff` scores 96.7 there, so the fixtures still separate above the gate.

## Growing the suite

The target is 10 to 15 samples per gated rule, then 100 to 150 real merged pull requests
plus 30 to 50 curated positives once labels exist. Add one concern per file, and keep each
sample small so it isolates the judgment it probes.
