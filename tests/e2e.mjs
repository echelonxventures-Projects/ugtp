/**
 * End-to-end verification against a real workerd + D1 instance.
 *
 * Boots `wrangler dev` on a fresh persistent D1 directory, applies migrations,
 * bootstraps the sandbox and exercises the HTTP API. No mocks: every check is a
 * real request against the Worker.
 */
import { execFileSync, spawn } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { rmSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';

const PORT = 8799;
const BASE = `http://127.0.0.1:${PORT}`;
const PERSIST = '.wrangler/e2e-state';
const SECRET = 'e2e-webhook-secret';

let passed = 0;
let failed = 0;
const failures = [];

function check(name, condition, detail) {
  if (condition) {
    passed += 1;
    console.log(`  PASS  ${name}`);
  } else {
    failed += 1;
    failures.push(name);
    console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

function checkStatus(name, response, expected) {
  check(
    name,
    response.status === expected,
    `expected ${expected}, got ${response.status} ${JSON.stringify(response.json ?? response.text).slice(0, 400)}`,
  );
}

async function request(method, path, options = {}) {
  const headers = { 'content-type': 'application/json', ...(options.headers ?? {}) };
  if (options.cookie) headers.cookie = options.cookie;
  const body =
    options.raw !== undefined ? options.raw : options.body !== undefined ? JSON.stringify(options.body) : undefined;
  const response = await fetch(BASE + path, { method, headers, body });
  const text = await response.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { status: response.status, json, text, cookies: response.headers.getSetCookie?.() ?? [] };
}

async function login(email, password) {
  const response = await request('POST', '/api/auth/login', { body: { email, password } });
  if (response.status !== 200) {
    throw new Error(`login failed for ${email}: ${response.status} ${JSON.stringify(response.json)}`);
  }
  const cookie = response.cookies[0]?.split(';')[0];
  if (!cookie) throw new Error(`no session cookie for ${email}`);
  return { cookie };
}

function call(session, method, path, body) {
  return request(method, `/api${path}`, { cookie: session.cookie, body });
}

const serverLogs = [];
let server = null;

async function main() {
  rmSync(PERSIST, { recursive: true, force: true });
  console.log('Applying migrations to a fresh local D1…');
  execFileSync('npx', ['wrangler', 'd1', 'migrations', 'apply', 'ugtp', '--local', '--persist-to', PERSIST], {
    stdio: 'inherit',
    env: { ...process.env, CI: '1' },
  });

  console.log('Starting workerd…');
  server = spawn(
    'npx',
    ['wrangler', 'dev', '--ip', '127.0.0.1', '--port', String(PORT), '--persist-to', PERSIST, '--var', `PSP_WEBHOOK_SECRET:${SECRET}`],
    { stdio: ['ignore', 'pipe', 'pipe'], detached: true, env: { ...process.env, CI: '1' } },
  );
  server.stdout.on('data', (chunk) => serverLogs.push(chunk.toString()));
  server.stderr.on('data', (chunk) => serverLogs.push(chunk.toString()));

  let ready = false;
  for (let attempt = 0; attempt < 120; attempt += 1) {
    try {
      const response = await fetch(`${BASE}/api/health`);
      if (response.ok) {
        ready = true;
        break;
      }
    } catch {
      /* not up yet */
    }
    await sleep(500);
  }
  if (!ready) {
    console.error(serverLogs.join('').slice(-6000));
    throw new Error('wrangler dev did not become ready');
  }

  const health = await request('GET', '/api/health');
  checkStatus('health endpoint', health, 200);

  const setup = await request('POST', '/api/setup', { body: {} });
  checkStatus('sandbox bootstrap', setup, 201);
  const tenants = setup.json?.tenants ?? [];
  const accounts = setup.json?.accounts ?? [];
  const mt = tenants.find((tenant) => tenant.jurisdiction === 'MT');
  const india = tenants.find((tenant) => tenant.jurisdiction === 'IN');
  check('two jurisdiction profiles seeded', Boolean(mt && india), JSON.stringify(tenants));
  if (!mt || !india) throw new Error('seed did not create expected tenants');

  const passwords = Object.fromEntries(accounts.map((account) => [account.email, account.password]));
  async function loginAs(email) {
    const secret = passwords[email];
    if (!secret) throw new Error(`missing seeded password for ${email}`);
    return login(email, secret);
  }

  const mtAdmin = await loginAs('mt.tenant_admin@ugtp.local');
  const mtFinance = await loginAs('mt.finance@ugtp.local');
  const mtCompliance = await loginAs('mt.compliance@ugtp.local');
  const mtPlayer = await loginAs('mt.player@ugtp.local');
  const inAdmin = await loginAs('in.tenant_admin@ugtp.local');
  const platform = await loginAs('platform@ugtp.local');

  const second = await request('POST', '/api/setup', { body: {} });
  checkStatus('bootstrap is single-use', second, 409);

  const scoped = await call(mtAdmin, 'GET', '/me');
  check('tenant admin is scoped to Malta', scoped.json?.tenant?.jurisdiction_code === 'MT');
  const indiaScoped = await call(inAdmin, 'GET', '/me');
  check('India tenant admin scoped', indiaScoped.json?.tenant?.jurisdiction_code === 'IN');
  const platformScoped = await call(platform, 'GET', '/tenants');
  check('platform admin sees both tenants', (platformScoped.json?.tenants ?? []).length === 2);

  const overviewIndia = await call(inAdmin, 'GET', '/overview');
  check('India profile is prohibited', overviewIndia.json?.jurisdiction?.money_gaming === 'prohibited');
  const overviewMalta = await call(mtAdmin, 'GET', '/overview');
  check('Malta profile is licence-gated', overviewMalta.json?.jurisdiction?.money_gaming === 'permitted_with_licence');

  const mtPlayerId = mt.playerId;
  const indiaPlayerId = india.playerId;
  check('seeded players exist', Boolean(mtPlayerId && indiaPlayerId));

  // ---------------------------------------------------------------- gaming
  const walletBefore = await call(mtAdmin, 'GET', `/players/${mtPlayerId}/wallet`);
  const xcrBefore = (walletBefore.json?.wallet ?? []).find((row) => row.asset_code === 'XCR')?.balance_minor ?? 0;
  const usdBefore = (walletBefore.json?.wallet ?? []).find((row) => row.asset_code === 'USD')?.balance_minor ?? 0;

  const round = await call(mtAdmin, 'POST', '/play/dice', {
    playerId: mtPlayerId,
    stakeMinor: 1000,
    assetCode: 'XCR',
    direction: 'under',
    target: 5000,
  });
  checkStatus('play-credit dice round settles', round, 200);
  check(
    'dice returns an integer roll in range',
    Number.isInteger(round.json?.roll) && round.json.roll >= 0 && round.json.roll < 10000,
    String(round.json?.roll),
  );
  const walletAfterRound = await call(mtAdmin, 'GET', `/players/${mtPlayerId}/wallet`);
  const xcrAfter = (walletAfterRound.json?.wallet ?? []).find((row) => row.asset_code === 'XCR')?.balance_minor ?? 0;
  check(
    'play-credit balance equals stake and payout',
    xcrAfter === xcrBefore - 1000 + round.json.payoutMinor,
    `${xcrBefore} -> ${xcrAfter} payout ${round.json?.payoutMinor}`,
  );

  const indiaPlay = await call(inAdmin, 'POST', '/play/dice', {
    playerId: indiaPlayerId,
    stakeMinor: 500,
    assetCode: 'XCR',
    direction: 'over',
    target: 5000,
  });
  checkStatus('non-monetary play is not money gaming', indiaPlay, 200);

  // --------------------------------------------------------------- cashier
  const indiaDeposit = await call(inAdmin, 'POST', '/payments/deposit', {
    playerId: indiaPlayerId,
    amountMinor: 1000,
    method: 'sandbox_card',
  });
  checkStatus('India deposit denied', indiaDeposit, 403);
  check('denial cites the prohibited profile', indiaDeposit.json?.error?.code === 'JURISDICTION_PROHIBITED', JSON.stringify(indiaDeposit.json));

  const deposit = await call(mtAdmin, 'POST', '/payments/deposit', {
    playerId: mtPlayerId,
    amountMinor: 50000,
    method: 'sandbox_card',
    idempotencyKey: 'e2e-dep-1',
  });
  checkStatus('licensed deposit captured', deposit, 201);
  const depositReplay = await call(mtAdmin, 'POST', '/payments/deposit', {
    playerId: mtPlayerId,
    amountMinor: 50000,
    method: 'sandbox_card',
    idempotencyKey: 'e2e-dep-1',
  });
  check('duplicate deposit is idempotent', depositReplay.json?.duplicate === true);

  const walletAfterDeposit = await call(mtAdmin, 'GET', `/players/${mtPlayerId}/wallet`);
  const usdAfterDeposit = (walletAfterDeposit.json?.wallet ?? []).find((row) => row.asset_code === 'USD')?.balance_minor ?? 0;
  check('deposit credited exactly once', usdAfterDeposit === usdBefore + 50000, `${usdBefore} -> ${usdAfterDeposit}`);

  const withdrawal = await call(mtAdmin, 'POST', '/payments/withdrawals', {
    playerId: mtPlayerId,
    amountMinor: 20000,
    method: 'bank_transfer',
    idempotencyKey: 'e2e-wd-1',
  });
  checkStatus('withdrawal held for approval', withdrawal, 201);
  check('withdrawal is pending approval', withdrawal.json?.payment?.status === 'pending_approval');

  const selfApprove = await call(mtAdmin, 'POST', `/payments/${withdrawal.json.payment.id}/approve`, {});
  checkStatus('requester cannot approve own withdrawal', selfApprove, 403);
  check('segregation of duties enforced', selfApprove.json?.error?.code === 'SEGREGATION_OF_DUTIES');

  const paidWithdrawal = await call(mtFinance, 'POST', `/payments/${withdrawal.json.payment.id}/approve`, {});
  checkStatus('finance approves withdrawal', paidWithdrawal, 200);
  check('withdrawal paid', paidWithdrawal.json?.payment?.status === 'paid');

  const overdraft = await call(mtAdmin, 'POST', '/payments/withdrawals', {
    playerId: mtPlayerId,
    amountMinor: 9000000,
    method: 'bank_transfer',
    idempotencyKey: 'e2e-wd-overdraft',
  });
  checkStatus('overdraft rejected by ledger guard', overdraft, 402);

  // ---------------------------------------------------------------- agents
  const agentA = await call(mtAdmin, 'POST', '/agents', { name: 'Alpha', code: 'A1', agentType: 'master' });
  checkStatus('agent created', agentA, 201);
  const agentB = await call(mtAdmin, 'POST', '/agents', {
    name: 'Beta',
    code: 'B1',
    agentType: 'regional',
    parentId: agentA.json.id,
  });
  checkStatus('child agent created', agentB, 201);
  const cycle = await call(mtAdmin, 'PATCH', `/agents/${agentA.json.id}/parent`, { parentId: agentB.json.id });
  checkStatus('hierarchy cycle rejected', cycle, 409);
  check('cycle code returned', cycle.json?.error?.code === 'HIERARCHY_CYCLE');

  // ---------------------------------------------------------------- credit
  const facility = await call(mtAdmin, 'POST', '/credit/facilities', {
    subjectType: 'player',
    subjectId: mtPlayerId,
    limitMinor: 100000,
    policyRef: 'credit-policy-v1',
  });
  checkStatus('credit facility requested', facility, 201);
  const selfActivate = await call(mtAdmin, 'POST', `/credit/facilities/${facility.json.id}/activate`, {});
  checkStatus('requester cannot activate own facility', selfActivate, 403);
  const activated = await call(mtFinance, 'POST', `/credit/facilities/${facility.json.id}/activate`, {});
  checkStatus('finance activates facility', activated, 200);

  const smallDraw = await call(mtAdmin, 'POST', `/credit/facilities/${facility.json.id}/draw`, {
    amountMinor: 10000,
    reason: 'e2e small draw',
  });
  checkStatus('draw below threshold posts', smallDraw, 200);
  const exposureAfterSmall = await call(mtAdmin, 'GET', '/credit/exposure');
  check('exposure reflects draw', exposureAfterSmall.json?.outstandingMinor === 10000, JSON.stringify(exposureAfterSmall.json));

  const largeDraw = await call(mtAdmin, 'POST', `/credit/facilities/${facility.json.id}/draw`, {
    amountMinor: 60000,
    reason: 'e2e large draw',
  });
  checkStatus('draw above threshold queued', largeDraw, 200);
  check('large draw needs approval', largeDraw.json?.status === 'pending_approval');

  const approvals = await call(mtFinance, 'GET', '/approvals');
  const pending = (approvals.json?.approvals ?? []).find((row) => row.id === largeDraw.json.approvalId);
  check('approval queued for finance', pending?.status === 'pending');

  const selfDecide = await call(mtAdmin, 'POST', `/approvals/${largeDraw.json.approvalId}/decide`, { approve: true });
  checkStatus('requester cannot decide own approval', selfDecide, 403);
  const decided = await call(mtFinance, 'POST', `/approvals/${largeDraw.json.approvalId}/decide`, { approve: true });
  checkStatus('finance approves large draw', decided, 200);
  const exposureAfterLarge = await call(mtAdmin, 'GET', '/credit/exposure');
  check('approved draw posts to exposure', exposureAfterLarge.json?.outstandingMinor === 70000, JSON.stringify(exposureAfterLarge.json));

  const overLimit = await call(mtAdmin, 'POST', `/credit/facilities/${facility.json.id}/draw`, {
    amountMinor: 50000,
    reason: 'over limit',
  });
  checkStatus('credit limit enforced', overLimit, 409);

  // ------------------------------------------------------------ settlements
  const claim = await call(mtAdmin, 'POST', '/settlements', {
    kind: 'off_platform',
    source: 'external',
    counterparty: 'Vendor Ltd',
    amountMinor: 5000,
    evidenceRef: 'inv-1',
  });
  checkStatus('external settlement claim recorded', claim, 201);
  check('claim is not treated as confirmed', claim.json?.status === 'claimed');

  const jumpToConfirmed = await call(mtAdmin, 'POST', `/settlements/${claim.json.id}/transition`, {
    next: 'confirmed',
    evidenceRef: 'inv-1',
  });
  checkStatus('claim cannot skip verification', jumpToConfirmed, 409);

  const noEvidence = await call(mtAdmin, 'POST', '/settlements', {
    kind: 'off_platform',
    source: 'external',
    counterparty: 'Vendor Two',
    amountMinor: 4000,
  });
  const verifyWithoutEvidence = await call(mtCompliance, 'POST', `/settlements/${noEvidence.json.id}/transition`, {
    next: 'verified',
  });
  checkStatus('verification requires evidence', verifyWithoutEvidence, 400);

  const verified = await call(mtCompliance, 'POST', `/settlements/${claim.json.id}/transition`, {
    next: 'verified',
    evidenceRef: 'inv-1',
  });
  checkStatus('compliance verifies settlement', verified, 200);
  const confirmed = await call(mtAdmin, 'POST', `/settlements/${claim.json.id}/transition`, {
    next: 'confirmed',
    evidenceRef: 'inv-1',
  });
  checkStatus('second actor confirms settlement', confirmed, 200);
  const reconciled = await call(mtAdmin, 'POST', `/settlements/${claim.json.id}/transition`, { next: 'reconciled' });
  checkStatus('settlement reconciled', reconciled, 200);

  // ------------------------------------------------------------- redemption
  const redemption = await call(mtAdmin, 'POST', '/redemptions', {
    playerId: mtPlayerId,
    units: 5000,
    assetCode: 'USD',
  });
  checkStatus('redemption request holds funds', redemption, 201);
  const selfRedeem = await call(mtAdmin, 'POST', `/redemptions/${redemption.json.id}/approve`, {});
  checkStatus('requester cannot approve own redemption', selfRedeem, 403);
  const paidRedemption = await call(mtFinance, 'POST', `/redemptions/${redemption.json.id}/approve`, {});
  checkStatus('finance pays redemption', paidRedemption, 200);
  check('redemption paid', paidRedemption.json?.redemption?.status === 'paid');

  const creditRedemption = await call(mtAdmin, 'POST', '/redemptions', {
    playerId: mtPlayerId,
    units: 1000,
    assetCode: 'XCR',
  });
  checkStatus('play credits cannot be redeemed for money', creditRedemption, 400);
  check('non-monetary classification enforced', creditRedemption.json?.error?.code === 'ASSET_NOT_MONETARY');

  // -------------------------------------------------------------- affiliates
  const affiliate = await call(mtAdmin, 'POST', '/affiliates', {
    name: 'Partner One',
    code: 'P1',
    taxWithholdingBps: 1500,
  });
  checkStatus('affiliate created pending', affiliate, 201);
  const affiliateActive = await call(mtAdmin, 'PATCH', `/affiliates/${affiliate.json.id}/status`, { status: 'active' });
  checkStatus('affiliate activated', affiliateActive, 200);

  const contract = await call(mtAdmin, 'POST', `/affiliates/${affiliate.json.id}/contracts`, {
    model: 'cpa',
    cpaMinor: 5000,
    minPayoutMinor: 1000,
  });
  checkStatus('contract v1 published', contract, 201);

  const attribution = await call(mtAdmin, 'POST', `/affiliates/${affiliate.json.id}/attribute`, {
    playerId: mtPlayerId,
  });
  checkStatus('player attributed once', attribution, 201);

  const commission = await call(mtAdmin, 'POST', `/affiliates/${affiliate.json.id}/commissions`, {
    periodStart: Date.now() - 30 * 86_400_000,
    periodEnd: Date.now() + 86_400_000,
  });
  checkStatus('commission computed from contract', commission, 201);
  check('CPA commission equals contract rate', commission.json?.amount_minor === 5000, JSON.stringify(commission.json?.amount_minor));

  const reproduction = await call(mtFinance, 'GET', `/commissions/${commission.json.id}/verify`);
  check(
    'commission reproduces from source lines',
    reproduction.json?.matches === true && reproduction.json?.linesReproducible === true,
    JSON.stringify(reproduction.json),
  );

  const selfCommission = await call(mtAdmin, 'POST', `/commissions/${commission.json.id}/approve`, {});
  checkStatus('commission requester cannot approve', selfCommission, 403);
  const approvedCommission = await call(mtFinance, 'POST', `/commissions/${commission.json.id}/approve`, {});
  checkStatus('finance approves commission', approvedCommission, 200);

  const payout = await call(mtAdmin, 'POST', `/commissions/${commission.json.id}/payout`, {});
  checkStatus('payout requested', payout, 201);
  check(
    'withholding applied from affiliate contract',
    payout.json?.withheld_minor === 750 && payout.json?.net_minor === 4250,
    JSON.stringify({ withheld: payout.json?.withheld_minor, net: payout.json?.net_minor }),
  );

  const selfPayout = await call(mtAdmin, 'POST', `/payouts/${payout.json.id}/approve`, {});
  checkStatus('payout requester cannot approve', selfPayout, 403);
  const paidPayout = await call(mtFinance, 'POST', `/payouts/${payout.json.id}/approve`, {});
  checkStatus('finance approves payout', paidPayout, 200);
  check('payout marked paid', paidPayout.json?.payout?.status === 'paid');

  // --------------------------------------------------------------- isolation
  const crossTenant = await call(inAdmin, 'GET', `/players/${mtPlayerId}/wallet`);
  checkStatus('cross-tenant player access denied', crossTenant, 404);
  const indiaPayments = await call(inAdmin, 'GET', '/payments');
  check(
    'cross-tenant payments isolated',
    !(indiaPayments.json?.payments ?? []).some((row) => row.id === deposit.json.payment.id),
  );

  // ------------------------------------------------------------- fail-closed
  const disabled = await call(platform, 'POST', '/platform/settings', { key: 'real_money_enabled', value: 'false' });
  checkStatus('platform can disable real money', disabled, 200);
  const blocked = await call(mtAdmin, 'POST', '/payments/deposit', {
    playerId: mtPlayerId,
    amountMinor: 1000,
    method: 'sandbox_card',
  });
  checkStatus('real money disabled blocks deposit', blocked, 403);
  check('denial code is explicit', blocked.json?.error?.code === 'REAL_MONEY_DISABLED');
  const enabled = await call(platform, 'POST', '/platform/settings', { key: 'real_money_enabled', value: 'true' });
  checkStatus('real money re-enabled', enabled, 200);

  // ---------------------------------------------------------------- webhooks
  const payload = JSON.stringify({
    eventId: 'evt-chargeback-1',
    type: 'payment.chargeback',
    paymentId: deposit.json.payment.id,
  });
  const badSignature = await request('POST', `/api/webhooks/psp/${mt.id}`, {
    raw: payload,
    headers: { 'x-psp-signature': 'deadbeef' },
  });
  checkStatus('webhook rejects invalid signature', badSignature, 401);
  const signature = createHmac('sha256', SECRET).update(payload).digest('hex');
  const webhook = await request('POST', `/api/webhooks/psp/${mt.id}`, {
    raw: payload,
    headers: { 'x-psp-signature': signature },
  });
  checkStatus('webhook accepts signed event', webhook, 200);
  const webhookReplay = await request('POST', `/api/webhooks/psp/${mt.id}`, {
    raw: payload,
    headers: { 'x-psp-signature': signature },
  });
  check('webhook deduplicates provider event', webhookReplay.json?.duplicate === true);

  // ----------------------------------------------------------------- ledger
  const maltaFinal = await call(mtAdmin, 'GET', '/overview');
  check('Malta ledger nets to zero', maltaFinal.json?.ledgerBalanced === true);
  const indiaFinal = await call(inAdmin, 'GET', '/overview');
  check('India ledger nets to zero', indiaFinal.json?.ledgerBalanced === true);
  const auditTrail = await call(mtAdmin, 'GET', '/audit');
  check('audit trail records privileged actions', (auditTrail.json?.entries ?? []).length > 0);
}

try {
  await main();
} catch (error) {
  failed += 1;
  console.error('\nE2E ABORTED:', error?.message ?? error);
  console.error(serverLogs.join('').slice(-6000));
} finally {
  if (server) {
    try {
      process.kill(-server.pid, 'SIGTERM');
    } catch {
      try {
        server.kill('SIGTERM');
      } catch {
        /* already gone */
      }
    }
  }
  console.log(`\nE2E RESULT: ${passed} passed, ${failed} failed`);
  if (failures.length) console.error('Failing checks:', failures.join(' | '));
  await sleep(300);
  process.exit(failed === 0 ? 0 : 1);
}
