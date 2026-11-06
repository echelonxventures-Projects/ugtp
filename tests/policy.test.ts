import { describe, expect, it } from 'vitest';
import { evaluatePolicy, type JurisdictionPolicy, type LicencePolicy } from '../src/worker/policy';

const now = Date.UTC(2026, 5, 1);
const future = now + 86_400_000;
const past = now - 86_400_000;

const malta: JurisdictionPolicy = {
  code: 'MT',
  name: 'Malta',
  money_gaming: 'permitted_with_licence',
  affiliate_payout: 'permitted_with_licence',
  credit: 'permitted_with_licence',
  authority: 'MGA',
  legal_basis: 'Gaming Act',
};

const india: JurisdictionPolicy = {
  code: 'IN',
  name: 'India',
  money_gaming: 'prohibited',
  affiliate_payout: 'prohibited',
  credit: 'prohibited',
  authority: 'MeitY',
  legal_basis: 'Promotion and Regulation of Online Gaming Act, 2025',
};

const unassessed: JurisdictionPolicy = {
  ...malta,
  code: 'US',
  name: 'United States',
  money_gaming: 'unassessed',
  affiliate_payout: 'unassessed',
  credit: 'unassessed',
};

const licence: LicencePolicy = {
  id: 'lic_1',
  status: 'active',
  valid_from: past,
  valid_to: future,
  activities: ['deposit', 'withdrawal', 'wager', 'credit', 'affiliate_payout', 'settlement'],
  gameCategories: ['casino'],
  verified_at: past,
  jurisdiction_code: 'MT',
  evidence_ref: 'evidence://licence.pdf',
};

function evaluate(overrides: Partial<Parameters<typeof evaluatePolicy>[0]>) {
  return evaluatePolicy({
    action: 'deposit',
    jurisdiction: malta,
    licence,
    realMoneyEnabled: true,
    at: now,
    ...overrides,
  });
}

describe('regulatory authorization', () => {
  it('allows an authorized activity covered by a verified, active licence', () => {
    const decision = evaluate({});
    expect(decision.allowed).toBe(true);
    expect(decision.licenceId).toBe('lic_1');
  });

  it('denies every money action in a prohibited jurisdiction even with a licence on file', () => {
    for (const action of ['deposit', 'withdrawal', 'wager_real', 'redemption_monetary', 'credit_issue', 'affiliate_payout'] as const) {
      const decision = evaluate({ action, jurisdiction: india });
      expect(decision.allowed).toBe(false);
      expect(decision.code).toBe('JURISDICTION_PROHIBITED');
    }
  });

  it('denies an unassessed jurisdiction instead of assuming permission', () => {
    const decision = evaluate({ jurisdiction: unassessed });
    expect(decision.allowed).toBe(false);
    expect(decision.code).toBe('JURISDICTION_UNASSESSED');
  });

  it('denies when no jurisdiction profile applies', () => {
    const decision = evaluate({ jurisdiction: null });
    expect(decision.allowed).toBe(false);
    expect(decision.code).toBe('JURISDICTION_UNKNOWN');
  });

  it('denies when the platform real-money flag is off', () => {
    const decision = evaluate({ realMoneyEnabled: false });
    expect(decision.allowed).toBe(false);
    expect(decision.code).toBe('REAL_MONEY_DISABLED');
  });

  it('denies when there is no licence at all', () => {
    const decision = evaluate({ licence: null });
    expect(decision.allowed).toBe(false);
    expect(decision.code).toBe('LICENCE_MISSING');
  });

  it('denies unverified licence evidence', () => {
    const decision = evaluate({ licence: { ...licence, verified_at: null } });
    expect(decision.allowed).toBe(false);
    expect(decision.code).toBe('LICENCE_UNVERIFIED');
  });

  it('denies suspended, revoked and inactive licences', () => {
    for (const status of ['suspended', 'revoked', 'pending']) {
      const decision = evaluate({ licence: { ...licence, status } });
      expect(decision.allowed).toBe(false);
      expect(['LICENCE_SUSPENDED', 'LICENCE_REVOKED', 'LICENCE_INACTIVE']).toContain(decision.code);
    }
  });

  it('denies expired and not-yet-effective licences', () => {
    expect(evaluate({ licence: { ...licence, valid_to: past } }).code).toBe('LICENCE_EXPIRED');
    expect(evaluate({ licence: { ...licence, valid_from: future } }).code).toBe('LICENCE_NOT_YET_VALID');
  });

  it('denies an activity the licence does not cover', () => {
    const decision = evaluate({ action: 'redemption_monetary' });
    expect(decision.allowed).toBe(false);
    expect(decision.code).toBe('ACTIVITY_NOT_LICENSED');
  });

  it('denies a game category the licence does not cover', () => {
    const decision = evaluate({ gameCategory: 'sports' });
    expect(decision.allowed).toBe(false);
    expect(decision.code).toBe('GAME_CATEGORY_NOT_LICENSED');
  });

  it('denies a licence issued in a different jurisdiction', () => {
    const decision = evaluate({ licence: { ...licence, jurisdiction_code: 'GB' } });
    expect(decision.allowed).toBe(false);
    expect(decision.code).toBe('LICENCE_JURISDICTION_MISMATCH');
  });

  it('does not let a licence cover a prohibited area through another licence field', () => {
    const decision = evaluate({ action: 'affiliate_payout', jurisdiction: india, licence: { ...licence, jurisdiction_code: 'IN' } });
    expect(decision.allowed).toBe(false);
    expect(decision.code).toBe('JURISDICTION_PROHIBITED');
  });
});
