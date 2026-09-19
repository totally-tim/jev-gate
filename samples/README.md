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

## Growing the suite

The target is 10 to 15 samples per gated rule, then 100 to 150 real merged pull requests
plus 30 to 50 curated positives once labels exist. Add one concern per file, and keep each
sample small so it isolates the judgment it probes.
