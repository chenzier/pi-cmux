# Peer messaging validation — scoped follow-up results

## Automated checks

```bash
npm ci --ignore-scripts
npm run typecheck
npm test
PI_CMUX_TEST_CLI=/absolute/path/to/cmux node --test tests/cmux-cli-contract.test.mjs
npm run pack:check
git diff --check
```

Default tests use temporary files, fake local models/transport/editor and no ambient extensions/credentials/network. They never open real peers/surfaces or reload the user's session. The installed-CLI suite pins every request to a fake socket/HOME. Installer tests run only with temporary HOME, verify every relative runtime import and load the installed entry through the real Pi loader. The lib omission fixed earlier predates messaging.

## Current coverage and boundaries

| Requirement | Evidence | Limit |
|---|---|---|
| Explicit delegated return setup | Real launch/orientation code on fake native responses: returnResults option, retained task prompt plus exact request/return instructions, expected child conversation/task/surface, unknown live binding held, multi-peer return, invalid combinations rejected before creation | Child model must actually send results; not verified readiness/completion or an enforced worker sandbox |
| Own claim replacement | Production-self-path regressions replace binding token/PID before renewal and during receiving/intent persistence; old runtime cannot resolve ownership, enqueue findings, prepare a launch or rename the tab | Local claim fencing, not cryptographic authentication |
| Launch cancellation boundaries | Workspace/right/down/tab guards cover identify/inventory, creation response, discovery, startup delay and naming; abort/off/claim/session changes prevent further dispatch, with explicit warnings once a surface exists. Post-child-dispatch abort retains already-launched/no-retry evidence | No rollback or cancellation guarantee for already-dispatched native work; no physical cancellation test |
| Non-retriable post-creation setup failure | Missing child UUID reports already-launched/not-configured rather than throwing a safe-to-retry launch failure | No automatic peer cleanup/relaunch |
| Automatic idle/busy follow-up | Actual Pi1.3 SDK fake provider: idle wake including default timer-driven delivery without explicit tick/events/user prompt, busy hold, multiple requests batched after original work, host start during durable reservation routes into followUp rather than steer | Not physical/provider acceptance |
| Quiet/unrelated traffic | Progress/control/wrong request/sender/recipient/conversation cannot trigger an automatic request; inspection-only/related-without-return regressions retained | No cryptographic sender authentication |
| Preserve accepted user work | Actual session steer/followUp queues finish before delegated results; later unqueued input cannot cause messaging abort. Existing pending/consumed session/public-core regressions and actual TUI restoration methods on synthetic editor/compaction queue retain checks | Not physical keyboard/draft behavior; hidden preflight is separately a known failure |
| Settlement, dialogs and revocation | Actual SDK deferred-settlement handlers before/after messaging, real UI prompt wrappers, abort/off/tree/reload/instance ticket fences, restart, expiry, native receiving changes and pinned child session changes | Already accepted SDK work cannot be retracted by this extension; manual compaction and some host lifecycle boundaries remain upstream gaps |
| IDs, ordering, bounds | Same logical ID under new native IDs/timestamps suppresses duplicates; same-ID conflicts held; native newest-first batches oldest-first, per-request16 messages, batch16/128KiB; own abandoned-branch dedup | Native retention/caps may hide older findings; not a complete durable queue/job registry |
| Persistence/unknown enqueue | Real SessionManager/files and actual SDK queueing; durable intent before enqueue, corrupt/missing/unflushed/oversized persistence, throwing/dropped/post-enqueue-fault queues, conservative reserved/inserted and historical manual/wake dedup, no native mutation or blind retry | Intent is not context/application/processing; crash before enqueue can prevent automatic response |
| Best-effort input/authentication race | Deterministic actual SDK tests deliberately hold human input/authentication, deliver authorized findings first and observe the human prompt fail while the agent is not messaging-aborted | **Observed accepted limitation, not fixed or certified input priority** |
| Existing features/package | Full default suite, strict typecheck, installed isolated CLI, installer/load graph, package content exclusion and diff/docs checks | Supplied logs are coordinator evidence, not independent reviewer execution |

No claim/ACK/dequeue/mark_read occurs, even after durable intent/context. Inspected/unselected/automatic messages keep native states unchanged. Production and isolated-CLI contracts require only send/list/settings; no lease/native-poll/read primitives or event subscriber remain. Retired import is explicitly tested to open no dialog or create context/model work, while historical receipts remain conservative replay fences. Native queued/read, durable intent, persisted context, model processing and verified task completion are distinct.

## Live smoke and launch-ID regression

The first live smoke failed during native launch with a socket-close error and no established reviewer startup. A later explicitly authorized traced attempt did launch a reviewer, but default CLI JSON returned only short refs: `created` was empty and automatic return was correctly refused for a missing surface UUID. Neither attempt is an automatic-return pass; renderer `not_started` alone is not proof of no Pi process.

The ID-format defect is reproduced by assertions against the actual installed CLI on an isolated fake socket. Creation now requests both refs and UUIDs for workspace/split/tab paths; regressions verify exact full IDs, retained short refs, return setup and unchanged failure/no-retry guards. A subsequent explicitly authorized no-trace live smoke on Pi1.4.0/cmux0.65.2 did return findings automatically and trigger parent processing. It predates tracing removal and this polling/manual-API cleanup: it is a historical bounded happy path, not fresh physical certification of the simplified source. Existing peers and native messages are not modified/re-authorized automatically.

## Historical evidence — not current acceptance

Steps01–07/14 and rejected08 belong to retired automatic preemption. Completed09–12 and pending/unaccepted13 describe the previous manual-only snapshot. Historical two-Pi captures observed send/reply/thread/wake/progress on cmux0.65.2(111)/Pi1.3.0 but do not certify current scoped follow-up delivery. Old reports/receipts are preserved, not rewritten or relabeled passes. The earlier13 reviewer never launched because dispatch preflight rejected; no independent report exists for that attempt or the current version.

## Optional native transport fixture — separate authorization

`PI_CMUX_MESSAGES_LIVE=1 node --test tests/cmux-messaging-live.test.mjs` creates one disposable native terminal, sends to it, checks repeated read-only lists preserve queued state and closes that exact fixture. It starts no Pi and performs no claim/ACK/mark-read, but **does open a real surface and write a fixture message**. It is transport-only and must not run without explicit permission. Default skips are not passes; ordinary validation does not authorize it.

## Broader physical/native acceptance — still incomplete

Separately authorize live scope first: exact peers/tasks/versions/snapshot, allowable model use, message limits and cleanup. The user decides when to load/reload; never inject prompts/confirmation, navigate, reload or close existing peers on their behalf. Existing panes may still run old code.

1. Ask for a bounded fresh review with findings returned; confirm exact launch identities/request and explicit return option. Creation is not readiness. Verify the child actually sends concise findings, parent validates live identity and native send returns promptly.
2. Keep parent busy with user work/draft and then an extension dialog. Accumulate findings from one/multiple authorized children. Verify no steering/cancellation/editor mutation, quiet progress and follow-up only after eligible completion. Check native states remain unchanged. Record queue/cost/processing evidence separately.
3. While idle, send authorized findings and verify automatic response without manual import/prompt. Contrast unrelated/stale traffic and related-only independent launch: neither should wake. Do not test the known preflight collision against irreplaceable real user work; synthetic reproduction documents it.
4. Confirm inbox/status controls remain read-only and retired import is rejected without dialogs/context/model work. Historical manual/wake records and automatic intent without verified context must suppress reinsertion, not restore authority or silently become processing confirmation.
5. Under separate bounded scope, test abort/off/expiry/reload/branch/session changes and native receiving/crash/retention/oversize failures with disposable fixtures, never the user's actual settings/queues. Already accepted SDK items follow host semantics; no strong cancellation/retraction claim. Manual-compaction behavior is not certified by the current fixtures.
6. Record exact source, versions, endpoints/request/message IDs, durable intent/context/native state, actual model usage and cleanup limitations. Do not force closure or erase unknown work. Missing observations remain **unverified**.

## Review and release boundary

Current validation covers scoped follow-up implementation plus explicit missing physical/native evidence. No independent reviewer is launched by validation, and no historical review certifies this version. Any later review requires its own explicit selection and the identified integrated snapshot/requirements/evidence, not implementation conversation or a suggested verdict. Findings never authorize fixes. Global install/settings, SDK patches, worker registry/cancellation/refill, live probes/cleanup, commit/push/release remain separate scope.
