/**
 * Shared row contract for the cmux pane switcher.
 *
 * Every row is one switchable cmux surface (terminal tab or browser tab). The
 * switcher never stores this data: discovery rebuilds it from live cmux
 * topology on each opening, and navigation revalidates the same surface UUID
 * before focusing anything.
 */

export interface SurfaceAgent {
	/** Agent kind as reported by cmux (for example `pi`, `claude`). */
	kind: string;
	/** Agent activity as reported by cmux (for example `working`, `idle`). */
	state: string;
}

export interface SwitcherRow {
	windowId: string;
	workspaceId: string;
	paneId: string;
	surfaceId: string;
	/** 1-based window position; cmux exposes no window title. */
	windowIndex: number;
	workspaceIndex: number;
	paneIndex: number;
	surfaceIndex: number;
	workspaceTitle: string;
	surfaceTitle: string;
	type: string;
	url?: string;
	/** Only present when cmux reported exactly one attributed agent for the surface. */
	agent?: SurfaceAgent;
	/** True for the surface that opened the switcher. */
	isCaller: boolean;
}

export interface SwitcherCaller {
	windowId: string;
	workspaceId: string;
	paneId: string;
	surfaceId: string;
}

export interface SwitcherGroup {
	windowId: string;
	workspaceId: string;
	windowIndex: number;
	workspaceIndex: number;
	workspaceTitle: string;
	rows: SwitcherRow[];
}

const MAX_TEXT_LENGTH = 200;

/**
 * External cmux text is untrusted display input: strip ANSI escapes and control
 * characters, collapse whitespace, and bound the length before rendering.
 */
export function safeText(value: unknown, fallback = ""): string {
	if (typeof value !== "string") return fallback;
	const stripped = value
		// CSI, OSC and single-character escapes.
		.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, " ")
		.replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)?/g, " ")
		.replace(/\u001b[@-Z\\-_]?/g, " ")
		.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
		.replace(/\s+/g, " ")
		.trim();
	return stripped ? stripped.slice(0, MAX_TEXT_LENGTH) : fallback;
}

/** `Pi · working`; undefined when cmux reported no usable agent metadata. */
export function agentLabel(row: SwitcherRow): string | undefined {
	const agent = row.agent;
	if (!agent) return undefined;
	const kind = safeText(agent.kind);
	const state = safeText(agent.state);
	if (!kind || !state) return undefined;
	return `${kind} · ${state}`;
}

/** Fallback label used when no verified agent metadata exists, never a guessed state. */
export function typeLabel(row: SwitcherRow): string {
	return safeText(row.type, "surface");
}

export function rowTitle(row: SwitcherRow): string {
	return safeText(row.surfaceTitle) || safeText(row.url) || safeText(row.type, "surface");
}

function searchableFields(row: SwitcherRow): string[] {
	return [
		safeText(row.workspaceTitle),
		safeText(row.surfaceTitle),
		safeText(row.type),
		safeText(row.url),
		safeText(row.agent?.kind),
		safeText(row.agent?.state),
	];
}

/** Case-insensitive, whitespace-separated token matching with stable ordering. */
export function filterRows(rows: readonly SwitcherRow[], query: string): SwitcherRow[] {
	const tokens = safeText(query).toLowerCase().split(" ").filter(Boolean);
	if (!tokens.length) return [...rows];
	return rows.filter((row) => {
		const fields = searchableFields(row).map((value) => value.toLowerCase());
		return tokens.every((token) => fields.some((field) => field.includes(token)));
	});
}

function compareRows(a: SwitcherRow, b: SwitcherRow): number {
	return a.windowIndex - b.windowIndex
		|| a.workspaceIndex - b.workspaceIndex
		|| a.paneIndex - b.paneIndex
		|| a.surfaceIndex - b.surfaceIndex
		|| a.surfaceId.localeCompare(b.surfaceId);
}

/**
 * Group rows by workspace, keeping the caller workspace first so the nearby
 * panes are the easiest to reach. Ordering inside a group is stable.
 */
export function groupRows(rows: readonly SwitcherRow[], callerWorkspaceId?: string): SwitcherGroup[] {
	const groups = new Map<string, SwitcherGroup>();
	for (const row of rows) {
		const key = `${row.windowId}/${row.workspaceId}`;
		let group = groups.get(key);
		if (!group) {
			group = {
				windowId: row.windowId,
				workspaceId: row.workspaceId,
				windowIndex: row.windowIndex,
				workspaceIndex: row.workspaceIndex,
				workspaceTitle: row.workspaceTitle,
				rows: [],
			};
			groups.set(key, group);
		}
		group.rows.push(row);
	}
	const ordered = [...groups.values()];
	for (const group of ordered) group.rows.sort(compareRows);
	ordered.sort((a, b) => {
		const callerFirst = Number(b.workspaceId === callerWorkspaceId) - Number(a.workspaceId === callerWorkspaceId);
		return callerFirst || a.windowIndex - b.windowIndex || a.workspaceIndex - b.workspaceIndex;
	});
	return ordered;
}

export function sortRows(rows: readonly SwitcherRow[]): SwitcherRow[] {
	return [...rows].sort(compareRows);
}

/** Workspace label with optional location prefixes for otherwise ambiguous names. */
export function workspaceLabel(
	group: Pick<SwitcherGroup, "workspaceTitle" | "windowIndex" | "workspaceIndex">,
	windowCount: number,
	duplicateTitle = false,
): string {
	const title = safeText(group.workspaceTitle, "untitled workspace");
	const label = duplicateTitle ? `workspace ${group.workspaceIndex} · ${title}` : title;
	return windowCount > 1 ? `window ${group.windowIndex} · ${label}` : label;
}
