/**
 * Send handler — core logic for POST /accounts/{account_id}/email/sending/send,
 * separated from the Hono app for unit testing. The request body is CF Email
 * Sending REST-API compatible; two transformations map it to the Workers
 * EmailMessageBuilder:
 *   1. { address, name } → { email, name }   (address objects)
 *   2. reply_to          → replyTo           (field rename)
 *
 * All responses follow the Cloudflare API envelope:
 *   { errors: [{code,message}], messages: [{code,message}], result, success }
 *
 * Error codes and messages align with the official CF REST API doc:
 *   https://developers.cloudflare.com/email-service/api/send-emails/rest-api/
 * Our service-specific code 19999 (duplicate idempotency key) is the only
 * non-CF code, per design.
 */

// ─── Error codes & messages (aligned with CF REST API doc) ────
// CF official:  10001 = invalid_request_schema, 10002 = internal_server
// Custom:       19999 = duplicate_request (idempotency dedup — our feature)
export const ERRORS = {
  INVALID_REQUEST_SCHEMA: {
    code: 10001,
    message: "email.sending.error.invalid_request_schema",
  },
  DUPLICATE_REQUEST: {
    code: 19999,
    message: "email.sending.error.duplicate_request",
  },
  INTERNAL_SERVER: {
    code: 10002,
    message: "email.sending.error.internal_server",
  },
} as const;

// Informational message code for dedup degradation (CF messages array).
const MSG_DEDUP_SKIPPED = {
  code: 0,
  message: "dedup_skipped: DO_UNREACHABLE",
} as const;

// ─── CF standard response envelope helpers ──────────────────

interface CFEnvelopeItem {
  code: number;
  message: string;
}

function cfErrorResponse(
  code: number,
  message: string,
  status: number,
): Response {
  return Response.json(
    {
      errors: [{ code, message }],
      messages: [],
      result: null,
      success: false,
    },
    { status },
  );
}

function cfSuccessResponse(
  result: Record<string, unknown>,
  messages?: CFEnvelopeItem[],
): Response {
  return Response.json({
    errors: [],
    messages: messages ?? [],
    result,
    success: true,
  });
}

// ─── Bindings / types ────────────────────────────────────────

export interface SendBindings {
  DEDUP: {
    idFromName: (name: string) => DurableObjectId;
    get: (id: DurableObjectId) => {
      trySend: (idempotencyKey: string) => Promise<{ action: "send" | "skip" }>;
    };
  };
  EMAIL: {
    send: (message: EmailMessageBuilder) => Promise<EmailSendResult>;
  };
}

// ─── Validation ──────────────────────────────────────────────

export function validateBody(body: unknown): boolean {
  if (!body || typeof body !== "object") return false;
  const b = body as Record<string, unknown>;

  if (!b.from || (typeof b.from !== "string" && typeof b.from !== "object")) {
    return false;
  }

  if (typeof b.subject !== "string" || !b.subject) return false;

  const hasHtml = typeof b.html === "string" && b.html.length > 0;
  const hasText = typeof b.text === "string" && b.text.length > 0;
  return hasHtml || hasText;
}

// ─── Address remapping ───────────────────────────────────────

/** REST { address, name } → Workers { email, name }; strings pass through. */
export function remapAddress(addr: unknown): unknown {
  if (typeof addr === "string") return addr;
  if (addr !== null && typeof addr === "object" && "address" in addr) {
    const obj = addr as Record<string, unknown>;
    return { email: obj.address, ...("name" in obj ? { name: obj.name } : {}) };
  }
  return addr;
}

export function remapAddresses(addr: unknown): unknown {
  if (Array.isArray(addr)) return addr.map(remapAddress);
  return remapAddress(addr);
}

/** Map the CF REST API body to a Workers EmailMessageBuilder. */
export function toEmailMessageBuilder(body: Record<string, unknown>): EmailMessageBuilder {
  const builder: Record<string, unknown> = {};

  for (const key of ["from", "to", "cc", "bcc"]) {
    if (body[key] !== undefined) {
      builder[key] = remapAddresses(body[key]);
    }
  }

  for (const key of ["subject", "html", "text", "headers", "attachments"]) {
    if (body[key] !== undefined) {
      builder[key] = body[key];
    }
  }

  if (body.reply_to !== undefined) {
    builder.replyTo = remapAddress(body.reply_to);
  }

  return builder as unknown as EmailMessageBuilder;
}

// ─── Recipient extraction (for CF result.delivered) ─────────

/**
 * Extract all recipient email addresses from the request body (to/cc/bcc).
 * Used to populate result.delivered — when EMAIL.send() succeeds, all
 * recipients were accepted by the CF email pipeline.
 */
export function extractRecipients(body: Record<string, unknown>): string[] {
  const recipients: string[] = [];
  for (const key of ["to", "cc", "bcc"]) {
    const val = body[key];
    if (val === undefined) continue;
    const addrs = Array.isArray(val) ? val : [val];
    for (const a of addrs) {
      if (typeof a === "string") {
        recipients.push(a);
      } else if (a !== null && typeof a === "object" && "address" in a) {
        recipients.push((a as Record<string, unknown>).address as string);
      }
    }
  }
  return recipients;
}

// ─── Handler ─────────────────────────────────────────────────

export function createSendHandler() {
  return async function handleSend(
    request: Request,
    bindings: SendBindings,
  ): Promise<Response> {
    // 1. Idempotency-Key header required (our dedup feature).
    const idempotencyKey = request.headers.get("Idempotency-Key");
    if (!idempotencyKey) {
      return cfErrorResponse(
        ERRORS.INVALID_REQUEST_SCHEMA.code,
        ERRORS.INVALID_REQUEST_SCHEMA.message,
        400,
      );
    }

    // 2. Parse + validate body.
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return cfErrorResponse(
        ERRORS.INVALID_REQUEST_SCHEMA.code,
        ERRORS.INVALID_REQUEST_SCHEMA.message,
        400,
      );
    }

    if (!validateBody(body)) {
      return cfErrorResponse(
        ERRORS.INVALID_REQUEST_SCHEMA.code,
        ERRORS.INVALID_REQUEST_SCHEMA.message,
        400,
      );
    }

    // 3. Best-effort dedup via Durable Object.
    let dedupResult: { action: "send" | "skip" } | null = null;
    let dedupSkipped: string | undefined;

    try {
      const doId = bindings.DEDUP.idFromName(idempotencyKey);
      const stub = bindings.DEDUP.get(doId);
      dedupResult = await stub.trySend(idempotencyKey);
    } catch {
      dedupSkipped = "DO_UNREACHABLE";
    }

    // 4. Duplicate within TTL → error code 19999 (custom).
    if (dedupResult?.action === "skip") {
      return cfErrorResponse(
        ERRORS.DUPLICATE_REQUEST.code,
        ERRORS.DUPLICATE_REQUEST.message,
        409,
      );
    }

    // 5. Send via EMAIL binding.
    const parsedBody = body as Record<string, unknown>;
    const message = toEmailMessageBuilder(parsedBody);

    try {
      const result = await bindings.EMAIL.send(message);

      const cfResult: Record<string, unknown> = {
        delivered: extractRecipients(parsedBody),
        message_id: result.messageId,
        permanent_bounces: [],
        queued: [],
      };

      const messages: CFEnvelopeItem[] | undefined = dedupSkipped
        ? [{ ...MSG_DEDUP_SKIPPED }]
        : undefined;

      return cfSuccessResponse(cfResult, messages);
    } catch {
      return cfErrorResponse(
        ERRORS.INTERNAL_SERVER.code,
        ERRORS.INTERNAL_SERVER.message,
        500,
      );
    }
  };
}
