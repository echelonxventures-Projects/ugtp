import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import {
  ApiError,
  ROLE_PERMISSIONS,
  type AppEnv,
  type AuthContext,
  type Env,
  type Role,
  now,
  newId,
  rateLimit,
} from './core';
import type { Context } from 'hono';

const SESSION_COOKIE = 'ugtp_session';
const SESSION_TTL_MS = 1000 * 60 * 60 * 12;
const PBKDF2_ITERATIONS = 210_000;

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

function fromBase64(value: string): Uint8Array {
  const binary = atob(value);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

function bufferOf(bytes: Uint8Array): ArrayBuffer {
  const copy = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(copy).set(bytes);
  return copy;
}

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: bufferOf(salt), iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
    key,
    256,
  );
  return `pbkdf2$${PBKDF2_ITERATIONS}$${toBase64(salt)}$${toBase64(new Uint8Array(bits))}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, iterationsRaw, saltB64, hashB64] = stored.split('$');
  if (scheme !== 'pbkdf2') return false;
  const iterations = Number(iterationsRaw);
  if (!Number.isFinite(iterations) || iterations < 10_000) return false;
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: bufferOf(fromBase64(saltB64)), iterations, hash: 'SHA-256' },
    key,
    256,
  );
  const expected = fromBase64(hashB64);
  const actual = new Uint8Array(bits);
  if (expected.length !== actual.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected[i] ^ actual[i];
  return diff === 0;
}

export async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

export function unauthorized(code = 'UNAUTHENTICATED', message = 'Sign in required'): never {
  throw new ApiError(401, code, message);
}

export async function createSession(
  env: Env,
  c: Context<AppEnv>,
  user: { id: string; tenant_id: string | null },
  userAgent?: string,
): Promise<void> {
  const token = toBase64(crypto.getRandomValues(new Uint8Array(32))).replace(/[+/=]/g, (m) => ({ '+': '-', '/': '_', '=': '' })[m] ?? '');
  const tokenHash = await sha256(token);
  const createdAt = now();
  await env.DB.prepare(
    'INSERT INTO sessions (token_hash, user_id, tenant_id, created_at, expires_at, user_agent) VALUES (?, ?, ?, ?, ?, ?)',
  )
    .bind(tokenHash, user.id, user.tenant_id, createdAt, createdAt + SESSION_TTL_MS, userAgent ?? null)
    .run();
  const secure = new URL(c.req.url).protocol === 'https:';
  setCookie(c, SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'Lax',
    secure,
    path: '/',
    maxAge: SESSION_TTL_MS / 1000,
  });
}

export async function destroySession(env: Env, c: Context<AppEnv>): Promise<void> {
  const token = getCookie(c, SESSION_COOKIE);
  if (token) {
    const tokenHash = await sha256(token);
    await env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(tokenHash).run();
  }
  deleteCookie(c, SESSION_COOKIE, { path: '/' });
}

interface SessionRow {
  user_id: string;
  tenant_id: string | null;
  role: Role;
  display_name: string;
  user_type: 'staff' | 'player';
  status: string;
  expires_at: number;
}

export async function authenticate(c: Context<AppEnv>): Promise<AuthContext | null> {
  const token = getCookie(c, SESSION_COOKIE);
  if (!token) return null;
  const tokenHash = await sha256(token);
  const row = await c.env.DB.prepare(
    `SELECT s.user_id, s.tenant_id, u.role, u.display_name, u.user_type, u.status, s.expires_at
     FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = ?`,
  )
    .bind(tokenHash)
    .first<SessionRow>();
  if (!row) return null;
  if (row.expires_at <= now() || row.status !== 'active') {
    await c.env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(tokenHash).run();
    return null;
  }
  return {
    userId: row.user_id,
    tenantId: row.tenant_id,
    role: row.role,
    permissions: new Set(ROLE_PERMISSIONS[row.role] ?? []),
    displayName: row.display_name,
    userType: row.user_type,
  };
}

export function authOf(c: Context<AppEnv>): AuthContext {
  const auth = c.get('auth');
  if (!auth) unauthorized();
  return auth;
}

export async function loginAttemptKey(c: Context<AppEnv>, email: string): Promise<string> {
  const ip = c.req.header('cf-connecting-ip') ?? c.req.header('x-forwarded-for') ?? 'local';
  return `login:${ip}:${email.toLowerCase()}`;
}

export function guardLogin(c: Context<AppEnv>, email: string): void {
  const ip = c.req.header('cf-connecting-ip') ?? c.req.header('x-forwarded-for') ?? 'local';
  rateLimit(`login:${ip}:${email.toLowerCase()}`, 6, 60_000);
}

export async function createUser(
  env: Env,
  input: {
    tenantId: string | null;
    email: string;
    password: string;
    displayName: string;
    role: Role;
    userType?: 'staff' | 'player';
    countryCode?: string | null;
    kycStatus?: 'unverified' | 'pending' | 'verified' | 'rejected';
  },
): Promise<{ id: string; email: string }> {
  const id = newId('usr');
  const passwordHash = await hashPassword(input.password);
  await env.DB.prepare(
    `INSERT INTO users (id, tenant_id, email, password_hash, display_name, user_type, role, status, kyc_status, country_code, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)`,
  )
    .bind(
      id,
      input.tenantId,
      input.email.toLowerCase(),
      passwordHash,
      input.displayName,
      input.userType ?? 'staff',
      input.role,
      input.kycStatus ?? 'unverified',
      input.countryCode ?? null,
      now(),
    )
    .run();
  return { id, email: input.email.toLowerCase() };
}
