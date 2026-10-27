import assert from "node:assert/strict";
import { test } from "node:test";
import { SshTargetRuntime } from "../lib/ssh/runtime.ts";
import { SshExecutionAdapter } from "../lib/ssh/adapter.ts";
import { SshTransportError } from "../lib/ssh/transport.ts";
import { createSshConnector, decideSshConversation, registerSshConnect, validateConnect, SSH_AUTH_GUIDANCE } from "../lib/ssh/connect.ts";

const target = { destination: "javi", remoteCwd: "/srv/project" };
function fixture(run) {
	const entries = [], calls = [], tools = new Map();
	const runtime = new SshTargetRuntime((type, record) => entries.push({ type, record }));
	runtime.startSession({ sessionId: "current", localCwd: "/local" }, []);
	const ctx = { cwd: "/local", signal: undefined, isIdle: () => true, hasUI: true,
		sessionManager: { getSessionId: () => "current" },
		ui: { confirm() { assert.fail("Connection must not ask for confirmation"); }, select() { assert.fail("No picker"); }, input() { assert.fail("No questionnaire"); } } };
	let authorized = true;
	const authority = { currentRequest: (_ctx, action, params) => authorized && action === "connect" && params.destination === target.destination && params.remoteCwd === target.remoteCwd };
	const adapter = new SshExecutionAdapter(runtime, { transport: { async run(request) {
		request.assertCurrent(); calls.push(request);
		return run ? run(request) : { exitCode: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
	} } });
	const connect = createSshConnector(adapter, authority);
	return { entries, calls, ctx, adapter, runtime, connect, authority, tools, revoke() { authorized = false; } };
}

test("complete 'Connect to javi in /srv/project' supplied fields connect without questions or a yes/no gate", async () => {
	// This asserts supplied-field flow, not a claim about natural-language model compliance.
	const decision = decideSshConversation(target);
	assert.deepEqual(decision, { kind: "connect", target });
	const h = fixture();
	assert.match(await h.connect(decision.target, h.ctx), /ready/);
	assert.equal(h.calls.length, 1); assert.equal(h.entries.length, 1);
	assert.deepEqual(h.runtime.snapshot().target, target);
	assert.equal(h.runtime.snapshot().association, undefined);
	assert.equal(h.runtime.snapshot().state, "ready");
	assert.equal(h.calls[0].script, "test -d . && test -x . && :");
});

test("missing fields ask exactly one question; discovery never selects even a sole candidate", () => {
	const h = fixture();
	assert.equal(decideSshConversation({}).field, "destination");
	assert.equal(decideSshConversation({ remoteCwd: target.remoteCwd }).field, "destination");
	assert.deepEqual(decideSshConversation({ destination: "javi" }), {
		kind: "question", field: "remoteCwd", question: "Which absolute remote directory should I use?",
	});
	for (const candidates of [["javi"], ["javi", "javi-work"]]) {
		const decision = decideSshConversation({ remoteCwd: target.remoteCwd, ambiguousHostCandidates: candidates });
		assert.equal(decision.kind, "question"); assert.equal(decision.field, "destination");
		assert.deepEqual(decision.suggestions, candidates); assert.match(decision.question, /manual/);
	}
	assert.equal(h.entries.length, 0); assert.equal(h.calls.length, 0);
});

test("manual user@host is accepted, never a discovered workspace/backend/mode", async () => {
	const h = fixture();
	const manual = { destination: "dev@manual.example", remoteCwd: "/opt/work" };
	const connect = createSshConnector(h.adapter, { currentRequest: (_ctx, action, p) => action === "connect" && p.destination === manual.destination });
	await connect(decideSshConversation(manual).target, h.ctx);
	assert.deepEqual(h.runtime.snapshot().target, manual); assert.equal(h.runtime.snapshot().association, undefined);
});

test("incomplete/unsafe/unknown secret or execution fields fail before activation, persistence and transport", async () => {
	const h = fixture();
	const invalid = [{}, { destination: "javi" }, { remoteCwd: "/srv" },
		{ ...target, destination: "-oProxyCommand=bad" }, { ...target, destination: "a;echo" },
		{ ...target, remoteCwd: "~/project" }, { ...target, remoteCwd: "/x\nsecret" },
		... ["password", "privateKey", "passphrase", "command", "mode", "backend", "workspaceId", "confirmed"].map(key => ({ ...target, [key]: "sensitive-sentinel" })),
		Object.assign(Object.create({ destination: "javi" }), { remoteCwd: "/srv" }),
		Object.defineProperty({ remoteCwd: "/srv" }, "destination", { get() { assert.fail("Getter must not run"); } }),
	];
	for (const params of invalid) {
		assert.throws(() => validateConnect(params));
		await assert.rejects(h.connect(params, h.ctx), error => !error.message.includes("sensitive-sentinel"));
	}
	assert.equal(h.entries.length, 0); assert.equal(h.calls.length, 0); assert.equal(h.runtime.snapshot().state, "inactive");
});

test("disabled, foreign ctx, absent current intent and pre-cancelled calls have no side effects", async () => {
	for (const setup of [
		h => h.runtime.setEnabled(false), h => { h.ctx.cwd = "/other"; },
		h => { h.ctx.sessionManager.getSessionId = () => "other"; },
		h => h.revoke(),
		h => { h.ctx.signal = AbortSignal.abort(); },
	]) {
		const h = fixture(); setup(h);
		await assert.rejects(h.connect(target, h.ctx));
		assert.equal(h.entries.length, 0); assert.equal(h.calls.length, 0);
	}
	const h = fixture(); await assert.rejects(h.connect(target, h.ctx, AbortSignal.abort()));
	assert.equal(h.entries.length, 0); assert.equal(h.calls.length, 0);
	assert.deepEqual(decideSshConversation({ ...target, cancelled: true }), { kind: "cancelled" });
});

test("authentication failure gives fixed outside-chat guidance, no retry/key setup or secret output", async () => {
	const h = fixture(() => { throw new SshTransportError("connection", true); });
	await assert.rejects(h.connect(target, h.ctx), { message: SSH_AUTH_GUIDANCE });
	assert.equal(h.calls.length, 1); assert.equal(h.runtime.snapshot().state, "disconnected");
	assert.deepEqual(h.entries[0].record.target, target);
	const other = fixture(() => { throw new Error("password-sensitive-sentinel"); });
	await assert.rejects(other.connect(target, other.ctx), e => !e.message.includes("sensitive-sentinel"));
});

test("in-flight revocation cannot publish readiness or automatically reconnect", async () => {
	let finish;
	const h = fixture(() => new Promise(resolve => { finish = resolve; }));
	const pending = h.connect(target, h.ctx);
	h.runtime.setEnabled(false);
	finish({ exitCode: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) });
	await assert.rejects(pending); assert.equal(h.runtime.snapshot().state, "disabled");
	assert.equal(h.calls.length, 1);
});

test("opt-in registration is inert, idempotent and rejects forged consent parameters", async () => {
	const h = fixture(); const pi = { registerTool(tool) { h.tools.set(tool.name, tool); } };
	registerSshConnect(pi, h.adapter, h.authority); registerSshConnect(pi, h.adapter, h.authority);
	assert.equal(h.tools.size, 1); assert.equal(h.calls.length, 0); assert.equal(h.entries.length, 0);
	const tool = h.tools.get("ssh_connect");
	assert.equal(tool.parameters.additionalProperties, false);
	await assert.rejects(tool.execute("test", { ...target, confirmed: true }, undefined, undefined, h.ctx));
	h.ctx.isIdle = () => false; // Real model tool context is busy, not an idle slash command.
	const result = await tool.execute("test", target, undefined, undefined, h.ctx);
	assert.deepEqual(result.details, {}); assert.equal(h.calls.length, 1);
});
