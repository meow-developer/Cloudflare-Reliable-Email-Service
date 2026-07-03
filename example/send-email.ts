/**
 * Example: Send email via the official Cloudflare TypeScript SDK,
 * targeting our cf-reliable-email-service Worker instead of api.cloudflare.com.
 *
 * The Cloudflare SDK (npm: `cloudflare`) is designed for the CF REST API at:
 *   POST https://api.cloudflare.com/client/v4/accounts/{id}/email/sending/send
 *
 * Our Worker exposes the same path, so the SDK works with just one override:
 *   baseURL -> our Worker URL (instead of api.cloudflare.com)
 *
 * Auth: The SDK sends an Authorization header. Our Worker is behind
 * ZeroTrust Access which handles auth at the edge -- the header value
 * is ignored. For local dev (wrangler dev), no auth is needed.
 *
 * Usage:
 *   npx tsx send-email.ts
 *   npx tsx send-email.ts --duplicate   # sends twice with same Idempotency-Key
 */

import { Cloudflare } from "cloudflare";

// ─── Configuration ───────────────────────────────────────────────

// Change this to your deployed Worker URL or http://localhost:8787 for local dev.
const WORKER_BASE_URL =
  process.env.WORKER_BASE_URL ?? "https://your-worker.workers.dev";

// The SDK requires an apiToken (used as Bearer auth). Our Worker ignores it
// (ZeroTrust handles auth at the edge), but the SDK needs a non-null value.
const API_TOKEN = process.env.CLOUDFLARE_API_TOKEN ?? "dummy-token-not-used";

// account_id is a required path param in the SDK. Our Worker accepts it but
// doesn't use it -- the EMAIL binding is account-scoped at the infra level.
const ACCOUNT_ID = process.env.CLOUDFLARE_ACCOUNT_ID ?? "local";

// ─── SDK client ─────────────────────────────────────────────────

const client = new Cloudflare({
  apiToken: API_TOKEN,
  baseURL: WORKER_BASE_URL,
  // Don't retry on our custom errors (e.g. 409 duplicate).
  maxRetries: 0,
});

// ─── Send an email ─────────────────────────────────────────────

async function sendEmail(idempotencyKey: string) {
  console.log(`\n📧 Sending email (Idempotency-Key: ${idempotencyKey})...`);
  console.log(`   Target: ${WORKER_BASE_URL}`);

  const response = await client.emailSending.send(
    {
      account_id: ACCOUNT_ID,
      from: "noreply@example.com",
      to: "recipient@example.com",
      subject: "Hello from cf-reliable-email-service",
      html: "<h1>Hello!</h1><p>This email was sent via the Cloudflare TypeScript SDK.</p>",
      text: "Hello! This email was sent via the Cloudflare TypeScript SDK.",
    },
    {
      // Our dedup feature requires an Idempotency-Key header. The SDK
      // passes custom headers via the options argument natively.
      headers: { "Idempotency-Key": idempotencyKey },
    },
  );

  console.log("   ✅ Success!");
  console.log("   Result:", JSON.stringify(response, null, 2));
  return response;
}

// ─── Demo: duplicate detection ─────────────────────────────────

async function demonstrateDuplicate() {
  const key = crypto.randomUUID();

  // First send -- succeeds
  await sendEmail(key);

  // Second send with same key -- should fail with code 19999
  console.log(`\n🔄 Sending again with the same Idempotency-Key...`);
  try {
    await sendEmail(key);
    console.error("   ❌ Expected a 409 duplicate error but got success!");
  } catch (err) {
    const error = err as { status?: number; error?: { errors?: Array<{ code: number; message: string }> } };
    console.log(`   ✅ Got expected error:`);
    console.log(`   HTTP ${error.status}`);
    console.log(`   Errors: ${JSON.stringify(error.error?.errors)}`);
  }
}

// ─── Main ──────────────────────────────────────────────────────

const args = process.argv.slice(2);

if (args.includes("--duplicate")) {
  await demonstrateDuplicate();
} else {
  await sendEmail(crypto.randomUUID());
}

console.log("\nDone.");
