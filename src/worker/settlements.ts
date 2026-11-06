import { ApiError, audit, newId, now, realMoneyEnabled, type AuthContext, type Env } from './core';
import { evaluateTenantAction } from './policy';
import { tenantStructure } from './orgs';

/**
 * Settlement domain. An external settlement claim is never treated as verified:
 * it must carry evidence and be verified by a second actor before it can be
 * confirmed, reconciled or paid. State transitions are explicit and invalid
 * transitions are rejected.
 */

const TRANSITIONS: Record<string, string[]> = {
  draft: ['claimed', 'pending_verification'],
  claimed: ['pending_verification', 'verified', 'disputed'],
  pending_verification: ['verified', 'disputed'],
  verified: ['confirmed', 'disputed'],
  confirmed: ['reconciled', 'disputed', 'reversed'],
  reconciled: ['reversed'],
  disputed: ['pending_verification', 'reversed'],
  reversed: [],
};

export async function createSettlement(
  env: Env,
  auth: AuthContext,
  input: {
    kind: 'game_cash' | 'agent' | 'operator' | 'partner' | 'off_platform';
    source: 'platform' | 'external';
    counterparty: string;
    amountMinor: number;
    currency?: string;
    evidenceRef?: string;
  },
) {
  const tenantId = auth.tenantId;
  if (!tenantId) throw new ApiError(403, 'TENANT_REQUIRED', 'Tenant context required');
  if (!Number.isSafeInteger(input.amountMinor) || input.amountMinor <= 0) {
    throw new ApiError(400, 'INVALID_AMOUNT', 'Settlement amount must be a positive integer');
  }
  const id = newId('stl');
  const status = input.source === 'external' ? 'claimed' : 'draft';
  const createdAt = now();
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO settlements (id, tenant_id, kind, source, counterparty, amount_minor, currency, status,
                                evidence_ref, claimed_by, metadata_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '{}', ?, ?)`,
    ).bind(
      id,
      tenantId,
      input.kind,
      input.source,
      input.counterparty,
      input.amountMinor,
      input.currency ?? 'USD',
      status,
      input.evidenceRef ?? null,
      input.source === 'external' ? auth.userId : null,
      createdAt,
      createdAt,
    ),
    audit(env, auth, 'settlement.created', 'settlement', id, {
      source: input.source,
      kind: input.kind,
      amountMinor: input.amountMinor,
    }),
  ]);
  return getSettlement(env, tenantId, id);
}

export async function transitionSettlement(
  env: Env,
  auth: AuthContext,
  settlementId: string,
  next: 'pending_verification' | 'verified' | 'confirmed' | 'reconciled' | 'disputed' | 'reversed',
  input: { evidenceRef?: string; reason?: string } = {},
) {
  const tenantId = auth.tenantId;
  if (!tenantId) throw new ApiError(403, 'TENANT_REQUIRED', 'Tenant context required');
  const settlement = await getSettlement(env, tenantId, settlementId);
  const allowed = TRANSITIONS[settlement.status] ?? [];
  if (!allowed.includes(next)) {
    throw new ApiError(409, 'INVALID_TRANSITION', `Cannot move a settlement from ${settlement.status} to ${next}`);
  }

  const permissionByStep: Record<string, string> = {
    pending_verification: 'settlement:write',
    verified: 'settlement:verify',
    confirmed: 'settlement:approve',
    reconciled: 'settlement:approve',
    disputed: 'settlement:verify',
    reversed: 'settlement:approve',
  };
  if (!auth.permissions.has(permissionByStep[next] as never)) {
    throw new ApiError(403, 'FORBIDDEN', `Missing permission ${permissionByStep[next]}`);
  }

  const evidence = input.evidenceRef ?? settlement.evidence_ref ?? null;
  if ((next === 'verified' || next === 'confirmed') && !evidence) {
    throw new ApiError(400, 'EVIDENCE_REQUIRED', 'External settlement evidence is required before verification or confirmation');
  }
  if (next === 'verified' && settlement.claimed_by && settlement.claimed_by === auth.userId) {
    throw new ApiError(403, 'SEGREGATION_OF_DUTIES', 'The claimant cannot verify their own settlement');
  }
  if (next === 'confirmed' && settlement.verified_by && settlement.verified_by === auth.userId) {
    throw new ApiError(403, 'SEGREGATION_OF_DUTIES', 'The verifier cannot confirm the same settlement');
  }
  if (next === 'reversed' && !input.reason) throw new ApiError(400, 'REASON_REQUIRED', 'Reversal reason is required');

  if (next === 'confirmed') {
    const structure = await tenantStructure(env, tenantId);
    const decision = await evaluateTenantAction(env, {
      tenantId,
      jurisdictionCode: settlement.currency === 'USD' ? structure.tenant.jurisdiction_code : structure.tenant.jurisdiction_code,
      action: 'settlement_confirm',
      realMoneyEnabled: await realMoneyEnabled(env),
    });
    if (!decision.allowed) throw new ApiError(403, decision.code, decision.reason, { jurisdiction: decision.jurisdiction });
  }

  const at = now();
  const sets: string[] = ['status = ?', 'updated_at = ?'];
  const binds: unknown[] = [next, at];
  if (input.evidenceRef) {
    sets.push('evidence_ref = ?');
    binds.push(input.evidenceRef);
  }
  if (next === 'verified') {
    sets.push('verified_by = ?');
    binds.push(auth.userId);
  }
  if (next === 'confirmed') {
    sets.push('confirmed_at = ?');
    binds.push(at);
  }
  if (next === 'reconciled') {
    sets.push('reconciled_at = ?');
    binds.push(at);
  }
  if (next === 'reversed') {
    sets.push('reason = ?');
    binds.push(input.reason ?? null);
  }
  await env.DB.batch([
    env.DB.prepare(`UPDATE settlements SET ${sets.join(', ')} WHERE id = ? AND tenant_id = ?`).bind(...binds, settlementId, tenantId),
    audit(env, auth, `settlement.${next}`, 'settlement', settlementId, {
      previous: settlement.status,
      evidenceRef: evidence,
      reason: input.reason ?? null,
    }),
  ]);
  return getSettlement(env, tenantId, settlementId);
}

export async function getSettlement(env: Env, tenantId: string, id: string) {
  const row = await env.DB.prepare('SELECT * FROM settlements WHERE id = ? AND tenant_id = ?')
    .bind(id, tenantId)
    .first<{
      id: string;
      status: string;
      evidence_ref: string | null;
      claimed_by: string | null;
      verified_by: string | null;
      amount_minor: number;
      currency: string;
      [key: string]: unknown;
    }>();
  if (!row) throw new ApiError(404, 'SETTLEMENT_NOT_FOUND', 'Settlement not found');
  return row;
}

export async function listSettlements(env: Env, tenantId: string, limit = 100) {
  const rows = await env.DB.prepare(
    `SELECT id, kind, source, counterparty, amount_minor, currency, status, evidence_ref, claimed_by, verified_by,
            confirmed_at, reconciled_at, reason, created_at
     FROM settlements WHERE tenant_id = ? ORDER BY created_at DESC LIMIT ?`,
  )
    .bind(tenantId, limit)
    .all<Record<string, unknown>>();
  return rows.results ?? [];
}
