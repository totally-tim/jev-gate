# jev-gate for OpenCode

An OpenCode plugin that runs [jev-gate](../README.md) on the local change set while you
work. It watches the working tree, reviews each new diff once, records every review in a
ledger, and, when you turn it on, hands gated findings to the agent before its next model
call.

Ledger mode is the default. Injection is opt-in because the review has to earn trust on your
diffs first: run it for a while, read the ledger, and turn `inject` on when the findings look
like ones you would have wanted to see.

## Requirements

- The `jev-gate` CLI on the PATH of the process that runs OpenCode, or a `cli` option that
  points at it:
  ```sh
  npm install -g github:totally-tim/jev-gate
  ```
- A provider key visible to the OpenCode server: `TYPESAFE_API_KEY` (default) or
  `OPENROUTER_API_KEY` with `provider: openrouter`, or an `apiKey` option.

## Install

Recommended, as a package in the global config:

```sh
opencode plugin add 'github:totally-tim/jev-gate::path:plugin'
```

Then add options to the entry in your `opencode.json(c)`:

```jsonc
{
  "plugins": [
    {
      "package": "jev-gate-opencode",
      "options": {
        "base": "origin/main",
        "intervalMs": 120000,
        "inject": false
      }
    }
  ]
}
```

For development against a checkout, keep the package outside `.opencode/plugins/` and point
the config at it. A package under `.opencode/plugins/` is also discovered automatically, but
then it sees no options, and referencing the same directory both ways loads it twice:

```jsonc
{
  "plugins": [
    {
      "package": "../tools/jev-gate-plugin",
      "options": { "cli": "node /repos/jev-gate/dist/bundle/cli.cjs" }
    }
  ]
}
```

The package imports `@opencode/plugin` from the runtime, so that package must be resolvable
wherever the plugin is installed. `opencode plugin add` installs the dependency for you; a
copied directory needs the project's `node_modules` to provide it.

## Options

| Option | Default | Meaning |
| --- | --- | --- |
| `base` | detected | Base ref for `jev-gate diff`; the CLI tries `origin/HEAD`, `origin/main`, `origin/master`, `main`, `master`. |
| `cli` | `jev-gate` | Executable for the CLI, optionally with arguments (`"node /path/to/dist/bundle/cli.cjs"`). Split on whitespace. |
| `intervalMs` | `120000` | Poll interval, 1000 to 86400000. Every tick asks git for the current diff; nothing runs while the diff hash is unchanged. |
| `inject` | `false` | `true` also briefs the agent before its next model call. |
| `ledger` | `.jev-gate/ledger.jsonl` | Ledger path, relative to the plugin's working directory or absolute. |
| `provider` | config file | `typesafe` or `openrouter`, passed to the CLI. |
| `model` | provider default | Jev model name, passed to the CLI. |
| `apiKey` | environment | Passed to the child process under the provider's key variable. Prefer the environment; a config file is easy to commit by accident. |
| `timeoutMs` | `60000` | Per-invocation timeout for the CLI. |

## The ledger

One JSON line per review in `.jev-gate/ledger.jsonl`, under the project directory:

```json
{"ranAt":"...","diffHash":"1e1f0d22ce40","model":"jev-1.13.0","rulesHash":"ecc13761bf17",
 "failedGates":["danger-sensitive-area"],"erroredGates":[],
 "decisions":[{"name":"danger-sensitive-area","probability":0.96,"threshold":0.6,"failed":true}],
 "inputTokens":17042,"costUSD":0.0007,"injected":true}
```

A delivery record (`{"diffHash":"...","delivered":true,"agent":"build","messages":4}`) is
written when the briefing reaches a model call. The plugin reads the last record on startup,
so an unchanged diff is not reviewed again just because a session restarted. Add
`.jev-gate/` to your `.gitignore`.

The ledger is the raw material for tuning the plugin: the review-to-review churn it records
is what tells you whether injection should stay on, and how large `intervalMs` should be.
The diff hash covers the merge-base change set and uncommitted files, including untracked
ones, but never the `.jev-gate/` directory itself, so the ledger cannot trigger its own
reviews.

## What the agent sees

With `inject: true`, the next agent-loop model call carries one system block per reviewed
diff:

```
jev-gate reviewed the local change set (diff 1e1f0d22ce40) and one gated rule is at or above its threshold:
- danger-sensitive-area: 96% concern against a 60% threshold.
Treat this as a prompt to check the change, not as a verdict: jev-gate judges the whole diff,
not specific lines, and its numbers can be wrong. If the finding is real, fix it; if it is
not, say why. Do not edit code just to move the number.
```

Only gated rules are injected, and each finding is delivered once per diff hash. Advisory
scores stay in the ledger. A briefing reaches the next agent-loop call, not title generation
or other auxiliary requests.

## Development

From the repository root, `npm run typecheck` and `npm test` cover the plugin as well as the
CLI. A manual run against a scratch repository:

```sh
mkdir -p /tmp/demo && cd /tmp/demo && git init -b main
echo "export const x = 1;" > app.ts && git add -A && git commit -m init
git checkout -b feature && echo "export const x = 2;" > app.ts
mkdir -p .opencode/plugins && cp -R /repos/jev-gate/plugin .opencode/plugins/jev-gate
npm install -D @opencode/plugin
opencode run --standalone --print-logs "say ok"
cat .jev-gate/ledger.jsonl
```
