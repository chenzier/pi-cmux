import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { SSH_TARGET_ENTRY } from "../lib/ssh/target.ts";
import { SshTargetRuntime, getSshTargetRuntime, registerSshTarget } from "../lib/ssh/runtime.ts";

const local = { sessionId: "session-1", localCwd: "/local/agent" };
const A = { destination: "dev-a", remoteCwd: "/remote/A $literal 'space'" };
const B = { destination: "dev-b", remoteCwd: "/remote/B" };
const pin = { workspaceId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee", backend: "native-ssh" };
const observation = (extra = {}) => ({ ...pin, destination: A.destination, enabled: true, transport: "ssh", connected: true, ...extra });
const own = (extra = {}) => ({ version: 1, ...local, kind: "target", target: A, ...extra });
const entry = (data) => ({ type: "custom", customType: SSH_TARGET_ENTRY, data });
function fixture(persist) {
	const entries = [];
	const runtime = new SshTargetRuntime(persist ?? ((type, data) => { entries.push({ type: "custom", customType: type, data }); }));
	runtime.startSession(local, []);
	return { runtime, entries };
}
function ready(runtime, target = A, association) {
	runtime.activate(target, association);
	const validation = runtime.beginValidation();
	assert.equal(runtime.completeValidation(validation, association ? { ...association, destination: target.destination, enabled: true, transport: "ssh", connected: true } : undefined), true);
	return runtime.captureDispatch();
}
function notReady(runtime, state) {
	assert.equal(runtime.snapshot().state, state);
	assert.throws(() => runtime.captureDispatch(), /not ready/);
}
function deferred() {
	let resolve;
	const promise = new Promise((r) => { resolve = r; });
	return { promise, resolve };
}
function lifecycleHarness() {
	const handlers = new Map(), notifications = [];
	const ctx = { cwd: local.localCwd, sessionManager: SessionManager.inMemory(local.localCwd), ui: { notify: (...args) => notifications.push(args) } };
	const pi = {
		on(name, handler) { const list = handlers.get(name) ?? []; list.push(handler); handlers.set(name, list); },
		appendEntry(type, data) { ctx.sessionManager.appendCustomEntry(type, data); },
		exec() { throw new Error("Foundation must not execute anything"); },
	};
	return { pi, ctx, handlers, notifications, emit(name) { for (const handler of handlers.get(name) ?? []) handler({}, ctx); } };
}

test("ordinary local sessions remain inactive; activation only configures, never connects", () => {
	const { runtime, entries } = fixture();
	notReady(runtime, "inactive"); assert.equal(entries.length, 0);
	assert.throws(() => runtime.beginValidation(), /cannot be validated/);
	assert.equal(runtime.completeValidation({}), false);
	runtime.activate({ ...A, identity: "secret", options: ["-p", "9999"] }, { ...pin, orientationId: "not-authority" });
	notReady(runtime, "configured");
	assert.deepEqual(entries, [entry(own({ association: pin }))]);
	assert.equal(JSON.stringify(entries).includes("secret"), false);
	assert.equal(runtime.snapshot().context.localCwd, "/local/agent");
	assert.equal(runtime.snapshot().target.remoteCwd, A.remoteCwd);
	const ticket = runtime.beginValidation();
	notReady(runtime, "configured");
	assert.equal(runtime.completeValidation(ticket, observation()), true);
	assert.equal(runtime.snapshot().state, "ready");
	assert.equal(entries.length, 1, "validation/readiness is not persisted");
	assert.equal(runtime.completeValidation(ticket, observation()), false, "validation tickets are single-use");
});

test("target, snapshots and genuine tickets are immutable defensive values", () => {
	const { runtime } = fixture();
	const input = { ...A }, assoc = { ...pin };
	runtime.activate(input, assoc);
	input.destination = "attacker"; assoc.workspaceId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
	const validation = runtime.beginValidation();
	assert.ok(Object.isFrozen(validation)); assert.ok(Object.isFrozen(validation.context)); assert.ok(Object.isFrozen(validation.target));
	assert.throws(() => { validation.target.destination = "attacker"; }, TypeError);
	assert.equal(runtime.completeValidation(validation, observation()), true);
	const dispatch = runtime.captureDispatch(), first = runtime.snapshot(), second = runtime.snapshot();
	assert.ok(Object.isFrozen(dispatch)); assert.ok(Object.isFrozen(first)); assert.ok(Object.isFrozen(first.association));
	assert.notEqual(first, second); assert.notEqual(first.target, second.target); assert.notEqual(first.context, second.context);
	assert.throws(() => { first.context.localCwd = "/remote"; }, TypeError);
	assert.equal(dispatch.target.destination, "dev-a");
	runtime.assertDispatch(dispatch);
});

test("forged, copied, wrong-kind and cross-runtime tickets fail by identity", () => {
	const { runtime } = fixture(), other = fixture().runtime;
	runtime.activate(A); other.activate(A);
	const validation = runtime.beginValidation(), otherValidation = other.beginValidation();
	for (const forged of [{}, { ...validation }, otherValidation, undefined, null]) {
		assert.equal(runtime.completeValidation(forged), false);
		assert.equal(runtime.failValidation(forged), false);
	}
	assert.equal(runtime.completeValidation(validation), true);
	assert.equal(other.completeValidation(otherValidation), true);
	const dispatch = runtime.captureDispatch(), otherDispatch = other.captureDispatch();
	for (const forged of [{}, { ...dispatch }, validation, otherDispatch, undefined, null]) {
		assert.throws(() => runtime.assertDispatch(forged), /no longer current/);
		assert.equal(runtime.observeAssociation(forged, observation()), false);
	}
	assert.equal(runtime.failValidation(dispatch), false);
	runtime.assertDispatch(dispatch);
});

test("replacement A→B→A, including same-target activation, never revives old tickets", () => {
	const { runtime } = fixture();
	const first = ready(runtime);
	const second = ready(runtime, B);
	assert.equal(first.signal.aborted, true);
	const third = ready(runtime);
	assert.equal(second.signal.aborted, true);
	assert.throws(() => runtime.assertDispatch(first));
	assert.throws(() => runtime.assertDispatch(second));
	runtime.assertDispatch(third);
	runtime.activate(A);
	assert.equal(third.signal.aborted, true);
	notReady(runtime, "configured");
});

test("validation restart and late async success/failure cannot change newer readiness", async () => {
	const { runtime } = fixture();
	runtime.activate(A);
	const old = runtime.beginValidation(), pending = deferred();
	const late = pending.promise.then(() => [runtime.completeValidation(old), runtime.failValidation(old)]);
	const current = runtime.beginValidation();
	assert.equal(old.signal.aborted, true);
	assert.equal(runtime.completeValidation(current), true);
	const dispatch = runtime.captureDispatch(), before = runtime.snapshot();
	let changes = 0; runtime.subscribe(() => { changes++; });
	pending.resolve();
	assert.deepEqual(await late, [false, false]);
	assert.deepEqual(runtime.snapshot(), before); assert.equal(changes, 0, "stale callbacks publish no change");
	runtime.assertDispatch(dispatch);
	const restarted = runtime.beginValidation();
	assert.equal(dispatch.signal.aborted, true);
	assert.equal(runtime.failValidation(restarted), true);
	assert.equal(restarted.signal.aborted, true);
	notReady(runtime, "disconnected");
	assert.equal(runtime.snapshot().target.destination, A.destination);
	assert.equal(runtime.completeValidation(restarted), false);
	const retry = runtime.beginValidation();
	assert.equal(runtime.completeValidation(retry), true);
});

test("pinned readiness requires exact live association; no metadata adopts a new host", () => {
	const { runtime } = fixture();
	for (const bad of [undefined, null, {}, observation({ enabled: false }), observation({ transport: "local" }), observation({ connected: false }), observation({ workspaceId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" }), observation({ destination: "dev-b" }), observation({ backend: "tmux-mirror" }), observation({ destination: "DEV-A" })]) {
		runtime.activate(A, pin);
		const validation = runtime.beginValidation();
		assert.equal(runtime.completeValidation(validation, bad), false);
		assert.equal(validation.signal.aborted, true);
		notReady(runtime, "disconnected");
		assert.equal(runtime.snapshot().reason, "association-mismatch");
		assert.deepEqual(runtime.snapshot().target, A); assert.deepEqual(runtime.snapshot().association, pin);
	}
});

test("workspace move, loss, unavailable evidence and changed backend revoke dispatch without local fallback", () => {
	const { runtime } = fixture();
	for (const bad of [undefined, {}, observation({ enabled: false }), observation({ transport: "local" }), observation({ connected: false }), observation({ workspaceId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" }), observation({ destination: "dev-b" }), observation({ backend: "legacy-relay" })]) {
		const ticket = ready(runtime, A, pin);
		assert.equal(runtime.observeAssociation(ticket, observation()), true);
		runtime.assertDispatch(ticket);
		assert.equal(runtime.observeAssociation(ticket, bad), false);
		assert.equal(ticket.signal.aborted, true);
		notReady(runtime, "disconnected");
		assert.deepEqual(runtime.snapshot().target, A); assert.deepEqual(runtime.snapshot().association, pin);
		assert.throws(() => runtime.assertDispatch(ticket));
	}
});

test("late association observations cannot disconnect a replacement", async () => {
	const { runtime } = fixture();
	const old = ready(runtime, A, pin), pending = deferred();
	const late = pending.promise.then(() => runtime.observeAssociation(old, undefined));
	const current = ready(runtime, B, pin), before = runtime.snapshot();
	pending.resolve(); assert.equal(await late, false);
	assert.deepEqual(runtime.snapshot(), before); runtime.assertDispatch(current);
});

test("dispatch races require before-effect and post-await assertions; AbortSignal requests cancellation", async () => {
	const { runtime } = fixture();
	const ticket = ready(runtime), gate = deferred();
	let aborts = 0, effects = 0;
	ticket.signal.addEventListener("abort", () => { aborts++; }, { once: true });
	const work = (async () => {
		runtime.assertDispatch(ticket);
		await gate.promise;
		runtime.assertDispatch(ticket);
		effects++;
	})();
	const rejected = assert.rejects(work, /no longer current/);
	runtime.disconnect(); gate.resolve();
	await rejected;
	assert.equal(aborts, 1); assert.equal(effects, 0);
	notReady(runtime, "disconnected"); assert.deepEqual(runtime.snapshot().target, A);
});

test("resume only configures; clear tombstones and branch navigation never resurrect older intent", () => {
	const { runtime, entries } = fixture();
	const before = ready(runtime);
	runtime.startSession(local, entries);
	assert.equal(before.signal.aborted, true);
	notReady(runtime, "configured");
	assert.equal(runtime.completeValidation({}), false);
	const ticket = runtime.beginValidation(); runtime.completeValidation(ticket);
	const dispatch = runtime.captureDispatch();
	runtime.clear();
	assert.equal(dispatch.signal.aborted, true);
	assert.deepEqual(entries.at(-1).data, { version: 1, ...local, kind: "clear" });
	notReady(runtime, "inactive");
	runtime.startSession(local, entries); notReady(runtime, "inactive");
	runtime.startSession(local, entries.slice(0, 1)); notReady(runtime, "configured");
	runtime.startSession(local, []); notReady(runtime, "inactive");
});

test("malformed latest own data and incompatible context fail closed across enablement", () => {
	const { runtime } = fixture();
	for (const [bad, reason] of [[null, "invalid-saved-state"], [{}, "invalid-saved-state"], [own({ version: 2 }), "invalid-saved-state"], [own({ localCwd: "/other/local" }), "local-context-mismatch"], [own({ sessionId: "foreign" }), "foreign-session"]]) {
		const old = ready(runtime);
		runtime.startSession(local, [entry(own()), entry(bad)]);
		assert.equal(old.signal.aborted, true);
		notReady(runtime, "disconnected"); assert.equal(runtime.snapshot().reason, reason);
		assert.equal(runtime.snapshot().target, undefined, "older valid target is not revived");
		assert.throws(() => runtime.beginValidation());
		runtime.setEnabled(false); notReady(runtime, "disabled");
		runtime.setEnabled(true); notReady(runtime, "disconnected");
		assert.equal(runtime.snapshot().reason, reason);
		runtime.clear(); notReady(runtime, "inactive");
	}
	const ticket = ready(runtime);
	runtime.startSession({ ...local, localCwd: "relative" }, []);
	assert.equal(ticket.signal.aborted, true);
	notReady(runtime, "disconnected"); assert.equal(runtime.snapshot().reason, "invalid-context");
});

test("disabled integration refuses new selection and persistence without losing the existing target", () => {
	const { runtime, entries } = fixture();
	const dispatch = ready(runtime);
	runtime.setEnabled(false);
	const before = runtime.snapshot(), saved = entries.length;
	assert.throws(() => runtime.activate(B), /disabled/);
	assert.deepEqual(runtime.snapshot(), before);
	assert.equal(entries.length, saved);
	assert.equal(dispatch.signal.aborted, true);
	runtime.setEnabled(true);
	notReady(runtime, "configured");
	assert.deepEqual(runtime.snapshot().target, A);
});

test("disable/re-enable, disabled resume and new session revoke rather than reconnect", () => {
	const { runtime, entries } = fixture();
	const ticket = ready(runtime);
	runtime.setEnabled(false); assert.equal(ticket.signal.aborted, true);
	notReady(runtime, "disabled"); assert.deepEqual(runtime.snapshot().target, A);
	assert.throws(() => runtime.beginValidation());
	runtime.startSession(local, entries); notReady(runtime, "disabled");
	runtime.setEnabled(true); notReady(runtime, "configured");
	const validation = runtime.beginValidation();
	runtime.setEnabled(false); assert.equal(validation.signal.aborted, true);
	assert.equal(runtime.completeValidation(validation), false);
	runtime.startSession({ ...local, sessionId: "new-session" }, []);
	notReady(runtime, "disabled"); assert.equal(runtime.snapshot().target, undefined);
	runtime.setEnabled(true); notReady(runtime, "inactive");
	assert.throws(() => runtime.setEnabled("yes"));
});

test("persistence failures on replacement and clear revoke all authority and preserve explicit intent", () => {
	let fail = false;
	const { runtime } = fixture(() => { if (fail) throw new Error("secret failure"); });
	const ticket = ready(runtime); fail = true;
	assert.throws(() => runtime.activate(B), { message: "SSH target metadata could not be persisted" });
	assert.equal(ticket.signal.aborted, true);
	notReady(runtime, "disconnected"); assert.deepEqual(runtime.snapshot().target, B);
	assert.equal(runtime.snapshot().reason, "persistence-error");
	assert.throws(() => runtime.beginValidation());
	runtime.setEnabled(false); runtime.setEnabled(true); notReady(runtime, "disconnected");
	fail = false;
	const second = ready(runtime, B); fail = true;
	assert.throws(() => runtime.clear(), /could not be persisted/);
	assert.equal(second.signal.aborted, true); notReady(runtime, "disconnected");
	assert.deepEqual(runtime.snapshot().target, B, "failed clear does not silently become local");
	assert.throws(() => runtime.beginValidation());
	fail = false; runtime.clear(); notReady(runtime, "inactive");
});

test("async persistence is refused, as are invalid activation and activation without an owning session", async () => {
	const asyncRuntime = fixture(() => Promise.reject(new Error("secret"))).runtime;
	assert.throws(() => asyncRuntime.activate(A), /could not be persisted/);
	notReady(asyncRuntime, "disconnected"); assert.throws(() => asyncRuntime.beginValidation());
	await Promise.resolve();
	const { runtime } = fixture();
	const ticket = ready(runtime);
	assert.throws(() => runtime.activate({ ...B, destination: "-oProxyCommand=secret" }), { message: "Invalid SSH target selection" });
	assert.equal(ticket.signal.aborted, true); notReady(runtime, "disconnected");
	assert.deepEqual(runtime.snapshot().target, A); assert.equal(runtime.snapshot().reason, "invalid-target");
	assert.throws(() => runtime.beginValidation());
	const orphan = new SshTargetRuntime(() => {});
	assert.throws(() => orphan.activate(A), /could not be persisted/);
	notReady(orphan, "disconnected");
});

test("shutdown revokes validation/dispatch, releases session state and allows conservative restart", () => {
	const { runtime, entries } = fixture();
	const ticket = ready(runtime);
	runtime.shutdown();
	assert.equal(ticket.signal.aborted, true);
	notReady(runtime, "inactive"); assert.equal(runtime.snapshot().context, undefined); assert.equal(runtime.snapshot().target, undefined);
	assert.throws(() => runtime.beginValidation());
	runtime.startSession(local, entries); notReady(runtime, "configured");
	const validation = runtime.beginValidation(); runtime.shutdown();
	assert.equal(validation.signal.aborted, true); assert.equal(runtime.completeValidation(validation), false);
	runtime.shutdown(); notReady(runtime, "inactive");
});

test("bounded subscriptions cannot mutate state reentrantly, break transitions or dispatch from abort callbacks", () => {
	const { runtime } = fixture();
	let last, mutationRejected = false, abortRejected = false;
	const unsubscribe = runtime.subscribe((snapshot) => {
		last = snapshot;
		assert.throws(() => { snapshot.state = "ready"; }, TypeError);
		try { runtime.activate(B); } catch { mutationRejected = true; }
		throw new Error("observer failure");
	});
	const ticket = ready(runtime);
	ticket.signal.addEventListener("abort", () => {
		try { runtime.assertDispatch(ticket); } catch { abortRejected = true; }
	});
	runtime.disconnect();
	assert.equal(mutationRejected, true); assert.equal(abortRejected, true);
	assert.equal(last.state, "disconnected"); assert.deepEqual(runtime.snapshot().target, A);
	unsubscribe(); unsubscribe();
	const unsubscribers = Array.from({ length: 32 }, () => runtime.subscribe(() => {}));
	assert.throws(() => runtime.subscribe(() => {}), /subscription unavailable/);
	unsubscribers[0](); const unsub = runtime.subscribe(() => {}); unsub();
});

test("explicit registration is idempotent per ExtensionAPI, opt-in and lifecycle-only", () => {
	const h = lifecycleHarness(), other = lifecycleHarness();
	assert.equal(getSshTargetRuntime(h.pi), undefined);
	const runtime = registerSshTarget(h.pi);
	assert.equal(registerSshTarget(h.pi), runtime); assert.equal(getSshTargetRuntime(h.pi), runtime);
	assert.notEqual(registerSshTarget(other.pi), runtime);
	assert.deepEqual([...h.handlers.keys()], ["session_start", "session_tree", "session_shutdown"]);
	for (const list of h.handlers.values()) assert.equal(list.length, 1);
	h.emit("session_start"); notReady(runtime, "inactive");
	assert.equal(h.ctx.sessionManager.getBranch().length, 0, "local lifecycle appends nothing");
	const ticket = ready(runtime);
	h.emit("session_tree"); assert.equal(ticket.signal.aborted, true); notReady(runtime, "configured");
	assert.equal(runtime.snapshot().context.sessionId, h.ctx.sessionManager.getSessionId());
	h.emit("session_shutdown"); assert.equal(runtime.snapshot().context, undefined);
	h.emit("session_start"); notReady(runtime, "configured");
});

test("actual Pi SessionManager branch entries, /new and foreign/fork copies restore conservatively", () => {
	const h = lifecycleHarness(), runtime = registerSshTarget(h.pi);
	const branchRoot = h.ctx.sessionManager.appendCustomEntry("test-root", {});
	h.emit("session_start");
	ready(runtime, A, pin);
	const saved = h.ctx.sessionManager.getBranch().at(-1).data;
	const selectedLeaf = h.ctx.sessionManager.getLeafId();
	runtime.clear();
	const clearLeaf = h.ctx.sessionManager.getLeafId();
	h.emit("session_start"); notReady(runtime, "inactive");
	h.ctx.sessionManager.branch(selectedLeaf); h.emit("session_tree"); notReady(runtime, "configured");
	const validation = runtime.beginValidation(); runtime.completeValidation(validation, observation());
	const dispatch = runtime.captureDispatch();
	h.ctx.sessionManager.branch(branchRoot); h.emit("session_tree");
	assert.equal(dispatch.signal.aborted, true); notReady(runtime, "inactive");
	h.ctx.sessionManager.branch(clearLeaf); h.emit("session_tree"); notReady(runtime, "inactive");
	const original = h.ctx.sessionManager;
	h.ctx.sessionManager = SessionManager.inMemory(local.localCwd); h.emit("session_start"); notReady(runtime, "inactive");
	h.ctx.sessionManager.appendCustomEntry(SSH_TARGET_ENTRY, saved); h.emit("session_start");
	notReady(runtime, "disconnected"); assert.equal(runtime.snapshot().reason, "foreign-session");
	assert.throws(() => runtime.beginValidation());
	runtime.activate(A); notReady(runtime, "configured");
	assert.equal(h.ctx.sessionManager.getBranch().at(-1).data.sessionId, h.ctx.sessionManager.getSessionId());
	assert.notEqual(h.ctx.sessionManager.getSessionId(), original.getSessionId());
	h.ctx.sessionManager = original;
	original.branch(selectedLeaf);
	original.appendCustomEntry(SSH_TARGET_ENTRY, { ...saved, target: null });
	h.emit("session_tree"); notReady(runtime, "disconnected");
	assert.equal(runtime.snapshot().reason, "invalid-saved-state");
	assert.equal(h.notifications.at(-1)[1], "warning");
});

test("Pi SessionManager.newSession revokes in-flight validation and never activates copied entries", () => {
	const h = lifecycleHarness(), runtime = registerSshTarget(h.pi);
	h.emit("session_start"); runtime.activate(A);
	const saved = h.ctx.sessionManager.getBranch().at(-1).data;
	const oldSessionId = h.ctx.sessionManager.getSessionId(), validation = runtime.beginValidation();
	h.ctx.sessionManager.newSession(); h.emit("session_start");
	assert.notEqual(h.ctx.sessionManager.getSessionId(), oldSessionId);
	assert.equal(validation.signal.aborted, true); notReady(runtime, "inactive");
	h.ctx.sessionManager.appendCustomEntry(SSH_TARGET_ENTRY, saved); h.emit("session_start");
	notReady(runtime, "disconnected");
	assert.equal(runtime.snapshot().reason, "foreign-session");
	assert.equal(runtime.completeValidation(validation), false);
	assert.equal(runtime.failValidation(validation), false);
	assert.throws(() => runtime.beginValidation());
});

test("actual Pi session files round-trip only configuration and persist clear tombstones", (t) => {
	const root = mkdtempSync(join(tmpdir(), "pi-cmux-ssh-session-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	let manager = SessionManager.create(root, root);
	const context = { sessionId: manager.getSessionId(), localCwd: root };
	const runtime = new SshTargetRuntime((type, data) => manager.appendCustomEntry(type, data));
	runtime.startSession(context, manager.getBranch());
	runtime.activate(A, pin);
	assert.equal(existsSync(manager.getSessionFile()), false, "Pi defers setup-only sessions until conversation starts");
	manager.appendMessage({ role: "user", content: "Explicit offline SSH fixture", timestamp: 1 });
	const validation = runtime.beginValidation();
	assert.equal(runtime.completeValidation(validation, observation()), true);
	const dispatch = runtime.captureDispatch();
	const file = manager.getSessionFile();
	const records = readFileSync(file, "utf8").trim().split("\n").map(JSON.parse);
	const saved = records.find((record) => record.type === "custom" && record.customType === SSH_TARGET_ENTRY).data;
	assert.deepEqual(saved, { version: 1, ...context, kind: "target", target: A, association: pin });
	assert.equal(JSON.stringify(saved).includes("ready"), false);
	assert.equal(Object.hasOwn(saved, "signal"), false);
	assert.equal(Object.hasOwn(saved, "authorization"), false);

	manager = SessionManager.open(file, root);
	runtime.startSession({ sessionId: manager.getSessionId(), localCwd: root }, manager.getBranch());
	notReady(runtime, "configured");
	assert.equal(dispatch.signal.aborted, true);
	assert.throws(() => runtime.assertDispatch(dispatch));
	runtime.clear();
	manager = SessionManager.open(file, root);
	runtime.startSession(context, manager.getBranch());
	notReady(runtime, "inactive");
	assert.equal(manager.getBranch().filter((record) => record.type === "custom" && record.customType === SSH_TARGET_ENTRY).at(-1).data.kind, "clear");
});

test("lifecycle branch read failure revokes a previously ready target without fallback", () => {
	const h = lifecycleHarness(), runtime = registerSshTarget(h.pi);
	h.emit("session_start"); const ticket = ready(runtime);
	h.ctx.sessionManager = { getSessionId() { throw new Error("untrusted detail"); } };
	h.emit("session_tree");
	assert.equal(ticket.signal.aborted, true); notReady(runtime, "disconnected");
	assert.equal(runtime.snapshot().reason, "invalid-context");
	assert.equal(h.notifications.at(-1)[0].includes("untrusted detail"), false);
});
