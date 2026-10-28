/**
 * Transient type-to-filter overlay for the cmux pane switcher.
 *
 * The overlay owns one interaction: it renders rows supplied by discovery,
 * filters them as the user types, and resolves exactly once with the selected
 * row (or undefined when cancelled). It changes no cmux state; focusing the
 * chosen surface is the caller's job.
 */
import { Input, Key, matchesKey, truncateToWidth, visibleWidth, type Component, type Focusable } from "@earendil-works/pi-tui";
import {
	agentLabel,
	filterRows,
	groupRows,
	rowTitle,
	safeText,
	typeLabel,
	workspaceLabel,
	type SwitcherRow,
} from "./model.ts";

export const SWITCHER_TITLE = "Jump to pane";
const MIN_FRAME_WIDTH = 24;
const DEFAULT_VIEWPORT_ROWS = 10;
const MAX_VIEWPORT_ROWS = 16;
/** Pi renders custom overlays at most this fraction of the terminal height. */
const OVERLAY_HEIGHT_RATIO = 0.7;
/** Border top, input, gap, gap, footer, border bottom. */
const FRAME_CHROME_ROWS = 6;
/** Title, input, footer when the frame is dropped. */
const COMPACT_CHROME_ROWS = 3;
/** A workspace header and both lines of the selected tab. */
const MIN_BODY_ROWS = 3;

/** Theme-derived styling, injected so rendering can be tested without ANSI colors. */
export interface SwitcherStyle {
	title(text: string): string;
	accent(text: string): string;
	muted(text: string): string;
	dim(text: string): string;
	selected(text: string): string;
	error(text: string): string;
	success(text: string): string;
}

export interface SwitcherTheme {
	fg(color: string, text: string): string;
	bold(text: string): string;
	inverse(text: string): string;
}

export function createSwitcherStyle(theme: SwitcherTheme): SwitcherStyle {
	return {
		title: (text) => theme.bold(text),
		accent: (text) => theme.fg("accent", text),
		muted: (text) => theme.fg("muted", text),
		dim: (text) => theme.fg("dim", text),
		selected: (text) => theme.inverse(text),
		error: (text) => theme.fg("error", text),
		success: (text) => theme.fg("success", text),
	};
}

const plainStyle: SwitcherStyle = {
	title: (text) => text,
	accent: (text) => text,
	muted: (text) => text,
	dim: (text) => text,
	selected: (text) => text,
	error: (text) => text,
	success: (text) => text,
};

export type SwitcherStatus =
	| { state: "loading" }
	| { state: "error"; message: string }
	| { state: "ready"; rows: readonly SwitcherRow[]; callerWorkspaceId?: string };

export interface PaneSwitcherOverlayOptions {
	style?: SwitcherStyle;
	/** Terminal height source; read again on every render so resizes are honored. */
	terminalRows?: number | (() => number | undefined);
	/** Explicit list rows, used by tests instead of a terminal height. */
	viewportRows?: number;
	done: (result: SwitcherRow | undefined) => void;
}

interface OverlayLayout { viewport: number; framed: boolean; minimal?: boolean }

/**
 * Pi caps a custom overlay to 70% of the terminal height, so the list budget
 * comes from that capped height rather than from the terminal itself. Ignoring
 * the cap clipped the selected row while Enter still accepted it.
 */
export function overlayLayoutFor(terminalRows: number | undefined, fixedViewport?: number): OverlayLayout {
	const fixed = fixedViewport === undefined ? undefined : Math.max(1, Math.floor(fixedViewport));
	if (fixed !== undefined) return { viewport: fixed, framed: true };
	const rows = terminalRows === undefined ? undefined : Math.floor(terminalRows);
	if (rows === undefined || !Number.isFinite(rows) || rows <= 0) {
		return { viewport: DEFAULT_VIEWPORT_ROWS, framed: true };
	}
	const capped = Math.max(1, Math.floor(rows * OVERLAY_HEIGHT_RATIO));
	// A result needs its workspace header and both tab lines. Below four lines
	// even an input plus that block cannot fit: show a resize message instead.
	if (capped < 1 + MIN_BODY_ROWS) return { viewport: 0, framed: false };
	if (capped < COMPACT_CHROME_ROWS + MIN_BODY_ROWS) {
		return { viewport: capped - 1, framed: false, minimal: true };
	}
	if (capped < FRAME_CHROME_ROWS + MIN_BODY_ROWS) {
		return { viewport: capped - COMPACT_CHROME_ROWS, framed: false };
	}
	return { viewport: Math.min(MAX_VIEWPORT_ROWS, capped - FRAME_CHROME_ROWS), framed: true };
}

interface FrameLine {
	row?: SwitcherRow;
	header?: string;
	/** Repeated when scrolling starts inside this workspace's rows. */
	workspaceHeader?: string;
	blank?: boolean;
}

export class PaneSwitcherOverlay implements Component, Focusable {
	readonly input: Input;
	private readonly style: SwitcherStyle;
	private readonly done: (result: SwitcherRow | undefined) => void;
	private readonly terminalRows: number | (() => number | undefined) | undefined;
	private readonly fixedViewport: number | undefined;
	private status: SwitcherStatus = { state: "loading" };
	private filtered: SwitcherRow[] = [];
	private selected = 0;
	private offset = 0;
	private settled = false;
	private focusedValue = false;
	private cache: { width: number; key: string; lines: string[] } | undefined;
	private renderVersion = 0;

	constructor(options: PaneSwitcherOverlayOptions) {
		this.style = options.style ?? plainStyle;
		this.done = options.done;
		this.terminalRows = options.terminalRows;
		this.fixedViewport = options.viewportRows;
		// No placeholder: an Input draws its cursor over the first placeholder
		// character, which reads like a selected letter. The footer carries the hint.
		this.input = new Input({ prompt: this.style.accent("› ") });
		this.input.focused = false;
	}

	get focused(): boolean { return this.focusedValue; }
	set focused(value: boolean) {
		this.focusedValue = value;
		this.input.focused = value;
	}

	setStatus(status: SwitcherStatus): void {
		this.status = status;
		this.selected = 0;
		this.offset = 0;
		this.refreshFiltered();
		this.invalidate();
	}

	getQuery(): string { return this.input.getValue(); }

	selectedRow(): SwitcherRow | undefined {
		return this.filtered[this.selected];
	}

	visibleRows(): SwitcherRow[] {
		return this.filtered;
	}

	invalidate(): void {
		this.cache = undefined;
		this.renderVersion++;
		this.input.invalidate();
	}

	handleInput(data: string): void {
		if (this.settled) return;
		if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) {
			this.finish(undefined);
			return;
		}
		// Check live dimensions even before a resize render: never accept an
		// invisible target. Escape above remains available in the resize state.
		if (this.layout().viewport === 0) return;
		if (matchesKey(data, Key.enter) || data === "\r" || data === "\n") {
			const row = this.selectedRow();
			// Enter on an empty result list must not guess or fall back to a target.
			if (row) this.finish(row);
			return;
		}
		if (matchesKey(data, Key.up) || matchesKey(data, Key.ctrl("p"))) {
			this.move(-1);
			return;
		}
		if (matchesKey(data, Key.down) || matchesKey(data, Key.ctrl("n"))) {
			this.move(1);
			return;
		}
		const previous = this.input.getValue();
		this.input.handleInput(data);
		if (this.input.getValue() !== previous) {
			this.selected = 0;
			this.offset = 0;
			this.refreshFiltered();
		}
		// Cursor-only edits (Left, Home, End, word motion) change nothing else, so
		// the rendered query line must be rebuilt for every forwarded key.
		this.invalidate();
	}

	render(width: number): string[] {
		const safeWidth = Math.max(1, Math.floor(width));
		const layout = this.layout();
		const cacheKey = `${this.renderVersion}:${this.selected}:${this.offset}:${this.status.state}:${layout.viewport}:${layout.framed}:${layout.minimal}`;
		if (this.cache && this.cache.width === safeWidth && this.cache.key === cacheKey) return this.cache.lines;
		const lines = layout.viewport === 0
			? [truncateToWidth(this.style.muted("Resize terminal · Esc closes"), safeWidth, "")]
			: safeWidth < MIN_FRAME_WIDTH || !layout.framed
				? this.renderNarrow(safeWidth, layout.viewport, layout.minimal)
				: this.renderFramed(safeWidth, layout.viewport);
		this.cache = { width: safeWidth, key: cacheKey, lines };
		return lines;
	}

	private layout(): OverlayLayout {
		const rows = typeof this.terminalRows === "function" ? this.terminalRows() : this.terminalRows;
		return overlayLayoutFor(rows, this.fixedViewport);
	}

	private finish(result: SwitcherRow | undefined): void {
		if (this.settled) return;
		this.settled = true;
		this.done(result);
	}

	private move(delta: number): void {
		if (!this.filtered.length) return;
		this.selected = Math.max(0, Math.min(this.filtered.length - 1, this.selected + delta));
		this.invalidate();
	}

	private refreshFiltered(): void {
		if (this.status.state !== "ready") {
			this.filtered = [];
			return;
		}
		const query = safeText(this.input.getValue());
		// Selection follows the rendered order: caller workspace first when
		// unfiltered, flat match order while filtering.
		const rows = query
			? filterRows(this.status.rows, query)
			: groupRows(this.status.rows, this.callerWorkspaceId()).flatMap((group) => group.rows);
		// The caller surface is the current conversation; it stays visible but is
		// marked, so filtering never silently rewrites the list order.
		this.filtered = rows;
		if (this.selected > rows.length - 1) this.selected = Math.max(0, rows.length - 1);
	}

	private callerWorkspaceId(): string | undefined {
		return this.status.state === "ready" ? this.status.callerWorkspaceId : undefined;
	}

	/** Status placeholders; ready rows are rendered by the viewport path. */
	private statusLines(): string[] {
		if (this.status.state === "loading") return [this.style.muted("Reading cmux layout…")];
		// cmux error text is untrusted display input: sanitize and bound it here so a
		// stray newline, escape sequence or control byte cannot break the frame.
		if (this.status.state === "error") return [this.style.error(safeText(this.status.message, "Cannot read the cmux layout"))];
		if (!this.status.rows.length) return [this.style.muted("No switchable cmux panes")];
		return [this.style.muted("No matching panes")];
	}

	private windowCount(): number {
		const windows = new Set<string>();
		if (this.status.state === "ready") for (const row of this.status.rows) windows.add(row.windowId);
		return Math.max(1, windows.size);
	}

	private workspaceName(row: Pick<SwitcherRow, "windowId" | "workspaceId" | "windowIndex" | "workspaceIndex" | "workspaceTitle">, width?: number): string {
		const title = safeText(row.workspaceTitle, "untitled workspace");
		const duplicate = this.status.state === "ready" && this.status.rows.some((other) =>
			other.windowId === row.windowId && other.workspaceId !== row.workspaceId
			&& safeText(other.workspaceTitle, "untitled workspace") === title);
		const windows = this.windowCount();
		let label = workspaceLabel(row, windows, duplicate);
		if (width === undefined) return label;
		// If verbose location prefixes alone would be clipped, shorten their
		// names before truncating so window/workspace numbers remain distinct.
		if (visibleWidth(label) - visibleWidth(title) >= width) {
			const location = [windows > 1 ? `w${row.windowIndex}` : "", duplicate ? `ws${row.workspaceIndex}` : ""].filter(Boolean).join("/");
			label = location ? `${location} · ${title}` : title;
		}
		return truncateToWidth(label, width, "…");
	}

	/** Physical lines to display, windowed by whole result blocks where possible. */
	private visibleBody(innerWidth: number, viewport: number): string[] {
		const query = safeText(this.input.getValue());
		if (this.status.state !== "ready" || !this.filtered.length) {
			return this.statusLines().map((line) => truncateToWidth(line, innerWidth, "…"));
		}
		const items: FrameLine[] = [];
		if (query) {
			for (const row of this.filtered) items.push({ row });
		} else {
			const groups = groupRows(this.status.rows, this.callerWorkspaceId());
			groups.forEach((group, index) => {
				if (index > 0) items.push({ blank: true });
				// Keep the workspace level explicit even when its title repeats a tab.
				const header = this.style.dim("WORKSPACE  ") + this.style.muted(this.workspaceName(group));
				items.push({ header });
				for (const row of group.rows) items.push({ row, workspaceHeader: header });
			});
		}

		const selectedItem = items.findIndex((item) => item.row === this.selectedRow());
		if (selectedItem >= 0 && selectedItem < this.offset) this.offset = selectedItem;
		this.offset = Math.max(0, Math.min(this.offset, Math.max(0, items.length - 1)));
		// Reserve the sticky header in the same budget as the selected result.
		const stickyHeader = (start: number) => viewport >= MIN_BODY_ROWS ? items[start]?.workspaceHeader : undefined;
		const height = (start: number, end: number) => items.slice(start, end + 1)
			.reduce((total, item) => total + (item.row ? 2 : 1), stickyHeader(start) ? 1 : 0);
		while (selectedItem >= 0 && this.offset < selectedItem && height(this.offset, selectedItem) > viewport) this.offset++;
		// After a resize, backfill newly available space instead of leaving the
		// viewport anchored near the end with only a few visible results.
		while (selectedItem >= 0 && this.offset > 0 && height(this.offset - 1, selectedItem) <= viewport) this.offset--;

		const header = stickyHeader(this.offset);
		const lines: string[] = header ? [truncateToWidth(header, innerWidth, "…")] : [];
		for (let index = this.offset; index < items.length && lines.length < viewport; index++) {
			lines.push(...this.renderLine(items[index], innerWidth, query));
		}
		return lines.slice(0, viewport);
	}

	private renderLine(line: FrameLine, innerWidth: number, query: string): string[] {
		if (line.row) return this.renderRow(line.row, innerWidth, query);
		if (line.header) return [truncateToWidth(line.header, innerWidth, "…")];
		return [""];
	}

	private renderRow(row: SwitcherRow, innerWidth: number, query: string): string[] {
		const selected = row === this.selectedRow();
		const marker = selected ? "▸ " : "  ";
		const icon = row.agent ? "◆" : row.type === "browser" ? "◉" : "›";
		const prefix = `${marker}${icon} `;
		const titleWidth = Math.max(1, innerWidth - visibleWidth(prefix));
		// Bound workspace context separately so a long name cannot swallow the
		// tab title. Location discriminators lead the context and survive clipping.
		const context = query ? this.workspaceName(row, Math.max(1, Math.floor((titleWidth - 3) / 2))) : "";
		const title = query ? `${context} / ${rowTitle(row)}` : rowTitle(row);
		const left = truncateToWidth(title, titleWidth, "…");
		const titleLine = `${prefix}${left}`;
		const label = agentLabel(row) ?? typeLabel(row);
		const location = `pane ${row.paneIndex} · tab ${row.surfaceIndex}`;
		const indent = " ".repeat(visibleWidth(prefix));
		const statusLine = `${indent}${location} · ${label}${row.isCaller ? " · you" : ""}`;
		if (selected) {
			// Highlight the whole two-line block, as in the cmux sidebar.
			return [titleLine, statusLine].map((line) => this.style.selected(padLine(line, innerWidth)));
		}
		const working = safeText(row.agent?.state).toLowerCase() === "working";
		const statusStyle = working ? this.style.success : row.agent ? this.style.muted : this.style.dim;
		const status = this.style.dim(`${indent}${location} · `) + (row.isCaller
			? statusStyle(`${label} · `) + this.style.accent("you")
			: statusStyle(label));
		return [this.style.accent(marker) + this.style.accent(`${icon} `) + left, status];
	}

	private footerLines(innerWidth: number): string[] {
		const parts: Array<[string, string]> = [["↑↓", "select"], ["Enter", "jump"], ["Esc", "close"]];
		const hint = this.style.dim("Type to filter");
		const fullWidth = visibleWidth(`Type to filter  ${parts.map(([key, label]) => `${key} ${label}`).join("  ")}`);
		if (fullWidth <= innerWidth) {
			return [`${hint}  ${parts.map(([key, label]) => `${this.style.accent(key)} ${this.style.muted(label)}`).join("  ")}`];
		}
		const compact = parts.map(([key, label]) => `${key} ${label}`).join(" · ");
		if (visibleWidth(compact) <= innerWidth) {
			return [parts.map(([key, label]) => `${this.style.accent(key)} ${this.style.muted(label)}`).join(this.style.dim(" · "))];
		}
		return [this.style.muted(truncateToWidth(compact, innerWidth, ""))];
	}

	private renderFramed(width: number, viewport: number): string[] {
		const innerWidth = width - 2;
		const title = ` ${this.style.title(this.style.accent(`✦ ${SWITCHER_TITLE}`))} `;
		const count = this.paneCount();
		const countLabel = count && visibleWidth(title) + visibleWidth(count) + 6 <= width ? this.style.dim(`${count} `) : "";
		const topFill = Math.max(0, width - 3 - visibleWidth(title) - visibleWidth(countLabel));
		const border = (line: string) => this.style.dim(line);
		const lines: string[] = [];
		lines.push(border("╭─") + title + border("─".repeat(topFill)) + countLabel + border("╮"));
		const inputLines = this.input.render(innerWidth);
		for (const line of inputLines) lines.push(border("│") + padLine(line, innerWidth) + border("│"));
		lines.push(border("│") + " ".repeat(innerWidth) + border("│"));
		for (const line of this.visibleBody(innerWidth, viewport)) lines.push(border("│") + padLine(line, innerWidth) + border("│"));
		lines.push(border("│") + " ".repeat(innerWidth) + border("│"));
		for (const line of this.footerLines(innerWidth)) lines.push(border("│") + padLine(line, innerWidth) + border("│"));
		lines.push(border(`╰${"─".repeat(width - 2)}╯`));
		return lines;
	}

	private paneCount(): string {
		if (this.status.state !== "ready") return "";
		const total = this.status.rows.length;
		if (safeText(this.input.getValue())) return ` ${this.filtered.length}/${total} `;
		return ` ${total} ${total === 1 ? "pane" : "panes"} `;
	}

	/** Very narrow terminals drop the frame rather than clipping the list. */
	private renderNarrow(width: number, viewport: number, minimal = false): string[] {
		const lines: string[] = minimal ? [] : [truncateToWidth(this.style.title(this.style.accent(`✦ ${SWITCHER_TITLE}`)), width, "")];
		for (const line of this.input.render(width)) lines.push(truncateToWidth(line, width, ""));
		for (const line of this.visibleBody(width, viewport)) lines.push(truncateToWidth(line, width, ""));
		if (!minimal) for (const line of this.footerLines(width)) lines.push(truncateToWidth(line, width, ""));
		return lines;
	}
}

function padLine(line: string, width: number): string {
	const clipped = truncateToWidth(line, width, "");
	const padding = width - visibleWidth(clipped);
	return padding > 0 ? `${clipped}${" ".repeat(padding)}` : clipped;
}
