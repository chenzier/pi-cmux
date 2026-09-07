import assert from "node:assert/strict";
import { setImmediate as waitForImmediate } from "node:timers/promises";
import { test } from "node:test";
import cmuxNotifyExtension from "../extensions/cmux-notify.ts";
import cmuxSidebarExtension from "../extensions/cmux-sidebar.ts";

function createHarness(extension) {
	const handlers = new Map();
	const execCalls = [];
	const pi = {
		on(eventName, handler) {
			const eventHandlers = handlers.get(eventName) ?? [];
			eventHandlers.push(handler);
			handlers.set(eventName, eventHandlers);
		},
		async exec(command, args, options) {
			execCalls.push({ command, args, options });
			return { stdout: "", stderr: "", code: 0, killed: false };
		},
	};

	extension(pi);

	return {
		execCalls,
		async emit(eventName, event = {}, ctx = createContext()) {
			for (const handler of handlers.get(eventName) ?? []) {
				await handler(event, ctx);
			}
		},
	};
}

function createContext(idle = true) {
	return {
		isIdle: () => idle,
		sessionManager: {
			getBranch: () => [],
		},
	};
}

async function withEnvironment(overrides, callback) {
	const previous = new Map();
	for (const [name, value] of Object.entries(overrides)) {
		previous.set(name, process.env[name]);
		if (value === undefined) delete process.env[name];
		else process.env[name] = value;
	}

	try {
		return await callback();
	} finally {
		for (const [name, value] of previous) {
			if (value === undefined) delete process.env[name];
			else process.env[name] = value;
		}
	}
}

function assistantMessage(stopReason, text, usage) {
	return {
		role: "assistant",
		stopReason,
		content: [{ type: "text", text }],
		usage,
	};
}

function editResult(path) {
	return {
		type: "tool_result",
		toolName: "edit",
		input: { path, edits: [] },
		content: [{ type: "text", text: "Updated" }],
		details: {},
		isError: false,
	};
}

function cmuxCalls(calls, subcommand) {
	return calls.filter((call) => call.command === "cmux" && call.args[0] === subcommand);
}

test("notifications wait for idle settlement and use the final low-level result", async () => {
	await withEnvironment(
		{
			PI_CMUX_NOTIFY_DEBOUNCE_MS: "0",
			PI_CMUX_NOTIFY_INCLUDE_RESPONSE: "1",
			PI_CMUX_NOTIFY_LEVEL: "all",
			PI_CMUX_NOTIFY_THRESHOLD_MS: "999999",
		},
		async () => {
			const harness = createHarness(cmuxNotifyExtension);
			const failed = assistantMessage("error", "temporary provider failure");
			const succeeded = assistantMessage("stop", "Final response");

			await harness.emit("agent_start", { type: "agent_start" });
			await harness.emit("tool_result", editResult("/repo/retry.ts"));
			await harness.emit("agent_end", { type: "agent_end", messages: [failed] });
			assert.equal(cmuxCalls(harness.execCalls, "notify").length, 0);

			await harness.emit("agent_start", { type: "agent_start" });
			await harness.emit("agent_end", { type: "agent_end", messages: [succeeded] });
			await harness.emit("agent_settled", { type: "agent_settled" }, createContext(false));
			assert.equal(cmuxCalls(harness.execCalls, "notify").length, 0);

			await harness.emit("agent_settled", { type: "agent_settled" });
			const notifications = cmuxCalls(harness.execCalls, "notify");
			assert.equal(notifications.length, 1);
			assert.deepEqual(notifications[0].args, [
				"notify",
				"--title",
				"Pi",
				"--subtitle",
				"Task Complete",
				"--body",
				"Updated retry.ts\nFinal response",
			]);

			await harness.emit("agent_settled", { type: "agent_settled" });
			assert.equal(cmuxCalls(harness.execCalls, "notify").length, 1);
		},
	);
});

test("sidebar finalizes once after settlement and preserves retry activity", async () => {
	await withEnvironment(
		{
			CMUX_WORKSPACE_ID: "workspace:test",
			PI_CMUX_SIDEBAR: "1",
			PI_CMUX_SIDEBAR_FINAL_CLEAR_MS: "60000",
			PI_CMUX_SIDEBAR_STATUS_KEY: "pi-cmux-test",
			PI_CMUX_SIDEBAR_TOKENS: "1",
		},
		async () => {
			const harness = createHarness(cmuxSidebarExtension);
			const firstUsage = { input: 10, output: 2, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } };
			const finalUsage = { input: 3, output: 4, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } };
			const failed = assistantMessage("error", "temporary provider failure", firstUsage);
			const succeeded = assistantMessage("stop", "Done", finalUsage);

			await harness.emit("session_start", { type: "session_start" });
			await harness.emit("agent_start", { type: "agent_start" });
			await harness.emit("tool_result", editResult("/repo/retry.ts"));
			await harness.emit("message_end", { type: "message_end", message: failed });
			await harness.emit("agent_end", { type: "agent_end", messages: [failed] });
			await waitForImmediate();

			const finalStatusValues = new Set(["Pi error", "Pi cancelled", "Pi done", "Pi waiting"]);
			const finalStatuses = () =>
				cmuxCalls(harness.execCalls, "set-status").filter((call) => finalStatusValues.has(call.args[2]));
			assert.equal(finalStatuses().length, 0);
			assert.equal(cmuxCalls(harness.execCalls, "trigger-flash").length, 0);

			await harness.emit("agent_start", { type: "agent_start" });
			await harness.emit("message_end", { type: "message_end", message: succeeded });
			await harness.emit("agent_end", { type: "agent_end", messages: [succeeded] });
			await harness.emit("agent_settled", { type: "agent_settled" }, createContext(false));
			await waitForImmediate();
			assert.equal(finalStatuses().length, 0);

			await harness.emit("agent_settled", { type: "agent_settled" });
			await waitForImmediate();
			assert.equal(finalStatuses().length, 1);
			assert.equal(finalStatuses()[0].args[2], "Pi done");
			assert.equal(cmuxCalls(harness.execCalls, "trigger-flash").length, 1);

			const finalLogs = cmuxCalls(harness.execCalls, "log").filter((call) => call.args.includes("Updated retry.ts · tok ↑13 ↓6"));
			assert.equal(finalLogs.length, 1);

			await harness.emit("agent_settled", { type: "agent_settled" });
			await waitForImmediate();
			assert.equal(finalStatuses().length, 1);
			assert.equal(cmuxCalls(harness.execCalls, "trigger-flash").length, 1);

			await harness.emit("session_shutdown", { type: "session_shutdown" });
		},
	);
});
