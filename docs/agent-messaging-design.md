# Peer messaging contract — best-effort follow-up results

## Scope and history

Local interactive Pi 1.3.0+ uses cmux's native journal. Current user policy accepts automatic **follow-up** findings from explicitly delegated fresh launches, not steering or cancellation. Independent launches are unchanged; other traffic is inspection-only. Manual import is retired. Full managed-job registry, worker execution/sandboxing/cancellation, readiness acknowledgements, refill, SDK changes, host arbiters and automatic peer cleanup are deferred.

This policy supersedes manual-only scope for authorized return requests, without restoring the old automatic-preemption design. Completed steps01–07/14 and rejected08 are historical automatic evidence; completed09–12 and unaccepted13 describe the earlier manual-only snapshot. None certifies the new follow-up version. Preserve those records rather than marking old reviews accepted. Runtime code is loaded per Pi session; files changing does not upgrade existing panes and never authorizes silent reload.

## Launch and permission boundary

`cmux_start_pi.returnResults` defaults false. Use true only when the user explicitly delegates a fresh task and wants its findings returned. It requires a task prompt, implies related=true, and rejects handoff/continue roles and explicit related=false. Merely related/review roles, slash-command launches, origin links and peer messages do not grant automatic delivery.

Before launch, the bundled messaging runtime verifies live owner identity, native capabilities/receiving and an existing persisted session. Own resolution/preparation requires the active runtime's binding token and this process's PID; same-endpoint replacement is not ownership. Queued own-title writes use the same claim check. A host-generated request UUID binds a runtime-instance nonce, lifecycle generation, revocation epoch and exact owner endpoint. Recheck origin after asynchronous title construction, native caller/inventory lookup and discovery/naming boundaries, immediately before creation and child-command dispatch. The same small synchronous check carries tool cancellation and return-ticket revocation; it adds no scheduler or cancellation service. The child prompt retains the task plus exact return surface/request instructions to send concise findings using cmux_message_send. The child must actually send; model instruction adherence is not enforced worker completion. No request is sent to a model solely to configure this route.

Workspace/split/tab creation explicitly requests `--id-format both`. Keep returned short refs for targeting/display and validated full IDs for protocol identity; never assume default JSON includes UUIDs or make the user type them. If full IDs remain absent/malformed, setup fails conservatively with the already-created warning, not alias guessing or relaxed guards.

After creation, permission binds the returned child surface UUID and seeded conversation/task IDs. The live binding and envelope must agree on actual child session; the first valid traffic pins that session. No guessed focus/title/ref, or native recipient_has_agent, establishes readiness. Launch reports awaiting-live-child-binding, not verified readiness/result/settlement. A post-creation setup failure reports not-configured with an already-created warning, never an automatically retriable launch failure. If a guard stops startup after surface creation but before child-command dispatch, the tool instead fails with an explicit created-surface/no-relaunch warning. It does not close the surface. Already-dispatched native calls finish under the existing timeout; their side effects are not rolled back, and cancelling after child-command dispatch cannot guarantee that child did not start.

Permissions are memory-only, expire after30minutes, cap at32 active requests and16 actionable messages per request. Abort/off/session/branch/reload revoke new scheduling; prepared tickets cannot cross runtime/generation/epoch boundaries. No authority is reconstructed from receipts/history on restart. Revocation never aborts a run, clears SDK queues, retracts an accepted follow-up or closes a child; already accepted SDK work follows Pi's own behavior. Stale/expired findings remain native inspectable for deliberate handling.

## Automatic delivery and batching

A single session-scoped worker performs bounded serialized native list reconciliation on a normal 2-second interval, short settings reads, lifecycle kicks and capped error backoff. There is no native event subscription or poller registration; cleanup cancels local I/O/timers. It never blocks a tool waiting for a peer. Background counts contain no bodies. Model-callable inbox inspection remains read-only.

Only valid live sender/recipient/task/conversation/session/request traffic with launch permission is eligible. Questions/results are model-bound; progress stays quiet and never creates context or a model turn. Receipt/control kinds are not importable. Wrong/stale/malformed/conflicting input never acquires permission. Digests exclude retry timestamps but include routing/request/kind/text; same-ID conflicting copies in the current valid inbox are held, and own-history conflicts do not reinsert.

Busy Pi, observable pending user work, open extension UI prompts hold automatic dispatch. Pending findings stay native and accumulate until an eligible reconciliation. Consider native newest-first entries oldest-first, deduplicate logical IDs and form one batch up to16 messages /128KiB of envelope bodies, including multiple authorized requests/peers. Excess traffic waits for later eligibility subject to request budgets/native retention. This is bounded polling/coalescing, not a guarantee that every near-simultaneous arrival joins one model request.

First reserve exact own-session durable scheduling intent for every batch member. Recheck lifecycle/permission/provenance after I/O, then issue exactly one visible untrusted custom message with `{triggerTurn:true,deliverAs:"followUp"}`. If a run starts during reservation, use its SDK follow-up queue; never steer or preempt it. No global queue mode is changed. Native messages remain unchanged even after dispatch. Peer findings are not operator instructions, permission for fixes/new work, or plan completion.

## Best-effort host limits — explicitly accepted

Pi supports follow-up queues and before_agent_start, but idle observation and submission are not atomic. An ordinary prompt hidden inside asynchronous input handlers/authentication can still race a result wake. The peer result may start first and the human prompt may fail as busy. Deterministic actual SDK tests reproduce both windows; these are limitations, not passing priority guarantees. Do not add ctx.abort, raw input listeners, run-ownership heuristics or SDK patches to disguise them.

Manual compaction and other continuation/queue/settlement boundaries have additional host limitations; this integration is not a global admission scheduler. Already accepted SDK follow-ups cannot safely be withdrawn by this extension. User abort revokes future permission but is not an exactly-once cancellation guarantee for all previously queued host work. Missing native receiving/readiness, expired permissions, persistent-storage limits, child failure to send and upstream queue failure can prevent automatic return. Native queued/sent, SDK enqueue, applied context and processed findings remain different evidence.

Relevant upstream reports: input/authentication collision [#10924](https://github.com/earendil-works/pi/issues/10924), atomic idle admission [#9632](https://github.com/earendil-works/pi/issues/9632), manual-compaction custom wake [#10982](https://github.com/earendil-works/pi/issues/10982). These links identify discussed limits, not implemented upstream fixes or a requirement to patch installed Pi.

## Native transport semantics

The client requires only native send/list/settings, tested against cmux0.65.2(111). It does not implement claim/ACK/mark-read/native-poll APIs. List includes sent/received, newest first, capped at1,000 before exact incoming-recipient filtering. Polling latency includes the normal interval, I/O, backoff and host eligibility; no immediate-delivery guarantee is made.

Automatic return and inbox inspection are **list-only**: no claim, ACK, dequeue or mark-read. Dispatched/inspected/unselected entries keep their native states and can still count as queued. Native retention/caps still apply; neither indefinite retention nor an empty inbox after processing is promised.

Send/reply is nonblocking. Full endpoints and native sender/recipient must agree with live bindings. Replies validate native parent full endpoints/request. Native IDs differ from stable logical IDs. Return queued/native IDs or unknown evidence, never wait for processing. Unknown sends never retry automatically; deliberate retry after inspection retains logical ID and identical content. Local bindings are provenance, not cryptographic authentication or an OS sandbox.

## Intent, persistence and deduplication

Automatic `pi-cmux.message.followup.intent` means a durable scheduling reservation, **not** applied context, native delivery/read, processing or success. SDK sendMessage returns void; accepted/deferred/failed queues cannot be inferred durable from that return. Batch context carries each member's logical/native ID, digest and owner metadata in visible untrusted context. Only actual persisted batch context establishes that history insertion occurred; no automatic processing receipt is fabricated.

Record intent before enqueue, confirm exact session header/entry content by bounded asynchronous readback and suppress all matching intents/context across own historical branches. A memory attempt fence also suppresses retries when persistence/enqueue itself failed. Partial/corrupt/buffered/unknown outcomes stay unknown and never auto-replay. This is at-most-one automatic scheduling attempt per own logical identity, **not exactly-once delivery/execution**. A crash between intent and enqueue can leave no automatic response; native input is preserved for deliberate recovery. Intent alone suppresses another scheduling attempt; it is never proof of processing.

There is no manual import command, dialog or context-injection writer. Read-only inbox/status/off controls remain; on enables observation only, without return permission. The ledger still reads historical manual staged/received/rejected/context and wake/turn markers conservatively so cleanup cannot replay old work. No legacy receipt is newly written. Context abandoned on another branch still suppresses reinsertion; copied fork/session owners do not bind the current endpoint. Historical metadata never restores permission or proves uncertain work processed.

Never create/rewrite Pi session files or peer history. Missing/unflushed/in-memory/corrupt/oversized history fails closed; any already inserted/queued partial context remains visible/unknown, without rollback, consumption or blind retry.

## Bounds, privacy and costs

Envelopes fit32KiB. Native CLI stdout/stderr caps at2MiB with2.5-second subprocess deadlines. Lists cap at1,000; model inbox16 with500-character body excerpts. Durable readback caps session history at32MiB, entries1MiB, cooperatively yields and has a2.5-second parsing deadline. Automatic batches cap16/128KiB; permissions32requests/16actionable messages each/30minutes; runtime attempts cap1,024. Exceeding limits holds work, not silently consuming/truncating it into processed state.

Status is bounded/sanitized and never includes peer bodies or corrupt-history snippets. Observation/receiving checks use local native I/O; session cleanup cancels local I/O/timers only. No automatic provider call for progress/preview/setup. Automatic findings can start ordinary paid model turns, including an unnecessary turn in a startup race. Both local journals persist bodies; automatic findings can reach the configured provider without another user prompt. Send only authorized necessary data. Unsupported headless/storage/ownership/capabilities fail explicitly, not through fallback transport or terminal typing.

## Acceptance and non-goals

SDK/runtime/launch/transport tests must cover opt-in routing, readiness pinning, busy followUp not steer, multi-peer/request batching, exact provenance/conflicts, intent/persistence/queue failure, unknown no-retry, native preservation, revocation/expiry/restart/branch isolation and observed host-race limits. Keep meaningful existing feature, actual TUI queue-restoration and isolated install/load-graph tests. Run full tests/typecheck/isolated CLI/package/diff against identified files.

Physical automatic/native return, real draft/dialog/keyboard/compaction/restart behavior and independent review are separately authorized acceptance, not default test side effects. Synthetic/historical evidence never certifies missing physical observations. No code change silently reloads sessions, launches real test workers, changes global settings/installations, cleans peers, commits or releases.
