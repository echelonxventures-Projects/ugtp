import { Hono } from 'hono';
import {
  ApiError,
  audit,
  badRequest,
  jsonArray,
  money,
  newId,
  notFound,
  oneOf,
  rateLimit,
  readBody,
  requirePermission,
  requireTenant,
  str,
  type AppEnv,
  type AuthContext,
  type Permission,
} from './core';
import { authOf, createSession, destroySession, loginAttemptKey, verifyPassword } from './auth';
import { decideApproval, findApproval } from './approvals';
import { listAgents, createAgent, setAgentParent, setAgentStatus, assignPlayer } from './agents';
import {
  approveCommission,
  attributePlayer,
  calculateCommission,
  createAffiliate,
  createContract,
  decidePayout,
  listAffiliates,
  listCommissions,
  listPayouts,
  requestPayout,
  setAffiliateStatus,
  verifyCommission,
} from './affiliates';
import {
  activateFacility,
  createFacility,
  drawCredit,
  executeApprovedDraw,
  listFacilities,
  outstandingFor,
  repayCredit,
} from './credit';
import { listGames, playerGameHistory, playDice, rotateSeed, walletForPlayer } from './gaming';
import { balanceOf, unbalancedAssets } from './ledger';
import { createTenant, listTenants, tenantOverview, tenantStructure } from './orgs';
import {
  approveWithdrawal,
  deposit,
  listPayments,
  rejectWithdrawal,
  requestWithdrawal,
} from './payments';
import { createPlayer, getPlayer, listPlayers, updatePlayer } from './players';
import { createSettlement, listSettlements, transitionSettlement } from './settlements';
import { decideRedemption, listRedemptions, requestRedemption } from './redemptions';
import { accountBalance } from './ledger';
import { loadJurisdiction } from './policy';

export const api = new Hono<AppEnv>();

/* ---------------------------------------------------------------- identity */

api.get('/me', async (c) => {
  const auth = authOf(c);
  const permissions = [...auth.permissions];
  let tenant = null;
  let org = null;
  let playerId: string | null = null;
  if (auth.tenantId) {
    const structure = await tenantStructure(c.env, auth.tenantId);
    tenant = structure.tenant;
    org = {
      legalEntityId: structure.legalEntityId,
      operatorId: structure.operatorId,
      brandId: structure.brandId,
    };
  }
  if (auth.userType === 'player') {
    const row = await c.env.DB.prepare('SELECT id FROM players WHERE user_id = ? AND tenant_id = ?')
      .bind(auth.userId, auth.tenantId)
      .first<{ id: string }>();
    playerId = row?.id ?? null;
  }
  return c.json({
    user: {
      id: auth.userId,
      displayName: auth.displayName,
      role: auth.role,
      userType: auth.userType,
      permissions,
    },
    tenant,
    org,
    playerId,
    tenants: await listTenants(c.env, auth),
  });
});

api.post('/auth/login', async (c) => {
  const body = await readBody<{ email?: string; password?: string }>(c);
  const email = str(body.email, 'email', { max: 200 }).toLowerCase();
  const password = str(body.password, 'password', { max: 200 });
  rateLimit(await loginAttemptKey(c, email), 10, 60_000);
  const user = await c.env.DB.prepare(
    'SELECT id, tenant_id, email, password_hash, display_name, role, user_type, status FROM users WHERE email = ?',
  )
    .bind(email)
    .first<{
      id: string;
      tenant_id: string | null;
      email: string;
      password_hash: string;
      display_name: string;
      role: string;
      user_type: string;
      status: string;
    }>();
  const valid = user ? await verifyPassword(password, user.password_hash) : false;
  if (!user || !valid) throw new ApiError(401, 'INVALID_CREDENTIALS', 'Email or password is incorrect');
  if (user.status !== 'active') throw new ApiError(403, 'ACCOUNT_DISABLED', 'Account is not active');
  await c.env.DB.prepare('UPDATE users SET last_login_at = ? WHERE id = ?').bind(Date.now(), user.id).run();
  await createSession(c.env, c, user, c.req.header('user-agent'));
  return c.json({ ok: true, role: user.role, tenantId: user.tenant_id });
});

api.post('/auth/logout', async (c) => {
  await destroySession(c.env, c);
  return c.json({ ok: true });
});

api.get('/tenants', async (c) => {
  const auth = authOf(c);
  requirePermission(auth, 'tenant:read');
  return c.json({ tenants: await listTenants(c.env, auth) });
});

api.post('/tenants', async (c) => {
  const auth = authOf(c);
  const body = await readBody<{ name?: string; jurisdictionCode?: string; brandName?: string }>(c);
  const structure = await createTenant(c.env, auth, {
    name: str(body.name, 'name', { min: 2, max: 80 }),
    jurisdictionCode: str(body.jurisdictionCode, 'jurisdictionCode', { min: 2, max: 2 }),
    brandName: body.brandName ? str(body.brandName, 'brandName', { max: 80 }) : undefined,
  });
  return c.json({ tenant: structure.tenant, org: structure }, 201);
});

/* ---------------------------------------------------------------- overview */

api.get('/overview', async (c) => {
  const auth = authOf(c);
  const tenantId = requireTenant(auth);
  requirePermission(auth, 'tenant:read');
  const structure = await tenantStructure(c.env, tenantId);
  const overview = await tenantOverview(c.env, tenantId);
  const jurisdiction = await loadJurisdiction(c.env, structure.tenant.jurisdiction_code);
  return c.json({
    ...overview,
    tenant: structure.tenant,
    jurisdiction,
    ledgerBalanced: (await unbalancedAssets(c.env, tenantId)).length === 0,
  });
});

/* ----------------------------------------------------------------- players */

api.get('/players', async (c) => {
  const auth = authOf(c);
  const tenantId = requireTenant(auth);
  requirePermission(auth, 'player:read');
  return c.json({ players: await listPlayers(c.env, tenantId) });
});

api.post('/players', async (c) => {
  const auth = authOf(c);
  const tenantId = requireTenant(auth);
  requirePermission(auth, 'player:write');
  const body = await readBody<Record<string, unknown>>(c);
  const structure = await tenantStructure(c.env, tenantId);
  const result = await createPlayer(c.env, auth, {
    email: str(body.email, 'email', { max: 200, pattern: /^[^@\s]+@[^@\s]+\.[^@\s]+$/ }),
    password: str(body.password, 'password', { min: 10, max: 200 }),
    displayName: str(body.displayName, 'displayName', { min: 2, max: 60 }),
    brandId: body.brandId ? str(body.brandId, 'brandId', { max: 80 }) : structure.brandId,
    jurisdictionCode: body.jurisdictionCode
      ? str(body.jurisdictionCode, 'jurisdictionCode', { min: 2, max: 2 })
      : structure.tenant.jurisdiction_code,
    dateOfBirth: body.dateOfBirth ? str(body.dateOfBirth, 'dateOfBirth', { max: 20 }) : undefined,
    agentId: body.agentId ? str(body.agentId, 'agentId', { max: 80 }) : null,
    playCredits: body.playCredits ? money(body.playCredits, 'playCredits') : 0,
  });
  return c.json(result, 201);
});

api.patch('/players/:id', async (c) => {
  const auth = authOf(c);
  const tenantId = requireTenant(auth);
  requirePermission(auth, 'player:write');
  const body = await readBody<Record<string, unknown>>(c);
  const patch: Parameters<typeof updatePlayer>[3] = {};
  if (body.status !== undefined) patch.status = oneOf(body.status, ['active', 'suspended', 'self_excluded', 'closed'] as const, 'status');
  if (body.kycStatus !== undefined) {
    patch.kycStatus = oneOf(body.kycStatus, ['unverified', 'pending', 'verified', 'rejected'] as const, 'kycStatus');
  }
  if (body.selfExclusionUntil !== undefined) {
    patch.selfExclusionUntil = body.selfExclusionUntil === null ? null : Number(body.selfExclusionUntil);
  }
  if (body.dailyDepositLimit !== undefined) {
    patch.dailyDepositLimit = body.dailyDepositLimit === null ? null : money(body.dailyDepositLimit, 'dailyDepositLimit', { min: 0 });
  }
  if (body.dailyWagerLimit !== undefined) {
    patch.dailyWagerLimit = body.dailyWagerLimit === null ? null : money(body.dailyWagerLimit, 'dailyWagerLimit', { min: 0 });
  }
  return c.json({ player: await updatePlayer(c.env, auth, c.req.param('id'), patch) });
});

api.get('/players/:id/wallet', async (c) => {
  const auth = authOf(c);
  const tenantId = requireTenant(auth);
  requirePermission(auth, 'wallet:read');
  return c.json(await walletForPlayer(c.env, tenantId, c.req.param('id')));
});

api.get('/players/:id/history', async (c) => {
  const auth = authOf(c);
  const tenantId = requireTenant(auth);
  requirePermission(auth, 'player:read');
  return c.json({ rounds: await playerGameHistory(c.env, tenantId, c.req.param('id')) });
});

/* ------------------------------------------------------------------ gaming */

api.get('/games', async (c) => {
  const auth = authOf(c);
  const tenantId = requireTenant(auth);
  requirePermission(auth, 'game:read');
  return c.json({ games: await listGames(c.env, tenantId) });
});

api.post('/play/dice', async (c) => {
  const auth = authOf(c);
  requireTenant(auth);
  const body = await readBody<Record<string, unknown>>(c);
  const playerId = str(body.playerId, 'playerId', { max: 80 });
  const stakeMinor = money(body.stakeMinor, 'stakeMinor', { max: 5_000_00 });
  const assetCode = body.assetCode ? str(body.assetCode, 'assetCode', { max: 10 }).toUpperCase() : 'XCR';
  const direction = oneOf(body.direction, ['under', 'over'] as const, 'direction');
  const target = Number(body.target);
  if (!Number.isInteger(target)) badRequest('INVALID_TARGET', 'target must be an integer');
  return c.json(await playDice(c.env, auth, { playerId, stakeMinor, assetCode, direction, target }));
});

api.post('/play/fairness/rotate', async (c) => {
  const auth = authOf(c);
  requireTenant(auth);
  const body = await readBody<Record<string, unknown>>(c);
  return c.json(
    await rotateSeed(
      c.env,
      auth,
      str(body.playerId, 'playerId', { max: 80 }),
      body.assetCode ? str(body.assetCode, 'assetCode', { max: 10 }).toUpperCase() : 'XCR',
    ),
  );
});

/* ------------------------------------------------------------------ agents */

api.get('/agents', async (c) => {
  const auth = authOf(c);
  const tenantId = requireTenant(auth);
  requirePermission(auth, 'agent:read');
  return c.json({ agents: await listAgents(c.env, tenantId) });
});

api.post('/agents', async (c) => {
  const auth = authOf(c);
  requireTenant(auth);
  requirePermission(auth, 'agent:write');
  const body = await readBody<Record<string, unknown>>(c);
  return c.json(
    await createAgent(c.env, auth, {
      parentId: body.parentId ? str(body.parentId, 'parentId', { max: 80 }) : null,
      code: str(body.code, 'code', { min: 2, max: 40 }),
      name: str(body.name, 'name', { min: 2, max: 80 }),
      agentType: oneOf(body.agentType, ['master', 'regional', 'sub', 'distributor', 'franchise'] as const, 'agentType'),
      territory: body.territory ? str(body.territory, 'territory', { max: 80 }) : undefined,
      permissions: body.permissions ? jsonArray(body.permissions, 'permissions') : [],
      creditLimitMinor: body.creditLimitMinor ? money(body.creditLimitMinor, 'creditLimitMinor', { min: 0 }) : 0,
    }),
    201,
  );
});

api.patch('/agents/:id/parent', async (c) => {
  const auth = authOf(c);
  requireTenant(auth);
  requirePermission(auth, 'agent:write');
  const body = await readBody<{ parentId?: string | null }>(c);
  return c.json({
    agents: await setAgentParent(c.env, auth, c.req.param('id'), body.parentId ? String(body.parentId) : null),
  });
});

api.patch('/agents/:id/status', async (c) => {
  const auth = authOf(c);
  requireTenant(auth);
  requirePermission(auth, 'agent:write');
  const body = await readBody<{ status?: string }>(c);
  const status = oneOf(body.status, ['active', 'suspended', 'terminated'] as const, 'status');
  return c.json({ agents: await setAgentStatus(c.env, auth, c.req.param('id'), status) });
});

api.post('/agents/:id/players', async (c) => {
  const auth = authOf(c);
  requireTenant(auth);
  requirePermission(auth, 'agent:write');
  const body = await readBody<{ playerId?: string }>(c);
  return c.json(await assignPlayer(c.env, auth, c.req.param('id'), str(body.playerId, 'playerId', { max: 80 })));
});

/* ------------------------------------------------------------------ credit */

api.get('/credit/facilities', async (c) => {
  const auth = authOf(c);
  const tenantId = requireTenant(auth);
  requirePermission(auth, 'credit:read');
  return c.json({ facilities: await listFacilities(c.env, tenantId) });
});

api.post('/credit/facilities', async (c) => {
  const auth = authOf(c);
  requireTenant(auth);
  requirePermission(auth, 'credit:write');
  const body = await readBody<Record<string, unknown>>(c);
  return c.json(
    await createFacility(c.env, auth, {
      subjectType: oneOf(body.subjectType, ['player', 'agent'] as const, 'subjectType'),
      subjectId: str(body.subjectId, 'subjectId', { max: 80 }),
      limitMinor: money(body.limitMinor, 'limitMinor'),
      policyRef: str(body.policyRef, 'policyRef', { min: 3, max: 120 }),
    }),
    201,
  );
});

api.post('/credit/facilities/:id/activate', async (c) => {
  const auth = authOf(c);
  requireTenant(auth);
  requirePermission(auth, 'credit:approve');
  return c.json({ facility: await activateFacility(c.env, auth, c.req.param('id')) });
});

api.post('/credit/facilities/:id/draw', async (c) => {
  const auth = authOf(c);
  requireTenant(auth);
  requirePermission(auth, 'credit:write');
  const body = await readBody<Record<string, unknown>>(c);
  return c.json(
    await drawCredit(c.env, auth, {
      facilityId: c.req.param('id'),
      amountMinor: money(body.amountMinor, 'amountMinor'),
      reason: str(body.reason, 'reason', { min: 3, max: 200 }),
    }),
  );
});

api.post('/credit/facilities/:id/repay', async (c) => {
  const auth = authOf(c);
  requireTenant(auth);
  requirePermission(auth, 'credit:write');
  const body = await readBody<Record<string, unknown>>(c);
  return c.json(
    await repayCredit(c.env, auth, {
      facilityId: c.req.param('id'),
      amountMinor: money(body.amountMinor, 'amountMinor'),
      reason: body.reason ? str(body.reason, 'reason', { max: 200 }) : undefined,
      idempotencyKey: body.idempotencyKey ? str(body.idempotencyKey, 'idempotencyKey', { max: 120 }) : newId('repay'),
    }),
  );
});

api.get('/credit/exposure', async (c) => {
  const auth = authOf(c);
  const tenantId = requireTenant(auth);
  requirePermission(auth, 'credit:read');
  const facilities = await listFacilities(c.env, tenantId);
  let limit = 0;
  let outstanding = 0;
  for (const f of facilities as { limit_minor: number; status: string; id: string }[]) {
    if (f.status !== 'active') continue;
    limit += f.limit_minor;
    outstanding += await outstandingFor(c.env, tenantId, f.id);
  }
  return c.json({ limitMinor: limit, outstandingMinor: outstanding, availableMinor: limit - outstanding });
});

/* ---------------------------------------------------------------- payments */

api.get('/payments', async (c) => {
  const auth = authOf(c);
  const tenantId = requireTenant(auth);
  requirePermission(auth, 'payment:read');
  return c.json({ payments: await listPayments(c.env, tenantId) });
});

api.post('/payments/deposit', async (c) => {
  const auth = authOf(c);
  requireTenant(auth);
  requirePermission(auth, 'payment:write');
  const body = await readBody<Record<string, unknown>>(c);
  return c.json(
    await deposit(c.env, auth, {
      playerId: str(body.playerId, 'playerId', { max: 80 }),
      amountMinor: money(body.amountMinor, 'amountMinor', { max: 1_000_000_00 }),
      method: body.method ? str(body.method, 'method', { max: 40 }) : 'sandbox_card',
      idempotencyKey: body.idempotencyKey ? str(body.idempotencyKey, 'idempotencyKey', { max: 120 }) : newId('dep'),
    }),
    201,
  );
});

api.post('/payments/withdrawals', async (c) => {
  const auth = authOf(c);
  requireTenant(auth);
  requirePermission(auth, 'payment:write');
  const body = await readBody<Record<string, unknown>>(c);
  return c.json(
    await requestWithdrawal(c.env, auth, {
      playerId: str(body.playerId, 'playerId', { max: 80 }),
      amountMinor: money(body.amountMinor, 'amountMinor', { max: 1_000_000_00 }),
      method: body.method ? str(body.method, 'method', { max: 40 }) : 'bank_transfer',
      idempotencyKey: body.idempotencyKey ? str(body.idempotencyKey, 'idempotencyKey', { max: 120 }) : newId('wd'),
    }),
    201,
  );
});

api.post('/payments/:id/approve', async (c) => {
  const auth = authOf(c);
  requireTenant(auth);
  requirePermission(auth, 'payment:approve');
  return c.json({ payment: await approveWithdrawal(c.env, auth, c.req.param('id')) });
});

api.post('/payments/:id/reject', async (c) => {
  const auth = authOf(c);
  requireTenant(auth);
  requirePermission(auth, 'payment:approve');
  const body = await readBody<{ reason?: string }>(c);
  return c.json({
    payment: await rejectWithdrawal(c.env, auth, c.req.param('id'), str(body.reason ?? 'Rejected', 'reason', { max: 200 })),
  });
});

/* -------------------------------------------------------------- settlements */

api.get('/settlements', async (c) => {
  const auth = authOf(c);
  const tenantId = requireTenant(auth);
  requirePermission(auth, 'settlement:read');
  return c.json({ settlements: await listSettlements(c.env, tenantId) });
});

api.post('/settlements', async (c) => {
  const auth = authOf(c);
  requireTenant(auth);
  requirePermission(auth, 'settlement:write');
  const body = await readBody<Record<string, unknown>>(c);
  return c.json(
    await createSettlement(c.env, auth, {
      kind: oneOf(body.kind, ['game_cash', 'agent', 'operator', 'partner', 'off_platform'] as const, 'kind'),
      source: oneOf(body.source, ['platform', 'external'] as const, 'source'),
      counterparty: str(body.counterparty, 'counterparty', { min: 2, max: 120 }),
      amountMinor: money(body.amountMinor, 'amountMinor'),
      currency: body.currency ? str(body.currency, 'currency', { max: 3 }).toUpperCase() : 'USD',
      evidenceRef: body.evidenceRef ? str(body.evidenceRef, 'evidenceRef', { max: 200 }) : undefined,
    }),
    201,
  );
});

api.post('/settlements/:id/transition', async (c) => {
  const auth = authOf(c);
  requireTenant(auth);
  const body = await readBody<Record<string, unknown>>(c);
  const next = oneOf(
    body.next,
    ['pending_verification', 'verified', 'confirmed', 'reconciled', 'disputed', 'reversed'] as const,
    'next',
  );
  return c.json({
    settlement: await transitionSettlement(c.env, auth, c.req.param('id'), next, {
      evidenceRef: body.evidenceRef ? str(body.evidenceRef, 'evidenceRef', { max: 200 }) : undefined,
      reason: body.reason ? str(body.reason, 'reason', { max: 200 }) : undefined,
    }),
  });
});

/* -------------------------------------------------------------- redemptions */

api.get('/redemptions', async (c) => {
  const auth = authOf(c);
  const tenantId = requireTenant(auth);
  requirePermission(auth, 'redemption:read');
  return c.json({ redemptions: await listRedemptions(c.env, tenantId) });
});

api.post('/redemptions', async (c) => {
  const auth = authOf(c);
  requireTenant(auth);
  requirePermission(auth, 'redemption:write');
  const body = await readBody<Record<string, unknown>>(c);
  return c.json(
    await requestRedemption(c.env, auth, {
      playerId: str(body.playerId, 'playerId', { max: 80 }),
      assetCode: body.assetCode ? str(body.assetCode, 'assetCode', { max: 10 }).toUpperCase() : 'USD',
      units: money(body.units, 'units'),
    }),
    201,
  );
});

api.post('/redemptions/:id/approve', async (c) => {
  const auth = authOf(c);
  requireTenant(auth);
  requirePermission(auth, 'redemption:approve');
  return c.json({ redemption: await decideRedemption(c.env, auth, c.req.param('id'), true) });
});

api.post('/redemptions/:id/reject', async (c) => {
  const auth = authOf(c);
  requireTenant(auth);
  requirePermission(auth, 'redemption:approve');
  return c.json({ redemption: await decideRedemption(c.env, auth, c.req.param('id'), false) });
});

/* ---------------------------------------------------------------- affiliates */

api.get('/affiliates', async (c) => {
  const auth = authOf(c);
  const tenantId = requireTenant(auth);
  requirePermission(auth, 'affiliate:read');
  return c.json({
    affiliates: await listAffiliates(c.env, tenantId),
    commissions: await listCommissions(c.env, tenantId),
    payouts: await listPayouts(c.env, tenantId),
  });
});

api.post('/affiliates', async (c) => {
  const auth = authOf(c);
  requireTenant(auth);
  requirePermission(auth, 'affiliate:write');
  const body = await readBody<Record<string, unknown>>(c);
  return c.json(
    await createAffiliate(c.env, auth, {
      code: str(body.code, 'code', { min: 2, max: 40 }),
      name: str(body.name, 'name', { min: 2, max: 80 }),
      payoutMethod: body.payoutMethod ? str(body.payoutMethod, 'payoutMethod', { max: 40 }) : undefined,
      taxWithholdingBps: body.taxWithholdingBps ? Number(body.taxWithholdingBps) : 0,
    }),
    201,
  );
});

api.patch('/affiliates/:id/status', async (c) => {
  const auth = authOf(c);
  requireTenant(auth);
  requirePermission(auth, 'affiliate:write');
  const body = await readBody<{ status?: string }>(c);
  const status = oneOf(body.status, ['active', 'suspended', 'terminated'] as const, 'status');
  return c.json({ affiliate: await setAffiliateStatus(c.env, auth, c.req.param('id'), status) });
});

api.post('/affiliates/:id/contracts', async (c) => {
  const auth = authOf(c);
  requireTenant(auth);
  requirePermission(auth, 'affiliate:write');
  const body = await readBody<Record<string, unknown>>(c);
  return c.json(
    await createContract(c.env, auth, c.req.param('id'), {
      model: oneOf(body.model, ['revenue_share', 'cpa', 'cpl', 'hybrid', 'tiered'] as const, 'model'),
      revshareBps: body.revshareBps ? Number(body.revshareBps) : 0,
      cpaMinor: body.cpaMinor ? Number(body.cpaMinor) : 0,
      cplMinor: body.cplMinor ? Number(body.cplMinor) : 0,
      minPayoutMinor: body.minPayoutMinor ? Number(body.minPayoutMinor) : 0,
      tiers: Array.isArray(body.tiers) ? (body.tiers as { thresholdMinor: number; bps: number }[]) : [],
    }),
    201,
  );
});

api.post('/affiliates/:id/attribute', async (c) => {
  const auth = authOf(c);
  requireTenant(auth);
  requirePermission(auth, 'affiliate:write');
  const body = await readBody<Record<string, unknown>>(c);
  return c.json(
    await attributePlayer(c.env, auth, {
      affiliateId: c.req.param('id'),
      playerId: str(body.playerId, 'playerId', { max: 80 }),
      campaign: body.campaign ? str(body.campaign, 'campaign', { max: 80 }) : undefined,
    }),
    201,
  );
});

api.post('/affiliates/:id/commissions', async (c) => {
  const auth = authOf(c);
  requireTenant(auth);
  requirePermission(auth, 'affiliate:write');
  const body = await readBody<Record<string, unknown>>(c);
  return c.json(
    await calculateCommission(c.env, auth, {
      affiliateId: c.req.param('id'),
      periodStart: Number(body.periodStart),
      periodEnd: Number(body.periodEnd),
    }),
    201,
  );
});

api.get('/commissions/:id/verify', async (c) => {
  const auth = authOf(c);
  const tenantId = requireTenant(auth);
  requirePermission(auth, 'affiliate:read');
  return c.json(await verifyCommission(c.env, tenantId, c.req.param('id')));
});

api.post('/commissions/:id/approve', async (c) => {
  const auth = authOf(c);
  requireTenant(auth);
  requirePermission(auth, 'affiliate:approve');
  return c.json({ commission: await approveCommission(c.env, auth, c.req.param('id')) });
});

api.post('/commissions/:id/payout', async (c) => {
  const auth = authOf(c);
  requireTenant(auth);
  requirePermission(auth, 'affiliate:write');
  const body = await readBody<{ idempotencyKey?: string }>(c);
  return c.json(
    await requestPayout(c.env, auth, {
      commissionId: c.req.param('id'),
      idempotencyKey: body.idempotencyKey ? String(body.idempotencyKey) : newId('payout'),
    }),
    201,
  );
});

api.post('/payouts/:id/approve', async (c) => {
  const auth = authOf(c);
  requireTenant(auth);
  requirePermission(auth, 'affiliate:approve');
  return c.json({ payout: await decidePayout(c.env, auth, c.req.param('id'), true) });
});

api.post('/payouts/:id/reject', async (c) => {
  const auth = authOf(c);
  requireTenant(auth);
  requirePermission(auth, 'affiliate:approve');
  return c.json({ payout: await decidePayout(c.env, auth, c.req.param('id'), false) });
});

/* --------------------------------------------------------------- compliance */

api.get('/compliance/jurisdictions', async (c) => {
  const auth = authOf(c);
  requirePermission(auth, 'compliance:read');
  const rows = await c.env.DB.prepare('SELECT * FROM jurisdictions ORDER BY code').all<Record<string, unknown>>();
  return c.json({ jurisdictions: rows.results ?? [] });
});

api.get('/compliance/licences', async (c) => {
  const auth = authOf(c);
  const tenantId = requireTenant(auth);
  requirePermission(auth, 'compliance:read');
  const rows = await c.env.DB.prepare(
    `SELECT id, jurisdiction_code, authority, licence_type, licence_number, status, valid_from, valid_to,
            activities_json, game_categories_json, evidence_ref, verified_by, verified_at, created_at
     FROM licences WHERE tenant_id = ? ORDER BY created_at DESC`,
  )
    .bind(tenantId)
    .all<Record<string, unknown>>();
  return c.json({ licences: rows.results ?? [] });
});

api.post('/compliance/licences', async (c) => {
  const auth = authOf(c);
  const tenantId = requireTenant(auth);
  requirePermission(auth, 'compliance:write');
  const body = await readBody<Record<string, unknown>>(c);
  const structure = await tenantStructure(c.env, tenantId);
  const jurisdiction = await loadJurisdiction(c.env, str(body.jurisdictionCode, 'jurisdictionCode', { min: 2, max: 2 }));
  if (!jurisdiction) throw new ApiError(400, 'JURISDICTION_UNKNOWN', 'Unknown jurisdiction');
  const id = newId('lic');
  await c.env.DB.batch([
    c.env.DB.prepare(
      `INSERT INTO licences (id, tenant_id, legal_entity_id, jurisdiction_code, authority, licence_type, licence_number,
                             status, valid_from, valid_to, activities_json, game_categories_json, conditions_json,
                             evidence_ref, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, '{}', ?, ?)`,
    ).bind(
      id,
      tenantId,
      structure.legalEntityId,
      jurisdiction.code,
      str(body.authority, 'authority', { min: 2, max: 120 }),
      body.licenceType ? str(body.licenceType, 'licenceType', { max: 80 }) : 'remote_casino',
      str(body.licenceNumber, 'licenceNumber', { min: 2, max: 80 }),
      Number(body.validFrom),
      Number(body.validTo),
      JSON.stringify(body.activities ? jsonArray(body.activities, 'activities') : []),
      JSON.stringify(body.gameCategories ? jsonArray(body.gameCategories, 'gameCategories') : []),
      body.evidenceRef ? str(body.evidenceRef, 'evidenceRef', { max: 200 }) : null,
      Date.now(),
    ),
    audit(c.env, auth, 'licence.created', 'licence', id, { jurisdiction: jurisdiction.code }),
  ]);
  return c.json({ id }, 201);
});

api.post('/compliance/licences/:id/verify', async (c) => {
  const auth = authOf(c);
  const tenantId = requireTenant(auth);
  requirePermission(auth, 'compliance:write');
  const body = await readBody<{ evidenceRef?: string }>(c);
  const evidence = str(body.evidenceRef, 'evidenceRef', { min: 3, max: 200 });
  const licence = await c.env.DB.prepare('SELECT id FROM licences WHERE id = ? AND tenant_id = ?')
    .bind(c.req.param('id'), tenantId)
    .first<{ id: string }>();
  if (!licence) throw new ApiError(404, 'LICENCE_NOT_FOUND', 'Licence not found');
  await c.env.DB.batch([
    c.env.DB.prepare(
      `UPDATE licences SET status = 'active', evidence_ref = ?, verified_by = ?, verified_at = ? WHERE id = ? AND tenant_id = ?`,
    ).bind(evidence, auth.userId, Date.now(), licence.id, tenantId),
    audit(c.env, auth, 'licence.verified', 'licence', licence.id, { evidenceRef: evidence }),
  ]);
  return c.json({ ok: true, licenceId: licence.id });
});

/* ---------------------------------------------------------------- approvals */

api.get('/approvals', async (c) => {
  const auth = authOf(c);
  const tenantId = requireTenant(auth);
  requirePermission(auth, 'audit:read');
  const rows = await c.env.DB.prepare(
    `SELECT id, action, subject_type, subject_id, amount_minor, required_permission, status, requested_by, decided_by, created_at
     FROM approval_requests WHERE tenant_id = ? ORDER BY created_at DESC LIMIT 100`,
  )
    .bind(tenantId)
    .all<Record<string, unknown>>();
  return c.json({ approvals: rows.results ?? [] });
});

api.post('/approvals/:id/decide', async (c) => {
  const auth = authOf(c);
  const tenantId = requireTenant(auth);
  const body = await readBody<{ approve?: boolean; note?: string }>(c);
  if (typeof body.approve !== 'boolean') badRequest('INVALID_INPUT', 'approve must be a boolean');
  const approval = await decideApproval(c.env, auth, c.req.param('id'), body.approve, body.note);
  let effect: unknown = null;
  if (body.approve && approval.action === 'credit.draw' && approval.amount_minor) {
    effect = await executeApprovedDraw(
      c.env,
      auth,
      approval.subject_id,
      approval.amount_minor,
      approval.id,
      'approved credit draw',
    );
  }
  return c.json({ approval, effect });
});

api.get('/audit', async (c) => {
  const auth = authOf(c);
  const tenantId = requireTenant(auth);
  requirePermission(auth, 'audit:read');
  const rows = await c.env.DB.prepare(
    `SELECT id, actor_id, action, subject_type, subject_id, meta_json, created_at
     FROM audit_log WHERE tenant_id = ? OR tenant_id IS NULL ORDER BY created_at DESC LIMIT 100`,
  )
    .bind(tenantId)
    .all<Record<string, unknown>>();
  return c.json({ entries: rows.results ?? [] });
});

/* ---------------------------------------------------------------- platform */

api.post('/platform/settings', async (c) => {
  const auth = authOf(c);
  if (auth.role !== 'platform_admin') throw new ApiError(403, 'FORBIDDEN', 'Platform administrator required');
  const body = await readBody<{ key?: string; value?: string }>(c);
  const key = str(body.key, 'key', { max: 60 });
  const allowed = [
    'real_money_enabled',
    'credit_draw_approval_threshold_minor',
    'withdrawal_approval_threshold_minor',
    'min_withdrawal_minor',
  ];
  if (!allowed.includes(key)) badRequest('SETTING_NOT_ALLOWED', 'This setting cannot be changed through the API');
  const value = str(body.value, 'value', { max: 80 });
  await c.env.DB.batch([
    c.env.DB.prepare('INSERT INTO platform_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').bind(key, value),
    audit(c.env, auth, 'platform.setting_changed', 'setting', key, { value }),
  ]);
  return c.json({ key, value });
});

/* ------------------------------------------------------------------- misc */

api.get('/accounts/:id/balance', async (c) => {
  const auth = authOf(c);
  const tenantId = requireTenant(auth);
  requirePermission(auth, 'wallet:read');
  const row = await c.env.DB.prepare('SELECT id FROM accounts WHERE id = ? AND tenant_id = ?')
    .bind(c.req.param('id'), tenantId)
    .first<{ id: string }>();
  if (!row) notFound('ACCOUNT_NOT_FOUND', 'Account not found');
  return c.json({ accountId: row.id, balanceMinor: await balanceOf(c.env, row.id) });
});

api.get('/players/:id/balance/:asset', async (c) => {
  const auth = authOf(c);
  const tenantId = requireTenant(auth);
  requirePermission(auth, 'wallet:read');
  const player = await getPlayer(c.env, tenantId, c.req.param('id'));
  return c.json({
    playerId: player.id,
    asset: c.req.param('asset').toUpperCase(),
    balanceMinor: await accountBalance(c.env, {
      tenantId,
      ownerType: 'player',
      ownerId: player.id,
      assetCode: c.req.param('asset').toUpperCase(),
      kind: 'available',
    }),
  });
});
