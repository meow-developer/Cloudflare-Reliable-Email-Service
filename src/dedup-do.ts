/**
 * DedupDO — per-idempotency-key Durable Object for deduplication.
 *
 * One DO instance per key (via idFromName); single-threaded per instance
 * gives a race-free check-and-mark. TTL via alarm: on fire, the DO clears
 * storage and hibernates. The DO only makes the go/no-go decision — it
 * does not send the email.
 *
 * No blockConcurrencyWhile(): the check-and-mark (get → put → setAlarm) is
 * safe under the DO input gate, which blocks new events while storage ops
 * are in flight (same pattern as CF's Counter.increment() example). Omitting
 * the wrapper raises per-instance throughput from ~200 to ~1000 req/sec.
 */

import { DurableObject } from "cloudflare:workers";

export interface Env {
  DEDUP: DurableObjectNamespace<DedupDO>;
  EMAIL: SendEmail;
  /** Dedup key TTL in ms. Default 300000 (5 min), via wrangler.toml [vars]. */
  DEDUP_TTL_MS?: string;
}

const DEFAULT_DEDUP_TTL_MS = 5 * 60 * 1000;

export interface DedupResult {
  action: "send" | "skip";
}

export class DedupDO extends DurableObject<Env> {
  private get dedupTtlMs(): number {
    return this.env.DEDUP_TTL_MS
      ? parseInt(this.env.DEDUP_TTL_MS, 10)
      : DEFAULT_DEDUP_TTL_MS;
  }

  /** Race-free check-and-mark: "send" if first seen, "skip" if duplicate. */
  async trySend(idempotencyKey: string): Promise<DedupResult> {
    const existing = await this.ctx.storage.get(idempotencyKey);
    if (existing !== undefined && existing !== null) {
      return { action: "skip" };
    }
    await this.ctx.storage.put(idempotencyKey, { ts: Date.now() });
    await this.ctx.storage.setAlarm(Date.now() + this.dedupTtlMs);
    return { action: "send" };
  }

  /** Alarm: clear storage on TTL expiry, then the DO hibernates. */
  async alarm(): Promise<void> {
    await this.ctx.storage.deleteAll();
  }
}

export const DEFAULT_TTL_MS = DEFAULT_DEDUP_TTL_MS;
