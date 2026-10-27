import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import cmuxOpenExtension from "../extensions/cmux-open.ts";
import { getSshTargetRuntime, registerSshTarget } from "../lib/ssh/runtime.ts";
import { buildRemoteHelperCommand, openHelperTerminal, parseHelperArguments } from "../lib/ssh/terminal.ts";

const windowId = "11111111-1111-4111-8111-111111111111";
const workspaceId = "22222222-2222-4222-8222-222222222222";
const surfaceId = "33333333-3333-4333-8333-333333333333";
const paneId = "44444444-4444-4444-8444-444444444444";
const newSurface = "55555555-5555-4555-8555-555555555555";
const newPane = "66666666-6666-4666-8666-666666666666";
const target = { destination: "fixture", remoteCwd: "/remote ' $HOME $(touch BAD) café" };
function harness(options = {}) {
	const calls = [], tools = new Map(), commands = new Map(), handlers = new Map(), statuses = [], notifications = [];
	const ctx = { cwd: "/local/project", signal: undefined, isIdle: () => false, hasUI: true,
		sessionManager: { getSessionId: () => "session", getBranch: () => [] },
		ui: { setStatus: (...v) => statuses.push(v), notify: (...v) => notifications.push(v) } };
	const source = { window_id: windowId, workspace_id: workspaceId, pane_id: paneId, surface_id: surfaceId,
		window_ref: "window:1", workspace_ref: "workspace:1", surface_ref: "surface:1", pane_ref: "pane:1" };
	const pi = {
		appendEntry() {}, registerTool: tool => tools.set(tool.name, tool), registerCommand: (name, c) => commands.set(name, c),
		on(name, fn) { const list = handlers.get(name) ?? []; list.push(fn); handlers.set(name, list); },
		async exec(file, args) {
			calls.push({ file, args });
			if (file === "git") return { code: 1, killed: false, stdout: "", stderr: "" };
			assert.equal(file, "cmux");
			let payload = {};
			if (args.includes("identify")) payload = { caller: source };
			else if (args.includes("system.capabilities")) payload = { methods: options.missingCapabilities ? [] : ["surface.create", "surface.split"] };
			else if (args.includes("workspace.list")) {
				await options.beforeStatus?.();
				payload = options.workspacePayload ?? { workspaces: [{ id: workspaceId, remote: options.remote ?? { enabled: false } }] };
			} else if (args.includes("surface.create") || args.includes("surface.split")) {
				const params = JSON.parse(args.at(-1));
				await options.onCreate?.(params);
				if (options.creationTimeout) return { code: 1, killed: true, stdout: "", stderr: "" };
				payload = options.created ?? { window_id: windowId, workspace_id: workspaceId, surface_id: newSurface,
					pane_id: params.direction ? newPane : paneId, surface_ref: "surface:2", type: "terminal" };
			} else assert.ok(args.includes("rename-tab"), `unexpected ${args.join(" ")}`);
			return { code: 0, killed: false, stdout: JSON.stringify(payload), stderr: "" };
		},
	};
	const runtime = options.noRuntime ? undefined : registerSshTarget(pi);
	runtime?.startSession({ sessionId: "session", localCwd: ctx.cwd }, []);
	const ready = (selection = target, association) => {
		runtime.activate(selection, association);
		const v = runtime.beginValidation();
		runtime.completeValidation(v, association ? { ...association, destination: selection.destination, enabled: true, connected: true, transport: "ssh" } : undefined);
	};
	const createdCalls = () => calls.filter(c => c.args.includes("surface.create") || c.args.includes("surface.split"));
	return { pi, ctx, runtime, ready, calls, createdCalls, commands, tools, handlers, statuses, notifications,
		emit: async name => { for (const fn of handlers.get(name) ?? []) await fn({}, ctx); } };
}

test("ready SSH defaults remote, explicit local stays local, placement/focus/identity are retained", async () => {
	for (const placement of ["tab", "right", "down"]) {
		for (const locality of [undefined, "local", "remote"]) {
			const h = harness(); h.ready();
			const result = await openHelperTerminal(h.pi, h.ctx, { command: "htop", placement, target: locality, focus: false, title: "view" });
			assert.equal(result.ok, true); assert.equal(result.surfaceRef, "surface:2"); assert.equal(result.created.surface_id, newSurface);
			assert.equal(h.createdCalls().length, 1);
			const params = JSON.parse(h.createdCalls()[0].args.at(-1));
			assert.equal(params.focus, false); assert.equal(params.remote_context, "local");
			assert.equal(params.workspace_id, workspaceId); assert.equal(params.surface_id, surfaceId);
			assert.equal(params.direction, placement === "tab" ? undefined : placement);
			const remote = locality !== "local";
			assert.equal(result.target, remote ? "remote" : "local"); assert.equal(result.cwd, remote ? target.remoteCwd : h.ctx.cwd);
			assert.equal(params.initial_command.includes("/usr/bin/ssh"), remote);
			assert.equal(h.calls.some(c => c.file === "git"), !remote, "remote titles must not inspect the local repository");
			assert.equal(h.calls.some(c => c.args.includes("respawn-pane") || c.args.includes("new-surface") || c.args.includes("new-split")), false);
		}
	}
});

test("local sessions stay local; missing/disabled/configured/disconnected remote intent never falls back", async () => {
	for (const noRuntime of [false, true]) {
		const h = harness({ noRuntime });
		assert.equal((await openHelperTerminal(h.pi, h.ctx, { command: "htop" })).target, "local");
		await assert.rejects(openHelperTerminal(h.pi, h.ctx, { command: "htop", target: "remote" }), /No SSH|not ready/);
		assert.equal(h.createdCalls().length, 1);
	}
	for (const state of ["configured", "disabled", "disconnected"]) {
		const h = harness(); h.runtime.activate(target);
		if (state === "disabled") h.runtime.setEnabled(false);
		if (state === "disconnected") h.runtime.disconnect();
		await assert.rejects(openHelperTerminal(h.pi, h.ctx, { command: "htop" }), /not ready/);
		assert.equal(h.createdCalls().length, 0);
		assert.equal((await openHelperTerminal(h.pi, h.ctx, { command: "htop", target: "local" })).target, "local");
	}
});

test("remote-owned native, relay, mirror, missing and ambiguous evidence refuse all intended local/remote launches", async () => {
	for (const remote of [undefined, { enabled: true, transport: "ssh", backend: "native-ssh" }, { enabled: true, backend: "legacy-relay" }, { enabled: true, backend: "tmux-mirror" }, { enabled: false, connected: true }, { enabled: false, transport: "ssh" }]) {
		for (const locality of ["local", "remote"]) {
			const h = harness(remote === undefined ? { workspacePayload: {} } : { remote }); h.ready();
			await assert.rejects(openHelperTerminal(h.pi, h.ctx, { command: "htop", target: locality }), /locality|placement/);
			assert.equal(h.createdCalls().length, 0);
		}
	}
	const h = harness({ workspacePayload: { workspaces: [{ id: workspaceId, remote: { enabled: false } }, { id: workspaceId, remote: { enabled: false } }] } });
	await assert.rejects(openHelperTerminal(h.pi, h.ctx, { command: "htop" }), /ambiguous/);
	assert.equal(h.createdCalls().length, 0);
});

test("stale target/session/cancellation checks occur after awaits and before creation", async () => {
	for (const change of [h => h.runtime.disconnect(), h => h.ready({ ...target, destination: "replacement" }), h => { h.ctx.cwd = "/moved"; }, h => { h.ctx.sessionManager.getSessionId = () => "new"; }]) {
		let h; h = harness({ beforeStatus: () => change(h) }); h.ready();
		await assert.rejects(openHelperTerminal(h.pi, h.ctx, { command: "htop" }), /changed|current/);
		assert.equal(h.createdCalls().length, 0);
	}
	const h = harness(); h.ready(); h.ctx.signal = AbortSignal.abort();
	await assert.rejects(openHelperTerminal(h.pi, h.ctx, { command: "htop" })); assert.equal(h.createdCalls().length, 0);
	const assoc = harness(); assoc.ready(target, { workspaceId, backend: "native-ssh" });
	await assert.rejects(openHelperTerminal(assoc.pi, assoc.ctx, { command: "htop" }), /not validated/);
	assert.equal(assoc.createdCalls().length, 0);
});

test("missing capability, timeout, bad returned identity and target change after create never duplicate creation", async () => {
	const missing = harness({ missingCapabilities: true });
	await assert.rejects(openHelperTerminal(missing.pi, missing.ctx, { command: "htop" }), /unavailable/); assert.equal(missing.createdCalls().length, 0);
	for (const options of [{ creationTimeout: true }, { created: {} }, { created: { window_id: windowId, workspace_id: workspaceId, surface_id: surfaceId, pane_id: paneId, type: "terminal" } }]) {
		const h = harness(options); h.ready();
		await assert.rejects(openHelperTerminal(h.pi, h.ctx, { command: "htop" }), /uncertain.*Do not retry/);
		assert.equal(h.createdCalls().length, 1);
	}
	let h; h = harness({ onCreate: () => h.runtime.disconnect() }); h.ready();
	await assert.rejects(openHelperTerminal(h.pi, h.ctx, { command: "htop" }), /uncertain/); assert.equal(h.createdCalls().length, 1);
});

test("remote helper shell has literal remote cwd and remote PATH, no double SSH or Mac PATH", t => {
	const root = mkdtempSync(join(realpathSync(tmpdir()), "cmux-helper-shell-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const cwd = join(root, "remote ' $HOME $(touch BAD) café"); mkdirSync(cwd);
	const startup = buildRemoteHelperCommand({ destination: "fixture", remoteCwd: cwd }, 'printf "%s\\n%s" "$PWD" "$PATH"');
	assert.equal((startup.match(/\/usr\/bin\/ssh/g) ?? []).length, 1);
	assert.ok(!startup.includes(process.env.PATH));
	// Capture argv at the fake SSH boundary by replacing only its fixed binary.
	const recorder = join(root, "fake-ssh");
	writeFileSync(recorder, '#!/bin/sh\nfor last do :; done\nPATH=/REMOTE_SENTINEL:/usr/bin:/bin; export PATH\nexec /bin/sh -c "$last"\n', { mode: 0o700 });
	const command = startup.replace("/usr/bin/ssh", `'${recorder}'`);
	const result = spawnSync("/bin/sh", ["-c", command], { encoding: "utf8", env: { PATH: "/MAC_SENTINEL" } });
	assert.equal(result.status, 0, result.stderr);
	assert.equal(result.stdout, `${cwd}\n/REMOTE_SENTINEL:/usr/bin:/bin`);
	assert.throws(() => buildRemoteHelperCommand({ destination: "-unsafe", remoteCwd: cwd }, ":"));
});

test("tool/slash/config routing share one boundary, display target state and creation-only result", async t => {
	// Configure a test-only local settings file in an isolated cwd; restore the process cwd.
	const root = mkdtempSync(join(realpathSync(tmpdir()), "cmux-helper-config-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	mkdirSync(join(root, ".pi"));
	writeFileSync(join(root, ".pi/settings.json"), JSON.stringify({ "pi-cmux": { commands: { "fixture-local": { run: "htop", target: "local" }, "fixture-default": "htop" } } }));
	const previous = process.cwd();
	const h = harness();
	try { process.chdir(root); cmuxOpenExtension(h.pi); } finally { process.chdir(previous); }
	await h.emit("session_start"); h.ready();
	assert.match(h.statuses.at(-1)[1], /SSH ready: fixture:.*Pi local/);
	const tool = h.tools.get("cmux_open_terminal");
	assert.deepEqual(tool.parameters.properties.target.enum, ["local", "remote"]);
	const result = await tool.execute("id", { command: "htop", focus: false }, undefined, undefined, h.ctx);
	assert.match(result.content[0].text, /Creation is not command completion/); assert.equal(result.details.created.surface_id, newSurface);
	assert.equal(result.details.cwd, target.remoteCwd);
	for (const [name, args, remote] of [["cmo", "htop", true], ["cmoh", "--local htop", false], ["cmt", "--remote htop", true], ["fixture-local", "", false], ["fixture-default", "", true]]) {
		await h.commands.get(name).handler(args, h.ctx);
		const params = JSON.parse(h.createdCalls().at(-1).args.at(-1));
		assert.equal(params.initial_command.includes("/usr/bin/ssh"), remote, name);
	}
	assert.deepEqual(parseHelperArguments("--local echo hi"), { command: "echo hi", target: "local" });
	assert.deepEqual(parseHelperArguments("--remote"), { command: "", target: "remote" });
	await h.emit("session_shutdown");
	assert.equal(getSshTargetRuntime(h.pi).snapshot().state, "inactive");
});
