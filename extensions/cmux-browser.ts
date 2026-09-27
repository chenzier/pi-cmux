import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { BrowserBindings } from "../lib/browser/bindings.ts";
import { normalizeBrowserOptions, type BrowserOpenOptions } from "../lib/browser/client.ts";

const USAGE = "Usage: /cmb [--down] [--focus] <url>";
const PARAMETERS = {
	type: "object",
	additionalProperties: false,
	required: ["url"],
	properties: {
		url: { type: "string", description: "Absolute http://, https://, or local file:// URL to open. No embedded credentials." },
		placement: {
			type: "string", enum: ["right", "down"], default: "right",
			description: "Where to create the browser split relative to this Pi terminal.",
		},
		focus: {
			type: "boolean", default: false,
			description: "Focus the new browser. Defaults to false to keep focus in Pi.",
		},
	},
} as const;

export function parseBrowserCommand(args: string): BrowserOpenOptions {
	const tokens = args.trim().split(/\s+/);
	let placement: "right" | "down" = "right";
	let focus = false;
	while (tokens[0]?.startsWith("--")) {
		const flag = tokens.shift();
		if (flag === "--down" && placement !== "down") placement = "down";
		else if (flag === "--focus" && !focus) focus = true;
		else throw new Error(USAGE);
	}
	if (tokens.length !== 1 || !tokens[0]) throw new Error(USAGE);
	return normalizeBrowserOptions({ url: tokens[0], placement, focus });
}

export default function cmuxBrowserExtension(pi: ExtensionAPI) {
	const bindings = new BrowserBindings();
	pi.on("session_start", (_event, ctx) => bindings.start(ctx.sessionManager.getSessionId()));
	pi.on("session_shutdown", () => bindings.stop());

	pi.registerCommand("cmb", {
		description: "Open a browser beside Pi: /cmb [--down] [--focus] <url>",
		handler: async (args, ctx) => {
			let options: BrowserOpenOptions;
			try {
				options = parseBrowserCommand(args);
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "warning");
				return;
			}
			try {
				const binding = await bindings.open(pi, ctx.sessionManager.getSessionId(), options);
				ctx.ui.notify(`Opened browser ${binding.surfaceRef ?? binding.surfaceId} in a ${binding.placement === "right" ? "right" : "lower"} split.`, "info");
			} catch (error) {
				ctx.ui.notify(`browser open failed: ${error instanceof Error ? error.message : String(error)}`, "error");
			}
		},
	});

	pi.registerTool({
		name: "cmux_open_browser",
		label: "Open cmux browser",
		description: "Open a URL in a new cmux browser split beside this Pi terminal and bind its surface to this session. Opening only: no annotations, page interaction, or steering bridge yet.",
		promptSnippet: "Open a browser split in cmux when the user explicitly requests one.",
		promptGuidelines: [
			"Use cmux_open_browser only when the user explicitly requests opening a browser or URL in cmux or beside Pi.",
			"Use placement='right' for a side split and placement='down' for a lower split. Keep focus=false unless the user asks to focus the browser.",
			"Use cmux_open_browser directly, not a terminal command that opens another browser. This tool only opens a browser; it does not provide annotations or page interaction.",
			"If creation is not confirmed, inspect cmux or ask the user before retrying; a browser split may already exist.",
		],
		parameters: PARAMETERS as any,
		executionMode: "sequential",
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const binding = await bindings.open(pi, ctx.sessionManager.getSessionId(), params as BrowserOpenOptions, signal);
			return {
				content: [{ type: "text", text: `Opened browser ${binding.surfaceRef ?? binding.surfaceId} in a ${binding.placement === "right" ? "right" : "lower"} split, bound to this Pi session. Page readiness has not been checked. Annotation and interaction tools are not implemented yet.` }],
				details: { ...binding },
			};
		},
	});
}
