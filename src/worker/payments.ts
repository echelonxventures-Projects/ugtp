import { ApiError, audit, isoDay, newId, now, realMoneyEnabled, settingNumber, type AuthContext, type Env } from './core';
import { ensureAccount, post, reverseTransaction } from './ledger';
import { evaluateTenantAction } from './policy';
import { assertPlayerEligible, getPlayer } from './players';

/**
 * Provider-neutral payments. The only enabled adapter is `sandbox`, which moves
 * no real funds: it authorizes and captures immediately and records a sandbox
 * provider reference. Enabling a live provider requires a licensed PSP and an
 * adapter plus webhook secret; until then real-money remains fail-closed at the
 * regulatory policy layer.
 */

const SANDBOX = 'sandbox';

async function playerUsdAccount(env: Env, tenantId: string, playerId: string, kind: 'available' | 'held') {
  return ensureAccount(env, { tenantId, ownerType: 'player', ownerId: playerId, assetCode: 'USD', kind });
}

async function pspAccount(env: Env, tenantId: string) {
  return ensureAccount(env, {
    tenantId,
    ownerType: 'external',
    ownerId: `psp:${SANDBOX}`,
    assetCode: 'USD',
    kind: 'clearing',
    allowNegative: true,
  });
}

export async function listPayments(env: Env, tenantId: string, limit = 100) {
  const rows = await env.DB.prepare(
    `SELECT p.id, p.player_id, p.direction, p.amount_minor, p.currency, p.method, p.provider, p.provider_ref,
            p.status, p.jurisdiction_code, p.licence_id, p.requested_by, p.failure_reason, p.created_at, p.updated_at,
            u.display_name, u.email
     FROM payments p JOIN players pl ON pl.id = p.player_id JOIN users u ON u.id = pl.user_id
     WHERE p.tenant_id = ? ORDER BY p.created_at DESC LIMIT ?`,
  )
    .bind(tenantId, limit)
    .all<Record<string, unknown>>();
  return rows.results ?? [];
}

export async function deposit(
  env: Env,
  auth: AuthContext,
  input: { playerId: string; amountMinor: number; method: string; idempotencyKey: string },
) {
  const tenantId = auth.tenantId;
  if (!tenantId) throw new ApiError(403, 'TENANT_REQUIRED', 'Tenant context required');
  if (!Number.isSafeInteger(input.amountMinor) || input.amountMinor <= 0) {
    throw new ApiError(400, 'INVALID_AMOUNT', 'Deposit must be a positive integer amount');
  }
  if (input.amountMinor > 1_000_000_00) throw new ApiError(400, 'LIMIT_EXCEEDED', 'Deposit exceeds the platform limit');

  const existing = await env.DB.prepare('SELECT id FROM payments WHERE tenant_id = ? AND idempotency_key = ?')
    .bind(tenantId, input.idempotencyKey)
    .first<{ id: string }>();
  if (existing) {
    const payment = await getPayment(env, tenantId, existing.id);
    return { payment, duplicate: true };
  }

  const player = await getPlayer(env, tenantId, input.playerId);
  await assertPlayerEligible(env, player);
  if (player.daily_deposit_limit) {
    const today = isoDay();
    const sum = await env.DB.prepare(
      `SELECT COALESCE(SUM(amount_minor),0) AS n FROM payments
       WHERE tenant_id = ? AND player_id = ? AND direction = 'deposit' AND status IN ('captured','paid') AND created_at >= ?`,
    )
      .bind(tenantId, player.id, today)
      .first<{ n: number }>();
    if ((sum?.n ?? 0) + input.amountMinor > player.daily_deposit_limit) {
      throw new ApiError(403, 'DEPOSIT_LIMIT_REACHED', 'Daily deposit limit would be exceeded');
    }
  }

  const decision = await evaluateTenantAction(env, {
    tenantId,
    jurisdictionCode: player.jurisdiction_code,
    action: 'deposit',
    realMoneyEnabled: await realMoneyEnabled(env),
  });
  if (!decision.allowed) throw new ApiError(403, decision.code, decision.reason, { jurisdiction: decision.jurisdiction });

  const paymentId = newId('pay');
  const txnId = newId('txn');
  const createdAt = now();
  const playerAccount = await playerUsdAccount(env, tenantId, player.id, 'available');
  const clearing = await pspAccount(env, tenantId);

  await post(env, auth, {
    kind: 'payment.deposit',
    txnId,
    idempotencyKey: `deposit:${input.idempotencyKey}`,
    entries: [
      { accountId: clearing, assetCode: 'USD', amountMinor: -input.amountMinor },
      { accountId: playerAccount, assetCode: 'USD', amountMinor: input.amountMinor },
    ],
    metadata: { paymentId, playerId: player.id, method: input.method },
    extra: [
      env.DB.prepare(
        `INSERT INTO payments (id, tenant_id, player_id, direction, amount_minor, currency, method, provider, provider_ref,
                               status, jurisdiction_code, licence_id, idempotency_key, requested_by, txn_id, created_at, updated_at)
         VALUES (?, ?, ?, 'deposit', ?, 'USD', ?, ?, ?, 'captured', ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        paymentId,
        tenantId,
        player.id,
        input.amountMinor,
        input.method,
        SANDBOX,
        `sbx_dep_${paymentId}`,
        player.jurisdiction_code,
        decision.licenceId,
        input.idempotencyKey,
        auth.userId,
        txnId,
        createdAt,
        createdAt,
      ),
      audit(env, auth, 'payment.deposit.captured', 'payment', paymentId, {
        amountMinor: input.amountMinor,
        playerId: player.id,
        licenceId: decision.licenceId,
      }),
    ],
  });

  return { payment: await getPayment(env, tenantId, paymentId), duplicate: false };
}

export async function requestWithdrawal(
  env: Env,
  auth: AuthContext,
  input: { playerId: string; amountMinor: number; method: string; idempotencyKey: string },
) {
  const tenantId = auth.tenantId;
  if (!tenantId) throw new ApiError(403, 'TENANT_REQUIRED', 'Tenant context required');
  const minWithdrawal = await settingNumber(env, 'min_withdrawal_minor', 1000);
  if (!Number.isSafeInteger(input.amountMinor) || input.amountMinor < minWithdrawal) {
    throw new ApiError(400, 'INVALID_AMOUNT', `Withdrawal minimum is ${minWithdrawal} minor units`);
  }
  const existing = await env.DB.prepare('SELECT id FROM payments WHERE tenant_id = ? AND idempotency_key = ?')
    .bind(tenantId, input.idempotencyKey)
    .first<{ id: string }>();
  if (existing) return { payment: await getPayment(env, tenantId, existing.id), duplicate: true };

  const player = await getPlayer(env, tenantId, input.playerId);
  await assertPlayerEligible(env, player);
  if (player.kyc_status !== 'verified') {
    throw new ApiError(403, 'KYC_REQUIRED', 'Withdrawals require a verified identity');
  }

  const decision = await evaluateTenantAction(env, {
    tenantId,
    jurisdictionCode: player.jurisdiction_code,
    action: 'withdrawal',
    realMoneyEnabled: await realMoneyEnabled(env),
  });
  if (!decision.allowed) throw new ApiError(403, decision.code, decision.reason, { jurisdiction: decision.jurisdiction });

  const available = await playerUsdAccount(env, tenantId, player.id, 'available');
  const held = await playerUsdAccount(env, tenantId, player.id, 'held');
  const paymentId = newId('pay');
  const txnId = newId('txn');
  const createdAt = now();

  await post(env, auth, {
    kind: 'payment.withdrawal_hold',
    txnId,
    idempotencyKey: `withdrawal-hold:${input.idempotencyKey}`,
    entries: [
      { accountId: available, assetCode: 'USD', amountMinor: -input.amountMinor },
      { accountId: held, assetCode: 'USD', amountMinor: input.amountMinor },
    ],
    metadata: { paymentId, playerId: player.id, method: input.method },
    extra: [
      env.DB.prepare(
        `INSERT INTO payments (id, tenant_id, player_id, direction, amount_minor, currency, method, provider,
                               status, jurisdiction_code, licence_id, idempotency_key, requested_by, txn_id, created_at, updated_at)
         VALUES (?, ?, ?, 'withdrawal', ?, 'USD', ?, ?, 'pending_approval', ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        paymentId,
        tenantId,
        player.id,
        input.amountMinor,
        input.method,
        SANDBOX,
        player.jurisdiction_code,
        decision.licenceId,
        input.idempotencyKey,
        auth.userId,
        txnId,
        createdAt,
        createdAt,
      ),
      audit(env, auth, 'payment.withdrawal.requested', 'payment', paymentId, {
        amountMinor: input.amountMinor,
        playerId: player.id,
      }),
    ],
  });

  return { payment: await getPayment(env, tenantId, paymentId), duplicate: false };
}

export async function approveWithdrawal(env: Env, auth: AuthContext, paymentId: string) {
  const tenantId = auth.tenantId;
  if (!tenantId) throw new ApiError(403, 'TENANT_REQUIRED', 'Tenant context required');
  if (!auth.permissions.has('payment:approve')) throw new ApiError(403, 'FORBIDDEN', 'Withdrawal approval permission required');
  const payment = await getPayment(env, tenantId, paymentId);
  if (payment.direction !== 'withdrawal') throw new ApiError(400, 'WRONG_PAYMENT_TYPE', 'Not a withdrawal');
  if (payment.status !== 'pending_approval') throw new ApiError(409, 'INVALID_STATE', `Payment is ${payment.status}`);
  if (payment.requested_by === auth.userId) {
    throw new ApiError(403, 'SEGREGATION_OF_DUTIES', 'The requester cannot approve their own withdrawal');
  }
  const player = await getPlayer(env, tenantId, payment.player_id);
  const decision = await evaluateTenantAction(env, {
    tenantId,
    jurisdictionCode: payment.jurisdiction_code,
    action: 'withdrawal',
    realMoneyEnabled: await realMoneyEnabled(env),
  });
  if (!decision.allowed) throw new ApiError(403, decision.code, decision.reason, { jurisdiction: decision.jurisdiction });

  const held = await playerUsdAccount(env, tenantId, player.id, 'held');
  const clearing = await pspAccount(env, tenantId);
  const txnId = newId('txn');
  const providerRef = `sbx_wd_${paymentId}`;
  await post(env, auth, {
    kind: 'payment.withdrawal_payout',
    txnId,
    idempotencyKey: `withdrawal-payout:${paymentId}`,
    entries: [
      { accountId: held, assetCode: 'USD', amountMinor: -payment.amount_minor },
      { accountId: clearing, assetCode: 'USD', amountMinor: payment.amount_minor },
    ],
    metadata: { paymentId, approver: auth.userId },
    extra: [
      env.DB.prepare(
        `UPDATE payments SET status = 'paid', provider_ref = ?, txn_id = ?, updated_at = ?
         WHERE id = ? AND tenant_id = ? AND status = 'pending_approval'`,
      ).bind(providerRef, txnId, now(), paymentId, tenantId),
      audit(env, auth, 'payment.withdrawal.paid', 'payment', paymentId, { amountMinor: payment.amount_minor }),
    ],
  });
  return getPayment(env, tenantId, paymentId);
}

export async function rejectWithdrawal(env: Env, auth: AuthContext, paymentId: string, reason: string) {
  const tenantId = auth.tenantId;
  if (!tenantId) throw new ApiError(403, 'TENANT_REQUIRED', 'Tenant context required');
  if (!auth.permissions.has('payment:approve')) throw new ApiError(403, 'FORBIDDEN', 'Withdrawal approval permission required');
  const payment = await getPayment(env, tenantId, paymentId);
  if (payment.status !== 'pending_approval') throw new ApiError(409, 'INVALID_STATE', `Payment is ${payment.status}`);
  if (payment.requested_by === auth.userId) {
    throw new ApiError(403, 'SEGREGATION_OF_DUTIES', 'The requester cannot decide their own withdrawal');
  }
  const available = await playerUsdAccount(env, tenantId, payment.player_id, 'available');
  const held = await playerUsdAccount(env, tenantId, payment.player_id, 'held');
  await post(env, auth, {
    kind: 'payment.withdrawal_release',
    idempotencyKey: `withdrawal-release:${paymentId}`,
    entries: [
      { accountId: held, assetCode: 'USD', amountMinor: -payment.amount_minor },
      { accountId: available, assetCode: 'USD', amountMinor: payment.amount_minor },
    ],
    metadata: { paymentId, reason },
    extra: [
      env.DB.prepare(
        `UPDATE payments SET status = 'rejected', failure_reason = ?, updated_at = ?
         WHERE id = ? AND tenant_id = ? AND status = 'pending_approval'`,
      ).bind(reason, now(), paymentId, tenantId),
      audit(env, auth, 'payment.withdrawal.rejected', 'payment', paymentId, { reason }),
    ],
  });
  return getPayment(env, tenantId, paymentId);
}

export async function getPayment(env: Env, tenantId: string, paymentId: string) {
  const row = await env.DB.prepare(
    `SELECT id, tenant_id, player_id, direction, amount_minor, currency, method, provider, provider_ref, status,
            jurisdiction_code, licence_id, idempotency_key, requested_by, txn_id, failure_reason, created_at, updated_at
     FROM payments WHERE id = ? AND tenant_id = ?`,
  )
    .bind(paymentId, tenantId)
    .first<{
      id: string;
      tenant_id: string;
      player_id: string;
      direction: string;
      amount_minor: number;
      status: string;
      jurisdiction_code: string;
      provider_ref: string | null;
      requested_by: string | null;
      txn_id: string | null;
      [key: string]: unknown;
    }>();
  if (!row) throw new ApiError(404, 'PAYMENT_NOT_FOUND', 'Payment not found');
  return row;
}

function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function hmacHex(secret: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body));
  return Array.from(new Uint8Array(sig), (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Signed provider callback. Signature verification happens before any state
 * change; events are stored with a unique provider event id so duplicate
 * deliveries are idempotent.
 */
export async function pspWebhook(env: Env, tenantId: string, rawBody: string, signature: string | null) {
  const secret = env.PSP_WEBHOOK_SECRET;
  if (!secret) throw new ApiError(503, 'PSP_NOT_CONFIGURED', 'No payment provider webhook secret is configured');
  if (!signature) throw new ApiError(401, 'SIGNATURE_MISSING', 'Missing provider signature');
  const expected = await hmacHex(secret, rawBody);
  if (!timingSafeEqualHex(expected, signature.toLowerCase())) {
    throw new ApiError(401, 'SIGNATURE_INVALID', 'Provider signature is invalid');
  }

  let payload: { id?: string; eventId?: string; type?: string; paymentId?: string; providerRef?: string };
  try {
    payload = JSON.parse(rawBody) as typeof payload;
  } catch {
    throw new ApiError(400, 'INVALID_CALLBACK', 'Callback body is not valid JSON');
  }
  const eventId = payload.eventId ?? payload.id;
  if (!eventId || !payload.type) throw new ApiError(400, 'INVALID_CALLBACK', 'Callback requires eventId and type');

  const duplicate = await env.DB.prepare(
    'SELECT id FROM payment_events WHERE tenant_id = ? AND provider = ? AND provider_event_id = ?',
  )
    .bind(tenantId, SANDBOX, eventId)
    .first();
  if (duplicate) return { received: true, duplicate: true };

  await env.DB.prepare(
    `INSERT INTO payment_events (id, tenant_id, payment_id, provider, provider_event_id, event_type, signature_valid, payload_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)`,
  )
    .bind(newId('evt'), tenantId, payload.paymentId ?? null, SANDBOX, eventId, payload.type, rawBody, now())
    .run();

  if (payload.type === 'payment.chargeback' && payload.paymentId) {
    const payment = await getPayment(env, tenantId, payload.paymentId);
    if (payment.txn_id) {
      try {
        const auth = { tenantId, userId: 'psp-webhook', role: 'platform_admin' } as AuthContext;
        await reverseTransaction(env, auth, payment.txn_id, 'provider chargeback');
      } catch {
        // Insufficient balance: keep the payment disputed for manual recovery.
      }
    }
    await env.DB.prepare(`UPDATE payments SET status = 'disputed', updated_at = ? WHERE id = ? AND tenant_id = ?`)
      .bind(now(), payment.id, tenantId)
      .run();
  }

  return { received: true, duplicate: false };
}
