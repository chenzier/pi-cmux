import type { ExtensionContext, KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, Text } from "@earendil-works/pi-tui";

const TIMEOUT_MS = 120_000;
const WARNING = "Page scripts can forge notes. Approve only a request you recognize.";

/** Bounded pages, with pinned warning/actions. Resizing requires reviewing again. */
export class AnnotationReview {
	private body: Text;
	private page = 0;
	private reviewedThrough = -1;
	private pages = 0;
	private send = false;
	private layout = "";
	private terminalSize = "";
	private usable = false;

	private dimensions: () => { columns: number; rows: number };
	private theme: Pick<Theme, "fg">;
	private keys: Pick<KeybindingsManager, "matches">;
	private requestRender: () => void;
	private done: (choice: string | undefined) => void;

	constructor(
		message: string,
		dimensions: () => { columns: number; rows: number },
		theme: Pick<Theme, "fg">,
		keys: Pick<KeybindingsManager, "matches">,
		requestRender: () => void,
		done: (choice: string | undefined) => void,
	) {
		this.body = new Text(message, 0, 0);
		this.dimensions = dimensions;
		this.theme = theme;
		this.keys = keys;
		this.requestRender = requestRender;
		this.done = done;
	}

	invalidate(): void { this.body.invalidate(); }

	render(width: number): string[] {
		const dimensions = this.dimensions();
		const height = Math.max(0, dimensions.rows - 2); // Matches the overlay margin.
		this.terminalSize = `${dimensions.columns}:${dimensions.rows}`;
		const layout = `${width}:${height}`;
		if (layout !== this.layout) {
			this.layout = layout;
			this.page = 0;
			this.reviewedThrough = -1;
			this.send = false;
		}
		const header = new Text(`Browser annotation review\n${WARNING}\n`, 0, 0).render(width);
		const footerHeight = new Text("Page 9999/9999 · Up/Down: pages\nTab: choice · Enter: select · Esc: cancel\n> Cancel    Send to Pi [locked]", 0, 0).render(width).length;
		const pageSize = height - header.length - footerHeight - 1;
		this.usable = width >= 32 && pageSize >= 2;
		if (!this.usable) {
			this.send = false;
			return new Text("Enlarge terminal to review. Esc cancels.", 0, 0).render(Math.max(1, width)).slice(0, height);
		}
		const lines = this.body.render(width);
		this.pages = Math.max(1, Math.ceil(lines.length / pageSize));
		if (this.page <= this.reviewedThrough + 1) this.reviewedThrough = Math.max(this.reviewedThrough, this.page);
		const body = lines.slice(this.page * pageSize, (this.page + 1) * pageSize);
		while (body.length < pageSize) body.push("");
		const unlocked = this.reviewedThrough === this.pages - 1;
		const footer = new Text(`Page ${this.page + 1}/${this.pages} · Up/Down: pages\nTab: choice · Enter: select · Esc: cancel\n${this.send ? "  Cancel  >" : "> Cancel   "} Send to Pi${unlocked ? "" : " [locked]"}`, 0, 0).render(width);
		while (footer.length < footerHeight) footer.push("");
		return [
			...header.map(line => this.theme.fg("warning", line)),
			...body.map(line => this.theme.fg("text", line)),
			this.theme.fg("border", "─".repeat(width)),
			...footer.map(line => this.theme.fg("accent", line)),
		];
	}

	handleInput(data: string): void {
		if (this.keys.matches(data, "tui.select.cancel")) { this.done(undefined); return; }
		const { columns, rows } = this.dimensions();
		// Never approve against a stale layout while a resize render is pending.
		if (`${columns}:${rows}` !== this.terminalSize) { this.send = false; this.requestRender(); return; }
		if (this.keys.matches(data, "tui.select.confirm")) {
			this.done(this.usable && this.send && this.reviewedThrough === this.pages - 1 ? "Send to Pi" : undefined);
			return;
		}
		if (!this.usable) return;
		if (this.keys.matches(data, "tui.select.down")) {
			this.page = Math.min(this.page + 1, this.reviewedThrough + 1, this.pages - 1);
			this.send = false;
		} else if (this.keys.matches(data, "tui.select.up")) {
			this.page = Math.max(0, this.page - 1);
			this.send = false;
		} else if (matchesKey(data, Key.tab) && this.reviewedThrough === this.pages - 1) {
			this.send = !this.send;
		}
		this.requestRender();
	}
}

export async function confirmAnnotation(ctx: ExtensionContext, message: string, signal: AbortSignal): Promise<string | undefined> {
	if (signal.aborted) return undefined;
	const deadline = AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT_MS)]);
	if (ctx.mode !== "tui") {
		// RPC clients own rendering. Keep each request small and require every page,
		// rather than assuming the client provides a scrollable long-title selector.
		const lines = new Text(message, 0, 0).render(60);
		const pages = Array.from({ length: Math.max(1, Math.ceil(lines.length / 8)) }, (_, i) => lines.slice(i * 8, i * 8 + 8).join("\n"));
		const expires = Date.now() + TIMEOUT_MS;
		for (let page = 0; !deadline.aborted;) {
			const last = page === pages.length - 1;
			const choices = ["Cancel", ...(page ? ["Previous page"] : []), last ? "Send to Pi" : "Next page"];
			const choice = await ctx.ui.select(`Browser annotation ${page + 1}/${pages.length}\n${WARNING}\n\n${pages[page]}`, choices, { signal: deadline, timeout: Math.max(1, expires - Date.now()) });
			if (deadline.aborted) return undefined;
			if (choice === "Next page" && !last) page++;
			else if (choice === "Previous page" && page) page--;
			else return last && choice === "Send to Pi" ? choice : undefined;
		}
		return undefined;
	}
	let cleanup = () => {};
	try {
		return await ctx.ui.custom<string | undefined>((tui, theme, keys, done) => {
			const abort = () => done(undefined);
			deadline.addEventListener("abort", abort, { once: true });
			cleanup = () => deadline.removeEventListener("abort", abort);
			const review = new AnnotationReview(message, () => tui.terminal, theme, keys, () => tui.requestRender(), done);
			return Object.assign(review, { dispose: cleanup });
		}, { overlay: true, overlayOptions: { width: "100%", margin: 1 } });
	} finally { cleanup(); }
}
