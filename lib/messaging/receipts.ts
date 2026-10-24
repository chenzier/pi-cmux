import { randomUUID } from "node:crypto";
import { open } from "node:fs/promises";
import { setImmediate as yieldTurn } from "node:timers/promises";
import { digest, endpoint, sameEndpoint, type Endpoint, type Envelope, type NativeMessage } from "./protocol.ts";

// Read-only compatibility with historical manual/wake records; never written now.
export const RECEIPT_ENTRY = "pi-cmux.message.receipt";
export const CONTEXT_ENTRY = "pi-cmux.message.context";
export const FOLLOWUP_INTENT = "pi-cmux.message.followup.intent";
export const FOLLOWUP_CONTEXT = "pi-cmux.message.followup";
export type Phase = "staged" | "received" | "wake_requested" | "turn_finished" | "replied" | "rejected" | "followup_intent";
export interface FollowupBatch { version: 1; owner: Endpoint; nonce: string; receipts: Receipt[] }
export interface History { getSessionId(): string; getSessionFile(): string | undefined; getEntries(): readonly unknown[] }
export interface Receipt { version: 1; owner: Endpoint; logicalId: string; nativeId: string; digest: string; requestId: string; phase: Phase; nonce: string; reason?: string }
const object = (v: unknown): Record<string, any> | undefined => v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, any> : undefined;

/** Reads only this session; never creates/rewrites files or treats an enqueue as durable. */
export async function persistedEntries(file: string, sessionId: string, expected: Map<string, string>, signal?: AbortSignal): Promise<void> {
 signal?.throwIfAborted();
 const handle = await open(file, "r");
 try {
  const stat = await handle.stat();
  if (!stat.isFile() || stat.size > 32 * 1024 * 1024) throw new Error("Session history exceeds durable-confirmation limit (32 MiB)");
  const buffer = Buffer.alloc(64 * 1024), decoder = new TextDecoder("utf-8", { fatal: true });
  let position = 0, pending = "", header = false, lines = 0;
  const found = new Set<string>(), deadline = Date.now() + 2500;
  while (position < stat.size) {
   signal?.throwIfAborted(); if (Date.now() > deadline) throw new Error("Session confirmation deadline exceeded");
   const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, stat.size - position), position);
   if (!bytesRead) throw new Error("Session changed during confirmation");
   position += bytesRead; pending += decoder.decode(buffer.subarray(0, bytesRead), { stream: true });
   let end: number;
   while ((end = pending.indexOf("\n")) >= 0) {
    const line = pending.slice(0, end); pending = pending.slice(end + 1);
    if (!line || Buffer.byteLength(line) > 1024 * 1024) throw new Error("Invalid/oversized session entry");
    const entry = object(JSON.parse(line));
    if (!header) { if (entry?.type !== "session" || entry.id !== sessionId) throw new Error("Session owner changed"); header = true; }
    else {
     if (!entry || entry.type === "session") throw new Error("Invalid session history");
     if (typeof entry.id === "string" && expected.has(entry.id)) {
      if (JSON.stringify(entry) !== expected.get(entry.id)) throw new Error("Session receipt differs from memory");
      found.add(entry.id);
     }
    }
    if (++lines % 64 === 0) { await yieldTurn(); signal?.throwIfAborted(); }
   }
   if (Buffer.byteLength(pending) > 1024 * 1024) throw new Error("Session entry exceeds confirmation bound");
  }
  pending += decoder.decode();
  if (pending || !header || [...expected.keys()].some(id => !found.has(id))) throw new Error("Receipt is not confirmed in persisted session history");
 } finally { await handle.close(); }
}

export class ReceiptLedger {
 readonly owner: Endpoint;
 private history: History;
 private append: (type: string, data: FollowupBatch) => void;
 private active: () => boolean;
 constructor(owner: Endpoint, history: History, append: (type: string, data: FollowupBatch) => void, active = () => true) {
  this.owner = endpoint(owner); this.history = history; this.append = append; this.active = active;
 }
 private guard() { if (!this.active() || this.history.getSessionId() !== this.owner.sessionId) throw new Error("Receipt belongs to an inactive conversation"); }
 private own(value: unknown): Receipt | undefined {
  const r = object(value);
  try { if (r?.version === 1 && sameEndpoint(endpoint(r.owner), this.owner) && typeof r.logicalId === "string" && typeof r.digest === "string" && typeof r.nonce === "string") return r as unknown as Receipt; } catch { /* foreign/malformed record */ }
 }
 private entries(): Array<Record<string, any>> { this.guard(); return this.history.getEntries().map(object).filter((e): e is Record<string, any> => Boolean(e)); }
 private receipts(e: Record<string, any>): Receipt[] {
  const direct = this.own(e.type === "custom_message" && e.customType === CONTEXT_ENTRY ? e.details : e.type === "custom" && e.customType === RECEIPT_ENTRY ? e.data : undefined);
  if (direct) return [direct];
  const batch = e.type === "custom_message" && e.customType === FOLLOWUP_CONTEXT ? e.details : e.type === "custom" && e.customType === FOLLOWUP_INTENT ? e.data : undefined;
  return batch?.version === 1 && Array.isArray(batch.receipts) && batch.receipts.length <= 16
   ? batch.receipts.map((r: unknown) => this.own(r)).filter((r: Receipt | undefined): r is Receipt => Boolean(r)) : [];
 }
 inspect(envelope: Envelope): "new" | "staged" | "reserved" | "inserted" | "rejected" | "conflict" {
  let status: "new" | "staged" | "reserved" | "inserted" | "rejected" = "new";
  for (const e of this.entries()) for (const receipt of this.receipts(e)) {
   if (receipt.logicalId !== envelope.id) continue;
   if (receipt.digest !== digest(envelope)) return "conflict";
   if (e.type === "custom_message" || ["received", "wake_requested", "turn_finished", "replied"].includes(receipt.phase)) status = "inserted";
   else if (receipt.phase === "followup_intent" && status !== "inserted") status = "reserved";
   else if (receipt.phase === "rejected" && !["inserted", "reserved"].includes(status)) status = "rejected";
   else if (receipt.phase === "staged" && status === "new") status = "staged";
  }
  return status;
 }
 /** Durable scheduling intent, NOT enqueue/context/processing confirmation. Never native ACK. */
 async reserveFollowup(items: Array<{ envelope: Envelope; message: NativeMessage }>, signal?: AbortSignal): Promise<FollowupBatch> {
  signal?.throwIfAborted(); this.guard();
  if (!items.length || items.length > 16 || new Set(items.map(r => r.envelope.id)).size !== items.length || items.some(r => this.inspect(r.envelope) !== "new" || !sameEndpoint(r.envelope.to, this.owner) || r.message.recipient_surface_id !== this.owner.surfaceId || r.message.sender_surface_id !== r.envelope.from.surfaceId)) throw new Error("Follow-up batch is not fresh or routing changed");
  const batch: FollowupBatch = { version: 1, owner: this.owner, nonce: randomUUID(), receipts: items.map(r => this.receipt(r.envelope, r.message)) };
  this.append(FOLLOWUP_INTENT, batch);
  const entry = this.entries().find(e => e.type === "custom" && e.customType === FOLLOWUP_INTENT && e.data?.nonce === batch.nonce);
  if (!entry) throw new Error("Pi did not append the follow-up intent");
  await this.confirm([entry], signal); return batch;
 }
 private receipt(envelope: Envelope, message: NativeMessage): Receipt {
  return { version: 1, owner: this.owner, logicalId: envelope.id, nativeId: message.id,
   digest: digest(envelope), requestId: envelope.requestId, phase: "followup_intent", nonce: randomUUID() };
 }
 async confirm(entries: Array<Record<string, any>>, signal?: AbortSignal): Promise<void> {
  this.guard(); const file = this.history.getSessionFile();
  if (!file) throw new Error("Messaging requires a persisted session");
  await persistedEntries(file, this.owner.sessionId, new Map(entries.map(e => [e.id, JSON.stringify(e)])), signal);
  signal?.throwIfAborted(); this.guard();
 }
}
