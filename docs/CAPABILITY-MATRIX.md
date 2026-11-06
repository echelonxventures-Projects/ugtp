# Capability matrix

Status model (independent states): **Specified → Architected → Implemented → Enforced → Tested → Verified →
Authorized → Production-enabled**.

`Authorized` means legal/regulatory authorization exists. No capability is authorized or production-enabled in
this repository; no licence has been issued to UGTP and no regulator has approved anything.

Legend: ✅ done · ◐ partial · — not done / not applicable.

| Capability | Implemented | Enforced | Tested | Verified | Authorized | Evidence |
|---|---|---|---|---|---|---|
| Agent hierarchy | ✅ | ✅ | ✅ | ✅ | — | `agents.ts`, e2e cycle/reject, console |
| Agent/player credit | ✅ | ✅ | ✅ | ✅ | — | `credit.ts`, exposure + threshold approval e2e |
| Game-related cash settlement | ◐ | ◐ | ◐ | ◐ | — | `settlements.ts` supports `game_cash`; no game-provider settlement feed |
| Off-platform settlement | ✅ | ✅ | ✅ | ✅ | — | evidence + separation-of-duties e2e |
| Coin redemption | ◐ | ✅ | ✅ | ✅ | — | USD base asset only; non-monetary blocked; FX pipeline absent |
| Financial settlement / ledger | ✅ | ✅ | ✅ | ✅ | — | double-entry, idempotency, reversal, zero-sum checks |
| Real-money payment processing | ◐ | ✅ | ✅ | ✅ (sandbox) | — | sandbox adapter, signed webhooks; no live PSP |
| Affiliate commission | ✅ | ✅ | ✅ | ✅ | — | revshare/CPA/hybrid/tiered, reproducibility check |
| Affiliate payout | ✅ | ✅ | ✅ | ✅ (sandbox) | — | withholding + approval e2e; no live rail |
| Multi-tenancy isolation | ✅ | ✅ | ✅ | ✅ | — | tenant predicates + cross-tenant negative tests |
| Regulatory authorization | ✅ | ✅ | ✅ | ✅ | — | policy engine, licence verification, India prohibition |
| Identity & access (RBAC) | ✅ | ✅ | ✅ | ✅ | — | PBKDF2, sessions, permissions, rate limiting |
| MFA / ABAC | — | — | — | — | — | gap: permissions are role-based today |
| KYC / AML | ◐ | ◐ | — | — | — | manual `kyc_status` + withdrawal gate; no provider |
| Fraud / risk scoring | — | — | — | — | — | gap |
| Responsible gaming (self-exclusion, limits) | ◐ | ✅ | — | — | — | status/limits exist and block play; no UI flow or tests |
| Game integrity / provable fairness | ✅ | ✅ | ✅ | ✅ | — | seeded dice, hash publication, rotation |
| Game catalogue breadth | ◐ | — | — | — | — | dice only; no provider integration |
| Settlement/dispute workflows | ✅ | ✅ | ✅ | ✅ | — | explicit transition map, disputes |
| Audit trail | ✅ | ✅ | ✅ | ✅ | — | append-only `audit_log` |
| Observability (metrics/tracing) | — | — | — | — | — | gap: Worker logs + audit only |
| Performance / load verification | — | — | — | — | — | not measured; no claims made |
| CI enforcement | ✅ | ◐ | — | — | — | workflow added; not executed on GitHub from this environment |
| Backup / DR / multi-region | — | — | — | — | — | gap |

## Not implemented (explicit)

- Live payment provider adapters, provider capability registry and provider settlement reconciliation.
- KYC/AML, sanctions screening, fraud scoring, case management.
- MFA, device management, privileged access reviews, ABAC policy engine.
- FX conversion and non-USD monetary redemption.
- Sports, skill, tournament and third-party game-provider integration.
- Tax engine, general-ledger export, accounting-period close.
- Notifications, CRM, support tickets, complaint workflow.
- Multi-region deployment, backup/restore, disaster recovery, load testing.

These are material gaps: the implementation outcome is **C — partially implemented**, not A or B.
