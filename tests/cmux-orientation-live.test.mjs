import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { test } from "node:test";
import { OrientationRuntime } from "../lib/orientation/runtime.ts";
import { locateSurface } from "../lib/orientation/navigation.ts";
import { BindingStore, BINDING_TTL_MS, childBootstrap, orientedTitle, rootOrientation, uuid } from "../lib/orientation/state.ts";

// Explicit opt-in: creates temporary native terminals, changes focus, and restores it.
// No Pi child sessions, model requests, config edits, or user-surface writes.
test("native cmux: sibling tab, right split, workspace/window moves, closure and replacement", { skip: process.env.PI_CMUX_ORIENTATION_LIVE !== "1" }, async () => {
	const exec = promisify(execFile);
	const raw = async (args) => {
		try {
			const r = await exec("cmux", args, { timeout: 5000 });
			if (process.env.PI_CMUX_ORIENTATION_TRACE === "1" && (args.includes("surface.focus") || args.includes("move-tab-to-new-workspace"))) console.log({ args, stdout: r.stdout });
			return { code: 0, killed: false, ...r };
		} catch (e) {
			if (process.env.PI_CMUX_ORIENTATION_TRACE === "1") console.log({ args, error: e.stderr });
			return { code: e.code ?? 1, killed: e.killed ?? false, stdout: e.stdout ?? "", stderr: e.stderr ?? String(e) };
		}
	};
	const cmux = async (...args) => { const r = await raw(["--json", "--id-format", "both", ...args]); assert.equal(r.code, 0, r.stderr); return JSON.parse(r.stdout); };
	const waitForFocus = async (surfaceId) => {
		let tree;
		for (let attempt = 0; attempt < 40; attempt++) {
			tree = await cmux("tree", "--all");
			if (uuid(tree.active?.surface_id) === surfaceId) return tree;
			await new Promise(resolve => setTimeout(resolve, 50));
		}
		assert.equal(uuid(tree.active?.surface_id), surfaceId, "native focus must settle on the exact tab");
	};
	const waitForSurface = async (surfaceId, expected = {}, closed = false) => {
		for (let attempt = 0; attempt < 40; attempt++) {
			let location;
			try { location = locateSurface(await cmux("tree", "--all"), surfaceId); }
			catch (error) {
				if (error.message !== "Origin surface is closed or inaccessible") throw error;
				if (closed) return;
			}
			if (location && !closed && (!expected.workspaceId || location.workspaceId === expected.workspaceId)
				&& (!expected.windowId || location.windowId === expected.windowId)) return location;
			await new Promise(resolve => setTimeout(resolve, 50));
		}
		assert.fail(`Native inventory did not settle for exact surface ${surfaceId}${closed ? " closure" : " location"}`);
	};
	const initial = await cmux("identify"), saved = initial.focused, workspaces = new Set();
	assert.ok(uuid(saved?.surface_id) && uuid(saved?.workspace_id) && uuid(saved?.window_id));
	const root = mkdtempSync(join(tmpdir(), "pi-cmux-live-orientation-"));
	const store = new BindingStore(join(root, "bindings"));
	const runtime = new OrientationRuntime({ exec: (_command, args) => raw(args) }, store);
	let temporaryWindow;
	try {
		const created = await cmux("workspace", "create", "--window", saved.window_id, "--name", "pi-cmux orientation smoke", "--focus", "false");
		const workspaceId = uuid(created.workspace_id), surfaceId = uuid(created.surface_id);
		assert.ok(workspaceId && surfaceId, "creation must return UUIDs; do not retry uncertain creation"); workspaces.add(workspaceId);
		const original = await waitForSurface(surfaceId, { workspaceId });
		const parent = rootOrientation(randomUUID()), child = childBootstrap(parent, original, true, "review", "Review smoke");
		const title = orientedTitle(parent, "Origin smoke");
		await cmux("rename-tab", "--workspace", workspaceId, "--surface", surfaceId, title);
		const split = await cmux("new-split", "right", "--workspace", workspaceId, "--surface", surfaceId, "--focus", "false");
		assert.ok(uuid(split.surface_id));
		const sibling = await cmux("new-surface", "--workspace", workspaceId, "--pane", original.paneId, "--type", "terminal", "--focus", "true");
		assert.ok(uuid(sibling.surface_id));
		const claim = { ...parent, version: 1, token: randomUUID(), pid: process.pid, expiresAt: Date.now() + BINDING_TTL_MS };
		store.write(surfaceId, claim);
		runtime.state = { ...child, sessionId: randomUUID() };
		await runtime.returnToOrigin();
		const tree = await waitForFocus(surfaceId);
		assert.equal(uuid(tree.active.surface_id), surfaceId);
		const sourceWorkspace = tree.windows.flatMap(w => w.workspaces).find(w => uuid(w.id) === workspaceId);
		assert.equal(sourceWorkspace.panes.flatMap(p => p.surfaces).find(s => uuid(s.id) === surfaceId).title, title);

		const moved = await cmux("move-tab-to-new-workspace", "--workspace", workspaceId, "--surface", surfaceId, "--title", "pi-cmux moved origin smoke", "--focus", "false");
		const movedWorkspaceId = uuid(moved.workspace_id);
		assert.ok(movedWorkspaceId); workspaces.add(movedWorkspaceId);
		await cmux("rpc", "surface.focus", JSON.stringify({ window_id: saved.window_id, workspace_id: workspaceId, surface_id: uuid(split.surface_id) }));
		await waitForSurface(surfaceId, { workspaceId: movedWorkspaceId });
		store.write(surfaceId, { ...claim, expiresAt: Date.now() + BINDING_TTL_MS });
		assert.equal((await runtime.returnToOrigin()).workspaceId, movedWorkspaceId);

		const window = await cmux("rpc", "window.create", "{}");
		temporaryWindow = uuid(window.window_id); assert.ok(temporaryWindow);
		await cmux("move-workspace-to-window", "--workspace", movedWorkspaceId, "--window", temporaryWindow);
		await waitForSurface(surfaceId, { windowId: temporaryWindow, workspaceId: movedWorkspaceId });
		await cmux("rpc", "surface.focus", JSON.stringify({ window_id: saved.window_id, workspace_id: workspaceId, surface_id: uuid(split.surface_id) }));
		store.write(surfaceId, { ...claim, expiresAt: Date.now() + BINDING_TTL_MS });
		assert.equal((await runtime.returnToOrigin()).windowId, temporaryWindow);
		await waitForFocus(surfaceId);

		store.write(surfaceId, { ...claim, sessionId: randomUUID() });
		await assert.rejects(() => runtime.returnToOrigin(), /another conversation/);
		store.write(surfaceId, { ...claim, expiresAt: Date.now() + BINDING_TTL_MS });
		await cmux("rpc", "workspace.close", JSON.stringify({ window_id: temporaryWindow, workspace_id: movedWorkspaceId }));
		workspaces.delete(movedWorkspaceId);
		await waitForSurface(surfaceId, {}, true);
		await assert.rejects(() => runtime.returnToOrigin(), /closed or inaccessible/);
	} finally {
		// Only close identities returned by this test's own creation operations.
		const remaining = await cmux("tree", "--all");
		for (const workspaceId of workspaces) {
			const window = remaining.windows.find(w => w.workspaces.some(s => uuid(s.id) === workspaceId));
			if (window) {
				const closed = await raw(["rpc", "workspace.close", JSON.stringify({ window_id: uuid(window.id), workspace_id: workspaceId })]);
				assert.equal(closed.code, 0, closed.stderr);
			}
		}
		if (temporaryWindow) await raw(["rpc", "window.close", JSON.stringify({ window_id: temporaryWindow })]);
		await raw(["rpc", "surface.focus", JSON.stringify({ window_id: saved.window_id, workspace_id: saved.workspace_id, surface_id: saved.surface_id })]);
		try {
			let pendingCleanup = true;
			for (let attempt = 0; attempt < 40; attempt++) {
				const inventory = await cmux("tree", "--all");
				pendingCleanup = inventory.windows.some(w => uuid(w.id) === temporaryWindow || w.workspaces.some(s => workspaces.has(uuid(s.id))));
				if (!pendingCleanup) break;
				await new Promise(resolve => setTimeout(resolve, 50));
			}
			assert.equal(pendingCleanup, false, "test-created native resources must finish closing");
			await waitForFocus(uuid(saved.surface_id));
		} finally {
			runtime.stop(); rmSync(root, { recursive: true, force: true });
		}
	}
});
