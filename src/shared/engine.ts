/**
 * UGTP game integrity primitives.
 *
 * Outcomes are derived deterministically from a server seed, the player's
 * client seed and a monotonic nonce. The server publishes the hash of the
 * server seed before play and reveals the seed when rotated. There is no
 * player-specific manipulation, loss steering or hidden bias: the payable
 * multiplier is a pure function of the published probability and the
 * configured house edge.
 */

export const DICE_SIDES = 10_000;
export const DEFAULT_HOUSE_EDGE_BPS = 100;
const encoder = new TextEncoder();

export function isValidHex(value: string, bytes: number): boolean {
  return typeof value === 'string' && value.length === bytes * 2 && /^[0-9a-f]+$/i.test(value);
}

export function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

export function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0 || !/^[0-9a-f]*$/i.test(hex)) throw new Error('invalid hex');
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export function randomHex(bytes = 32): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return bytesToHex(buf);
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(copy).set(bytes);
  return copy;
}

export async function sha256Hex(message: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(message));
  return bytesToHex(new Uint8Array(digest));
}

export async function hmacSha256(keyHex: string, message: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    'raw',
    toArrayBuffer(hexToBytes(keyHex)),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(message));
  return new Uint8Array(sig);
}

export function roundMessage(clientSeed: string, nonce: number, game: string, block = 0): string {
  return `${game}|${clientSeed}|${nonce}|${block}`;
}

export async function roundBytes(
  serverSeed: string,
  clientSeed: string,
  nonce: number,
  game: string,
  block = 0,
): Promise<Uint8Array> {
  return hmacSha256(serverSeed, roundMessage(clientSeed, nonce, game, block));
}

class DigestStream {
  private block = 0;
  private words: Uint32Array = new Uint32Array(0);
  private cursor = 0;

  constructor(
    private readonly serverSeed: string,
    private readonly clientSeed: string,
    private readonly nonce: number,
    private readonly game: string,
  ) {}

  private async fill(): Promise<void> {
    const bytes = await roundBytes(this.serverSeed, this.clientSeed, this.nonce, this.game, this.block++);
    const view = new DataView(toArrayBuffer(bytes));
    const words = new Uint32Array(8);
    for (let i = 0; i < 8; i++) words[i] = view.getUint32(i * 4, false);
    this.words = words;
    this.cursor = 0;
  }

  async next(): Promise<number> {
    if (this.cursor >= this.words.length) await this.fill();
    return this.words[this.cursor++];
  }

  async below(maxExclusive: number): Promise<number> {
    if (maxExclusive <= 1) return 0;
    const limit = Math.floor(0x1_0000_0000 / maxExclusive) * maxExclusive;
    for (;;) {
      const value = await this.next();
      if (value < limit) return value % maxExclusive;
    }
  }
}

/** Uniform roll in [0, 10000). */
export async function diceRoll(serverSeed: string, clientSeed: string, nonce: number): Promise<number> {
  const bytes = await roundBytes(serverSeed, clientSeed, nonce, 'dice');
  const view = new DataView(toArrayBuffer(bytes));
  const value = view.getUint32(0, false);
  return Math.floor((value / 0x1_0000_0000) * DICE_SIDES);
}

export async function verifyDice(
  serverSeed: string,
  clientSeed: string,
  nonce: number,
): Promise<{ roll: number; serverSeedHash: string }> {
  return { roll: await diceRoll(serverSeed, clientSeed, nonce), serverSeedHash: await sha256Hex(serverSeed) };
}

export function winChance(direction: 'under' | 'over', target: number): number {
  if (!Number.isInteger(target) || target <= 0 || target >= DICE_SIDES) {
    throw new RangeError('target must be an integer in 1..9999');
  }
  return direction === 'under' ? target / DICE_SIDES : (DICE_SIDES - target) / DICE_SIDES;
}

/** Payout multiplier in basis points (10_000 = 1.00x), floored for the house. */
export function diceMultiplierBp(
  direction: 'under' | 'over',
  target: number,
  edgeBps = DEFAULT_HOUSE_EDGE_BPS,
): number {
  const chance = winChance(direction, target);
  const edge = Math.min(Math.max(edgeBps, 0), 1_000);
  return Math.floor(((10_000 - edge) / 10_000 / chance) * 10_000);
}

export function diceOutcome(
  direction: 'under' | 'over',
  target: number,
  roll: number,
): boolean {
  return direction === 'under' ? roll < target : roll >= target;
}

export function payoutFor(stakeMinor: number, multiplierBp: number): number {
  if (stakeMinor <= 0 || multiplierBp <= 0) return 0;
  return Math.floor((stakeMinor * multiplierBp) / 10_000);
}

/** Multipliers are bounded so a single round cannot pay more than the cap. */
export function isPlayableDiceTarget(direction: 'under' | 'over', target: number): boolean {
  if (!Number.isInteger(target) || target < 1 || target > 9_999) return false;
  const chance = winChance(direction, target);
  return chance >= 0.0001 && chance <= 0.98;
}
