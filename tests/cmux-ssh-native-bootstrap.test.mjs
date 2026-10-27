import assert from "node:assert/strict";
import { test } from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { registerSshTarget, SshTargetRuntime } from "../lib/ssh/runtime.ts";
import { consumeSshLaunch, encodeSshLaunch, SSH_LAUNCH_ENV } from "../lib/ssh/launch.ts";

const cwd = "/local/native-smoke";
const target = { destination: "fixture", remoteCwd: "/tmp/owned-fixture" };
function child(extra) {
	const manager = SessionManager.inMemory(cwd);
	// Pi SDK createAgentSession appends these before session_start.
	manager.appendModelChange("fixture-provider", "fixture-model");
	manager.appendThinkingLevelChange("off");
	extra?.(manager);
	const pi = { on() {}, appendEntry: (type, record) => manager.appendCustomEntry(type, record) };
	const runtime = registerSshTarget(pi);
	runtime.startSession({ sessionId: manager.getSessionId(), localCwd: cwd }, manager.getBranch());
	const parent = new SshTargetRuntime(() => {});
	parent.startSession({ sessionId: "parent-native-smoke", localCwd: cwd }, []);
	parent.activate(target);
	parent.completeValidation(parent.beginValidation());
	const env = { [SSH_LAUNCH_ENV]: encodeSshLaunch(parent.captureDispatch()) };
	return { manager, pi, runtime, env, ctx: { cwd, sessionManager: manager } };
}

test("real Pi startup model/thinking entries do not turn a fresh child into an existing conversation", () => {
	const h = child();
	assert.deepEqual(h.manager.getBranch().map(entry => entry.type), ["model_change", "thinking_level_change"]);
	assert.equal(consumeSshLaunch(h.pi, h.ctx, h.env), true);
	assert.equal(h.runtime.snapshot().state, "configured");
	assert.deepEqual(h.runtime.snapshot().target, target);
	assert.throws(() => h.runtime.captureDispatch(), /not ready/);
	assert.equal(Object.hasOwn(h.env, SSH_LAUNCH_ENV), false);
	const record = h.manager.getBranch().at(-1).data;
	assert.equal(record.sessionId, h.manager.getSessionId());
	assert.deepEqual(record.target, target);
});

test("neutral startup metadata cannot hide conversation or custom history in a fresh bootstrap", () => {
	for (const extra of [
		manager => manager.appendMessage({ role: "user", content: "existing conversation", timestamp: 1 }),
		manager => manager.appendCustomEntry("unrelated-history", {}),
	]) {
		const h = child(extra);
		assert.throws(() => consumeSshLaunch(h.pi, h.ctx, h.env), /refused/);
		assert.equal(h.runtime.snapshot().state, "disconnected");
		assert.equal(Object.hasOwn(h.env, SSH_LAUNCH_ENV), false);
	}
});
