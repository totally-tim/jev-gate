# JEV Gate for OpenCode

This adapter runs the JEV Gate CLI at agent context checkpoints and on a fallback timer.
Ledger mode is the default. With `inject: true`, the next model call receives current,
located findings and verification steps. Incomplete review is reported as incomplete.

Install the JEV Gate CLI from the same revision as this plugin. For development, point an
OpenCode package entry at this checkout's `plugin` directory:

```jsonc
{
  "plugins": [
    {
      "package": "/path/to/jev-gate/plugin",
      "options": {
        "cli": ["node", "/path/to/jev-gate/dist/bundle/cli.cjs"],
        "base": "origin/main",
        "inject": false
      }
    }
  ]
}
```

Keep the package outside `.opencode/plugins/` when explicitly configuring it, so automatic
and explicit discovery do not load two instances. This adapter uses OpenCode's session
context hook. It needs no runtime SDK dependency. The installed SDK checks its types during
development.

| Option | Default | Behavior |
| --- | --- | --- |
| `cli` | `jev-gate` | Executable, command string, or argv array. Prefer an array for paths with spaces. |
| `base` | CLI detection | Base branch for the local change snapshot. |
| `config` | Repository discovery | Explicit JEV configuration path. |
| `policySource` | `working` | `base` selects merge-base policy for comparison with CI. |
| `provider`, `model` | JEV configuration | Explicit overrides. |
| `apiKey` | Process environment | Passed under the provider selected by the snapshot. Prefer environment credentials. |
| `inject` | `false` | Deliver findings to agent context. |
| `intervalMs` | `120000` | Fallback poll period, 1000 to 86400000 ms. |
| `timeoutMs` | `120000` | Maximum time per CLI invocation, 1000 to 600000 ms. |
| `ledger` | `.jev-gate/ledger.jsonl` | Private assessment/delivery journal. |

Each snapshot captures code and effective policy before review. The adapter verifies that
the snapshot is still current after assessment and immediately before delivery. It discards
obsolete results. Agent calls are serialized through the monitor, and each session receives
a finding once while its identity remains unchanged.

The ledger stores assessments separately from delivery acknowledgments. Restart restores
undelivered findings. Unavailable or partial reviews retry after five minutes; a changed
snapshot can be reviewed immediately. Cleanup aborts owned child processes and prevents
late writes. The adapter restores the last 8 MiB of journal history; very old delivery
records outside that window may be repeated after a restart.

Add `.jev-gate/` to the project's `.gitignore`. A custom journal must be under `.jev-gate/`
or outside the project, and must be separate from the disposition ledger. Snapshot data contains source and stays in the local CLI pipes;
only the review engine submits redacted candidate state to the configured provider.

An injected finding is a request to verify behavior. A sensitive change can be correct.
Use the main CLI's `resolve` command to accept or dismiss a finding with a reason.

Run `npm run typecheck` and `npm test` at the repository root to check the adapter and
its lifecycle regressions.
