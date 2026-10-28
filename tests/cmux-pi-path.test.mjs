import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { test } from "node:test";
import { buildPiCommand, buildShellCommand, shellEscape } from "../extensions/cmux-core.ts";
import { openPiSession } from "../extensions/cmux-pi.ts";
import { orientationHarness } from "./helpers/orientation.mjs";
import { effectiveCommand } from "./helpers/launch-command.mjs";

const MODE = "PI_CMUX_PI_PATH_MODE";
function environment(t, values) {
 const saved = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]]));
 for (const [key, value] of Object.entries(values)) {
  if (value === undefined) delete process.env[key]; else process.env[key] = value;
 }
 t.after(() => { for (const [key, value] of Object.entries(saved)) {
  if (value === undefined) delete process.env[key]; else process.env[key] = value;
 } });
}
function fixture(t, together = false) {
 const root = realpathSync(mkdtempSync(join(tmpdir(), "pi-cmux-path-")));
 t.after(() => rmSync(root, { recursive: true, force: true }));
 const piDir = join(root, "pi's $HOME $(printf wrong) `printf wrong`; 日本語"), nodeDir = together ? piDir : join(root, "node's tools");
 const cwd = join(root, "child's project"), nativeDir = join(root, "native tools");
 for (const dir of new Set([piDir, nodeDir, cwd, nativeDir])) mkdirSync(dir);
 const pi = join(piDir, "pi");
 writeFileSync(pi, '#!/usr/bin/env node\nconsole.log(JSON.stringify({cwd:process.cwd(),args:process.argv.slice(2),path:process.env.PATH,mode:process.env.PI_CMUX_PI_PATH_MODE}));\n', { mode: 0o755 });
 symlinkSync(process.execPath, join(nodeDir, "node"));
 writeFileSync(join(nativeDir, "pi"), "#!/bin/sh\nexit 99\n", { mode: 0o755 });
 const parentOnly = join(root, "parent-only"); mkdirSync(parentOnly);
 const callerPath = [piDir, nodeDir, parentOnly, "/usr/bin", "/bin"].join(":");
 environment(t, { PATH: callerPath, [MODE]: "minimal" });
 return { root, piDir, nodeDir, cwd, nativeDir, parentOnly, callerPath, pi };
}
function execute(command, path) {
 const env = { ...process.env };
 if (path === undefined) delete env.PATH; else env.PATH = path;
 delete env[MODE]; // cmux need not inherit the launching Pi's mode override.
 const result = spawnSync("/bin/sh", ["-c", command], { env, encoding: "utf8", timeout: 10_000 });
 assert.ifError(result.error); assert.equal(result.status, 0, result.stderr); assert.equal(result.stderr, "");
 return JSON.parse(result.stdout);
}

for (const together of [false, true]) for (const native of ["normal", "empty", "unset"]) {
 test(`minimal Pi PATH preserves native entries and quotes resolved executables: together=${together}, native=${native}`, t => {
  const h = fixture(t, together), nativePath = native === "normal" ? `${h.nativeDir}:/usr/bin:/bin` : native === "empty" ? "" : undefined;
  const options = { prompt: "--help; $HOME\n'quoted' 日本語", sessionFile: "/tmp/session's file.jsonl", provider: "test", model: "test/model", thinking: "high", orientationBootstrap: "synthetic_bootstrap" };
  const command = buildPiCommand(h.cwd, options), captured = execute(command, nativePath);
  assert.equal(captured.cwd, h.cwd);
  assert.deepEqual(captured.args, ["--session", options.sessionFile, "--provider", "test", "--model", "test/model", "--thinking", "high", "--", options.prompt]);
  const prefix = [...new Set([h.piDir, h.nodeDir])].join(":");
  if (native !== "unset") assert.equal(captured.path, prefix + (nativePath ? ":" + nativePath : ""));
  else { assert.ok(captured.path.startsWith(prefix)); assert.ok(!captured.path.endsWith(":")); }
  assert.equal(captured.mode, "minimal", "child keeps minimal mode for subsequent local Pi launches");
  assert.ok(!captured.path.includes(h.parentOnly));
  assert.ok(command.includes(`exec ${shellEscape(h.pi)}`), "invoke the resolved Pi, not a child-environment shadow");
  assert.ok(!command.includes(h.parentOnly));
 });
}

for (const mode of [undefined, "", "  ", "minimal"]) test(`Pi PATH defaults to minimal: mode=${JSON.stringify(mode)}`, t => {
 const h = fixture(t); if (mode === undefined) delete process.env[MODE]; else process.env[MODE] = mode;
 const captured = execute(buildPiCommand(h.cwd, { prompt: "Review" }), "");
 assert.equal(captured.path, `${h.piDir}:${h.nodeDir}`);
 assert.equal(captured.mode, "minimal");
 assert.ok(!captured.path.includes(h.parentOnly));
 assert.deepEqual(captured.args, ["--", "Review"]);
});

for (const mode of ["full", " FULL "]) test(`full PATH compatibility requires an explicit opt-out: mode=${JSON.stringify(mode)}`, t => {
 const h = fixture(t); process.env[MODE] = mode;
 const captured = execute(buildPiCommand(h.cwd, { prompt: "Review" }), "");
 assert.equal(captured.path, h.callerPath);
 assert.equal(captured.mode, "full", "propagate the opt-out even when cmux has no mode override");
 assert.deepEqual(captured.args, ["--", "Review"]);
});

test("helper terminals keep the full caller PATH even when minimal Pi mode is enabled", t => {
 const h = fixture(t);
 const captured = execute(buildShellCommand(h.cwd, `${shellEscape(h.pi)} -- helper`), "/usr/bin:/bin");
 assert.equal(captured.path, h.callerPath);
 assert.deepEqual(captured.args, ["--", "helper"]);
});

test("relative caller PATH entries resolve before switching to the child project", t => {
 const h = fixture(t);
 process.env.PATH = [relative(process.cwd(), h.piDir), relative(process.cwd(), h.nodeDir)].join(":");
 const captured = execute(buildPiCommand(h.cwd), "");
 assert.equal(captured.cwd, h.cwd);
 assert.equal(captured.path, `${h.piDir}:${h.nodeDir}`);
});

test("minimal resolution skips directories, non-executable files and broken links", t => {
 const h = fixture(t), invalid = join(h.root, "invalid"); mkdirSync(invalid);
 mkdirSync(join(invalid, "pi")); symlinkSync(join(h.root, "missing"), join(invalid, "node"));
 const denied = join(h.root, "denied"); mkdirSync(denied);
 for (const name of ["pi", "node"]) { writeFileSync(join(denied, name), "not executable"); chmodSync(join(denied, name), 0o600); }
 process.env.PATH = [invalid, denied, h.piDir, h.nodeDir].join(":");
 const captured = execute(buildPiCommand(h.cwd), "");
 assert.equal(captured.path, `${h.piDir}:${h.nodeDir}`);
});

for (const missing of ["pi", "node"]) test(`minimal mode refuses missing ${missing} before creating a surface`, async t => {
 const h = fixture(t), o = orientationHarness(t); await o.emit("session_start");
 process.env.PATH = missing === "pi" ? h.nodeDir : h.piDir;
 await assert.rejects(openPiSession(o.pi, h.cwd, { role: "review" }), new RegExp(`minimal Pi PATH.*${missing}`, "i"));
 assert.equal(o.calls.some(c => c.args.includes("create") || c.args.includes("new-split") || c.args.includes("new-surface") || c.args.includes("respawn-pane")), false);
});

test("invalid Pi PATH mode fails closed without changing helper command behavior", t => {
 const h = fixture(t); process.env[MODE] = "mini";
 assert.throws(() => buildPiCommand(h.cwd), /PI_CMUX_PI_PATH_MODE/);
 assert.equal(execute(buildShellCommand(h.cwd, `${shellEscape(h.pi)} -- helper`), "").path, h.callerPath);
});

for (const placement of ["workspace", "right", "down", "tab"]) test(`default minimal mode reaches the shared ${placement} Pi launch path without a real child`, async t => {
 const h = fixture(t), o = orientationHarness(t); await o.emit("session_start");
 delete process.env[MODE];
 const result = await openPiSession(o.pi, h.cwd, { placement, role: "review", prompt: "Review only", focus: false });
 assert.equal(result.ok, true);
 const call = o.calls.find(c => c.args[0] === "respawn-pane");
 assert.ok(call);
 const launched = effectiveCommand(call.args.at(-1));
 assert.ok(launched.includes(`exec ${shellEscape(h.pi)}`));
 assert.ok(!launched.includes(h.parentOnly));
 assert.equal(result.orientation.origin.target.surfaceId, o.location.surfaceId);
});

test("minimal mode removes long parent PATH entries from serialized launch requests", t => {
 const h = fixture(t), unused = "unused-parent-path-" + "x".repeat(1200);
 delete process.env[MODE];
 process.env.PATH += ":/" + unused;
 const minimal = buildPiCommand(h.cwd, { prompt: "Read the brief" });
 process.env[MODE] = "full";
 const full = buildPiCommand(h.cwd, { prompt: "Read the brief" });
 const bytes = command => Buffer.byteLength(JSON.stringify({ method: "surface.respawn", params: { command, tmux_start_command: command } }));
 assert.ok(!minimal.includes(unused));
 assert.ok(bytes(full) - bytes(minimal) > 2000);
 assert.ok(bytes(minimal) < 4096, "short fixture fits; this is not a universal launch-size guarantee");
});
