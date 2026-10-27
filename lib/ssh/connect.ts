import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { t } from "../../extensions/i18n.ts";
import type { SshExecutionAdapter, SshValidationProbe } from "./adapter.ts";
import { parseSshTarget, type SshTarget } from "./target.ts";
import { SshTransportError } from "./transport.ts";

export const SSH_CONNECT_GUIDANCE = `SSH is opt-in, local-agent execution only. Connect only for the current explicit user request. Use ssh_connect with a concrete destination and absolute remoteCwd; never construct SSH commands. A complete request needs no picker, redundant question or yes/no gate. Ask only one missing or ambiguous field at a time. Discovered aliases are suggestions, never a selection; accept a manual destination. Never infer host, directory, workspace, backend or mode. Existing aliases need no save prompt. Optional ssh_alias_save is separate: its trusted UI shows the exact addition and asks yes/no; declining does not block a requested one-off connection. Never request passwords, private keys or passphrases in chat. Authentication setup happens outside chat; do not automatically create keys. Cancellation/unanswered questions do not connect or save.`;
export const SSH_AUTH_GUIDANCE = "SSH connection/authentication failed. Configure and verify authentication and host trust outside chat, then explicitly request connection again. Do not paste passwords, private keys or key passphrases here. No key setup or automatic retry was attempted.";

/** Reject extras BEFORE the target parser (which intentionally discards extras for restoration). */
export function strictFields(value: unknown, allowed: readonly string[]): Record<string, unknown> {
	const fail = () => { throw new Error("Invalid SSH action parameters"); };
	if (!value || typeof value !== "object" || Array.isArray(value)) return fail();
	const proto = Object.getPrototypeOf(value);
	if (proto !== Object.prototype && proto !== null) return fail();
	const out: Record<string, unknown> = Object.create(null);
	for (const key of Reflect.ownKeys(value)) {
		if (typeof key !== "string" || !allowed.includes(key)) return fail();
		const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
		if (!("value" in descriptor)) return fail();
		out[key] = descriptor.value;
	}
	return out;
}
export function validateConnect(value: unknown): SshTarget {
	return parseSshTarget(strictFields(value, ["destination", "remoteCwd"]));
}
export type ConversationDecision =
	| { kind: "question"; field: "destination" | "remoteCwd"; question: string; suggestions?: readonly string[] }
	| { kind: "connect"; target: SshTarget }
	| { kind: "cancelled" };
/** Pure supplied-field helper, not a natural-language parser or authority/consent mechanism.
 * Candidates represent an unresolved user reference; even one candidate is not selected. */
export function decideSshConversation(input: {
	destination?: string; remoteCwd?: string; ambiguousHostCandidates?: readonly string[]; cancelled?: boolean;
}): ConversationDecision {
	if (input.cancelled) return { kind: "cancelled" };
	const candidates = [...new Set(input.ambiguousHostCandidates ?? [])].slice(0, 20)
		.filter(destination => { try { validateConnect({ destination, remoteCwd: "/" }); return true; } catch { return false; } });
	if (!input.destination || candidates.length) return {
		kind: "question", field: "destination", question: candidates.length
			? t("ssh.question.ambiguous") : t("ssh.question.host"),
		...(candidates.length ? { suggestions: candidates } : {}),
	};
	// Validate a supplied host even before asking for the other field.
	validateConnect({ destination: input.destination, remoteCwd: "/" });
	if (!input.remoteCwd) return { kind: "question", field: "remoteCwd", question: t("ssh.question.path") };
	return { kind: "connect", target: validateConnect({ destination: input.destination, remoteCwd: input.remoteCwd }) };
}

export type SshAction = "connect" | "alias-save";
export type SshActionLease = (() => void) & { readonly signal?: AbortSignal };
export interface SshActionAuthority {
	/** Trusted integration callback: verify this exact action/parameters against the CURRENT
	 * user request. Never implement using model booleans, discovery, restored state or UI history.
	 * Synchronous and side-effect-free; absent/anything other than true fails closed. */
	readonly currentRequest: (ctx: ExtensionContext, action: SshAction, parameters: Readonly<object>) => boolean;
	/** Optional one-action lease. Finish burns this request, not a later input grant. */
	readonly begin?: (ctx: ExtensionContext, action: SshAction, parameters: Readonly<object>) => SshActionLease;
}
export function assertSshAction(adapter: SshExecutionAdapter, authority: SshActionAuthority,
	ctx: ExtensionContext, action: SshAction, parameters: Readonly<object>, signal?: AbortSignal): void {
	const snapshot = adapter.runtime.snapshot();
	if (signal?.aborted || ctx.signal?.aborted) throw new Error("SSH action cancelled");
	if (!snapshot.enabled || snapshot.state === "disabled") throw new Error("SSH integration is disabled");
	if (!snapshot.context || snapshot.context.localCwd !== ctx.cwd || snapshot.context.sessionId !== ctx.sessionManager.getSessionId()) {
		throw new Error("SSH action context does not own this runtime");
	}
	// Model-issued tools run while Pi is busy; sequential tool dispatch plus the
	// action-local busy guard serialize this workflow. isIdle() is command-only gating.
	if (authority.currentRequest(ctx, action, parameters) !== true) throw new Error("SSH action requires an explicit current user request");
}
export function createSshConnector(adapter: SshExecutionAdapter, authority: SshActionAuthority) {
	let busy = false;
	return async (value: unknown, ctx: ExtensionContext, signal?: AbortSignal): Promise<string> => {
		const target = validateConnect(value);
		const guard = () => assertSshAction(adapter, authority, ctx, "connect", target, signal);
		guard();
		if (busy) throw new Error("An SSH connection action is already in progress");
		const finish = authority.begin?.(ctx, "connect", target);
		busy = true;
		let probe: SshValidationProbe | undefined;
		try {
			// No awaits, discovery, picker, UI or connection mode selection before activation.
			adapter.runtime.activate(target);
			guard();
			const selected = adapter.runtime.snapshot();
			if (selected.target?.destination !== target.destination || selected.target?.remoteCwd !== target.remoteCwd || selected.association) {
				throw new Error("SSH selection changed");
			}
			const actionSignal = AbortSignal.any([...(signal ? [signal] : []), ...(ctx.signal ? [ctx.signal] : []), ...(finish?.signal ? [finish.signal] : [])]);
			probe = await adapter.probeValidation(actionSignal, guard);
			// No await follows this authority check + scoped readiness commit.
			probe.commit(guard);
			return "SSH execution ready; Pi and session storage remain local.";
		} catch (error) {
			if (error instanceof SshTransportError && error.kind === "connection") throw new Error(SSH_AUTH_GUIDANCE);
			// Do not echo arbitrary transport errors/output, which may contain sensitive text.
			throw new Error("SSH connection did not complete; no automatic retry. Check local setup outside chat or explicitly request connection again.");
		} finally { probe?.discard(); busy = false; finish?.(); }
	};
}
const registered = new WeakSet<ExtensionAPI>();
/** Registration alone is inert; the bundle supplies the SAME core-routing adapter
 * and source-checked current-request authority. */
export function registerSshConnect(pi: ExtensionAPI, adapter: SshExecutionAdapter, authority: SshActionAuthority): void {
	if (registered.has(pi)) return;
	registered.add(pi);
	const connect = createSshConnector(adapter, authority);
	pi.registerTool({
		name: "ssh_connect", label: "Connect SSH", description: SSH_CONNECT_GUIDANCE,
		parameters: { type: "object", required: ["destination", "remoteCwd"], additionalProperties: false,
			properties: { destination: { type: "string" }, remoteCwd: { type: "string" } } } as any,
		executionMode: "sequential",
		async execute(_id, parameters, signal, _onUpdate, ctx) {
			const text = await connect(parameters, ctx, signal);
			return { content: [{ type: "text", text }], details: {} };
		},
	});
}
