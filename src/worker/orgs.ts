import { ApiError, audit, newId, now, type AuthContext, type Env } from './core';

export interface TenantRow {
  id: string;
  name: string;
  kind: string;
  status: string;
  jurisdiction_code: string;
  settings_json: string;
  created_at: number;
}

export interface TenantStructure {
  tenant: TenantRow;
  legalEntityId: string;
  operatorId: string;
  brandId: string;
}

export async function tenantStructure(env: Env, tenantId: string): Promise<TenantStructure> {
  const tenant = await env.DB.prepare(
    'SELECT id, name, kind, status, jurisdiction_code, settings_json, created_at FROM tenants WHERE id = ?',
  )
    .bind(tenantId)
    .first<TenantRow>();
  if (!tenant) throw new ApiError(404, 'TENANT_NOT_FOUND', 'Tenant not found');
  const legal = await env.DB.prepare('SELECT id FROM legal_entities WHERE tenant_id = ? ORDER BY created_at LIMIT 1')
    .bind(tenantId)
    .first<{ id: string }>();
  const operator = await env.DB.prepare('SELECT id FROM operators WHERE tenant_id = ? ORDER BY created_at LIMIT 1')
    .bind(tenantId)
    .first<{ id: string }>();
  const brand = await env.DB.prepare('SELECT id FROM brands WHERE tenant_id = ? ORDER BY created_at LIMIT 1')
    .bind(tenantId)
    .first<{ id: string }>();
  if (!legal || !operator || !brand) throw new ApiError(409, 'TENANT_INCOMPLETE', 'Tenant organization is incomplete');
  return { tenant, legalEntityId: legal.id, operatorId: operator.id, brandId: brand.id };
}

export async function createTenant(
  env: Env,
  auth: AuthContext,
  input: { name: string; jurisdictionCode: string; legalEntityName?: string; brandName?: string; kind?: 'operator' | 'demo' | 'internal' },
): Promise<TenantStructure> {
  if (auth.role !== 'platform_admin') throw new ApiError(403, 'FORBIDDEN', 'Only platform administrators may create tenants');
  const jurisdiction = await env.DB.prepare('SELECT code FROM jurisdictions WHERE code = ?')
    .bind(input.jurisdictionCode)
    .first<{ code: string }>();
  if (!jurisdiction) throw new ApiError(400, 'JURISDICTION_UNKNOWN', 'Unknown jurisdiction profile');

  const tenantId = newId('ten');
  const legalEntityId = newId('ent');
  const operatorId = newId('opr');
  const brandId = newId('brd');
  const createdAt = now();
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO tenants (id, name, kind, status, jurisdiction_code, settings_json, created_at)
       VALUES (?, ?, ?, 'active', ?, '{}', ?)`,
    ).bind(tenantId, input.name, input.kind ?? 'operator', input.jurisdictionCode, createdAt),
    env.DB.prepare(
      `INSERT INTO legal_entities (id, tenant_id, name, jurisdiction_code, status, created_at)
       VALUES (?, ?, ?, ?, 'active', ?)`,
    ).bind(legalEntityId, tenantId, input.legalEntityName ?? `${input.name} Ltd`, input.jurisdictionCode, createdAt),
    env.DB.prepare(
      `INSERT INTO operators (id, tenant_id, legal_entity_id, name, status, created_at)
       VALUES (?, ?, ?, ?, 'active', ?)`,
    ).bind(operatorId, tenantId, legalEntityId, input.name, createdAt),
    env.DB.prepare(
      `INSERT INTO brands (id, tenant_id, operator_id, name, status, created_at)
       VALUES (?, ?, ?, ?, 'active', ?)`,
    ).bind(brandId, tenantId, operatorId, input.brandName ?? `${input.name} Casino`, createdAt),
    audit(env, auth, 'tenant.created', 'tenant', tenantId, { jurisdiction: input.jurisdictionCode, name: input.name }),
  ]);
  return {
    tenant: {
      id: tenantId,
      name: input.name,
      kind: input.kind ?? 'operator',
      status: 'active',
      jurisdiction_code: input.jurisdictionCode,
      settings_json: '{}',
      created_at: createdAt,
    },
    legalEntityId,
    operatorId,
    brandId,
  };
}

export async function listTenants(env: Env, auth: AuthContext): Promise<TenantRow[]> {
  if (auth.role !== 'platform_admin') {
    if (!auth.tenantId) return [];
    const rows = await env.DB.prepare(
      'SELECT id, name, kind, status, jurisdiction_code, settings_json, created_at FROM tenants WHERE id = ?',
    )
      .bind(auth.tenantId)
      .all<TenantRow>();
    return rows.results ?? [];
  }
  const rows = await env.DB.prepare(
    'SELECT id, name, kind, status, jurisdiction_code, settings_json, created_at FROM tenants ORDER BY created_at',
  ).all<TenantRow>();
  return rows.results ?? [];
}

export async function tenantOverview(env: Env, tenantId: string) {
  const [players, agents, wagered, houseRevenue, pendingPayments, ledger] = await Promise.all([
    env.DB.prepare('SELECT COUNT(*) AS n FROM players WHERE tenant_id = ?').bind(tenantId).first<{ n: number }>(),
    env.DB.prepare('SELECT COUNT(*) AS n FROM agents WHERE tenant_id = ?').bind(tenantId).first<{ n: number }>(),
    env.DB.prepare('SELECT COALESCE(SUM(stake_minor),0) AS n FROM rounds WHERE tenant_id = ?').bind(tenantId).first<{ n: number }>(),
    env.DB.prepare(
      `SELECT COALESCE(SUM(p.amount_minor),0) AS n FROM postings p
       JOIN accounts a ON a.id = p.account_id
       WHERE p.tenant_id = ? AND a.owner_type = 'platform' AND a.kind = 'revenue'`,
    )
      .bind(tenantId)
      .first<{ n: number }>(),
    env.DB.prepare(
      `SELECT COUNT(*) AS n, COALESCE(SUM(amount_minor),0) AS total FROM payments WHERE tenant_id = ? AND status = 'pending_approval'`,
    )
      .bind(tenantId)
      .first<{ n: number; total: number }>(),
    env.DB.prepare(`SELECT COUNT(*) AS n FROM postings p WHERE p.tenant_id = ?`).bind(tenantId).first<{ n: number }>(),
  ]);
  const unbalanced = await env.DB.prepare(
    `SELECT asset_code FROM postings WHERE tenant_id = ? GROUP BY asset_code HAVING SUM(amount_minor) <> 0`,
  )
    .bind(tenantId)
    .all<{ asset_code: string }>();
  const recent = await env.DB.prepare(
    `SELECT id, game_code, stake_minor, payout_minor, status, created_at FROM rounds WHERE tenant_id = ? ORDER BY created_at DESC LIMIT 8`,
  )
    .bind(tenantId)
    .all<{ id: string; game_code: string; stake_minor: number; payout_minor: number; status: string; created_at: number }>();
  return {
    players: players?.n ?? 0,
    agents: agents?.n ?? 0,
    wageredMinor: wagered?.n ?? 0,
    grossGamingRevenueMinor: -(houseRevenue?.n ?? 0),
    pendingWithdrawals: pendingPayments?.n ?? 0,
    pendingWithdrawalMinor: pendingPayments?.total ?? 0,
    postings: ledger?.n ?? 0,
    ledgerBalanced: (unbalanced.results ?? []).length === 0,
    recentRounds: recent.results ?? [],
  };
}
