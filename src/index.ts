/**
 * Cloudflare Reliable Email Service — Worker entry point.
 * POST /accounts/{account_id}/email/sending/send: idempotency-key dedup
 * (Durable Object) → EMAIL binding send. CF REST API-compatible so the
 * official cloudflare-typescript SDK can target this Worker by overriding
 * baseURL. account_id is accepted but unused (EMAIL binding is
 * account-scoped at the infra level). Auth is handled by Cloudflare
 * ZeroTrust Access at the edge.
 */

import { Hono } from "hono";
import { DedupDO, type Env } from "./dedup-do";
import { createSendHandler, type SendBindings } from "./handler";

// Re-export so Wrangler discovers the DO class for migration.
export { DedupDO };
export type { Env };

const app = new Hono<{ Bindings: Env }>();

app.get("/health", (c) => c.json({ status: "ok" }));

app.post("/accounts/:account_id/email/sending/send", async (c) => {
  const handler = createSendHandler();
  // DO RPC methods aren't on the standard DurableObjectStub type —
  // cast is standard CF Workers practice for RPC calls on DO stubs.
  return handler(c.req.raw, c.env as unknown as SendBindings);
});

export default app;
