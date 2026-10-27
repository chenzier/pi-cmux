import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { OpenSshTransport, sshArgv, SSH_MAX_INPUT } from "../lib/ssh/transport.ts";

const target = { destination: "user@fixture", remoteCwd: "/tmp" };
const request = (extra = {}) => ({ target, script: ":", assertCurrent() {}, ...extra });
function fakeSpawn(calls, program) {
	return (file, args, options) => {
		calls.push({ file, args, options });
		// This is the fake SSH endpoint: a disposable local shell, never OpenSSH/network.
		return spawn("/bin/sh", ["-c", program ?? args.at(-1)], { stdio: "pipe", env: { PATH: "/usr/bin:/bin", REMOTE_SENTINEL: "remote" } });
	};
}

test("SSH argv is noninteractive, rejects option destinations and keeps literal shell paths", async (t) => {
	const root = mkdtempSync(join(tmpdir(), "cmux-fake-ssh-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const cwd = join(root, "space ' $HOME $(touch EXPANDED) café"); mkdirSync(cwd);
	const calls = [], transport = new OpenSshTransport(fakeSpawn(calls));
	const result = await transport.run(request({ target: { ...target, remoteCwd: cwd }, script: 'printf "%s\\n%s" "$PWD" "$REMOTE_SENTINEL"; exit 7' }));
	assert.equal(result.exitCode, 7); assert.equal(result.stdout.toString(), `${cwd}\nremote`);
	assert.equal(calls.length, 1); assert.equal(calls[0].file, "/usr/bin/ssh");
	assert.equal(calls[0].options.shell, false);
	assert.ok(calls[0].args.includes("-oBatchMode=yes"));
	assert.ok(calls[0].args.includes("-oPermitLocalCommand=no"));
	assert.ok(calls[0].args.includes("-oSendEnv=-*"));
	assert.deepEqual(calls[0].args.slice(-3, -1), ["--", target.destination]);
	assert.ok(!calls[0].args.at(-1).includes(process.env.PATH));
	for (const destination of ["-Fconfig", "user@-host", "host;touch x", "ssh://host", "host password", "host\nother"]) {
		assert.throws(() => sshArgv({ ...target, destination }, ":"), /Invalid SSH/);
	}
});

test("large stdin uses backpressure and is not in argv; output streams and is bounded", async () => {
	const calls = [], transport = new OpenSshTransport(fakeSpawn(calls));
	const input = Buffer.from("' $() café\n".repeat(300_000)), streamed = [];
	const result = await transport.run(request({ script: "cat", input, onData: (b) => streamed.push(Buffer.from(b)) }));
	assert.deepEqual(result.stdout, input); assert.deepEqual(Buffer.concat(streamed), input);
	assert.ok(calls[0].args.join(" ").length < 2000);
	await assert.rejects(transport.run(request({ script: "printf 123456789", maxOutputBytes: 4 })), { kind: "output-limit", uncertain: true });
	const before = calls.length;
	await assert.rejects(transport.run(request({ input: Buffer.alloc(SSH_MAX_INPUT + 1) })), { kind: "input-limit", uncertain: false });
	assert.equal(calls.length, before);
});

test("auth failure, disconnect, spawn error, deadline and cancellation never retry", async () => {
	for (const program of ["exit 255", "kill -TERM $$"]) {
		const calls = [], transport = new OpenSshTransport(fakeSpawn(calls, program));
		await assert.rejects(transport.run(request()), { kind: "connection", uncertain: true });
		assert.equal(calls.length, 1);
	}
	await assert.rejects(new OpenSshTransport(() => { throw new Error("private detail"); }).run(request()), { kind: "spawn", uncertain: false });
	for (const mode of ["timeout", "cancelled"]) {
		const calls = [], controller = new AbortController();
		const transport = new OpenSshTransport(fakeSpawn(calls, "exec sleep 10"));
		const promise = transport.run(request({ timeoutMs: mode === "timeout" ? 30 : 1000, signal: controller.signal }));
		if (mode === "cancelled") controller.abort();
		await assert.rejects(promise, { kind: mode, uncertain: true });
		assert.equal(calls.length, 1);
	}
	const controller = new AbortController(); controller.abort();
	let calls = 0;
	await assert.rejects(new OpenSshTransport(() => { calls++; }).run(request({ signal: controller.signal })), { kind: "cancelled", uncertain: false });
	await assert.rejects(new OpenSshTransport(() => { calls++; }).run(request({ assertCurrent() { throw new Error("stale"); } })), /stale/);
	assert.equal(calls, 0);
});

test("callback failure and revoked authority terminate once without publishing success", async () => {
	const calls = [], transport = new OpenSshTransport(fakeSpawn(calls));
	await assert.rejects(transport.run(request({ script: "printf output", onData() { throw new Error("private callback"); } })), { kind: "callback", uncertain: true });
	let current = true;
	await assert.rejects(transport.run(request({ script: "printf first; sleep 0.03; printf second", onData() { current = false; }, assertCurrent() { if (!current) throw new Error("stale"); } })), { kind: "cancelled" });
	assert.equal(calls.length, 2);
});
