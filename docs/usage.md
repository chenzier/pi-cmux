# pi-cmux usage

Run Pi inside cmux. See the [README](../README.md#install) for installation.

## Commands

| Task | Command |
|---|---|
| New sidebar chat | `/cmn <prompt>` |
| New Pi split | `/cmv [prompt]` right, `/cmh [prompt]` below |
| Return to origin | `/cmbk` or **Ctrl+Alt+B** |
| Continue a task | `/cmcv [note]` right, `/cmch [note]` below |
| Continue in a new worktree | `/cmcv -c <branch> [--from <ref>] [note]` |
| Run a terminal command | `/cmo <command>` right, `/cmoh <command>` below, `/cmt <command>` in a tab |
| Open a browser | `/cmb [--down] [--focus] <url>` |
| Retry or stop annotations | `/cmba [surface]`, `/cmba off` |
| Jump to a directory | `/cmz <query-or-path>` right, `/cmzh <query-or-path>` below |

Aliases: `/cmux-v` → `/cmv`, `/cmux-h` → `/cmh`, `/cmov` → `/cmo`, `/z` → `/cmz`, `/zh` → `/cmzh`.

## Configuration

Package settings go in `~/.pi/agent/settings.json` (or `$PI_CODING_AGENT_DIR/settings.json`) and `.pi/settings.json` in the project. Project settings override global settings. Run `/reload` after editing them.

Set environment variables before starting Pi. Restart Pi after changing exports in another shell; `/reload` does not import that shell's environment.

## Pi sessions

```text
/cmn Investigate slow startup
/cmv Review the auth flow
/cmh Add tests
/cmz ~/src/other-project
```

These commands start fresh, independent chats. Directory jumps accept paths without zoxide; fuzzy queries require zoxide. Prompts are quoted, so `--help` remains prompt text. Inputs beginning with `@` retain Pi's file-input behavior.

You can also ask Pi:

```text
Start a fresh Pi session in a right split in ~/src/other-project.
Open a reviewer for this task in a right split.
```

The `cmux_start_pi` tool supports workspace, right, down, and tab placement, plus a title, focus control, model/provider, and thinking level. `cwd` accepts absolute, session-relative, and `~/…` paths and must name an existing directory. Omit it to keep the current directory. It cannot be combined with `continueSession: true`.

New sessions focus by default; `focus: false` opens them in the background. Sessions are independent, not managed subagents, and results do not automatically return to the source conversation.

**If opening fails, inspect cmux before retrying:** a workspace or pane may already exist. Creation is never automatically retried.

## Conversation orientation

Tabs put the topic first, followed by the role and a short shared task tag:

```text
Authentication · main [ab12]
Check login · review [ab12]
```

Detailed conversation markers stay in Pi status and metadata. The four-character tag is a visual hint, not a navigation target.

| Launch option | Relationship and history |
|---|---|
| Default fresh chat | Separate task group, no inherited history |
| `related: true` | Same task, no inherited history |
| `role: "review"` | Same-task reviewer, no inherited history |
| `continueSession: true`, `/cmcv`, `/cmch` | Same task with handoff context |

`related: false` cannot be combined with review/continue roles or `continueSession: true`. Writing “review” in a slash-command prompt does not select a relationship automatically.

### Return to the exact conversation

Use **`/cmbk`** or **Ctrl+Alt+B** in a child conversation to return to its immediate creator—even after switching sibling tabs or moving the origin between workspaces/windows. A reviewer of a reviewer returns to that reviewer, not the task root.

Set `PI_CMUX_RETURN_KEY=ctrl+shift+y` to change the shortcut, or `off` to disable it. `/cmbk` remains available. Supported keys include letters, digits, arrows, Home/End, and F1–F12 with optional `ctrl`, `alt`, and `shift` modifiers.

Handoffs and related chats show a navigation note with the origin link and return hint when they first start working. The launching LLM is also instructed to include that help in its confirmation. This does not copy extra history, rewrite the task, or wake an empty chat.

Prefer `/cmbk` over the native `cmux://` link: the command checks the live Pi conversation; the link only selects the tab. Links are scoped to the current cmux run, not guaranteed across app restarts. Neither is a messaging channel.

### Persistence and compatibility

Reload/resume preserves the same session's identity. `/new` and other-session resume use their own metadata; `/fork` starts a new independent identity. Tree navigation follows the active branch. `/name` and automatic topic titles preserve the task marker.

Closed, stale, inaccessible, or repurposed origins report “unavailable” rather than selecting another pane. After sleep, allow a few seconds for the live binding to renew. A root conversation has no origin.

Orientation runs in bundled interactive Pi sessions and was tested with cmux **0.65.2**. Task-specific colored borders are not implemented; this package does not change cmux's global border settings. See the [design contract](pane-orientation-design.md) for lifecycle and targeting limits.

## Continuation and worktree handoff

```text
/cmcv Continue with tests
/cmch Focus on error handling
/cmcv -c fix/login --from main Add login tests
```

Same-checkout handoffs include a summary and, when available, the current conversation branch. New-worktree handoffs carry a summary, not the full history or uncommitted files. Both keep the source session open and share its task marker.

Use `cmux_start_pi` with `continueSession: true` for an agent-started handoff; add `branch` and optional `fromRef` for a new branch worktree. Do not use `continueSession` for a fresh reviewer that should receive only your supplied prompt.

## Tool splits and tabs

```text
/cmo hx
/cmoh npm run dev
/cmt k9s
```

Or ask Pi to open a terminal program in a split or tab; it uses `cmux_open_terminal`. These terminals remain interactive rather than being captured as shell output.

Commands preserve the caller's `PATH` and run through an inner `/bin/sh -c`. cmux may wrap startup in a login shell, so profile side effects are still possible. Shell aliases/functions are not copied; request a specific shell when needed.

Tabs use `<title> · <repo-or-directory>`; Pi tabs add their orientation marker. Initial naming happens before command startup, without a later parent rename.

## Browser splits

```text
/cmb http://localhost:3000
/cmb --down https://example.com
/cmb --focus file:///tmp/preview.html
```

Browsers open to the right without taking focus. Use `--down` for a lower split or `--focus` to activate it. URLs must be absolute HTTP, HTTPS, or local `file://` URLs without embedded credentials; percent-encode spaces.

Ask Pi to open a URL beside it to use `cmux_open_browser`. Opening confirms creation, not page readiness or HTTP success. If opening fails, inspect cmux before trying again.

### Browser annotations

1. Turn on **Annotate** in the browser; it starts off.
2. Select an element, write a note, and choose **Send**.
3. In Pi, review the preview and choose **Send to Pi**. Confirmation defaults to Cancel.

Turning Annotate off restores normal browsing and retains the draft in the current document. Navigation can lose drafts. Up to four browsers can have active annotation bridges.

```text
/cmba             # retry the single bound browser
/cmba surface:2   # retry a specific bound browser
/cmba off         # stop all bridges; leave browsers open
```

Retrying enables the bridge, not the page toggle. After `/reload`, session replacement, or Pi exit, old bindings are not restored; open a new browser with `/cmb`. Existing panes remain open. Turn off native Design Mode before using annotations; iframe annotations are not supported.

**Privacy and trust:** the page can inspect drafts or forge submissions. Approve only notes you recognize, even on localhost. Delivery includes the full comment, page URL (including query/fragment), title, selector, and up to 240 characters of selected text; form/editable content is excluded. No screenshot is captured. Check for sensitive data—the Pi preview is shortened and does not show everything sent.

Approval sends the note into Pi and can start a turn. “Queued in Pi” does not mean the model has processed it. There is no atomic protection against navigation or cancellation immediately before dispatch. Annotations do not provide model-facing page click/typing tools.

## Conversation tab titles

LLM-generated topics are **off by default**. Enable them with `PI_CMUX_AUTOTITLE=1`, or in Pi settings:

```json
{
  "pi-cmux": {
    "autotitle": true
  }
}
```

After successful settlement, a background request names the current tab—not the workspace. It sends up to four recent user/assistant text messages, each limited to 300 characters, to the selected model provider and may incur charges. No images or tool messages are sent.

`/name` takes priority. Successful titles persist across reload/resume without another request; session/branch changes restore their own naming state. Clearing `/name` allows automatic naming again. Naming only runs in interactive cmux sessions and does not block Pi.

- `PI_CMUX_AUTOTITLE=0|1` overrides settings files.
- `PI_CMUX_AUTOTITLE_DISABLED=1` always disables automatic topics, not stable orientation markers.
- `PI_CMUX_AUTOTITLE_MODEL=provider/model` selects another model; an unknown model skips naming.

## Sidebar status/log

`PI_CMUX_SIDEBAR_MODE` selects the package's output:

- **`detailed`** (default): status, progress, tokens, and logs.
- **`minimal`**: status with live tokens and configured flashes; no package logs or progress.

These settings do not hide cmux's native previews, branch, path, or activity, or remove existing logs. Set `PI_CMUX_SIDEBAR=0` to disable package sidebar integration; flash settings remain independent.

```bash
PI_CMUX_SIDEBAR_MODE=minimal
PI_CMUX_SIDEBAR_TOKENS=0       # hide tokens
PI_CMUX_SIDEBAR_COST=1         # show reported cost (default: off)
PI_CMUX_SIDEBAR_FLASH=error    # all (default), error, disabled
PI_CMUX_SIDEBAR_PROGRESS=0    # hide progress in detailed mode
PI_CMUX_SIDEBAR_LOG_TOOLS=1   # log tool results (default: off)
PI_CMUX_SIDEBAR_LOG_PROMPT=1  # log truncated prompts (default: off)
PI_CMUX_SIDEBAR_FINAL_CLEAR_MS=2500
```

## Notifications

Package notifications are **off by default** to avoid duplicating native cmux hook alerts. Opt in before starting Pi:

| `PI_CMUX_NOTIFY_LEVEL` | Notifications |
|---|---|
| `all` | Waiting, Task Complete, Error |
| `medium` | Task Complete, Error |
| `low` | Error only |
| `disabled` | None (default) |

Notifications run after Pi settles, normally only in interactive cmux sessions. `PI_CMUX_NOTIFY_FORCE=1` allows them outside that mode/surface guard but still requires an enabled level.

Bodies summarize activity and errors. `PI_CMUX_NOTIFY_INCLUDE_RESPONSE=1` also includes up to 500 characters of the final response; leave it off if responses may contain sensitive text.

Optional tuning: `PI_CMUX_NOTIFY_TITLE=Pi`, `PI_CMUX_NOTIFY_THRESHOLD_MS=15000`, and `PI_CMUX_NOTIFY_DEBOUNCE_MS=3000`.

### Tool notification settings

Enable exact tool names in Pi settings:

```json
{
  "pi-cmux": {
    "notify": {
      "tools": { "ask_user_question": true }
    }
  }
}
```

An enabled notification level is still required. Configured tools notify at any enabled level; bodies contain the tool name and optional path basename, not other arguments. A project entry of `{ "disabled": true }` removes a global entry. Invalid entries produce a warning.

## Pluggable tool commands

Define your own split shortcuts in Pi settings:

```json
{
  "pi-cmux": {
    "commands": {
      "edit": {
        "run": "hx",
        "acceptArgs": true,
        "description": "Open Helix"
      },
      "dev": { "run": "npm run dev", "direction": "down" },
      "logs": "tail -f logs/app.log"
    }
  }
}
```

Use `/edit src/auth.ts`, `/dev`, or `/logs`. Shortcuts default to a right split and use the same shell behavior as [tool terminals](#tool-splits-and-tabs).

Object options: `run`, `acceptArgs`, `direction` (`right` or `down`), `title`, `description`, and `disabled`. Set `disabled: true` in project settings to remove a global shortcut. Command names cannot replace Pi or package commands, including `/cmbk`.

For reviews, start a normal chat with your preferred review prompt or skill. Ask Pi to use `cmux_start_pi` with `role: "review"` for a related reviewer. No review tool or workflow is prescribed by this package.

## Compatibility

Workspace creation and browser opening were tested with cmux **0.64.25**; orientation with **0.65.2**. Older versions are not verified. The integrations target the calling terminal, not whichever pane happens to have focus. Failed or ambiguous targeting does not trigger automatic creation retries.
