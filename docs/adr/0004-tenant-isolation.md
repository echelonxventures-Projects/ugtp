# ADR-0004 — Tenant isolation in the data layer

**Status:** accepted · 2026-11-05

## Context

D1 (SQLite) has no row-level security. Multi-tenant isolation must therefore be a property of every query and
must be proven by tests, not assumed from routing.

## Decision

Every tenant-owned table carries `tenant_id`. Service functions receive the tenant from the authenticated
session (validated `x-tenant-id` only for platform admins) and always filter by it. Cross-tenant identifiers
resolve as 404. Negative tests assert the boundary.

## Consequences

- Isolation is enforced in one place per query, but a missed predicate is a real risk; review and tests are the
  control.
- Platform-level queries are explicitly separated and permission-gated.
- If the platform later moves to Postgres, RLS can add defense in depth without changing callers.
