import assert from "node:assert/strict";
import test from "node:test";
import { Text, getKeybindings, visibleWidth } from "@earendil-works/pi-tui";
import { AnnotationReview, confirmAnnotation } from "../lib/browser/annotation-review.ts";

const keys = getKeybindings();
const theme = { fg: (_color, text) => text };
const DOWN = "\x1b[B", UP = "\x1b[A", ENTER = "\r", TAB = "\t", ESC = "\x1b";
const message = "User request:\n" + Array.from({ length: 20 }, (_, i) => `Request-${i}: ${"wide 界 é 👩‍💻 ".repeat(6)}`).join("\n")
	+ "\nPage context:\nhttps://example.test/?q=" + "a".repeat(1900) + "&end=QUERY_END\nLast instruction";

function harness(content = message, columns = 80, rows = 24) {
	const dimensions = { columns, rows }, choices = [];
	const review = new AnnotationReview(content, () => dimensions, theme, keys, () => {}, choice => choices.push(choice));
	return { review, dimensions, choices, render: () => review.render(dimensions.columns - 2) };
}
function visitAll(h) {
	const seen = [];
	for (let i = 0; i < 10000; i++) {
		const lines = h.render();
		seen.push(...lines);
		assert.ok(lines.length <= h.dimensions.rows - 2);
		assert.ok(lines.every(line => visibleWidth(line) <= h.dimensions.columns - 2));
		assert.match(lines.slice(0, 4).join("\n"), /forge/);
		if (!lines.join("\n").includes("[locked]")) return seen;
		h.review.handleInput(DOWN);
	}
	assert.fail("review did not reach the final page");
}

for (const [columns, rows] of [[80, 24], [40, 20], [120, 32]]) {
	test(`review keeps all content reachable and actions bounded at ${columns}x${rows}`, () => {
		const h = harness(message, columns, rows);
		const shown = visitAll(h).join("\n");
		for (const line of new Text(message, 0, 0).render(columns - 2)) {
			assert.ok(shown.includes(line), `Missing rendered content: ${line}`);
		}
		assert.deepEqual(h.choices, []);
		h.review.handleInput(TAB); h.render(); h.review.handleInput(ENTER);
		assert.deepEqual(h.choices, ["Send to Pi"]);
	});
}

test("initial Enter and Enter after reviewing still default to Cancel", () => {
	for (const complete of [false, true]) {
		const h = harness();
		if (complete) visitAll(h); else h.render();
		h.review.handleInput(ENTER);
		assert.deepEqual(h.choices, [undefined]);
	}
});

test("Tab cannot unlock approval before every page has been rendered", () => {
	const h = harness(); h.render();
	for (let i = 0; i < 100; i++) h.review.handleInput(DOWN); // No render between inputs.
	h.render(); h.review.handleInput(TAB); h.review.handleInput(ENTER);
	assert.deepEqual(h.choices, [undefined]);
});

test("previous pages remain accessible, and resize resets review and approval", () => {
	const h = harness(); const first = h.render().join("\n");
	h.review.handleInput(DOWN); h.render(); h.review.handleInput(UP);
	assert.equal(h.render().join("\n"), first);
	visitAll(h); h.review.handleInput(TAB);
	h.dimensions.columns = 40;
	h.review.handleInput(ENTER); // Resize happened before the scheduled render.
	assert.deepEqual(h.choices, []);
	assert.match(h.render().join("\n"), /Page 1\//);
	assert.match(h.render().join("\n"), /\[locked\]/);
	h.review.handleInput(TAB); h.review.handleInput(ENTER);
	assert.deepEqual(h.choices, [undefined]);
});

test("tiny terminals fail closed but can cancel", () => {
	const h = harness("Short request", 20, 5);
	const lines = h.render();
	assert.ok(lines.length <= 3);
	assert.ok(lines.every(line => visibleWidth(line) <= 18));
	h.review.handleInput(TAB); h.review.handleInput(ENTER);
	assert.deepEqual(h.choices, [undefined]);
	const escape = harness(); escape.render(); escape.review.handleInput(ESC);
	assert.deepEqual(escape.choices, [undefined]);
});

test("RPC review shows bounded pages, defaults to Cancel, and only offers approval last", async () => {
	const titles = [], signals = [];
	const ctx = { mode: "rpc", ui: { async select(title, choices, options) {
		titles.push(title); signals.push(options.signal);
		assert.equal(choices[0], "Cancel");
		assert.ok(title.split("\n").length <= 12);
		assert.ok(options.timeout > 0 && options.timeout <= 120000);
		return choices.includes("Next page") ? "Next page" : "Send to Pi";
	} } };
	assert.equal(await confirmAnnotation(ctx, message, new AbortController().signal), "Send to Pi");
	assert.ok(titles.length > 1);
	assert.equal(new Set(signals).size, 1, "all pages share one cancellation/deadline signal");
	for (const line of new Text(message, 0, 0).render(60)) assert.ok(titles.join("\n").includes(line));
});

test("RPC premature approval is rejected and cancellation stops pagination", async () => {
	for (const action of ["Send to Pi", "Cancel", "abort"]) {
		const controller = new AbortController(); let calls = 0;
		const ctx = { mode: "rpc", ui: { async select() {
			calls++;
			if (action === "abort") controller.abort();
			return action === "abort" ? "Next page" : action;
		} } };
		assert.equal(await confirmAnnotation(ctx, message, controller.signal), undefined);
		assert.equal(calls, 1);
	}
});

function customHarness() {
	let review, resolve, overlay;
	const ctx = { mode: "tui", ui: { custom(factory, options) {
		overlay = options;
		const result = new Promise(done => { resolve = done; });
		review = factory({ terminal: { columns: 80, rows: 24 }, requestRender() {} }, theme, keys, resolve);
		return result;
	} } };
	return { ctx, get review() { return review; }, get overlay() { return overlay; } };
}

test("TUI confirmation handles abort and pre-aborted work without dispatch", async () => {
	const h = customHarness(), controller = new AbortController();
	const pending = confirmAnnotation(h.ctx, message, controller.signal);
	assert.equal(h.overlay.overlay, true);
	h.review.render(78);
	controller.abort();
	assert.equal(await pending, undefined);
	const preaborted = customHarness();
	assert.equal(await confirmAnnotation(preaborted.ctx, message, AbortSignal.abort()), undefined);
	assert.equal(preaborted.review, undefined);
});

test("both confirmation modes expire on a single two-minute deadline", async t => {
	const timeout = new AbortController();
	t.mock.method(AbortSignal, "timeout", ms => { assert.equal(ms, 120000); return timeout.signal; });
	const h = customHarness();
	const tui = confirmAnnotation(h.ctx, message, new AbortController().signal);
	let rpcSignal;
	const rpc = confirmAnnotation({ mode: "rpc", ui: { select(_title, _choices, { signal }) {
		rpcSignal = signal;
		return new Promise(resolve => signal.addEventListener("abort", () => resolve(undefined), { once: true }));
	} } }, message, new AbortController().signal);
	timeout.abort();
	assert.equal(await tui, undefined);
	assert.equal(await rpc, undefined);
	assert.equal(rpcSignal.aborted, true);
});
