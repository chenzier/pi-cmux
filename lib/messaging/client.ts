import { spawn } from "node:child_process";
import { incoming, nativeMessage, record, decodeEnvelope, sameEndpoint, type Envelope, type NativeMessage } from "./protocol.ts";
import { uuid } from "../orientation/state.ts";

export interface ExecResult { code: number; stdout: string; stderr: string; uncertain?: boolean }
export type Execute = (args: string[], signal?: AbortSignal) => Promise<ExecResult>;
export class TransportError extends Error {
 readonly uncertain: boolean;
 constructor(message: string, uncertain = false) { super(message); this.uncertain = uncertain; }
}
export const METHODS = ["send", "list", "settings"].map(s => `agent.message.${s}`);
/** No shell, bounded buffers/deadline, and no abandoned stream after cancellation. */
export const execute: Execute = (args, signal) => new Promise((resolve, reject) => {
 if (signal?.aborted) { reject(new TransportError("Request cancelled before dispatch")); return; }
 const child = spawn("cmux", args, { stdio: ["ignore", "pipe", "pipe"] });
 const output: Buffer[] = [], errors: Buffer[] = [];
 let bytes = 0, settled = false, stopped: string | undefined;
 const stop = (why: string) => { stopped ??= why; child.kill("SIGKILL"); };
 const abort = () => stop("Request cancelled; outcome unknown");
 const timer = setTimeout(() => stop("cmux request deadline exceeded; outcome unknown"), 2500); timer.unref();
 signal?.addEventListener("abort", abort, { once: true });
 const finish = (error?: Error, code = 1) => {
  if (settled) return; settled = true; clearTimeout(timer); signal?.removeEventListener("abort", abort);
  if (error) reject(error); else resolve({ code, stdout: Buffer.concat(output).toString("utf8"), stderr: Buffer.concat(errors).toString("utf8"), uncertain: Boolean(stopped) });
 };
 const data = (chunks: Buffer[]) => (chunk: Buffer) => { bytes += chunk.length; if (bytes > 2 * 1024 * 1024) stop("cmux response exceeds 2 MiB; outcome unknown"); else chunks.push(chunk); };
 child.stdout.on("data", data(output)); child.stderr.on("data", data(errors));
 child.on("error", e => finish(new TransportError(`Cannot start cmux: ${e.message}`)));
 child.on("close", code => stopped ? finish(new TransportError(stopped, true)) : finish(undefined, code ?? 1));
});

export class MessageClient {
 private capabilities: Promise<void> | undefined;
 readonly surfaceId: string;
 private exec: Execute;
 constructor(surfaceId: string, exec: Execute = execute) {
  const id = uuid(surfaceId); if (!id) throw new Error("Messaging requires a full surface UUID");
  this.surfaceId = id; this.exec = exec;
 }
 async ready(signal?: AbortSignal): Promise<void> {
  if (!this.capabilities) {
   this.capabilities = (async () => {
    const r = await this.exec(["--json", "capabilities"], signal);
    if (r.code !== 0) throw new TransportError("Cannot inspect cmux messaging capabilities");
    const methods = record(JSON.parse(r.stdout)).methods;
    if (!Array.isArray(methods) || METHODS.some(m => !methods.includes(m))) throw new TransportError("cmux agent messaging API is unavailable");
   })();
   this.capabilities.catch(() => { this.capabilities = undefined; });
  }
  return this.capabilities;
 }
 private async rpc(method: "send" | "list" | "settings", params: Record<string, unknown>, signal?: AbortSignal): Promise<Record<string, unknown>> {
  await this.ready(signal);
  signal?.throwIfAborted();
  const r = await this.exec(["--json", "--id-format", "both", "rpc", `agent.message.${method}`, JSON.stringify(params)], signal);
  if (r.code !== 0) throw new TransportError(`cmux ${method} rejected or failed (exit ${r.code})`, Boolean(r.uncertain) || method === "send");
  let result: Record<string, unknown>;
  try { result = record(JSON.parse(r.stdout)); } catch { throw new TransportError(`Malformed cmux ${method} response`, method === "send"); }
  if (result.error) throw new TransportError(`cmux ${method} returned an error`, method === "send");
  return result;
 }
 async send(envelope: Envelope, signal?: AbortSignal, replyTo?: string): Promise<NativeMessage> {
  envelope = decodeEnvelope(JSON.stringify(envelope));
  if (envelope.from.surfaceId !== this.surfaceId) throw new Error("Sender surface does not belong to this client");
  if (replyTo) {
   const parent = (await this.list(signal)).find(m => m.id === replyTo);
   if (!parent || parent.sender_surface_id !== envelope.to.surfaceId) throw new Error("Reply address does not match the intended peer");
   const original = decodeEnvelope(parent.body);
   if (!sameEndpoint(original.from, envelope.to) || !sameEndpoint(original.to, envelope.from) || original.requestId !== envelope.requestId) throw new Error("Reply belongs to another conversation/request");
  }
  const result = await this.rpc("send", {
   target: envelope.to.surfaceId, ...(replyTo ? { reply_to: replyTo } : {}), body: JSON.stringify(envelope),
   sender_surface_id: envelope.from.surfaceId, ...(!replyTo ? { thread_id: envelope.id } : {}), from: "Pi peer",
  }, signal);
  try {
   const message = nativeMessage(result);
   if (message.recipient_surface_id !== envelope.to.surfaceId || message.sender_surface_id !== envelope.from.surfaceId || message.body !== JSON.stringify(envelope)) throw new Error("Target/body mismatch");
   return message;
  } catch { throw new TransportError("cmux send response did not confirm the message; outcome unknown", true); }
 }
 async list(signal?: AbortSignal): Promise<NativeMessage[]> {
  const r = await this.rpc("list", { surface: this.surfaceId, limit: 1000 }, signal);
  return incoming(r.messages, this.surfaceId);
 }
 async settings(signal?: AbortSignal): Promise<boolean> {
  const r = await this.rpc("settings", { surface_id: this.surfaceId }, signal);
  if (uuid(r.id) !== this.surfaceId || r.scope !== "surface" || typeof r.receiving !== "boolean" || typeof r.messages_enabled !== "boolean" || typeof r.workspace_receiving !== "boolean") throw new TransportError("Malformed cmux receiving settings");
  return r.receiving && r.messages_enabled && r.workspace_receiving;
 }
}
