import { ApiError, audit, isoDay, newId, now, type AuthContext, type Env } from './core';
import {
  diceMultiplierBp,
  diceOutcome,
  diceRoll,
  isPlayableDiceTarget,
  payoutFor,
  randomHex,
  sha256Hex,
} from '../shared/engine';
import { balanceOf, ensureAccount, post } from './ledger';
import { evaluateTenantAction } from './policy';
import { assertPlayerEligible, getPlayer, playerWallet } from './players';
import { realMoneyEnabled } from './core';

export interface GameRow {
  id: string;
  tenant_id: string;
  code: string;
  name: string;
  category: string;
  provider: string;
  rtp_bps: number;
  status: string;
  config_json: string;
}

export async function listGames(env: Env, tenantId: string) {
  const rows = await env.DB.prepare(
    'SELECT id, code, name, category, provider, rtp_bps, status FROM games WHERE tenant_id = ? ORDER BY name',
  )
    .bind(tenantId)
    .all<GameRow>();
  return rows.results ?? [];
}

async function getGame(env: Env, tenantId: string, code: string): Promise<GameRow> {
  const row = await env.DB.prepare('SELECT * FROM games WHERE tenant_id = ? AND code = ?')
    .bind(tenantId, code)
    .first<GameRow>();
  if (!row) throw new ApiError(404, 'GAME_NOT_FOUND', 'Game is not available for this tenant');
  if (row.status !== 'active') throw new ApiError(409, 'GAME_DISABLED', `Game status is ${row.status}`);
  return row;
}

async function getAsset(env: Env, code: string) {
  const row = await env.DB.prepare(
    'SELECT code, name, classification, monetary, redeemable, conversion_rate_minor FROM assets WHERE code = ?',
  )
    .bind(code)
    .first<{ code: string; name: string; classification: string; monetary: number; redeemable: number; conversion_rate_minor: number }>();
  if (!row) throw new ApiError(400, 'ASSET_UNKNOWN', 'Unknown asset');
  return row;
}

async function openSession(env: Env, tenantId: string, playerId: string, gameId: string, assetCode: string) {
  const existing = await env.DB.prepare(
    `SELECT id, server_seed, server_seed_hash, client_seed, nonce FROM game_sessions
     WHERE tenant_id = ? AND player_id = ? AND game_id = ? AND asset_code = ? AND status = 'open'
     ORDER BY created_at DESC LIMIT 1`,
  )
    .bind(tenantId, playerId, gameId, assetCode)
    .first<{ id: string; server_seed: string; server_seed_hash: string; client_seed: string; nonce: number }>();
  if (existing) return existing;
  const seed = randomHex(32);
  const session = {
    id: newId('ses'),
    server_seed: seed,
    server_seed_hash: await sha256Hex(seed),
    client_seed: randomHex(8),
    nonce: 0,
  };
  await env.DB.prepare(
    `INSERT INTO game_sessions (id, tenant_id, player_id, game_id, asset_code, status, server_seed, server_seed_hash, client_seed, nonce, created_at)
     VALUES (?, ?, ?, ?, ?, 'open', ?, ?, ?, 0, ?)`,
  )
    .bind(session.id, tenantId, playerId, gameId, assetCode, seed, session.server_seed_hash, session.client_seed, now())
    .run();
  return session;
}

async function nextNonce(env: Env, sessionId: string, current: number): Promise<number | null> {
  const result = await env.DB.prepare(
    'UPDATE game_sessions SET nonce = nonce + 1 WHERE id = ? AND nonce = ?',
  )
    .bind(sessionId, current)
    .run();
  return (result.meta.changes ?? 0) === 1 ? current : null;
}

export async function playDice(
  env: Env,
  auth: AuthContext,
  input: {
    playerId: string;
    stakeMinor: number;
    assetCode: string;
    direction: 'under' | 'over';
    target: number;
  },
) {
  const tenantId = auth.tenantId;
  if (!tenantId) throw new ApiError(403, 'TENANT_REQUIRED', 'Tenant context required');
  if (!auth.permissions.has('game:play')) throw new ApiError(403, 'FORBIDDEN', 'Game play permission required');
  if (!isPlayableDiceTarget(input.direction, input.target)) {
    throw new ApiError(400, 'INVALID_TARGET', 'Target must produce a win chance between 0.01% and 98%');
  }
  if (!Number.isSafeInteger(input.stakeMinor) || input.stakeMinor <= 0) {
    throw new ApiError(400, 'INVALID_STAKE', 'Stake must be a positive integer in minor units');
  }
  if (input.stakeMinor > 5_000_00) throw new ApiError(400, 'STAKE_TOO_LARGE', 'Stake exceeds the table limit');

  const player = await getPlayer(env, tenantId, input.playerId);
  await assertPlayerEligible(env, player);
  const game = await getGame(env, tenantId, 'dice');
  const asset = await getAsset(env, input.assetCode);
  const realMoney = await realMoneyEnabled(env);

  if (asset.monetary) {
    const decision = await evaluateTenantAction(env, {
      tenantId,
      jurisdictionCode: player.jurisdiction_code,
      action: 'wager_real',
      realMoneyEnabled: realMoney,
      gameCategory: game.category,
    });
    if (!decision.allowed) throw new ApiError(403, decision.code, decision.reason, { jurisdiction: decision.jurisdiction });
  }

  if (player.daily_wager_limit) {
    const today = isoDay();
    const wagered = await env.DB.prepare(
      'SELECT COALESCE(SUM(stake_minor),0) AS n FROM rounds WHERE tenant_id = ? AND player_id = ? AND created_at >= ?',
    )
      .bind(tenantId, player.id, today)
      .first<{ n: number }>();
    if ((wagered?.n ?? 0) + input.stakeMinor > player.daily_wager_limit) {
      throw new ApiError(403, 'WAGER_LIMIT_REACHED', 'Daily wager limit would be exceeded');
    }
  }

  const session = await openSession(env, tenantId, player.id, game.id, asset.code);
  let nonce = session.nonce;
  for (let attempt = 0; attempt < 3; attempt++) {
    const claimed = await nextNonce(env, session.id, nonce);
    if (claimed !== null) break;
    nonce += 1;
  }

  const roll = await diceRoll(session.server_seed, session.client_seed, nonce);
  const won = diceOutcome(input.direction, input.target, roll);
  const edgeBps = Math.max(0, 10_000 - game.rtp_bps);
  const multiplierBp = won ? diceMultiplierBp(input.direction, input.target, edgeBps) : 0;
  const payoutMinor = payoutFor(input.stakeMinor, multiplierBp);

  const playerAccount = await ensureAccount(env, {
    tenantId,
    ownerType: 'player',
    ownerId: player.id,
    assetCode: asset.code,
    kind: 'available',
  });
  const revenue = await ensureAccount(env, {
    tenantId,
    ownerType: 'platform',
    ownerId: 'house',
    assetCode: asset.code,
    kind: 'revenue',
    allowNegative: true,
  });

  const entries = [
    { accountId: playerAccount, assetCode: asset.code, amountMinor: -input.stakeMinor },
    { accountId: revenue, assetCode: asset.code, amountMinor: input.stakeMinor },
  ];
  if (payoutMinor > 0) {
    entries.push(
      { accountId: revenue, assetCode: asset.code, amountMinor: -payoutMinor },
      { accountId: playerAccount, assetCode: asset.code, amountMinor: payoutMinor },
    );
  }

  const roundId = newId('rnd');
  const txnId = newId('txn');
  const createdAt = now();
  await post(env, auth, {
    kind: 'game.round',
    txnId,
    idempotencyKey: `round:${roundId}`,
    entries,
    metadata: { roundId, playerId: player.id, game: 'dice', stakeMinor: input.stakeMinor, payoutMinor, roll },
    extra: [
      env.DB.prepare(
        `INSERT INTO rounds (id, tenant_id, session_id, player_id, game_code, stake_minor, payout_minor, multiplier_bp, status, detail_json, txn_id, created_at)
         VALUES (?, ?, ?, ?, 'dice', ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        roundId,
        tenantId,
        session.id,
        player.id,
        input.stakeMinor,
        payoutMinor,
        multiplierBp,
        won ? 'won' : 'lost',
        JSON.stringify({ direction: input.direction, target: input.target, roll }),
        txnId,
        createdAt,
      ),
      audit(env, auth, 'game.round', 'round', roundId, { stake: input.stakeMinor, payout: payoutMinor, asset: asset.code }),
    ],
  });

  return {
    roundId,
    roll,
    target: input.target,
    direction: input.direction,
    won,
    multiplierBp,
    stakeMinor: input.stakeMinor,
    payoutMinor,
    balanceMinor: await balanceOf(env, playerAccount),
    serverSeedHash: session.server_seed_hash,
    clientSeed: session.client_seed,
    nonce,
    fairness: { algorithm: 'HMAC-SHA256(serverSeed, "dice|clientSeed|nonce|0")', reveal: 'POST /api/play/fairness/rotate' },
  };
}

export async function rotateSeed(env: Env, auth: AuthContext, playerId: string, assetCode: string) {
  const tenantId = auth.tenantId;
  if (!tenantId) throw new ApiError(403, 'TENANT_REQUIRED', 'Tenant context required');
  await getPlayer(env, tenantId, playerId);
  const games = await env.DB.prepare('SELECT id FROM games WHERE tenant_id = ? AND code = ?').bind(tenantId, 'dice').first<{ id: string }>();
  if (!games) throw new ApiError(404, 'GAME_NOT_FOUND', 'Game not available');
  const session = await env.DB.prepare(
    `SELECT id, server_seed, server_seed_hash, client_seed, nonce FROM game_sessions
     WHERE tenant_id = ? AND player_id = ? AND game_id = ? AND asset_code = ? AND status = 'open'
     ORDER BY created_at DESC LIMIT 1`,
  )
    .bind(tenantId, playerId, games.id, assetCode)
    .first<{ id: string; server_seed: string; server_seed_hash: string; client_seed: string; nonce: number }>();
  if (!session) throw new ApiError(404, 'SESSION_NOT_FOUND', 'No open session');

  const seed = randomHex(32);
  const hash = await sha256Hex(seed);
  const clientSeed = randomHex(8);
  const createdAt = now();
  await env.DB.batch([
    env.DB.prepare(`UPDATE game_sessions SET status = 'closed', closed_at = ? WHERE id = ?`).bind(createdAt, session.id),
    env.DB.prepare(
      `INSERT INTO seed_history (id, user_id, server_seed, server_seed_hash, client_seed, final_nonce, revealed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).bind(newId('seed'), auth.userId, session.server_seed, session.server_seed_hash, session.client_seed, session.nonce, createdAt),
    env.DB.prepare(
      `INSERT INTO game_sessions (id, tenant_id, player_id, game_id, asset_code, status, server_seed, server_seed_hash, client_seed, nonce, created_at)
       VALUES (?, ?, ?, ?, ?, 'open', ?, ?, ?, 0, ?)`,
    ).bind(newId('ses'), tenantId, playerId, games.id, assetCode, seed, hash, clientSeed, createdAt),
    audit(env, auth, 'seed.rotated', 'player', playerId, { assetCode }),
  ]);
  return {
    revealed: {
      serverSeed: session.server_seed,
      serverSeedHash: session.server_seed_hash,
      clientSeed: session.client_seed,
      finalNonce: session.nonce,
    },
    current: { serverSeedHash: hash, clientSeed },
  };
}

export async function playerGameHistory(env: Env, tenantId: string, playerId: string, limit = 30) {
  const rows = await env.DB.prepare(
    `SELECT id, game_code, stake_minor, payout_minor, multiplier_bp, status, created_at
     FROM rounds WHERE tenant_id = ? AND player_id = ? ORDER BY created_at DESC LIMIT ?`,
  )
    .bind(tenantId, playerId, limit)
    .all<Record<string, unknown>>();
  return rows.results ?? [];
}

export async function walletForPlayer(env: Env, tenantId: string, playerId: string) {
  const player = await getPlayer(env, tenantId, playerId);
  const wallet = await playerWallet(env, tenantId, playerId);
  return { player: { id: player.id, jurisdiction: player.jurisdiction_code, kycStatus: player.kyc_status, status: player.status }, wallet };
}
