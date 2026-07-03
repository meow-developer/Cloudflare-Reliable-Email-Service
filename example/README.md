# Example: Cloudflare SDK Integration

This example demonstrates how to use the official [Cloudflare TypeScript SDK](https://github.com/cloudflare/cloudflare-typescript) (`npm: cloudflare`) to send emails through **cf-reliable-email-service** instead of `api.cloudflare.com`.

## How it works

The Cloudflare SDK is designed for the CF REST API endpoint:

```
POST https://api.cloudflare.com/client/v4/accounts/{account_id}/email/sending/send
```

Our Worker exposes the same path (`/accounts/:account_id/email/sending/send`), so the SDK works with a single override:

1. **`baseURL`** — point at our Worker instead of `api.cloudflare.com`

## Quick start

```bash
cd example
npm install

# Send a single email
npm run send

# Demonstrate duplicate detection (sends twice with same Idempotency-Key)
npm run send:duplicate
```

## Configuration

| Environment Variable | Default | Description |
|---|---|---|
| `WORKER_BASE_URL` | `https://your-worker.workers.dev` | Worker URL |
| `CLOUDFLARE_API_TOKEN` | `dummy-token-not-used` | Ignored by Worker (ZeroTrust handles auth) |
| `CLOUDFLARE_ACCOUNT_ID` | `local` | Path param, accepted but unused by Worker |

For local development:

```bash
WORKER_BASE_URL=http://localhost:8787 npm run send
```

## SDK code pattern

```typescript
import { Cloudflare } from "cloudflare";

const client = new Cloudflare({
  apiToken: "any-value",           // Worker ignores this (ZeroTrust auth)
  baseURL: "https://your-worker.workers.dev",  // Override base URL
  maxRetries: 0,                   // Don't retry on 409 duplicate
});

const result = await client.emailSending.send(
  {
    account_id: "local",
    from: "noreply@example.com",
    to: "recipient@example.com",
    subject: "Hello",
    html: "<p>Hello!</p>",
  },
  {
    headers: { "Idempotency-Key": crypto.randomUUID() },
  },
);

console.log(result.delivered);      // ["recipient@example.com"]
console.log(result.message_id);     // "<abc123@workers.email>"
```

## Error handling

Duplicate requests return HTTP 409 with error code `19999`:

```json
{
  "success": false,
  "errors": [
    { "code": 19999, "message": "email.sending.error.duplicate_request" }
  ],
  "result": null
}
```

The SDK throws on non-2xx responses. Catch the error to inspect the code:

```typescript
try {
  await client.emailSending.send(params, { headers });
} catch (err) {
  if (err.status === 409) {
    console.log("Duplicate request detected");
  }
}
```
