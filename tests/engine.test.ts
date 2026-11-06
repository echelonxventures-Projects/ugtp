import { describe, expect, it } from 'vitest';
import {
  DEFAULT_HOUSE_EDGE_BPS,
  diceMultiplierBp,
  diceOutcome,
  diceRoll,
  isPlayableDiceTarget,
  payoutFor,
  randomHex,
  verifyDice,
  winChance,
} from '../src/shared/engine';

const SERVER = 'a'.repeat(64);
const CLIENT = 'client-seed';

describe('provably fair dice', () => {
  it('is deterministic for the same seed, client seed and nonce', async () => {
    const a = await diceRoll(SERVER, CLIENT, 7);
    const b = await diceRoll(SERVER, CLIENT, 7);
    expect(a).toBe(b);
  });

  it('changes with the nonce and the server seed', async () => {
    const base = await diceRoll(SERVER, CLIENT, 1);
    const next = await diceRoll(SERVER, CLIENT, 2);
    const otherSeed = await diceRoll('b'.repeat(64), CLIENT, 1);
    expect(base).not.toBe(next);
    expect(base).not.toBe(otherSeed);
  });

  it('produces an integer roll in [0, 10000)', async () => {
    for (let nonce = 0; nonce < 250; nonce++) {
      const roll = await diceRoll(SERVER, CLIENT, nonce);
      expect(Number.isInteger(roll)).toBe(true);
      expect(roll).toBeGreaterThanOrEqual(0);
      expect(roll).toBeLessThan(10000);
    }
  });

  it('exposes a verifiable seed hash', async () => {
    const result = await verifyDice(SERVER, CLIENT, 3);
    expect(result.roll).toBe(await diceRoll(SERVER, CLIENT, 3));
    expect(result.serverSeedHash).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('dice payout math', () => {
  it('prices a 50% chance at 1.98x with a 1% edge', () => {
    expect(diceMultiplierBp('under', 5000)).toBe(19800);
    expect(payoutFor(1000, 19800)).toBe(1980);
  });

  it('keeps the theoretical return near 99%', () => {
    const cases = [
      { direction: 'under' as const, target: 2500 },
      { direction: 'under' as const, target: 7500 },
      { direction: 'over' as const, target: 9000 },
      { direction: 'over' as const, target: 2000 },
    ];
    for (const item of cases) {
      const rtp = winChance(item.direction, item.target) * (diceMultiplierBp(item.direction, item.target) / 10_000);
      expect(rtp).toBeGreaterThan(0.97);
      expect(rtp).toBeLessThanOrEqual(0.99);
    }
  });

  it('floors payouts so rounding never pays more than the multiplier', () => {
    expect(payoutFor(3, 19800)).toBe(5);
    expect(payoutFor(1, 10001)).toBe(1);
    expect(payoutFor(0, 19800)).toBe(0);
  });

  it('applies under/over comparison consistently with the quoted chance', () => {
    expect(diceOutcome('under', 5000, 4999)).toBe(true);
    expect(diceOutcome('under', 5000, 5000)).toBe(false);
    expect(diceOutcome('over', 5000, 5000)).toBe(true);
    expect(diceOutcome('over', 5000, 4999)).toBe(false);
  });

  it('rejects unplayable targets and keeps the edge parameter bounded', () => {
    expect(isPlayableDiceTarget('under', 0)).toBe(false);
    expect(isPlayableDiceTarget('under', 9900)).toBe(false);
    expect(isPlayableDiceTarget('under', 5000)).toBe(true);
    expect(isPlayableDiceTarget('over', 300)).toBe(true);
    expect(isPlayableDiceTarget('over', 100)).toBe(false);
    const noEdge = diceMultiplierBp('under', 5000, 0);
    expect(noEdge).toBe(20000);
    expect(diceMultiplierBp('under', 5000, DEFAULT_HOUSE_EDGE_BPS)).toBe(19800);
  });

  it('generates distinct 32-byte hex seeds', () => {
    const a = randomHex(32);
    const b = randomHex(32);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(a).not.toBe(b);
  });
});
