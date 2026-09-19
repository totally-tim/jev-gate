# jev-gate

A GitHub Action that reviews a pull request with [TypeSafe Jev](https://typesafe.ai). Jev
answers typed questions with calibrated probabilities instead of writing text; TypeSafe calls
this class of model System One. jev-gate asks the same seven questions about every diff: does
it touch security-sensitive logic, did it delete tests, does it contain secrets, does it break
existing callers, are the tests weak, are the changes mixed together, do the comments still
describe the code. It posts one sticky comment with the numbers.

Jev costs $0.042 per million input tokens and charges nothing for output tokens, so reviewing
a small diff costs about $0.00006. That is cheap enough to run on every push, and the gate
fails only on the rules you choose to gate.

## Quick start

1. Add a repository secret with your provider's API key: `TYPESAFE_API_KEY` for TypeSafe (a
   key from [console.typesafe.ai](https://console.typesafe.ai)) or `OPENROUTER_API_KEY` for
   [OpenRouter](https://openrouter.ai/typesafe/jev-1.13).
2. Copy [examples/caller.yml](examples/caller.yml) to `.github/workflows/jev-gate.yml`.
3. Optionally add a `.jev-gate.yml` to tune rules and thresholds (see below).

Until a `v1` tag exists, pin the action to a full commit SHA instead of `@v1`.

The first push to a pull request creates the sticky comment; later pushes update it in place
and show the delta against the previous run.

### Using OpenRouter

TypeSafe serves Jev directly, and OpenRouter serves the same model through its decisions
endpoint. Set the provider in the config file:

```yaml
provider: openrouter
model: typesafe/jev-1.13   # omit the model to follow ~typesafe/jev-latest
```

Then pass the OpenRouter key as the action input, or set `OPENROUTER_API_KEY` in the job
environment and leave the input empty:

```yaml
      - uses: timkraus/jev-gate@v1
        with:
          api-key: ${{ secrets.OPENROUTER_API_KEY }}
```

## What it checks

Every rule is phrased as a concern: a higher number means the concern is more likely present.
A Noul rule asks a yes/no question and returns the probability of yes. A Score rule grades
against an ordered rubric and returns a position between the levels. Gated rules fail the
check at or above their threshold; advisory rules report the same number and never fail it.

| Rule | Kind | Default | Threshold | The question it asks |
| --- | --- | --- | ---: | --- |
| `danger-sensitive-area` | Noul | gate | 0.60 | Does the diff change security-sensitive logic: authentication, authorization, sessions or tokens, payments, personal data, or migrations? |
| `danger-deleted-tests` | Noul | gate | 0.60 | Does the diff delete, disable, or weaken existing tests instead of updating them with the behavior they cover? |
| `danger-secret-material` | Noul | gate | 0.60 | Does the diff contain credentials, keys, tokens, or connection strings with embedded passwords? |
| `breaking-change` | Noul | gate | 0.60 | Does the diff change behavior callers or deployments depend on without a migration or compatibility path? |
| `test-meaningfulness` | Score | advisory | 0.70 | How weak are the tests this diff adds or changes? |
| `change-hygiene` | Score | advisory | 0.60 | How much does the diff bundle unrelated changes or diverge from the PR description? |
| `comment-drift` | Noul | advisory | 0.60 | Did the diff change behavior while leaving comments or docs it touches describing the old behavior? |

All seven questions go to Jev in a single request about the same state, so the fixed request
overhead is paid once instead of once per question. In our measurements that overhead is
about 300 input tokens per request.

A gated rule whose first answer lands within `borderlineMargin` (0.1 by default) of its
threshold gets one more ask, and the mean of the two decides. Near-threshold answers are
where run-to-run noise can flip a verdict, and the second request carries only the rules
that are close, so it costs nothing on the runs that are clearly clean or clearly blocked.
The comment shows both asks for any rule that was averaged.

The rule text lives in [`src/rules.ts`](src/rules.ts). The wording decides what the gate
notices, so review a rule edit the way you review a code change.

## The comment

The sticky comment holds a table with each rule's concern probability, its threshold, and
the delta against the previous run on the same pull request. When a gated rule reaches its
threshold the check fails and the comment names the rules.

For coding agents the comment also carries a hidden JSON block:

```
<!-- jev-gate:data
{"schema":1,"headSha":"...","decisions":[...]}
-->
```

An agent can read the pull request comments, parse that block, and act on the exact
probabilities, for example to resubmit after a fix and compare the two runs or to explain
which rule is blocking.

## Failing CI and branch protection

When a gated rule fails, the action exits non-zero, so the workflow run shows a red check.
A gated rule that cannot be graded (the model returned no usable answer) also fails the
check: the gate exists to answer that question, and a re-run usually clears a malformed
response. The action never fails for rules that are not gated, and it skips neutrally
(green with a warning annotation) when it cannot run at all. To require the check, mark the
`jev-gate` job as required in branch protection. Start advisory if you want to watch the
numbers for a few pull requests first.

## Fork pull requests

GitHub does not pass repository secrets to workflows triggered by pull requests from forks,
so under the `pull_request` event a fork PR is skipped with a warning. If you want fork PRs
reviewed, use the `pull_request_target` event and pin the action to a release or SHA. That
is safe with this action specifically: it never checks out or executes pull request code,
and it reads the config from the pull request's base commit, so a PR cannot change the rules
it is reviewed under.

```yaml
on: pull_request_target

jobs:
  jev-gate:
    runs-on: ubuntu-latest
    steps:
      - uses: timkraus/jev-gate@8f3c1d0  # pin a release commit
        with:
          api-key: ${{ secrets.TYPESAFE_API_KEY }}
```

## Configuration

The action reads `.jev-gate.yml` from the pull request's base commit. A missing file means
the defaults; a present but invalid file fails the check, because a config change that
silently stops working is worse than a red check.

```yaml
provider: typesafe   # or openrouter

model: jev-latest
maxStateTokens: 24000

ignore:
  - "**/node_modules/**"
  - "**/package-lock.json"
  - "**/*.min.js"
  - "**/dist/**"

comment: true

rules:
  danger-sensitive-area:
    threshold: 0.45
  test-meaningfulness:
    enabled: false
```

Every setting:

| Key | Default | Meaning |
| --- | --- | --- |
| `provider` | `typesafe` | `typesafe` or `openrouter`. |
| `model` | `jev-latest` (typesafe), `~typesafe/jev-latest` (openrouter) | Jev model name; OpenRouter uses its own slugs such as `typesafe/jev-1.13`. |
| `maxStateTokens` | `24000` | Budget for the serialized state; between 2000 and 30000. The API caps state plus the longest question near 32k tokens. |
| `borderlineMargin` | `0.1` | Distance from a gated rule's threshold inside which the rule is asked a second time and the mean decides; 0 disables the second ask, 0.3 is the maximum. |
| `ignore` | lockfiles, lockfile variants, `*.min.js`, `*.min.css`, `*.map`, `node_modules`, `dist` | Glob patterns for files excluded from the state. |
| `comment` | `true` | Post or update the sticky comment. |
| `rules.<name>.enabled` | `true` | Set `false` to drop the rule and its tokens. |
| `rules.<name>.gate` | rule default | Set `true` to make an advisory rule fail the check. |
| `rules.<name>.threshold` | rule default | Concern probability at which the rule fails (gated) or warns (advisory), 0..1. |
| `openrouter.referer` | none | Optional `HTTP-Referer` header, used only by OpenRouter. |
| `openrouter.title` | none | Optional `X-Title` header, used only by OpenRouter. |

Unknown keys, unknown rule names, and out-of-range values are config errors.

## Calibrating thresholds

The defaults are starting points from our calibration measurements: yes/no answers were well
calibrated near 0 and 1, and few answers landed between 0.2 and 0.8. They are not your
thresholds. Before trusting a gate, measure it on real diffs. From a checkout of this
repository:

```sh
npm ci && npm run build
export TYPESAFE_API_KEY=...

# Review the local change set against main: merge base, branch commits, uncommitted work
node dist/bundle/cli.cjs review --base main

# Run every rule over a directory of sampled diffs
node dist/bundle/cli.cjs calibrate --dir samples/
```

`calibrate` prints one concern probability per rule per sample so you can pick thresholds
that separate the diffs you would have blocked from the ones you would not. For OpenRouter,
set `OPENROUTER_API_KEY` and pass `--provider openrouter` to either command. `--repeat`
runs each sample several times to show run-to-run spread, and `--solo` asks one question per
request instead of the production batched request, so a comparison of the two JSON outputs
shows whether answers lean on each other. The repository ships a starter boundary suite in
[`samples/`](samples/README.md) with a known expected direction per file. Two practical
rules: keep gated thresholds outside the 0.2-0.8 band unless you have enough samples to
justify them, and re-measure after any rule wording change, because the wording moves the
boundary. Borderline gated answers are averaged over two asks, so the spread `--repeat`
prints after this change is the spread you actually get, not the raw one.

## Costs and limits

At $0.042 per million input tokens, a 6,000-token state costs about $0.00025, so roughly
forty reviews per cent. A state carries the PR title and description, file metadata, and
per-file patches capped at 8,000 characters each and 24,000 tokens total. When a diff is
larger, the action drops patches from the largest files first and says so in the comment.
Jev takes text only, so the action does not review binary files, images, or lockfiles.

## How it runs

The action talks to the GitHub REST API and the selected provider's decisions API directly
(`api.typesafe.ai` or `openrouter.ai`). It does not check out the repository, does not
execute pull request code, and reads rules from the PR's base commit. The only write it
performs is the sticky comment. The API key lives in your repository secrets and goes only
to the provider you selected.

## Run it locally

The same rules run on a local checkout, where the change set can include work that has not
been committed or pushed yet:

```sh
npm install -g github:totally-tim/jev-gate
export TYPESAFE_API_KEY=...

jev-gate diff --base main            # merge base + branch commits + uncommitted files
jev-gate review --base main          # review that change set, exits 1 on a failed gate
jev-gate review --diff - < x.diff    # review a diff from stdin
```

`review` without `--diff` builds the local change set itself: everything committed on the
branch since the merge base with the base ref, plus staged, unstaged, and untracked files,
as one diff. `--base` defaults to the repository's main branch (`origin/HEAD`, then
`origin/main`, `origin/master`, `main`, `master`). `--no-gate` keeps the exit code at 0 and
leaves the verdict to `--json` output. The tool's own `.jev-gate/` directory never enters
the diff.

A pre-push hook shows the gate before CI does, without blocking the push:

```sh
printf '#!/bin/sh\nev-gate review --base origin/main --no-gate\n' > .git/hooks/pre-push
chmod +x .git/hooks/pre-push
```

## OpenCode plugin

[`plugin/`](plugin/README.md) runs the same review inside an
[OpenCode](https://opencode.ai) session. It watches the working tree, reviews each new diff
once, and records the result in `.jev-gate/ledger.jsonl`. With `inject: true` it also hands
gated findings to the agent before its next model call, once per diff, so the agent can fix
a finding before it ever reaches a pull request. Ledger mode is the default; run it for a
while and read the ledger before turning injection on.

```sh
opencode plugin add 'github:totally-tim/jev-gate::path:plugin'
```

See the [plugin README](plugin/README.md) for options, the ledger format, and how the
briefing is phrased.

## Development

```sh
npm ci
npm run typecheck
npm test
```

`dist/` is committed because GitHub runs JavaScript actions without an install step; CI
fails if `dist/` is stale after a build. The CLI is bundled at `dist/bundle/cli.cjs`.
`npm test` also typechecks and tests the OpenCode plugin under `plugin/`.

## License

MIT
