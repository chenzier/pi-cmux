# Experimental SSH execution

Pi, credentials, session files and other extensions stay local. Only `read`, `write`, `edit`, `bash` and user `!`/`!!` commands use the bound SSH target. Registration does not connect or scan config. Do not load another core-tool/SSH adapter alongside this one.

## Connect

```text
Connect to javi
Connect to javi in ~
Connect to javi in /srv/project
Connect to javi in "/srv/project with spaces"
```

Use a direct idle interactive/RPC prompt. The destination is required; omitting the directory defaults to the remote account's home, as does an explicit `~`. The connector resolves the remote `HOME`, then stores and validates its absolute path—never your Mac's home. Other directory values must be absolute; `~/project` and `~user` require clarification rather than silently falling back to home. Complete requests proceed without a picker or extra yes/no gate; an unresolved destination or invalid explicit path asks one question. Aliases, manual hosts/IPs and `user@host` are accepted. Discovery suggests but never selects.

The input parser supports simple English/Spanish requests and literal follow-up answers, not arbitrary phrasing. Quoted requests, expanded file content, peers, streaming steering and saved state grant no connection. For an unrecognized request, use:

```text
/ssh-bind {"destination":"javi"}
/ssh-bind {"destination":"javi","remoteCwd":"/srv/project"}
/ssh-validate
/ssh-clear
```

Bind selects/validates; validate explicitly rechecks a resolved saved target; clear returns core tools to local execution. Home requests perform one bounded home lookup and one cwd validation, not retries. While resolving home, prior dispatch is revoked and only pending destination intent is saved. Failure or reload in that phase remains blocked until a fresh connection request or explicit clear; it cannot restore an older target or fall back locally. Resume and child launches restore resolved targets as **configured**, never ready. Failed connection attempts need a new request.

## Authentication and aliases

Configure OpenSSH keys/agent and host trust outside chat. Never paste passwords, private keys or passphrases. Connections are noninteractive; no key setup or automatic retry occurs. Trusted SSH config helpers/account startup still apply.

```text
Save alias work for dev@host.example port 2222
```

Alias saving is separate and optional. Pi shows the exact addition to `~/.ssh/config` and requires fresh confirmation; declining does not block a requested one-off connection. Identical aliases need no prompt. Rich/unsafe/conflicting config is refused. No host registry is created. See [save safeguards](ssh-connect.md#alias-saving).

## Controls

Set before starting Pi:

| Variable | Default | `0` disables |
|---|---|---|
| `PI_CMUX_SSH` | `1` | Connections, validation, discovery and saves |
| `PI_CMUX_SSH_DISCOVERY` | `1` | Config/cmux suggestions only |
| `PI_CMUX_SSH_ALIAS_SAVE` | `1` | Alias saves only |

Disabled sessions without remote intent stay local; saved remote intent stays blocked until explicitly cleared or revalidated after enablement.

## Helpers and children

Ready SSH sessions default helpers to remote cwd/PATH. Use tool `target: "local"` or `/cmt --local k9s` for the Mac; `--remote` requires readiness. Terminal creation is not command completion.

Same-project fresh/related/reviewer tabs/splits keep Pi local and transfer configured-only selection. Host authority is separate from origin navigation and messaging.

## Limits

- Ordinary local cmux workspaces only. Remote-owned/cloud/relay/tmux layouts, SSH sidebar workspace creation, explicit cwd changes, handoffs/worktrees/Git/zoxide and new browser previews are refused. Existing annotation stop/retry and drafts remain available.
- Remote requirements: account shell, `/bin/bash`, `cat`, `mkdir`, `test`, POSIX `wc`, quiet startup stdout. File replies use strict byte framing; unexpected output is refused, not file data.
- File paths are literal POSIX paths; no tilde/environment expansion. The `~` special case applies only to the connection's cwd, not read/write/edit paths. Remote project instructions/extensions are not loaded automatically. Read applicable instruction files as data and establish which guidance applies before changes.
- Cancellation kills local SSH, not necessarily remote descendants. Partial effects are possible; uncertain mutations/creations are never replayed or rolled back automatically.
- Output spools remain local and cannot be opened through remote `read`.

Native evidence covers clean real SSH core operations and historical ordinary-local-workspace helper/child tabs. Splits, persisted child resume/remote execution, live alias UI, default-home resolution, cancellation/noisy-account experiments and later launch-size changes remain unverified. No minimum cmux version is certified for this path.

[Transport](ssh-adapter.md) · [Target contract](ssh-target-contract.md) · [Connection API](ssh-connect.md) · [Discovery](ssh-discovery.md) · [Helpers](ssh-terminal.md) · [Launches](ssh-launch.md) · [Native evidence](ssh-native-validation.md) · [Post-fix evidence](ssh-postfix-validation.md) · [Smoke recipe](ssh-smoke.md)
