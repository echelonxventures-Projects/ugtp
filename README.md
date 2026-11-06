# UGTP Ω∞ — Universal Gaming Technology Platform

A server-authoritative, multi-tenant gaming platform foundation built on **Cloudflare Workers + D1 + React**,
with double-entry financial controls, provably fair gaming, regulatory authorization that fails closed, agent
distribution, credit, settlement, redemption, affiliate commission and payout.

**Status: sandbox-verified foundation (implementation outcome C).** The platform is not authorized,
licensed or production-enabled for real-money gaming. Only a sandbox payment adapter is enabled; no real
funds move. See [docs/CAPABILITY-MATRIX.md](docs/CAPABILITY-MATRIX.md) and
[docs/VERIFICATION.md](docs/VERIFICATION.md).

---

## Run it locally

Requirements: Node 22+ (verified on Node 26), npm, no external services.

```bash
npm install
npm run build        # builds the React console into dist/client
npm run db:local     # applies migrations/0001_init.sql to the local D1 database
npm run dev          # wrangler dev on http://127.0.0.1:8787
```

Open the console and click **Initialize sandbox**. It seeds:

- a platform administrator;
- a licensed Malta demo operator (`MT`) with an active, verified licence;
- an India tenant (`IN`) whose assessed profile is `prohibited` (every money action is denied, licence or not);
- tenant admin, finance and compliance users per tenant, plus a verified demo player each;
- a provably fair dice game and a demo affiliate.

Credentials are generated at bootstrap and **shown once**. Write them down; they are stored only as
PBKDF2 hashes.

## Verify

```bash
npm run typecheck     # tsc --noEmit
npm test              # 23 unit tests (provably fair math + regulatory policy)
npm run build         # Vite production build
npm run test:e2e      # 81 HTTP checks against real workerd + D1
```

`npm run test:e2e` boots `wrangler dev` on port 8799 with a throwaway D1 directory, applies migrations,
bootstraps the sandbox and exercises the API end to end. It exits non-zero on any failure.

## What is implemented

| Area | Summary |
|---|---|
| Tenancy | Tenant → legal entity → operator → brand, platform-admin tenant switching, every query tenant-scoped |
| Identity | Email + PBKDF2-SHA256 (210k) passwords, HttpOnly session cookies, RBAC, permission checks server-side |
| Regulatory | Jurisdiction profiles, licence registry, evidence verification, fail-closed policy engine (prohibited / unassessed / expired / unverified / wrong activity → deny) |
| Wallet & ledger | Append-only double-entry postings, idempotency keys, reversal transactions, balance projection guarded by `CHECK`, zero-sum invariant |
| Gaming | Provably fair dice (HMAC-SHA256, published seed hash, seed rotation), server-authoritative settlement |
| Payments | Provider-neutral cashier, sandbox adapter, idempotent deposits, withdrawal holds, two-person approval, HMAC-signed webhooks with replay protection, chargeback handling |
| Settlement | Explicit state machine for on/off-platform settlement, evidence required, claimant/verifier/confirmer separation |
| Redemption | Monetary + redeemable asset only, KYC and jurisdiction gates, funds held until approval |
| Agents | Tenant-scoped hierarchy with cycle, depth and self-parent rejection, status and player assignment |
| Credit | Facilities with limits, exposure tracking, threshold-based approvals, draw/repay ledger postings |
| Affiliates | Versioned contracts, attribution, revenue-share / CPA / hybrid / tiered commissions, reproducibility check, payouts with withholding and approval |
| Compliance | Approval queue with segregation of duties, immutable audit log |

Interactive console: overview, players, agents & credit, payments/settlements/redemptions, affiliates,
compliance, approvals, audit, and the game lobby.

## Architecture in brief

```
src/
  shared/engine.ts     deterministic, provably fair game math (browser + worker + tests)
  worker/
    index.ts           Worker entry: origin checks, auth, routing, static assets
    api.ts             HTTP API
    core.ts            env types, permissions, errors, validation, audit
    auth.ts            password hashing, sessions, login rate limits
    ledger.ts          double-entry postings, reversals, invariants
    policy.ts          jurisdiction + licence evaluation (fail closed)
    approvals.ts       approval queue and segregation of duties
    orgs.ts players.ts gaming.ts payments.ts settlements.ts
    redemptions.ts agents.ts credit.ts affiliates.ts
    setup.ts           single-use sandbox bootstrap
  client/              React console
migrations/0001_init.sql
tests/                 unit tests + e2e harness
docs/                  audit, architecture, capability matrix, regulatory model, ADRs, verification
```

Design rules enforced in code:

- money is integer minor units; balances are projections of append-only postings;
- an overdraft aborts the whole D1 batch (`CHECK (balance_minor >= 0 OR allow_negative = 1)`);
- corrections are reversal transactions, never edits;
- idempotency keys are unique per tenant, so retries and duplicate webhooks cannot double-post;
- financial state changes and their ledger postings commit in one D1 batch;
- no capability is enabled by a flag alone: money actions require a jurisdiction assessment **and** an active,
  verified licence covering the activity;
- requesters cannot approve their own withdrawal, credit facility, redemption, commission or payout.

## Regulatory posture

The policy engine enforces approved determinations; it does **not** decide legality. See
[docs/REGULATORY-MODEL.md](docs/REGULATORY-MODEL.md).

India is a distinct profile: online money gaming, related promotion/facilitation and financial transactions
are treated as prohibited and are denied for deposit, withdrawal, real-money wager, monetary redemption,
credit and affiliate payout, regardless of any licence row, tenant, currency or flag. Non-monetary play
credits with no cash-out remain a separate, non-money activity. This is an engineering control, not a legal
opinion; deployment requires qualified local counsel and current official sources.

## Real money

`ENVIRONMENT=production` disables the sandbox bootstrap. Real-money operation additionally requires:

1. a licensed operator and supplier authorization in each jurisdiction;
2. a licensed PSP adapter (this repository ships only `sandbox`) and KYC/AML providers;
3. verified licence evidence and jurisdiction profiles matching the approved scope;
4. operational, security and financial-readiness approval.

Until then, `real_money_enabled` can be disabled at the platform level and every money action fails closed.

## Deployment

The app is a Worker with static assets and a D1 binding:

```bash
npx wrangler d1 create ugtp           # then put the returned id in wrangler.jsonc
npm run db:remote
npm run deploy
```

No deployment has been performed as part of this work.
