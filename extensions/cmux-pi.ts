import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { currentConversation, prepareOrientation, validateRelation, type RelationOptions } from "../lib/orientation/runtime.ts";
import { encodeBootstrap, orientedTitle, type Bootstrap } from "../lib/orientation/state.ts";
import { navigationHints } from "../lib/orientation/hints.ts";
import {
	buildContextualTabTitle,
	buildPiCommand,
	openCommandInNewSplit,
	openCommandInNewTab,
	openCommandInNewWorkspace,
	type PiCommandOptions,
	type SplitDirection,
} from "./cmux-core.ts";

export type PiPlacement = "workspace" | "tab" | SplitDirection;

export interface PiLaunchOptions extends PiCommandOptions, RelationOptions {
	placement?: PiPlacement;
	title?: string;
	focus?: boolean;
}

export const PI_LAUNCH_PROPERTIES = {
	placement: {
		type: "string", enum: ["workspace", "right", "down", "tab"], default: "workspace",
		description: "Where to start Pi. workspace creates a separate sidebar entry; tab stays in the current workspace.",
	},
	provider: { type: "string", description: "Optional Pi provider. Requires model; omit both to use Pi's normal model selection." },
	model: { type: "string", description: "Optional Pi model pattern or ID, including provider/model and model:thinking forms." },
	thinking: { type: "string", enum: ["off", "minimal", "low", "medium", "high", "xhigh", "max"], description: "Optional Pi thinking level." },
	title: { type: "string", description: "Short task title for the sidebar workspace or tab." },
	focus: { type: "boolean", default: true, description: "Focus the new workspace or terminal. Set false to open it in the background." },
	related: { type: "boolean", description: "Share the originating conversation's task marker without copying history. Use true for another agent working on the same task; defaults to false for unrelated chats." },
	role: { type: "string", enum: ["chat", "review", "continue"], description: "Conversation role. review and continue imply related=true; role alone never copies conversation history." },
} as const;

export function validatePiLaunchOptions(options: PiLaunchOptions): void {
	validateRelation(options);
	if (!["workspace", "right", "down", "tab"].includes(options.placement ?? "workspace")) {
		throw new Error("Invalid Pi placement");
	}
	if (options.provider?.trim() && !options.model?.trim()) throw new Error("provider requires model");
}

export function describePiPlacement(placement: PiPlacement): string {
	return placement === "workspace" ? "sidebar workspace" : placement === "tab" ? "tab" : `${placement} split`;
}

// The optional check must be side-effect-free: helpers repeat it at dispatch boundaries.
export async function openPiSession(pi: ExtensionAPI, cwd: string, options: PiLaunchOptions, fallbackTitle = "Pi", beforeLaunch?: (seed: Bootstrap | undefined) => void) {
	validatePiLaunchOptions(options);
	const placement = options.placement ?? "workspace";
	const topic = await buildContextualTabTitle(pi, cwd, options.title || options.prompt, fallbackTitle);
	const seed = prepareOrientation(pi, options, topic);
	const checkLaunch = () => {
		const origin = seed?.origin, own = origin && currentConversation(pi);
		if (origin && (!own || own.state.sessionId !== origin.sessionId || own.state.conversationId !== origin.conversationId
			|| own.state.taskId !== origin.taskId || own.target.surfaceId !== origin.target.surfaceId)) throw new Error("Launch origin binding changed");
		beforeLaunch?.(seed);
	};
	checkLaunch();
	const title = seed ? orientedTitle(seed, topic) : topic;
	const command = buildPiCommand(cwd, { ...options, orientationBootstrap: seed && encodeBootstrap(seed), provider: options.provider?.trim(), model: options.model?.trim() });
	const focus = options.focus ?? true;
	const result = placement === "workspace"
		? await openCommandInNewWorkspace(pi, cwd, command, { title, focus, checkLaunch })
		: placement === "tab"
			? await openCommandInNewTab(pi, command, { tabTitle: title, focus, checkLaunch })
			: await openCommandInNewSplit(pi, placement, command, { tabTitle: title, focus, checkLaunch });
	if (!result.ok) return result;
	return {
		ok: true as const,
		placement, cwd, title,
		workspaceRef: result.workspaceRef, surfaceRef: result.surfaceRef, source: result.source, created: result.created,
		orientation: seed, navigation: navigationHints(seed),
	};
}
