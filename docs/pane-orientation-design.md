# Pane orientation contract

## Identities and relationships

Version-1 `pi-cmux.orientation` entries store owning session ID, random task/conversation UUIDs, role, topic and optional immediate origin. Origins include session/conversation/task/role and full cmux window/workspace/pane/surface UUIDs. Entries are non-context metadata; short refs/tags are diagnostic only.

Fresh launches default to independent tasks. Related/review launches share a task without history; continuation shares the task with handoff context. Contradictory options fail before creation. Every tracked child records its immediate creator—not the task root—even when independent.

## Bootstrap

Launch environment carries bounded validated base64url JSON, consumed/removed once before descendants can inherit it. New wire format:

```text
[2, taskId, conversationId, role, topic, originOrNull]
origin = [taskIdOrNull, conversationId, role, sessionId,
          [windowId, workspaceId, paneId, surfaceId]]
```

Only an origin task UUID equal to the child's becomes null. Full UUIDs and opaque session IDs remain intact. Updated code reads legacy v1 objects; persisted entries stay v1. Compact launches require updated child code. Smaller metadata does not guarantee the whole cmux request fits its routing limit.

## Lifecycle and bindings

| Event | Behavior |
|---|---|
| First interactive startup | Consume bootstrap, restore owned branch metadata, or create independent root |
| Same-session reload/resume | Restore identity/origin and bind current surface |
| New/other session | Release old binding; use destination metadata only |
| Fork | Ignore foreign copied identity; create independent identity |
| Tree navigation | Restore current branch or create root if absent |
| Shutdown/reload | Cancel renames; remove own binding; leave terminals open |
| Invalid metadata/API | Disable orientation; report limitation without guessing |

Private local bindings under `<agent-dir>/pi-cmux/orientation/` hold surface/session/conversation, PID, runtime token and short expiry, renewed periodically. Expired files are not liveness proof. Ownership-sensitive operations require exact token/PID as well as identity. These are local navigation metadata, not cross-user authorization.

## Titles and notes

Titles reserve role/task tag within 48 characters: `Check login · review [ab12]`. Only topic is truncated. Detailed conversation markers stay in status/metadata; equal titles do not imply equal identities. No task-specific native border colors are implemented.

Manual/automatic names change topic, not identity. Child renames are serialized and lifecycle-cancelled. Protected creation starts the child in the create RPC and names it best-effort afterward; workspace/standalone legacy paths name before respawn. Startup naming is not a readiness guarantee.

At before_agent_start, related/handoff sessions receive a visible origin-link/return note once per active conversation/shortcut configuration. Empty chats are not awakened; user prompts/history are unchanged. Launch results expose the same origin help. Neither note nor label grants execution or messaging authority.

## Return navigation

`/cmbk` and its configured shortcut require a live exact origin binding, then locate exactly one UUID-bearing terminal in `tree --all`. Revalidate before focusing its current window/workspace/surface. Do not match titles, select siblings, replay keys or rebuild layouts. Closed/stale/duplicated/repurposed origins fail unavailable.

Native `cmux://workspace/<UUID>/surface/<UUID>` links select tabs but do not validate Pi occupants; prefer `/cmbk`. Links are scoped to the current cmux run. Native focus and final binding validation are not atomic; concurrent replacement remains a narrow race. Running one session in multiple surfaces does not change its recorded origin.

## Compatibility

Current minimum Pi: **1.3.0**. Inspected cmux **0.65.2 (111), 9d01f956c** provides UUID identify/tree and exact surface.focus. Incompatible responses fail closed. Creation compatibility is separate; no automatic retries.

Fixtures cover placements, roles, codec compatibility, lifecycle/naming races and moved/closed/replaced origins. They do not replace native navigation evidence or establish later launch-size guarantees. See [usage](usage.md#conversation-orientation).
