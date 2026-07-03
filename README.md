# Cloudflare Reliable Email Service

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

Idempotent email delivery on Cloudflare Workers + Durable Objects. Adds an `Idempotency-Key` dedup layer on top of the Cloudflare Email Service — the request body is fully compatible with the [CF Email Sending REST API](https://developers.cloudflare.com/api/resources/email_sending/methods/send/).

## Background

[AWS SNS](https://docs.aws.amazon.com/sns/latest/dg/fifo-message-dedup.html) provides a `MessageDeduplicationId` for deduplication. Cloudflare does not. This project fills that gap.

**When do duplicate emails happen?** The email was already delivered, but the response was lost — typically a TCP FIN packet dropped during connection teardown. The client can't distinguish "server never got it" from "server got it but I missed the ACK," so it retries.

**Why is that a problem?**

- **Extra cost** — each redundant send consumes email provider quota and incurs per-message charges.
- **Degraded user experience** — a customer receiving the same order status update twice is confusing and erodes trust.

**Why not Cloudflare KV?** KV is eventually consistent for reads — a duplicate request hitting a different edge node could read a stale (or absent) key before the first write propagates. Durable Objects are single-threaded and single-context, guaranteeing strong consistency per key. Under the [PACELC](https://en.wikipedia.org/wiki/PACELC_theorem) principle, we sacrifice latency for consistency here.

## How It Works

```
Your Application
  │  POST /accounts/{account_id}/email/sending/send  +  Idempotency-Key: <unique-key>
  ▼
Cloudflare Worker
  ├── Durable Object (1 per key): first → mark + send, duplicate → 409
  └── Email delivery via CF Email Service (internal RPC)
```

## Quick Start

### Local Deploy

```bash
git clone https://github.com/meow-developer/cf-reliable-email-service.git
cd cf-reliable-email-service
npm install
npm run deploy   # wrangler deploy
```

### GitHub Pipeline Deploy

1. **Fork** the repo.
2. **Add repository secrets** — `CLOUDFLARE_API_TOKEN` (Workers Scripts: Edit) and `CLOUDFLARE_ACCOUNT_ID` under *Settings → Secrets and variables → Actions*.
3. **Uncomment** the `on: push` trigger and the "Deploy to Cloudflare Workers" step in [`.github/workflows/deploy.yml`](.github/workflows/deploy.yml).

Pushes to `main` will then run tests and deploy automatically.

## Configuration

All configuration is in `wrangler.toml`:

```toml
# Dedup key TTL in milliseconds (default: 300000 = 5 min)
[vars]
DEDUP_TTL_MS = "300000"
```

**Authentication (optional):** Handled at the Cloudflare edge by [ZeroTrust Access](https://developers.cloudflare.com/cloudflare-one/identity/) — zero auth code in the Worker. Create an Access Application + Service Token, then send `CF-Access-Client-Id` and `CF-Access-Client-Secret` headers.

## SDK Usage

This service is **fully compatible with the official [cloudflare-typescript](https://github.com/cloudflare/cloudflare-typescript) SDK** and the [CF Email Sending REST API](https://developers.cloudflare.com/api/resources/email_sending/methods/send/) — no wrapper library or adapter needed. Point the SDK at your Worker URL and pass the `Idempotency-Key` header via the standard `options` argument.

```ts
import { Cloudflare } from "cloudflare";

const client = new Cloudflare({
  apiToken: process.env.CLOUDFLARE_API_TOKEN,
  baseURL: "https://your-worker.workers.dev", // ← your Worker, not api.cloudflare.com
});

await client.emailSending.send(
  {
    account_id: "your-account-id",
    from: "noreply@example.com",
    to: "recipient@example.com",
    subject: "Hello from cf-reliable-email-service",
    html: "<h1>Hello!</h1>",
  },
  {
    headers: { "Idempotency-Key": crypto.randomUUID() }, // ← dedup key
  },
);
```

See [`example/`](example/) for a complete runnable demo, including duplicate detection.

## API

### `POST /accounts/{account_id}/email/sending/send`

The Cloudflare REST API path. Compatible with the official [cloudflare-typescript](https://github.com/cloudflare/cloudflare-typescript) SDK — point `baseURL` at your Worker and pass the `Idempotency-Key` header. The `account_id` path parameter is accepted but unused (the Email binding is account-scoped at the infra level).

| Header | Required | Description |
|--------|----------|-------------|
| `Idempotency-Key` | **Yes** | Unique key per logical request. Duplicate within TTL → `409`. |
| `Content-Type` | Yes | `application/json` |

**Body:** the full [CF Email Sending REST API](https://developers.cloudflare.com/api/resources/email_sending/methods/send/) payload — `from`, `to`, `cc`, `bcc`, `reply_to`, `subject`, `html`, `text`, `headers`, `attachments`. All fields pass through verbatim.

```bash
curl -X POST https://your-worker.workers.dev/accounts/$ACCOUNT_ID/email/sending/send \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: $(uuidgen)" \
  -d '{
    "from": "sender@example.com",
    "to": ["recipient@example.com"],
    "subject": "Monthly Report",
    "html": "<h1>Hello</h1>",
    "text": "Hello"
  }'
```

All responses follow the [Cloudflare API envelope](https://developers.cloudflare.com/fundamentals/api/):

| Status | Description |
|--------|-------------|
| `200` | Sent. `result` = `{ "delivered": [...], "message_id": "...", "permanent_bounces": [], "queued": [] }` |
| `409` | Duplicate `Idempotency-Key` within TTL. `errors[0].code = 19999` |
| `400` | Missing `Idempotency-Key` header or invalid body. `errors[0].code = 10001` |
| `500` | Email send failed. `errors[0].code = 10002` |

See [`example/`](example/) for a runnable demo using the official Cloudflare SDK.

### `GET /health`

Returns `{ "status": "ok" }`.

## License

[MIT](LICENSE)
