import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { test } from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { Markdown, getCapabilities, setCapabilities } from "@earendil-works/pi-tui";
import cmuxStart from "../extensions/cmux-start.ts";
import { openPiSession } from "../extensions/cmux-pi.ts";
import { childNavigationHint, navigationHints, NAVIGATION_MESSAGE, resolveReturnShortcut } from "../lib/orientation/hints.ts";
import { childBootstrap, encodeBootstrap, marker, rootOrientation } from "../lib/orientation/state.ts";
import { orientationHarness, target } from "./helpers/orientation.mjs";

function relatedHarness(t, role = "continue") {
	const parent = rootOrientation(randomUUID()), originTarget = target();
	const seed = childBootstrap(parent, originTarget, true, role, "Handoff");
	const h = orientationHarness(t, { bootstrap: encodeBootstrap(seed) });
	const note = () => h.events.get("before_agent_start")[0]({}, h.ctx);
	return { ...h, seed, parent, originTarget, note };
}
function persistNote(h, result) {
	const message = result.message;
	h.ctx.sessionManager.appendCustomMessageEntry(message.customType, message.content, message.display, message.details);
}
const immediateTimeouts = (t) => t.mock.method(globalThis, "setTimeout", callback => { queueMicrotask(callback); return 0; });

for (const role of ["chat", "review", "continue"]) {
	test(`${role}: first normal turn gets a visible origin link and return guidance`, async (t) => {
		const h = relatedHarness(t, role); await h.emit("session_start");
		const result = await h.note(), message = result.message;
		assert.equal(message.customType, NAVIGATION_MESSAGE);
		assert.equal(message.display, true);
		assert.ok(message.content.includes(`[${marker(h.parent)}](cmux://workspace/${h.originTarget.workspaceId}/surface/${h.originTarget.surfaceId})`));
		assert.match(message.content, /\/cmbk.*Ctrl\+Alt\+B/);
		assert.match(message.content, /do not navigate unless explicitly asked/);
		assert.match(message.content, /does not check which Pi session/);
		assert.match(message.content, /not a message channel/);
		assert.equal(message.details.sessionId, h.ctx.sessionManager.getSessionId());
	});
}

test("notes are branch/session scoped, survive reload without duplication, and replace inherited hints", async (t) => {
	const h = relatedHarness(t);
	h.ctx.sessionManager.appendCustomMessageEntry(NAVIGATION_MESSAGE, "Inherited source link", true, { sessionId: h.parent.sessionId, conversationId: h.parent.conversationId });
	await h.emit("session_start");
	const beforeNote = h.ctx.sessionManager.getLeafId();
	const result = await h.note(); assert.ok(result);
	persistNote(h, result);
	assert.equal(await h.note(), undefined);
	await h.emit("session_start"); assert.equal(await h.note(), undefined);
	h.ctx.sessionManager.branch(beforeNote);
	await h.emit("session_tree"); assert.ok(await h.note());
	h.ctx.sessionManager = SessionManager.inMemory(h.root);
	assert.equal(await h.note(), undefined, "stale runtime context cannot inject into another session");
	await h.emit("session_start"); assert.equal(await h.note(), undefined, "new root has no origin");
});

for (const [key, label] of [["ctrl+shift+y", "Ctrl+Shift+Y"], ["off", undefined], ["ctrl+ctrl+b", undefined]]) {
	test(`child guidance honors shortcut setting ${key}`, async (t) => {
		const old = process.env.PI_CMUX_RETURN_KEY; process.env.PI_CMUX_RETURN_KEY = key;
		t.after(() => { if (old === undefined) delete process.env.PI_CMUX_RETURN_KEY; else process.env.PI_CMUX_RETURN_KEY = old; });
		t.mock.method(console, "warn", () => {});
		const h = relatedHarness(t); await h.emit("session_start");
		const text = (await h.note()).message.content;
		assert.match(text, /\/cmbk/);
		if (label) { assert.ok(text.includes(label)); assert.ok(h.shortcuts.has(key)); }
		else { assert.equal(text.includes("Ctrl+Alt+B"), false); assert.equal(text.split("\n").find(line => line.startsWith("Return from")), "Return from this pane with `/cmbk`."); assert.equal(h.shortcuts.size, 0); }
	});
}

test("a note for an older shortcut does not suppress current navigation guidance", async (t) => {
	const h = relatedHarness(t); await h.emit("session_start");
	const first = await h.note();
	persistNote(h, first);
	persistNote(h, { message: { ...first.message, details: { ...first.message.details, shortcutKey: "old-shortcut" } } });
	const current = await h.note();
	assert.ok(current);
	persistNote(h, current);
	assert.equal(await h.note(), undefined);
});

test("guidance describes the registered shortcut until runtime reload", async (t) => {
	const old = process.env.PI_CMUX_RETURN_KEY; process.env.PI_CMUX_RETURN_KEY = "ctrl+shift+y";
	t.after(() => { if (old === undefined) delete process.env.PI_CMUX_RETURN_KEY; else process.env.PI_CMUX_RETURN_KEY = old; });
	const h = relatedHarness(t);
	process.env.PI_CMUX_RETURN_KEY = "off";
	await h.emit("session_start");
	assert.ok(h.shortcuts.has("ctrl+shift+y"));
	assert.match((await h.note()).message.content, /Ctrl\+Shift\+Y/);
});

test("empty related chat does not rewrite its prompt or start a model turn", async (t) => {
	const h = orientationHarness(t); immediateTimeouts(t);
	h.pi.sendMessage = () => assert.fail("must not start a turn");
	h.pi.sendUserMessage = () => assert.fail("must not start a turn");
	await h.emit("session_start");
	const result = await openPiSession(h.pi, h.root, { placement: "right", related: true });
	assert.ok(result.navigation);
	const command = h.calls.find(call => call.args[0] === "respawn-pane").args.at(-1);
	assert.equal(command.includes(" -- "), false);
	assert.equal(h.ctx.sessionManager.getBranch().some(entry => entry.type === "custom_message"), false);
});

test("independent chats and malformed origins do not get navigation instructions", async (t) => {
	const h = orientationHarness(t); await h.emit("session_start");
	assert.equal(h.runtime.navigationMessage(h.ctx), undefined);
	const parent = rootOrientation(randomUUID()), seed = childBootstrap(parent, target(), false, "chat", "Unrelated");
	assert.equal(navigationHints(seed), undefined);
	seed.taskId = parent.taskId;
	seed.origin.target.surfaceId = "surface:1";
	assert.equal(navigationHints(seed), undefined, "short refs are not deep-link identities");
	seed.origin.target.surfaceId = "../../injected\ncommand";
	assert.equal(navigationHints(seed), undefined);
});

for (const mode of ["print", "json", "rpc", "sdk"]) {
	test(`${mode} does not inject navigation context`, async (t) => {
		const h = relatedHarness(t); h.ctx.mode = mode;
		await h.emit("session_start"); assert.equal(await h.note(), undefined);
	});
}

test("handoff tool returns exact origin navigation without changing handoff task instructions", async (t) => {
	const h = orientationHarness(t); immediateTimeouts(t); await h.emit("session_start");
	const create = SessionManager.create;
	t.mock.method(SessionManager, "create", (cwd, sessionDir, options) => create.call(SessionManager, cwd, sessionDir ?? join(h.root, "seeds"), options));
	cmuxStart(h.pi);
	const tool = h.tools.get("cmux_start_pi");
	assert.ok(tool.promptGuidelines.some(text => text.includes("returned origin link and /cmbk")));
	const result = await tool.execute("handoff", { continueSession: true, prompt: "Continue with tests" }, undefined, undefined, h.ctx);
	assert.equal(result.details.navigation.originUrl, `cmux://workspace/${h.location.workspaceId}/surface/${h.location.surfaceId}`);
	assert.equal(result.details.navigation.returnCommand, "/cmbk");
	assert.ok(result.content[0].text.includes(result.details.navigation.originUrl));
	assert.match(result.content[0].text, /default shortcut: Ctrl\+Alt\+B; configurable/);
	const command = h.calls.find(call => call.args[0] === "respawn-pane").args.at(-1);
	assert.ok(command.includes("Continue the current task"));
	assert.ok(command.includes("Continue with tests"));
	assert.equal(command.includes("cmux://"), false, "hints are child context, not edits to the task prompt");
});

for (const hyperlinks of [true, false]) {
	test(`Pi Markdown renders the origin link with hyperlinks=${hyperlinks}`, (t) => {
		const previous = getCapabilities(); t.after(() => setCapabilities(previous));
		setCapabilities({ ...previous, hyperlinks });
		const parent = rootOrientation(randomUUID()), hints = navigationHints(childBootstrap(parent, target(), true, "continue", "Handoff"));
		const theme = Object.fromEntries(["heading", "link", "linkUrl", "code", "codeBlock", "codeBlockBorder", "quote", "quoteBorder", "hr", "listBullet", "bold", "italic", "strikethrough", "underline"].map(key => [key, text => text]));
		const rendered = new Markdown(childNavigationHint(hints, resolveReturnShortcut()), 0, 0, theme).render(200).join("\n");
		assert.ok(rendered.includes(hints.originUrl));
		assert.equal(rendered.includes(`\x1b]8;;${hints.originUrl}`), hyperlinks);
	});
}

test("default shortcut normalization and native link construction are deterministic", () => {
	assert.deepEqual(resolveReturnShortcut(), { key: "ctrl+alt+b", label: "Ctrl+Alt+B", invalid: false });
	assert.deepEqual(resolveReturnShortcut(" CTRL+ALT+LEFT "), { key: "ctrl+alt+left", label: "Ctrl+Alt+Left", invalid: false });
	assert.deepEqual(resolveReturnShortcut("off"), { invalid: false });
	const parent = rootOrientation(randomUUID()), origin = target();
	const hints = navigationHints(childBootstrap(parent, origin, true, "continue", "Handoff"));
	assert.equal(hints.originUrl, `cmux://workspace/${origin.workspaceId}/surface/${origin.surfaceId}`);
	assert.equal(childNavigationHint(hints, resolveReturnShortcut("off")).includes("Ctrl+Alt+B"), false);
});
