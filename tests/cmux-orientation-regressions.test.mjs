import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { setImmediate as immediate } from "node:timers/promises";
import { test } from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { prepareOrientation } from "../lib/orientation/runtime.ts";
import { openCommandInNewSplit, openCommandInNewTab, openCommandInNewWorkspace } from "../extensions/cmux-core.ts";
import { BOOTSTRAP_ENV, ORIENTATION_ENTRY, BINDING_TTL_MS, liveBinding, marker } from "../lib/orientation/state.ts";
import { orientationHarness } from "./helpers/orientation.mjs";

const drain = async () => { for (let i = 0; i < 5; i++) await immediate(); };

for (const mode of ["print", "json", "rpc", "sdk"]) {
	test(`${mode} retains legacy launch behavior without orientation`, async (t) => {
		const h = orientationHarness(t); h.ctx.mode = mode;
		await h.emit("session_start");
		assert.equal(h.runtime.state, undefined);
		assert.equal(prepareOrientation(h.pi, { related: true, role: "continue" }, "Continue"), undefined);
		assert.equal(h.calls.length, 0);
	});
}

test("invalid own saved metadata fails explicitly, rather than silently relinking", async (t) => {
	const h = orientationHarness(t);
	h.ctx.sessionManager.appendCustomEntry(ORIENTATION_ENTRY, { version: 999, sessionId: h.ctx.sessionManager.getSessionId() });
	await h.emit("session_start");
	assert.equal(h.runtime.state, undefined);
	assert.match(h.notifications.at(-1)[0], /Invalid saved/);
});

test("live binding file does not contain topic, prompt, or origin payloads", async (t) => {
	const h = orientationHarness(t); await h.emit("session_start");
	const claim = h.store.read(h.location.surfaceId);
	h.store.write(h.location.surfaceId, { ...claim, topic: "secret prompt", origin: { unexpected: "secret" } });
	const raw = readFileSync(join(h.store.directory, `${h.location.surfaceId}.json`), "utf8");
	assert.doesNotMatch(raw, /topic|prompt|secret|origin|unexpected/);
});

test("a moved conversation renames only its current window/workspace/surface", async (t) => {
	const h = orientationHarness(t); await h.emit("session_start"); await drain();
	h.location.windowId = randomUUID(); h.location.workspaceId = randomUUID();
	await h.runtime.renameTopic("Moved topic");
	const call = h.calls.filter(c => c.args[0] === "rename-tab").at(-1);
	assert.equal(call.args[call.args.indexOf("--window") + 1], h.location.windowId);
	assert.equal(call.args[call.args.indexOf("--workspace") + 1], h.location.workspaceId);
	assert.equal(call.args[call.args.indexOf("--surface") + 1], h.location.surfaceId);
});

test("resume another session and then the original restores only each session's own identity", async (t) => {
	const h = orientationHarness(t); await h.emit("session_start");
	const source = h.ctx.sessionManager, first = h.runtime.state;
	h.ctx.sessionManager = SessionManager.inMemory(h.root);
	await h.emit("session_start"); const second = h.runtime.state;
	assert.notEqual(second.taskId, first.taskId);
	h.ctx.sessionManager = source;
	await h.emit("session_start"); assert.deepEqual(h.runtime.state, first);
	assert.equal(h.store.read(h.location.surfaceId).sessionId, first.sessionId);
});

test("shutdown while an old rename is in flight cannot dispatch another old-session title", async (t) => {
	let release, blocked = false;
	const h = orientationHarness(t, { exec: (_command, args) => {
		if (blocked && args.includes("identify")) { blocked = false; return new Promise(resolve => { release = () => resolve({ code: 0, stdout: '{}' }); }); }
	} });
	await h.emit("session_start"); await drain();
	const oldMarker = marker(h.runtime.state), count = h.calls.filter(c => c.args[0] === "rename-tab").length;
	blocked = true; const old = h.runtime.renameTopic("Must not appear"); await drain();
	await h.emit("session_shutdown"); release(); assert.equal(await old, false);
	assert.equal(h.calls.filter(c => c.args[0] === "rename-tab").length, count);
	assert.equal(h.statuses.at(-1)[1], undefined);
	assert.ok(oldMarker);
});

for (const placement of ["right", "tab", "workspace"]) {
	test(`${placement} creation cannot alias the caller through a returned UUID`, async () => {
		const surfaceId = randomUUID(), workspaceId = randomUUID(), calls = [];
		const pi = { exec: async (_command, args) => {
			calls.push(args);
			let response = {};
			if (args.includes("identify")) response = { caller: { window_ref: "window:1", workspace_ref: "workspace:1", surface_ref: "surface:1", pane_ref: "pane:1", surface_id: surfaceId, workspace_id: workspaceId } };
			else if (args.includes("list-panes")) response = { panes: [] };
			else response = { surface_ref: "surface:2", surface_id: surfaceId, workspace_ref: "workspace:2", workspace_id: workspaceId };
			return { code: 0, killed: false, stderr: "", stdout: JSON.stringify(response) };
		} };
		const result = placement === "right" ? await openCommandInNewSplit(pi, "right", "exec pi") : placement === "tab"
			? await openCommandInNewTab(pi, "exec pi") : await openCommandInNewWorkspace(pi, "/tmp", "exec pi", { title: "Test" });
		assert.equal(result.ok, false);
		assert.equal(calls.some(args => args[0] === "respawn-pane"), false);
	});
}

test("future-dated or expired ownership is not live evidence", async (t) => {
	const h = orientationHarness(t); await h.emit("session_start");
	const binding = h.store.read(h.location.surfaceId), state = h.runtime.state;
	assert.equal(liveBinding({ ...binding, expiresAt: Date.now() + BINDING_TTL_MS * 3 }, state), false);
	assert.equal(liveBinding({ ...binding, expiresAt: 1 }, state), false);
	assert.equal(process.env[BOOTSTRAP_ENV], undefined);
});
