import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { PaneSwitcherOverlay, createSwitcherStyle, overlayLayoutFor } from "../lib/switcher/overlay.ts";

const KEYS = { up: "\u001b[A", down: "\u001b[B", enter: "\r", escape: "\u001b", backspace: "\u007f" };

function row(overrides = {}) {
	return {
		windowId: "11111111-1111-4111-8111-111111111111",
		workspaceId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
		paneId: "d1111111-1111-4111-8111-111111111111",
		surfaceId: `e${String(overrides.surfaceIndex ?? 1).padStart(7, "0")}-1111-4111-8111-111111111111`,
		windowIndex: 1,
		workspaceIndex: 1,
		paneIndex: 1,
		surfaceIndex: overrides.surfaceIndex ?? 1,
		workspaceTitle: "pi-cmux",
		surfaceTitle: "Pi · main",
		type: "terminal",
		isCaller: false,
		...overrides,
	};
}

const rows = [
	row({ surfaceIndex: 1, surfaceTitle: "Pi · reviewer", agent: { kind: "pi", state: "working" }, isCaller: true }),
	row({ surfaceIndex: 2, surfaceTitle: "zsh" }),
	row({
		surfaceIndex: 3,
		surfaceTitle: "docs",
		type: "browser",
		url: "https://example.test/docs",
		workspaceTitle: "website",
		workspaceId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
		windowIndex: 2,
	}),
];

function overlay(status, options = {}) {
	const results = [];
	const component = new PaneSwitcherOverlay({ viewportRows: 8, done: (value) => results.push(value), ...options });
	component.setStatus(status ?? { state: "ready", rows, callerWorkspaceId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" });
	return { component, results };
}

function assertWithin(lines, width) {
	for (const line of lines) assert.ok(visibleWidth(line) <= width, `line too wide: ${visibleWidth(line)} > ${width}: ${JSON.stringify(line)}`);
}

test("renders a framed, grouped list with agent labels and the caller marker", () => {
	const { component } = overlay();
	const lines = component.render(60);
	assertWithin(lines, 60);
	const text = lines.join("\n");
	assert.match(text, /✦ Jump to pane/);
	assert.match(text, /3 panes/);
	assert.match(text, /◆ Pi · reviewer/);
	assert.match(text, /◉ docs/);
	assert.match(text, /pi-cmux/);
	assert.match(text, /Pi · reviewer/);
	assert.match(text, /pi · working · you/);
	const selectedTitle = lines.findIndex((line) => line.includes("Pi · reviewer"));
	assert.doesNotMatch(lines[selectedTitle], /working/, "metadata moves below the title instead of using a wide right column");
	assert.match(lines[selectedTitle + 1], /^│ {4}pane 1 · tab 1 · pi · working · you/, "location and agent metadata are indented beneath the title");
	assert.match(text, /terminal/, "rows without cmux agent metadata fall back to the surface type");
	assert.match(text, /website/);
	assert.match(text, /Type to filter/);
	assert.match(lines[0], /^╭/);
	assert.match(lines.at(-1), /^╰/);
});

test("typing, paste and backspace filter immediately and reset selection", () => {
	const { component } = overlay();
	component.handleInput("do");
	assert.deepEqual(component.visibleRows().map((value) => value.surfaceTitle), ["docs"]);
	component.handleInput(KEYS.backspace);
	component.handleInput(KEYS.backspace);
	assert.equal(component.visibleRows().length, 3);
	// A paste arrives as one data chunk.
	component.handleInput("reviewer");
	assert.deepEqual(component.visibleRows().map((value) => value.surfaceTitle), ["Pi · reviewer"]);
	// Filtered rows show the workspace inline.
	const filtered = component.render(60).join("\n");
	assert.match(filtered, /pi-cmux \/ Pi · reviewer/);
	assert.match(filtered, /1\/3/, "the count shows filtered and total panes");
	component.handleInput(KEYS.backspace);
	assert.equal(component.getQuery(), "reviewe");
});

test("selection follows the rendered order and Enter returns the exact row", () => {
	const { component, results } = overlay();
	component.handleInput(KEYS.down);
	assert.equal(component.selectedRow().surfaceTitle, "zsh");
	component.handleInput(KEYS.down);
	assert.equal(component.selectedRow().surfaceTitle, "docs");
	component.handleInput(KEYS.up);
	assert.equal(component.selectedRow().surfaceTitle, "zsh");
	component.handleInput(KEYS.enter);
	assert.equal(results.length, 1);
	assert.equal(results[0].surfaceTitle, "zsh");
	assert.equal(results[0].surfaceId, component.visibleRows().find((value) => value.surfaceTitle === "zsh").surfaceId);
	// One interaction settles once.
	component.handleInput(KEYS.enter);
	assert.equal(results.length, 1);
});

test("Escape cancels without a result and Enter on no matches does nothing", () => {
	const first = overlay();
	first.component.handleInput("nothing-matches");
	assert.equal(first.component.visibleRows().length, 0);
	first.component.handleInput(KEYS.enter);
	assert.equal(first.results.length, 0);
	assert.match(first.component.render(60).join("\n"), /No matching panes/);
	first.component.handleInput(KEYS.escape);
	assert.deepEqual(first.results, [undefined]);
	first.component.handleInput(KEYS.escape);
	assert.equal(first.results.length, 1);
});

test("loading, error and empty states stay readable", () => {
	const loading = overlay({ state: "loading" });
	assert.match(loading.component.render(50).join("\n"), /Reading cmux layout/);
	loading.component.handleInput(KEYS.enter);
	assert.equal(loading.results.length, 0, "Enter cannot select a target before discovery finishes");

	const failed = overlay({ state: "error", message: "Cannot read the cmux layout" });
	assert.match(failed.component.render(50).join("\n"), /Cannot read the cmux layout/);

	const empty = overlay({ state: "ready", rows: [] });
	assert.match(empty.component.render(50).join("\n"), /No switchable cmux panes/);
});

test("cmux error text is sanitized and cannot break the frame", () => {
	const failed = overlay({ state: "error", message: "\u001b[31mcmux failed\u001b[0m\nsecond line\u0007" });
	for (const width of [60, 30]) assertWithin(failed.component.render(width), width);
	const text = failed.component.render(60).join("\n");
	assert.match(text, /cmux failed second line/);
	assert.doesNotMatch(text, /\u001b\[31m/);
	const line = failed.component.render(60).find((value) => value.includes("cmux failed"));
	assert.ok(line);
	assert.doesNotMatch(line, /\u0007|\n/);
});

test("long lists scroll and keep the selection visible", () => {
	const many = Array.from({ length: 40 }, (_, index) => row({
		surfaceIndex: index + 1,
		surfaceTitle: `pane ${index + 1}`,
		surfaceId: `e${String(index + 1).padStart(7, "0")}-1111-4111-8111-111111111111`,
	}));
	const { component } = overlay({ state: "ready", rows: many }, { viewportRows: 5 });
	assert.ok(component.render(60).length <= 5 + 6, "viewport bounds the list even with group headers");
	for (let index = 0; index < 12; index += 1) component.handleInput(KEYS.down);
	const text = component.render(60).join("\n");
	assert.match(text, /▸ › pane 13/);
	assert.doesNotMatch(text, /› pane 1\b/);
	for (let index = 0; index < 40; index += 1) component.handleInput(KEYS.down);
	assert.match(component.render(60).join("\n"), /▸ › pane 40/);
});

test("scrolling and resizing retain the selected workspace header", () => {
	const many = Array.from({ length: 15 }, (_, index) => row({
		surfaceIndex: index + 1,
		surfaceTitle: `shell ${index + 1}`,
		workspaceTitle: "Selected workspace",
		windowIndex: 2,
	}));
	let terminalRows = 24;
	const component = new PaneSwitcherOverlay({ terminalRows: () => terminalRows, done: () => {} });
	component.setStatus({ state: "ready", rows: [
		...many,
		row({ windowId: "other-window", workspaceId: "other-workspace", workspaceTitle: "Other workspace" }),
	], callerWorkspaceId: many[0].workspaceId });
	for (let index = 0; index < 7; index++) component.handleInput(KEYS.down);
	for (const height of [24, 12, 8, 24]) {
		terminalRows = height;
		const lines = component.render(64);
		assert.ok(lines.length <= Math.floor(height * 0.7));
		const text = lines.join("\n");
		assert.match(text, /WORKSPACE  window 2 · Selected workspace/);
		assert.match(text, /▸ › shell 8/);
		assert.match(text, /pane 1 · tab 8 · terminal/);
	}
	for (let index = 0; index < 8; index++) component.handleInput(KEYS.down);
	assert.match(component.render(64).join("\n"), /WORKSPACE  window 1 · Other workspace/);
	component.handleInput(KEYS.up);
	const previousGroup = component.render(64).join("\n");
	assert.match(previousGroup, /WORKSPACE  window 2 · Selected workspace/);
	assert.match(previousGroup, /▸ › shell 15/);
});

test("filtered rows distinguish windows and same-named workspaces", () => {
	const component = new PaneSwitcherOverlay({ viewportRows: 10, done: () => {} });
	component.setStatus({ state: "ready", rows: [
		row({ surfaceTitle: "zsh", workspaceTitle: "project" }),
		row({ surfaceId: "second", surfaceTitle: "zsh", workspaceTitle: "project", workspaceId: "second-workspace", workspaceIndex: 2 }),
		row({ surfaceId: "third", surfaceTitle: "zsh", workspaceTitle: "project", workspaceId: "third-workspace", windowId: "second-window", windowIndex: 2 }),
	] });
	component.handleInput("zsh");
	const lines = component.render(64);
	const titles = lines.filter((line) => line.includes("/ zsh"));
	assert.equal(titles.length, 3);
	assert.equal(new Set(titles.map((line) => line.replace("▸", " "))).size, 3);
	assert.match(titles[0], /window 1 · workspace 1/);
	assert.match(titles[1], /window 1 · workspace 2/);
	assert.match(titles[2], /window 2 · project/);
	assertWithin(lines, 64);
	for (const width of [40, 24]) {
		const narrow = component.render(width);
		const narrowTitles = narrow.filter((line) => line.includes("/ zsh"));
		assert.equal(narrowTitles.length, 3);
		assert.match(narrowTitles[0], /w1\/ws1/);
		assert.match(narrowTitles[1], /w1\/ws2/);
		assert.match(narrowTitles[2], width === 24 ? /w2/ : /window 2/);
		assertWithin(narrow, width);
	}
});

test("long workspace names leave room for distinct filtered tab titles", () => {
	const component = new PaneSwitcherOverlay({ viewportRows: 8, done: () => {} });
	component.setStatus({ state: "ready", rows: [
		row({ surfaceTitle: "Review changes", workspaceTitle: "Long project workspace ".repeat(4) }),
		row({ surfaceIndex: 2, surfaceTitle: "Edit code", workspaceTitle: "Long project workspace ".repeat(4) }),
	] });
	component.handleInput("terminal");
	for (const width of [64, 40, 24]) {
		const lines = component.render(width);
		assertWithin(lines, width);
		const text = lines.join("\n");
		assert.match(text, /\/ Review/);
		assert.match(text, /\/ Edit/);
	}
});

test("resize keeps every line inside the width and degrades gracefully", () => {
	const { component } = overlay();
	for (const width of [80, 60, 40, 25, 20, 12]) {
		const lines = component.render(width);
		assert.ok(lines.length > 0);
		assertWithin(lines, width);
	}
	assert.match(component.render(25)[0], /^╭/);
	assert.doesNotMatch(component.render(20)[0], /^╭/);
});

test("workspace headers stay explicit and groups are separated", () => {
	const styled = [];
	const style = {
		title: (text) => text, accent: (text) => text, muted: (text) => text,
		selected: (text) => text, error: (text) => text, success: (text) => text,
		dim: (text) => { styled.push(text); return text; },
	};
	const single = row({ surfaceTitle: "Review pane", workspaceTitle: "Review pane" });
	const other = row({
		surfaceIndex: 2,
		surfaceTitle: "Pi · main",
		workspaceTitle: "pi-cmux",
		workspaceId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
		surfaceId: "e9999999-9999-4999-8999-999999999999",
	});
	const component = new PaneSwitcherOverlay({ viewportRows: 10, style, done: () => {} });
	component.setStatus({ state: "ready", rows: [single, other], callerWorkspaceId: single.workspaceId });
	const text = component.render(60).join("\n");
	assert.match(text, /WORKSPACE  Review pane/);
	assert.match(text, /WORKSPACE  pi-cmux/);
	assert.ok(styled.includes("WORKSPACE  "), "the workspace label is quieter than its title");
	assert.match(text, /\n│ +│\n│WORKSPACE  pi-cmux +│\n│  › Pi · main/, "groups are separated by a blank line");

	// Repeated workspace and tab titles remain distinct hierarchy levels.
	const mixed = new PaneSwitcherOverlay({ viewportRows: 10, style, done: () => {} });
	mixed.setStatus({
		state: "ready",
		rows: [{ ...single, workspaceTitle: "Pi · main [4d3e]" }, row({ surfaceIndex: 2, surfaceTitle: "Pi · main [4d3e]", workspaceTitle: "Pi · main [4d3e]", surfaceId: "e8888888-8888-4888-8888-888888888888", workspaceId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" })],
		callerWorkspaceId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
	});
	assert.match(mixed.render(60).join("\n"), /WORKSPACE  Pi · main \[4d3e\]/);
});

test("a single workspace keeps its header and identifies pane and tab locations", () => {
	const component = new PaneSwitcherOverlay({ viewportRows: 10, done: () => {} });
	component.setStatus({ state: "ready", rows: [row({ surfaceTitle: "Pi · main" }), row({ surfaceIndex: 2, surfaceTitle: "zsh" })] });
	const lines = component.render(60);
	const body = lines.slice(3, -3).join("\n");
	assert.match(body, /WORKSPACE  pi-cmux/);
	assert.match(body, /pane 1 · tab 1 · terminal/);
	assert.match(body, /pane 1 · tab 2 · terminal/);
	assert.match(body, /Pi · main/);
	assert.match(body, /zsh/);
});

test("Unicode, wide characters and ANSI in cmux text are clipped safely", () => {
	const hostile = [
		row({ surfaceIndex: 1, surfaceTitle: "\u001b[31m日语タイトル\u001b[0m", agent: { kind: "pi", state: "working" } }),
		row({ surfaceIndex: 2, surfaceTitle: "🎉🎉🎉 long ".repeat(6), workspaceTitle: "ワークスペース" }),
	];
	const { component } = overlay({ state: "ready", rows: hostile });
	const wide = component.render(70);
	// The cmux title reaches the row as plain text: no injected color and no
	// leftover control bytes from the untrusted string.
	const titleLine = wide.find((line) => line.includes("日语タイトル"));
	assert.ok(titleLine);
	assert.doesNotMatch(titleLine, /\u001b\[31m/);
	assert.doesNotMatch(titleLine, /\u001b|\u0007/);
	for (const width of [70, 40, 24]) assertWithin(component.render(width), width);
});

test("focus is propagated to the query input for cursor and IME handling", () => {
	const { component } = overlay();
	assert.equal(component.focused, false);
	assert.equal(component.input.focused, false);
	component.focused = true;
	assert.equal(component.input.focused, true);
	component.focused = false;
	assert.equal(component.input.focused, false);
});

test("the list budget follows Pi's 70% overlay cap", () => {
	assert.deepEqual(overlayLayoutFor(undefined), { viewport: 10, framed: true });
	// 80x24: Pi keeps 16 lines, so 10 list rows plus 6 chrome fit exactly.
	assert.deepEqual(overlayLayoutFor(24), { viewport: 10, framed: true });
	assert.deepEqual(overlayLayoutFor(80), { viewport: 16, framed: true });
	// Short terminals drop chrome before sacrificing context or either tab line.
	assert.deepEqual(overlayLayoutFor(8), { viewport: 4, framed: false, minimal: true });
	assert.deepEqual(overlayLayoutFor(12), { viewport: 5, framed: false });
	assert.deepEqual(overlayLayoutFor(4), { viewport: 0, framed: false });
	// Explicit test override wins.
	assert.deepEqual(overlayLayoutFor(24, 5), { viewport: 5, framed: true });
});

test("at 80x24 the selected row and footer stay inside Pi's overlay bounds", () => {
	const many = Array.from({ length: 40 }, (_, index) => row({
		surfaceIndex: index + 1,
		surfaceTitle: `pane ${index + 1}`,
		surfaceId: `e${String(index + 1).padStart(7, "0")}-1111-4111-8111-111111111111`,
	}));
	const component = new PaneSwitcherOverlay({ terminalRows: 24, done: () => {} });
	component.setStatus({ state: "ready", rows: many });
	for (let index = 0; index < 39; index += 1) component.handleInput(KEYS.down);
	const lines = component.render(57);
	const capped = Math.floor(24 * 0.7);
	assert.ok(lines.length <= capped, `rendered ${lines.length} lines for a ${capped}-line overlay`);
	const text = lines.join("\n");
	assert.match(text, /▸ › pane 40/, "the selected row is visible");
	assert.match(text, /Type to filter/, "the footer is visible");
});

test("a height change after opening re-derives the list budget", () => {
	let rowsAvailable = 24;
	const component = new PaneSwitcherOverlay({ terminalRows: () => rowsAvailable, done: () => {} });
	const many = Array.from({ length: 40 }, (_, index) => row({
		surfaceIndex: index + 1,
		surfaceTitle: `pane ${index + 1}`,
		surfaceId: `e${String(index + 1).padStart(7, "0")}-1111-4111-8111-111111111111`,
	}));
	component.setStatus({ state: "ready", rows: many });
	for (let index = 0; index < 39; index += 1) component.handleInput(KEYS.down);
	const short = component.render(57);
	rowsAvailable = 50;
	const tall = component.render(57);
	assert.ok(tall.length > short.length, "a taller terminal exposes more rows without reopening");
	assert.match(tall.join("\n"), /▸ › pane 40/);
	assert.ok(tall.length <= Math.floor(50 * 0.7));
});

test("a very short terminal drops the frame instead of clipping the selection", () => {
	const component = new PaneSwitcherOverlay({ terminalRows: 8, done: () => {} });
	component.setStatus({ state: "ready", rows });
	const lines = component.render(57);
	assert.ok(lines.length <= Math.floor(8 * 0.7));
	assert.doesNotMatch(lines[0], /^╭/);
	assert.match(lines.join("\n"), /WORKSPACE  pi-cmux/);
	assert.match(lines.join("\n"), /▸ ◆ Pi · reviewer/);
});

test("tiny terminal heights never hide an accepted selection", () => {
	let terminalRows = 24;
	const results = [];
	const component = new PaneSwitcherOverlay({ terminalRows: () => terminalRows, done: (value) => results.push(value) });
	component.setStatus({ state: "ready", rows });
	component.render(64);
	// Shrink before another render: Enter must use the current height, not the cache.
	terminalRows = 4;
	component.handleInput(KEYS.enter);
	assert.deepEqual(results, []);
	for (const height of [1, 2, 3, 4, 5]) {
		terminalRows = height;
		const lines = component.render(64);
		assert.ok(lines.length <= Math.max(1, Math.floor(height * 0.7)));
		assert.match(lines.join("\n"), /Resize terminal/);
		component.handleInput(KEYS.enter);
		assert.deepEqual(results, []);
	}
	for (const height of [6, 7, 8, 9, 10, 11, 12, 24]) {
		terminalRows = height;
		const lines = component.render(64);
		assert.ok(lines.length <= Math.floor(height * 0.7));
		const text = lines.join("\n");
		assert.match(text, /WORKSPACE  pi-cmux/);
		assert.match(text, /▸ ◆ Pi · reviewer/);
		assert.match(text, /pane 1 · tab 1 · pi · working · you/);
	}
	component.handleInput(KEYS.enter);
	assert.deepEqual(results, [rows[0]], "growing the terminal restores selection without reopening");
	const cancelled = overlay(undefined, { terminalRows: 4, viewportRows: undefined });
	cancelled.component.handleInput(KEYS.escape);
	assert.deepEqual(cancelled.results, [undefined], "Escape still closes the resize message");
});

test("cursor-only edits repaint the query line", () => {
	const component = new PaneSwitcherOverlay({ viewportRows: 8, done: () => {} });
	component.setStatus({ state: "ready", rows });
	component.focused = true;
	for (const char of "abcd") component.handleInput(char);
	// pi-tui marks the cursor with a private sequence inside the value.
	const visible = (line) => line.replace(/\u001b_pi:[^\u0007]*\u0007/g, "");
	const before = component.render(60)[1];
	assert.match(visible(before), /abcd/);
	component.handleInput("\u001b[D");
	const after = component.render(60)[1];
	assert.match(visible(after), /abcd/);
	assert.notEqual(after, before, "moving the cursor must change the rendered input line");
});

test("theme style wraps without changing visible width", () => {
	const style = createSwitcherStyle({
		fg: (color, text) => `\u001b[${color === "error" ? "31" : color === "success" ? "32" : "2"}m${text}\u001b[0m`,
		bold: (text) => `\u001b[1m${text}\u001b[0m`,
		inverse: (text) => `\u001b[7m${text}\u001b[0m`,
	});
	const { component } = overlay(undefined, { style });
	const lines = component.render(60);
	assertWithin(lines, 60);
	assert.match(lines[0], /\u001b\[1m/);
	assert.match(lines.join("\n"), /\u001b\[7m/, "the selected row is highlighted");
	component.handleInput(KEYS.down);
	assert.match(component.render(60).join("\n"), /\u001b\[32m/, "working agents use the success color");
});
