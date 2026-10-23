import { marker, parseBootstrap, type Bootstrap } from "./state.ts";

export const NAVIGATION_MESSAGE = "pi-cmux.navigation";
export interface NavigationHints {
	originLabel: string;
	originUrl: string;
	returnCommand: "/cmbk";
}
export interface ReturnShortcut { key?: string; label?: string; invalid: boolean }

export function resolveReturnShortcut(raw?: string): ReturnShortcut {
	const key = raw?.trim().toLowerCase() || "ctrl+alt+b";
	if (key === "off") return { invalid: false };
	const modifiers = key.split("+").slice(0, -1);
	if (!/^(?:(?:ctrl|alt|shift)\+)*(?:[a-z0-9]|left|right|up|down|home|end|f[1-9]|f1[0-2])$/.test(key) || new Set(modifiers).size !== modifiers.length) return { invalid: true };
	const label = key.split("+").map(part => part.length === 1 || /^f\d+$/.test(part) ? part.toUpperCase() : part[0].toUpperCase() + part.slice(1)).join("+");
	return { key, label, invalid: false };
}

/** Native tab links use full UUIDs, not labels, indices, or short refs. */
export function navigationHints(value: Bootstrap | undefined): NavigationHints | undefined {
	const seed = parseBootstrap(value), origin = seed?.origin;
	if (!seed || !origin || seed.taskId !== origin.taskId) return undefined;
	return {
		originLabel: marker(origin),
		originUrl: `cmux://workspace/${origin.target.workspaceId}/surface/${origin.target.surfaceId}`,
		returnCommand: "/cmbk",
	};
}

export function launchNavigationHint(hints: NavigationHints): string {
	return `Origin: [${hints.originLabel}](${hints.originUrl}). In the new pane, use \`${hints.returnCommand}\` to return (default shortcut: Ctrl+Alt+B; configurable).`;
}

export function childNavigationHint(hints: NavigationHints, shortcut: ReturnShortcut): string {
	return [
		"Navigation for this related conversation (current origin, not inherited handoff hints):",
		`Origin: [${hints.originLabel}](${hints.originUrl}).`,
		`Return from this pane with \`${hints.returnCommand}\`${shortcut.label ? ` or ${shortcut.label}` : ""}.`,
		"Include this origin link and return hint when giving the user navigation or handoff guidance. Keep the task and its output requirements unchanged; do not navigate unless explicitly asked.",
		"Prefer /cmbk: it validates the live Pi conversation. The native link only selects the tab in the current cmux run and does not check which Pi session now occupies it. It is not a message channel or permission to do additional work.",
	].join("\n");
}
