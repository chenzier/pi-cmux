import assert from "node:assert/strict";
import { test } from "node:test";
import { getCallerInfo } from "../extensions/cmux-core.ts";
import { assertLocalWorkspace } from "../lib/ssh/terminal.ts";

const ids = {
	window_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
	workspace_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
	pane_id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
	surface_id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
};
const refs = { window_ref: "window:1", workspace_ref: "workspace:1", pane_ref: "pane:1", surface_ref: "surface:1" };
const success = value => ({ code: 0, killed: false, stdout: JSON.stringify(value), stderr: "" });

test("caller identify requests both IDs and refs instead of assuming default CLI output includes UUIDs", async () => {
	const calls = [];
	const pi = { async exec(_file, args) {
		calls.push(args);
		const both = args.includes("--id-format") && args[args.indexOf("--id-format") + 1] === "both";
		return success({ caller: { ...refs, ...(both ? Object.fromEntries(Object.entries(ids).map(([key, value]) => [key, value.toUpperCase()])) : {}) } });
	} };
	const result = await getCallerInfo(pi);
	assert.equal(result.ok, true);
	assert.equal(result.caller.workspace_id, ids.workspace_id);
	assert.equal(result.caller.surface_id, ids.surface_id);
	assert.equal(result.caller.surface_ref, refs.surface_ref);
	assert.deepEqual(calls, [["--json", "--id-format", "both", "identify"]]);
});

test("workspace locality accepts native uppercase UUIDs without adopting a different workspace", async () => {
	const pi = { async exec() { return success({ workspaces: [{ id: ids.workspace_id.toUpperCase(), remote: { enabled: false, connected: false, transport: null } }] }); } };
	await assertLocalWorkspace(pi, { ...ids, ...refs });
});

test("case-equivalent duplicate workspace rows are ambiguous, not a selectable first match", async () => {
	const pi = { async exec() { return success({ workspaces: [
		{ id: ids.workspace_id, remote: { enabled: false } },
		{ id: ids.workspace_id.toUpperCase(), remote: { enabled: false } },
	] }); } };
	await assert.rejects(assertLocalWorkspace(pi, { ...ids, ...refs }), /ambiguous/);
});

test("a different UUID or refs-only evidence cannot satisfy exact workspace locality", async () => {
	for (const id of [ids.surface_id, refs.workspace_ref]) {
		const pi = { async exec() { return success({ workspaces: [{ id, remote: { enabled: false } }] }); } };
		await assert.rejects(assertLocalWorkspace(pi, { ...ids, ...refs }), /stale|ambiguous/);
	}
});
