# pi-cmux

<img width="1335" height="758" alt="Screenshot 2026-05-27 at 12 05 46" src="https://github.com/user-attachments/assets/27806213-60f9-4c30-84d4-4a331ea1484b" />

[![CI](https://github.com/javiermolinar/pi-cmux/actions/workflows/ci.yml/badge.svg)](https://github.com/javiermolinar/pi-cmux/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/pi-cmux.svg)](https://www.npmjs.com/package/pi-cmux)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](https://opensource.org/licenses/MIT)

Pi package with [cmux](https://www.cmux.dev)-powered terminal integrations for [Pi](https://pi.dev).

## What it adds

`pi-cmux` keeps Pi terminal-native by delegating notifications, sidebar status, pane splits, tab naming, pluggable tool commands, directory jumps, review handoff, and continuation workflows to cmux.

## Install

Requires Pi **0.85.1 or newer** and Node.js **22.19.0 or newer**. The `pi` executable on your `PATH` must also meet this requirement. Update Pi if needed:

```bash
npm install -g --ignore-scripts @earendil-works/pi-coding-agent@latest
```

Then install the package:

```bash
pi install npm:pi-cmux
```

Or install/update with the package installer:

```bash
npx pi-cmux
```

If Pi is already running:

```text
/reload
```

## Commands

| Workflow | Commands | Summary |
|---|---|---|
| Notifications | automatic | Sends `cmux notify` once Pi settles after retries, compaction, and queued follow-ups. |
| Sidebar status/log | automatic | Updates cmux status, progress, and logs while Pi runs, then flashes once Pi settles. |
| Split Pi | `/cmv [prompt]`, `/cmh [prompt]` | Opens a new right/lower split with Pi in the same project. |
| Run a tool | `/cmo <cmd>`, `/cmoh <cmd>`, `/cmt <cmd>` | Opens a split or tab and runs a shell command in the same project. |
| Pluggable tools | custom `/<name>` | Registers cmux split shortcuts from `pi-cmux.commands` settings. |
| Jump directory | `/cmz <query>`, `/cmzh <query>` | Resolves a zoxide match or path, then opens Pi there. |
| Continue task | `/cmcv [note]`, `/cmch [note]` | Opens a related handoff session in a split. |
| Continue in worktree | `/cmcv -c <branch> [--from <ref>] [note]` | Creates a branch worktree and starts Pi there with handoff context. |
| Review in split | `/cmrv [flags] [target]`, `/cmrh [flags] [target]` | Starts a focused review session in a split. |

Detailed command examples: [docs/usage.md](docs/usage.md).

## Common examples

```text
/cmv Review the auth flow
/cmo npm test
/cmt k9s
/cmz mono
/cmcv focus on tests
/cmcv -c fix/sidebar --from main
/cmrv --bugs src/auth.ts
/cmrv https://github.com/owner/repo/pull/123
```

## Configuration

| Variable | Default | Purpose |
|---|---:|---|
| `PI_CMUX_NOTIFY_LEVEL` | `all` | `all`, `medium`, `low`, or `disabled`. |
| `PI_CMUX_NOTIFY_INCLUDE_RESPONSE` | `0` | Append truncated final assistant response to non-error notifications. |
| `PI_CMUX_NOTIFY_THRESHOLD_MS` | `15000` | Duration threshold for `Task Complete` vs `Waiting`. |
| `PI_CMUX_SIDEBAR` | `1` | Set `0` to disable sidebar integration. |
| `PI_CMUX_SIDEBAR_FLASH` | `all` | `all`, `error`, or `disabled`. |
| `PI_CMUX_SIDEBAR_PROGRESS` | `1` | Set `0` to disable sidebar progress updates. |
| `PI_CMUX_SIDEBAR_TOKENS` | `1` | Include compact live cumulative session token counts in sidebar progress and summaries. |
| `PI_CMUX_SIDEBAR_COST` | `0` | Include reported model cost alongside token counts. |
| `PI_CMUX_SIDEBAR_LOG_TOOLS` | `0` | Set `1` to log every tool result. |

Custom split shortcuts can be registered under `pi-cmux.commands` in `~/.pi/agent/settings.json` or `.pi/settings.json`; see [docs/usage.md](docs/usage.md#pluggable-tool-commands).

Example Hunk review shortcut:

```json
{
  "pi-cmux": {
    "commands": {
      "ck": {
        "run": "hunk diff --agent-notes --watch",
        "acceptArgs": true,
        "description": "Open Hunk diff with agent notes in a cmux split"
      }
    }
  }
}
```

Use `/ck` to open Hunk in a cmux split, add Hunk comments while reviewing, then ask Pi to read them.

`pi-cmux` also exposes an agent tool so Pi can open an explicitly requested terminal command in a cmux split or tab. For example, asking "open k9s in a new tab" lets Pi open `k9s` without trying to capture the TUI through a shell command.

cmux workspace/surface targeting uses `CMUX_WORKSPACE_ID` and `CMUX_SURFACE_ID` automatically. New splits and tabs use cmux's returned surface IDs; older responses fall back to bounded discovery that rejects ambiguous matches. Sidebar integration only activates inside a cmux workspace.

## Bundled resources

Extensions: `cmux-notify`, `cmux-sidebar`, `cmux-split`, `cmux-open`, `cmux-zoxide`, `cmux-review`, `cmux-continue`.

`pi-cmux` intentionally does not bundle generic review skills or prompt templates, so packages that provide `/review`, `/review-diff`, or `code-review` can own those names without conflicts.

## Development

```bash
npm ci --ignore-scripts
npm run typecheck
npm test
npm run pack:check
```

The development Pi version and lockfile are pinned for reproducible installs. Dependabot checks for Pi updates weekly and opens pull requests; CI runs type checks, CLI argument/quoting tests, surface-targeting tests, and extension lifecycle tests on Node.js 22.19.0 and 24. Tests use the installed Pi parser and in-process stubs, without starting Pi sessions or cmux panes.
