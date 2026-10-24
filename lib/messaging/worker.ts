import type { MessageClient } from "./client.ts";
import type { NativeMessage } from "./protocol.ts";

export interface ReceiverOptions {
 client: Pick<MessageClient, "list">;
 current(): boolean;
 queued(count: number): void;
 reconcile?(messages: NativeMessage[], signal: AbortSignal): Promise<void>;
 diagnostic(message: string): void;
 intervalMs?: number;
 setTimer?: (callback: () => void, delay: number) => ReturnType<typeof setTimeout>;
 clearTimer?: (timer: ReturnType<typeof setTimeout>) => void;
}

/** Never awaited by a Pi lifecycle handler or a model tool waiting for a peer. */
export class ReceiverWorker {
 private options: ReceiverOptions;
 private controller = new AbortController();
 private timer: ReturnType<typeof setTimeout> | undefined;
 private running: Promise<void> | undefined;
 private stopped = true;
 private started = false;
 private hinted = false;
 private backoff = 0;
 constructor(options: ReceiverOptions) { this.options = options; }
 private current(): boolean { return !this.stopped && !this.controller.signal.aborted && this.options.current(); }
 start(): void {
  if (this.started) return;
  this.started = true;
  this.stopped = false; this.controller = new AbortController(); this.backoff = 0;
  void this.tick();
 }
 stop(): void {
  this.stopped = true; this.controller.abort(); this.clearTimer();
 }
 private clearTimer() { if (this.timer !== undefined) (this.options.clearTimer ?? clearTimeout)(this.timer); this.timer = undefined; }
 private schedule(delay: number) {
  if (!this.current()) return;
  this.clearTimer();
  const callback = () => { this.timer = undefined; void this.tick(); };
  this.timer = this.options.setTimer ? this.options.setTimer(callback, delay) : setTimeout(callback, delay);
  this.timer?.unref?.();
 }
 kick(): void { if (!this.current() || this.hinted) return; this.hinted = true; if (!this.running) this.schedule(250); }
 tick(): Promise<void> {
  if (this.running) { this.hinted = true; return this.running; }
  this.clearTimer();
  if (!this.current()) { this.stop(); return Promise.resolve(); }
  const signal = this.controller.signal;
  this.running = this.check(signal).catch(error => {
   if (!this.current()) return;
   const message = error instanceof Error ? error.message : "Messaging request failed";
   this.backoff = Math.min(this.backoff ? this.backoff * 2 : 2000, 30_000);
   this.options.diagnostic(message);
  }).finally(() => {
   this.running = undefined;
   if (!this.current()) { this.stop(); return; }
   const delay = this.backoff || (this.hinted ? 250 : (this.options.intervalMs ?? 2000));
   this.hinted = false; this.schedule(delay);
  });
  return this.running;
 }
 private async check(signal: AbortSignal) {
  const messages = await this.options.client.list(signal); if (!this.current()) return;
  this.options.queued(messages.filter(m => m.state === "queued").length);
  await this.options.reconcile?.(messages, signal); if (!this.current()) return;
  this.backoff = 0;
 }
}
