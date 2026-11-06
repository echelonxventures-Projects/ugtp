# Security posture

## Implemented

| Control | Detail |
|---|---|
| Password storage | PBKDF2-HMAC-SHA256, 210,000 iterations, 16-byte random salt, constant-time comparison |
| Sessions | 32-byte random token, stored as SHA-256 hash, HttpOnly + SameSite=Lax (+ Secure on HTTPS), 12h expiry, server-side revocation |
| Authorization | Permission sets per role, checked server-side on every route; client navigation is cosmetic |
| Tenant isolation | Tenant derived from the session; every query filtered by `tenant_id`; cross-tenant IDs return 404 |
| CSRF | SameSite cookies plus same-origin enforcement on all mutating requests carrying an `Origin` |
| Login throttling | In-memory per-isolate rate limit on attempts (best-effort; not distributed) |
| Financial guards | Non-negative balance constraint, idempotency keys, atomic batches, reversal-only corrections |
| Webhooks | HMAC-SHA256 signature over the raw body, constant-time comparison, unique provider event id, replay-safe |
| Segregation of duties | Requester cannot approve withdrawals, credit facilities, redemptions, commissions or payouts |
| Input validation | Typed parsing, integer money, allow-listed enums and settings keys |
| Audit | Append-only `audit_log` for privileged mutations, with actor, subject and metadata |
| Headers | `nosniff`, `referrer-policy: same-origin`, `cache-control: no-store` on API responses |
| Secrets | No secrets in the repository; `PSP_WEBHOOK_SECRET` is a runtime binding; `.dev.vars` is gitignored |

## Known gaps

- **No MFA**, device binding or privileged access management.
- **Rate limiting is per isolate**; production needs a Durable Object or edge rate-limit service.
- **No KYC/AML/sanctions provider**, no fraud or collusion detection.
- **No encryption at the application layer**; D1 encryption and TLS are provider responsibilities.
- **No data retention/deletion workflow**, subject-access export or privacy tooling.
- **No security headers beyond the listed ones**, no CSP (the console is a static bundle; add CSP before
  production).
- **Audit log is append-only by convention**, not cryptographically chained; an operator with database access
  could rewrite history. Production requires WORM storage or hash chaining.
- **No vulnerability scanning or dependency policy** beyond `npm audit` at install time.
- **Sandbox PSP only**; live provider integration brings PCI scope and provider onboarding.

## Threat notes

- The platform processes real-value balances in D1; database access is equivalent to financial authority.
  Restrict production credentials accordingly.
- `x-tenant-id` is honored only for `platform_admin` and validated against existing tenants.
- The bootstrap endpoint is disabled in production and single-use otherwise.
