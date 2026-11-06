# ADR-0003 — Regulatory authorization fails closed

**Status:** accepted · 2026-11-05

## Context

The platform must not enable prohibited online money gaming through configuration, tenant choice or licence
data, and must not treat its own code as legal authorization.

## Decision

A single policy engine evaluates platform flag → jurisdiction assessment → area permission → licence presence,
status, verification, validity, activity and game category. Any absent or stale fact denies with a stable
code. Prohibited jurisdictions are checked before licence data, so no licence can override them. The platform
records who verified a licence and on what evidence.

## Consequences

- Missing data is safe by construction; onboarding requires explicit compliance work.
- A licence cannot be "activated" by inserting a row: verification is a separate, audited act.
- Expiry is evaluated per request; there is no proactive suspension job yet.
- The software enforces determinations; counsel remains accountable for them.
