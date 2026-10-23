import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import registerOrientation from "../../lib/orientation/runtime.ts";
import { BindingStore, BOOTSTRAP_ENV } from "../../lib/orientation/state.ts";

export const target = () => ({ windowId: randomUUID(), workspaceId: randomUUID(), paneId: randomUUID(), surfaceId: randomUUID() });
export function orientationHarness(t, options = {}) {
	const root = mkdtempSync(join(tmpdir(), "pi-cmux-orientation-"));
	const saved = { CMUX_SURFACE_ID: process.env.CMUX_SURFACE_ID, [BOOTSTRAP_ENV]: process.env[BOOTSTRAP_ENV] };
	const location = options.target ?? target();
	process.env.CMUX_SURFACE_ID = location.surfaceId;
	if (options.bootstrap) process.env[BOOTSTRAP_ENV] = options.bootstrap; else delete process.env[BOOTSTRAP_ENV];
	const events = new Map(), commands = new Map(), shortcuts = new Map(), tools = new Map();
	const calls = [], notifications = [], statuses = [];
	const ctx = { mode: "tui", hasUI: true, cwd: root, sessionManager: SessionManager.inMemory(root), isIdle: () => true,
		ui: { notify: (...args) => notifications.push(args), setStatus: (...args) => statuses.push(args) } };
	const pi = {
		on(name, callback) { if (!events.has(name)) events.set(name, []); events.get(name).push(callback); },
		registerCommand(name, command) { commands.set(name, command); },
		registerShortcut(key, shortcut) { shortcuts.set(key, shortcut); },
		registerTool(tool) { tools.set(tool.name, tool); },
		appendEntry: (type, data) => ctx.sessionManager.appendCustomEntry(type, data),
		async exec(command, args, opts) {
			calls.push({ command, args, opts });
			if (options.exec) { const result = await options.exec(command, args, opts); if (result) return result; }
			if (command === "git") return { code: 1, killed: false, stdout: "", stderr: "not git" };
			let response = {};
			if (args.includes("identify")) response = { caller: { window_id: location.windowId, workspace_id: location.workspaceId,
				pane_id: location.paneId, surface_id: location.surfaceId, window_ref: "window:1", workspace_ref: "workspace:1", pane_ref: "pane:1", surface_ref: "surface:1" } };
			else if (args.includes("list-panes")) response = { panes: [{ ref: "pane:1", surface_refs: ["surface:1"] }] };
			else if (args.includes("new-split") || args.includes("new-surface") || args.includes("create")) response = { workspace_ref: "workspace:2", surface_ref: "surface:2", surface_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" };
			return { code: 0, killed: false, stdout: JSON.stringify(response), stderr: "" };
		},
	};
	const store = new BindingStore(join(root, "bindings"));
	const runtime = registerOrientation(pi, store);
	t.after(() => { runtime.stop(); rmSync(root, { recursive: true, force: true }); for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
	return { root, pi, ctx, store, runtime, location, calls, commands, shortcuts, tools, notifications, statuses, events,
		emit: async (name, event = {}) => { for (const callback of events.get(name) ?? []) await callback(event, ctx); } };
}
