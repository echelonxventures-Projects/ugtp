let tenantOverride: string | null = null;

export function setTenantOverride(tenantId: string | null): void {
  tenantOverride = tenantId;
}

export class ApiClientError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

export async function api<T = Record<string, unknown>>(
  path: string,
  options: { method?: string; body?: unknown } = {},
): Promise<T> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (tenantOverride) headers['x-tenant-id'] = tenantOverride;
  const response = await fetch(`/api${path}`, {
    method: options.method ?? 'GET',
    credentials: 'same-origin',
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const payload = (await response.json().catch(() => null)) as
    | { error?: { code?: string; message?: string; details?: unknown } }
    | null;
  if (!response.ok) {
    throw new ApiClientError(
      payload?.error?.message ?? `Request failed (${response.status})`,
      payload?.error?.code ?? 'REQUEST_FAILED',
      payload?.error?.details,
    );
  }
  return payload as T;
}

export interface Session {
  user: {
    id: string;
    displayName: string;
    role: string;
    userType: string;
    permissions: string[];
  };
  tenant: { id: string; name: string; jurisdiction_code: string; status: string } | null;
  org: { legalEntityId: string; operatorId: string; brandId: string } | null;
  playerId: string | null;
  tenants: { id: string; name: string; jurisdiction_code: string }[];
}

export function can(session: Session | null, permission: string): boolean {
  return Boolean(session?.user.permissions.includes(permission));
}

export function money(minor: number | string | null | undefined, currency = 'USD'): string {
  const value = Number(minor ?? 0) / 100;
  return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(value);
}

export function number(value: number | string | null | undefined): string {
  return new Intl.NumberFormat('en-US').format(Number(value ?? 0));
}

export function when(ms: number | string | null | undefined): string {
  if (!ms) return '—';
  return new Date(Number(ms)).toLocaleString();
}

export function bps(value: number | string | null | undefined): string {
  return `${(Number(value ?? 0) / 100).toFixed(2)}%`;
}
