# Regulatory model

## 1. Separation of concerns

The platform **enforces** approved legal determinations. It does not decide legality, and no code in this
repository constitutes legal advice or evidence of a licence. Legal interpretation and authorization remain
accountable human decisions by qualified counsel and the operator.

## 2. Evaluation order

`src/worker/policy.ts` denies unless every fact below is true:

1. real-money processing is enabled at platform level (`platform_settings.real_money_enabled`);
2. a jurisdiction profile exists for the operating territory;
3. the profile's area for the action is `permitted_with_licence` (not `prohibited` or `unassessed`);
4. an operator licence exists for the tenant and jurisdiction;
5. the licence is `active`, not suspended or revoked;
6. the licence has been verified by compliance (`verified_at`) with evidence on file;
7. the current time is inside the licence's validity window;
8. the licence covers the activity (`deposit`, `withdrawal`, `wager`, `redemption`, `credit`,
   `affiliate_payout`, `settlement`);
9. the licence covers the game category, when one is supplied.

Denials are machine-coded (`JURISDICTION_PROHIBITED`, `LICENCE_EXPIRED`, `LICENCE_UNVERIFIED`,
`ACTIVITY_NOT_LICENSED`, …) and returned as `403` with the jurisdiction for audit.

## 3. Jurisdiction profiles

Profiles are structured data in `jurisdictions` with three independent areas — `money_gaming`,
`affiliate_payout`, `credit` — plus authority, legal basis, review date and notes. Seeded profiles:

| Code | Money gaming | Affiliate payout | Credit |
|---|---|---|---|
| MT (Malta) | permitted with licence | permitted with licence | permitted with licence |
| IN (India) | prohibited | prohibited | prohibited |
| GB | permitted with licence | permitted with licence | permitted with licence |
| US | unassessed | unassessed | unassessed |

`US` exists to demonstrate fail-closed behaviour for unassessed territories; it is not a legal assessment of
any state.

## 4. India

India's profile is `prohibited` for money gaming, affiliate payout and credit. The policy engine checks the
profile **before** any licence, so a licence row, foreign entity, alternate tenant, alternate currency,
skill-game label or platform flag cannot enable the prohibited activity. Deposits, withdrawals, real-money
wagers, monetary redemption and affiliate payouts are all denied. Non-monetary play credits with no cash-out
are handled outside the money-gaming path and remain non-monetary by data classification.

This reflects the Promotion and Regulation of Online Gaming Act, 2025 (in force 1 May 2026) as an engineering
control. The statute, rules, notifications and judicial developments must be verified against current official
sources, and any deployment requires local counsel. The software makes no claim of legal sufficiency.

## 5. Licence registry

`licences` stores authority, type, number, status, validity window, activities, game categories, conditions,
evidence reference and verifier. Registration is required before verification; verification requires an
evidence reference and is audited. Expiry is evaluated at request time, so an expired licence denies without
any code change.

## 6. Capability ≠ authorization

- A feature flag cannot enable a regulated capability.
- A tenant's own licence does not authorize the platform supplier, hosting or payment provider.
- Enabling `real_money_enabled` does not make an activity lawful; the jurisdiction profile and verified
  licence must still allow it.
- Continuous activation requires re-verification before the validity date; there is no background expiry job,
  so expiry is enforced on read rather than proactively suspended.
