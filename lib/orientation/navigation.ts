import { uuid, type Target } from "./state.ts";

function record(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid cmux topology response");
	return value as Record<string, unknown>;
}
function array(value: unknown): unknown[] {
	if (!Array.isArray(value)) throw new Error("Invalid cmux topology response");
	return value;
}

/** Match full surface identity, never selection, indices, titles or stale pane coordinates. */
export function locateSurface(value: unknown, surfaceId: string): Target {
	const matches: Target[] = [];
	for (const windowValue of array(record(value).windows)) {
		const window = record(windowValue);
		for (const workspaceValue of array(window.workspaces)) {
			const workspace = record(workspaceValue);
			for (const paneValue of array(workspace.panes)) {
				const pane = record(paneValue);
				for (const surfaceValue of array(pane.surfaces)) {
					const surface = record(surfaceValue);
					if (uuid(surface.id) !== surfaceId) continue;
					const windowId = uuid(window.id), workspaceId = uuid(workspace.id), paneId = uuid(pane.id);
					if (!windowId || !workspaceId || !paneId || surface.type !== "terminal" || (surface.pane_id !== undefined && uuid(surface.pane_id) !== paneId)) throw new Error("Invalid cmux origin surface location");
					matches.push({ windowId, workspaceId, paneId, surfaceId });
				}
			}
		}
	}
	if (matches.length !== 1) throw new Error(matches.length ? "Origin surface is ambiguous" : "Origin surface is closed or inaccessible");
	return matches[0];
}
