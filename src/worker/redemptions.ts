import { ApiError, audit, newId, now, realMoneyEnabled, type AuthContext, type Env } from './core';
import { ensureAccount, post } from './ledger';
import { evaluateTenantAction } from './policy';
import { assertPlayerEligible, getPlayer } from './players';

/**
 * Redemption converts a redeemable monetary asset into a fiat payout. The asset
 * must be explicitly classified as monetary and redeemable; non-monetary play
 * credits can never be converted into money through this path.
 */

export async function requestRedemption(
  env: Env,
  auth: AuthContext,
  input: { playerId: string; assetCode: string; units: number },
) {
  const tenantId = auth.tenantId;
  if (!tenantId) throw new ApiError(403, 'TENANT_REQUIRED', 'Tenant context required');
  if (!Number.isSafeInteger(input.units) || input.units <= 0) {
    throw new ApiError(400, 'INVALID_AMOUNT', 'Redemption units must be a positive integer');
  }

  const asset = await env.DB.prepare(
    'SELECT code, name, classification, monetary, redeemable, conversion_rate_minor FROM assets WHERE code = ?',
  )
    .bind(input.assetCode)
    .first<{ code: string; name: string; classification: string; monetary: number; redeemable: number; conversion_rate_minor: number }>();
  if (!asset) throw new ApiError(400, 'ASSET_UNKNOWN', 'Unknown asset');
  if (!asset.monetary) {
    throw new ApiError(400, 'ASSET_NOT_MONETARY', 'Non-monetary assets cannot be redeemed for money');
  }
  if (!asset.redeemable) throw new ApiError(400, 'ASSET_NOT_REDEEMABLE', 'This asset is not redeemable');
  if (asset.code !== 'USD') {
    throw new ApiError(400, 'ASSET_UNSUPPORTED', 'Only the base monetary asset can be redeemed until an FX conversion pipeline is authorized');
  }
  const amountMinor = input.units;

  const player = await getPlayer(env, tenantId, input.playerId);
  await assertPlayerEligible(env, player);
  if (player.kyc_status !== 'verified') throw new ApiError(403, 'KYC_REQUIRED', 'Redemption requires a verified identity');

  const decision = await evaluateTenantAction(env, {
    tenantId,
    jurisdictionCode: player.jurisdiction_code,
    action: 'redemption_monetary',
    realMoneyEnabled: await realMoneyEnabled(env),
  });
  if (!decision.allowed) throw new ApiError(403, decision.code, decision.reason, { jurisdiction: decision.jurisdiction });

  const available = await ensureAccount(env, {
    tenantId,
    ownerType: 'player',
    ownerId: player.id,
    assetCode: 'USD',
    kind: 'available',
  });
  const held = await ensureAccount(env, {
    tenantId,
    ownerType: 'player',
    ownerId: player.id,
    assetCode: 'USD',
    kind: 'held',
  });

  const redemptionId = newId('rdm');
  const createdAt = now();
  await post(env, auth, {
    kind: 'redemption.hold',
    idempotencyKey: `redemption-hold:${redemptionId}`,
    entries: [
      { accountId: available, assetCode: 'USD', amountMinor: -amountMinor },
      { accountId: held, assetCode: 'USD', amountMinor: amountMinor },
    ],
    metadata: { redemptionId, playerId: player.id, units: input.units },
    extra: [
      env.DB.prepare(
        `INSERT INTO redemptions (id, tenant_id, player_id, asset_code, units, conversion_rate_minor, amount_minor, status,
                                  jurisdiction_code, licence_id, requested_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'pending_approval', ?, ?, ?, ?, ?)`,
      ).bind(
        redemptionId,
        tenantId,
        player.id,
        asset.code,
        input.units,
        asset.conversion_rate_minor,
        amountMinor,
        player.jurisdiction_code,
        decision.licenceId,
        auth.userId,
        createdAt,
        createdAt,
      ),
      audit(env, auth, 'redemption.requested', 'redemption', redemptionId, {
        playerId: player.id,
        amountMinor,
        asset: asset.code,
      }),
    ],
  });
  return getRedemption(env, tenantId, redemptionId);
}

export async function decideRedemption(env: Env, auth: AuthContext, redemptionId: string, approve: boolean) {
  const tenantId = auth.tenantId;
  if (!tenantId) throw new ApiError(403, 'TENANT_REQUIRED', 'Tenant context required');
  if (!auth.permissions.has('redemption:approve')) {
    throw new ApiError(403, 'FORBIDDEN', 'Redemption approval permission required');
  }
  const redemption = await getRedemption(env, tenantId, redemptionId);
  if (redemption.status !== 'pending_approval') throw new ApiError(409, 'INVALID_STATE', `Redemption is ${redemption.status}`);
  if (redemption.requested_by === auth.userId) {
    throw new ApiError(403, 'SEGREGATION_OF_DUTIES', 'The requester cannot approve their own redemption');
  }

  const held = await ensureAccount(env, {
    tenantId,
    ownerType: 'player',
    ownerId: redemption.player_id,
    assetCode: 'USD',
    kind: 'held',
  });
  const available = await ensureAccount(env, {
    tenantId,
    ownerType: 'player',
    ownerId: redemption.player_id,
    assetCode: 'USD',
    kind: 'available',
  });

  if (!approve) {
    await post(env, auth, {
      kind: 'redemption.release',
      idempotencyKey: `redemption-release:${redemptionId}`,
      entries: [
        { accountId: held, assetCode: 'USD', amountMinor: -redemption.amount_minor },
        { accountId: available, assetCode: 'USD', amountMinor: redemption.amount_minor },
      ],
      metadata: { redemptionId },
      extra: [
        env.DB.prepare(`UPDATE redemptions SET status = 'rejected', updated_at = ? WHERE id = ? AND status = 'pending_approval'`)
          .bind(now(), redemptionId),
        audit(env, auth, 'redemption.rejected', 'redemption', redemptionId, {}),
      ],
    });
    return getRedemption(env, tenantId, redemptionId);
  }

  const psplayer = await getPlayer(env, tenantId, redemption.player_id);
  const decision = await evaluateTenantAction(env, {
    tenantId,
    jurisdictionCode: psplayer.jurisdiction_code,
    action: 'redemption_monetary',
    realMoneyEnabled: await realMoneyEnabled(env),
  });
  if (!decision.allowed) throw new ApiError(403, decision.code, decision.reason, { jurisdiction: decision.jurisdiction });

  const external = await ensureAccount(env, {
    tenantId,
    ownerType: 'external',
    ownerId: 'psp:sandbox',
    assetCode: 'USD',
    kind: 'clearing',
    allowNegative: true,
  });
  const txnId = newId('txn');
  await post(env, auth, {
    kind: 'redemption.payout',
    txnId,
    idempotencyKey: `redemption-payout:${redemptionId}`,
    entries: [
      { accountId: held, assetCode: 'USD', amountMinor: -redemption.amount_minor },
      { accountId: external, assetCode: 'USD', amountMinor: redemption.amount_minor },
    ],
    metadata: { redemptionId, approver: auth.userId },
    extra: [
      env.DB.prepare(
        `UPDATE redemptions SET status = 'paid', approved_by = ?, evidence_ref = ?, updated_at = ?
         WHERE id = ? AND status = 'pending_approval'`,
      ).bind(auth.userId, `sbx_rdm_${redemptionId}`, now(), redemptionId),
      audit(env, auth, 'redemption.paid', 'redemption', redemptionId, { amountMinor: redemption.amount_minor }),
    ],
  });
  return getRedemption(env, tenantId, redemptionId);
}

export async function getRedemption(env: Env, tenantId: string, id: string) {
  const row = await env.DB.prepare('SELECT * FROM redemptions WHERE id = ? AND tenant_id = ?')
    .bind(id, tenantId)
    .first<{ id: string; status: string; amount_minor: number; player_id: string; requested_by: string | null; [key: string]: unknown }>();
  if (!row) throw new ApiError(404, 'REDEMPTION_NOT_FOUND', 'Redemption not found');
  return row;
}

export async function listRedemptions(env: Env, tenantId: string, limit = 100) {
  const rows = await env.DB.prepare(
    `SELECT r.id, r.player_id, r.asset_code, r.units, r.amount_minor, r.status, r.jurisdiction_code, r.approved_by, r.evidence_ref,
            r.created_at, u.display_name, u.email
     FROM redemptions r JOIN players p ON p.id = r.player_id JOIN users u ON u.id = p.user_id
     WHERE r.tenant_id = ? ORDER BY r.created_at DESC LIMIT ?`,
  )
    .bind(tenantId, limit)
    .all<Record<string, unknown>>();
  return rows.results ?? [];
}
