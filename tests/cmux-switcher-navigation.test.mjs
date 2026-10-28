import assert from "node:assert/strict";
import test from "node:test";
import { focusSurface } from "../lib/switcher/navigation.ts";
import { fakePi, ids, topologyFixture, treeResponse } from "./helpers/switcher-fixture.mjs";

function echoedRpc() {
	return (args) => {
		const params = JSON.parse(args[args.length - 1]);
		return { stdout: JSON.stringify(params) };
	};
}

function movedTopology(surfaceId, target) {
	const topology = topologyFixture();
	for (const window of topology.windows) {
		for (const workspace of window.workspaces) {
			for (const pane of workspace.panes) {
				pane.surfaces = pane.surfaces.filter((surface) => surface.id !== surfaceId);
			}
		}
	}
	const targetWindow = topology.windows.find((window) => window.id === target.windowId);
	const targetWorkspace = targetWindow.workspaces.find((workspace) => workspace.id === target.workspaceId);
	const targetPane = targetWorkspace.panes.find((pane) => pane.id === target.paneId);
	targetPane.surfaces.push({
		id: surfaceId,
		type: "terminal",
		pane_id: target.paneId,
		index_in_pane: targetPane.surfaces.length,
		title: "Pi · reviewer",
	});
	return topology;
}

test("focuses one exact target across windows and workspaces", async () => {
	const pi = fakePi({ tree: treeResponse(), rpc: echoedRpc() });
	const result = await focusSurface(pi, { surfaceId: "e5555555-5555-4555-8555-555555555555" });
	assert.equal(result.ok, true);
	assert.equal(result.row.workspaceId, ids.ws3);
	assert.equal(pi.calls.length, 2, "one topology read and one focus call");
	const params = JSON.parse(pi.calls[1].args.at(-1));
	assert.deepEqual(params, {
		window_id: ids.window2,
		workspace_id: ids.ws3,
		surface_id: "e5555555-5555-4555-8555-555555555555",
	});
	assert.deepEqual(pi.calls[1].args.slice(0, 5), ["--json", "--id-format", "both", "rpc", "surface.focus"]);
});

test("a moved surface keeps its exact UUID and focuses its new location", async () => {
	const topology = movedTopology(ids.surfaceSibling, { windowId: ids.window1, workspaceId: ids.ws2, paneId: ids.pane2 });
	const pi = fakePi({ tree: treeResponse(topology), rpc: echoedRpc() });
	const result = await focusSurface(pi, { surfaceId: ids.surfaceSibling });
	assert.equal(result.ok, true);
	assert.equal(result.row.workspaceId, ids.ws2);
	assert.equal(result.row.paneId, ids.pane2);
	const params = JSON.parse(pi.calls[1].args.at(-1));
	assert.equal(params.workspace_id, ids.ws2);
	assert.equal(params.surface_id, ids.surfaceSibling);
});

test("browser surfaces and the caller surface are focusable by UUID", async () => {
	const pi = fakePi({ tree: treeResponse(), rpc: echoedRpc() });
	const browser = await focusSurface(pi, { surfaceId: ids.surfaceBrowser });
	assert.equal(browser.ok, true);
	assert.equal(browser.row.type, "browser");
	const params = JSON.parse(pi.calls[1].args.at(-1));
	assert.equal(params.surface_id, ids.surfaceBrowser);

	const caller = await focusSurface(pi, { surfaceId: ids.surfaceCaller });
	assert.equal(caller.ok, true);
	assert.equal(JSON.parse(pi.calls[3].args.at(-1)).surface_id, ids.surfaceCaller);
});

test("closed and ambiguous targets never reach cmux focus", async () => {
	const closed = fakePi({ tree: treeResponse(), rpc: echoedRpc() });
	const first = await focusSurface(closed, { surfaceId: "e9999999-9999-4999-8999-999999999999" });
	assert.equal(first.ok, false);
	assert.match(first.error, /closed or no longer exists/);
	assert.equal(closed.calls.length, 1, "no focus attempt for a closed target");

	const duplicated = topologyFixture();
	duplicated.windows[0].workspaces[1].panes[0].surfaces.push({
		id: ids.surfaceSibling,
		type: "terminal",
		pane_id: ids.pane2,
		index_in_pane: 1,
		title: "Pi · reviewer",
	});
	const ambiguous = fakePi({ tree: treeResponse(duplicated), rpc: echoedRpc() });
	const second = await focusSurface(ambiguous, { surfaceId: ids.surfaceSibling });
	assert.equal(second.ok, false);
	assert.equal(ambiguous.calls.length, 1);

	const invalid = fakePi({ tree: treeResponse(), rpc: echoedRpc() });
	const third = await focusSurface(invalid, { surfaceId: "surface:2" });
	assert.equal(third.ok, false);
	assert.equal(invalid.calls.length, 0);
});

test("unconfirmed or failed focus is reported without retry or substitute targeting", async () => {
	const wrong = fakePi({
		tree: treeResponse(),
		rpc: () => ({ stdout: JSON.stringify({ ...{ window_id: ids.window1, workspace_id: ids.ws1 }, surface_id: ids.surfaceCaller }) }),
	});
	const first = await focusSurface(wrong, { surfaceId: ids.surfaceBrowser });
	assert.equal(first.ok, false);
	assert.match(first.error, /did not confirm the exact target/);
	assert.equal(wrong.calls.length, 2, "exactly one focus attempt");

	const failed = fakePi({ tree: treeResponse(), rpc: () => ({ code: 1, stderr: "surface.focus is unavailable" }) });
	const second = await focusSurface(failed, { surfaceId: ids.surfaceBrowser });
	assert.equal(second.ok, false);
	assert.match(second.error, /surface\.focus is unavailable/);
	assert.equal(failed.calls.length, 2);

	const unreadable = fakePi({ tree: treeResponse(), rpc: { stdout: "not json" } });
	const third = await focusSurface(unreadable, { surfaceId: ids.surfaceBrowser });
	assert.equal(third.ok, false);
	assert.match(third.error, /unreadable focus response/);

	const timeout = fakePi({ tree: () => ({ killed: true, code: 0, stdout: "" }) });
	const fourth = await focusSurface(timeout, { surfaceId: ids.surfaceBrowser });
	assert.equal(fourth.ok, false);
	assert.match(fourth.error, /timed out/);
	assert.equal(timeout.calls.length, 1);
});

test("focus forwards the caller abort signal", async () => {
	const controller = new AbortController();
	const pi = fakePi({ tree: treeResponse(), rpc: echoedRpc() });
	await focusSurface(pi, { surfaceId: ids.surfaceBrowser }, { signal: controller.signal });
	assert.equal(pi.calls[0].options.signal, controller.signal);
	assert.equal(pi.calls[1].options.signal, controller.signal);
});
