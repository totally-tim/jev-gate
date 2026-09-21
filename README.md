# JEV Gate

JEV Gate is a review companion for GitHub and coding agents. It identifies changes that
deserve another look and supplies their locations and verification steps. Each result
records the exact input, effective policy, and review coverage.

Sensitive changes request review by default. A finding is a candidate for verification;
it is not proof of a defect. Required blocking is an explicit repository policy.

## Local use

Build this checkout with Node 26 and npm 12. The bundled CLI runs on Node 20 or later:

```sh
npm ci
npm run build
export TYPESAFE_API_KEY=...
node dist/bundle/cli.cjs review --base main
node dist/bundle/cli.cjs review --base main --json
```

To install the built CLI, run `npm install -g .`. The bundled executable also works
without installing dependencies in the repository being reviewed:

```sh
cd /path/to/your/project
node /path/to/jev-gate/dist/bundle/cli.cjs review --base origin/main --json
```

The CLI discovers `.jev-gate.yml` at the Git repository root, including when called from a
subdirectory. It includes branch commits, staged and unstaged edits, and untracked files.
The `.jev-gate/` metadata directory is excluded. Keep it in your project's `.gitignore`.
Collection limits and unavailable binary patches appear as coverage gaps.

```sh
jev-gate review --diff change.diff --json
jev-gate review --diff - --json < change.diff
jev-gate snapshot --base main --json > /tmp/review-snapshot.json
jev-gate review --snapshot /tmp/review-snapshot.json --json
jev-gate review --base main --policy-source base --json
```

Snapshots contain source code and effective configuration. Store them privately. Snapshot
review validates the captured identity against the installed rules and local dispositions. Base policy reads the
configuration at the merge-base commit. Local authoring uses working-tree policy by default;
GitHub uses the PR base commit. The result names the policy source so this difference is visible.

Exit codes:

| Code | Meaning |
| --- | --- |
| 0 | Complete advisory review, or a complete required review with no blocking findings. |
| 1 | An open finding exceeds an enabled gate in required mode. |
| 2 | Incomplete or unavailable review, or invalid input/configuration. |

`--no-gate` suppresses exit 1 only. It does not hide review errors. Empty reviews still return
JSON. A complete review can have findings; read `status` as well as `health`.

## GitHub

Copy [examples/caller.yml](examples/caller.yml), replace its commit placeholder with a
reviewed release commit, and add `TYPESAFE_API_KEY` as a repository secret. Version 0.2 uses
the schema described here; pin a commit containing this implementation rather than assuming
an older moving tag has it.

The Action reads PR data through GitHub's API. It does not check out or execute PR code.
Configuration comes from the base commit. It verifies base and head revisions after collection
and before publication, and updates only the expected GitHub Actions bot's sticky comment.
When GitHub omits or truncates a patch, the Action reads the file at the PR head
and merge base and reconstructs the diff with Git. It does not check out PR code.
Recovery attempts at most 100 files, reads at most 2 MiB per file and 16 MiB of
file content in total, and starts no more reads after two minutes. Each request
also has a timeout. A pinned Git tree verifies that each path is a regular file;
symlinks and submodules are not followed. Tree metadata is capped at 8 MiB per
revision. Ignored current and previous paths are not fetched for recovery.
Binary files, unsupported metadata-only
changes, unavailable content, and exceeded limits remain explicit coverage gaps.
The runner must have Git installed.

The caller workflow cancels superseded runs. GitHub comments do not provide an atomic
compare-and-update operation, so the revision in each result remains the authority.

For manual reruns, add a `workflow_dispatch` PR-number input to the caller and pass
it to the Action as `pull-request`. The Action validates that the PR is open and
reads its current revision. Do not override GitHub's reserved event variables.

Fork PRs do not receive provider secrets under `pull_request`. Their review will report
unavailable. To review forks, use `pull_request_target`, pin the Action to a reviewed commit,
and retain this workflow's API-only design. Never add execution of fork code to that job.

The comment groups findings into review topics. Expand a row to see what to verify,
the evidence, and links to every location. Small gauges show the peak model estimate
beside its configured review threshold. Percentages answer a review question; they
are not calibrated defect probabilities. Credential pattern matches show counts.
The file map, coverage notes, and run metadata expand below the table. A review with
no findings stays short. The full workflow report includes every model observation.

The gauges use generic SVGs shipped in `assets/review/v1`, served from this project's
public repository. Image URLs contain only a color and an integer from 0 to 100;
no source paths, credentials, or review text are sent to an image service. Alt text
preserves the estimate when images are unavailable. Regenerate the artwork with
`node scripts/review-assets.mjs`; use a new version directory to change published art.

Oversized reports go to the workflow summary and `result` output.
Outputs include `health`, `status`, `passed`, `failed-gates`, and the complete JSON `result`.
The `result-path` output points to the same JSON under `RUNNER_TEMP`. Upload that
file as a workflow artifact to preserve large assessments without putting
report contents into a shell command or environment variable.
`passed` is `unavailable` when review did not complete. Provider failures exit nonzero and
update the comment when the PR revision remains current.

## Policy

```yaml
provider: typesafe
model: jev-1.13.0
mode: advisory
maxStateTokens: 24000
maxRequests: 64
borderlineMargin: 0
comment: true
rules:
  danger-sensitive-area:
    gate: false
  breaking-change:
    threshold: 0.8
```

| Setting | Default | Behavior |
| --- | --- | --- |
| `provider` | `typesafe` | `typesafe` or `openrouter`. |
| `model` | `jev-1.13.0` | OpenRouter defaults to `typesafe/jev-1.13-20260917`. Defaults are pinned. |
| `mode` | `advisory` | `required` enables configured blocking gates. Both modes report review errors. |
| `maxStateTokens` | `24000` | Conservative UTF-8 byte bound on state, 2000 to 30000. |
| `maxRequests` | `64` | Maximum logical provider calls per review, 1 to 500, including optional second observations. Provider retries can add network attempts. |
| `borderlineMargin` | `0` | Optional second observation for gated results near a threshold; 0 to 0.3. This is not independent corroboration. |
| `ignore` | Generated files, dependencies, and lockfiles | Glob list replacing the defaults. Exclusions appear in coverage. |
| `comment` | `true` | Publish the GitHub comment. |
| `rules.<name>.enabled` | Rule default | Include the rule. |
| `rules.<name>.gate` | Rule default | Make open findings block in required mode. |
| `rules.<name>.threshold` | Rule default | Normalized observation threshold between 0 and 1. |
| `openrouter.referer`, `openrouter.title` | None | Optional provider attribution headers. |

OpenRouter reads `OPENROUTER_API_KEY`. Set `provider: openrouter` or use `--provider openrouter`.
The Action also accepts `provider`, `model`, `mode`, `config-path`, `max-state-tokens`, `max-requests`,
`timeout-ms`, `api-key`, `github-token`, and `comment` inputs. Unknown configuration keys and
invalid CLI flags fail explicitly.

## Findings and coverage

| Rule | Observation | Gate eligible by default |
| --- | --- | --- |
| `danger-sensitive-area` | A security or data invariant deserves focused review. | No |
| `danger-deleted-tests` | Existing test coverage may have been removed or weakened. | Yes |
| `danger-secret-material` | Added content may contain credentials. | Yes |
| `breaking-change` | A public contract may require migration or compatibility work. | Yes |
| `test-meaningfulness` | Experimental test-quality rating, disabled by default. | No |
| `comment-drift` | Touched comments may describe old behavior. | No |
| `change-hygiene` | Experimental coherence rating, disabled by default. | No |

The engine splits textual patches into bounded candidates and reviews every candidate that
fits the configured budgets. Related implementation/test changes supply limited context.
Later sections also receive up to 1,000 characters from the same file's diff opening, when the state
budget permits. This keeps document purpose and module context visible after
splitting; the opening is background, not an additional finding location.
Locations identify the reviewed candidate, not an exact causal line. Missing callers and
contracts still require a human or a reasoning model to investigate.

Coverage distinguishes reviewed, excluded, partial, and unavailable files. A giant single
line, missing patch, exhausted budget, or missing answer cannot silently count as reviewed.
Binary probabilities and rubric scores retain distinct display units.

Test-quality scoring is opt-in because live evaluation produced false positives on setup
helpers. When enabled, it applies only to recognized test-code paths. Documentation and
production files that mention assertions do not make it applicable.

Before provider calls, a local detector redacts recognized credentials and private keys.
Added matches produce located findings without revealing values. This is a limited pattern
detector; it does not guarantee that all secrets or personal data are removed. Use `ignore`
for content that must not leave the repository. Review state goes to the chosen TypeSafe or
OpenRouter endpoint, including PR descriptions and candidate source code after redaction.

Schema 2 JSON contains snapshot and policy identities, resolved model, rule fingerprint,
coverage, raw observations, and findings. Findings have stable identities tied to their
candidate content and policy. Accept or dismiss a finding locally with a reason:

```sh
jev-gate resolve FINDING_ID --status accepted --reason 'Callers migrate in this release'
```

Dispositions live in `.jev-gate/dispositions.jsonl`. They do not silently change repository
policy or authorize a GitHub merge. A changed candidate or policy creates a new identity.
Recording a disposition invalidates cached assessments. Collect a fresh snapshot after changing one.
GitHub enforcement overrides follow repository branch-protection rules. Editing policy in
the PR does not change the policy used to review that same PR.

## Coding agents

Any agent host can call `jev-gate review --json` after an edit batch or completed tests.
Read `health` before treating results as complete, then inspect each open finding's location
and `verification`. Record a disposition when a finding is intentional. Avoid editing code
merely to change a model's score.

The [OpenCode adapter](plugin/README.md) calls this same CLI contract. It restores undelivered
assessments, retries unavailable reviews, checks freshness before injection, and tracks
recipient sessions. It requires no runtime dependency beyond the host and the installed CLI.

## Evaluation

```sh
jev-gate calibrate --dir samples --split tune --json > /tmp/tune.json
jev-gate calibrate --dir samples --split holdout --json > /tmp/holdout.json
```

The [label manifest](samples/labels.json) records expected directions and separates previously
tuned examples from new holdout examples. Each run records content, policy, rule, and model
identity plus observations and per-rule precision/recall. Unavailable answers make evaluation
invalid and exit 2. `--repeat` measures variation; `--solo` evaluates rules independently.
Unlabeled axes do not enter metrics. The small synthetic suite does not establish real-world
accuracy. Preserve independent data when using results to change rules.

## Development

```sh
npm ci
npm run typecheck
npm test
```

Tests include bundled CLI/Action execution and agent-delivery lifecycle checks. `dist/` is
committed for GitHub Actions. Rebuild it with changes. The OpenCode contract is checked at
build time; its runtime adapter imports no OpenCode SDK. JavaScript dependencies must be at
least 48 hours old; `.npmrc` enforces this with npm 12.

MIT licensed.
