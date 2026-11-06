# ADR-0006 — Explicit state machines and segregation of duties

**Status:** accepted · 2026-11-05

## Context

Regulated money flows need reviewable transitions and dual control; ad-hoc status updates are neither
auditable nor safe.

## Decision

Each financial entity has an explicit transition map. Illegal transitions return 409. High-risk actions
(withdrawal payment, credit activation, above-threshold draw, redemption payment, commission approval, payout)
create approval requests, and the requester cannot decide them. Decisions are audited with actor and timestamp.

## Consequences

- Every privileged transition has a named human decision and a trail.
- Workflows need at least two active staff per tenant; bootstrap seeds them.
- The model is role-based today; finer ABAC and MFA remain gaps.
