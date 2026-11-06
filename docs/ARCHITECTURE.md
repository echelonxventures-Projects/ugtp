# Architecture

## 1. Shape

A modular monolith deployed as one Cloudflare Worker with static assets and a D1 (SQLite) database.
Every domain is a module with its own tables, invariants and service functions; the HTTP layer in
`src/worker/api.ts` only validates input, resolves the authenticated context and delegates.

This shape was chosen deliberately over premature service decomposition: the platform's hard problems are
financial integrity, authorization and auditability, not network topology. Each module can be extracted
later without changing its contracts (see ADR-0001).

## 2. Canonical domains

| Domain | Owner module | Canonical tables |
|---|---|---|
| Organization & tenancy | `orgs.ts` | `tenants`, `legal_entities`, `operators`, `brands` |
| Identity & access | `auth.ts`, `core.ts` | `users`, `sessions` |
| Regulatory authorization | `policy.ts`, `api.ts` | `jurisdictions`, `licences` |
| Player | `players.ts` | `players` |
| Gaming | `gaming.ts`, `shared/engine.ts` | `games`, `game_sessions`, `rounds`, `seed_history` |
| Wallet & ledger | `ledger.ts` | `accounts`, `account_balances`, `transactions`, `postings` |
| Payments | `payments.ts` | `payments`, `payment_events` |
| Settlement | `settlements.ts` | `settlements` |
| Redemption | `redemptions.ts` | `redemptions`, `assets` |
| Agents | `agents.ts` | `agents` |
| Credit | `credit.ts` | `credit_facilities`, `credit_events` |
| Affiliates | `affiliates.ts` | `affiliates`, `affiliate_contracts`, `attributions`, `commissions`, `commission_lines`, `payouts` |
| Approvals & audit | `approvals.ts`, `core.ts` | `approval_requests`, `audit_log` |

Money is always integer minor units. Assets carry an explicit classification (`monetary`, `promotional`,
`non_monetary`) and `redeemable` flag; classification is data, never inferred from a display name.

## 3. Financial architecture

Every movement is a `transactions` row with two or more `postings` whose signed amounts sum to zero per
asset. `account_balances` is a cached projection updated in the same D1 batch; a `CHECK` constraint makes an
overdraft abort the batch, which surfaces as `402 INSUFFICIENT_FUNDS`.

Accounts are keyed by `(tenant, owner type, owner id, asset, kind)` with kinds `available`, `held`,
`revenue`, `clearing`, `receivable`. External PSP and platform revenue accounts are allowed to go negative by
design; player accounts are not.

- **Idempotency:** `UNIQUE(tenant_id, idempotency_key)` on `transactions`; a replay returns the existing
  transaction instead of posting again. Payment webhooks add `UNIQUE(tenant_id, provider, provider_event_id)`.
- **Reversal:** `reverseTransaction` posts mirrored entries under a new transaction and marks the original
  `reversed`. Posted amounts are never mutated or deleted.
- **Atomicity:** the transaction header, postings, balance updates and the domain row (round, payment,
  redemption, credit event) are one `DB.batch`.
- **Invariants:** `unbalancedAssets` and `projectionMismatches` verify zero-sum postings and projection
  consistency; the overview endpoint reports ledger balance.

## 4. Regulatory enforcement

`evaluatePolicy(action, jurisdiction, licence, realMoneyEnabled)` checks, in order: platform flag → assessed
jurisdiction → area permission (`money_gaming`, `credit`, `affiliate_payout`) → licence presence, status,
verification, validity window, activity coverage and game category. Any missing or stale fact denies.

Actions covered: `deposit`, `withdrawal`, `wager_real`, `redemption_monetary`, `credit_issue`,
`affiliate_payout`, `settlement_confirm`. Non-monetary gaming is outside the money-gaming policy path and is
tracked as such.

Licences are canonical rows (`licences`) with evidence references, verifier identity and timestamps.
Registration alone is inert: `verified_at` must be set by compliance, and the policy engine refuses
unverified licences. See `docs/REGULATORY-MODEL.md`.

## 5. State machines

| Entity | States | Guards |
|---|---|---|
| Payment (withdrawal) | `pending_approval → paid / rejected` | KYC, policy, hold placed, approver ≠ requester |
| Payment (deposit) | `captured → disputed` | policy, idempotency, signed webhook |
| Settlement | `draft/claimed → pending_verification → verified → confirmed → reconciled` plus `disputed`/`reversed` | evidence, actor separation, legal transition map |
| Redemption | `pending_approval → paid / rejected` | monetary + redeemable asset, KYC, policy, approver ≠ requester |
| Credit facility | `pending_approval → active → suspended/closed` | approval, policy |
| Credit draw | `posted` (immediate below threshold, approved above) | limit, exposure, policy |
| Commission | `draft → approved → paid` | reproducibility, approver ≠ requester |
| Payout | `pending_approval → paid/failed/reversed/rejected` | commission approved, minimum, withholding, approver ≠ requester |

Invalid transitions return `409`; they are not silently coerced.

## 6. Tenancy and isolation

Every tenant-owned row carries `tenant_id`. Data access always takes the tenant from the authenticated
session (platform administrators may select a tenant through a validated `x-tenant-id` header) and filters by
it. Cross-tenant identifiers resolve as `404`, not as data. D1 has no row-level security, so isolation is an
application-layer control, backed by mandatory tenant predicates and negative tests (see ADR-0004).

## 7. Gaming integrity

Dice outcomes are `floor(uint32(HMAC-SHA256(server_seed, "dice|client_seed|nonce|0")) / 2³² × 10000)`.
The server publishes `SHA-256(server_seed)` before play and reveals the seed on rotation with the final nonce.
Multipliers are a pure function of the published win probability and the configured house edge (99% RTP).
There is no player-specific manipulation, loss steering or hidden bias.

## 8. HTTP and security conventions

- Same-origin enforcement on mutations that carry an `Origin` header.
- HttpOnly, `SameSite=Lax`, `Secure` (when HTTPS) session cookies; 12-hour expiry; server-side revocation.
- Permission checks server-side for every route; the client's navigation is cosmetic only.
- Errors are `{ error: { code, message, details } }` with stable machine codes.
- No financial or personal data is logged by the Worker.

## 9. Operational model

Workers + D1, deployed per environment; bindings: `DB` (D1), `ASSETS`, `ENVIRONMENT`, optional
`PSP_WEBHOOK_SECRET`. Migrations are the only schema path. Observability today is Cloudflare Worker logs plus
the append-only audit table; structured metrics/tracing are a documented gap.
