import { ApiError, type Env } from './core';

/**
 * Regulatory authorization policy.
 *
 * The platform never infers permission from a tenant flag, feature toggle or
 * customer-supplied licence claim. A regulated action is allowed only when a
 * jurisdiction profile has been assessed, permits the activity, AND an active,
 * verified licence covers it. Anything missing, expired, unknown or prohibited
 * denies the action. Legal authorization itself remains an accountable human
 * decision; this module enforces approved determinations.
 */

export type RegulatedAction =
  | 'deposit'
  | 'withdrawal'
  | 'wager_real'
  | 'redemption_monetary'
  | 'credit_issue'
  | 'affiliate_payout'
  | 'settlement_confirm';

export type PermissionState = 'permitted_with_licence' | 'prohibited' | 'unassessed';

export interface JurisdictionPolicy {
  code: string;
  name: string;
  money_gaming: PermissionState;
  affiliate_payout: PermissionState;
  credit: PermissionState;
  authority: string | null;
  legal_basis: string | null;
}

export interface LicencePolicy {
  id: string;
  status: string;
  valid_from: number;
  valid_to: number;
  activities: string[];
  gameCategories: string[];
  verified_at: number | null;
  jurisdiction_code: string;
  evidence_ref: string | null;
}

export interface PolicyDecision {
  allowed: boolean;
  code: string;
  reason: string;
  jurisdiction: string | null;
  licenceId: string | null;
}

const ACTIVITY_BY_ACTION: Record<RegulatedAction, string> = {
  deposit: 'deposit',
  withdrawal: 'withdrawal',
  wager_real: 'wager',
  redemption_monetary: 'redemption',
  credit_issue: 'credit',
  affiliate_payout: 'affiliate_payout',
  settlement_confirm: 'settlement',
};

const BASE_DENIAL: Omit<PolicyDecision, 'allowed' | 'code' | 'reason'> = {
  jurisdiction: null,
  licenceId: null,
};

function deny(code: string, reason: string, jurisdiction: string | null = null, licenceId: string | null = null): PolicyDecision {
  return { allowed: false, code, reason, jurisdiction, licenceId };
}

function areaFor(action: RegulatedAction, jurisdiction: JurisdictionPolicy): PermissionState {
  if (action === 'credit_issue') return jurisdiction.credit;
  if (action === 'affiliate_payout') return jurisdiction.affiliate_payout;
  return jurisdiction.money_gaming;
}

export function evaluatePolicy(input: {
  action: RegulatedAction;
  jurisdiction: JurisdictionPolicy | null;
  licence: LicencePolicy | null;
  realMoneyEnabled: boolean;
  at?: number;
  gameCategory?: string;
}): PolicyDecision {
  const at = input.at ?? Date.now();
  const jurisdictionCode = input.jurisdiction?.code ?? null;

  if (!input.realMoneyEnabled) {
    return deny('REAL_MONEY_DISABLED', 'Real-money processing is disabled at the platform level', jurisdictionCode);
  }
  if (!input.jurisdiction) {
    return deny('JURISDICTION_UNKNOWN', 'No assessed jurisdiction profile applies to this operation');
  }

  const area = areaFor(input.action, input.jurisdiction);
  if (area === 'prohibited') {
    return deny(
      'JURISDICTION_PROHIBITED',
      `${input.action} is prohibited in ${input.jurisdiction.code} by the assessed regulatory profile`,
      jurisdictionCode,
    );
  }
  if (area !== 'permitted_with_licence') {
    return deny(
      'JURISDICTION_UNASSESSED',
      `${input.jurisdiction.code} has not been assessed for ${input.action}; the platform fails closed`,
      jurisdictionCode,
    );
  }

  const licence = input.licence;
  if (!licence) {
    return deny('LICENCE_MISSING', `No licence covers ${input.action} in ${input.jurisdiction.code}`, jurisdictionCode);
  }
  if (licence.jurisdiction_code !== input.jurisdiction.code) {
    return deny('LICENCE_JURISDICTION_MISMATCH', 'Licence jurisdiction does not match the operating jurisdiction', jurisdictionCode, licence.id);
  }
  if (licence.status === 'revoked') {
    return deny('LICENCE_REVOKED', 'Licence has been revoked', jurisdictionCode, licence.id);
  }
  if (licence.status === 'suspended') {
    return deny('LICENCE_SUSPENDED', 'Licence is suspended', jurisdictionCode, licence.id);
  }
  if (licence.status !== 'active') {
    return deny('LICENCE_INACTIVE', `Licence status is ${licence.status}`, jurisdictionCode, licence.id);
  }
  if (!licence.verified_at) {
    return deny('LICENCE_UNVERIFIED', 'Licence evidence has not been verified by compliance', jurisdictionCode, licence.id);
  }
  if (at < licence.valid_from) {
    return deny('LICENCE_NOT_YET_VALID', 'Licence is not yet effective', jurisdictionCode, licence.id);
  }
  if (at > licence.valid_to) {
    return deny('LICENCE_EXPIRED', 'Licence has expired', jurisdictionCode, licence.id);
  }
  if (!licence.activities.includes(ACTIVITY_BY_ACTION[input.action])) {
    return deny(
      'ACTIVITY_NOT_LICENSED',
      `Licence does not cover the ${ACTIVITY_BY_ACTION[input.action]} activity`,
      jurisdictionCode,
      licence.id,
    );
  }
  if (input.gameCategory && !licence.gameCategories.includes(input.gameCategory)) {
    return deny(
      'GAME_CATEGORY_NOT_LICENSED',
      `Licence does not cover the ${input.gameCategory} game category`,
      jurisdictionCode,
      licence.id,
    );
  }
  return {
    allowed: true,
    code: 'ALLOWED',
    reason: 'Authorized by an active, verified licence',
    jurisdiction: jurisdictionCode,
    licenceId: licence.id,
  };
}

export async function loadJurisdiction(env: Env, code: string): Promise<JurisdictionPolicy | null> {
  const row = await env.DB.prepare(
    'SELECT code, name, money_gaming, affiliate_payout, credit, authority, legal_basis FROM jurisdictions WHERE code = ?',
  )
    .bind(code)
    .first<JurisdictionPolicy>();
  return row ?? null;
}

export async function loadLicence(env: Env, tenantId: string, jurisdictionCode: string): Promise<LicencePolicy | null> {
  const row = await env.DB.prepare(
    `SELECT id, status, valid_from, valid_to, activities_json, game_categories_json, verified_at, jurisdiction_code, evidence_ref
     FROM licences WHERE tenant_id = ? AND jurisdiction_code = ?
     ORDER BY CASE status WHEN 'active' THEN 0 WHEN 'suspended' THEN 1 WHEN 'revoked' THEN 2 ELSE 3 END,
              valid_to DESC LIMIT 1`,
  )
    .bind(tenantId, jurisdictionCode)
    .first<{
      id: string;
      status: string;
      valid_from: number;
      valid_to: number;
      activities_json: string;
      game_categories_json: string;
      verified_at: number | null;
      jurisdiction_code: string;
      evidence_ref: string | null;
    }>();
  if (!row) return null;
  let activities: string[] = [];
  let gameCategories: string[] = [];
  try {
    activities = JSON.parse(row.activities_json) as string[];
    gameCategories = JSON.parse(row.game_categories_json) as string[];
  } catch {
    activities = [];
    gameCategories = [];
  }
  return {
    id: row.id,
    status: row.status,
    valid_from: row.valid_from,
    valid_to: row.valid_to,
    activities,
    gameCategories,
    verified_at: row.verified_at,
    jurisdiction_code: row.jurisdiction_code,
    evidence_ref: row.evidence_ref,
  };
}

export interface PolicyEvaluation extends PolicyDecision {
  action: RegulatedAction;
}

export async function evaluateTenantAction(
  env: Env,
  input: {
    tenantId: string;
    jurisdictionCode: string;
    action: RegulatedAction;
    realMoneyEnabled: boolean;
    gameCategory?: string;
  },
): Promise<PolicyEvaluation> {
  const [jurisdiction, licence] = await Promise.all([
    loadJurisdiction(env, input.jurisdictionCode),
    loadLicence(env, input.tenantId, input.jurisdictionCode),
  ]);
  const decision = evaluatePolicy({
    action: input.action,
    jurisdiction,
    licence,
    realMoneyEnabled: input.realMoneyEnabled,
    gameCategory: input.gameCategory,
  });
  return { ...decision, action: input.action };
}

export function assertAllowed(decision: PolicyDecision): void {
  if (decision.allowed) return;
  throw new ApiError(403, decision.code, decision.reason, {
    jurisdiction: decision.jurisdiction,
    licenceId: decision.licenceId,
    action: decision.code,
  });
}

export function policyContext(details: unknown): unknown {
  return details ?? BASE_DENIAL;
}
