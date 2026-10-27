import { discoverSshConfig, concreteDestination, discoveryLimits } from "./config-discovery.ts";
import type { AliasCandidate, ConfigDiscoveryOptions, DiscoveryDiagnostic } from "./config-discovery.ts";

export interface ConnectionCandidate {
	readonly kind: "connection";
	readonly workspaceId: string;
	readonly destination: string;
	readonly backend?: "native-ssh" | "legacy-relay" | "tmux-mirror" | "cmux-tui";
	readonly enabled: true;
	readonly transport: "ssh";
	readonly connected: boolean;
}
export interface SshDiscoveryOptions extends ConfigDiscoveryOptions {
	discoverConfig?: boolean;
	discoverCmux?: boolean;
	/** Returns decoded workspace.list JSON only. Discovery never invokes cmux itself. */
	listWorkspaces?: () => unknown | Promise<unknown>;
}
export interface SshDiscoveryResult {
	readonly candidates: readonly (AliasCandidate | ConnectionCandidate)[];
	readonly diagnostics: readonly DiscoveryDiagnostic[];
	readonly partial: boolean;
}
function object(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("shape");
	const proto = Object.getPrototypeOf(value);
	if (proto !== Object.prototype && proto !== null) throw new Error("shape");
	return value as Record<string, unknown>;
}
function field(value: Record<string, unknown>, key: string): unknown {
	const descriptor = Object.getOwnPropertyDescriptor(value, key);
	if (descriptor && !("value" in descriptor)) throw new Error("shape");
	return descriptor?.value;
}
/** Suggestions only: no runtime registration, activation, readiness or execution. */
export async function discoverSshDestinations(options: SshDiscoveryOptions): Promise<SshDiscoveryResult> {
	const candidates: (AliasCandidate | ConnectionCandidate)[] = [];
	const diagnostics = new Set<DiscoveryDiagnostic>();
	const finish = (): SshDiscoveryResult => Object.freeze({ candidates: Object.freeze(candidates),
		diagnostics: Object.freeze([...diagnostics]), partial: diagnostics.size > 0 });
	if (options.enabled !== true) return finish();
	const limit = discoveryLimits(options.limits).candidates;
	if (options.discoverConfig !== false) {
		const config = await discoverSshConfig(options);
		candidates.push(...config.aliases);
		for (const diagnostic of config.diagnostics) diagnostics.add(diagnostic);
	}
	if (options.discoverCmux === false) return finish();
	let payload: unknown;
	try {
		if (!options.listWorkspaces) throw new Error("unavailable");
		payload = await options.listWorkspaces();
	} catch { diagnostics.add("cmux-unavailable"); return finish(); }
	try {
		const workspaces = field(object(payload), "workspaces");
		if (!Array.isArray(workspaces)) throw new Error("shape");
		if (workspaces.length > 256) diagnostics.add("workspace-limit");
		// Null permanently suppresses a conflicting workspace within this snapshot.
		const connections = new Map<string, ConnectionCandidate | null>();
		for (let i = 0; i < Math.min(workspaces.length, 256); i++) {
			let workspaceId: string | undefined;
			try {
				const item = Object.getOwnPropertyDescriptor(workspaces, String(i));
				if (!item || !("value" in item)) throw new Error("shape");
				const workspace = object(item.value), id = field(workspace, "id");
				if (typeof id === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) workspaceId = id.toLowerCase();
				const remote = object(field(workspace, "remote"));
				const enabled = field(remote, "enabled");
				if (enabled === false) {
					if (workspaceId) {
						if (connections.get(workspaceId)) diagnostics.add("cmux-malformed");
						connections.set(workspaceId, null);
					}
					continue;
				}
				if (enabled !== true) throw new Error("shape");
				const transport = field(remote, "transport");
				if (transport !== "ssh") throw new Error("shape");
				const destination = concreteDestination(field(remote, "destination"));
				const backend = field(remote, "backend"), connected = field(remote, "connected");
				if (!workspaceId || !destination || typeof connected !== "boolean"
					|| (backend !== undefined && backend !== "native-ssh" && backend !== "legacy-relay" && backend !== "tmux-mirror" && backend !== "cmux-tui")) throw new Error("shape");
				const previous = connections.get(workspaceId);
				if (previous === null) { diagnostics.add("cmux-malformed"); continue; }
				if (previous && (previous.destination !== destination || previous.backend !== backend || previous.connected !== connected)) {
					connections.set(workspaceId, null); diagnostics.add("cmux-malformed"); continue;
				}
				if (previous) continue;
				connections.set(workspaceId, Object.freeze({ kind: "connection", workspaceId, destination,
					...(backend !== undefined ? { backend } : {}), enabled: true, transport: "ssh", connected }));
			} catch {
				if (workspaceId) connections.set(workspaceId, null);
				diagnostics.add("cmux-malformed");
			}
		}
		for (const connection of connections.values()) {
			if (!connection) continue;
			if (candidates.length >= limit) { diagnostics.add("candidate-limit"); break; }
			candidates.push(connection);
		}
	} catch { diagnostics.add("cmux-malformed"); }
	return finish();
}
