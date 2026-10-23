import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { buildPiCommand } from "../extensions/cmux-core.ts";
import { openPiSession } from "../extensions/cmux-pi.ts";
import cmuxStart from "../extensions/cmux-start.ts";
import { prepareOrientation } from "../lib/orientation/runtime.ts";
import { BOOTSTRAP_ENV, ORIENTATION_ENTRY, childBootstrap, decodeBootstrap, encodeBootstrap, liveBinding, parseOrientation, rootOrientation } from "../lib/orientation/state.ts";
import { orientationHarness, target } from "./helpers/orientation.mjs";

const immediateTimeouts = (t) => t.mock.method(globalThis, "setTimeout", (callback) => { queueMicrotask(callback); return 0; });

test("bootstrap preserves identities outside argv/prompt and quotes its environment value", (t) => {
	const h = orientationHarness(t), parent = rootOrientation(randomUUID());
	const seed = childBootstrap(parent, target(), true, "review", "Review auth");
	const encoded = encodeBootstrap(seed);
	assert.deepEqual(decodeBootstrap(encoded), seed);
	const bin = join(h.root, "bin"); mkdirSync(bin);
	const pi = join(bin, "pi");
	writeFileSync(pi, `#!${process.execPath}\nconsole.log(JSON.stringify({seed:process.env.${BOOTSTRAP_ENV},args:process.argv.slice(2)}));`); chmodSync(pi, 0o755);
	const old = process.env.PATH; process.env.PATH = `${bin}:${old}`;
	try {
		const result = spawnSync("/bin/sh", ["-c", buildPiCommand(h.root, { orientationBootstrap: encoded, prompt: "--help" })], { encoding: "utf8" });
		assert.equal(result.status, 0, result.stderr);
		assert.deepEqual(JSON.parse(result.stdout), { seed: encoded, args: ["--", "--help"] });
	} finally { process.env.PATH = old; }
	for (const invalid of ["bad!", "x".repeat(8193), Buffer.from('{}').toString('base64url')]) assert.throws(() => decodeBootstrap(invalid), /Invalid/);
});

test("reload/resume restores own metadata; new/fork does not inherit another session's identity", async (t) => {
	const h = orientationHarness(t);
	await h.emit("session_start");
	const original = h.runtime.state;
	assert.ok(liveBinding(h.store.read(h.location.surfaceId), original));
	assert.equal(statSync(join(h.store.directory, `${h.location.surfaceId}.json`)).mode & 0o777, 0o600);
	await h.emit("session_start");
	assert.deepEqual(h.runtime.state, original);
	const fork = SessionManager.inMemory(h.root);
	fork.appendCustomEntry(ORIENTATION_ENTRY, original);
	h.ctx.sessionManager = fork;
	await h.emit("session_start");
	assert.notEqual(h.runtime.state.taskId, original.taskId);
	assert.equal(h.runtime.state.origin, undefined);
	assert.equal(parseOrientation(original, fork.getSessionId()), undefined);
});

test("child bootstrap is consumed once, overrides handoff copies, and survives same-session tree/reset", async (t) => {
	const parent = rootOrientation(randomUUID()), origin = target();
	const seed = childBootstrap(parent, origin, true, "review", "Auth review");
	const h = orientationHarness(t, { bootstrap: encodeBootstrap(seed) });
	h.ctx.sessionManager.appendCustomEntry(ORIENTATION_ENTRY, parent);
	await h.emit("session_start");
	assert.equal(process.env[BOOTSTRAP_ENV], undefined);
	assert.equal(h.runtime.state.taskId, parent.taskId);
	assert.equal(h.runtime.state.origin.conversationId, parent.conversationId);
	assert.notEqual(h.runtime.state.conversationId, parent.conversationId);
	const own = h.runtime.state;
	await h.emit("session_tree"); assert.deepEqual(h.runtime.state, own);
	h.ctx.sessionManager = SessionManager.inMemory(h.root);
	await h.emit("session_start");
	assert.equal(h.runtime.state.origin, undefined);
	assert.notEqual(h.runtime.state.taskId, parent.taskId);
});

test("tree navigation before metadata creates a new branch-local identity", async (t) => {
	const h = orientationHarness(t);
	const before = h.ctx.sessionManager.appendCustomEntry("test", {});
	await h.emit("session_start"); const original = h.runtime.state;
	h.ctx.sessionManager.branch(before);
	await h.emit("session_tree");
	assert.notEqual(h.runtime.state.conversationId, original.conversationId);
});

test("independent chats have different task groups; reviewers and further reviewers share a group", async (t) => {
	const h = orientationHarness(t); await h.emit("session_start");
	const parent = h.runtime.state;
	const independent = prepareOrientation(h.pi, {}, "Another task");
	const reviewer = prepareOrientation(h.pi, { role: "review" }, "Review");
	assert.notEqual(independent.taskId, parent.taskId);
	assert.equal(reviewer.taskId, parent.taskId);
	const grandchild = childBootstrap({ ...reviewer, sessionId: randomUUID() }, target(), true, "review", "Review reviewer");
	assert.equal(grandchild.taskId, parent.taskId);
	assert.equal(grandchild.origin.conversationId, reviewer.conversationId);
	assert.throws(() => prepareOrientation(h.pi, { related: false, role: "review" }, "Review"), /require related/);
});

for (const placement of ["workspace", "right", "down", "tab"]) {
	test(`tracked ${placement} launch retains targets and carries fresh reviewer bootstrap without history`, async (t) => {
		const h = orientationHarness(t); immediateTimeouts(t);
		await h.emit("session_start"); cmuxStart(h.pi);
		const before = h.ctx.sessionManager.getBranch().length;
		const result = await h.tools.get("cmux_start_pi").execute("call", { placement, role: "review", prompt: "Check auth", focus: false }, undefined, undefined, h.ctx);
		assert.equal(result.details.surfaceRef, "surface:2");
		assert.equal(result.details.source.surface_ref, "surface:1");
		assert.equal(result.details.created.surface_id, "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb");
		assert.equal(result.details.navigation.originUrl, `cmux://workspace/${h.location.workspaceId}/surface/${h.location.surfaceId}`);
		assert.ok(result.content[0].text.includes(result.details.navigation.originUrl));
		const launch = h.calls.find(c => c.args[0] === "respawn-pane").args;
		const command = launch.at(-1), raw = command.match(/PI_CMUX_ORIENTATION='([^']+)'/)[1];
		const seed = decodeBootstrap(raw);
		assert.equal(seed.role, "review"); assert.equal(seed.taskId, h.runtime.state.taskId);
		assert.equal(seed.origin.target.surfaceId, h.location.surfaceId);
		assert.equal(command.includes("--session"), false);
		assert.ok(command.endsWith(" -- 'Check auth'"), "navigation instructions must not rewrite the requested task prompt");
		assert.equal(h.ctx.sessionManager.getBranch().length, before, "launch must not copy or mutate source history");
		const creation = h.calls.find(c => c.args.includes(placement === "workspace" ? "create" : placement === "tab" ? "new-surface" : "new-split"));
		assert.equal(creation.args.at(-1), "false");
	});
}

test("expired or repurposed source bindings reject tracked launches before creation", async (t) => {
	const h = orientationHarness(t); await h.emit("session_start");
	const binding = h.store.read(h.location.surfaceId);
	h.store.write(h.location.surfaceId, { ...binding, expiresAt: 0 });
	await assert.rejects(() => openPiSession(h.pi, h.root, { related: true }), /no longer live/);
	assert.equal(h.calls.some(c => c.args.includes("new-split") || c.args.includes("create")), false);
	h.store.write(h.location.surfaceId, { ...binding, conversationId: randomUUID() });
	h.runtime.stop();
	assert.equal(h.store.read(h.location.surfaceId), undefined, "the same runtime token can clean up its expired/changed claim");
});

test("shutdown does not remove another runtime's binding", async (t) => {
	const h = orientationHarness(t); await h.emit("session_start");
	const claim = { ...h.store.read(h.location.surfaceId), token: randomUUID() };
	h.store.write(h.location.surfaceId, claim); await h.emit("session_shutdown");
	assert.deepEqual(h.store.read(h.location.surfaceId), claim);
});

test("invalid caller UUIDs disable orientation without creating a target", async (t) => {
	const h = orientationHarness(t, { exec: (_command, args) => args.includes("identify") ? { code: 0, stdout: '{"caller":{"surface_ref":"surface:1"}}' } : undefined });
	await h.emit("session_start");
	assert.equal(h.runtime.state, undefined);
	assert.match(h.notifications.at(-1)[0], /UUID-bearing/);
	assert.throws(() => prepareOrientation(h.pi, { role: "review" }, "Review"), /UUID targeting/);
});
