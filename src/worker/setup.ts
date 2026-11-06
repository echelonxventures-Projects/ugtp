import { ApiError, audit, newId, now, type Env } from './core';
import { createUser } from './auth';
import { sha256Hex } from '../shared/engine';

/**
 * First-run sandbox bootstrap. Disabled in production and refused once any user
 * exists, so it cannot be used to create privileged accounts on a live system.
 * It seeds a licensed Malta demo operator and an India tenant whose prohibited
 * profile is expected to block every money-gaming action.
 */

function generatePassword(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(15));
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join('') + '!7a';
}

export async function setupStatus(env: Env) {
  const count = await env.DB.prepare('SELECT COUNT(*) AS n FROM users').first<{ n: number }>();
  return {
    initialized: (count?.n ?? 0) > 0,
    environment: env.ENVIRONMENT ?? 'sandbox',
    allowsBootstrap: (env.ENVIRONMENT ?? 'sandbox') !== 'production' && (count?.n ?? 0) === 0,
  };
}

export async function bootstrap(env: Env) {
  if ((env.ENVIRONMENT ?? 'sandbox') === 'production') {
    throw new ApiError(403, 'BOOTSTRAP_DISABLED', 'Sandbox bootstrap is disabled in production');
  }
  const count = await env.DB.prepare('SELECT COUNT(*) AS n FROM users').first<{ n: number }>();
  if ((count?.n ?? 0) > 0) {
    throw new ApiError(409, 'ALREADY_INITIALIZED', 'This deployment has already been initialized');
  }

  const createdAt = now();
  const adminPassword = generatePassword();
  const admin = await createUser(env, {
    tenantId: null,
    email: 'platform@ugtp.local',
    password: adminPassword,
    displayName: 'Platform Administrator',
    role: 'platform_admin',
  });

  await env.DB.prepare(`INSERT OR REPLACE INTO platform_settings (key, value) VALUES ('real_money_enabled', 'true')`).run();

  const tenantsOut: { id: string; name: string; jurisdiction: string; playerId?: string }[] = [];
  const accountsOut: { email: string; password: string; role: string; tenant: string | null }[] = [
    { email: admin.email, password: adminPassword, role: 'platform_admin', tenant: null },
  ];

  const seeds = [
    { name: 'UGTP Malta Demo', jurisdiction: 'MT', licenceNumber: 'MGA/B2C/DEMO/001', play: true },
    { name: 'Bharat Skill Demo', jurisdiction: 'IN', licenceNumber: 'IN/DEMO/NOT-VALID/001', play: true },
  ];

  for (const seed of seeds) {
    const tenantId = newId('ten');
    const entityId = newId('ent');
    const operatorId = newId('opr');
    const brandId = newId('brd');
    const licenceId = newId('lic');
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO tenants (id, name, kind, status, jurisdiction_code, settings_json, created_at)
         VALUES (?, ?, 'demo', 'active', ?, '{}', ?)`,
      ).bind(tenantId, seed.name, seed.jurisdiction, createdAt),
      env.DB.prepare(
        `INSERT INTO legal_entities (id, tenant_id, name, jurisdiction_code, registration_no, status, created_at)
         VALUES (?, ?, ?, ?, ?, 'active', ?)`,
      ).bind(entityId, tenantId, `${seed.name} Ltd`, seed.jurisdiction, `REG-${seed.jurisdiction}-001`, createdAt),
      env.DB.prepare(
        `INSERT INTO operators (id, tenant_id, legal_entity_id, name, status, created_at)
         VALUES (?, ?, ?, ?, 'active', ?)`,
      ).bind(operatorId, tenantId, entityId, seed.name, createdAt),
      env.DB.prepare(
        `INSERT INTO brands (id, tenant_id, operator_id, name, domain, status, created_at)
         VALUES (?, ?, ?, ?, ?, 'active', ?)`,
      ).bind(brandId, tenantId, operatorId, `${seed.name} Casino`, `${seed.jurisdiction.toLowerCase()}.demo.local`, createdAt),
      env.DB.prepare(
        `INSERT INTO licences (id, tenant_id, legal_entity_id, jurisdiction_code, authority, licence_type, licence_number,
                               status, valid_from, valid_to, activities_json, game_categories_json, conditions_json,
                               evidence_ref, verified_by, verified_at, created_at)
         VALUES (?, ?, ?, ?, ?, 'remote_casino', ?, 'active', ?, ?, ?, ?, '{}', ?, ?, ?, ?)`,
      ).bind(
        licenceId,
        tenantId,
        entityId,
        seed.jurisdiction,
        seed.jurisdiction === 'IN' ? 'Ministry of Electronics and Information Technology' : 'Malta Gaming Authority',
        seed.licenceNumber,
        createdAt - 1000 * 60 * 60 * 24 * 30,
        createdAt + 1000 * 60 * 60 * 24 * 365,
        JSON.stringify(['deposit', 'withdrawal', 'wager', 'redemption', 'credit', 'affiliate_payout', 'settlement']),
        JSON.stringify(['casino']),
        `evidence://sandbox/${seed.jurisdiction}/licence.pdf`,
        'sandbox-bootstrap',
        createdAt,
        createdAt,
      ),
      env.DB.prepare(
        `INSERT INTO games (id, tenant_id, code, name, category, provider, rtp_bps, status, config_json, created_at)
         VALUES (?, ?, 'dice', 'Provably Fair Dice', 'casino', 'ugtp', 9900, 'active', '{}', ?)`,
      ).bind(newId('gam'), tenantId, createdAt),
      audit(env, { userId: admin.id, tenantId: null }, 'tenant.seeded', 'tenant', tenantId, {
        jurisdiction: seed.jurisdiction,
        licenceNumber: seed.licenceNumber,
      }),
    ]);
    tenantsOut.push({ id: tenantId, name: seed.name, jurisdiction: seed.jurisdiction });

    const staff = [
      { role: 'tenant_admin' as const, label: 'Tenant Admin' },
      { role: 'finance' as const, label: 'Finance' },
      { role: 'compliance' as const, label: 'Compliance' },
    ];
    for (const person of staff) {
      const password = generatePassword();
      const email = `${seed.jurisdiction.toLowerCase()}.${person.role}@ugtp.local`;
      await createUser(env, {
        tenantId,
        email,
        password,
        displayName: `${seed.name} ${person.label}`,
        role: person.role,
      });
      accountsOut.push({ email, password, role: person.role, tenant: seed.name });
    }

    if (seed.play) {
      const password = generatePassword();
      const email = `${seed.jurisdiction.toLowerCase()}.player@ugtp.local`;
      const userId = await createUser(env, {
        tenantId,
        email,
        password,
        displayName: `${seed.jurisdiction} Demo Player`,
        role: 'player',
        userType: 'player',
        countryCode: seed.jurisdiction,
        kycStatus: 'verified',
      });
      const playerId = newId('ply');
      await env.DB.prepare(
        `INSERT INTO players (id, tenant_id, user_id, brand_id, jurisdiction_code, date_of_birth, kyc_status, status, created_at)
         VALUES (?, ?, ?, ?, ?, '1990-01-01', 'verified', 'active', ?)`,
      )
        .bind(playerId, tenantId, userId.id, brandId, seed.jurisdiction, createdAt)
        .run();

      const accounts = await env.DB.prepare('SELECT code FROM assets').all<{ code: string }>();
      for (const asset of accounts.results ?? []) {
        const accountId = newId('acct');
        await env.DB.batch([
          env.DB.prepare(
            `INSERT INTO accounts (id, tenant_id, owner_type, owner_id, asset_code, kind, allow_negative, created_at)
             VALUES (?, ?, 'player', ?, ?, 'available', 0, ?)`,
          ).bind(accountId, tenantId, playerId, asset.code, createdAt),
          env.DB.prepare(
            `INSERT INTO account_balances (account_id, balance_minor, allow_negative, updated_at) VALUES (?, 0, 0, ?)`,
          ).bind(accountId, createdAt),
        ]);
      }
      const xcr = await env.DB.prepare(
        `SELECT a.id FROM accounts a WHERE a.tenant_id = ? AND a.owner_type='player' AND a.owner_id = ? AND a.asset_code='XCR'`,
      )
        .bind(tenantId, playerId)
        .first<{ id: string }>();
      const external = newId('acct');
      await env.DB.batch([
        env.DB.prepare(
          `INSERT INTO accounts (id, tenant_id, owner_type, owner_id, asset_code, kind, allow_negative, created_at)
           VALUES (?, ?, 'external', 'play-issuance', 'XCR', 'clearing', 1, ?)`,
        ).bind(external, tenantId, createdAt),
        env.DB.prepare(
          `INSERT INTO account_balances (account_id, balance_minor, allow_negative, updated_at) VALUES (?, 0, 1, ?)`,
        ).bind(external, createdAt),
        env.DB.prepare(
          `INSERT INTO transactions (id, tenant_id, kind, status, idempotency_key, actor_id, metadata_json, created_at)
           VALUES (?, ?, 'play_credit.issuance', 'posted', ?, ?, '{}', ?)`,
        ).bind(newId('txn'), tenantId, `play-issuance:${playerId}`, admin.id, createdAt),
      ]);
      const txn = await env.DB.prepare(`SELECT id FROM transactions WHERE tenant_id = ? AND idempotency_key = ?`)
        .bind(tenantId, `play-issuance:${playerId}`)
        .first<{ id: string }>();
      const grant = 100_000;
      if (txn && xcr) {
        await env.DB.batch([
          env.DB.prepare(
            `INSERT INTO postings (id, txn_id, tenant_id, account_id, asset_code, amount_minor, created_at)
             VALUES (?, ?, ?, ?, 'XCR', ?, ?)`,
          ).bind(newId('pst'), txn.id, tenantId, external, -grant, createdAt),
          env.DB.prepare(
            `INSERT INTO postings (id, txn_id, tenant_id, account_id, asset_code, amount_minor, created_at)
             VALUES (?, ?, ?, ?, 'XCR', ?, ?)`,
          ).bind(newId('pst'), txn.id, tenantId, xcr.id, grant, createdAt),
          env.DB.prepare(`UPDATE account_balances SET balance_minor = balance_minor - ? WHERE account_id = ?`).bind(grant, external),
          env.DB.prepare(`UPDATE account_balances SET balance_minor = balance_minor + ? WHERE account_id = ?`).bind(grant, xcr.id),
        ]);
      }
      await env.DB.prepare(
        `INSERT INTO affiliates (id, tenant_id, code, name, status, payout_method, tax_withholding_bps, created_at)
         VALUES (?, ?, ?, ?, 'active', 'bank_transfer', 1500, ?)`,
      )
        .bind(newId('aff'), tenantId, 'PARTNER1', 'Demo Partner', createdAt)
        .run();
      accountsOut.push({ email, password, role: 'player', tenant: seed.name });
      tenantsOut[tenantsOut.length - 1].playerId = playerId;
    }
  }

  return {
    ok: true,
    tenants: tenantsOut,
    accounts: accountsOut,
    note: 'Sandbox only. No real funds move; the sandbox payment adapter is the only enabled rail.',
    fairness: {
      serverSeedHashes: await sha256Hex('sandbox-bootstrap'),
    },
  };
}
