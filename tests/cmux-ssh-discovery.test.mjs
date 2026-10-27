import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverSshConfig } from "../lib/ssh/config-discovery.ts";
import { discoverSshDestinations } from "../lib/ssh/discovery.ts";
import { parseSshTarget } from "../lib/ssh/target.ts";

async function fixture(t, files = {}) {
  const homeDirectory = await fs.mkdtemp(join(tmpdir(), "pi-ssh-discovery-"));
  t.after(() => fs.rm(homeDirectory, { recursive: true, force: true }));
  const directory = join(homeDirectory, ".ssh");
  await fs.mkdir(directory);
  for (const [name, content] of Object.entries(files)) {
    await fs.mkdir(join(directory, name, ".."), { recursive: true });
    await fs.writeFile(join(directory, name), content);
  }
  return { enabled: true, homeDirectory, configPath: join(directory, "config"), directory };
}
const aliases = result => result.aliases.map(candidate => candidate.destination);
const uuid = "01234567-89ab-cdef-0123-456789abcdef";
const connection = (extra = {}) => ({ id: uuid, title: "SECRET TITLE", current_directory: "/SECRET-CWD",
  remote: { enabled: true, transport: "ssh", backend: "cmux-tui", connected: true,
    destination: "production", port: 2222, identity_file: "SECRET KEY", ...extra } });
// The built-in ESM named imports are synchronized so this checks actual open calls,
// not just whether the parser happened to suppress a candidate after reading it.
async function spyOperations(overrides, run) {
  const previous = {};
  try {
    for (const [key, value] of Object.entries(overrides)) { previous[key] = fs[key]; fs[key] = value; }
    syncBuiltinESMExports();
    return await run();
  } finally {
    Object.assign(fs, previous);
    syncBuiltinESMExports();
  }
}

test("disabled discovery has zero filesystem/callback I/O", async () => {
  const fail = () => { throw new Error("unexpected I/O"); };
  await spyOperations({ open: fail, lstat: fail, opendir: fail }, async () => {
    const result = await discoverSshDestinations({ enabled: false, listWorkspaces: fail });
    assert.deepEqual(result, { candidates: [], diagnostics: [], partial: false });
    assert.deepEqual(aliases(await discoverSshConfig({ enabled: false })), []);
  });
});

test("missing and unreadable configuration returns sanitized partial results", async t => {
  const options = await fixture(t);
  assert.deepEqual((await discoverSshConfig(options)).diagnostics, ["config-unavailable"]);
  await fs.writeFile(options.configPath, "Host hidden\n");
  await spyOperations({ open: async () => { throw new Error("SECRET permission failure"); } }, async () => {
    const result = await discoverSshConfig(options);
    assert.deepEqual(result.diagnostics, ["config-unavailable"]);
    assert.equal(JSON.stringify(result).includes("SECRET"), false);
  });
});

test("literal aliases, quotes, comments, key=value, duplicates and inert commands", async t => {
  const options = await fixture(t, { config: `# comment
Host=alpha "beta" 'gamma' alpha # trailing
User secret-user
HostName secret-host
IdentityFile /SECRET-KEY
ProxyCommand sh -c 'touch /SECRET-MARKER'
Host *.example !excluded ?bad bad* -option "two words"
Host user@box 192.0.2.1 ::1
Match exec "touch /SECRET-MARKER"
Host delta
` });
  const result = await discoverSshConfig(options);
  assert.deepEqual(aliases(result), ["alpha", "beta", "gamma", "192.0.2.1", "::1", "delta"]);
  assert.ok(result.diagnostics.includes("alias-skipped"));
  assert.ok(result.diagnostics.includes("unsupported-syntax"));
  assert.equal(JSON.stringify(result).includes("SECRET"), false);
  assert.ok(Object.isFrozen(result) && Object.isFrozen(result.aliases) && Object.isFrozen(result.aliases[0]));
});

test("Includes use user-config base and carry Host context back to caller", async t => {
  const options = await fixture(t, {
    config: "Include conf.d/first.conf\nInclude hidden.conf\nHost outer\n",
    "conf.d/first.conf": "Include second.conf\nHost inner\n",
    "second.conf": "User ignored\n", "hidden.conf": "Host must-not-discover\n",
    "conf.d/second.conf": "Host wrong-relative-base\n",
  });
  const result = await discoverSshConfig(options);
  assert.deepEqual(aliases(result), ["inner", "outer"]);
  assert.ok(result.diagnostics.includes("conditional-include"));
});

test("a custom root file still resolves user Includes against home/.ssh", async t => {
  const options = await fixture(t, {
    "nested/custom.conf": "Include fragment.conf\nHost outer\n",
    "fragment.conf": "Host from-user-base\n",
    "nested/fragment.conf": "Host wrong-config-parent\n",
  });
  const result = await discoverSshConfig({ ...options, configPath: join(options.directory, "nested", "custom.conf") });
  assert.deepEqual(aliases(result), ["from-user-base", "outer"]);
});

test("Match context, including included Match, never evaluates or guesses Includes", async t => {
  const options = await fixture(t, {
    config: "Include fragment.conf\nInclude hidden.conf\nHost visible\nInclude hidden.conf\n",
    "fragment.conf": 'Match exec "SECRET COMMAND"\n', "hidden.conf": "Host hidden\n",
  });
  const result = await discoverSshConfig(options);
  assert.deepEqual(aliases(result), ["visible"]);
  assert.ok(result.partial);
  assert.equal(JSON.stringify(result).includes("SECRET"), false);
});

test("cycles, depth, files, bytes, lines and candidates are bounded", async t => {
  const options = await fixture(t, {
    config: "Include a.conf\nHost root\n", "a.conf": "Include b.conf\nHost a\n",
    "b.conf": "Include a.conf\nHost b\n",
  });
  assert.ok((await discoverSshConfig(options)).diagnostics.includes("include-cycle"));
  for (const [limits, code] of [
    [{ depth: 1 }, "depth-limit"], [{ files: 1 }, "file-limit"],
    [{ fileBytes: 4 }, "byte-limit"], [{ totalBytes: 4 }, "byte-limit"],
    [{ lines: 1 }, "line-limit"], [{ candidates: 1 }, "candidate-limit"],
  ]) assert.ok((await discoverSshConfig({ ...options, limits })).diagnostics.includes(code), code);
});

test("glob subset is bounded, sorted, and conservatively stops after context changes", async t => {
  const options = await fixture(t, {
    config: "Include conf.d/*.conf\n", "conf.d/a.conf": "Host first\n", "conf.d/b.conf": "Host second\n",
  });
  const result = await discoverSshConfig(options);
  assert.deepEqual(aliases(result), ["first"]);
  assert.ok(result.diagnostics.includes("conditional-include"));
  assert.ok((await discoverSshConfig({ ...options, limits: { directoryEntries: 1 } })).diagnostics.includes("directory-limit"));
});

test("symlinks and key-like/outside Includes rejected before opening", async t => {
  const options = await fixture(t, {
    config: "Include id_ed25519 id_rsa.conf known_hosts known_hosts.conf public.pub secret.key secret.pem ../outside.conf $HOME/x.conf %h.conf linked.conf linked-dir/safe.conf\nHost visible\n",
    "id_rsa.conf": "SECRET KEY", "known_hosts.conf": "SECRET HOSTS", "safe.conf": "Host forbidden\n",
    "keys/safe.conf": "Host forbidden\n",
  });
  await fs.symlink(join(options.directory, "safe.conf"), join(options.directory, "linked.conf"));
  await fs.symlink(join(options.directory, "keys"), join(options.directory, "linked-dir"));
  const original = fs.open;
  for (const path of ["id_ed25519", "id_rsa.conf", "known_hosts", "known_hosts.conf", "public.pub", "secret.key", "secret.pem",
    "../outside.conf", "$HOME/x.conf", "%h.conf", "linked.conf", "linked-dir/safe.conf", "keys/safe.conf"]) {
    await fs.writeFile(options.configPath, `Include ${path}\nHost visible\n`);
    const opened = [];
    await spyOperations({ open: async (...args) => { opened.push(args[0]); return original(...args); } }, async () => {
      const result = await discoverSshConfig(options);
      assert.deepEqual(aliases(result), ["visible"], path);
      assert.ok(result.diagnostics.includes("unsafe-path"), path);
    });
    assert.deepEqual(opened, [options.configPath], path);
  }
});

test("cmux unavailable/malformed metadata is partial, no raw fallback", async () => {
  const base = { enabled: true, discoverConfig: false };
  assert.deepEqual((await discoverSshDestinations(base)).diagnostics, ["cmux-unavailable"]);
  assert.deepEqual((await discoverSshDestinations({ ...base, listWorkspaces: () => { throw new Error("SECRET"); } })).diagnostics, ["cmux-unavailable"]);
  for (const payload of [null, "SECRET raw text", [], { workspaces: [{}] },
    { workspaces: [connection({ destination: "-unsafe" })] },
    { workspaces: [{ ...connection(), id: "not-a-uuid" }] },
    { workspaces: [connection({ backend: "unknown" })] }]) {
    const result = await discoverSshDestinations({ ...base, listWorkspaces: () => payload });
    assert.deepEqual(result.candidates, []);
    assert.deepEqual(result.diagnostics, ["cmux-malformed"]);
    assert.equal(JSON.stringify(result).includes("SECRET"), false);
  }
});

test("cmux whitelist, duplicates, frozen output, disconnected suggestions and source disable", async t => {
  const options = await fixture(t, { config: "Host production\n" });
  let calls = 0;
  const listWorkspaces = () => { calls++; return { workspaces: [connection(), connection(),
    { ...connection({ connected: false }), id: "11111111-1111-1111-1111-111111111111" },
    { remote: { enabled: false }, title: "SECRET" }] }; };
  const result = await discoverSshDestinations({ ...options, listWorkspaces });
  assert.equal(calls, 1);
  assert.equal(result.candidates.length, 3);
  assert.equal(result.partial, false);
  assert.deepEqual(Object.keys(result.candidates[1]).sort(), ["backend", "connected", "destination", "enabled", "kind", "transport", "workspaceId"].sort());
  assert.equal(result.candidates[2].connected, false);
  assert.equal(JSON.stringify(result).includes("SECRET"), false);
  assert.ok(result.candidates.every(Object.isFrozen));
  assert.ok(Object.isFrozen(result.candidates) && Object.isFrozen(result.diagnostics));
  await discoverSshDestinations({ ...options, discoverCmux: false, listWorkspaces });
  assert.equal(calls, 1);
  await spyOperations({ open: () => { throw new Error("must not read config"); } }, async () => {
    assert.equal((await discoverSshDestinations({ ...options, discoverConfig: false, listWorkspaces })).partial, false);
  });
});

test("workspace/candidate bounds and data accessors", async () => {
  const base = { enabled: true, discoverConfig: false };
  const many = Array.from({ length: 257 }, () => connection());
  assert.ok((await discoverSshDestinations({ ...base, listWorkspaces: () => ({ workspaces: many }) })).diagnostics.includes("workspace-limit"));
  const distinct = [connection(), { ...connection(), id: "11111111-1111-1111-1111-111111111111" }];
  assert.ok((await discoverSshDestinations({ ...base, limits: { candidates: 1 }, listWorkspaces: () => ({ workspaces: distinct }) })).diagnostics.includes("candidate-limit"));
  const payload = Object.defineProperty({}, "workspaces", { get() { throw new Error("must not invoke getter"); } });
  assert.deepEqual((await discoverSshDestinations({ ...base, listWorkspaces: () => payload })).diagnostics, ["cmux-malformed"]);
});

test("negated Host lists do not invent aliases excluded by their own block", async t => {
  const options = await fixture(t, { config: "Host excluded !excluded\nHost hidden !*\nHost user@box\nHost visible\n" });
  const result = await discoverSshConfig(options);
  assert.deepEqual(aliases(result), ["visible"]);
  assert.ok(result.diagnostics.includes("alias-skipped"));
});

test("legacy cmux SSH rows remain useful without an exposed backend", async () => {
  const row = connection();
  delete row.remote.backend;
  const result = await discoverSshDestinations({
    enabled: true, discoverConfig: false, listWorkspaces: () => ({ workspaces: [row] }),
  });
  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0].destination, "production");
  assert.equal(Object.hasOwn(result.candidates[0], "backend"), false, "discovery must not guess a backend");
  assert.equal(result.partial, false);
  assert.equal(JSON.stringify(result).includes("SECRET"), false);
});

test("conflicting identities for the same cmux workspace are not selectable suggestions", async () => {
  for (const conflicting of [connection({ destination: "other-host" }), connection({ backend: "legacy-relay" }), connection({ connected: false }), connection({ backend: "unknown" }), connection({ enabled: false })]) {
    const result = await discoverSshDestinations({
      enabled: true, discoverConfig: false,
      listWorkspaces: () => ({ workspaces: [connection(), conflicting, connection()] }),
    });
    assert.deepEqual(result.candidates, []);
    assert.ok(result.diagnostics.includes("cmux-malformed"));
  }
});

test("a full candidate list cannot hide a later workspace conflict", async () => {
  const result = await discoverSshDestinations({
    enabled: true, discoverConfig: false, limits: { candidates: 1 },
    listWorkspaces: () => ({ workspaces: [connection(), connection({ destination: "conflict" }),
      { ...connection(), id: "11111111-1111-1111-1111-111111111111" }] }),
  });
  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0].workspaceId, "11111111-1111-1111-1111-111111111111");
  assert.ok(result.diagnostics.includes("cmux-malformed"));
});

test("manual destinations remain independent of missing discovery inventory", async t => {
  const options = await fixture(t);
  const result = await discoverSshDestinations({ ...options, listWorkspaces: () => ({ workspaces: [] }) });
  assert.deepEqual(result.candidates, []);
  assert.deepEqual(parseSshTarget({ destination: "manual-only", remoteCwd: "/srv/project" }),
    { destination: "manual-only", remoteCwd: "/srv/project" });
  assert.throws(() => parseSshTarget({ destination: "-unsafe", remoteCwd: "/srv/project" }));
});
