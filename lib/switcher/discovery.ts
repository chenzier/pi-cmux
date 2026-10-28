/**
 * Live cmux discovery for the pane switcher.
 *
 * cmux stays the source of truth: this module reads the current topology on
 * every opening and never persists a pane registry, scrapes terminals, scans
 * processes or starts a background watcher.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { execCmux } from "../../extensions/cmux-core.ts";
import { uuid } from "../orientation/state.ts";
import {
	safeText,
	sortRows,
	type SurfaceAgent,
	type SwitcherCaller,
	type SwitcherRow,
} from "./model.ts";

const TREE_MAX_BYTES = 5_000_000;
const CURRENT_MAX_BYTES = 1_000_000;
const CURRENT_LIMIT = 200;
const SWITCHABLE_TYPES = new Set(["terminal", "browser"]);

export interface SwitcherDiscovery {
	rows: SwitcherRow[];
	caller?: SwitcherCaller;
	windowCount: number;
}

export type SwitcherDiscoveryResult =
	| { ok: true; discovery: SwitcherDiscovery }
	| { ok: false; error: string };

function record(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? value as Record<string, unknown>
		: undefined;
}

function array(value: unknown): unknown[] | undefined {
	return Array.isArray(value) ? value : undefined;
}

function indexOf(value: unknown, fallback: number): number {
	return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function agentOf(value: unknown): SurfaceAgent | undefined {
	const agent = record(value);
	const kind = safeText(agent?.kind);
	const state = safeText(agent?.state);
	return kind && state ? { kind, state } : undefined;
}

/**
 * Map surface UUIDs to the single agent cmux attributes to them. Ended
 * sessions that still share the tab are ignored; anything left missing or
 * ambiguous is simply absent, which renders as the surface type rather than a
 * guessed activity state.
 */
export function parseAgents(value: unknown): Map<string, SurfaceAgent> {
	const agents = new Map<string, SurfaceAgent>();
	const items = array(record(value)?.items);
	if (!items) return agents;
	const candidates = new Map<string, SurfaceAgent[]>();
	// A surface covered by any incomplete or withheld current item is ambiguous,
	// even when another item would otherwise supply exactly one agent. Recording
	// it here keeps the result independent of item order and count.
	const ambiguous = new Set<string>();
	for (const itemValue of items) {
		const item = record(itemValue);
		if (!item) continue;
		// Stale projections are not verified metadata for the current layout.
		if (safeText(record(item.freshness)?.state) !== "current") continue;
		const rawAgents = array(item.agents) ?? [];
		const reported = rawAgents.map(agentOf).filter((agent): agent is SurfaceAgent => agent !== undefined);
		const omitted = record(item.omitted)?.agents;
		// An entry without kind or state, or an agent cmux says it withheld, means
		// the surface's agents are not fully known: never claim a unique one.
		const partial = reported.length !== rawAgents.length || (typeof omitted === "number" && omitted > 0);
		const live = reported.filter((agent) => agent.state !== "ended");
		const surfaceIds = new Set<string>();
		for (const projectionValue of array(item.projections) ?? []) {
			const surfaceId = uuid(record(projectionValue)?.panel_id);
			if (surfaceId) surfaceIds.add(surfaceId);
		}
		if (partial) {
			for (const surfaceId of surfaceIds) ambiguous.add(surfaceId);
			continue;
		}
		for (const surfaceId of surfaceIds) {
			const list = candidates.get(surfaceId) ?? [];
			for (const agent of live) list.push(agent);
			if (!live.length && reported.length === 1) list.push(reported[0]);
			candidates.set(surfaceId, list);
		}
	}
	for (const [surfaceId, list] of candidates) {
		if (ambiguous.has(surfaceId)) continue;
		const [first] = list;
		// Several live agents on one surface cannot be attributed to it safely.
		if (list.length === 1 && first) agents.set(surfaceId, first);
	}
	return agents;
}

interface ParsedTopology {
	rows: SwitcherRow[];
	caller?: SwitcherCaller;
	windowCount: number;
}

/** Parse and validate `cmux tree --all`; ambiguous or duplicate identities are rejected. */
export function parseTopology(value: unknown): ParsedTopology {
	const root = record(value);
	const windows = array(root?.windows);
	if (!windows) throw new Error("Invalid cmux topology response");
	const rows: SwitcherRow[] = [];
	const seen = new Map<string, string>();
	let caller: SwitcherCaller | undefined;
	const callerSurface = uuid(process.env.CMUX_SURFACE_ID);

	windows.forEach((windowValue, windowPosition) => {
		const window = record(windowValue);
		const windowId = uuid(window?.id);
		if (!window || !windowId) throw new Error("Invalid cmux window identity");
		const workspaceValues = array(window.workspaces);
		if (!workspaceValues) throw new Error("Invalid cmux workspace list");
		const windowIndex = indexOf(window.index, windowPosition) + 1;
		workspaceValues.forEach((workspaceValue, workspacePosition) => {
			const workspace = record(workspaceValue);
			const workspaceId = uuid(workspace?.id);
			if (!workspace || !workspaceId) throw new Error("Invalid cmux workspace identity");
			const paneValues = array(workspace.panes);
			if (!paneValues) throw new Error("Invalid cmux pane list");
			const workspaceTitle = safeText(workspace.title, "untitled workspace");
			const workspaceIndex = indexOf(workspace.index, workspacePosition) + 1;
			paneValues.forEach((paneValue, panePosition) => {
				const pane = record(paneValue);
				const paneId = uuid(pane?.id);
				if (!pane || !paneId) throw new Error("Invalid cmux pane identity");
				const surfaceValues = array(pane.surfaces);
				if (!surfaceValues) throw new Error("Invalid cmux surface list");
				const paneIndex = indexOf(pane.index, panePosition) + 1;
				surfaceValues.forEach((surfaceValue, surfacePosition) => {
					const surface = record(surfaceValue);
					if (!surface) throw new Error("Invalid cmux surface entry");
					const type = safeText(surface.type);
					if (!SWITCHABLE_TYPES.has(type)) return;
					const surfaceId = uuid(surface.id);
					if (!surfaceId) throw new Error("Invalid cmux surface identity");
					if (surface.pane_id !== undefined && surface.pane_id !== null && uuid(surface.pane_id) !== paneId) {
						throw new Error("Invalid cmux surface location");
					}
					const location = `${windowId}/${workspaceId}/${paneId}`;
					const previous = seen.get(surfaceId);
					if (previous !== undefined && previous !== location) throw new Error("Surface identity is ambiguous");
					if (previous === undefined) seen.set(surfaceId, location);
					const here = surface.here === true
						|| (callerSurface !== undefined && surfaceId === callerSurface);
					if (here) caller = { windowId, workspaceId, paneId, surfaceId };
					const url = safeText(surface.url);
					rows.push({
						windowId,
						workspaceId,
						paneId,
						surfaceId,
						windowIndex,
						workspaceIndex,
						paneIndex,
						surfaceIndex: indexOf(surface.index_in_pane, surfacePosition) + 1,
						workspaceTitle,
						surfaceTitle: safeText(surface.title),
						type,
						...(url ? { url } : {}),
						isCaller: here,
					});
				});
			});
		});
	});

	return { rows: sortRows(rows), ...(caller ? { caller } : {}), windowCount: windows.length };
}

function parseTreeJson(stdout: string): unknown {
	if (stdout.length > TREE_MAX_BYTES) throw new Error("cmux topology response is too large");
	try {
		return JSON.parse(stdout) as unknown;
	} catch {
		throw new Error("Invalid cmux topology response");
	}
}

function parseCurrentJson(stdout: string): unknown {
	if (stdout.length > CURRENT_MAX_BYTES) return undefined;
	try {
		return JSON.parse(stdout) as unknown;
	} catch {
		return undefined;
	}
}

/** Read live cmux topology plus optional agent labels; missing labels never fail discovery. */
export async function discoverSwitcher(
	pi: ExtensionAPI,
	options: { signal?: AbortSignal } = {},
): Promise<SwitcherDiscoveryResult> {
	const tree = await execCmux(pi, ["--json", "--id-format", "both", "tree", "--all"], options.signal);
	if (!tree.ok) return { ok: false, error: tree.error || "Cannot read the cmux layout" };
	let parsed: ParsedTopology;
	try {
		parsed = parseTopology(parseTreeJson(tree.stdout));
	} catch (error) {
		return { ok: false, error: error instanceof Error ? error.message : "Invalid cmux topology response" };
	}
	// Agent labels are supporting context only: a failure or empty answer keeps
	// the ordinary rows and never invents an activity state.
	const current = await execCmux(
		pi,
		["--json", "current", "--limit", String(CURRENT_LIMIT)],
		options.signal,
	);
	const agents = current.ok ? parseAgents(parseCurrentJson(current.stdout)) : new Map<string, SurfaceAgent>();
	const rows = parsed.rows.map((row) => {
		const agent = agents.get(row.surfaceId);
		return { ...row, ...(agent ? { agent } : {}) } satisfies SwitcherRow;
	});
	return {
		ok: true,
		discovery: { rows, ...(parsed.caller ? { caller: parsed.caller } : {}), windowCount: parsed.windowCount },
	};
}

export type SurfaceResolution =
	| { ok: true; row: SwitcherRow }
	| { ok: false; error: string };

/**
 * Re-resolve one surface UUID in fresh topology so a moved tab keeps its exact
 * identity. Titles, indices and selected-pane defaults are never used.
 */
export async function revalidateSurface(
	pi: ExtensionAPI,
	surfaceId: string,
	options: { signal?: AbortSignal } = {},
): Promise<SurfaceResolution> {
	const target = uuid(surfaceId);
	if (!target) return { ok: false, error: "Invalid surface identity" };
	const tree = await execCmux(pi, ["--json", "--id-format", "both", "tree", "--all"], options.signal);
	if (!tree.ok) return { ok: false, error: tree.error || "Cannot read the cmux layout" };
	let parsed: ParsedTopology;
	try {
		parsed = parseTopology(parseTreeJson(tree.stdout));
	} catch (error) {
		return { ok: false, error: error instanceof Error ? error.message : "Invalid cmux topology response" };
	}
	const matches = parsed.rows.filter((row) => row.surfaceId === target);
	const [match] = matches;
	if (!match) return { ok: false, error: "That surface is closed or no longer exists" };
	if (matches.length > 1) return { ok: false, error: "That surface appears more than once; not switching" };
	return { ok: true, row: match };
}
