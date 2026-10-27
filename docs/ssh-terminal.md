# SSH-aware helper terminals

Tool `cmux_open_terminal`, slash commands and configured shortcuts share `openHelperTerminal`. They run commands, never select hosts or launch Pi.

| Request | Route |
|---|---|
| No SSH intent, omitted target | Local project |
| Ready SSH intent, omitted target | Bound remote project |
| Explicit local | Mac, even with disabled/disconnected SSH intent |
| Explicit remote | Requires this session's ready enabled target |
| Non-ready SSH intent, omitted target | Error; no local fallback |

Slash locality must be leading: `/cmt --local htop`. Configured commands use `target: "local" | "remote"`; forwarded arguments are program arguments, not locality flags.

Status shows state/destination/path and “Pi local”. Results retain exact created identities, target/cwd and placement/focus. Creation proves neither connection nor command completion.

## Creation boundary

Require exact caller UUIDs, advertised create/split capability and one unambiguous workspace.list row proving ordinary local ownership. Refuse remote-owned/cloud/relay/mirror/associated/unknown placement; never substitute a layout.

One RPC carries `initial_command` and `remote_context: "local"`. Local commands use local cwd/caller PATH. Remote commands launch local `/usr/bin/ssh -tt` with noninteractive authentication/strict trust, a whitelisted client environment including TERM/agent socket, and remote cwd/PATH. No Mac PATH, local cwd or Pi executable becomes remote startup text.

No default-create + respawn or discovery fallback. Naming is best-effort after exact response validation. Target/context checks bracket effects/awaits. Staleness, timeout or lost/invalid reply after creation is uncertain; never automatically retry, close unknown surfaces or search for substitutes. Cancelling the opening tool cannot stop an already opened terminal/remote descendants.

## Evidence

cmux **0.65.2 (111)** source supports initial_command/local-context creation and rejects unsupported backend overrides; local context is not universal placement authority. Tests inject cmux JSON/fake SSH for routing, quoting, limits, focus, races and refusal.

Authorized [native smoke](ssh-native-validation.md) verified remote/local helper **tabs in an ordinary local workspace**. Splits/other layouts, live cancellation and a minimum native cmux version remain unverified. See [transport](ssh-adapter.md) and [Pi launches](ssh-launch.md).
