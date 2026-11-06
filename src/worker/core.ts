import type { Context } from 'hono';

export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  ENVIRONMENT?: string;
  CURRENCY?: string;
  PSP_WEBHOOK_SECRET?: string;
}

export type Role = 'platform_admin' | 'tenant_admin' | 'compliance' | 'finance' | 'support' | 'agent' | 'player';

export interface AuthContext {
  userId: string;
  tenantId: string | null;
  role: Role;
  permissions: Set<Permission>;
  displayName: string;
  userType: 'staff' | 'player';
}

export type AppEnv = { Bindings: Env; Variables: { auth: AuthContext } };
export type Ctx = Context<AppEnv>;

const ALL_PERMISSIONS = [
  'tenant:read',
  'tenant:write',
  'player:read',
  'player:write',
  'agent:read',
  'agent:write',
  'credit:read',
  'credit:write',
  'credit:approve',
  'payment:read',
  'payment:write',
  'payment:approve',
  'settlement:read',
  'settlement:write',
  'settlement:verify',
  'settlement:approve',
  'redemption:read',
  'redemption:write',
  'redemption:approve',
  'affiliate:read',
  'affiliate:write',
  'affiliate:approve',
  'compliance:read',
  'compliance:write',
  'audit:read',
  'game:read',
  'game:play',
  'wallet:read',
  'settings:write',
] as const;

export type Permission = (typeof ALL_PERMISSIONS)[number];

export const ROLE_PERMISSIONS: Record<Role, Permission[]> = {
  platform_admin: [...ALL_PERMISSIONS],
  tenant_admin: [
    'tenant:read',
    'player:read',
    'player:write',
    'agent:read',
    'agent:write',
    'credit:read',
    'credit:write',
    'credit:approve',
    'payment:read',
    'payment:write',
    'payment:approve',
    'settlement:read',
    'settlement:write',
    'settlement:verify',
    'settlement:approve',
    'redemption:read',
    'redemption:write',
    'redemption:approve',
    'affiliate:read',
    'affiliate:write',
    'affiliate:approve',
    'compliance:read',
    'compliance:write',
    'audit:read',
    'game:read',
    'game:play',
    'wallet:read',
  ],
  compliance: ['tenant:read', 'player:read', 'compliance:read', 'compliance:write', 'audit:read', 'settlement:read', 'settlement:verify', 'payment:read', 'redemption:read'],
  finance: [
    'tenant:read',
    'player:read',
    'payment:read',
    'payment:write',
    'payment:approve',
    'settlement:read',
    'settlement:write',
    'settlement:approve',
    'redemption:read',
    'redemption:approve',
    'affiliate:read',
    'affiliate:approve',
    'credit:read',
    'credit:approve',
    'audit:read',
    'wallet:read',
  ],
  support: ['tenant:read', 'player:read', 'player:write', 'payment:read', 'game:read', 'wallet:read'],
  agent: ['agent:read', 'player:read', 'wallet:read'],
  player: ['game:read', 'game:play', 'wallet:read'],
};

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export function badRequest(code: string, message: string, details?: unknown): never {
  throw new ApiError(400, code, message, details);
}

export function forbidden(code: string, message: string, details?: unknown): never {
  throw new ApiError(403, code, message, details);
}

export function notFound(code: string, message: string): never {
  throw new ApiError(404, code, message);
}

export function conflict(code: string, message: string): never {
  throw new ApiError(409, code, message);
}

export function newId(prefix = 'id'): string {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, '')}`;
}

export function now(): number {
  return Date.now();
}

export function isoDay(ms = Date.now()): number {
  const d = new Date(ms);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

export function audit(
  env: Env,
  auth: Pick<AuthContext, 'userId' | 'tenantId'> | null,
  action: string,
  subjectType: string | null,
  subjectId: string | null,
  meta: Record<string, unknown> = {},
): D1PreparedStatement {
  return env.DB.prepare(
    `INSERT INTO audit_log (id, tenant_id, actor_id, action, subject_type, subject_id, meta_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    newId('aud'),
    auth?.tenantId ?? null,
    auth?.userId ?? null,
    action,
    subjectType,
    subjectId,
    JSON.stringify(meta),
    now(),
  );
}

export async function readBody<T>(c: Ctx): Promise<T> {
  try {
    return (await c.req.json()) as T;
  } catch {
    badRequest('INVALID_JSON', 'Request body must be valid JSON');
  }
}

export function str(value: unknown, field: string, opts: { min?: number; max?: number; pattern?: RegExp } = {}): string {
  if (typeof value !== 'string') badRequest('INVALID_INPUT', `${field} must be a string`);
  const trimmed = value.trim();
  if (opts.min !== undefined && trimmed.length < opts.min) {
    badRequest('INVALID_INPUT', `${field} must be at least ${opts.min} characters`);
  }
  if (opts.max !== undefined && trimmed.length > opts.max) {
    badRequest('INVALID_INPUT', `${field} must be at most ${opts.max} characters`);
  }
  if (opts.pattern && !opts.pattern.test(trimmed)) badRequest('INVALID_INPUT', `${field} is invalid`);
  return trimmed;
}

export function money(value: unknown, field: string, opts: { min?: number; max?: number } = {}): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    badRequest('INVALID_AMOUNT', `${field} must be an integer amount in minor units`);
  }
  if (value < (opts.min ?? 1)) badRequest('INVALID_AMOUNT', `${field} must be at least ${opts.min ?? 1}`);
  if (opts.max !== undefined && value > opts.max) badRequest('INVALID_AMOUNT', `${field} exceeds the maximum`);
  return value;
}

export function oneOf<T extends string>(value: unknown, allowed: readonly T[], field: string): T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    badRequest('INVALID_INPUT', `${field} must be one of: ${allowed.join(', ')}`);
  }
  return value as T;
}

export function jsonArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.some((v) => typeof v !== 'string')) {
    badRequest('INVALID_INPUT', `${field} must be an array of strings`);
  }
  return value as string[];
}

export function requireTenant(auth: AuthContext): string {
  if (!auth.tenantId) forbidden('TENANT_REQUIRED', 'This operation requires a tenant-scoped session');
  return auth.tenantId;
}

export function can(auth: AuthContext, permission: Permission): boolean {
  return auth.permissions.has(permission);
}

export function requirePermission(auth: AuthContext, permission: Permission): void {
  if (!can(auth, permission)) forbidden('FORBIDDEN', `Missing required permission: ${permission}`);
}

const rateBuckets = new Map<string, { count: number; resetAt: number }>();

export function rateLimit(key: string, limit: number, windowMs: number): void {
  const current = Date.now();
  const bucket = rateBuckets.get(key);
  if (!bucket || bucket.resetAt <= current) {
    rateBuckets.set(key, { count: 1, resetAt: current + windowMs });
    return;
  }
  bucket.count += 1;
  if (bucket.count > limit) {
    throw new ApiError(429, 'RATE_LIMITED', 'Too many attempts. Try again shortly.');
  }
}

export async function setting(env: Env, key: string, fallback: string): Promise<string> {
  const row = await env.DB.prepare('SELECT value FROM platform_settings WHERE key = ?').bind(key).first<{ value: string }>();
  return row?.value ?? fallback;
}

export async function settingNumber(env: Env, key: string, fallback: number): Promise<number> {
  const raw = await setting(env, key, String(fallback));
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export async function realMoneyEnabled(env: Env): Promise<boolean> {
  return (await setting(env, 'real_money_enabled', 'false')) === 'true';
}
