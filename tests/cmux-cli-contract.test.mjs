import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { isAbsolute, join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { buildPiCommand, buildShellCommand, openCommandInNewWorkspace, openCommandInNewSplit, openCommandInNewTab } from "../extensions/cmux-core.ts";
import { MessageClient, METHODS } from "../lib/messaging/client.ts";
import { makeEnvelope } from "../lib/messaging/protocol.ts";
import { childBootstrap, encodeBootstrap } from "../lib/orientation/state.ts";

// Opt in with an absolute CLI path. Default CI never needs cmux or a running app.
const cli = process.env.PI_CMUX_TEST_CLI;
const contract = { skip: !cli && "Set PI_CMUX_TEST_CLI to an installed cmux executable", timeout: 30_000 };
const execute = promisify(execFile);
// Synthetic data only. No live identify, config, socket, or captured session fixtures.
const WINDOW = "11111111-1111-4111-8111-111111111111";
const SOURCE_WORKSPACE = "22222222-2222-4222-8222-222222222222";
const SOURCE_SURFACE = "33333333-3333-4333-8333-333333333333";
const WORKSPACE = "44444444-4444-4444-8444-444444444444";
const SURFACE = "55555555-5555-4555-8555-555555555555";
const PANE = "66666666-6666-4666-8666-666666666666";
const OTHER_WINDOW = "99999999-9999-4999-8999-999999999999";
const CALLER = {
	window_id: WINDOW, window_ref: "window:1",
	workspace_id: SOURCE_WORKSPACE, workspace_ref: "workspace:1",
	surface_id: SOURCE_SURFACE, surface_ref: "surface:1", pane_id: PANE, pane_ref: "pane:1",
};
const CREATED = {
	window_id: WINDOW, window_ref: "window:1",
	workspace_id: WORKSPACE, workspace_ref: "workspace:7",
	surface_id: SURFACE, surface_ref: "surface:27",
};
const CWD = "/tmp/pi-cmux-contract-project";
const TITLE = "Contract 'title' · project";

async function fakeCli(t, options = {}) {
	assert.ok(isAbsolute(cli), "PI_CMUX_TEST_CLI must be an absolute executable path");
	// Keep the Unix socket path short even on macOS. HOME is isolated too.
	const root = await mkdtemp("/tmp/pc-contract-");
	const socketPath = join(root, "socket");
	const requests = [], requestLines = [];
	const calls = [];
	const failures = [];
	const sockets = new Set();
	const server = createServer((socket) => {
		sockets.add(socket);
		socket.on("close", () => sockets.delete(socket));
		socket.on("error", (error) => failures.push(error.message));
		socket.setEncoding("utf8");
		let buffer = "";
		socket.on("data", (chunk) => {
			buffer += chunk;
			while (buffer.includes("\n")) {
				const end = buffer.indexOf("\n");
				const line = buffer.slice(0, end);
				buffer = buffer.slice(end + 1);
				let request;
				try {
					request = JSON.parse(line);
					requests.push(request);
					requestLines.push(line);
					let result;
					switch (request.method) {
						case "system.capabilities": result = { methods: METHODS }; break;
						case "system.identify": result = { caller: CALLER, focused: { window_id: OTHER_WINDOW, window_ref: "window:99" } }; break;
						case "window.list": result = { windows: [{ id: OTHER_WINDOW, ref: "window:99" }, { id: WINDOW, ref: "window:1" }] }; break;
						case "workspace.list":
							// Newer CLIs can enumerate workspaces without a window selector while resolving a ref.
							assert.ok([undefined, WINDOW, OTHER_WINDOW].includes(request.params.window_id));
							result = { workspaces: request.params.window_id !== OTHER_WINDOW
								? [{ id: SOURCE_WORKSPACE, ref: "workspace:1" }, { id: WORKSPACE, ref: "workspace:7" }]
								: [] };
							break;
						case "surface.list":
							assert.ok([WORKSPACE, SOURCE_WORKSPACE].includes(request.params.workspace_id));
							result = { surfaces: [{ id: SOURCE_SURFACE, ref: "surface:1" }, { id: SURFACE, ref: "surface:27" }] };
							break;
						case "pane.list":
							assert.equal(request.params.workspace_id, SOURCE_WORKSPACE);
							result = { panes: [{ id: PANE, ref: "pane:1", surface_ids: [SOURCE_SURFACE], surface_refs: ["surface:1"], selected_surface_id: SOURCE_SURFACE, selected_surface_ref: "surface:1" }] };
							break;
						case "surface.split":
						case "surface.create":
							assert.equal(request.params.workspace_id, SOURCE_WORKSPACE);
							result = { ...CREATED, workspace_id: SOURCE_WORKSPACE, workspace_ref: "workspace:1", pane_id: PANE, pane_ref: "pane:1" };
							break;
						case "workspace.create":
							if (options.disconnectCreate) { socket.end(); continue; }
							if (options.rejectCreate) {
								socket.write(JSON.stringify({ id: request.id, ok: false, error: { code: "contract_rejected", message: "creation rejected" } }) + "\n");
								continue;
							}
							result = options.created ?? CREATED;
							break;
						case "surface.respawn":
						case "tab.action": result = CREATED; break;
						default:
							if (options.respond) { result = options.respond(request); break; }
							throw new Error(`Unexpected method: ${request.method}`);
					}
					socket.write(JSON.stringify({ id: request.id, ok: true, result }) + "\n");
				} catch (error) {
					failures.push(error.message);
					socket.write(JSON.stringify({ id: request?.id, ok: false, error: { code: "unexpected_request", message: error.message } }) + "\n");
				}
			}
		});
	});
	t.after(async () => {
		for (const socket of sockets) socket.destroy();
		await new Promise((resolve) => server.close(resolve));
		await rm(root, { recursive: true, force: true });
		assert.deepEqual(failures, [], "fake socket must recognize every request");
	});
	server.listen(socketPath);
	await once(server, "listening");
	const pi = {
		async exec(command, args, options = {}) {
			assert.equal(command, "cmux");
			// Every invocation is pinned to our socket; never fall back to the app.
			const cliArgs = ["--socket", socketPath, ...args];
			let result;
			try {
				result = { ...await execute(cli, cliArgs, {
					encoding: "utf8", timeout: options.timeout ?? 5000,
					env: {
						PATH: "/usr/bin:/bin", HOME: root, CMUX_SOCKET_PATH: socketPath,
						CMUX_WORKSPACE_ID: SOURCE_WORKSPACE, CMUX_SURFACE_ID: SOURCE_SURFACE,
						CMUX_PANEL_ID: SOURCE_SURFACE, CMUX_QUIET: "1",
					},
				}), code: 0, killed: false };
			} catch (error) {
				// A missing/unlaunchable CLI is a test setup failure, not a cmux error.
				if (typeof error.code !== "number") throw error;
				result = { code: error.code, killed: Boolean(error.killed), stdout: error.stdout, stderr: error.stderr };
			}
			calls.push({ args, ...result });
			return result;
		},
	};
	return { root, pi, requests, requestLines, calls, requestsFor: (method) => requests.filter((request) => request.method === method) };
}

for (const focus of [undefined, true, false]) {
	test(`installed cmux: workspace launch targets returned IDs, focus=${focus}`, contract, async (t) => {
		const h = await fakeCli(t);
		let command;
		const previousPath = process.env.PATH, previousMode = process.env.PI_CMUX_PI_PATH_MODE;
		try {
			process.env.PI_CMUX_PI_PATH_MODE = "full"; // Compatibility fixture uses a synthetic PATH.
			process.env.PATH = "/contract/bin:/usr/bin:/bin";
			command = focus === false
				? buildShellCommand(CWD, "printf '%s' 'contract only; never executed'")
				: buildPiCommand(CWD, { prompt: "Contract 'prompt'; $HOME" });
		} finally {
			if (previousPath === undefined) delete process.env.PATH;
			else process.env.PATH = previousPath;
			if (previousMode === undefined) delete process.env.PI_CMUX_PI_PATH_MODE;
			else process.env.PI_CMUX_PI_PATH_MODE = previousMode;
		}
		const opened = await openCommandInNewWorkspace(h.pi, CWD, command, { title: TITLE, focus });
		assert.equal(opened.ok, true);
		assert.equal(opened.workspaceRef, "workspace:7");
		assert.equal(opened.surfaceRef, "surface:27");
		assert.equal(opened.source.surface_ref, "surface:1");
		assert.equal(opened.created?.surface_id, SURFACE, "return setup needs the actual CLI's full surface UUID, not just its ref");
		assert.equal(opened.created?.workspace_id, WORKSPACE);
		assert.deepEqual(h.calls.map(({ args }) => args.slice(0, args[0] === "--json" ? (args[1] === "--id-format" ? 5 : 3) : 1)), [
			["--json", "--id-format", "both", "identify"], ["--json", "--id-format", "both", "workspace", "create"], ["rename-tab"], ["respawn-pane"],
		]);
		assert.deepEqual(h.requestsFor("workspace.create").map(({ params }) => params), [{
			window_id: WINDOW, cwd: CWD, title: TITLE, focus: focus ?? true,
		}]); // No command/initial_input during creation.
		const respawns = h.requestsFor("surface.respawn");
		assert.equal(respawns.length, 1);
		assert.equal(respawns[0].params.workspace_id, WORKSPACE);
		assert.equal(respawns[0].params.surface_id, SURFACE);
		assert.equal(respawns[0].params.tmux_start_command, command);
		// cmux 0.64.25 adds this outer LOGIN shell. Do not execute it in this test.
		assert.equal(respawns[0].params.command, `/bin/sh -lc '${command.replaceAll("'", `'"'"'`)}'`);
		const renames = h.requestsFor("tab.action");
		assert.equal(renames.length, 1);
		// 0.64.25 forwards refs; 0.65.2 resolves the same targets to UUIDs.
		assert.ok(["workspace:7", WORKSPACE].includes(renames[0].params.workspace_id));
		assert.ok(["surface:27", SURFACE].includes(renames[0].params.surface_id));
		assert.equal(renames[0].params.action, "rename");
		assert.equal(renames[0].params.title, TITLE);
		assert.ok(h.requests.indexOf(renames[0]) < h.requests.indexOf(respawns[0]), "the installed CLI must initialize the title before starting the child");
	});
}

test("installed cmux: default minimal Pi PATH keeps a representative request below 4 KiB on an isolated socket", contract, async t => {
 const h = await fakeCli(t), piDir = join(h.root, "pi's bin"), nodeDir = join(h.root, "node bin");
 await mkdir(piDir); await mkdir(nodeDir);
 await writeFile(join(piDir, "pi"), "#!/bin/sh\nexit 99\n", { mode: 0o755 });
 await symlink(process.execPath, join(nodeDir, "node"));
 const previousPath = process.env.PATH, previousMode = process.env.PI_CMUX_PI_PATH_MODE;
 let command;
 try {
  process.env.PATH = `${piDir}:${nodeDir}:/unused-parent-${"x".repeat(1500)}`;
  delete process.env.PI_CMUX_PI_PATH_MODE;
  const seed = childBootstrap({ version: 1, sessionId: SOURCE_SURFACE, taskId: WINDOW, conversationId: SOURCE_WORKSPACE, role: "main", topic: "Pi" },
   { windowId: WINDOW, workspaceId: SOURCE_WORKSPACE, paneId: PANE, surfaceId: SOURCE_SURFACE }, true, "review", "SSH review");
  command = buildPiCommand(CWD, { orientationBootstrap: encodeBootstrap(seed), provider: "test", model: "test/model", thinking: "high", prompt: "Synthetic review only. " + "x".repeat(600) });
 } finally {
  if (previousPath === undefined) delete process.env.PATH; else process.env.PATH = previousPath;
  if (previousMode === undefined) delete process.env.PI_CMUX_PI_PATH_MODE; else process.env.PI_CMUX_PI_PATH_MODE = previousMode;
 }
 const result = await openCommandInNewWorkspace(h.pi, CWD, command, { title: TITLE, focus: false });
 assert.equal(result.ok, true);
 assert.equal(h.requestsFor("surface.respawn").length, 1);
 const line = h.requestLines.find(raw => JSON.parse(raw).method === "surface.respawn");
 assert.ok(Buffer.byteLength(line + "\n") < 4096);
 assert.ok(!line.includes("unused-parent-"));
 assert.equal(JSON.parse(line).params.tmux_start_command, command);
 assert.ok(command.includes('${PATH:+:"$PATH"}'), "expand native PATH at child execution, not CLI serialization");
});

for (const placement of ["right", "down", "tab"]) {
 test(`installed cmux: ${placement} creation retains full UUID and short ref`, contract, async t => {
  const h=await fakeCli(t),command="NOT EXECUTED; isolated CLI contract only";
  const result=placement==='tab'
   ?await openCommandInNewTab(h.pi,command,{tabTitle:TITLE,focus:false})
   :await openCommandInNewSplit(h.pi,placement,command,{tabTitle:TITLE,focus:false});
  assert.equal(result.ok,true,result.error);assert.equal(result.surfaceRef,'surface:27');assert.equal(result.created.surface_id,SURFACE);assert.equal(result.created.workspace_id,SOURCE_WORKSPACE);
  const method=placement==='tab'?'surface.create':'surface.split';assert.equal(h.requestsFor(method).length,1);const created=h.requestsFor(method)[0];assert.equal(created.params.focus,false);
  if(placement!=='tab')assert.ok([SOURCE_SURFACE,'surface:1'].includes(created.params.surface_id));
  const respawn=h.requestsFor('surface.respawn');assert.equal(respawn.length,1);assert.equal(respawn[0].params.surface_id,SURFACE);assert.equal(respawn[0].params.workspace_id,SOURCE_WORKSPACE);
  assert.equal(h.calls.find(c=>c.args.includes(placement==='tab'?'new-surface':'new-split')).args[2],'both');
 });
}

// Locks down the observed CLI distinction that a JSON-returning mock concealed.
test("installed cmux: legacy new-workspace ignores --json, workspace create honors it", contract, async (t) => {
	const h = await fakeCli(t);
	const flags = ["--window", "window:1", "--cwd", CWD, "--name", TITLE, "--focus", "false"];
	const legacy = await h.pi.exec("cmux", ["--json", "new-workspace", ...flags]);
	const structured = await h.pi.exec("cmux", ["--json", "workspace", "create", ...flags]);
	const both = await h.pi.exec("cmux", ["--json", "--id-format", "both", "workspace", "create", ...flags]);
	assert.equal(legacy.code, 0, legacy.stderr);
	assert.equal(legacy.stdout, "OK workspace:7\n");
	assert.equal(structured.code, 0, structured.stderr);
	assert.deepEqual(JSON.parse(structured.stdout), { window_ref: "window:1", workspace_ref: "workspace:7", surface_ref: "surface:27" });
	assert.equal(both.code, 0, both.stderr);
	assert.equal(JSON.parse(both.stdout).workspace_id, WORKSPACE);
	assert.equal(JSON.parse(both.stdout).surface_id, SURFACE);
	assert.equal(JSON.parse(both.stdout).surface_ref, "surface:27");
	const creates = h.requestsFor("workspace.create");
	assert.equal(creates.length, 3); // Three explicit format probes, not a launch retry.
	assert.deepEqual(creates[0].params, creates[1].params);
	assert.deepEqual(creates[1].params, creates[2].params);
});

for (const [label, options] of [["rejected", { rejectCreate: true }], ["missing IDs", { created: {} }]]) {
	test(`installed cmux: ${label} creation is never retried or launched`, contract, async (t) => {
		const h = await fakeCli(t, options);
		const result = await openCommandInNewWorkspace(h.pi, CWD, "NOT EXECUTED", { title: TITLE });
		assert.equal(result.ok, false);
		assert.match(result.error, options.rejectCreate ? /creation rejected/ : /could not identify the new cmux workspace safely/);
		assert.equal(h.requestsFor("workspace.create").length, 1);
		assert.equal(h.calls.length, 2);
		assert.equal(h.requestsFor("surface.respawn").length, 0);
		assert.equal(h.requestsFor("tab.action").length, 0);
	});
}

test("installed cmux: disconnect after create is never retried or launched", contract, async (t) => {
	const h = await fakeCli(t, { disconnectCreate: true });
	const result = await openCommandInNewWorkspace(h.pi, CWD, "NOT EXECUTED", { title: TITLE, focus: false });
	assert.equal(result.ok, false);
	assert.match(result.error, /Socket closed before reply/);
	assert.equal(h.requestsFor("workspace.create").length, 1);
	assert.equal(h.calls.length, 2);
	assert.equal(h.requestsFor("surface.respawn").length, 0);
	assert.equal(h.requestsFor("tab.action").length, 0);
});

test("installed cmux: message client preserves UUIDs with send/list/settings only on an isolated socket", contract, async t => {
 const from={surfaceId:SOURCE_SURFACE,sessionId:WINDOW,conversationId:SOURCE_WORKSPACE,taskId:OTHER_WINDOW};
 const to={surfaceId:SURFACE,sessionId:WORKSPACE,conversationId:SURFACE,taskId:OTHER_WINDOW};
 const envelope=makeEnvelope(from,to,"cli-contract","result","A quoted 'report'; $HOME stays data");
 let stored;
 const h=await fakeCli(t,{respond:request=>{
  switch(request.method){
   case 'agent.message.send':
    assert.equal(request.params.target,SURFACE);assert.equal(request.params.sender_surface_id,SOURCE_SURFACE);
    stored={id:WINDOW,thread_id:SOURCE_WORKSPACE,sender_surface_id:SOURCE_SURFACE,recipient_surface_id:SURFACE,body:request.params.body,state:'queued',in_reply_to:null};return {...stored,recipient_surface_ref:'surface:27',recipient_workspace_ref:'workspace:7'};
   case 'agent.message.list':return {messages:[stored]};
   case 'agent.message.settings':return {id:SURFACE,scope:'surface',receiving:true,messages_enabled:true,workspace_receiving:true};
   default:throw Error(`Unexpected messaging method ${request.method}`);
  }
 }});
 const exec=(args,signal)=>h.pi.exec('cmux',args,{signal});
 const sender=new MessageClient(SOURCE_SURFACE,exec),receiver=new MessageClient(SURFACE,exec);
 assert.equal((await sender.send(envelope)).recipient_surface_id,SURFACE);
 assert.equal(await receiver.settings(),true);
 assert.equal((await receiver.list())[0].body,JSON.stringify(envelope));
 assert.equal((await receiver.list())[0].state,'queued');
 assert.equal(h.requestsFor('agent.message.send').length,1);
 assert.deepEqual(h.requests.filter(r=>r.method.startsWith('agent.message.')).map(r=>r.method),['agent.message.send','agent.message.settings','agent.message.list','agent.message.list']);
});
