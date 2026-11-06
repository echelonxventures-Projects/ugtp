import { ApiError, audit, newId, now, realMoneyEnabled, type AuthContext, type Env } from './core';
import { ensureAccount, post } from './ledger';
import { tenantStructure } from './orgs';
import { evaluateTenantAction } from './policy';

/**
 * Affiliate commission and payout. Commissions are reproducible: every record
 * stores the contract version, rule, base amount and rate per source line, so
 * the total can be recomputed from source transactions at any time.
 */

export async function createAffiliate(
  env: Env,
  auth: AuthContext,
  input: { code: string; name: string; payoutMethod?: string; taxWithholdingBps?: number },
) {
  const tenantId = auth.tenantId;
  if (!tenantId) throw new ApiError(403, 'TENANT_REQUIRED', 'Tenant context required');
  const id = newId('aff');
  const withholding = input.taxWithholdingBps ?? 0;
  if (!Number.isInteger(withholding) || withholding < 0 || withholding > 5_000) {
    throw new ApiError(400, 'INVALID_WITHHOLDING', 'Withholding must be between 0 and 5000 basis points');
  }
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO affiliates (id, tenant_id, code, name, status, payout_method, tax_withholding_bps, created_at)
       VALUES (?, ?, ?, ?, 'pending', ?, ?, ?)`,
    ).bind(id, tenantId, input.code, input.name, input.payoutMethod ?? 'bank_transfer', withholding, now()),
    audit(env, auth, 'affiliate.created', 'affiliate', id, { code: input.code, name: input.name }),
  ]);
  return getAffiliate(env, tenantId, id);
}

export async function setAffiliateStatus(env: Env, auth: AuthContext, affiliateId: string, status: 'active' | 'suspended' | 'terminated') {
  const tenantId = auth.tenantId;
  if (!tenantId) throw new ApiError(403, 'TENANT_REQUIRED', 'Tenant context required');
  if (status === 'active' && !auth.permissions.has('affiliate:approve')) {
    throw new ApiError(403, 'FORBIDDEN', 'Affiliate activation requires approval permission');
  }
  await env.DB.batch([
    env.DB.prepare('UPDATE affiliates SET status = ? WHERE id = ? AND tenant_id = ?').bind(status, affiliateId, tenantId),
    audit(env, auth, 'affiliate.status', 'affiliate', affiliateId, { status }),
  ]);
  return getAffiliate(env, tenantId, affiliateId);
}

export async function createContract(
  env: Env,
  auth: AuthContext,
  affiliateId: string,
  input: {
    model: 'revenue_share' | 'cpa' | 'cpl' | 'hybrid' | 'tiered';
    revshareBps?: number;
    cpaMinor?: number;
    cplMinor?: number;
    minPayoutMinor?: number;
    tiers?: { thresholdMinor: number; bps: number }[];
  },
) {
  const tenantId = auth.tenantId;
  if (!tenantId) throw new ApiError(403, 'TENANT_REQUIRED', 'Tenant context required');
  await getAffiliate(env, tenantId, affiliateId);
  const latest = await env.DB.prepare(
    'SELECT COALESCE(MAX(version), 0) AS v FROM affiliate_contracts WHERE tenant_id = ? AND affiliate_id = ?',
  )
    .bind(tenantId, affiliateId)
    .first<{ v: number }>();
  const version = (latest?.v ?? 0) + 1;
  const id = newId('ctr');
  const createdAt = now();
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO affiliate_contracts (id, tenant_id, affiliate_id, version, model, revshare_bps, cpa_minor, cpl_minor,
                                        min_payout_minor, tiers_json, valid_from, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?)`,
    ).bind(
      id,
      tenantId,
      affiliateId,
      version,
      input.model,
      input.revshareBps ?? 0,
      input.cpaMinor ?? 0,
      input.cplMinor ?? 0,
      input.minPayoutMinor ?? 0,
      JSON.stringify(input.tiers ?? []),
      createdAt,
      createdAt,
    ),
    env.DB.prepare(
      `UPDATE affiliate_contracts SET status = 'superseded' WHERE tenant_id = ? AND affiliate_id = ? AND status = 'active' AND id <> ?`,
    ).bind(tenantId, affiliateId, id),
    audit(env, auth, 'affiliate.contract_created', 'affiliate', affiliateId, { version, model: input.model }),
  ]);
  return { id, version, model: input.model };
}

export async function attributePlayer(
  env: Env,
  auth: AuthContext,
  input: { affiliateId: string; playerId: string; campaign?: string },
) {
  const tenantId = auth.tenantId;
  if (!tenantId) throw new ApiError(403, 'TENANT_REQUIRED', 'Tenant context required');
  const affiliate = await env.DB.prepare(`SELECT id, status FROM affiliates WHERE id = ? AND tenant_id = ?`)
    .bind(input.affiliateId, tenantId)
    .first<{ id: string; status: string }>();
  if (!affiliate) throw new ApiError(404, 'AFFILIATE_NOT_FOUND', 'Affiliate not found');
  if (affiliate.status !== 'active') throw new ApiError(409, 'AFFILIATE_INACTIVE', 'Affiliate is not active');
  const player = await env.DB.prepare('SELECT id FROM players WHERE id = ? AND tenant_id = ?')
    .bind(input.playerId, tenantId)
    .first<{ id: string }>();
  if (!player) throw new ApiError(404, 'PLAYER_NOT_FOUND', 'Player not found in this tenant');
  const contract = await env.DB.prepare(
    `SELECT id FROM affiliate_contracts WHERE tenant_id = ? AND affiliate_id = ? AND status = 'active' ORDER BY version DESC LIMIT 1`,
  )
    .bind(tenantId, input.affiliateId)
    .first<{ id: string }>();
  if (!contract) throw new ApiError(409, 'CONTRACT_MISSING', 'Affiliate has no active contract');

  const existing = await env.DB.prepare('SELECT id FROM attributions WHERE tenant_id = ? AND player_id = ?')
    .bind(tenantId, input.playerId)
    .first<{ id: string }>();
  if (existing) throw new ApiError(409, 'ALREADY_ATTRIBUTED', 'Player already has an attribution');

  const id = newId('atr');
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO attributions (id, tenant_id, affiliate_id, contract_id, player_id, campaign, attributed_at, window_days)
       VALUES (?, ?, ?, ?, ?, ?, ?, 30)`,
    ).bind(id, tenantId, input.affiliateId, contract.id, input.playerId, input.campaign ?? null, now()),
    audit(env, auth, 'affiliate.attributed', 'player', input.playerId, { affiliateId: input.affiliateId }),
  ]);
  return { id, affiliateId: input.affiliateId, playerId: input.playerId, contractId: contract.id };
}

export async function calculateCommission(
  env: Env,
  auth: AuthContext,
  input: { affiliateId: string; periodStart: number; periodEnd: number },
) {
  const tenantId = auth.tenantId;
  if (!tenantId) throw new ApiError(403, 'TENANT_REQUIRED', 'Tenant context required');
  if (input.periodEnd <= input.periodStart) throw new ApiError(400, 'INVALID_PERIOD', 'Period end must be after period start');
  const affiliate = await getAffiliate(env, tenantId, input.affiliateId);
  if (affiliate.status !== 'active') throw new ApiError(409, 'AFFILIATE_INACTIVE', 'Affiliate is not active');
  const contract = await env.DB.prepare(
    `SELECT * FROM affiliate_contracts WHERE tenant_id = ? AND affiliate_id = ? AND status = 'active' ORDER BY version DESC LIMIT 1`,
  )
    .bind(tenantId, input.affiliateId)
    .first<{
      id: string;
      version: number;
      model: string;
      revshare_bps: number;
      cpa_minor: number;
      cpl_minor: number;
      tiers_json: string;
    }>();
  if (!contract) throw new ApiError(409, 'CONTRACT_MISSING', 'Affiliate has no active contract');

  const existing = await env.DB.prepare(
    'SELECT id FROM commissions WHERE tenant_id = ? AND affiliate_id = ? AND period_start = ? AND period_end = ? AND contract_id = ?',
  )
    .bind(tenantId, input.affiliateId, input.periodStart, input.periodEnd, contract.id)
    .first<{ id: string }>();
  if (existing) return getCommission(env, tenantId, existing.id);

  const attributed = await env.DB.prepare(
    `SELECT a.player_id, p.created_at FROM attributions a JOIN players p ON p.id = a.player_id
     WHERE a.tenant_id = ? AND a.affiliate_id = ?`,
  )
    .bind(tenantId, input.affiliateId)
    .all<{ player_id: string; created_at: number }>();
  const playerIds = (attributed.results ?? []).map((r) => r.player_id);

  const lines: { sourceRef: string; baseMinor: number; rateBps: number; amountMinor: number }[] = [];

  if (playerIds.length && (contract.model === 'revenue_share' || contract.model === 'hybrid' || contract.model === 'tiered')) {
    const ngr = await env.DB.prepare(
      `SELECT r.player_id, SUM(r.stake_minor - r.payout_minor) AS ngr
       FROM rounds r JOIN game_sessions s ON s.id = r.session_id
       WHERE r.tenant_id = ? AND s.asset_code = 'USD' AND r.created_at >= ? AND r.created_at <= ?
         AND r.player_id IN (${playerIds.map(() => '?').join(',')})
       GROUP BY r.player_id`,
    )
      .bind(tenantId, input.periodStart, input.periodEnd, ...playerIds)
      .all<{ player_id: string; ngr: number }>();

    const rows = (ngr.results ?? []).filter((r) => r.ngr > 0);
    if (contract.model === 'tiered') {
      let tiers: { thresholdMinor: number; bps: number }[] = [];
      try {
        tiers = JSON.parse(contract.tiers_json) as { thresholdMinor: number; bps: number }[];
      } catch {
        tiers = [];
      }
      const total = rows.reduce((sum, r) => sum + r.ngr, 0);
      const tier = [...tiers].sort((a, b) => a.thresholdMinor - b.thresholdMinor).filter((t) => total >= t.thresholdMinor).pop();
      if (tier && total > 0) {
        lines.push({
          sourceRef: `tier:${tier.thresholdMinor}`,
          baseMinor: total,
          rateBps: tier.bps,
          amountMinor: Math.floor((total * tier.bps) / 10_000),
        });
      }
    } else {
      for (const row of rows) {
        lines.push({
          sourceRef: `ngr:${row.player_id}`,
          baseMinor: row.ngr,
          rateBps: contract.revshare_bps,
          amountMinor: Math.floor((row.ngr * contract.revshare_bps) / 10_000),
        });
      }
    }
  }

  if (playerIds.length && (contract.model === 'cpa' || contract.model === 'hybrid')) {
    const acquisitions = await env.DB.prepare(
      `SELECT p.id AS player_id FROM attributions a JOIN players p ON p.id = a.player_id
       WHERE a.tenant_id = ? AND a.affiliate_id = ? AND p.created_at >= ? AND p.created_at <= ?`,
    )
      .bind(tenantId, input.affiliateId, input.periodStart, input.periodEnd)
      .all<{ player_id: string }>();
    for (const row of acquisitions.results ?? []) {
      lines.push({
        sourceRef: `cpa:${row.player_id}`,
        baseMinor: contract.cpa_minor,
        rateBps: 10_000,
        amountMinor: contract.cpa_minor,
      });
    }
  }

  const amountMinor = lines.reduce((sum, line) => sum + line.amountMinor, 0);
  const commissionId = newId('com');
  const statements = [
    env.DB.prepare(
      `INSERT INTO commissions (id, tenant_id, affiliate_id, contract_id, contract_version, period_start, period_end, status,
                                amount_minor, currency, source_json, requested_by, computed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'draft', ?, 'USD', ?, ?, ?)`,
    ).bind(
      commissionId,
      tenantId,
      input.affiliateId,
      contract.id,
      contract.version,
      input.periodStart,
      input.periodEnd,
      amountMinor,
      JSON.stringify(lines.map((l) => l.sourceRef)),
      auth.userId,
      now(),
    ),
    audit(env, auth, 'affiliate.commission_computed', 'commission', commissionId, {
      affiliateId: input.affiliateId,
      amountMinor,
      lines: lines.length,
    }),
  ];
  for (const line of lines) {
    statements.push(
      env.DB.prepare(
        `INSERT INTO commission_lines (id, commission_id, source_ref, base_minor, rate_bps, amount_minor)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).bind(newId('cml'), commissionId, line.sourceRef, line.baseMinor, line.rateBps, line.amountMinor),
    );
  }
  await env.DB.batch(statements);
  return getCommission(env, tenantId, commissionId);
}

export async function getCommission(env: Env, tenantId: string, id: string) {
  const commission = await env.DB.prepare('SELECT * FROM commissions WHERE id = ? AND tenant_id = ?')
    .bind(id, tenantId)
    .first<{
      id: string;
      status: string;
      amount_minor: number;
      affiliate_id: string;
      requested_by: string | null;
      contract_version: number;
      [key: string]: unknown;
    }>();
  if (!commission) throw new ApiError(404, 'COMMISSION_NOT_FOUND', 'Commission not found');
  const lines = await env.DB.prepare(
    'SELECT id, source_ref, base_minor, rate_bps, amount_minor FROM commission_lines WHERE commission_id = ?',
  )
    .bind(id)
    .all<Record<string, unknown>>();
  return { ...commission, lines: lines.results ?? [] };
}

export async function verifyCommission(env: Env, tenantId: string, id: string) {
  const commission = await getCommission(env, tenantId, id);
  const computed = (commission.lines as { amount_minor: number; base_minor: number; rate_bps: number }[]).reduce(
    (sum, line) => sum + line.amount_minor,
    0,
  );
  const linesReproducible = (commission.lines as { amount_minor: number; base_minor: number; rate_bps: number }[]).every(
    (line) => line.amount_minor === Math.floor((line.base_minor * line.rate_bps) / 10_000),
  );
  return {
    commissionId: commission.id,
    storedAmountMinor: commission.amount_minor,
    recomputedAmountMinor: computed,
    matches: computed === commission.amount_minor,
    linesReproducible,
    contractVersion: commission.contract_version,
  };
}

export async function approveCommission(env: Env, auth: AuthContext, commissionId: string) {
  const tenantId = auth.tenantId;
  if (!tenantId) throw new ApiError(403, 'TENANT_REQUIRED', 'Tenant context required');
  const commission = await getCommission(env, tenantId, commissionId);
  if (commission.status !== 'draft') throw new ApiError(409, 'INVALID_STATE', `Commission is ${commission.status}`);
  if (commission.requested_by === auth.userId) {
    throw new ApiError(403, 'SEGREGATION_OF_DUTIES', 'The requester cannot approve their own commission');
  }
  const verification = await verifyCommission(env, tenantId, commissionId);
  if (!verification.matches || !verification.linesReproducible) {
    throw new ApiError(409, 'COMMISSION_NOT_REPRODUCIBLE', 'Commission does not reproduce from its source lines');
  }
  await env.DB.batch([
    env.DB.prepare(`UPDATE commissions SET status = 'approved' WHERE id = ? AND tenant_id = ? AND status = 'draft'`)
      .bind(commissionId, tenantId),
    audit(env, auth, 'affiliate.commission_approved', 'commission', commissionId, { amountMinor: commission.amount_minor }),
  ]);
  return getCommission(env, tenantId, commissionId);
}

export async function requestPayout(
  env: Env,
  auth: AuthContext,
  input: { commissionId: string; idempotencyKey: string },
) {
  const tenantId = auth.tenantId;
  if (!tenantId) throw new ApiError(403, 'TENANT_REQUIRED', 'Tenant context required');
  const commission = await getCommission(env, tenantId, input.commissionId);
  if (commission.status !== 'approved') throw new ApiError(409, 'COMMISSION_NOT_APPROVED', 'Commission must be approved before payout');
  const paid = await env.DB.prepare(
    `SELECT id FROM payouts WHERE tenant_id = ? AND commission_id = ? AND status IN ('requested','pending_approval','approved','paid')`,
  )
    .bind(tenantId, input.commissionId)
    .first<{ id: string }>();
  if (paid) throw new ApiError(409, 'PAYOUT_EXISTS', 'A payout already exists for this commission');

  const affiliate = await getAffiliate(env, tenantId, commission.affiliate_id);
  const contract = await env.DB.prepare(
    `SELECT min_payout_minor FROM affiliate_contracts WHERE tenant_id = ? AND affiliate_id = ? AND version = ?`,
  )
    .bind(tenantId, commission.affiliate_id, commission.contract_version)
    .first<{ min_payout_minor: number }>();
  if (commission.amount_minor < (contract?.min_payout_minor ?? 0)) {
    throw new ApiError(409, 'BELOW_MINIMUM_PAYOUT', 'Commission is below the contractual minimum payout');
  }

  const structure = await tenantStructure(env, tenantId);
  const decision = await evaluateTenantAction(env, {
    tenantId,
    jurisdictionCode: structure.tenant.jurisdiction_code,
    action: 'affiliate_payout',
    realMoneyEnabled: await realMoneyEnabled(env),
  });
  if (!decision.allowed) throw new ApiError(403, decision.code, decision.reason, { jurisdiction: decision.jurisdiction });

  const withheld = Math.floor((commission.amount_minor * affiliate.tax_withholding_bps) / 10_000);
  const net = commission.amount_minor - withheld;
  const id = newId('pot');
  const createdAt = now();
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO payouts (id, tenant_id, affiliate_id, commission_id, amount_minor, withheld_minor, net_minor, status,
                            requested_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'pending_approval', ?, ?, ?)`,
    ).bind(
      id,
      tenantId,
      commission.affiliate_id,
      commission.id,
      commission.amount_minor,
      withheld,
      net,
      auth.userId,
      createdAt,
      createdAt,
    ),
    audit(env, auth, 'affiliate.payout_requested', 'payout', id, {
      commissionId: commission.id,
      amountMinor: commission.amount_minor,
      withheld,
    }),
  ]);
  return getPayout(env, tenantId, id);
}

export async function decidePayout(env: Env, auth: AuthContext, payoutId: string, approve: boolean) {
  const tenantId = auth.tenantId;
  if (!tenantId) throw new ApiError(403, 'TENANT_REQUIRED', 'Tenant context required');
  if (!auth.permissions.has('affiliate:approve')) throw new ApiError(403, 'FORBIDDEN', 'Payout approval permission required');
  const payout = await getPayout(env, tenantId, payoutId);
  if (payout.status !== 'pending_approval') throw new ApiError(409, 'INVALID_STATE', `Payout is ${payout.status}`);
  if (payout.requested_by === auth.userId) {
    throw new ApiError(403, 'SEGREGATION_OF_DUTIES', 'The requester cannot approve their own payout');
  }

  if (!approve) {
    await env.DB.batch([
      env.DB.prepare(`UPDATE payouts SET status = 'rejected', updated_at = ? WHERE id = ? AND status = 'pending_approval'`)
        .bind(now(), payoutId),
      audit(env, auth, 'affiliate.payout_rejected', 'payout', payoutId, {}),
    ]);
    return getPayout(env, tenantId, payoutId);
  }

  const structure = await tenantStructure(env, tenantId);
  const decision = await evaluateTenantAction(env, {
    tenantId,
    jurisdictionCode: structure.tenant.jurisdiction_code,
    action: 'affiliate_payout',
    realMoneyEnabled: await realMoneyEnabled(env),
  });
  if (!decision.allowed) throw new ApiError(403, decision.code, decision.reason, { jurisdiction: decision.jurisdiction });

  const expense = await ensureAccount(env, {
    tenantId,
    ownerType: 'platform',
    ownerId: 'house',
    assetCode: 'USD',
    kind: 'revenue',
    allowNegative: true,
  });
  const clearing = await ensureAccount(env, {
    tenantId,
    ownerType: 'external',
    ownerId: 'psp:sandbox',
    assetCode: 'USD',
    kind: 'clearing',
    allowNegative: true,
  });
  await post(env, auth, {
    kind: 'affiliate.payout',
    idempotencyKey: `affiliate-payout:${payoutId}`,
    entries: [
      { accountId: expense, assetCode: 'USD', amountMinor: -payout.net_minor },
      { accountId: clearing, assetCode: 'USD', amountMinor: payout.net_minor },
    ],
    metadata: { payoutId, affiliateId: payout.affiliate_id, withheldMinor: payout.withheld_minor },
    extra: [
      env.DB.prepare(
        `UPDATE payouts SET status = 'paid', approved_by = ?, provider_ref = ?, updated_at = ?
         WHERE id = ? AND status = 'pending_approval'`,
      ).bind(auth.userId, `sbx_pot_${payoutId}`, now(), payoutId),
      env.DB.prepare(`UPDATE commissions SET status = 'paid' WHERE id = ? AND tenant_id = ?`).bind(payout.commission_id, tenantId),
      audit(env, auth, 'affiliate.payout_paid', 'payout', payoutId, {
        netMinor: payout.net_minor,
        withheldMinor: payout.withheld_minor,
      }),
    ],
  });
  return getPayout(env, tenantId, payoutId);
}

export async function getAffiliate(env: Env, tenantId: string, id: string) {
  const row = await env.DB.prepare('SELECT * FROM affiliates WHERE id = ? AND tenant_id = ?')
    .bind(id, tenantId)
    .first<{ id: string; status: string; tax_withholding_bps: number; [key: string]: unknown }>();
  if (!row) throw new ApiError(404, 'AFFILIATE_NOT_FOUND', 'Affiliate not found');
  return row;
}

export async function getPayout(env: Env, tenantId: string, id: string) {
  const row = await env.DB.prepare('SELECT * FROM payouts WHERE id = ? AND tenant_id = ?')
    .bind(id, tenantId)
    .first<{
      id: string;
      status: string;
      net_minor: number;
      withheld_minor: number;
      amount_minor: number;
      requested_by: string;
      approved_by: string | null;
      commission_id: string;
      affiliate_id: string;
      [key: string]: unknown;
    }>();
  if (!row) throw new ApiError(404, 'PAYOUT_NOT_FOUND', 'Payout not found');
  return row;
}

export async function listAffiliates(env: Env, tenantId: string) {
  const rows = await env.DB.prepare(
    `SELECT a.id, a.code, a.name, a.status, a.payout_method, a.tax_withholding_bps, a.created_at,
            (SELECT COUNT(*) FROM attributions t WHERE t.affiliate_id = a.id) AS players,
            (SELECT version FROM affiliate_contracts c WHERE c.affiliate_id = a.id AND c.status = 'active' ORDER BY version DESC LIMIT 1) AS contract_version,
            (SELECT model FROM affiliate_contracts c WHERE c.affiliate_id = a.id AND c.status = 'active' ORDER BY version DESC LIMIT 1) AS model
     FROM affiliates a WHERE a.tenant_id = ? ORDER BY a.created_at DESC`,
  )
    .bind(tenantId)
    .all<Record<string, unknown>>();
  return rows.results ?? [];
}

export async function listCommissions(env: Env, tenantId: string) {
  const rows = await env.DB.prepare(
    `SELECT c.id, c.affiliate_id, a.name AS affiliate_name, c.contract_version, c.period_start, c.period_end, c.status,
            c.amount_minor, c.computed_at, c.requested_by
     FROM commissions c JOIN affiliates a ON a.id = c.affiliate_id
     WHERE c.tenant_id = ? ORDER BY c.computed_at DESC LIMIT 100`,
  )
    .bind(tenantId)
    .all<Record<string, unknown>>();
  return rows.results ?? [];
}

export async function listPayouts(env: Env, tenantId: string) {
  const rows = await env.DB.prepare(
    `SELECT p.id, p.affiliate_id, a.name AS affiliate_name, p.commission_id, p.amount_minor, p.withheld_minor, p.net_minor,
            p.status, p.requested_by, p.approved_by, p.provider_ref, p.created_at
     FROM payouts p JOIN affiliates a ON a.id = p.affiliate_id
     WHERE p.tenant_id = ? ORDER BY p.created_at DESC LIMIT 100`,
  )
    .bind(tenantId)
    .all<Record<string, unknown>>();
  return rows.results ?? [];
}
