import { ApiError, audit, newId, now, type AuthContext, type Env } from './core';
import { createUser } from './auth';
import { ensureAccount, type AccountRef } from './ledger';

export interface PlayerRow {
  id: string;
  tenant_id: string;
  user_id: string;
  brand_id: string;
  agent_id: string | null;
  jurisdiction_code: string;
  kyc_status: string;
  status: string;
  self_exclusion_until: number | null;
  daily_deposit_limit: number | null;
  daily_wager_limit: number | null;
  created_at: number;
  email?: string;
  display_name?: string;
}

export async function playerAccounts(env: Env, tenantId: string, playerId: string): Promise<Record<string, string>> {
  const assets = await env.DB.prepare('SELECT code FROM assets').all<{ code: string }>();
  const out: Record<string, string> = {};
  for (const asset of assets.results ?? []) {
    out[asset.code] = await ensureAccount(env, {
      tenantId,
      ownerType: 'player',
      ownerId: playerId,
      assetCode: asset.code,
      kind: 'available',
    });
  }
  return out;
}

export async function getPlayer(env: Env, tenantId: string, playerId: string): Promise<PlayerRow> {
  const row = await env.DB.prepare(
    `SELECT p.*, u.email, u.display_name FROM players p JOIN users u ON u.id = p.user_id
     WHERE p.id = ? AND p.tenant_id = ?`,
  )
    .bind(playerId, tenantId)
    .first<PlayerRow>();
  if (!row) throw new ApiError(404, 'PLAYER_NOT_FOUND', 'Player not found in this tenant');
  return row;
}

export async function listPlayers(env: Env, tenantId: string, limit = 100) {
  const rows = await env.DB.prepare(
    `SELECT p.id, p.user_id, p.jurisdiction_code, p.kyc_status, p.status, p.agent_id, p.created_at,
            u.email, u.display_name,
            COALESCE((SELECT b.balance_minor FROM accounts a JOIN account_balances b ON b.account_id = a.id
                      WHERE a.tenant_id = p.tenant_id AND a.owner_type='player' AND a.owner_id = p.id AND a.asset_code='USD' AND a.kind='available'), 0) AS usd_minor,
            COALESCE((SELECT b.balance_minor FROM accounts a JOIN account_balances b ON b.account_id = a.id
                      WHERE a.tenant_id = p.tenant_id AND a.owner_type='player' AND a.owner_id = p.id AND a.asset_code='XCR' AND a.kind='available'), 0) AS xcr_minor
     FROM players p JOIN users u ON u.id = p.user_id
     WHERE p.tenant_id = ? ORDER BY p.created_at DESC LIMIT ?`,
  )
    .bind(tenantId, limit)
    .all<Record<string, unknown>>();
  return rows.results ?? [];
}

export async function createPlayer(
  env: Env,
  auth: AuthContext,
  input: {
    email: string;
    password: string;
    displayName: string;
    brandId: string;
    jurisdictionCode: string;
    dateOfBirth?: string;
    agentId?: string | null;
    kycStatus?: 'unverified' | 'pending' | 'verified';
    playCredits?: number;
  },
) {
  const tenantId = auth.tenantId;
  if (!tenantId) throw new ApiError(403, 'TENANT_REQUIRED', 'Tenant context required');
  const brand = await env.DB.prepare('SELECT id FROM brands WHERE id = ? AND tenant_id = ?')
    .bind(input.brandId, tenantId)
    .first<{ id: string }>();
  if (!brand) throw new ApiError(400, 'BRAND_NOT_FOUND', 'Brand does not belong to this tenant');
  const jurisdiction = await env.DB.prepare('SELECT code FROM jurisdictions WHERE code = ?')
    .bind(input.jurisdictionCode)
    .first<{ code: string }>();
  if (!jurisdiction) throw new ApiError(400, 'JURISDICTION_UNKNOWN', 'Unknown jurisdiction profile');

  if (input.agentId) {
    const agent = await env.DB.prepare('SELECT id FROM agents WHERE id = ? AND tenant_id = ? AND status = ?')
      .bind(input.agentId, tenantId, 'active')
      .first<{ id: string }>();
    if (!agent) throw new ApiError(400, 'AGENT_INVALID', 'Agent is not active in this tenant');
  }

  const existing = await env.DB.prepare('SELECT id FROM users WHERE email = ?').bind(input.email.toLowerCase()).first();
  if (existing) throw new ApiError(409, 'EMAIL_IN_USE', 'An account with this email already exists');

  const user = await createUser(env, {
    tenantId,
    email: input.email,
    password: input.password,
    displayName: input.displayName,
    role: 'player',
    userType: 'player',
    countryCode: input.jurisdictionCode,
    kycStatus: input.kycStatus ?? 'unverified',
  });
  const playerId = newId('ply');
  await env.DB.prepare(
    `INSERT INTO players (id, tenant_id, user_id, brand_id, agent_id, jurisdiction_code, date_of_birth, kyc_status, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?)`,
  )
    .bind(
      playerId,
      tenantId,
      user.id,
      input.brandId,
      input.agentId ?? null,
      input.jurisdictionCode,
      input.dateOfBirth ?? null,
      input.kycStatus ?? 'unverified',
      now(),
    )
    .run();
  const accounts = await playerAccounts(env, tenantId, playerId);

  if (input.playCredits && input.playCredits > 0) {
    const external = await ensureAccount(env, {
      tenantId,
      ownerType: 'external',
      ownerId: 'play-issuance',
      assetCode: 'XCR',
      kind: 'clearing',
      allowNegative: true,
    });
    const { post } = await import('./ledger');
    await post(env, auth, {
      kind: 'play_credit.issuance',
      idempotencyKey: `play-issuance:${playerId}`,
      entries: [
        { accountId: external, assetCode: 'XCR', amountMinor: -input.playCredits },
        { accountId: accounts['XCR'], assetCode: 'XCR', amountMinor: input.playCredits },
      ],
      metadata: { playerId, reason: 'sandbox play credit' },
    });
  }
  await audit(env, auth, 'player.created', 'player', playerId, { email: user.email, jurisdiction: input.jurisdictionCode });
  return { playerId, userId: user.id, email: user.email, accounts };
}

export async function updatePlayer(
  env: Env,
  auth: AuthContext,
  playerId: string,
  patch: {
    status?: 'active' | 'suspended' | 'self_excluded' | 'closed';
    kycStatus?: 'unverified' | 'pending' | 'verified' | 'rejected';
    selfExclusionUntil?: number | null;
    dailyDepositLimit?: number | null;
    dailyWagerLimit?: number | null;
  },
) {
  const tenantId = auth.tenantId;
  if (!tenantId) throw new ApiError(403, 'TENANT_REQUIRED', 'Tenant context required');
  await getPlayer(env, tenantId, playerId);
  const sets: string[] = [];
  const binds: unknown[] = [];
  if (patch.status) {
    sets.push('status = ?');
    binds.push(patch.status);
  }
  if (patch.kycStatus) {
    sets.push('kyc_status = ?');
    binds.push(patch.kycStatus);
  }
  if (patch.selfExclusionUntil !== undefined) {
    sets.push('self_exclusion_until = ?');
    binds.push(patch.selfExclusionUntil);
  }
  if (patch.dailyDepositLimit !== undefined) {
    sets.push('daily_deposit_limit = ?');
    binds.push(patch.dailyDepositLimit);
  }
  if (patch.dailyWagerLimit !== undefined) {
    sets.push('daily_wager_limit = ?');
    binds.push(patch.dailyWagerLimit);
  }
  if (!sets.length) throw new ApiError(400, 'NO_CHANGES', 'No fields to update');
  await env.DB.batch([
    env.DB.prepare(`UPDATE players SET ${sets.join(', ')} WHERE id = ? AND tenant_id = ?`).bind(...binds, playerId, tenantId),
    audit(env, auth, 'player.updated', 'player', playerId, patch as Record<string, unknown>),
  ]);
  return getPlayer(env, tenantId, playerId);
}

export async function playerWallet(env: Env, tenantId: string, playerId: string) {
  const accounts = await env.DB.prepare(
    `SELECT a.asset_code, a.id, COALESCE(b.balance_minor, 0) AS balance_minor, ast.monetary, ast.classification
     FROM accounts a
     LEFT JOIN account_balances b ON b.account_id = a.id
     JOIN assets ast ON ast.code = a.asset_code
     WHERE a.tenant_id = ? AND a.owner_type = 'player' AND a.owner_id = ? AND a.kind IN ('available','held')
     ORDER BY a.asset_code, a.kind`,
  )
    .bind(tenantId, playerId)
    .all<{ asset_code: string; id: string; balance_minor: number; monetary: number; classification: string }>();
  return accounts.results ?? [];
}

export async function assertPlayerEligible(env: Env, player: PlayerRow): Promise<void> {
  const current = now();
  if (player.self_exclusion_until && player.self_exclusion_until > current) {
    throw new ApiError(403, 'SELF_EXCLUDED', 'Player is self-excluded and cannot transact', {
      until: player.self_exclusion_until,
    });
  }
  if (player.self_exclusion_until && player.self_exclusion_until <= current) {
    await env.DB.prepare(`UPDATE players SET status = 'active', self_exclusion_until = NULL WHERE id = ?`).bind(player.id).run();
    player.status = 'active';
    player.self_exclusion_until = null;
  }
  if (player.status !== 'active') {
    throw new ApiError(403, 'PLAYER_INACTIVE', `Player status is ${player.status}`);
  }
}
