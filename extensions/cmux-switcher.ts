import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { discoverSwitcher, type SwitcherDiscoveryResult } from "../lib/switcher/discovery.ts";
import { focusSurface, type FocusResult } from "../lib/switcher/navigation.ts";
import { PaneSwitcherOverlay, createSwitcherStyle } from "../lib/switcher/overlay.ts";
import { safeText, type SwitcherRow } from "../lib/switcher/model.ts";
import { canonicalShortcutKey, parseShortcutKey, resolveReturnShortcut } from "../lib/orientation/hints.ts";

const OVERLAY_OPTIONS = { width: 64, maxHeight: "70%", anchor: "center", margin: 1 } as const;

export interface SwitcherDeps {
	discover(pi: ExtensionAPI, options: { signal?: AbortSignal }): Promise<SwitcherDiscoveryResult>;
	focus(pi: ExtensionAPI, row: Pick<SwitcherRow, "surfaceId">, options: { signal?: AbortSignal }): Promise<FocusResult>;
	/** Test seam; production reads the live terminal height on every render. */
	terminalRows?(): number | undefined;
}

const defaultDeps: SwitcherDeps = {
	discover: discoverSwitcher,
	focus: focusSurface,
};

/**
 * `/cm` and the optional `PI_CMUX_SWITCHER_KEY` shortcut open the same
 * transient overlay. This is Pi-local navigation only: it never runs a model
 * turn, never creates panes and never claims a cmux-wide shortcut.
 */
export default function cmuxSwitcherExtension(pi: ExtensionAPI, deps: SwitcherDeps = defaultDeps) {
	let active = false;
	let generation = 0;
	let runController: AbortController | undefined;
	let discoveryController: AbortController | undefined;

	pi.on("session_shutdown", () => {
		generation++;
		active = false;
		runController?.abort();
		discoveryController?.abort();
		runController = undefined;
		discoveryController = undefined;
	});

	const open = async (ctx: ExtensionContext): Promise<void> => {
		if (ctx.mode !== "tui" || !ctx.hasUI) {
			ctx.ui.notify("The cmux pane switcher needs interactive Pi (/cm).", "warning");
			return;
		}
		if (active) return;
		active = true;
		const runGeneration = ++generation;
		const run = new AbortController();
		const discovery = new AbortController();
		runController = run;
		discoveryController = discovery;
		try {
			let closed = false;
			const result = await ctx.ui.custom<SwitcherRow | undefined>((tui, theme, _keybindings, done) => {
				const overlay = new PaneSwitcherOverlay({
					style: createSwitcherStyle(theme),
					// Read the height per render so Pi's 70% cap and later resizes are honored.
					terminalRows: () => deps.terminalRows?.() ?? process.stdout.rows,
					done: (value) => {
						// Dismissal must not leave a pending cmux read behind.
						closed = true;
						discovery.abort();
						done(value);
					},
				});
				void deps.discover(pi, { signal: discovery.signal }).then((found) => {
					if (closed || runGeneration !== generation || discovery.signal.aborted) return;
					overlay.setStatus(found.ok
						? { state: "ready", rows: found.discovery.rows, callerWorkspaceId: found.discovery.caller?.workspaceId }
						: { state: "error", message: found.error });
					tui.requestRender();
				}, (error: unknown) => {
					if (closed || runGeneration !== generation || discovery.signal.aborted) return;
					overlay.setStatus({ state: "error", message: error instanceof Error ? error.message : "Cannot read the cmux layout" });
					tui.requestRender();
				});
				return overlay;
			}, { overlay: true, overlayOptions: OVERLAY_OPTIONS });
			// A stale session or a replaced overlay must not focus anything.
			if (runGeneration !== generation || run.signal.aborted) return;
			if (!result) return;
			let focused: FocusResult;
			try {
				focused = await deps.focus(pi, result, { signal: run.signal });
			} catch (error) {
				// An unexpected rejection (cmux gone, aborted exec) is reported like a
				// failed focus instead of escaping the /cm handler.
				focused = { ok: false, error: error instanceof Error ? error.message : "cmux focus failed" };
			}
			if (runGeneration !== generation || run.signal.aborted) return;
			// Unconfirmed focus is reported once; never retried or substituted.
			if (!focused.ok) ctx.ui.notify(`Not switched: ${safeText(focused.error, "cmux focus failed")}`, "error");
		} finally {
			discovery.abort();
			if (runGeneration === generation) {
				active = false;
				runController = undefined;
				discoveryController = undefined;
			}
		}
	};

	pi.registerCommand("cm", {
		description: "Jump to a cmux pane: type to filter, Enter switches, Esc closes",
		handler: async (_args, ctx) => { await open(ctx); },
	});

	const shortcut = parseShortcutKey(process.env.PI_CMUX_SWITCHER_KEY ?? "");
	if (shortcut.invalid) {
		console.warn("pi-cmux: invalid PI_CMUX_SWITCHER_KEY; /cm is still available");
	} else if (shortcut.key) {
		const returnKey = resolveReturnShortcut(process.env.PI_CMUX_RETURN_KEY).key;
		// `alt+ctrl+b` and `ctrl+alt+b` are the same key, so compare canonically.
		if (returnKey !== undefined && canonicalShortcutKey(returnKey) === canonicalShortcutKey(shortcut.key)) {
			console.warn(`pi-cmux: PI_CMUX_SWITCHER_KEY (${shortcut.key}) conflicts with the return-to-origin shortcut; /cm is still available`);
		} else {
			try {
				pi.registerShortcut(shortcut.key as Parameters<ExtensionAPI["registerShortcut"]>[0], {
					description: "Jump to a cmux pane",
					handler: async (ctx) => { await open(ctx); },
				});
			} catch (error) {
				console.warn(`pi-cmux: could not register PI_CMUX_SWITCHER_KEY (${shortcut.key}): ${error instanceof Error ? error.message : String(error)}; /cm is still available`);
			}
		}
	}
}
