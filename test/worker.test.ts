import { env } from "cloudflare:workers";
import { describe, it, expect } from "vitest";

import {
  createSendHandler,
  toEmailMessageBuilder,
  validateBody,
  remapAddress,
  extractRecipients,
  ERRORS,
  type SendBindings,
} from "../src/handler";

// ─── CF REST API compatible payload (from the official docs example) ──
const CF_REST_BODY = {
  from: "sender@example.com",
  subject: "Monthly Report",
  to: ["recipient@example.com"],
  cc: ["recipient-a@example.com", { address: "recipient-b@example.com", name: "Recipient B" }],
  bcc: ["secret@example.com"],
  reply_to: { address: "reply@example.com", name: "Replies" },
  headers: { "X-Custom-Header": "value" },
  html: "<h1>Hello</h1><p>Please find your report attached.</p>",
  text: "Hello\n\nPlease find your report attached.",
};

const MINIMAL_BODY = {
  from: "noreply@example.com",
  to: "user@example.com",
  subject: "Hello World",
  html: "<p>This is a test.</p>",
};

function makeRequest(
  body: unknown,
  opts?: { idempotencyKey?: string | null },
): Request {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  const key = opts?.idempotencyKey;
  if (key !== null) {
    headers["Idempotency-Key"] = key ?? "9c7d2b4a-0e1f-6c83-5a2d-1b0f4e3c5a7d";
  }
  return new Request("http://localhost/accounts/local/email/sending/send", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

async function jsonBody(resp: Response): Promise<Record<string, unknown>> {
  return (await resp.json()) as unknown as Record<string, unknown>;
}

// ─── Pure-logic unit tests (no bindings needed) ──────────────
describe("toEmailMessageBuilder — REST API → Workers binding remapping", () => {
  it("remaps { address, name } → { email, name } for address objects", () => {
    const builder = toEmailMessageBuilder(CF_REST_BODY) as unknown as Record<string, unknown>;
    const cc = builder.cc as unknown[];
    const ccObj = cc[1] as unknown as Record<string, unknown>;
    expect(ccObj.email).toBe("recipient-b@example.com");
    expect(ccObj.name).toBe("Recipient B");
    expect(ccObj.address).toBeUndefined();
  });

  it("remaps reply_to → replyTo with { address } → { email }", () => {
    const builder = toEmailMessageBuilder(CF_REST_BODY) as unknown as Record<string, unknown>;
    const replyTo = builder.replyTo as unknown as Record<string, unknown>;
    expect(replyTo.email).toBe("reply@example.com");
    expect(replyTo.name).toBe("Replies");
    expect(builder.reply_to).toBeUndefined();
  });

  it("passes through string-form addresses unchanged", () => {
    const builder = toEmailMessageBuilder(MINIMAL_BODY) as unknown as Record<string, unknown>;
    expect(builder.from).toBe("noreply@example.com");
    expect(builder.to).toBe("user@example.com");
  });

  it("remaps from when given as { address, name }", () => {
    const body = { ...MINIMAL_BODY, from: { address: "noreply@example.com", name: "No Reply" } };
    const builder = toEmailMessageBuilder(body) as unknown as Record<string, unknown>;
    const from = builder.from as unknown as Record<string, unknown>;
    expect(from.email).toBe("noreply@example.com");
    expect(from.name).toBe("No Reply");
    expect(from.address).toBeUndefined();
  });

  it("handles mixed string + object arrays for 'to'", () => {
    const body = {
      ...MINIMAL_BODY,
      to: ["a@example.com", { address: "b@example.com", name: "Bee" }],
    };
    const builder = toEmailMessageBuilder(body) as unknown as Record<string, unknown>;
    const to = builder.to as unknown[];
    expect(to[0]).toBe("a@example.com");
    const toObj = to[1] as unknown as Record<string, unknown>;
    expect(toObj.email).toBe("b@example.com");
    expect(toObj.name).toBe("Bee");
    expect(toObj.address).toBeUndefined();
  });

  it("passes through non-address fields (subject, html, text, headers, attachments)", () => {
    const builder = toEmailMessageBuilder(CF_REST_BODY) as unknown as Record<string, unknown>;
    expect(builder.subject).toBe(CF_REST_BODY.subject);
    expect(builder.html).toBe(CF_REST_BODY.html);
    expect(builder.text).toBe(CF_REST_BODY.text);
    expect(builder.headers).toEqual({ "X-Custom-Header": "value" });
  });
});

describe("remapAddress — single address transformation", () => {
  it("passes through strings unchanged", () => {
    expect(remapAddress("user@example.com")).toBe("user@example.com");
  });

  it("transforms { address } → { email }", () => {
    const result = remapAddress({ address: "x@example.com" }) as unknown as Record<string, unknown>;
    expect(result.email).toBe("x@example.com");
    expect(result.address).toBeUndefined();
  });

  it("preserves name when present", () => {
    const result = remapAddress({ address: "x@example.com", name: "X" }) as unknown as Record<string, unknown>;
    expect(result.email).toBe("x@example.com");
    expect(result.name).toBe("X");
  });

  it("returns null/undefined/numbers unchanged", () => {
    expect(remapAddress(null)).toBeNull();
    expect(remapAddress(undefined)).toBeUndefined();
    expect(remapAddress(42)).toBe(42);
  });
});

describe("validateBody", () => {
  it("accepts a minimal valid body (from + subject + html)", () => {
    expect(validateBody(MINIMAL_BODY)).toBe(true);
  });

  it("accepts text instead of html", () => {
    expect(validateBody({ from: "a@b.com", subject: "S", text: "hello" })).toBe(true);
  });

  it("rejects missing from", () => {
    const { from, ...bad } = MINIMAL_BODY;
    expect(validateBody(bad)).toBe(false);
  });

  it("rejects missing subject", () => {
    const { subject, ...bad } = MINIMAL_BODY;
    expect(validateBody(bad)).toBe(false);
  });

  it("rejects when neither html nor text present", () => {
    const { html, ...bad } = MINIMAL_BODY;
    expect(validateBody(bad)).toBe(false);
  });

  it("rejects non-object input", () => {
    expect(validateBody(null)).toBe(false);
    expect(validateBody("string")).toBe(false);
    expect(validateBody(undefined)).toBe(false);
  });
});

describe("extractRecipients — collect all to/cc/bcc addresses", () => {
  it("extracts string and object addresses from to/cc/bcc", () => {
    const recipients = extractRecipients(CF_REST_BODY as Record<string, unknown>);
    expect(recipients).toEqual([
      "recipient@example.com",
      "recipient-a@example.com",
      "recipient-b@example.com",
      "secret@example.com",
    ]);
  });

  it("handles single-string 'to' (not array)", () => {
    const recipients = extractRecipients(MINIMAL_BODY as Record<string, unknown>);
    expect(recipients).toEqual(["user@example.com"]);
  });

  it("returns empty array when no recipients", () => {
    const recipients = extractRecipients({ from: "a@b.com", subject: "S", html: "<p/>" });
    expect(recipients).toEqual([]);
  });
});

// ─── Handler routing tests — CF REST API response alignment ──
describe("POST /accounts/{account_id}/email/sending/send handler — CF REST API aligned", () => {
  it("rejects missing Idempotency-Key with 400 + invalid_request_schema", async () => {
    const handler = createSendHandler();
    const resp = await handler(
      makeRequest(MINIMAL_BODY, { idempotencyKey: null }),
      { DEDUP: env.DEDUP, EMAIL: { send: async () => ({ messageId: "x" }) } },
    );
    expect(resp.status).toBe(400);
    const json = await jsonBody(resp);
    expect(json.success).toBe(false);
    expect(json.errors).toEqual([ERRORS.INVALID_REQUEST_SCHEMA]);
    expect(json.result).toBeNull();
  });

  it("rejects invalid body with 400 + invalid_request_schema", async () => {
    const handler = createSendHandler();
    const resp = await handler(
      makeRequest({ from: "a@b.com" }, { idempotencyKey: "bad-body-2" }),
      { DEDUP: env.DEDUP, EMAIL: { send: async () => ({ messageId: "x" }) } },
    );
    expect(resp.status).toBe(400);
    const json = await jsonBody(resp);
    expect(json.success).toBe(false);
    expect(json.errors).toEqual([ERRORS.INVALID_REQUEST_SCHEMA]);
    expect(json.result).toBeNull();
  });

  it("sends email (200) with CF REST API result shape", async () => {
    const handler = createSendHandler();
    const bindings: SendBindings = {
      DEDUP: env.DEDUP,
      EMAIL: { send: async () => ({ messageId: "real-id-123" }) },
    };
    const resp = await handler(makeRequest(MINIMAL_BODY, { idempotencyKey: "route-send-3" }), bindings);
    expect(resp.status).toBe(200);
    const json = await jsonBody(resp);
    expect(json.success).toBe(true);
    expect(json.errors).toEqual([]);
    // Result matches CF REST API doc: delivered, message_id, permanent_bounces, queued
    const result = json.result as Record<string, unknown>;
    expect(result.delivered).toEqual(["user@example.com"]);
    expect(result.message_id).toBe("real-id-123");
    expect(result.permanent_bounces).toEqual([]);
    expect(result.queued).toEqual([]);
  });

  it("returns 409 with error code 19999 + duplicate_request message", async () => {
    const handler = createSendHandler();
    const bindings: SendBindings = {
      DEDUP: env.DEDUP,
      EMAIL: { send: async () => ({ messageId: "should-not-reach" }) },
    };
    // First call marks the key → DO says "send"
    const resp1 = await handler(makeRequest(MINIMAL_BODY, { idempotencyKey: "route-skip-3" }), bindings);
    expect(resp1.status).toBe(200);
    // Second call with same key → DO says "skip" → 409
    const resp2 = await handler(makeRequest(MINIMAL_BODY, { idempotencyKey: "route-skip-3" }), bindings);
    expect(resp2.status).toBe(409);
    const json = await jsonBody(resp2);
    expect(json.success).toBe(false);
    expect(json.errors).toEqual([ERRORS.DUPLICATE_REQUEST]);
    expect(json.result).toBeNull();
  });

  it("proceeds to send when DO is unreachable (best-effort degradation, messages array)", async () => {
    const handler = createSendHandler();
    const bindings: SendBindings = {
      DEDUP: {
        idFromName: () => { throw new Error("DO unreachable"); },
        get: () => { throw new Error("DO unreachable"); },
      },
      EMAIL: { send: async () => ({ messageId: "degraded-123" }) },
    };
    const resp = await handler(makeRequest(MINIMAL_BODY), bindings);
    expect(resp.status).toBe(200);
    const json = await jsonBody(resp);
    expect(json.success).toBe(true);
    const degradedResult = json.result as Record<string, unknown>;
    expect(degradedResult.delivered).toEqual(["user@example.com"]);
    expect(degradedResult.permanent_bounces).toEqual([]);
    expect(degradedResult.queued).toEqual([]);
    // Degradation info goes in the CF messages array
    expect(json.messages).toEqual([
      { code: 0, message: "dedup_skipped: DO_UNREACHABLE" },
    ]);
  });

  it("returns 500 with internal_server when EMAIL.send throws", async () => {
    const handler = createSendHandler();
    const bindings: SendBindings = {
      DEDUP: env.DEDUP,
      EMAIL: { send: async () => { throw new Error("email_send_failed"); } },
    };
    const resp = await handler(makeRequest(MINIMAL_BODY, { idempotencyKey: "route-fail-3" }), bindings);
    expect(resp.status).toBe(500);
    const json = await jsonBody(resp);
    expect(json.success).toBe(false);
    expect(json.errors).toEqual([ERRORS.INTERNAL_SERVER]);
    expect(json.result).toBeNull();
  });

  it("success with multiple recipients populates delivered array", async () => {
    const handler = createSendHandler();
    const bindings: SendBindings = {
      DEDUP: env.DEDUP,
      EMAIL: { send: async () => ({ messageId: "multi-123" }) },
    };
    const resp = await handler(makeRequest(CF_REST_BODY, { idempotencyKey: "route-multi-2" }), bindings);
    expect(resp.status).toBe(200);
    const json = await jsonBody(resp);
    const result = json.result as Record<string, unknown>;
    expect(result.delivered).toEqual([
      "recipient@example.com",
      "recipient-a@example.com",
      "recipient-b@example.com",
      "secret@example.com",
    ]);
  });
});
