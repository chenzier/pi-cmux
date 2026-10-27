import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, statSync, lstatSync, symlinkSync, linkSync, readdirSync, rmSync, realpathSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SshTargetRuntime } from "../lib/ssh/runtime.ts";
import { SshExecutionAdapter } from "../lib/ssh/adapter.ts";
import { createSshConnector } from "../lib/ssh/connect.ts";
import { aliasAddition, createAliasSaver, registerSshAliasSave } from "../lib/ssh/alias-save.ts";

const parameters = { alias: "work", hostname: "work.example", user: "dev", port: 2222 };
function fixture(t, content) {
	// Only isolated fixture config files; never inspect the user's real ~/.ssh/config.
	const home = mkdtempSync(join(realpathSync(tmpdir()), "cmux-alias-save-"));
	t.after(() => rmSync(home, { recursive: true, force: true }));
	const ssh = join(home, ".ssh"), config = join(ssh, "config"); mkdirSync(ssh, { mode: 0o700 });
	if (content !== undefined) writeFileSync(config, content, { mode: 0o640 });
	const entries = [], calls = [], previews = [];
	const runtime = new SshTargetRuntime((type, record) => entries.push({ type, record }));
	runtime.startSession({ sessionId: "fixture", localCwd: "/local" }, []);
	const adapter = new SshExecutionAdapter(runtime, { transport: { async run(request) {
		request.assertCurrent(); calls.push(request); return { exitCode: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
	} } });
	const authority = { currentRequest: () => true };
	const ctx = { cwd: "/local", hasUI: true, signal: undefined, isIdle: () => false, // Model tools execute during an active turn.
		sessionManager: { getSessionId: () => "fixture" },
		ui: { async confirm(title, message) { previews.push({ title, message }); return true; } } };
	return { home, ssh, config, entries, calls, previews, adapter, runtime, authority, ctx,
		save: createAliasSaver(adapter, authority, home) };
}

test("exact preview and fresh trusted UI approval append only, preserve original comments, bytes and permissions", async t => {
	const original = "# user comment\nHost old\n  HostName old.example\n  IdentityFile ~/.ssh/private_existing\n# retained (no final newline)";
	const h = fixture(t, original), before = statSync(h.config);
	await h.save(parameters, h.ctx);
	const addition = "\nHost work\n  HostName work.example\n  User dev\n  Port 2222\n";
	assert.equal(aliasAddition(parameters), addition);
	assert.equal(h.previews.length, 1);
	assert.equal(h.previews[0].message, `Append exactly the following to ~/.ssh/config (including the leading newline):\n\n${addition}`);
	assert.doesNotMatch(h.previews[0].message, /private_existing|old.example/);
	assert.equal(readFileSync(h.config, "utf8"), original + addition);
	const after = statSync(h.config);
	assert.equal(after.ino, before.ino); assert.equal(after.mode, before.mode); assert.equal(after.uid, before.uid);
	assert.deepEqual(readdirSync(h.ssh), ["config"]);
	assert.equal(h.entries.length, 0); assert.equal(h.calls.length, 0); assert.equal(h.runtime.snapshot().state, "inactive");
});

test("missing config uses no-clobber creation with 0600, never creates a registry", async t => {
	const h = fixture(t); await h.save(parameters, h.ctx);
	assert.equal(readFileSync(h.config, "utf8"), aliasAddition(parameters));
	assert.equal(statSync(h.config).mode & 0o777, 0o600);
	assert.deepEqual(readdirSync(h.home), [".ssh"]); assert.deepEqual(readdirSync(h.ssh), ["config"]);
});

test("existing aliases skip save confirmation; conflicting alias is refused without prompting", async t => {
	const h = fixture(t, aliasAddition(parameters));
	h.ctx.ui.confirm = () => assert.fail("Existing aliases need no save prompt");
	assert.match(await h.save(parameters, h.ctx), /already exists/);
	await assert.rejects(h.save({ ...parameters, hostname: "different.example" }, h.ctx));
	assert.equal(readFileSync(h.config, "utf8"), aliasAddition(parameters));
});

test("declining or unanswered preview does not save/bind; declining still permits explicitly requested one-off connect", async t => {
	const h = fixture(t, "# original\n");
	h.ctx.ui.confirm = async () => false;
	assert.match(await h.save(parameters, h.ctx), /not saved/);
	assert.equal(readFileSync(h.config, "utf8"), "# original\n");
	assert.equal(h.entries.length, 0); assert.equal(h.calls.length, 0);
	await createSshConnector(h.adapter, h.authority)({ destination: "dev@work.example", remoteCwd: "/srv/project" }, h.ctx);
	assert.equal(h.calls.length, 1);
	let answer; h.ctx.ui.confirm = () => new Promise(resolve => { answer = resolve; });
	const pending = h.save(parameters, h.ctx);
	assert.equal(readFileSync(h.config, "utf8"), "# original\n");
	assert.deepEqual(readdirSync(h.ssh), ["config"]); // no lock held while waiting for the user
	answer(false); await pending;
});

test("model boolean/saved-state approval and unsafe/secret fields are never accepted", async t => {
	const h = fixture(t, "# original\n");
	for (const p of [
		{ ...parameters, confirmed: true }, { ...parameters, approved: true }, { ...parameters, password: "sensitive-sentinel" },
		{ ...parameters, privateKey: "sensitive-sentinel" }, { ...parameters, passphrase: "sensitive-sentinel" },
		{ ...parameters, alias: "x\nMatch all" }, { ...parameters, alias: "*" }, { ...parameters, hostname: "host\nProxyCommand evil" },
		{ ...parameters, user: "$(evil)" }, { ...parameters, port: 0 }, { ...parameters, port: "22" },
	]) await assert.rejects(h.save(p, h.ctx), error => !error.message.includes("sensitive-sentinel"));
	assert.equal(h.previews.length, 0); assert.equal(readFileSync(h.config, "utf8"), "# original\n");
	// Even restored target state conveys no alias-save authority.
	h.runtime.activate({ destination: "work", remoteCwd: "/srv" });
	await assert.rejects(createAliasSaver(h.adapter, { currentRequest: () => false }, h.home)(parameters, h.ctx));
	assert.equal(h.previews.length, 0);
});

test("unsupported config constructs fail closed without echoing existing contents", async t => {
	for (const text of ["Include other\n", "Host *\n  User dev\n", "Match all\n", "User global\n", "Host old\n  ProxyCommand secret-command\n",
		"Host old\n  HostName 'quoted'\n", "Host old\n  HostName one\\\n two\n", "Host old\nHost old\n", "# café\n", "x".repeat(256 * 1024 + 1)]) {
		const h = fixture(t, text);
		await assert.rejects(h.save(parameters, h.ctx), e => !e.message.includes("secret-command"));
		assert.equal(h.previews.length, 0); assert.equal(readFileSync(h.config, "utf8"), text);
	}
});

test("snapshot conflicts preserve newer changes and never retry; exclusive lock contention does not remove another lock", async t => {
	for (const original of [undefined, "# old\n"]) {
		const h = fixture(t, original);
		h.ctx.ui.confirm = async () => { writeFileSync(h.config, "# newer user edit\n"); return true; };
		await assert.rejects(h.save(parameters, h.ctx));
		assert.equal(readFileSync(h.config, "utf8"), "# newer user edit\n");
		assert.deepEqual(readdirSync(h.ssh), ["config"]);
	}
	const h = fixture(t, "# old\n"); const lock = join(h.ssh, ".pi-cmux-config.lock");
	writeFileSync(lock, "other owner", { mode: 0o600 });
	await assert.rejects(h.save(parameters, h.ctx));
	assert.equal(readFileSync(lock, "utf8"), "other owner"); assert.equal(readFileSync(h.config, "utf8"), "# old\n");
});

test("reject symlink config/parents, hard links and unsafe writable permissions", async t => {
	const h = fixture(t); const elsewhere = join(h.home, "elsewhere"); writeFileSync(elsewhere, "do not touch");
	symlinkSync(elsewhere, h.config);
	await assert.rejects(h.save(parameters, h.ctx)); assert.equal(lstatSync(h.config).isSymbolicLink(), true);
	assert.equal(readFileSync(elsewhere, "utf8"), "do not touch");
	const d = fixture(t); rmSync(d.ssh, { recursive: true }); mkdirSync(join(d.home, "other"), { mode: 0o700 }); symlinkSync(join(d.home, "other"), d.ssh);
	await assert.rejects(d.save(parameters, d.ctx));
	const hard = fixture(t, "# old\n"); linkSync(hard.config, join(hard.home, "hardlink"));
	await assert.rejects(hard.save(parameters, hard.ctx)); assert.equal(hard.previews.length, 0);
	const w = fixture(t, "# old\n"); chmodSync(w.config, 0o666);
	await assert.rejects(w.save(parameters, w.ctx)); assert.equal(w.previews.length, 0);
});

test("cancelled, disabled, foreign context, headless or stale confirmation never writes", async t => {
	for (const setup of [h => { h.ctx.signal = AbortSignal.abort(); }, h => h.runtime.setEnabled(false),
		h => { h.ctx.cwd = "/other"; }, h => { h.ctx.hasUI = false; },
		h => { h.ctx.ui.confirm = async () => { h.ctx.signal = AbortSignal.abort(); return true; }; },
		h => { h.ctx.ui.confirm = async () => { h.runtime.setEnabled(false); return true; }; },
		h => { h.ctx.ui.confirm = async () => { h.authority.currentRequest = () => false; return true; }; },
	]) {
		const h = fixture(t, "# old\n"); setup(h); await assert.rejects(h.save(parameters, h.ctx));
		assert.equal(readFileSync(h.config, "utf8"), "# old\n"); assert.equal(h.entries.length, 0); assert.equal(h.calls.length, 0);
		assert.deepEqual(readdirSync(h.ssh), ["config"]);
	}
});

test("separate opt-in alias tool registration performs no filesystem or connection work", () => {
	const tools = [], adapter = {}, authority = { currentRequest: () => false };
	const pi = { registerTool(tool) { tools.push(tool); } };
	registerSshAliasSave(pi, adapter, authority); registerSshAliasSave(pi, adapter, authority);
	assert.equal(tools.length, 1); assert.equal(tools[0].name, "ssh_alias_save");
	assert.equal(tools[0].parameters.additionalProperties, false);
});
