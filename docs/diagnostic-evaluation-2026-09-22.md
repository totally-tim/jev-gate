# Compatibility diagnostic evaluation

The optional diagnostic stages completed against hosted Jev and local Kev on September 22,
2026. Hosted Jev remains the default. Kev missed five of seven labeled breaking changes
under the current screening policy, so this run does not support substituting it for Jev.

## Method

The [manifest](../samples/diagnostics.json) contains 12 hand-written cases: seven breaking
changes and five compatible changes. Four cases belong to the tuning split and eight to
the holdout split. Labels were written before either live run. No prompts or thresholds
were changed after inspecting the results. The table reports one run per case after
integration with the current local-model support on `main` and review fixes. Earlier
runs produced the same screening counts; Jev abstained on the configuration rename
in those runs but supported it in the final run.

The [runner](../scripts/evaluate-diagnostics.mjs) enables only `breaking-change`, with its
existing 0.6 threshold. It captures a real screening response and replays that response
into the diagnostic run. Measured replay counts must match the captured responses;
a request mismatch invalidates the run. This isolates the added stages from variation in screening.
Cases below the screening threshold also receive a separate diagnostic probe, so the
evaluation can observe false support and abstentions on negative cases.

Requests run serially with a 60-second timeout and no retries. Both providers use the
native TypeSafe contract through authenticated Gateway endpoints. Hosted requests use
the TypeSafe passthrough. Local requests use the Kev native route and request `local-decide`.
The runner checks model discovery before and after each evaluation.

## Results

| Measurement | Hosted Jev | Local Kev |
| --- | ---: | ---: |
| Requested model | `jev-1.13.0` | `local-decide` |
| Returned model | `jev-1.13.0` | `kev-latest` |
| Breaking changes detected | 7 / 7 | 2 / 7 |
| Compatible changes flagged | 0 / 5 | 0 / 5 |
| Screened breaking changes supported by follow-up | 7 / 7 | 1 / 2 |
| Missed breaking changes supported by separate probes | No missed cases | 0 / 5 |
| Compatible changes supported as defects by probes | 0 / 5 | 0 / 5 |
| Breaking changes rejected by diagnostics | 0 | 1 |
| Diagnostic abstentions across all cases | 2 | 10 |
| Correct mechanism among supported positives | 7 / 7 | 1 / 1 |
| Request failures or skipped diagnostics | 0 | 0 |
| Actual provider requests | 31 | 25 |
| Reported input tokens | 18,379 | 6,031 |
| Median request duration | 314 ms | 2,348 ms |
| Total evaluation duration | 10.60 seconds | 84.91 seconds |

On the eight holdout cases, Jev detected all five positives and flagged none of the three
negatives. Kev detected one positive, missed four, and flagged no negatives. Diagnostic
follow-up supported all five holdout positives for Jev and one for Kev.

Jev abstained on two compatible changes. Kev supported the
deleted public export, rejected the breaking change with a misleading reviewer comment,
and abstained on the other ten cases. The confidence threshold remained 0.55 for both
models; this run does not establish that threshold as calibrated for Kev.

All paired runs preserved the original screening observations and gate decisions, with
12 measured screening replays per model. Model
discovery stayed stable. Kev reported checkpoint
`jaredpalmer/kev-4b@485ace8703592fcf405488b262449990824cfed1`.

## Reproduction and limits

Build the project, set `TYPESAFE_API_KEY` to the authorized endpoint credential, and run:

```sh
EVAL_MODEL=jev-1.13.0 EVAL_ENDPOINT="$HOSTED_SYSTEMONE_URL" \
  node scripts/evaluate-diagnostics.mjs > /tmp/diagnostics-jev.json
EVAL_MODEL=local-decide EVAL_ENDPOINT="$LOCAL_SYSTEMONE_URL" \
  node scripts/evaluate-diagnostics.mjs > /tmp/diagnostics-kev.json
```

Use exact `systemone` URLs. The runner handles the SDK's `/v1` prefix, which otherwise
duplicates the version in some passthrough paths. It sends only these synthetic cases.
The reports include raw observations, model discovery, policy identities, timing, and
per-case gate comparisons. Runtime reports and credentials are not committed.

The measured manifest hash is
`162d568c44ab178929be6a3c5ee6385341077e281e3e0c63dd9330a8bcbc05f5`.
The diagnostic policy hash is
`e4cea7632c97423b5e1e71f219ef6795e751a12cfaa31d592776bc4841a3b5cb`.

This small synthetic suite measures neither production precision nor run-to-run variation.
Timings include network and provider queueing.
It contains one misleading-comment case and does not establish resistance to prompt
injection. Impact scores have no independent severity labels. Larger candidates, missing
context, and real multi-file migrations need further evaluation. The implementation tests
cover budget exhaustion, malformed answers, redaction, model changes, and runtime delivery.
Diagnostics remain optional and never dismiss findings or change gate decisions.
