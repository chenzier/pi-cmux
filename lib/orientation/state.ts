import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const ORIENTATION_ENTRY = "pi-cmux.orientation";
export const BOOTSTRAP_ENV = "PI_CMUX_ORIENTATION";
export const BINDING_TTL_MS = 20_000;
export type Role = "main" | "chat" | "review" | "continue";
export interface Target { windowId: string; workspaceId: string; paneId: string; surfaceId: string }
export interface Identity { taskId: string; conversationId: string; role: Role }
export interface Origin extends Identity { sessionId: string; target: Target }
export interface Bootstrap extends Identity { version: 1; topic: string; origin?: Origin }
export interface Orientation extends Bootstrap { sessionId: string }
export interface Binding extends Identity { version: 1; sessionId: string; token: string; pid: number; expiresAt: number }

export function uuid(value: unknown): string | undefined {
	return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value) ? value.toLowerCase() : undefined;
}
function object(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
function sessionId(value: unknown): value is string { return typeof value === "string" && value.length > 0 && value.length <= 128; }
export function topicText(value: string): string { return value.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").replace(/\s+/g, " ").trim().slice(0, 300); }
function identity(value: Record<string, unknown>): Identity | undefined {
	const taskId = uuid(value.taskId), conversationId = uuid(value.conversationId);
	return taskId && conversationId && ["main", "chat", "review", "continue"].includes(String(value.role))
		? { taskId, conversationId, role: value.role as Role } : undefined;
}
export function parseTarget(value: unknown): Target | undefined {
	const v = object(value);
	if (!v) return undefined;
	const windowId = uuid(v.windowId), workspaceId = uuid(v.workspaceId), paneId = uuid(v.paneId), surfaceId = uuid(v.surfaceId);
	return windowId && workspaceId && paneId && surfaceId ? { windowId, workspaceId, paneId, surfaceId } : undefined;
}
export function parseBootstrap(value: unknown): Bootstrap | undefined {
	const v = object(value);
	if (!v || v.version !== 1 || typeof v.topic !== "string" || v.topic.length > 300) return undefined;
	const ids = identity(v);
	if (!ids) return undefined;
	let origin: Origin | undefined;
	if (v.origin !== undefined) {
		const o = object(v.origin), target = parseTarget(o?.target), parent = o && identity(o);
		if (!o || !parent || !target || !sessionId(o.sessionId)) return undefined;
		origin = { ...parent, sessionId: o.sessionId, target };
	}
	return { version: 1, ...ids, topic: topicText(v.topic), ...(origin ? { origin } : {}) };
}
export function parseOrientation(value: unknown, owner: string): Orientation | undefined {
	const v = object(value), seed = parseBootstrap(value);
	return v?.sessionId === owner && seed ? { ...seed, sessionId: owner } : undefined;
}
// Wire v2: [2, taskId, conversationId, role, topic, origin | null].
// Origin: [taskId | null (same as child), conversationId, role, sessionId,
//          [windowId, workspaceId, paneId, surfaceId]]. Stored entries stay v1.
function parseCompactBootstrap(value: unknown[]): Bootstrap | undefined {
	if (value.length !== 6 || value[0] !== 2 || typeof value[3] !== "string") return undefined;
	const [, taskId, conversationId, role, topic, parent] = value;
	let origin: unknown;
	if (parent !== null) {
		if (!Array.isArray(parent) || parent.length !== 5 || typeof parent[2] !== "string") return undefined;
		const [parentTaskId, parentConversationId, parentRole, sessionId, target] = parent;
		if (!Array.isArray(target) || target.length !== 4) return undefined;
		origin = {
			taskId: parentTaskId === null ? taskId : parentTaskId, conversationId: parentConversationId, role: parentRole, sessionId,
			target: { windowId: target[0], workspaceId: target[1], paneId: target[2], surfaceId: target[3] },
		};
	}
	return parseBootstrap({ version: 1, taskId, conversationId, role, topic, ...(origin ? { origin } : {}) });
}
export function decodeBootstrap(raw: string): Bootstrap {
	if (raw.length > 8192 || !/^[A-Za-z0-9_-]+$/.test(raw)) throw new Error("Invalid cmux orientation bootstrap");
	let seed: Bootstrap | undefined;
	try {
		const value: unknown = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
		seed = Array.isArray(value) ? parseCompactBootstrap(value) : parseBootstrap(value);
	} catch { /* invalid data */ }
	if (!seed) throw new Error("Invalid cmux orientation bootstrap");
	return seed;
}
export function encodeBootstrap(seed: Bootstrap): string {
	const parsed = parseBootstrap(seed);
	if (!parsed || typeof parsed.role !== "string" || (parsed.origin && typeof parsed.origin.role !== "string")) throw new Error("Invalid cmux orientation bootstrap");
	const { taskId, conversationId, role, topic, origin } = parsed;
	const parent = origin ? [origin.taskId === taskId ? null : origin.taskId, origin.conversationId, origin.role, origin.sessionId,
		[origin.target.windowId, origin.target.workspaceId, origin.target.paneId, origin.target.surfaceId]] : null;
	return Buffer.from(JSON.stringify([2, taskId, conversationId, role, topic, parent])).toString("base64url");
}
export function rootOrientation(owner: string): Orientation {
	return { version: 1, sessionId: owner, taskId: randomUUID(), conversationId: randomUUID(), role: "main", topic: "Pi" };
}
export function childBootstrap(parent: Orientation, target: Target, related: boolean, role: Role, topic: string): Bootstrap {
	return {
		version: 1, taskId: related ? parent.taskId : randomUUID(), conversationId: randomUUID(), role, topic: topicText(topic),
		origin: { taskId: parent.taskId, conversationId: parent.conversationId, role: parent.role, sessionId: parent.sessionId, target },
	};
}
export function marker(value: Identity): string { return `T${value.taskId.slice(0, 8)}/${value.conversationId.slice(0, 8)} ${value.role}`; }
export function orientedTitle(value: Identity, topic: string): string {
	const legacyPrefix = `${marker(value)} · `;
	const suffix = ` · ${value.role} [${value.taskId.slice(0, 4)}]`;
	let clean = topicText(topic);
	while (clean.startsWith(legacyPrefix)) clean = clean.slice(legacyPrefix.length).trim();
	while (clean.endsWith(suffix)) clean = clean.slice(0, -suffix.length).trim();
	clean ||= "Pi";
	const room = 48 - suffix.length;
	return (clean.length <= room ? clean : `${clean.slice(0, room - 3).trimEnd()}...`) + suffix;
}

/** Local, expiring ownership evidence. Not an authorization boundary. */
export class BindingStore {
	readonly directory: string;
	constructor(directory: string) { this.directory = directory; }
	private path(surfaceId: string): string {
		const id = uuid(surfaceId);
		if (!id) throw new Error("Invalid cmux surface UUID");
		return join(this.directory, `${id}.json`);
	}
	write(surfaceId: string, binding: Binding): void {
		mkdirSync(this.directory, { recursive: true, mode: 0o700 });
		const path = this.path(surfaceId), tmp = `${path}.${randomUUID()}.tmp`;
		const data: Binding = { version: 1, taskId: binding.taskId, conversationId: binding.conversationId, role: binding.role,
			sessionId: binding.sessionId, token: binding.token, pid: binding.pid, expiresAt: binding.expiresAt };
		try { writeFileSync(tmp, JSON.stringify(data), { mode: 0o600, flag: "wx" }); renameSync(tmp, path); }
		finally { rmSync(tmp, { force: true }); }
	}
	read(surfaceId: string): Binding | undefined {
		try {
			const raw = readFileSync(this.path(surfaceId), "utf8");
			if (raw.length > 4096) return undefined;
			const v = object(JSON.parse(raw)), ids = v && identity(v);
			if (!v || !ids || v.version !== 1 || !sessionId(v.sessionId) || !uuid(v.token) || !Number.isSafeInteger(v.pid) || Number(v.pid) <= 0 || !Number.isSafeInteger(v.expiresAt)) return undefined;
			return { version: 1, ...ids, sessionId: v.sessionId, token: uuid(v.token)!, pid: Number(v.pid), expiresAt: Number(v.expiresAt) };
		} catch { return undefined; }
	}
	remove(surfaceId: string, token: string): void {
		if (this.read(surfaceId)?.token === token) rmSync(this.path(surfaceId), { force: true });
	}
}
export function liveBinding(binding: Binding | undefined, expected: Identity & { sessionId: string }, now = Date.now()): binding is Binding {
	if (!binding || binding.expiresAt <= now || binding.expiresAt > now + BINDING_TTL_MS + 1000 || binding.sessionId !== expected.sessionId
		|| binding.taskId !== expected.taskId || binding.conversationId !== expected.conversationId || binding.role !== expected.role) return false;
	try { process.kill(binding.pid, 0); return true; } catch { return false; }
}
