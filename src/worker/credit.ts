import { ApiError, audit, newId, now, realMoneyEnabled, settingNumber, type AuthContext, type Env } from './core';
import { openApproval } from './approvals';
import { ensureAccount, post } from './ledger';
import { tenantStructure } from './orgs';
import { evaluateTenantAction } from './policy';

/**
 * Credit facilities for agents and players. Draws are bounded by the approved
 * limit and outstanding exposure, recorded as ledger transactions against a
 * credit receivable account, and above the configured threshold require an
 * approval by a different operator.
 */

export async function createFacility(
  env: Env,
  auth: AuthContext,
  input: { subjectType: 'player' | 'agent'; subjectId: string; limitMinor: number; policyRef: string },
) {
  const tenantId = auth.tenantId;
  if (!tenantId) throw new ApiError(403, 'TENANT_REQUIRED', 'Tenant context required');
  if (!Number.isSafeInteger(input.limitMinor) || input.limitMinor <= 0) {
    throw new ApiError(400, 'INVALID_LIMIT', 'Credit limit must be a positive integer');
  }
  const table = input.subjectType === 'player' ? 'players' : 'agents';
  const subject = await env.DB.prepare(`SELECT id FROM ${table} WHERE id = ? AND tenant_id = ?`)
    .bind(input.subjectId, tenantId)
    .first<{ id: string }>();
  if (!subject) throw new ApiError(404, 'SUBJECT_NOT_FOUND', `No ${input.subjectType} with that id in this tenant`);

  const structure = await tenantStructure(env, tenantId);
  const decision = await evaluateTenantAction(env, {
    tenantId,
    jurisdictionCode: structure.tenant.jurisdiction_code,
    action: 'credit_issue',
    realMoneyEnabled: await realMoneyEnabled(env),
  });
  if (!decision.allowed) throw new ApiError(403, decision.code, decision.reason, { jurisdiction: decision.jurisdiction });

  const id = newId('crf');
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO credit_facilities (id, tenant_id, subject_type, subject_id, currency, limit_minor, status, policy_ref, requested_by, created_at)
       VALUES (?, ?, ?, ?, 'USD', ?, 'pending_approval', ?, ?, ?)`,
    ).bind(id, tenantId, input.subjectType, input.subjectId, input.limitMinor, input.policyRef, auth.userId, now()),
    audit(env, auth, 'credit.facility_requested', 'credit_facility', id, {
      subjectType: input.subjectType,
      subjectId: input.subjectId,
      limitMinor: input.limitMinor,
    }),
  ]);
  return getFacility(env, tenantId, id);
}

export async function activateFacility(env: Env, auth: AuthContext, facilityId: string) {
  const tenantId = auth.tenantId;
  if (!tenantId) throw new ApiError(403, 'TENANT_REQUIRED', 'Tenant context required');
  if (!auth.permissions.has('credit:approve')) throw new ApiError(403, 'FORBIDDEN', 'Credit approval permission required');
  const facility = await getFacility(env, tenantId, facilityId);
  if (facility.requested_by === auth.userId) {
    throw new ApiError(403, 'SEGREGATION_OF_DUTIES', 'The requester cannot approve their own credit facility');
  }
  if (facility.status !== 'pending_approval') throw new ApiError(409, 'INVALID_STATE', `Facility is ${facility.status}`);
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE credit_facilities SET status = 'active', approved_by = ? WHERE id = ? AND tenant_id = ? AND status = 'pending_approval'`,
    ).bind(auth.userId, facilityId, tenantId),
    audit(env, auth, 'credit.facility_activated', 'credit_facility', facilityId, { approvedBy: auth.userId }),
  ]);
  return getFacility(env, tenantId, facilityId);
}

export async function outstandingFor(env: Env, tenantId: string, facilityId: string): Promise<number> {
  const row = await env.DB.prepare(
    `SELECT COALESCE(SUM(CASE WHEN kind = 'draw' THEN amount_minor WHEN kind IN ('repay','write_off') THEN -amount_minor ELSE 0 END), 0) AS n
     FROM credit_events WHERE tenant_id = ? AND facility_id = ? AND status = 'posted'`,
  )
    .bind(tenantId, facilityId)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

export async function drawCredit(
  env: Env,
  auth: AuthContext,
  input: { facilityId: string; amountMinor: number; reason: string },
) {
  const tenantId = auth.tenantId;
  if (!tenantId) throw new ApiError(403, 'TENANT_REQUIRED', 'Tenant context required');
  const facility = await getFacility(env, tenantId, input.facilityId);
  if (facility.status !== 'active') throw new ApiError(409, 'FACILITY_INACTIVE', `Facility is ${facility.status}`);
  if (!Number.isSafeInteger(input.amountMinor) || input.amountMinor <= 0) {
    throw new ApiError(400, 'INVALID_AMOUNT', 'Draw amount must be a positive integer');
  }
  const outstanding = await outstandingFor(env, tenantId, input.facilityId);
  if (outstanding + input.amountMinor > facility.limit_minor) {
    throw new ApiError(409, 'CREDIT_LIMIT_EXCEEDED', 'Draw would exceed the approved credit limit', {
      limit: facility.limit_minor,
      outstanding,
    });
  }

  const structure = await tenantStructure(env, tenantId);
  const decision = await evaluateTenantAction(env, {
    tenantId,
    jurisdictionCode: structure.tenant.jurisdiction_code,
    action: 'credit_issue',
    realMoneyEnabled: await realMoneyEnabled(env),
  });
  if (!decision.allowed) throw new ApiError(403, decision.code, decision.reason, { jurisdiction: decision.jurisdiction });

  const threshold = await settingNumber(env, 'credit_draw_approval_threshold_minor', 50_000);
  if (input.amountMinor > threshold) {
    const approvalId = await openApproval(env, auth, {
      action: 'credit.draw',
      subjectType: 'credit_facility',
      subjectId: input.facilityId,
      amountMinor: input.amountMinor,
      permission: 'credit:approve',
      metadata: { reason: input.reason },
    });
    return { status: 'pending_approval', approvalId };
  }

  const eventId = await executeDraw(env, auth, input.facilityId, input.amountMinor, input.reason, `credit-draw:${newId('req')}`);
  return { status: 'posted', creditEventId: eventId };
}

export async function executeDraw(
  env: Env,
  auth: AuthContext,
  facilityId: string,
  amountMinor: number,
  reason: string,
  idempotencyKey: string,
): Promise<string> {
  const tenantId = auth.tenantId!;
  const facility = await getFacility(env, tenantId, facilityId);
  const outstanding = await outstandingFor(env, tenantId, facilityId);
  if (outstanding + amountMinor > facility.limit_minor) {
    throw new ApiError(409, 'CREDIT_LIMIT_EXCEEDED', 'Draw would exceed the approved credit limit');
  }
  const ownerType = facility.subject_type === 'player' ? 'player' : 'agent';
  const available = await ensureAccount(env, {
    tenantId,
    ownerType,
    ownerId: facility.subject_id,
    assetCode: 'USD',
    kind: 'available',
  });
  const receivable = await ensureAccount(env, {
    tenantId,
    ownerType: 'platform',
    ownerId: 'credit',
    assetCode: 'USD',
    kind: 'receivable',
    allowNegative: true,
  });
  const eventId = newId('cre');
  await post(env, auth, {
    kind: 'credit.draw',
    idempotencyKey,
    entries: [
      { accountId: available, assetCode: 'USD', amountMinor: amountMinor },
      { accountId: receivable, assetCode: 'USD', amountMinor: -amountMinor },
    ],
    metadata: { facilityId, reason, subjectType: facility.subject_type, subjectId: facility.subject_id },
    extra: [
      env.DB.prepare(
        `INSERT INTO credit_events (id, tenant_id, facility_id, kind, amount_minor, status, idempotency_key, reason, created_at)
         VALUES (?, ?, ?, 'draw', ?, 'posted', ?, ?, ?)`,
      ).bind(eventId, tenantId, facilityId, amountMinor, idempotencyKey, reason, now()),
      audit(env, auth, 'credit.draw', 'credit_facility', facilityId, { amountMinor, reason }),
    ],
  });
  return eventId;
}

export async function repayCredit(
  env: Env,
  auth: AuthContext,
  input: { facilityId: string; amountMinor: number; reason?: string; idempotencyKey: string },
) {
  const tenantId = auth.tenantId;
  if (!tenantId) throw new ApiError(403, 'TENANT_REQUIRED', 'Tenant context required');
  const facility = await getFacility(env, tenantId, input.facilityId);
  const outstanding = await outstandingFor(env, tenantId, input.facilityId);
  if (!Number.isSafeInteger(input.amountMinor) || input.amountMinor <= 0) {
    throw new ApiError(400, 'INVALID_AMOUNT', 'Repayment must be a positive integer');
  }
  if (input.amountMinor > outstanding) {
    throw new ApiError(409, 'REPAYMENT_EXCEEDS_EXPOSURE', 'Repayment exceeds the outstanding credit balance', { outstanding });
  }
  const ownerType = facility.subject_type === 'player' ? 'player' : 'agent';
  const available = await ensureAccount(env, {
    tenantId,
    ownerType,
    ownerId: facility.subject_id,
    assetCode: 'USD',
    kind: 'available',
  });
  const receivable = await ensureAccount(env, {
    tenantId,
    ownerType: 'platform',
    ownerId: 'credit',
    assetCode: 'USD',
    kind: 'receivable',
    allowNegative: true,
  });
  const eventId = newId('cre');
  await post(env, auth, {
    kind: 'credit.repay',
    idempotencyKey: input.idempotencyKey,
    entries: [
      { accountId: available, assetCode: 'USD', amountMinor: -input.amountMinor },
      { accountId: receivable, assetCode: 'USD', amountMinor: input.amountMinor },
    ],
    metadata: { facilityId: input.facilityId, reason: input.reason ?? 'repayment' },
    extra: [
      env.DB.prepare(
        `INSERT INTO credit_events (id, tenant_id, facility_id, kind, amount_minor, status, idempotency_key, reason, created_at)
         VALUES (?, ?, ?, 'repay', ?, 'posted', ?, ?, ?)`,
      ).bind(eventId, tenantId, input.facilityId, input.amountMinor, input.idempotencyKey, input.reason ?? null, now()),
      audit(env, auth, 'credit.repay', 'credit_facility', input.facilityId, { amountMinor: input.amountMinor }),
    ],
  });
  return { status: 'posted', creditEventId: eventId, outstanding: await outstandingFor(env, tenantId, input.facilityId) };
}

export async function getFacility(env: Env, tenantId: string, id: string) {
  const row = await env.DB.prepare('SELECT * FROM credit_facilities WHERE id = ? AND tenant_id = ?')
    .bind(id, tenantId)
    .first<{
      id: string;
      tenant_id: string;
      subject_type: 'player' | 'agent';
      subject_id: string;
      limit_minor: number;
      status: string;
      requested_by: string | null;
      approved_by: string | null;
      policy_ref: string;
      [key: string]: unknown;
    }>();
  if (!row) throw new ApiError(404, 'FACILITY_NOT_FOUND', 'Credit facility not found');
  return row;
}

export async function listFacilities(env: Env, tenantId: string) {
  const rows = await env.DB.prepare(
    `SELECT f.id, f.subject_type, f.subject_id, f.limit_minor, f.status, f.policy_ref, f.requested_by, f.approved_by, f.created_at,
            COALESCE((SELECT SUM(CASE WHEN e.kind = 'draw' THEN e.amount_minor WHEN e.kind IN ('repay','write_off') THEN -e.amount_minor ELSE 0 END)
                      FROM credit_events e WHERE e.facility_id = f.id AND e.status = 'posted'), 0) AS outstanding_minor
     FROM credit_facilities f WHERE f.tenant_id = ? ORDER BY f.created_at DESC`,
  )
    .bind(tenantId)
    .all<Record<string, unknown>>();
  return rows.results ?? [];
}

export async function executeApprovedDraw(
  env: Env,
  auth: AuthContext,
  facilityId: string,
  amountMinor: number,
  approvalId: string,
  reason: string,
) {
  return executeDraw(env, auth, facilityId, amountMinor, reason, `credit-draw-approval:${approvalId}`);
}
