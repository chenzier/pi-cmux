# pi-cmux

<img width="1335" height="758" alt="Screenshot 2026-05-27 at 12 05 46" src="https://github.com/user-attachments/assets/27806213-60f9-4c30-84d4-4a331ea1484b" />

[![CI](https://github.com/javiermolinar/pi-cmux/actions/workflows/ci.yml/badge.svg)](https://github.com/javiermolinar/pi-cmux/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/pi-cmux.svg)](https://www.npmjs.com/package/pi-cmux)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](https://opensource.org/licenses/MIT)

Pi package with [cmux](https://www.cmux.dev)-powered terminal and browser integrations for [Pi](https://pi.dev).

## What it adds

`pi-cmux` keeps Pi terminal-native by delegating notifications, sidebar status, terminal and browser splits, tab naming, pluggable tool commands, directory jumps, and continuation workflows to cmux.

Recommended: run `cmux hooks pi install` for native notifications, session restore, and prompt previews;

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

## Commands

| Workflow | Commands | Summary |
|---|---|---|
| Notifications | opt-in | Set `PI_CMUX_NOTIFY_LEVEL=all` to send `cmux notify` once Pi settles after retries, compaction, and queued follow-ups. |
| Sidebar status/log | automatic | Updates cmux status, progress, and logs while Pi runs, then flashes once Pi settles. |
| New sidebar chat | `/cmn <prompt>` | Starts a fresh Pi chat in a named workspace in the left sidebar. |
| Split Pi | `/cmv [prompt]`, `/cmh [prompt]` | Opens a new right/lower split with Pi in the same project. |
| Run a tool | `/cmo <cmd>`, `/cmoh <cmd>`, `/cmt <cmd>` | Opens a split or tab and runs a shell command in the same project. |
| Open a browser | `/cmb [--down] [--focus] <url>` | Opens a browser beside this Pi terminal; keeps focus in Pi by default. |
| Annotate a page | **Annotate** toggle in the browser | Added automatically, initially off. Select an element and write a note; Send requires confirmation in Pi. |
| Pluggable tools | custom `/<name>` | Registers cmux split shortcuts from `pi-cmux.commands` settings. |
| Jump directory | `/cmz <query>`, `/cmzh <query>` | Resolves a zoxide match or path, then opens Pi there. |
| Continue task | `/cmcv [note]`, `/cmch [note]` | Opens a related handoff session in a split. |
| Continue in worktree | `/cmcv -c <branch> [--from <ref>] [note]` | Creates a branch worktree and starts Pi there with handoff context. |

New Pi sessions and tool terminals preserve the calling Pi process's `PATH`, so executables such as Pi, Node, and Hunk remain discoverable even when cmux has a different terminal environment. Tool commands use an inner `/bin/sh -c`, but cmux 0.64.25 wraps respawns in `/bin/sh -lc`. Login profiles may run before our command restores `PATH`; profile side effects are not prevented. This does not copy the caller's shell aliases or functions.

New workspaces use `cmux --json workspace create`, verified against cmux **0.64.25 (106)**. Creation targets the caller's window and is never automatically retried; if identification or startup fails, inspect cmux before retrying because the workspace may already exist. Older cmux versions have not been verified.

Detailed command examples: [docs/usage.md](docs/usage.md).

## Common examples

```text
/cmv Review the auth flow
/cmo npm test
/cmt k9s
/cmb http://localhost:3000
/cmz mono
/cmcv focus on tests
/cmcv -c fix/sidebar --from main
```

## Configuration

| Variable | Default | Purpose |
|---|---:|---|
| `PI_CMUX_NOTIFY_LEVEL` | `disabled` | Opt in with `all`, `medium`, or `low`; leave disabled when using native hook notifications. |
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

Ask "open http://localhost:3000 beside Pi" to use `cmux_open_browser`. An **Annotate** toggle appears automatically, initially off. Switch it on, select an element, write a note, and Send; Pi requires reviewing all confirmation pages before steering. Switch it off to browse normally without losing your draft. Page scripts can forge submissions, so approve only notes you recognize. See [browser usage and lifecycle](docs/usage.md#browser-splits).

cmux workspace/surface targeting uses `CMUX_WORKSPACE_ID` and `CMUX_SURFACE_ID` automatically. New terminal splits and tabs use cmux's returned surface IDs; older terminal-creation responses fall back to bounded discovery that rejects ambiguous matches. Browser opening requires validated UUIDs and does not use discovery fallbacks. Sidebar integration only activates inside a cmux workspace.

## Bundled resources

Extensions: `cmux-notify`, `cmux-sidebar`, `cmux-split`, `cmux-open`, `cmux-browser`, `cmux-zoxide`, `cmux-start`, `cmux-continue`.

`pi-cmux` does not provide review commands, skills, or prompt templates. Use your preferred review tooling in a new chat or split.

## Validation

```bash
npm ci --ignore-scripts
npm test
npm run typecheck
npm run pack:check
```

Normal tests/CI do not require cmux. To opt into installed-CLI contract tests:

```bash
PI_CMUX_TEST_CLI="$(command -v cmux)" node --test tests/cmux-cli-contract.test.mjs
```

Use an absolute executable path; an unset variable skips these tests. The tests route every CLI call to an isolated fake Unix socket, with synthetic IDs and an isolated home/environment. They exercise workspace creation through the actual launch function, targeting, focus, failures, legacy versus JSON output, and the respawn login-shell wrapper. They never execute the returned shell command or mutate the cmux app. These are CLI serialization/response tests, not application-side creation or focus tests. The audited baseline is cmux **0.64.25 (106)**, revision `b685a275c`; review contract changes when testing another version.

