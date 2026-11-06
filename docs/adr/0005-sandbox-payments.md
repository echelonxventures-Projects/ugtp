# ADR-0005 — Sandbox-only payment rail with signed webhooks

**Status:** accepted · 2026-11-05

## Context

No licensed payment provider is integrated in this environment, and real funds must not move during
development or verification.

## Decision

Ship one `sandbox` adapter behind the `payments` domain. Deposits create captured payments and ledger
postings; withdrawals place a hold and require a different actor to approve. Provider callbacks are
HMAC-SHA256 signed over the raw body, compared in constant time, and deduplicated by
`UNIQUE(tenant_id, provider, provider_event_id)`. Chargebacks post a reversal; if funds were withdrawn the
payment is marked `disputed` rather than forcing a negative balance.

## Consequences

- All financial flows are testable end to end without external dependencies.
- Adding a live PSP requires an adapter, capability metadata, reconciliation and compliance onboarding — a
  deliberate gate, not a code toggle.
- Real-money activation is blocked by policy until a verified licence exists; the flag alone is insufficient.
