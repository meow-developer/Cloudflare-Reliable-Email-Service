import type { DedupDO } from "../src/dedup-do";

// Augment the global Cloudflare.Env so that `env` from "cloudflare:workers"
// (typed as Cloudflare.Env in @cloudflare/workers-types) exposes our bindings
// with full type safety — DEDUP has RPC-typed stubs, EMAIL is SendEmail.
declare global {
  namespace Cloudflare {
    interface Env {
      DEDUP: DurableObjectNamespace<DedupDO>;
      EMAIL: SendEmail;
      DEDUP_TTL_MS?: string;
    }
  }
}
