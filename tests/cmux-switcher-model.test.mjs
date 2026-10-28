import assert from "node:assert/strict";
import test from "node:test";
import {
	agentLabel,
	filterRows,
	groupRows,
	rowTitle,
	safeText,
	sortRows,
	typeLabel,
	workspaceLabel,
} from "../lib/switcher/model.ts";

function row(overrides = {}) {
	return {
		windowId: "11111111-1111-4111-8111-111111111111",
		workspaceId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
		paneId: "d1111111-1111-4111-8111-111111111111",
		surfaceId: "e1111111-1111-4111-8111-111111111111",
		windowIndex: 1,
		workspaceIndex: 1,
		paneIndex: 1,
		surfaceIndex: 1,
		workspaceTitle: "pi-cmux",
		surfaceTitle: "Pi · main",
		type: "terminal",
		isCaller: false,
		...overrides,
	};
}

test("safeText strips ANSI and control characters and bounds length", () => {
	assert.equal(safeText("\u001b[31mred\u001b[0m"), "red");
	assert.equal(safeText("a\u0007b\u0000c"), "a b c");
	assert.equal(safeText("  spaced \n title "), "spaced title");
	assert.equal(safeText("x".repeat(500)).length, 200);
	assert.equal(safeText(undefined, "fallback"), "fallback");
	assert.equal(safeText(""), "");
});

test("agentLabel uses only reported metadata and never invents a state", () => {
	assert.equal(agentLabel(row({ agent: { kind: "pi", state: "working" } })), "pi · working");
	assert.equal(agentLabel(row()), undefined);
	assert.equal(agentLabel(row({ agent: { kind: "", state: "working" } })), undefined);
	assert.equal(typeLabel(row()), "terminal");
});

test("rowTitle falls back to url then type", () => {
	assert.equal(rowTitle(row({ surfaceTitle: "Reviewer" })), "Reviewer");
	assert.equal(rowTitle(row({ surfaceTitle: "", url: "https://example.test/x", type: "browser" })), "https://example.test/x");
	assert.equal(rowTitle(row({ surfaceTitle: "", type: "browser" })), "browser");
});

test("filterRows matches all tokens case-insensitively and keeps order", () => {
	const rows = [
		row({ surfaceId: "e1111111-1111-4111-8111-111111111111", surfaceTitle: "Pi · reviewer" }),
		row({ surfaceId: "e2222222-2222-4222-8222-222222222222", surfaceTitle: "zsh", workspaceTitle: "website" }),
		row({ surfaceId: "e3333333-3333-4333-8333-333333333333", surfaceTitle: "docs", type: "browser", agent: { kind: "claude", state: "idle" } }),
	];
	assert.deepEqual(filterRows(rows, "").map((value) => value.surfaceId), rows.map((value) => value.surfaceId));
	assert.deepEqual(filterRows(rows, "  ").map((value) => value.surfaceId), rows.map((value) => value.surfaceId));
	assert.deepEqual(filterRows(rows, "PI REVIEW").map((value) => value.surfaceId), [rows[0].surfaceId]);
	assert.deepEqual(filterRows(rows, "website zsh").map((value) => value.surfaceId), [rows[1].surfaceId]);
	assert.deepEqual(filterRows(rows, "claude idle").map((value) => value.surfaceId), [rows[2].surfaceId]);
	assert.deepEqual(filterRows(rows, "browser").map((value) => value.surfaceId), [rows[2].surfaceId]);
	assert.deepEqual(filterRows(rows, "nothing-here"), []);
});

test("groupRows puts the caller workspace first and keeps stable inner order", () => {
	const caller = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
	const rows = [
		row({ surfaceId: "e2222222-2222-4222-8222-222222222222", surfaceIndex: 2 }),
		row({ surfaceId: "e1111111-1111-4111-8111-111111111111", surfaceIndex: 1 }),
		row({
			surfaceId: "e3333333-3333-4333-8333-333333333333",
			windowId: "22222222-2222-4222-8222-222222222222",
			workspaceId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
			windowIndex: 2,
			workspaceTitle: "website",
		}),
	];
	const groups = groupRows(rows, caller);
	assert.deepEqual(groups.map((group) => group.workspaceTitle), ["pi-cmux", "website"]);
	assert.deepEqual(groups[0].rows.map((value) => value.surfaceIndex), [1, 2]);
	assert.equal(workspaceLabel(groups[1], 2), "window 2 · website");
	assert.equal(workspaceLabel(groups[1], 1), "website");
	assert.equal(workspaceLabel({ ...groups[1], workspaceTitle: "" }, 1), "untitled workspace");
	assert.equal(workspaceLabel(groups[1], 1, true), "workspace 1 · website");
	assert.equal(workspaceLabel(groups[1], 2, true), "window 2 · workspace 1 · website");
});

test("sortRows is deterministic across windows, workspaces, panes and tabs", () => {
	const rows = [
		row({ surfaceId: "e3333333-3333-4333-8333-333333333333", windowIndex: 2, workspaceIndex: 1, paneIndex: 1, surfaceIndex: 1 }),
		row({ surfaceId: "e2222222-2222-4222-8222-222222222222", windowIndex: 1, workspaceIndex: 2, paneIndex: 1, surfaceIndex: 1 }),
		row({ surfaceId: "e1111111-1111-4111-8111-111111111111", windowIndex: 1, workspaceIndex: 1, paneIndex: 2, surfaceIndex: 1 }),
	];
	assert.deepEqual(sortRows(rows).map((value) => value.surfaceId), [
		"e1111111-1111-4111-8111-111111111111",
		"e2222222-2222-4222-8222-222222222222",
		"e3333333-3333-4333-8333-333333333333",
	]);
});
