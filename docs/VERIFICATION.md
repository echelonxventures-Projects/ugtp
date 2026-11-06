# Verification report

Environment: Node 26.13.0 · npm 11.20.0 · wrangler 4.158.0 · workerd 1.20261104.1 · Vite 8.3.6 · Vitest 5.1.0
D1: local SQLite via workerd (`--persist-to .wrangler/e2e-state`), migrations applied from scratch.

## Commands and results

| # | Command | Result |
|---|---|---|
| 1 | `npx tsc --noEmit` | exit 0, no diagnostics |
| 2 | `npx vitest run` | **23 passed / 23**, 2 files |
| 3 | `npx vite build` | exit 0, 25 modules, `dist/client` emitted |
| 4 | `npx wrangler d1 migrations apply ugtp --local --persist-to .wrangler/e2e-state` | 56 statements applied |
| 5 | `node tests/e2e.mjs` | **81 passed / 0 failed**, exit 0 |

## Unit coverage

`tests/engine.test.ts` (10):
determinism across identical seeds; variation by nonce and server seed; roll range over 250 nonces; seed hash
matches recomputation; 50% chance priced at 1.98x; RTP within 97–99% for four configurations; payout flooring;
under/over boundary semantics; unplayable-target rejection; seed uniqueness.

`tests/policy.test.ts` (13):
allowed with verified active licence; India denies six money actions even with a licence; unassessed denies;
unknown jurisdiction denies; platform flag off denies; missing licence; unverified; suspended/revoked/pending;
expired/not-yet-effective; unlicensed activity; unlicensed game category; jurisdiction mismatch; prohibited
area not rescued by licence data.

## End-to-end coverage (real HTTP against workerd + D1)

Bootstrap and auth: health, single-use bootstrap, tenant scoping, platform tenant list, India prohibition,
Malta licence gating, seeded players, six logins.

Gaming: play-credit round settles with an in-range roll, wallet equals `stake − payout`, India play-money
allowed.

Cashier: India deposit `403 JURISDICTION_PROHIBITED`; Malta deposit captured; duplicate idempotency key
credits once; withdrawal held; requester cannot approve; finance pays; overdraft `402`.

Agents/credit: parent/child creation; cycle `409`; facility approval SoD; threshold draw queued and approved;
exposure 10,000 → 70,000; limit `409`.

Settlement: claim recorded as `claimed`; cannot jump to `confirmed`; evidence required for verification;
compliance verifies; second actor confirms; reconcile.

Redemption: hold; requester cannot approve; finance pays; XCR rejected.

Affiliate: activate, contract, attribution, CPA commission 5,000; reproducible; requester cannot approve;
finance approves; payout withheld 750, net 4,250; requester cannot approve; finance pays.

Isolation/fail-closed: cross-tenant player `404`; payment list isolated; real-money disable blocks deposit
(`REAL_MONEY_DISABLED`) and re-enable restores it.

Webhooks: invalid HMAC `401`; valid signature accepted; replay deduplicated.

Ledger/audit: both tenants' postings net to zero; audit entries present.

## What this does not prove

- No load, soak, concurrency or fault-injection testing. No performance claims.
- No browser/visual test of the console beyond the production build; UI flows are exercised only through the
  API and a manual preview.
- No live payment provider, KYC, AML or sanctions integration.
- No CI execution on GitHub from this environment (workflow is authored but unrun).
- No security review, penetration test or dependency audit beyond install-time `npm audit`.
- No multi-region, backup/restore or disaster-recovery exercise.

## Outcome

**Outcome C — partially implemented.** All nine mandatory capability areas have working, persisted,
policy-enforced implementations with passing tests for their core flows, but material capabilities (live
payments, KYC/AML, MFA, fraud, FX, provider integrations, performance evidence, disaster recovery) remain
absent, and nothing is legally authorized or production-enabled.
