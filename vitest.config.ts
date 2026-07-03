import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

// Cloudflare Workers Vitest integration — runs tests inside the Workers
// runtime (workerd via Miniflare). Tests access real Durable Object
// bindings via `env` from "cloudflare:workers", and use helpers like
// runDurableObjectAlarm() / runInDurableObject() from "cloudflare:test".
// See: https://developers.cloudflare.com/workers/testing/vitest-integration/
export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.toml" },
    }),
  ],
});
