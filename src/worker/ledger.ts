import { ApiError, newId, now, type AuthContext, type Env } from './core';

/**
 * Double-entry ledger.
 *
 * Every financial movement is a transaction made of postings whose signed
 * amounts sum to zero per asset. Balances are a cached projection guarded by a
 * CHECK constraint, so an attempted overdraft aborts the entire D1 batch.
 * Transactions are never edited; corrections are posted as reversals.
 */

export type OwnerType = 'player' | 'agent' | 'platform' | 'external';

export interface AccountRef {
  tenantId: string;
  ownerType: OwnerType;
  ownerId: string;
  assetCode: string;
  kind: 'available' | 'held' | 'revenue' | 'clearing' | 'receivable';
  allowNegative?: boolean;
}

export interface PostingEntry {
  accountId: string;
  assetCode: string;
  amountMinor: number;
}

export async function ensureAccount(env: Env, ref: AccountRef): Promise<string> {
  const allowNegative = ref.allowNegative ? 1 : 0;
  const existing = await env.DB.prepare(
    `SELECT id FROM accounts WHERE tenant_id = ? AND owner_type = ? AND owner_id = ? AND asset_code = ? AND kind = ?`,
  )
    .bind(ref.tenantId, ref.ownerType, ref.ownerId, ref.assetCode, ref.kind)
    .first<{ id: string }>();
  if (existing) return existing.id;

  const id = newId('acct');
  const createdAt = now();
  await env.DB.batch([
    env.DB.prepare(
      `INSERT OR IGNORE INTO accounts (id, tenant_id, owner_type, owner_id, asset_code, kind, allow_negative, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(id, ref.tenantId, ref.ownerType, ref.ownerId, ref.assetCode, ref.kind, allowNegative, createdAt),
    env.DB.prepare(
      `INSERT OR IGNORE INTO account_balances (account_id, balance_minor, allow_negative, updated_at)
       VALUES (?, 0, ?, ?)`,
    ).bind(id, allowNegative, createdAt),
  ]);
  const created = await env.DB.prepare(
    `SELECT id FROM accounts WHERE tenant_id = ? AND owner_type = ? AND owner_id = ? AND asset_code = ? AND kind = ?`,
  )
    .bind(ref.tenantId, ref.ownerType, ref.ownerId, ref.assetCode, ref.kind)
    .first<{ id: string }>();
  if (!created) throw new ApiError(500, 'ACCOUNT_CREATE_FAILED', 'Unable to open ledger account');
  return created.id;
}

export async function balanceOf(env: Env, accountId: string): Promise<number> {
  const row = await env.DB.prepare('SELECT balance_minor FROM account_balances WHERE account_id = ?')
    .bind(accountId)
    .first<{ balance_minor: number }>();
  return row?.balance_minor ?? 0;
}

export async function accountBalance(env: Env, ref: AccountRef): Promise<number> {
  const id = await ensureAccount(env, ref);
  return balanceOf(env, id);
}

export interface PostInput {
  kind: string;
  idempotencyKey: string;
  /** Pre-generated so callers can reference the transaction in extra statements. */
  txnId?: string;
  entries: PostingEntry[];
  metadata?: Record<string, unknown>;
  /** Extra statements committed atomically with the postings (e.g. a round row). */
  extra?: D1PreparedStatement[];
}

export interface PostResult {
  txnId: string;
  duplicate: boolean;
}

function validate(entries: PostingEntry[]): void {
  if (entries.length < 2) throw new ApiError(400, 'POSTING_REQUIRED', 'A transaction requires at least two postings');
  const totals = new Map<string, number>();
  for (const entry of entries) {
    if (!Number.isSafeInteger(entry.amountMinor) || entry.amountMinor === 0) {
      throw new ApiError(400, 'INVALID_POSTING', 'Posting amounts must be non-zero integers');
    }
    totals.set(entry.assetCode, (totals.get(entry.assetCode) ?? 0) + entry.amountMinor);
  }
  for (const [asset, total] of totals) {
    if (total !== 0) {
      throw new ApiError(500, 'UNBALANCED_POSTING', `Postings do not balance for ${asset}`, { asset, total });
    }
  }
}

export async function post(env: Env, auth: AuthContext | null, input: PostInput): Promise<PostResult> {
  validate(input.entries);
  const tenantId = auth?.tenantId ?? null;
  if (!tenantId) throw new ApiError(403, 'TENANT_REQUIRED', 'Ledger postings require a tenant');

  const duplicate = await env.DB.prepare(
    'SELECT id FROM transactions WHERE tenant_id = ? AND idempotency_key = ?',
  )
    .bind(tenantId, input.idempotencyKey)
    .first<{ id: string }>();
  if (duplicate) return { txnId: duplicate.id, duplicate: true };

  const txnId = input.txnId ?? newId('txn');
  const createdAt = now();
  const statements: D1PreparedStatement[] = [
    env.DB.prepare(
      `INSERT INTO transactions (id, tenant_id, kind, status, idempotency_key, actor_id, metadata_json, created_at)
       VALUES (?, ?, ?, 'posted', ?, ?, ?, ?)`,
    ).bind(
      txnId,
      tenantId,
      input.kind,
      input.idempotencyKey,
      auth?.userId ?? null,
      JSON.stringify(input.metadata ?? {}),
      createdAt,
    ),
  ];

  for (const entry of input.entries) {
    statements.push(
      env.DB.prepare(
        `INSERT INTO postings (id, txn_id, tenant_id, account_id, asset_code, amount_minor, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).bind(newId('pst'), txnId, tenantId, entry.accountId, entry.assetCode, entry.amountMinor, createdAt),
    );
  }
  for (const entry of input.entries) {
    statements.push(
      env.DB.prepare(
        'UPDATE account_balances SET balance_minor = balance_minor + ?, updated_at = ? WHERE account_id = ?',
      ).bind(entry.amountMinor, createdAt, entry.accountId),
    );
  }
  if (input.extra) statements.push(...input.extra);

  try {
    await env.DB.batch(statements);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes('UNIQUE constraint failed') && message.includes('transactions')) {
      const existing = await env.DB.prepare(
        'SELECT id FROM transactions WHERE tenant_id = ? AND idempotency_key = ?',
      )
        .bind(tenantId, input.idempotencyKey)
        .first<{ id: string }>();
      if (existing) return { txnId: existing.id, duplicate: true };
    }
    if (message.includes('CHECK constraint failed')) {
      throw new ApiError(402, 'INSUFFICIENT_FUNDS', 'The account balance is insufficient for this transaction');
    }
    throw error;
  }
  return { txnId, duplicate: false };
}

export async function reverseTransaction(
  env: Env,
  auth: AuthContext,
  txnId: string,
  reason: string,
): Promise<{ reversalTxnId: string; duplicate: boolean }> {
  const tenantId = auth.tenantId;
  if (!tenantId) throw new ApiError(403, 'TENANT_REQUIRED', 'Tenant context required');
  const txn = await env.DB.prepare(
    'SELECT id, kind, status, reverses_txn_id FROM transactions WHERE id = ? AND tenant_id = ?',
  )
    .bind(txnId, tenantId)
    .first<{ id: string; kind: string; status: string; reverses_txn_id: string | null }>();
  if (!txn) throw new ApiError(404, 'TXN_NOT_FOUND', 'Transaction not found');
  if (txn.reverses_txn_id) throw new ApiError(409, 'NOT_REVERSIBLE', 'A reversal transaction cannot itself be reversed');

  const postings = await env.DB.prepare(
    'SELECT account_id, asset_code, amount_minor FROM postings WHERE txn_id = ?',
  )
    .bind(txnId)
    .all<{ account_id: string; asset_code: string; amount_minor: number }>();
  const entries = (postings.results ?? []).map((p) => ({
    accountId: p.account_id,
    assetCode: p.asset_code,
    amountMinor: -p.amount_minor,
  }));

  const reversal = await post(env, auth, {
    kind: `${txn.kind}.reversal`,
    idempotencyKey: `reverse:${txnId}`,
    entries,
    metadata: { reason, originalTxnId: txnId },
  });
  await env.DB.prepare(`UPDATE transactions SET status = 'reversed' WHERE id = ? AND tenant_id = ? AND status = 'posted'`)
    .bind(txnId, tenantId)
    .run();
  return { reversalTxnId: reversal.txnId, duplicate: reversal.duplicate };
}

/** Returns every asset whose postings do not net to zero. Empty means balanced. */
export async function unbalancedAssets(env: Env, tenantId: string): Promise<string[]> {
  const rows = await env.DB.prepare(
    `SELECT asset_code, SUM(amount_minor) AS total FROM postings WHERE tenant_id = ? GROUP BY asset_code HAVING SUM(amount_minor) <> 0`,
  )
    .bind(tenantId)
    .all<{ asset_code: string; total: number }>();
  return (rows.results ?? []).map((r) => r.asset_code);
}

/** Recomputes projections from postings. Used by reconciliation reports and tests. */
export async function projectionMismatches(env: Env, tenantId: string): Promise<string[]> {
  const rows = await env.DB.prepare(
    `SELECT b.account_id, b.balance_minor,
            COALESCE((SELECT SUM(p.amount_minor) FROM postings p WHERE p.account_id = b.account_id), 0) AS computed
     FROM account_balances b JOIN accounts a ON a.id = b.account_id
     WHERE a.tenant_id = ? AND b.balance_minor <> computed`,
  )
    .bind(tenantId)
    .all<{ account_id: string }>();
  return (rows.results ?? []).map((r) => r.account_id);
}
