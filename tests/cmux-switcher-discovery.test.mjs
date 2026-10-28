import assert from "node:assert/strict";
import test from "node:test";
import { discoverSwitcher, parseAgents, parseTopology, revalidateSurface } from "../lib/switcher/discovery.ts";
import {
	currentFixture,
	currentResponse,
	fakePi,
	ids,
	topologyFixture,
	treeResponse,
} from "./helpers/switcher-fixture.mjs";

test("discovery returns one row per terminal and browser surface", async () => {
	const previous = process.env.CMUX_SURFACE_ID;
	delete process.env.CMUX_SURFACE_ID;
	try {
		const pi = fakePi({ tree: treeResponse(), current: currentResponse() });
		const result = await discoverSwitcher(pi);
		assert.equal(result.ok, true);
		const { rows, caller, windowCount } = result.discovery;
		assert.equal(windowCount, 2);
		assert.deepEqual(rows.map((row) => row.type).sort(), ["browser", "terminal", "terminal", "terminal", "terminal"]);
		assert.deepEqual(caller, {
			windowId: ids.window1,
			workspaceId: ids.ws1,
			paneId: ids.pane1,
			surfaceId: ids.surfaceCaller,
		});
		const browser = rows.find((row) => row.type === "browser");
		assert.equal(browser.url, "https://example.test/docs");
		assert.equal(browser.surfaceTitle, "docs");
		// Only the caller surface has verified agent metadata.
		assert.deepEqual(rows.find((row) => row.surfaceId === ids.surfaceCaller).agent, { kind: "pi", state: "working" });
		assert.equal(rows.find((row) => row.surfaceId === ids.surfaceSibling).agent, undefined);
		// Caller is marked once, by exact UUID.
		assert.deepEqual(rows.filter((row) => row.isCaller).map((row) => row.surfaceId), [ids.surfaceCaller]);
	} finally {
		if (previous !== undefined) process.env.CMUX_SURFACE_ID = previous;
	}
});

test("duplicate titles stay distinct because identity is the surface UUID", async () => {
	const pi = fakePi({ tree: treeResponse(), current: currentResponse() });
	const result = await discoverSwitcher(pi);
	assert.equal(result.ok, true);
	const duplicates = result.discovery.rows.filter((row) => row.surfaceTitle === "Pi · main");
	assert.equal(duplicates.length, 2);
	assert.notEqual(duplicates[0].surfaceId, duplicates[1].surfaceId);
	assert.notEqual(duplicates[0].windowId, duplicates[1].windowId);
});

test("missing, stale and ambiguous agent metadata produce no label", () => {
	const stale = parseAgents({ items: [{ freshness: { state: "stale" }, projections: [{ panel_id: ids.surfaceCaller }], agents: [{ kind: "pi", state: "idle" }] }] });
	assert.equal(stale.size, 0);
	const ambiguous = parseAgents({ items: [{ freshness: { state: "current" }, projections: [{ panel_id: ids.surfaceCaller }], agents: [{ kind: "pi", state: "idle" }, { kind: "claude", state: "working" }] }] });
	assert.equal(ambiguous.size, 0);
	const twoItems = parseAgents({ items: [
		{ freshness: { state: "current" }, projections: [{ panel_id: ids.surfaceCaller }], agents: [{ kind: "pi", state: "idle" }] },
		{ freshness: { state: "current" }, projections: [{ panel_id: ids.surfaceCaller }], agents: [{ kind: "pi", state: "working" }] },
	] });
	assert.equal(twoItems.size, 0);
	const good = parseAgents(currentFixture());
	assert.deepEqual(good.get(ids.surfaceCaller), { kind: "pi", state: "working" });

	// A reused tab usually keeps ended sessions next to the live one.
	const reused = parseAgents({ items: [{
		freshness: { state: "current" },
		projections: [{ panel_id: ids.surfaceCaller }],
		agents: [
			{ kind: "pi", state: "idle" },
			{ kind: "pi", state: "ended" },
			{ kind: "claude", state: "ended" },
		],
	}] });
	assert.deepEqual(reused.get(ids.surfaceCaller), { kind: "pi", state: "idle" });

	// Two live agents on one surface stay unattributed.
	const twoLive = parseAgents({ items: [{
		freshness: { state: "current" },
		projections: [{ panel_id: ids.surfaceCaller }],
		agents: [{ kind: "pi", state: "idle" }, { kind: "claude", state: "working" }],
	}] });
	assert.equal(twoLive.size, 0);

	// Partial metadata is not a unique attribution.
	const incompleteEntry = parseAgents({ items: [{
		freshness: { state: "current" },
		projections: [{ panel_id: ids.surfaceCaller }],
		agents: [{ kind: "pi", state: "idle" }, { kind: "claude" }],
	}] });
	assert.equal(incompleteEntry.size, 0);

	const withheld = parseAgents({ items: [{
		freshness: { state: "current" },
		projections: [{ panel_id: ids.surfaceCaller }],
		agents: [{ kind: "pi", state: "idle" }],
		omitted: { agents: 1 },
	}] });
	assert.equal(withheld.size, 0);

	const nothingOmitted = parseAgents({ items: [{
		freshness: { state: "current" },
		projections: [{ panel_id: ids.surfaceCaller }],
		agents: [{ kind: "pi", state: "idle" }, { kind: "pi", state: "ended" }],
		omitted: { agents: 0 },
	}] });
	assert.deepEqual(nothingOmitted.get(ids.surfaceCaller), { kind: "pi", state: "idle" });

	// Another current item on the same surface must not restore a unique label
	// after a partial item already made that surface ambiguous, in either order.
	const complete = {
		freshness: { state: "current" },
		projections: [{ panel_id: ids.surfaceCaller }],
		agents: [{ kind: "pi", state: "idle" }],
	};
	const incomplete = {
		freshness: { state: "current" },
		projections: [{ panel_id: ids.surfaceCaller }],
		agents: [{ kind: "claude" }],
	};
	const withheldShared = {
		freshness: { state: "current" },
		projections: [{ panel_id: ids.surfaceCaller }],
		agents: [{ kind: "claude", state: "working" }],
		omitted: { agents: 1 },
	};
	for (const [label, partialItem] of [["incomplete entry", incomplete], ["omitted agent", withheldShared]]) {
		for (const [order, items] of [["complete first", [complete, partialItem]], ["partial first", [partialItem, complete]]]) {
			const shared = parseAgents({ items });
			assert.equal(shared.size, 0, `${label}, ${order}: shared surface stays unlabeled`);
		}
	}

	// A partial item for one surface does not silence a different surface.
	const separate = parseAgents({ items: [complete, {
		freshness: { state: "current" },
		projections: [{ panel_id: ids.surfaceSibling }],
		agents: [{ kind: "claude" }],
	}] });
	assert.deepEqual(separate.get(ids.surfaceCaller), { kind: "pi", state: "idle" });
	assert.equal(separate.has(ids.surfaceSibling), false);

	// A single ended session is still verified metadata, not a guess.
	const ended = parseAgents({ items: [{
		freshness: { state: "current" },
		projections: [{ panel_id: ids.surfaceCaller }],
		agents: [{ kind: "claude", state: "ended" }],
	}] });
	assert.deepEqual(ended.get(ids.surfaceCaller), { kind: "claude", state: "ended" });
});

test("a failing or malformed agent query keeps the rows without labels", async () => {
	const pi = fakePi({
		tree: treeResponse(),
		current: () => ({ code: 1, stdout: "", stderr: "current unavailable" }),
	});
	const result = await discoverSwitcher(pi);
	assert.equal(result.ok, true);
	assert.equal(result.discovery.rows.length, 5);
	assert.ok(result.discovery.rows.every((row) => row.agent === undefined));

	const malformed = fakePi({ tree: treeResponse(), current: { stdout: "not json" } });
	const second = await discoverSwitcher(malformed);
	assert.equal(second.ok, true);
	assert.ok(second.discovery.rows.every((row) => row.agent === undefined));
});

test("timeout and malformed topology fail discovery with a message", async () => {
	const timeout = fakePi({ tree: () => ({ killed: true, code: 0, stdout: "" }) });
	const result = await discoverSwitcher(timeout);
	assert.equal(result.ok, false);
	assert.match(result.error, /timed out/);

	const malformed = fakePi({ tree: { stdout: "{\"windows\": 1}" } });
	const second = await discoverSwitcher(malformed);
	assert.equal(second.ok, false);
	assert.match(second.error, /Invalid cmux topology response/);

	const notJson = fakePi({ tree: { stdout: "<html>" } });
	const third = await discoverSwitcher(notJson);
	assert.equal(third.ok, false);
	assert.match(third.error, /Invalid cmux topology response/);
});

test("invalid or duplicated identities are rejected", () => {
	assert.throws(() => parseTopology({ windows: [{ id: "not-a-uuid", workspaces: [] }] }), /Invalid cmux window identity/);
	assert.throws(() => parseTopology({ windows: [{ id: ids.window1, workspaces: [{ id: ids.ws1, panes: [{ id: "nope", surfaces: [] }] }] }] }), /Invalid cmux pane identity/);
	const duplicated = topologyFixture();
	duplicated.windows[0].workspaces[1].panes[0].surfaces[0].id = ids.surfaceCaller;
	assert.throws(() => parseTopology(duplicated), /Surface identity is ambiguous/);
});

test("surfaces with a mismatched pane id or an unsupported type are not shown", () => {
	const topology = topologyFixture();
	topology.windows[0].workspaces[0].panes[0].surfaces.push({
		id: "e6666666-6666-4666-8666-666666666666",
		type: "simulator",
		pane_id: ids.pane1,
		index_in_pane: 3,
		title: "simulator",
	});
	const parsed = parseTopology(topology);
	assert.equal(parsed.rows.some((row) => row.surfaceId === "e6666666-6666-4666-8666-666666666666"), false);

	const mismatched = topologyFixture();
	mismatched.windows[0].workspaces[0].panes[0].surfaces[1].pane_id = ids.pane2;
	assert.throws(() => parseTopology(mismatched), /Invalid cmux surface location/);
});

test("revalidation returns the moved surface by UUID and rejects closed or ambiguous ones", async () => {
	const topology = topologyFixture();
	const sourcePane = topology.windows[0].workspaces[0].panes[0];
	const movedIndex = sourcePane.surfaces.findIndex((surface) => surface.id === ids.surfaceSibling);
	const [movedSurface] = sourcePane.surfaces.splice(movedIndex, 1);
	movedSurface.pane_id = ids.pane2;
	movedSurface.index_in_pane = 1;
	topology.windows[0].workspaces[1].panes[0].surfaces.push(movedSurface);
	const pi = fakePi({ tree: treeResponse(topology) });
	const first = await revalidateSurface(pi, ids.surfaceSibling);
	assert.equal(first.ok, true);
	assert.equal(first.row.paneId, ids.pane2);
	assert.equal(first.row.workspaceId, ids.ws2);

	const closed = await revalidateSurface(pi, "e9999999-9999-4999-8999-999999999999");
	assert.equal(closed.ok, false);
	assert.match(closed.error, /closed or no longer exists/);

	const invalid = await revalidateSurface(pi, "surface:3");
	assert.equal(invalid.ok, false);

	const duplicated = topologyFixture();
	duplicated.windows[0].workspaces[1].panes[0].surfaces.push({
		id: ids.surfaceCaller,
		type: "terminal",
		pane_id: ids.pane2,
		index_in_pane: 1,
		title: "Pi · main",
	});
	const ambiguous = fakePi({ tree: treeResponse(duplicated) });
	const third = await revalidateSurface(ambiguous, ids.surfaceCaller);
	assert.equal(third.ok, false);
	assert.match(third.error, /Invalid cmux surface location|ambiguous/);

	const timeout = fakePi({ tree: () => ({ killed: true, code: 0, stdout: "" }) });
	const fourth = await revalidateSurface(timeout, ids.surfaceCaller);
	assert.equal(fourth.ok, false);
	assert.match(fourth.error, /timed out/);
});

test("discovery is bounded and read-only", async () => {
	const pi = fakePi({ tree: treeResponse(), current: currentResponse() });
	await discoverSwitcher(pi);
	assert.deepEqual(pi.calls.map((call) => call.command), ["cmux", "cmux"]);
	assert.deepEqual(pi.calls[0].args, ["--json", "--id-format", "both", "tree", "--all"]);
	assert.deepEqual(pi.calls[1].args, ["--json", "current", "--limit", "200"]);
	assert.equal(pi.calls.every((call) => call.options.timeout > 0), true);

	const huge = fakePi({ tree: { stdout: `{"windows":[]}${" ".repeat(5_000_001)}` } });
	const result = await discoverSwitcher(huge);
	assert.equal(result.ok, false);
	assert.match(result.error, /too large/);
});
