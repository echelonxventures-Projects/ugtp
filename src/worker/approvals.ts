import { ApiError, audit, can, newId, now, requirePermission, type AuthContext, type Env, type Permission } from './core';

/**
 * Approval workflow with segregation of duties.
 *
 * A requester can never approve their own request, and the approver must hold
 * the permission the action requires. Actions that move money or activate
 * credit are only executed after the approval resolves.
 */

export interface ApprovalRow {
  id: string;
  tenant_id: string;
  action: string;
  subject_type: string;
  subject_id: string;
  amount_minor: number | null;
  required_permission: string;
  status: 'pending' | 'approved' | 'rejected';
  requested_by: string;
  decided_by: string | null;
  created_at: number;
}

export async function openApproval(
  env: Env,
  auth: AuthContext,
  input: {
    action: string;
    subjectType: string;
    subjectId: string;
    amountMinor?: number;
    permission: Permission;
    metadata?: Record<string, unknown>;
  },
): Promise<string> {
  const tenantId = auth.tenantId;
  if (!tenantId) throw new ApiError(403, 'TENANT_REQUIRED', 'Tenant context required');
  const id = newId('apr');
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO approval_requests
       (id, tenant_id, action, subject_type, subject_id, amount_minor, required_permission, status, requested_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
    ).bind(
      id,
      tenantId,
      input.action,
      input.subjectType,
      input.subjectId,
      input.amountMinor ?? null,
      input.permission,
      auth.userId,
      now(),
    ),
    audit(env, auth, 'approval.requested', input.subjectType, input.subjectId, {
      approvalId: id,
      action: input.action,
      amountMinor: input.amountMinor ?? null,
      ...input.metadata,
    }),
  ]);
  return id;
}

export async function decideApproval(
  env: Env,
  auth: AuthContext,
  approvalId: string,
  approve: boolean,
  note?: string,
): Promise<ApprovalRow> {
  const tenantId = auth.tenantId;
  if (!tenantId) throw new ApiError(403, 'TENANT_REQUIRED', 'Tenant context required');
  const row = await env.DB.prepare(
    `SELECT id, tenant_id, action, subject_type, subject_id, amount_minor, required_permission, status, requested_by, decided_by, created_at
     FROM approval_requests WHERE id = ? AND tenant_id = ?`,
  )
    .bind(approvalId, tenantId)
    .first<ApprovalRow>();
  if (!row) throw new ApiError(404, 'APPROVAL_NOT_FOUND', 'Approval request not found');
  if (row.status !== 'pending') throw new ApiError(409, 'APPROVAL_RESOLVED', 'Approval request has already been decided');
  if (row.requested_by === auth.userId) {
    throw new ApiError(403, 'SEGREGATION_OF_DUTIES', 'The requester cannot decide their own approval');
  }
  requirePermission(auth, row.required_permission as Permission);
  if (!can(auth, row.required_permission as Permission)) {
    throw new ApiError(403, 'FORBIDDEN', 'Approver lacks the required permission');
  }

  const decidedAt = now();
  const decisions = JSON.stringify([{ by: auth.userId, decision: approve ? 'approved' : 'rejected', note: note ?? null, at: decidedAt }]);
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE approval_requests SET status = ?, decided_by = ?, decisions_json = ?, decided_at = ?
       WHERE id = ? AND tenant_id = ? AND status = 'pending'`,
    ).bind(approve ? 'approved' : 'rejected', auth.userId, decisions, decidedAt, approvalId, tenantId),
    audit(env, auth, approve ? 'approval.approved' : 'approval.rejected', row.subject_type, row.subject_id, {
      approvalId,
      action: row.action,
      note: note ?? null,
    }),
  ]);
  return { ...row, status: approve ? 'approved' : 'rejected', decided_by: auth.userId };
}

export async function findApproval(env: Env, tenantId: string, id: string): Promise<ApprovalRow | null> {
  return env.DB.prepare(
    `SELECT id, tenant_id, action, subject_type, subject_id, amount_minor, required_permission, status, requested_by, decided_by, created_at
     FROM approval_requests WHERE id = ? AND tenant_id = ?`,
  )
    .bind(id, tenantId)
    .first<ApprovalRow>();
}
