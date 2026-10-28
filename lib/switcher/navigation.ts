/**
 * Exact-target navigation for the pane switcher.
 *
 * A selected row is only a UUID claim. Navigation re-reads live topology,
 * requires one unique switchable surface with that UUID, then focuses it and
 * checks that cmux echoed the same window/workspace/surface. Titles, indices,
 * selected-pane defaults and terminal input are never used as targets.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { execCmux } from "../../extensions/cmux-core.ts";
import { uuid } from "../orientation/state.ts";
import { revalidateSurface } from "./discovery.ts";
import type { SwitcherRow } from "./model.ts";

const FOCUS_MAX_BYTES = 1_000_000;

export type FocusResult = { ok: true; row: SwitcherRow } | { ok: false; error: string };

export async function focusSurface(
	pi: ExtensionAPI,
	row: Pick<SwitcherRow, "surfaceId">,
	options: { signal?: AbortSignal } = {},
): Promise<FocusResult> {
	const resolved = await revalidateSurface(pi, row.surfaceId, options);
	if (!resolved.ok) return resolved;
	const target = resolved.row;
	const focused = await execCmux(pi, [
		"--json", "--id-format", "both", "rpc", "surface.focus",
		JSON.stringify({
			window_id: target.windowId,
			workspace_id: target.workspaceId,
			surface_id: target.surfaceId,
		}),
	], options.signal);
	if (!focused.ok) return { ok: false, error: focused.error || "cmux surface.focus is unavailable" };
	if (focused.stdout.length > FOCUS_MAX_BYTES) return { ok: false, error: "cmux focus response is too large" };
	let response: Record<string, unknown> | undefined;
	try {
		const parsed = JSON.parse(focused.stdout) as unknown;
		response = parsed && typeof parsed === "object" && !Array.isArray(parsed)
			? parsed as Record<string, unknown>
			: undefined;
	} catch {
		return { ok: false, error: "cmux returned an unreadable focus response" };
	}
	// Unconfirmed focus is reported; it is never retried or replaced by a
	// nearby target such as the selected pane or a same-titled tab.
	if (uuid(response?.window_id) !== target.windowId
		|| uuid(response?.workspace_id) !== target.workspaceId
		|| uuid(response?.surface_id) !== target.surfaceId) {
		return { ok: false, error: "cmux did not confirm the exact target" };
	}
	return { ok: true, row: target };
}
