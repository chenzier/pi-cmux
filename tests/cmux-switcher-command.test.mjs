import assert from "node:assert/strict";
import test from "node:test";
import { setImmediate as immediate } from "node:timers/promises";
import cmuxSwitcherExtension from "../extensions/cmux-switcher.ts";

const flush = async () => { await immediate(); await immediate(); };

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
		surfaceTitle: "Pi · reviewer",
		type: "terminal",
		isCaller: false,
		...overrides,
	};
}

const rows = [
	row({ surfaceIndex: 1, surfaceTitle: "Pi · reviewer", agent: { kind: "pi", state: "working" } }),
	row({ surfaceIndex: 2, surfaceTitle: "docs", type: "browser", surfaceId: "e2222222-2222-4222-8222-222222222222" }),
];

function fakeApi() {
	const commands = new Map();
	const shortcuts = new Map();
	const events = new Map();
	return {
		commands, shortcuts, events,
		registerCommand(name, options) { commands.set(name, options); },
		registerShortcut(key, options) {
			if (shortcuts.has(key)) throw new Error(`Duplicate shortcut ${key}`);
			shortcuts.set(key, options);
		},
		on(event, handler) { events.set(event, handler); return () => events.delete(event); },
	};
}

function fakeContext({ mode = "tui", hasUI = true } = {}) {
	const notifications = [];
	const state = { opened: 0, renders: 0, component: undefined, options: undefined, settle: undefined, factory: undefined };
	const ctx = {
		mode,
		hasUI,
		notifications,
		ui: {
			notify(message, type) { notifications.push({ message, type }); },
			custom(factory, options) {
				state.opened++;
				state.factory = factory;
				state.options = options;
				return new Promise((resolve) => {
					state.settle = resolve;
					const tui = { requestRender() { state.renders++; } };
					const theme = { fg: (_color, text) => text, bold: (text) => text, inverse: (text) => text };
					const component = factory(tui, theme, {}, (value) => resolve(value));
					state.component = component;
				});
			},
		},
	};
	return { ctx, state };
}

function deps(overrides = {}) {
	const focusCalls = [];
	const discovery = { ok: true, discovery: {
		rows,
		caller: { windowId: rows[0].windowId, workspaceId: rows[0].workspaceId, paneId: rows[0].paneId, surfaceId: rows[0].surfaceId },
		windowCount: 1,
	} };
	return {
		focusCalls,
		discover: async () => discovery,
		focus: async (...args) => { focusCalls.push(args); return { ok: true, row: args[1] }; },
		terminalRows: () => 24,
		...overrides,
	};
}

function withEnv(vars, run) {
	const previous = Object.fromEntries(Object.keys(vars).map((key) => [key, process.env[key]]));
	for (const [key, value] of Object.entries(vars)) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	try {
		return run();
	} finally {
		for (const [key, value] of Object.entries(previous)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	}
}

test("registers /cm and opens the transient overlay with cmux rows", async () => {
	await withEnv({ PI_CMUX_SWITCHER_KEY: undefined }, async () => {
		const pi = fakeApi();
		const testDeps = deps();
		cmuxSwitcherExtension(pi, testDeps);
		assert.equal(pi.commands.has("cm"), true);
		assert.match(pi.commands.get("cm").description, /Jump to a cmux pane/);
		assert.equal(pi.shortcuts.size, 0, "no shortcut unless configured");

		const { ctx, state } = fakeContext();
		const pending = pi.commands.get("cm").handler("", ctx);
		await flush();
		assert.equal(state.opened, 1);
		assert.deepEqual(state.options, { overlay: true, overlayOptions: { width: 64, maxHeight: "70%", anchor: "center", margin: 1 } });
		assert.match(state.component.render(60).join("\n"), /Pi · reviewer/);
		assert.match(state.component.render(60).join("\n"), /pi · working/);

		state.component.handleInput("\u001b[B");
		state.component.handleInput("\r");
		await pending;
		assert.equal(testDeps.focusCalls.length, 1);
		assert.equal(testDeps.focusCalls[0][1].surfaceId, rows[1].surfaceId);
	});
});

test("Escape closes without focusing anything and repeated invocation is ignored while open", async () => {
	await withEnv({ PI_CMUX_SWITCHER_KEY: undefined }, async () => {
		const pi = fakeApi();
		const testDeps = deps();
		cmuxSwitcherExtension(pi, testDeps);
		const { ctx, state } = fakeContext();
		const handler = pi.commands.get("cm").handler;
		const pending = handler("", ctx);
		const second = handler("", ctx);
		await flush();
		assert.equal(state.opened, 1, "a second /cm while open does not stack overlays");
		state.component.handleInput("\u001b");
		await Promise.all([pending, second]);
		assert.equal(testDeps.focusCalls.length, 0);
	});
});

test("discovery failures and focus failures are reported without switching", async () => {
	await withEnv({ PI_CMUX_SWITCHER_KEY: undefined }, async () => {
		const failed = fakeApi();
		cmuxSwitcherExtension(failed, deps({ discover: async () => ({ ok: false, error: "Cannot read the cmux layout" }) }));
		const first = fakeContext();
		const pending = failed.commands.get("cm").handler("", first.ctx);
		await flush();
		assert.match(first.state.component.render(60).join("\n"), /Cannot read the cmux layout/);
		first.state.component.handleInput("\u001b");
		await pending;

		const unconfirmed = fakeApi();
		cmuxSwitcherExtension(unconfirmed, deps({ focus: async () => ({ ok: false, error: "cmux did not confirm the exact target" }) }));
		const second = fakeContext();
		const run = unconfirmed.commands.get("cm").handler("", second.ctx);
		await flush();
		second.state.component.handleInput("\r");
		await run;
		assert.deepEqual(second.ctx.notifications.map((entry) => entry.message), ["Not switched: cmux did not confirm the exact target"]);
		assert.equal(second.ctx.notifications[0].type, "error");
	});
});

test("an unexpected focus rejection is reported instead of escaping /cm", async () => {
	await withEnv({ PI_CMUX_SWITCHER_KEY: undefined }, async () => {
		const pi = fakeApi();
		let attempts = 0;
		cmuxSwitcherExtension(pi, deps({
			focus: async () => { attempts++; throw new Error("\u001b[31mcmux disappeared\u001b[0m"); },
		}));
		const { ctx, state } = fakeContext();
		const pending = pi.commands.get("cm").handler("", ctx);
		await flush();
		state.component.handleInput("\r");
		await pending;
		assert.equal(attempts, 1, "no retry after an unexpected rejection");
		assert.deepEqual(ctx.notifications.map((entry) => entry.message), ["Not switched: cmux disappeared"]);
		assert.equal(ctx.notifications[0].type, "error");
	});
});

test("non-interactive modes do not open the overlay", async () => {
	await withEnv({ PI_CMUX_SWITCHER_KEY: undefined }, async () => {
		const pi = fakeApi();
		const testDeps = deps();
		cmuxSwitcherExtension(pi, testDeps);
		const { ctx, state } = fakeContext({ mode: "print", hasUI: false });
		await pi.commands.get("cm").handler("", ctx);
		assert.equal(state.opened, 0);
		assert.deepEqual(ctx.notifications.map((entry) => entry.type), ["warning"]);
	});
});

test("session shutdown cancels pending discovery and stale callbacks are ignored", async () => {
	await withEnv({ PI_CMUX_SWITCHER_KEY: undefined }, async () => {
		const pi = fakeApi();
		let seenSignal;
		const testDeps = deps({
			discover: (_pi, options) => {
				seenSignal = options.signal;
				return new Promise(() => {});
			},
		});
		cmuxSwitcherExtension(pi, testDeps);
		const { ctx, state } = fakeContext();
		const pending = pi.commands.get("cm").handler("", ctx);
		await flush();
		assert.equal(seenSignal.aborted, false);
		pi.events.get("session_shutdown")();
		assert.equal(seenSignal.aborted, true);
		state.settle(undefined);
		await pending;
		assert.equal(testDeps.focusCalls.length, 0);

		// A new session may open the switcher again.
		const reopened = fakeContext();
		const next = pi.commands.get("cm").handler("", reopened.ctx);
		await flush();
		assert.equal(reopened.state.opened, 1);
		reopened.state.component.handleInput("\u001b");
		await next;
	});
});

test("session shutdown ignores a late successful or failed discovery callback", async () => {
	await withEnv({ PI_CMUX_SWITCHER_KEY: undefined }, async () => {
		for (const outcome of ["success", "failure"]) {
			const pi = fakeApi();
			let finishDiscovery;
			const testDeps = deps({
				discover: (_pi, options) => new Promise((resolve, reject) => {
					finishDiscovery = () => {
						assert.equal(options.signal.aborted, true, "shutdown aborts the pending read");
						if (outcome === "success") resolve({ ok: true, discovery: { rows, windowCount: 1 } });
						else reject(new Error("cmux disappeared"));
					};
				}),
			});
			cmuxSwitcherExtension(pi, testDeps);
			const { ctx, state } = fakeContext();
			const pending = pi.commands.get("cm").handler("", ctx);
			await flush();
			pi.events.get("session_shutdown")();
			const renders = state.renders;
			finishDiscovery();
			await flush();
			state.settle(undefined);
			await pending;
			assert.equal(state.renders, renders, `${outcome}: no repaint after shutdown`);
			assert.equal(testDeps.focusCalls.length, 0);
			assert.deepEqual(ctx.notifications, []);
		}
	});
});

test("a stale discovery result cannot repaint a closed overlay", async () => {
	await withEnv({ PI_CMUX_SWITCHER_KEY: undefined }, async () => {
		const pi = fakeApi();
		let finishDiscovery;
		const testDeps = deps({
			discover: () => new Promise((resolve) => { finishDiscovery = resolve; }),
		});
		cmuxSwitcherExtension(pi, testDeps);
		const { ctx, state } = fakeContext();
		const pending = pi.commands.get("cm").handler("", ctx);
		await flush();
		state.component.handleInput("\u001b");
		await pending;
		const renders = state.renders;
		finishDiscovery({ ok: true, discovery: { rows, windowCount: 1 } });
		await flush();
		assert.equal(state.renders, renders, "no render is requested after the overlay closed");
	});
});

test("the optional shortcut registers once, honours off and reports conflicts", async () => {
	await withEnv({ PI_CMUX_SWITCHER_KEY: "ctrl+alt+p", PI_CMUX_RETURN_KEY: undefined }, async () => {
		const pi = fakeApi();
		const testDeps = deps();
		cmuxSwitcherExtension(pi, testDeps);
		assert.deepEqual([...pi.shortcuts.keys()], ["ctrl+alt+p"]);
		assert.match(pi.shortcuts.get("ctrl+alt+p").description, /Jump to a cmux pane/);
		const { ctx, state } = fakeContext();
		const pending = pi.shortcuts.get("ctrl+alt+p").handler(ctx);
		await flush();
		state.component.handleInput("\u001b");
		await pending;
		assert.equal(state.opened, 1);
	});

	for (const value of ["off", "OFF", "", undefined]) {
		await withEnv({ PI_CMUX_SWITCHER_KEY: value }, async () => {
			const pi = fakeApi();
			cmuxSwitcherExtension(pi, deps());
			assert.equal(pi.shortcuts.size, 0, `${value} registers no shortcut`);
			assert.equal(pi.commands.has("cm"), true);
		});
	}
});

test("invalid or conflicting shortcut values warn without disabling /cm", async (t) => {
	const warnings = [];
	t.mock.method(console, "warn", (message) => { warnings.push(String(message)); });

	await withEnv({ PI_CMUX_SWITCHER_KEY: "hyper+q" }, async () => {
		const pi = fakeApi();
		cmuxSwitcherExtension(pi, deps());
		assert.equal(pi.shortcuts.size, 0);
		assert.equal(pi.commands.has("cm"), true);
	});
	assert.match(warnings.at(-1), /invalid PI_CMUX_SWITCHER_KEY/);

	await withEnv({ PI_CMUX_SWITCHER_KEY: "ctrl+alt+b", PI_CMUX_RETURN_KEY: undefined }, async () => {
		const pi = fakeApi();
		cmuxSwitcherExtension(pi, deps());
		assert.equal(pi.shortcuts.size, 0);
		assert.equal(pi.commands.has("cm"), true);
	});
	assert.match(warnings.at(-1), /conflicts with the return-to-origin shortcut/);

	await withEnv({ PI_CMUX_SWITCHER_KEY: "ctrl+alt+p", PI_CMUX_RETURN_KEY: "ctrl+alt+p" }, async () => {
		const pi = fakeApi();
		cmuxSwitcherExtension(pi, deps());
		assert.equal(pi.shortcuts.size, 0);
	});
	assert.match(warnings.at(-1), /conflicts/);

	// Modifier order is not significant, so `alt+ctrl+b` is still /cmbk's key.
	for (const value of ["alt+ctrl+b", "ctrl+alt+B", "ALT+CTRL+B"]) {
		await withEnv({ PI_CMUX_SWITCHER_KEY: value, PI_CMUX_RETURN_KEY: undefined }, async () => {
			const pi = fakeApi();
			cmuxSwitcherExtension(pi, deps());
			assert.equal(pi.shortcuts.size, 0, `${value} must not register over the return shortcut`);
		});
		assert.match(warnings.at(-1), /conflicts/, `${value} warns`);
	}
});

test("a rejected keybinding registration keeps /cm available", async (t) => {
	const warnings = [];
	t.mock.method(console, "warn", (message) => { warnings.push(String(message)); });
	await withEnv({ PI_CMUX_SWITCHER_KEY: "ctrl+alt+p", PI_CMUX_RETURN_KEY: "off" }, async () => {
		const pi = fakeApi();
		pi.registerShortcut = () => { throw new Error("Keybinding is already taken"); };
		cmuxSwitcherExtension(pi, deps());
		assert.equal(pi.commands.has("cm"), true);
	});
	assert.match(warnings.at(-1), /could not register PI_CMUX_SWITCHER_KEY/);
});
