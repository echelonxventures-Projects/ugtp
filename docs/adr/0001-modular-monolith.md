# ADR-0001 — Modular monolith on Workers, D1 and React

**Status:** accepted · 2026-11-05

## Context

The platform must deliver nine regulated capability areas with strong financial integrity, on a stack the
team can deploy and verify, without inventing infrastructure it cannot test.

## Decision

One Cloudflare Worker (Hono-free, explicit router), one D1 database, one React SPA served as Worker assets.
Domains are separate modules with canonical tables and service functions; the HTTP layer only maps requests.

## Consequences

- Financial transitions and ledger postings share one D1 batch, giving atomicity without a distributed
  transaction.
- D1 lacks row-level security and long transactions: tenancy must be enforced in queries, and batch sizes are
  bounded.
- Extraction to services later is possible because module contracts are narrow.
- Chosen over microservices because network boundaries would add failure modes without improving the actual
  integrity guarantees.
