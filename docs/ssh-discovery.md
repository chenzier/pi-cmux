# SSH destination discovery

Discovery returns suggestions, never target selection/readiness. The bundle registers `ssh_discover` without scanning at startup. Current explicit discovery/connection clarification and enabled controls are required. No host registry or picker is introduced.

## API

```ts
const result = await discoverSshDestinations({
  enabled: true,
  homeDirectory: fixtureHome, // default: homedir()
  configPath: fixtureConfig,  // default: <home>/.ssh/config
  discoverConfig: true,
  discoverCmux: true,
  listWorkspaces: async () => suppliedWorkspaceListJson,
  limits: { candidates: 64 }, // lower hard limits only
});
```

Returns frozen `{candidates, diagnostics, partial}`. Alias candidates contain kind/destination; connections add workspace UUID, enabled/SSH/connected fields and an optional recognized backend. Diagnostics are fixed codes, never paths, config excerpts or raw errors. Partial indicates limitations, not readiness/completeness.

`discoverSshConfig` returns `{aliases, diagnostics, partial}` without cmux. Unless `enabled === true`, both APIs return without I/O. Source controls skip that source. Always accept valid manual destinations independently of discovery.

## Config subset

- Collect concrete Host tokens; support whitespace, quotes, comments and optional directive `=`. Collapse exact duplicates without resolving/lowercasing aliases.
- Skip wildcard/invalid tokens and entire negated Host lines. `user@host` is a manual destination, not a discovered Host pattern.
- Never reconstruct identity/port/ProxyJump options or evaluate Match/ProxyCommand. No `ssh -G`, shell, network probe, key/known_hosts read or model call.
- Includes resolve beneath the trusted home's `.ssh`, relative to that root—not the fragment directory. Support `~/`, literal config/`.conf` files and sorted basename `*`/`?` globs. Refuse external paths, substituted/directory globs, key/private paths and key-like filenames before opening.
- Skip conditional/unknown Includes. Included Host/Match context propagates outward; a glob may therefore return only its first fragment with a partial diagnostic. Failures also leave unknown context. Later concrete Host lines can still be collected. Cycles are detected.

## Bounds and filesystem

| Resource | Hard maximum |
|---|---:|
| Include depth / file visits | 8 / 32 |
| Per-file / aggregate bytes | 64 KiB / 256 KiB |
| Lines / candidates | 8,192 / 256 |
| Glob directory entries / cmux rows | 256 / 256 |

Options only lower positive integer limits. Reads use lstat, no-follow/nonblocking open where available, descriptor regular-file checks and bounded buffers with one overflow byte. Symlinks below/at the configured root are refused. Ancestors above it remain trusted; component checks cannot prevent adversarial replacement races. No recursive home/root scan occurs.

## cmux subset

The callback is invoked at most once and supplies decoded workspace.list JSON:

```json
{"workspaces":[{"id":"01234567-89ab-cdef-0123-456789abcdef","remote":{"enabled":true,"transport":"ssh","destination":"work","backend":"cmux-tui","connected":true}}]}
```

Accept backend `cmux-tui`, `native-ssh`, `legacy-relay`, `tmux-mirror`, or absent legacy backend; never infer activation support. Normalize workspace UUID case. Disabled rows are ignored; disconnected enabled rows remain suggestions. Conflicting rows suppress that workspace, even after the candidate cap is reached. Config aliases have priority.

Malformed rows/wrappers/backends and unavailable/oversized inventory produce diagnostics. Accessors are refused; unknown fields, titles, commands and cwd are discarded. The callback owns finite completion and transport/payload bounds; this library has no callback timeout/cancellation contract. It never calls cmux itself or queries remotes/team registries.

## Verification

`tests/cmux-ssh-discovery.test.mjs` uses synthetic config trees and injected inventory to cover parsing, Includes, bounds, symlinks, redaction, disablement, conflicts and manual destinations. No user config scan or live host is needed.
