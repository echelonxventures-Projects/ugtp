# ADR-0002 — Append-only double-entry ledger with a guarded projection

**Status:** accepted · 2026-11-05

## Context

Wallet balances are the platform's most sensitive state. A mutable `balance` column cannot explain history,
detect drift or support disputes and audits.

## Decision

Every money movement is a `transactions` row with ≥2 signed `postings` summing to zero per asset.
`account_balances` is a projection updated in the same batch, constrained by
`CHECK (balance_minor >= 0 OR allow_negative = 1)`. Corrections are new reversal transactions. Idempotency
keys are unique per tenant.

## Consequences

- Overdrafts abort the D1 batch, surfacing as HTTP 402, including when the guard is the last statement.
- History is explainable and reconcilable; `unbalancedAssets` and `projectionMismatches` detect drift.
- Slightly more write amplification per operation, accepted for auditability.
- Posted rows are never edited; only status fields (e.g. `reversed`) change.
