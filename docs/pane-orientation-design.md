# Pane orientation contract

## Scope and identities

Pi-to-Pi launches use a versioned `pi-cmux.orientation` custom session entry, excluded from model context. It records the owning Pi session ID, a random task UUID, a separate random conversation UUID, a role (`main`, `chat`, `review`, or `continue`), a launch-topic fallback, and an optional immediate origin. An origin includes its session/conversation identity, task/role label, and cmux window/workspace/pane/surface UUIDs. Only UUIDs are durable targets; short refs are diagnostic launch results.

`cmux_start_pi` defaults to a new task group. `related: true` shares the caller's group without copying conversation history. `role: "review"` implies related; `continueSession: true` and `/cmcv`/`/cmch` share the group and use `continue`. Explicitly contradictory options are rejected before creation. `/cmn`, `/cmv`, `/cmh`, and zoxide splits remain independent chats. Every tracked launch retains its immediate creator as origin; independent chats have a different group even though they can return to their creator. A reviewer of a reviewer shares the task group but returns to that reviewer, not an inferred task root.

A child receives a bounded, validated, base64url JSON bootstrap in an environment assignment on its launch command. The orientation runtime consumes and removes it once at startup; it is never part of the user/handoff prompt or inherited by subsequent shell children. A fresh conversation remains history-free. Prepared handoff sessions get their own identity instead of inheriting copied source metadata.

## Lifecycle

| Event | Behavior |
| --- | --- |
| First interactive startup inside cmux | Restore the current session's own entry or consume a launch bootstrap; otherwise create an independent root identity. |
| Reload or resume the same Pi session | Restore its identity and immediate origin; register its current UUID-bearing cmux surface. |
| `/new` or resume another session | Release the old live binding; load only the destination session's own metadata. Never reuse the bootstrap. |
| `/fork` | Copied metadata belongs to another session ID and is ignored; assign a new independent identity. |
| Tree navigation in the same session | Reconstruct from the active branch; restore that branch's own entry or create a new independent identity if absent. |
| Session shutdown/reload | Cancel pending renames and remove only this runtime's live binding; leave terminals open. |
| Invalid metadata / unavailable UUID API | Disable orientation safely and report the limitation; do not guess a target or retry creation. |

Local live bindings under `<agent-dir>/pi-cmux/orientation/` associate a surface UUID with the current Pi session/conversation, process ID, runtime token, and short expiry. Atomic private-file replacement and periodic renewal support detecting a terminal that now hosts a different session or no live Pi. No prompt contents or credentials are stored. Expired bindings fail closed; stale files are not proof of liveness. Own resolution, launch preparation and title writes also require this runtime's exact claim token and process ID; they do not wait for renewal to notice a same-endpoint replacement. This is local navigation metadata, not an authorization or cross-user security boundary.

## Labels and title ownership

Titles put the human topic first, for example `Authentication · main [ab12]` and `Check login · review [ab12]`. The suffix reserves the role and first four task-UUID characters within the existing 48-character bound; only the topic is truncated. Related conversations share that compact task tag, never an agent-specific color. Short tags are visual hints, not guaranteed-unique identities or navigation targets. Conversation IDs do not consume tab-title space: detailed `T<task-short>/<conversation-short> <role>` markers remain in Pi status and full identities remain in session metadata. Conversations with the same topic, role and group can have identical tab titles while their status/metadata distinguish them.

Manual `/name` and opt-in automatic titles change the topic, not the suffix. Formatting removes this conversation's repeated legacy prefixes and current suffixes, so decorated saved names stay readable on reload. It does not generate a topic or change the session's saved name. A single orientation rename queue and lifecycle cancellation prevent old title work from applying to a replaced session. The parent initializes the decorated title before requesting child execution, then makes no further title writes. After startup, the child's orientation queue owns topic and identity changes; a delayed parent startup reply cannot overwrite them. Initial naming remains best-effort and is never retried after startup. A compact Pi status shows the local marker and immediate-origin marker with `/cmbk`; it does not claim that the origin is live until validated.

## Model-facing handoff navigation

The origin bootstrap remains non-context session metadata. Separately, `before_agent_start` supplies a visible `pi-cmux.navigation` custom message for handoffs and related sessions, containing the immediate origin marker/link and `/cmbk` plus the child's actual shortcut when enabled. The message is model-visible by design, carries owning session/conversation IDs, and is added only if the active branch lacks that conversation's note for the registered shortcut configuration. Inherited notes do not suppress the current conversation's note. Empty chats do not trigger a model request; user task prompts and handoff summaries are unchanged. Unrelated chats, headless modes, and stale session contexts do not get navigation instructions.

The parent launch result also exposes `navigation.originLabel`, `navigation.originUrl`, and `navigation.returnCommand`. Its tool guidelines ask the launching LLM to show the returned link/return hint, without inventing targets or assuming the child's shortcut configuration. Both sides are told not to navigate automatically or treat navigation metadata as additional execution authority.

Native links use `cmux://workspace/<workspace-UUID>/surface/<surface-UUID>`. The inspected cmux 0.65.2 navigation resolver supports runtime surface UUIDs and cross-workspace moves (`Sources/AppDelegate+CmuxNavigationDeepLinks.swift`, `Sources/CmuxNavigationTargetResolver.swift`, and `cmuxTests/CmuxNavigationTargetResolverTests.swift`). The installed application registers the `cmux` URL scheme. This implementation does not generate restart-stable fallback IDs. A link selects a native tab without checking which Pi session currently occupies it; `/cmbk` remains the safer validated return path. Link support was inspected in native source, not exercised by automatically opening a URL.

## Return navigation

`/cmbk` and its configurable extension shortcut return without an LLM request. Before focusing, validate the origin's live binding and scan `cmux tree --all` for exactly one terminal surface with its full UUID. Use that surface's current window/workspace/pane location, so moving tabs is supported without moving them back. Revalidate the binding immediately before `surface.focus`. Explicit window/workspace/surface UUID selectors restore the window, workspace, pane and exact selected tab. Never focus only a pane, match by title, choose a sibling, replay keys, or rebuild layouts.

Closed, expired, inaccessible, duplicated, malformed, or repurposed targets report an unavailable origin. Concurrent session replacement between final validation and native focus cannot be made atomic by the current cmux API; this narrow race is a documented limitation, not a guarantee of session-level native targeting. Concurrently running the same Pi session in multiple surfaces is not an origin-discovery mechanism: return follows the recorded surface only.

## Compatibility and verification

Inspected cmux **0.65.2 (111), commit `9d01f956c`**: UUID-bearing `identify` and `tree --all` responses are available; `surface.focus` focuses the owning window and calls `focusTab(workspace, surfaceId:)` (`Sources/TerminalController+ControlSurfaceContext.swift`). New orientation behavior requires those response shapes and fails closed on incompatible versions. Existing terminal creation compatibility, including bounded unambiguous legacy discovery, remains separate; creation is never automatically repeated.

The original orientation APIs were verified against Pi 0.85.1. The package now pins and requires **Pi 1.3.0+** for its modern lifecycle and messaging integration; this is the supported baseline for current validation.

The current cmux `paneBorderColor` and `activePaneBorderColor` settings are global. Ghostty `split-divider-color` is also not task-specific. This package does not edit those settings or draw native borders. Per-surface task colors remain native cmux work, outside this implementation.

Validation covers all placements, unrelated/related/reviewer/continuation relationships, bootstrap isolation, session lifecycle changes, naming races and title bounds, moved/closed/replaced origins, and exact focus selectors. Automated mocks do not replace the separately recorded interactive cmux navigation smoke test.
