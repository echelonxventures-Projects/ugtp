# Traceability

Mandatory capability → canonical implementation → API → verification.

| Capability | Implementation | API | Verification |
|---|---|---|---|
| Agent hierarchy | `src/worker/agents.ts` | `GET/POST /api/agents`, `PATCH /api/agents/:id/parent`, `PATCH /api/agents/:id/status`, `POST /api/agents/:id/players` | e2e: create parent/child, cycle rejected (`HIERARCHY_CYCLE`); console `Operations` |
| Agent/player credit | `src/worker/credit.ts` | `/api/credit/facilities`, `/:id/activate`, `/:id/draw`, `/:id/repay`, `/api/credit/exposure`, `/api/approvals/:id/decide` | e2e: approval, SoD, threshold queue, exposure, limit rejection |
| Game cash settlement | `src/worker/settlements.ts` (`kind = game_cash`) | `POST /api/settlements`, `/api/settlements/:id/transition` | e2e settlement lifecycle (off-platform); game-cash automation absent |
| Off-platform settlement | `src/worker/settlements.ts` | same | e2e: claim ≠ confirmed, evidence required, verify/confirm by different actors, reconcile |
| Coin redemption | `src/worker/redemptions.ts`, `assets` classification | `POST /api/redemptions`, `/:id/approve`, `/:id/reject` | e2e: hold, SoD, payout; XCR rejected (`ASSET_NOT_MONETARY`) |
| Financial settlement | `src/worker/ledger.ts` | embedded in every money route; `/api/accounts/:id/balance` | e2e: deposit, withdrawal, credit, payout; zero-sum overview |
| Real-money payments | `src/worker/payments.ts` | `POST /api/payments/deposit`, `/withdrawals`, `/:id/approve`, `/:id/reject`, `POST /api/webhooks/psp/:tenantId` | e2e: capture, idempotency, hold, approval, overdraft, signature, replay |
| Affiliate commission | `src/worker/affiliates.ts` | `/api/affiliates/:id/contracts`, `/attribute`, `/commissions`, `/api/commissions/:id/verify`, `/approve` | e2e: CPA amount, reproducibility, SoD |
| Affiliate payout | `src/worker/affiliates.ts` | `/api/commissions/:id/payout`, `/api/payouts/:id/approve`, `/reject` | e2e: withholding, net amount, SoD, paid |
| Regulatory authorization | `src/worker/policy.ts`, `jurisdictions`, `licences` | `/api/compliance/*` | 13 unit tests + e2e India denial, unlicensed/unassessed paths |
| Multi-tenant isolation | tenant predicates across all modules | `x-tenant-id` for platform admins | e2e cross-tenant 404 and payment isolation |
| Provable fairness | `src/shared/engine.ts`, `src/worker/gaming.ts` | `POST /api/play/dice`, `/api/play/fairness/rotate` | 10 unit tests + e2e balance/roll |
| Audit | `src/worker/core.ts` `audit()` | `GET /api/audit` | e2e audit entries present |
| Approvals / SoD | `src/worker/approvals.ts` | `GET /api/approvals`, `POST /api/approvals/:id/decide` | e2e requester-cannot-decide |
| Platform settings | `src/worker/api.ts` | `POST /api/platform/settings` | e2e fail-closed when real money disabled |

## Requirements without implemented traceability

MFA, KYC/AML, sanctions, fraud, tax withholding remittance, live PSP, FX, multi-region/DR, performance and
load evidence, and regulator reporting have **no implementation**. They are listed as gaps, not as covered.
