-- UGTP Ω∞ canonical schema (v0.1.0)
-- Single source of truth for persisted domain state. Every tenant-owned row
-- carries tenant_id; isolation is enforced in the data layer and by tests.
-- Money is stored in integer minor units. Financial history is append-only:
-- corrections are posted as new reversal transactions, never as edits.

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS jurisdictions (
  code              TEXT PRIMARY KEY,
  name              TEXT NOT NULL,
  money_gaming      TEXT NOT NULL CHECK (money_gaming IN ('permitted_with_licence','prohibited','unassessed')),
  affiliate_payout  TEXT NOT NULL CHECK (affiliate_payout IN ('permitted_with_licence','prohibited','unassessed')),
  credit            TEXT NOT NULL CHECK (credit IN ('permitted_with_licence','prohibited','unassessed')),
  authority         TEXT,
  legal_basis       TEXT,
  reviewed_at       INTEGER,
  notes             TEXT
);

CREATE TABLE IF NOT EXISTS tenants (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  kind          TEXT NOT NULL DEFAULT 'operator' CHECK (kind IN ('operator','demo','internal')),
  status        TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended','closed')),
  jurisdiction_code TEXT NOT NULL REFERENCES jurisdictions(code),
  settings_json TEXT NOT NULL DEFAULT '{}',
  created_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS legal_entities (
  id              TEXT PRIMARY KEY,
  tenant_id       TEXT NOT NULL REFERENCES tenants(id),
  name            TEXT NOT NULL,
  jurisdiction_code TEXT NOT NULL REFERENCES jurisdictions(code),
  registration_no TEXT,
  status          TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended','closed')),
  created_at      INTEGER NOT NULL,
  UNIQUE (tenant_id, name)
);

CREATE TABLE IF NOT EXISTS operators (
  id              TEXT PRIMARY KEY,
  tenant_id       TEXT NOT NULL REFERENCES tenants(id),
  legal_entity_id TEXT NOT NULL REFERENCES legal_entities(id),
  name            TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended','closed')),
  created_at      INTEGER NOT NULL,
  UNIQUE (tenant_id, name)
);

CREATE TABLE IF NOT EXISTS brands (
  id          TEXT PRIMARY KEY,
  tenant_id   TEXT NOT NULL REFERENCES tenants(id),
  operator_id TEXT NOT NULL REFERENCES operators(id),
  name        TEXT NOT NULL,
  domain      TEXT,
  status      TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended','closed')),
  created_at  INTEGER NOT NULL,
  UNIQUE (tenant_id, name)
);

CREATE TABLE IF NOT EXISTS licences (
  id                TEXT PRIMARY KEY,
  tenant_id         TEXT NOT NULL REFERENCES tenants(id),
  legal_entity_id   TEXT NOT NULL REFERENCES legal_entities(id),
  jurisdiction_code TEXT NOT NULL REFERENCES jurisdictions(code),
  authority         TEXT NOT NULL,
  licence_type      TEXT NOT NULL,
  licence_number    TEXT NOT NULL,
  status            TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','active','suspended','expired','revoked')),
  valid_from        INTEGER NOT NULL,
  valid_to          INTEGER NOT NULL,
  activities_json   TEXT NOT NULL DEFAULT '[]',
  game_categories_json TEXT NOT NULL DEFAULT '[]',
  conditions_json   TEXT NOT NULL DEFAULT '{}',
  evidence_ref      TEXT,
  verified_by       TEXT,
  verified_at       INTEGER,
  created_at        INTEGER NOT NULL,
  UNIQUE (tenant_id, licence_number)
);
CREATE INDEX IF NOT EXISTS licences_tenant ON licences(tenant_id, jurisdiction_code, status);

CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  tenant_id     TEXT REFERENCES tenants(id),
  email         TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  display_name  TEXT NOT NULL,
  user_type     TEXT NOT NULL DEFAULT 'staff' CHECK (user_type IN ('staff','player')),
  role          TEXT NOT NULL CHECK (role IN ('platform_admin','tenant_admin','compliance','finance','support','agent','player')),
  status        TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended','closed')),
  kyc_status    TEXT NOT NULL DEFAULT 'unverified' CHECK (kyc_status IN ('unverified','pending','verified','rejected')),
  country_code  TEXT,
  created_at    INTEGER NOT NULL,
  last_login_at INTEGER
);
CREATE INDEX IF NOT EXISTS users_tenant ON users(tenant_id, role);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  tenant_id  TEXT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  user_agent TEXT
);
CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id);

CREATE TABLE IF NOT EXISTS players (
  id                  TEXT PRIMARY KEY,
  tenant_id           TEXT NOT NULL REFERENCES tenants(id),
  user_id             TEXT NOT NULL UNIQUE REFERENCES users(id),
  brand_id            TEXT NOT NULL REFERENCES brands(id),
  agent_id            TEXT,
  jurisdiction_code   TEXT NOT NULL REFERENCES jurisdictions(code),
  date_of_birth       TEXT,
  kyc_status          TEXT NOT NULL DEFAULT 'unverified' CHECK (kyc_status IN ('unverified','pending','verified','rejected')),
  status              TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended','self_excluded','closed')),
  self_exclusion_until INTEGER,
  daily_deposit_limit INTEGER,
  daily_wager_limit   INTEGER,
  created_at          INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS players_tenant ON players(tenant_id, status);

CREATE TABLE IF NOT EXISTS agents (
  id                TEXT PRIMARY KEY,
  tenant_id         TEXT NOT NULL REFERENCES tenants(id),
  parent_id         TEXT REFERENCES agents(id),
  code              TEXT NOT NULL,
  name              TEXT NOT NULL,
  agent_type        TEXT NOT NULL CHECK (agent_type IN ('master','regional','sub','distributor','franchise')),
  status            TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended','terminated')),
  territory         TEXT,
  permissions_json  TEXT NOT NULL DEFAULT '[]',
  credit_limit_minor INTEGER NOT NULL DEFAULT 0 CHECK (credit_limit_minor >= 0),
  created_at        INTEGER NOT NULL,
  UNIQUE (tenant_id, code)
);
CREATE INDEX IF NOT EXISTS agents_parent ON agents(tenant_id, parent_id);

CREATE TABLE IF NOT EXISTS games (
  id          TEXT PRIMARY KEY,
  tenant_id   TEXT NOT NULL REFERENCES tenants(id),
  code        TEXT NOT NULL,
  name        TEXT NOT NULL,
  category    TEXT NOT NULL,
  provider    TEXT NOT NULL DEFAULT 'ugtp',
  rtp_bps     INTEGER NOT NULL DEFAULT 9900,
  status      TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled','pending_certification')),
  config_json TEXT NOT NULL DEFAULT '{}',
  created_at  INTEGER NOT NULL,
  UNIQUE (tenant_id, code)
);

CREATE TABLE IF NOT EXISTS game_sessions (
  id               TEXT PRIMARY KEY,
  tenant_id        TEXT NOT NULL REFERENCES tenants(id),
  player_id        TEXT NOT NULL REFERENCES players(id),
  game_id          TEXT NOT NULL REFERENCES games(id),
  asset_code       TEXT NOT NULL,
  status           TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed')),
  server_seed      TEXT NOT NULL,
  server_seed_hash TEXT NOT NULL,
  client_seed      TEXT NOT NULL,
  nonce            INTEGER NOT NULL DEFAULT 0,
  created_at       INTEGER NOT NULL,
  closed_at        INTEGER
);

CREATE TABLE IF NOT EXISTS rounds (
  id          TEXT PRIMARY KEY,
  tenant_id   TEXT NOT NULL REFERENCES tenants(id),
  session_id  TEXT NOT NULL REFERENCES game_sessions(id),
  player_id   TEXT NOT NULL REFERENCES players(id),
  game_code   TEXT NOT NULL,
  stake_minor INTEGER NOT NULL CHECK (stake_minor > 0),
  payout_minor INTEGER NOT NULL DEFAULT 0 CHECK (payout_minor >= 0),
  multiplier_bp INTEGER NOT NULL DEFAULT 0,
  status      TEXT NOT NULL CHECK (status IN ('won','lost')),
  detail_json TEXT NOT NULL DEFAULT '{}',
  txn_id      TEXT,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS rounds_player ON rounds(tenant_id, player_id, created_at DESC);

CREATE TABLE IF NOT EXISTS assets (
  code                 TEXT PRIMARY KEY,
  name                 TEXT NOT NULL,
  classification       TEXT NOT NULL CHECK (classification IN ('non_monetary','promotional','monetary')),
  monetary             INTEGER NOT NULL CHECK (monetary IN (0,1)),
  redeemable           INTEGER NOT NULL DEFAULT 0 CHECK (redeemable IN (0,1)),
  conversion_rate_minor INTEGER NOT NULL DEFAULT 0,
  created_at           INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS accounts (
  id             TEXT PRIMARY KEY,
  tenant_id      TEXT NOT NULL REFERENCES tenants(id),
  owner_type     TEXT NOT NULL CHECK (owner_type IN ('player','agent','platform','external')),
  owner_id       TEXT NOT NULL,
  asset_code     TEXT NOT NULL REFERENCES assets(code),
  kind           TEXT NOT NULL,
  allow_negative INTEGER NOT NULL DEFAULT 0 CHECK (allow_negative IN (0,1)),
  created_at     INTEGER NOT NULL,
  UNIQUE (tenant_id, owner_type, owner_id, asset_code, kind)
);

CREATE TABLE IF NOT EXISTS account_balances (
  account_id      TEXT PRIMARY KEY REFERENCES accounts(id),
  balance_minor   INTEGER NOT NULL DEFAULT 0,
  allow_negative  INTEGER NOT NULL DEFAULT 0 CHECK (allow_negative IN (0,1)),
  updated_at      INTEGER NOT NULL,
  CHECK (balance_minor >= 0 OR allow_negative = 1)
);

CREATE TABLE IF NOT EXISTS transactions (
  id              TEXT PRIMARY KEY,
  tenant_id       TEXT NOT NULL REFERENCES tenants(id),
  kind            TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'posted' CHECK (status IN ('posted','reversed')),
  idempotency_key TEXT NOT NULL,
  reverses_txn_id TEXT,
  actor_id        TEXT,
  metadata_json   TEXT NOT NULL DEFAULT '{}',
  created_at      INTEGER NOT NULL,
  UNIQUE (tenant_id, idempotency_key)
);
CREATE INDEX IF NOT EXISTS transactions_tenant ON transactions(tenant_id, created_at DESC);

CREATE TABLE IF NOT EXISTS postings (
  id           TEXT PRIMARY KEY,
  txn_id       TEXT NOT NULL REFERENCES transactions(id),
  tenant_id    TEXT NOT NULL REFERENCES tenants(id),
  account_id   TEXT NOT NULL REFERENCES accounts(id),
  asset_code   TEXT NOT NULL,
  amount_minor INTEGER NOT NULL,
  created_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS postings_txn ON postings(txn_id);
CREATE INDEX IF NOT EXISTS postings_account ON postings(account_id);

CREATE TABLE IF NOT EXISTS payments (
  id              TEXT PRIMARY KEY,
  tenant_id       TEXT NOT NULL REFERENCES tenants(id),
  player_id       TEXT NOT NULL REFERENCES players(id),
  direction       TEXT NOT NULL CHECK (direction IN ('deposit','withdrawal')),
  amount_minor    INTEGER NOT NULL CHECK (amount_minor > 0),
  currency        TEXT NOT NULL,
  method          TEXT NOT NULL,
  provider        TEXT NOT NULL,
  provider_ref    TEXT,
  status          TEXT NOT NULL CHECK (status IN ('initiated','pending_approval','authorized','captured','paid','rejected','failed','reversed','disputed')),
  jurisdiction_code TEXT NOT NULL,
  licence_id      TEXT,
  idempotency_key TEXT NOT NULL,
  requested_by    TEXT,
  txn_id          TEXT,
  failure_reason  TEXT,
  metadata_json   TEXT NOT NULL DEFAULT '{}',
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL,
  UNIQUE (tenant_id, idempotency_key)
);
CREATE INDEX IF NOT EXISTS payments_status ON payments(tenant_id, status, created_at DESC);

CREATE TABLE IF NOT EXISTS payment_events (
  id               TEXT PRIMARY KEY,
  tenant_id        TEXT NOT NULL REFERENCES tenants(id),
  payment_id       TEXT REFERENCES payments(id),
  provider         TEXT NOT NULL,
  provider_event_id TEXT NOT NULL,
  event_type       TEXT NOT NULL,
  signature_valid  INTEGER NOT NULL CHECK (signature_valid IN (0,1)),
  payload_json     TEXT NOT NULL,
  created_at       INTEGER NOT NULL,
  UNIQUE (tenant_id, provider, provider_event_id)
);

CREATE TABLE IF NOT EXISTS settlements (
  id            TEXT PRIMARY KEY,
  tenant_id     TEXT NOT NULL REFERENCES tenants(id),
  kind          TEXT NOT NULL CHECK (kind IN ('game_cash','agent','operator','partner','off_platform')),
  source        TEXT NOT NULL CHECK (source IN ('platform','external')),
  counterparty  TEXT NOT NULL,
  amount_minor  INTEGER NOT NULL CHECK (amount_minor > 0),
  currency      TEXT NOT NULL,
  status        TEXT NOT NULL CHECK (status IN ('draft','claimed','pending_verification','verified','confirmed','reconciled','disputed','reversed')),
  evidence_ref  TEXT,
  claimed_by    TEXT,
  verified_by   TEXT,
  confirmed_at  INTEGER,
  reconciled_at INTEGER,
  reversal_of   TEXT,
  reason        TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS settlements_status ON settlements(tenant_id, status, created_at DESC);

CREATE TABLE IF NOT EXISTS redemptions (
  id                   TEXT PRIMARY KEY,
  tenant_id            TEXT NOT NULL REFERENCES tenants(id),
  player_id            TEXT NOT NULL REFERENCES players(id),
  asset_code           TEXT NOT NULL REFERENCES assets(code),
  units                INTEGER NOT NULL CHECK (units > 0),
  conversion_rate_minor INTEGER NOT NULL,
  amount_minor         INTEGER NOT NULL CHECK (amount_minor > 0),
  status               TEXT NOT NULL CHECK (status IN ('requested','pending_approval','approved','paid','rejected','reversed')),
  jurisdiction_code    TEXT NOT NULL,
  licence_id           TEXT,
  evidence_ref         TEXT,
  requested_by         TEXT,
  approved_by          TEXT,
  created_at           INTEGER NOT NULL,
  updated_at           INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS redemptions_status ON redemptions(tenant_id, status, created_at DESC);

CREATE TABLE IF NOT EXISTS affiliates (
  id                    TEXT PRIMARY KEY,
  tenant_id             TEXT NOT NULL REFERENCES tenants(id),
  code                  TEXT NOT NULL,
  name                  TEXT NOT NULL,
  status                TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','active','suspended','terminated')),
  payout_method         TEXT,
  tax_withholding_bps   INTEGER NOT NULL DEFAULT 0,
  created_at            INTEGER NOT NULL,
  UNIQUE (tenant_id, code)
);

CREATE TABLE IF NOT EXISTS affiliate_contracts (
  id              TEXT PRIMARY KEY,
  tenant_id       TEXT NOT NULL REFERENCES tenants(id),
  affiliate_id    TEXT NOT NULL REFERENCES affiliates(id),
  version         INTEGER NOT NULL,
  model           TEXT NOT NULL CHECK (model IN ('revenue_share','cpa','cpl','hybrid','tiered')),
  revshare_bps    INTEGER NOT NULL DEFAULT 0,
  cpa_minor       INTEGER NOT NULL DEFAULT 0,
  cpl_minor       INTEGER NOT NULL DEFAULT 0,
  min_payout_minor INTEGER NOT NULL DEFAULT 0,
  tiers_json      TEXT NOT NULL DEFAULT '[]',
  valid_from      INTEGER NOT NULL,
  status          TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('draft','active','superseded')),
  created_at      INTEGER NOT NULL,
  UNIQUE (tenant_id, affiliate_id, version)
);

CREATE TABLE IF NOT EXISTS attributions (
  id            TEXT PRIMARY KEY,
  tenant_id     TEXT NOT NULL REFERENCES tenants(id),
  affiliate_id  TEXT NOT NULL REFERENCES affiliates(id),
  contract_id   TEXT NOT NULL REFERENCES affiliate_contracts(id),
  player_id     TEXT NOT NULL REFERENCES players(id),
  campaign      TEXT,
  attributed_at INTEGER NOT NULL,
  window_days   INTEGER NOT NULL DEFAULT 30,
  UNIQUE (tenant_id, player_id)
);

CREATE TABLE IF NOT EXISTS commissions (
  id             TEXT PRIMARY KEY,
  tenant_id      TEXT NOT NULL REFERENCES tenants(id),
  affiliate_id   TEXT NOT NULL REFERENCES affiliates(id),
  contract_id    TEXT NOT NULL REFERENCES affiliate_contracts(id),
  contract_version INTEGER NOT NULL,
  period_start   INTEGER NOT NULL,
  period_end     INTEGER NOT NULL,
  status         TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','approved','paid','reversed')),
  amount_minor   INTEGER NOT NULL,
  currency       TEXT NOT NULL,
  source_json    TEXT NOT NULL DEFAULT '[]',
  requested_by   TEXT,
  computed_at    INTEGER NOT NULL,
  UNIQUE (tenant_id, affiliate_id, period_start, period_end, contract_id)
);

CREATE TABLE IF NOT EXISTS commission_lines (
  id             TEXT PRIMARY KEY,
  commission_id  TEXT NOT NULL REFERENCES commissions(id),
  source_ref     TEXT NOT NULL,
  base_minor     INTEGER NOT NULL,
  rate_bps       INTEGER NOT NULL,
  amount_minor   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS commission_lines_commission ON commission_lines(commission_id);

CREATE TABLE IF NOT EXISTS payouts (
  id             TEXT PRIMARY KEY,
  tenant_id      TEXT NOT NULL REFERENCES tenants(id),
  affiliate_id   TEXT NOT NULL REFERENCES affiliates(id),
  commission_id  TEXT NOT NULL REFERENCES commissions(id),
  amount_minor   INTEGER NOT NULL CHECK (amount_minor > 0),
  withheld_minor INTEGER NOT NULL DEFAULT 0,
  net_minor      INTEGER NOT NULL,
  status         TEXT NOT NULL CHECK (status IN ('requested','pending_approval','approved','paid','failed','reversed','rejected')),
  provider_ref   TEXT,
  requested_by   TEXT NOT NULL,
  approved_by    TEXT,
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS payouts_status ON payouts(tenant_id, status, created_at DESC);

CREATE TABLE IF NOT EXISTS credit_facilities (
  id              TEXT PRIMARY KEY,
  tenant_id       TEXT NOT NULL REFERENCES tenants(id),
  subject_type    TEXT NOT NULL CHECK (subject_type IN ('player','agent')),
  subject_id      TEXT NOT NULL,
  currency        TEXT NOT NULL,
  limit_minor     INTEGER NOT NULL CHECK (limit_minor > 0),
  status          TEXT NOT NULL DEFAULT 'pending_approval' CHECK (status IN ('pending_approval','active','suspended','closed')),
  policy_ref      TEXT NOT NULL,
  requested_by    TEXT,
  approved_by     TEXT,
  created_at      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS credit_facilities_subject ON credit_facilities(tenant_id, subject_id);

CREATE TABLE IF NOT EXISTS credit_events (
  id              TEXT PRIMARY KEY,
  tenant_id       TEXT NOT NULL REFERENCES tenants(id),
  facility_id     TEXT NOT NULL REFERENCES credit_facilities(id),
  kind            TEXT NOT NULL CHECK (kind IN ('draw','repay','adjust','reverse','expire','write_off')),
  amount_minor    INTEGER NOT NULL CHECK (amount_minor > 0),
  status          TEXT NOT NULL CHECK (status IN ('posted','reversed')),
  txn_id          TEXT,
  idempotency_key TEXT NOT NULL,
  reason          TEXT,
  created_at      INTEGER NOT NULL,
  UNIQUE (tenant_id, idempotency_key)
);
CREATE INDEX IF NOT EXISTS credit_events_facility ON credit_events(facility_id, created_at);

CREATE TABLE IF NOT EXISTS approval_requests (
  id                  TEXT PRIMARY KEY,
  tenant_id           TEXT NOT NULL REFERENCES tenants(id),
  action              TEXT NOT NULL,
  subject_type        TEXT NOT NULL,
  subject_id          TEXT NOT NULL,
  amount_minor        INTEGER,
  required_permission TEXT NOT NULL,
  status              TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
  requested_by        TEXT NOT NULL,
  decided_by          TEXT,
  decisions_json      TEXT NOT NULL DEFAULT '[]',
  created_at          INTEGER NOT NULL,
  decided_at          INTEGER
);
CREATE INDEX IF NOT EXISTS approvals_pending ON approval_requests(tenant_id, status, created_at);

CREATE TABLE IF NOT EXISTS audit_log (
  id           TEXT PRIMARY KEY,
  tenant_id    TEXT,
  actor_id     TEXT,
  action       TEXT NOT NULL,
  subject_type TEXT,
  subject_id   TEXT,
  meta_json    TEXT NOT NULL DEFAULT '{}',
  created_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS audit_tenant ON audit_log(tenant_id, created_at DESC);

CREATE TABLE IF NOT EXISTS platform_settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

INSERT OR IGNORE INTO platform_settings (key, value) VALUES
  ('real_money_enabled', 'false'),
  ('credit_draw_approval_threshold_minor', '50000'),
  ('withdrawal_approval_threshold_minor', '0'),
  ('min_withdrawal_minor', '1000');

INSERT OR IGNORE INTO assets (code, name, classification, monetary, redeemable, conversion_rate_minor, created_at) VALUES
  ('XCR', 'UGTP Play Credits', 'non_monetary', 0, 0, 0, 0),
  ('USD', 'US Dollar', 'monetary', 1, 1, 0, 0);

INSERT OR IGNORE INTO jurisdictions (code, name, money_gaming, affiliate_payout, credit, authority, legal_basis, reviewed_at, notes) VALUES
  ('MT', 'Malta', 'permitted_with_licence', 'permitted_with_licence', 'permitted_with_licence', 'Malta Gaming Authority', 'Gaming Act (Cap. 583)', 0, 'Demo profile: requires an active verified licence.'),
  ('IN', 'India', 'prohibited', 'prohibited', 'prohibited', 'Ministry of Electronics and Information Technology', 'Promotion and Regulation of Online Gaming Act, 2025 (in force 1 May 2026)', 0, 'Online money gaming and related promotion, facilitation and financial transactions are prohibited. Play-money games without cash-out remain distinguishable.'),
  ('GB', 'Great Britain', 'permitted_with_licence', 'permitted_with_licence', 'permitted_with_licence', 'Gambling Commission', 'Gambling Act 2005', 0, 'Demo profile: requires an active verified licence.'),
  ('US', 'United States', 'unassessed', 'unassessed', 'unassessed', NULL, NULL, 0, 'State-by-state analysis required. Fail-closed until assessed.');
