import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	buildShellCommand, buildContextualTabTitle, formatTabTitle, execCmux,
	openCommandInNewSplit, openCommandInNewTab,
	type CmuxCallerContext, type CommandOpenResult,
} from "../../extensions/cmux-core.ts";
import { getSshTargetRuntime, type DispatchTicket } from "./runtime.ts";
import { hasSshIntent } from "./launch.ts";
import { uuid } from "../orientation/state.ts";
import { shellQuote, sshArgv } from "./transport.ts";
import { parseSshTarget, type SshTarget } from "./target.ts";

export type TerminalTarget = "local" | "remote";
export interface HelperTerminalOptions {
	command: string;
	placement?: "right" | "down" | "tab";
	title?: string;
	focus?: boolean;
	target?: TerminalTarget;
}
export type HelperTerminalResult = CommandOpenResult & { target?: TerminalTarget; cwd?: string; destination?: string };

/** This is a LOCAL SSH client launched in a local PTY, never native auto-remote startup.
 * Remote PATH comes from the SSH account environment; no Mac PATH or local cwd crosses SSH. */
export function buildRemoteHelperCommand(target: SshTarget, command: string): string {
	parseSshTarget(target);
	const args = sshArgv(target, `exec /bin/sh -c ${shellQuote(command)}`);
	args[0] = "-tt";
	const env = ["PATH=/usr/bin:/bin:/usr/sbin:/sbin", "SSH_ASKPASS_REQUIRE=never"];
	for (const key of ["HOME", "USER", "LOGNAME", "SSH_AUTH_SOCK", "TMPDIR", "TERM"]) {
		if (process.env[key] !== undefined) env.push(`${key}=${process.env[key]}`);
	}
	return ["exec", "/usr/bin/env", "-i", ...env.map(shellQuote), "/usr/bin/ssh", ...args.map(shellQuote)].join(" ");
}

/** Unknown/missing/remote-owned workspace evidence is unsupported, not a request
 * to silently open another workspace or wrap an already remote surface in SSH. */
export async function assertLocalWorkspace(pi: ExtensionAPI, source: CmuxCallerContext): Promise<void> {
	const workspaceId = uuid(source.workspace_id);
	if (!workspaceId) throw new Error("Locality verification requires an exact workspace UUID");
	const response = await execCmux(pi, ["--json", "rpc", "workspace.list", "{}"]);
	if (!response.ok || response.stdout.length > 1_048_576) throw new Error("Cannot verify cmux workspace locality");
	let rows: unknown;
	try { rows = JSON.parse(response.stdout).workspaces; } catch { /* fail below */ }
	if (!Array.isArray(rows) || rows.length > 256) throw new Error("Cannot verify cmux workspace locality");
	const matches = rows.filter(row => row && typeof row === "object"
		&& (uuid(row.id) === workspaceId || uuid(row.workspace_id) === workspaceId));
	if (matches.length !== 1) throw new Error("cmux workspace association is stale or ambiguous");
	const remote = matches[0].remote;
	if (!remote || typeof remote !== "object" || remote.enabled !== false || remote.connected === true
		|| (remote.transport != null && remote.transport !== "local") || remote.backend != null) {
		throw new Error("Remote-owned or unverified cmux placement is unsupported; no local/SSH helper was launched");
	}
}

/** One common routing boundary for tool, slash and configured helper commands. */
export async function openHelperTerminal(pi: ExtensionAPI, ctx: Pick<ExtensionContext, "cwd"> & Partial<Pick<ExtensionContext, "sessionManager" | "signal">>,
	params: HelperTerminalOptions): Promise<HelperTerminalResult> {
	if (typeof params.command !== "string" || !params.command.trim() || params.command.includes("\0")) throw new Error("Specify a valid command to open");
	if (params.target !== undefined && params.target !== "local" && params.target !== "remote") throw new Error("Terminal target must be local or remote");
	if (params.placement !== undefined && !["right", "down", "tab"].includes(params.placement)) throw new Error("Invalid terminal placement");
	if (params.focus !== undefined && typeof params.focus !== "boolean") throw new Error("Invalid terminal focus");
	const command = params.command.trim(), placement = params.placement ?? "tab";
	const runtime = getSshTargetRuntime(pi);
	const target = params.target ?? (hasSshIntent(pi) ? "remote" : "local");
	let ticket: DispatchTicket | undefined;
	let stale = false;
	const unsubscribe = runtime?.subscribe(() => { stale = true; });
	const localCwd = ctx.cwd, sessionId = ctx.sessionManager?.getSessionId();
	const check = () => {
		ctx.signal?.throwIfAborted();
		if (getSshTargetRuntime(pi) !== runtime) throw new Error("Terminal runtime changed before dispatch");
		if (stale || ctx.cwd !== localCwd || ctx.sessionManager?.getSessionId() !== sessionId) throw new Error("Terminal target changed before dispatch");
		if (ticket) runtime!.assertDispatch(ticket);
	};
	try {
		if (target === "remote") {
			if (!runtime) throw new Error("No SSH target is bound");
			ticket = runtime.captureDispatch();
			if (ticket.context.localCwd !== localCwd || !sessionId || ticket.context.sessionId !== sessionId) throw new Error("SSH terminal context does not own the target");
			if (ticket.association) throw new Error("Associated remote-owned workspace placement is not validated; no helper was launched");
		}
		check();
		const cwd = ticket?.target.remoteCwd ?? localCwd;
		const startup = ticket ? buildRemoteHelperCommand(ticket.target, command) : buildShellCommand(localCwd, command);
		const title = ticket ? formatTabTitle(`${params.title ?? command} · ${ticket.target.destination}:${cwd}`, "SSH")
			: await buildContextualTabTitle(pi, localCwd, params.title ?? command, "Tool");
		check();
		const options = { tabTitle: title, focus: params.focus ?? true, localOnly: true, checkLaunch: check,
			beforeEffect: async (source: CmuxCallerContext) => { check(); await assertLocalWorkspace(pi, source); check(); } };
		const result = placement === "tab" ? await openCommandInNewTab(pi, startup, options)
			: await openCommandInNewSplit(pi, placement, startup, options);
		// A creation response is not command completion. A stale result is uncertain, not retryable.
		try { check(); } catch { throw new Error("Terminal creation outcome is uncertain after target change; command may have started. Do not retry automatically"); }
		return { ...result, target, cwd, ...(ticket ? { destination: ticket.target.destination } : {}) };
	} finally { unsubscribe?.(); }
}

/** Slash entrypoints expose explicit locality without requiring raw SSH commands. */
export function parseHelperArguments(args: string): { command: string; target?: TerminalTarget } {
	const match = /^\s*--(local|remote)(?:\s+|$)/.exec(args);
	return match ? { command: args.slice(match[0].length).trim(), target: match[1] as TerminalTarget } : { command: args.trim() };
}
