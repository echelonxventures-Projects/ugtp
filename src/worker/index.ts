import { Hono } from 'hono';
import { ApiError, type AppEnv } from './core';
import { authenticate, unauthorized } from './auth';
import { api } from './api';
import { bootstrap, setupStatus } from './setup';
import { pspWebhook } from './payments';

const app = new Hono<AppEnv>();

const PUBLIC_PATHS = new Set(['/api/health', '/api/setup', '/api/setup/status', '/api/auth/login']);

app.use('/api/*', async (c, next) => {
  if (!['GET', 'HEAD', 'OPTIONS'].includes(c.req.method)) {
    const origin = c.req.header('origin');
    if (origin) {
      const expected = new URL(c.req.url).origin;
      if (origin !== expected) {
        throw new ApiError(403, 'ORIGIN_MISMATCH', 'Cross-origin mutation rejected');
      }
    }
  }
  await next();
  c.header('x-content-type-options', 'nosniff');
  c.header('referrer-policy', 'same-origin');
  c.header('cache-control', 'no-store');
});

app.use('/api/*', async (c, next) => {
  const path = c.req.path;
  if (PUBLIC_PATHS.has(path) || path.startsWith('/api/webhooks/')) return next();
  const auth = await authenticate(c);
  if (!auth) unauthorized();

  if (auth.role === 'platform_admin') {
    const requested = c.req.header('x-tenant-id');
    if (requested) {
      const tenant = await c.env.DB.prepare('SELECT id FROM tenants WHERE id = ?').bind(requested).first<{ id: string }>();
      if (!tenant) throw new ApiError(400, 'TENANT_UNKNOWN', 'Requested tenant does not exist');
      c.set('auth', { ...auth, tenantId: requested });
      return next();
    }
  }
  c.set('auth', auth);
  await next();
});

app.get('/api/health', (c) =>
  c.json({
    ok: true,
    service: 'ugtp',
    version: '0.1.0',
    environment: c.env.ENVIRONMENT ?? 'sandbox',
    time: Date.now(),
  }),
);

app.get('/api/setup/status', async (c) => c.json(await setupStatus(c.env)));

app.post('/api/setup', async (c) => c.json(await bootstrap(c.env), 201));

app.post('/api/webhooks/psp/:tenantId', async (c) => {
  const raw = await c.req.text();
  const tenantId = c.req.param('tenantId');
  const tenant = await c.env.DB.prepare('SELECT id FROM tenants WHERE id = ?').bind(tenantId).first<{ id: string }>();
  if (!tenant) throw new ApiError(404, 'TENANT_NOT_FOUND', 'Unknown tenant');
  return c.json(await pspWebhook(c.env, tenantId, raw, c.req.header('x-psp-signature') ?? null));
});

app.route('/api', api);

app.all('/api/*', (c) => c.json({ error: { code: 'NOT_FOUND', message: 'Endpoint not found' } }, 404));

app.all('*', (c) => c.env.ASSETS.fetch(c.req.raw));

app.onError((error, c) => {
  if (error instanceof ApiError) {
    return c.json(
      { error: { code: error.code, message: error.message, details: error.details ?? null } },
      error.status as 400,
    );
  }
  console.error('unhandled', error);
  return c.json({ error: { code: 'INTERNAL_ERROR', message: 'Internal server error' } }, 500);
});

export default app;
