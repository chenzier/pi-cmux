# SSH transport and core tools

`registerSshAdapter(pi, options)` returns one shared `SshExecutionAdapter` per Pi API. The bundle registers it without connecting, using Pi 1.3.0 pluggable operations—not the installed example's private state. See [activation and controls](ssh.md).

## Routing

Inactive sessions use local tools. Configured/disconnected/disabled/invalid SSH intent cannot fall back locally. Each remote workflow holds an immutable session/generation ticket, checked before effects and after awaits. Replacement, lifecycle changes and disablement revoke tickets.

File paths resolve lexically against remote cwd; closures bypass Pi's local path expansion. No local-prefix, home or environment substitution occurs. Read MIME detection caches at most one bounded file. Write/edit workflows reject overlap; external remote writers are not locked, so edits are not distributed transactions.

Only the four core tools and user `!`/`!!` use SSH. Other tools/extensions, instruction discovery, credentials and output spools remain local. Remote project instructions/extensions are not loaded automatically.

## Transport

Each request spawns one local `/usr/bin/ssh` without a local shell. Paths/programs are single-quoted; content travels on stdin in 64 KiB chunks with backpressure. The remote needs an account shell, `/bin/bash`, `cat`, `mkdir`, `test` and POSIX `wc`.

OpenSSH retains alias/identity/port/ProxyJump semantics. Enforced options disable interactive passwords, forwarding, control-socket reuse, local-command hooks and SendEnv; host trust must already exist. Config helpers and account startup remain trusted behavior, not a sandbox. The inner bash clears BASH_ENV/ENV and disables profiles/rc files.

The local SSH environment is whitelisted. Remote commands receive neither Mac PATH nor local cwd/session environment. Bash deliberately executes user shell text. Exit statuses are preserved; 255 is conservatively treated as connection/authentication failure.

| Limit | Maximum |
|---|---:|
| Write input | 32 MiB |
| Combined raw stdout/stderr per request | 16 MiB |
| Generated command | 128 KiB |
| Default deadline | 60 seconds |
| Bash deadline cap | 10 minutes |
| Whole file workflow | 60 seconds |

Framing/stderr consume output budget. Oversized files fail; use bounded bash output instead.

## File integrity

Cwd validation requires empty stdout. File replies and the fixed remote-home query have a fresh nonce, canonical decimal byte length, raw payload and exact trailer. Home lookup is capped at 20 KiB of raw output and validates strict UTF-8 plus an absolute path before selection; it never expands a local home. Reads/MIME/edits consume verified bytes only; acknowledgements must have zero payload. Prefixes, suffixes, extra/truncated frames, wrong markers and malformed lengths are rejected, never stripped.

Protocol errors revoke only the current dispatch generation. Invalid mutation acknowledgements mean effects may already have occurred; no retry or rollback follows. Framing uses no remote temporary file or encoding utility. Length counting and payload transfer are separate reads; changing-size files/streams can fail verification. This detects contamination, not malicious-host behavior or concurrent-writer races.

## Validation and cancellation

`resolveHome(destination, signal, assertAuthorized)` revokes prior dispatch and persists destination-only pending intent. It returns an absolute target plus a fence the caller must check immediately before activation, with no intervening await. Failure/reload cannot make pending intent local or restore an older target.

`probeValidation(signal, assertAuthorized)` remains non-ready. Its single-use probe commits synchronously after final cancellation/authority checks; callers must commit or discard. Revoked grants abort pending validation; stale settlement cannot affect a newer ticket.

Associated targets require trusted observation during validation/before operations. Missing/mismatched evidence refuses effects; waits are bounded. Native observation and effects are not atomic.

Cancellation, timeout and output-limit terminate local SSH, escalating after 250 ms. This does not prove remote descendants stopped or effects rolled back. Connection/spawn/timeout failures revoke current readiness; cancellation/output-limit/callback failures do not necessarily do so. Stale failures cannot disconnect a replacement. There is no automatic retry/reconnect.

## Evidence

Transport/adapter/protocol/integration tests use injected endpoints, local bash and isolated roots. They cover quoting, binary/Unicode data, noise, malformed frames, cancellation, stale authority and uncertain acknowledgements. [Post-fix native evidence](ssh-postfix-validation.md) covers a clean real endpoint only; live noise/cancellation and remote quiescence are not established.
