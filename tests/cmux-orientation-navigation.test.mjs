import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { BINDING_TTL_MS, childBootstrap, encodeBootstrap, rootOrientation } from "../lib/orientation/state.ts";
import { orientationHarness, target } from "./helpers/orientation.mjs";

const json = (value) => ({ code: 0, killed: false, stderr: "", stdout: JSON.stringify(value) });
const tree = (location, extras = []) => ({ windows: [{ id: location.windowId, workspaces: [{ id: location.workspaceId, panes: [{ id: location.paneId,
	selected_surface_id: extras[0]?.id ?? randomUUID(), surfaces: [{ id: location.surfaceId, pane_id: location.paneId, type: "terminal", title: "Same title" }, ...extras] }] }] }] });
async function reviewer(t, options = {}) {
	const parent = rootOrientation(randomUUID()), original = target(), moved = options.moved ?? original;
	const seed = childBootstrap(parent, original, true, "review", "Review");
	let h;
	h = orientationHarness(t, { bootstrap: encodeBootstrap(seed), exec: (_command, args) => {
		if (args.includes("tree")) {
			options.onTree?.(h);
			return json(options.topology?.(moved) ?? tree(moved));
		}
		if (args.includes("surface.focus")) return options.focusResponse ?? json(JSON.parse(args.at(-1)));
	} });
	h.store.write(original.surfaceId, { ...parent, version: 1, pid: process.pid, token: randomUUID(), expiresAt: Date.now() + BINDING_TTL_MS });
	await h.emit("session_start");
	return { ...h, parent, original, moved, focusCalls: () => h.calls.filter(c => c.args.includes("surface.focus")) };
}

test("return selects the recorded surface even when a sibling tab is selected", async (t) => {
	const h = await reviewer(t, { topology: location => tree(location, [{ id: randomUUID(), type: "terminal", title: "Same title", selected: true }]) });
	const restored = await h.runtime.returnToOrigin();
	assert.deepEqual(restored, h.original);
	assert.deepEqual(JSON.parse(h.focusCalls()[0].args.at(-1)), { window_id: h.original.windowId, workspace_id: h.original.workspaceId, surface_id: h.original.surfaceId });
	assert.equal(h.calls.some(c => c.args.includes("focus-pane") || c.args.includes("send-key")), false);
});

test("moved origin follows its full UUID to the current window/workspace/pane", async (t) => {
	const newLocation = target();
	const h = await reviewer(t, { topology: original => tree({ ...newLocation, surfaceId: original.surfaceId }) });
	const result = await h.runtime.returnToOrigin();
	assert.deepEqual(result, { ...newLocation, surfaceId: h.original.surfaceId });
	assert.notEqual(result.paneId, h.original.paneId);
	assert.equal(h.calls.some(c => c.args.includes("move-surface")), false);
});

for (const variant of ["expired", "wrong-conversation", "wrong-session", "dead-pid", "missing"]) {
	test(`return rejects ${variant} binding without focusing`, async (t) => {
		const h = await reviewer(t);
		const claim = h.store.read(h.original.surfaceId);
		if (variant === "missing") h.store.remove(h.original.surfaceId, claim.token);
		else h.store.write(h.original.surfaceId, { ...claim, ...(variant === "expired" ? { expiresAt: 0 } : variant === "wrong-conversation" ? { conversationId: randomUUID() }
			: variant === "wrong-session" ? { sessionId: randomUUID() } : { pid: 2147483647 }) });
		await assert.rejects(() => h.runtime.returnToOrigin(), /unavailable|another conversation/);
		assert.equal(h.focusCalls().length, 0);
	});
}
for (const variant of ["closed", "duplicate", "malformed", "browser", "bad-pane"]) {
	test(`return rejects ${variant} topology without focusing`, async (t) => {
		const h = await reviewer(t, { topology: location => {
			if (variant === "closed") return { windows: [] };
			if (variant === "malformed") return { windows: [{}] };
			const value = tree(location), surfaces = value.windows[0].workspaces[0].panes[0].surfaces;
			if (variant === "duplicate") surfaces.push({ ...surfaces[0] });
			if (variant === "browser") surfaces[0].type = "browser";
			if (variant === "bad-pane") surfaces[0].pane_id = randomUUID();
			return value;
		} });
		await assert.rejects(() => h.runtime.returnToOrigin(), /closed|ambiguous|Invalid/);
		assert.equal(h.focusCalls().length, 0);
	});
}

test("origin replacement while topology is read fails closed", async (t) => {
	const h = await reviewer(t, { onTree: h => {
		const id = h.runtime.state.origin.target.surfaceId;
		h.store.write(id, { ...h.store.read(id), token: randomUUID() });
	} });
	await assert.rejects(() => h.runtime.returnToOrigin(), /changed during return/);
	assert.equal(h.focusCalls().length, 0);
});

test("reviewer session change while topology is read fails closed", async (t) => {
	const h = await reviewer(t, { onTree: h => h.runtime.stop() });
	await assert.rejects(() => h.runtime.returnToOrigin(), /Conversation changed/);
	assert.equal(h.focusCalls().length, 0);
});

for (const response of [{ code: 1, stdout: "", stderr: "Unknown method surface.focus" }, json({ surface_id: randomUUID() })]) {
	test("unsupported or mismatched focus response is not reported as success", async (t) => {
		const h = await reviewer(t, { focusResponse: response });
		await h.commands.get("cmbk").handler("", h.ctx);
		assert.equal(h.notifications.at(-1)[1], "warning");
		assert.match(h.statuses.at(-1)[1], /origin unavailable/);
	});
}

test("command and shortcut use the same direct return action", async (t) => {
	const h = await reviewer(t);
	await h.commands.get("cmbk").handler("", h.ctx);
	await h.shortcuts.get("ctrl+alt+b").handler(h.ctx);
	assert.equal(h.focusCalls().length, 2);
	assert.equal(h.notifications.at(-1)[1], "info");
});

test("root conversation reports no origin", async (t) => {
	const h = orientationHarness(t); await h.emit("session_start");
	await h.commands.get("cmbk").handler("", h.ctx);
	assert.match(h.notifications.at(-1)[0], /no recorded origin/);
});

test("return shortcut can be changed or disabled", (t) => {
	const old = process.env.PI_CMUX_RETURN_KEY;
	t.after(() => { if (old === undefined) delete process.env.PI_CMUX_RETURN_KEY; else process.env.PI_CMUX_RETURN_KEY = old; });
	process.env.PI_CMUX_RETURN_KEY = "ctrl+shift+y";
	const custom = orientationHarness(t); assert.ok(custom.shortcuts.has("ctrl+shift+y"));
	process.env.PI_CMUX_RETURN_KEY = "off";
	const disabled = orientationHarness(t); assert.equal(disabled.shortcuts.size, 0); assert.ok(disabled.commands.has("cmbk"));
});
