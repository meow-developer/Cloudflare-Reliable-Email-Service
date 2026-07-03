# Changelog

## [0.1.0] - 2026-07-03

Initial release.

- Durable Object (`DedupDO`) for race-free, per-key deduplication via `Idempotency-Key` header. Alarm-based TTL cleanup, configurable via `DEDUP_TTL_MS`.
- Cloudflare Worker on the [CF Email Sending REST API path](https://developers.cloudflare.com/email-service/api/send-emails/rest-api/) (`POST /accounts/{account_id}/email/sending/send`) with idempotent email delivery on top of the Cloudflare Email Service.
- Request body is a full passthrough to the [CF Email Sending REST API](https://developers.cloudflare.com/api/resources/email_sending/methods/send/) — `cc`, `bcc`, `reply_to`, `headers`, `attachments`, array recipients all pass through verbatim.
- Duplicate `Idempotency-Key` within TTL → `409 Conflict`.
- Best-effort degradation: proceeds to send if the Durable Object is unreachable.
- ZeroTrust Access authentication support (edge-validated, zero Worker auth code).
- GitHub Actions CI workflow.
- 30 unit tests covering DO logic, request validation, dedup hits, CF REST API payload compatibility, and error paths.
