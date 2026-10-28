/**
 * Fixtures for the cmux pane switcher tests. Shapes mirror `cmux --json
 * --id-format both tree --all` and `cmux --json current --limit 200` on cmux
 * 0.65.2, reduced to the fields the adapter reads.
 */

export const ids = {
	window1: "11111111-1111-4111-8111-111111111111",
	window2: "22222222-2222-4222-8222-222222222222",
	ws1: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
	ws2: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
	ws3: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
	pane1: "d1111111-1111-4111-8111-111111111111",
	pane2: "d2222222-2222-4222-8222-222222222222",
	pane3: "d3333333-3333-4333-8333-333333333333",
	surfaceCaller: "e1111111-1111-4111-8111-111111111111",
	surfaceSibling: "e2222222-2222-4222-8222-222222222222",
	surfaceBrowser: "e3333333-3333-4333-8333-333333333333",
	surfaceOther: "e4444444-4444-4444-8444-444444444444",
};

function surface({ id, paneId, type, title, index, here = false, url = null }) {
	return {
		id,
		ref: `surface:${index}`,
		type,
		pane_id: paneId,
		index_in_pane: index,
		title,
		url,
		here,
		selected: here,
		focused: here,
		render_health: "rendering",
		tty: null,
	};
}

/** Two windows: caller workspace with two tabs plus a browser tab, and a second window. */
export function topologyFixture() {
	return {
		windows: [
			{
				id: ids.window1,
				index: 0,
				workspaces: [
					{
						id: ids.ws1,
						index: 0,
						title: "pi-cmux",
						panes: [
							{
								id: ids.pane1,
								index: 0,
								surfaces: [
									surface({ id: ids.surfaceCaller, paneId: ids.pane1, type: "terminal", title: "Pi · main", index: 0, here: true }),
									surface({ id: ids.surfaceSibling, paneId: ids.pane1, type: "terminal", title: "Pi · reviewer", index: 1 }),
									surface({ id: ids.surfaceBrowser, paneId: ids.pane1, type: "browser", title: "docs", index: 2, url: "https://example.test/docs" }),
								],
							},
						],
					},
					{
						id: ids.ws2,
						index: 1,
						title: "pi-cmux",
						panes: [
							{
								id: ids.pane2,
								index: 0,
								surfaces: [
									surface({ id: ids.surfaceOther, paneId: ids.pane2, type: "terminal", title: "zsh", index: 0 }),
								],
							},
						],
					},
				],
			},
			{
				id: ids.window2,
				index: 1,
				workspaces: [
					{
						id: ids.ws3,
						index: 0,
						title: "website",
						panes: [
							{
								id: ids.pane3,
								index: 0,
								surfaces: [
									surface({ id: "e5555555-5555-4555-8555-555555555555", paneId: ids.pane3, type: "terminal", title: "Pi · main", index: 0 }),
								],
							},
						],
					},
				],
			},
		],
	};
}

/** Agent labels: one attributed agent for the caller surface, none elsewhere. */
export function currentFixture(overrides = {}) {
	return {
		authority: "read_only_projection",
		items: [
			{
				kind: "terminal",
				label: "Pi · main",
				lifecycle: "running",
				freshness: { state: "current" },
				projections: [{ panel_id: ids.surfaceCaller }],
				agents: [{ kind: "pi", state: "working", session_id: "s1" }],
				...(overrides.caller ?? {}),
			},
		],
	};
}

/** Minimal fake Pi `exec` used by the adapter; records every cmux argv. */
export function fakePi(responses) {
	const calls = [];
	return {
		calls,
		exec: async (command, args, options) => {
			calls.push({ command, args: [...args], options });
			const verb = args.find((value) => value === "tree" || value === "current" || value === "rpc" || value === "identify") ?? "tree";
			const handler = responses[verb];
			const value = typeof handler === "function" ? await handler(args) : handler;
			if (!value) return { code: 1, stdout: "", stderr: `unexpected cmux call: ${args.join(" ")}`, killed: false };
			return { code: value.code ?? 0, stdout: value.stdout ?? "", stderr: value.stderr ?? "", killed: value.killed ?? false };
		},
	};
}

export function treeResponse(topology = topologyFixture()) {
	return { stdout: JSON.stringify(topology) };
}

export function currentResponse(current = currentFixture()) {
	return { stdout: JSON.stringify(current) };
}
