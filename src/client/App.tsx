import { useCallback, useEffect, useState } from 'react';
import { api, can, setTenantOverride, type Session } from './api';
import { Badge, Button, ErrorNote, Form, Panel } from './ui';
import Overview from './pages/Overview';
import Operations from './pages/Operations';
import Finance from './pages/Finance';
import Growth from './pages/Growth';
import Compliance from './pages/Compliance';
import Play from './pages/Play';

interface SetupStatus {
  initialized: boolean;
  environment: string;
  allowsBootstrap: boolean;
}

interface BootstrapResult {
  tenants: { id: string; name: string; jurisdiction: string }[];
  accounts: { email: string; password: string; role: string; tenant: string | null }[];
  note: string;
}

const NAV = [
  { group: 'Platform', items: [{ path: '/', label: 'Overview', glyph: '◈', permission: 'tenant:read' }] },
  {
    group: 'Operations',
    items: [
      { path: '/players', label: 'Players', glyph: '◎', permission: 'player:read' },
      { path: '/agents', label: 'Agents & Credit', glyph: '⌘', permission: 'agent:read' },
    ],
  },
  {
    group: 'Finance',
    items: [
      { path: '/finance', label: 'Payments & Settlement', glyph: '⇄', permission: 'payment:read' },
      { path: '/growth', label: 'Affiliates', glyph: '✧', permission: 'affiliate:read' },
    ],
  },
  {
    group: 'Governance',
    items: [{ path: '/compliance', label: 'Compliance', glyph: '⚖', permission: 'compliance:read' }],
  },
  {
    group: 'Games',
    items: [{ path: '/play', label: 'Game Lobby', glyph: '◆', permission: 'game:play' }],
  },
];

function currentRoute(): string {
  return window.location.hash.replace(/^#/, '') || '/';
}

export default function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [ready, setReady] = useState(false);
  const [setupStatus, setSetupStatus] = useState<SetupStatus | null>(null);
  const [bootstrap, setBootstrap] = useState<BootstrapResult | null>(null);
  const [route, setRoute] = useState(currentRoute());
  const [tenantId, setTenantId] = useState<string | null>(() => localStorage.getItem('ugtp.tenant'));
  const [loginError, setLoginError] = useState<unknown>(null);

  const loadSession = useCallback(async () => {
    setTenantOverride(tenantId);
    try {
      let me = await api<Session>('/me');
      if (me.user.role === 'platform_admin' && !me.tenant && me.tenants.length) {
        const first = me.tenants[0].id;
        localStorage.setItem('ugtp.tenant', first);
        setTenantOverride(first);
        setTenantId(first);
        me = await api<Session>('/me');
      }
      setSession(me);
    } catch {
      setSession(null);
    }
  }, [tenantId]);

  useEffect(() => {
    loadSession().finally(() => setReady(true));
  }, [loadSession]);

  useEffect(() => {
    const onHash = () => setRoute(currentRoute());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  useEffect(() => {
    api<SetupStatus>('/setup/status')
      .then(setSetupStatus)
      .catch(() => setSetupStatus(null));
  }, []);

  function navigate(path: string) {
    window.location.hash = path;
    setRoute(path);
  }

  async function login(values: Record<string, string>) {
    await api('/auth/login', { method: 'POST', body: values });
    setBootstrap(null);
    await loadSession();
    navigate('/');
  }

  async function runSetup() {
    const result = await api<BootstrapResult>('/setup', { method: 'POST', body: {} });
    setBootstrap(result);
    setSetupStatus({ initialized: true, environment: 'sandbox', allowsBootstrap: false });
  }

  async function logout() {
    await api('/auth/logout', { method: 'POST', body: {} }).catch(() => undefined);
    setSession(null);
    setTenantId(null);
    localStorage.removeItem('ugtp.tenant');
    setTenantOverride(null);
  }

  function chooseTenant(id: string) {
    localStorage.setItem('ugtp.tenant', id);
    setTenantId(id);
  }

  if (!ready) {
    return (
      <div className="login-wrap">
        <p className="muted">Loading UGTP…</p>
      </div>
    );
  }

  if (!session) {
    return (
      <div className="login-wrap">
        <div className="login-card">
          <div className="brand" style={{ padding: 0, marginBottom: 14 }}>
            <div className="brand-mark">Ω</div>
            <div>
              <div className="brand-name">
                UGTP <span>Ω∞</span>
              </div>
              <div className="brand-sub">Universal Gaming Technology Platform</div>
            </div>
          </div>
          <h1>Operator console</h1>
          <p className="muted small">
            Sandbox environment · no real funds · regulatory policy enforced server-side.
          </p>

          {setupStatus && !setupStatus.initialized && setupStatus.allowsBootstrap ? (
            <div style={{ marginTop: 18 }} className="stack">
              <p className="small muted">
                This deployment has no accounts yet. Initialize the sandbox to seed a licensed demo
                operator, an India jurisdiction profile, compliance/ finance users and a player.
              </p>
              <Button variant="primary" onClick={() => void runSetup().catch(() => undefined)}>
                Initialize sandbox
              </Button>
              {!bootstrap ? null : (
                <div className="credentials">
                  <p className="small">Credentials are shown once. Store them now.</p>
                  {bootstrap.accounts.map((account) => (
                    <div className="credential" key={account.email}>
                      <strong>
                        {account.role} · {account.tenant ?? 'platform'}
                      </strong>
                      <code>{account.email}</code>
                      <code>{account.password}</code>
                    </div>
                  ))}
                </div>
              )}
            </div>
          ) : (
            <>
              <form
                className="login-form"
                onSubmit={(event) => {
                  event.preventDefault();
                  const data = new FormData(event.currentTarget);
                  void login({ email: String(data.get('email')), password: String(data.get('password')) }).catch(
                    (error) => setLoginError(error),
                  );
                }}
              >
                <label className="field">
                  <span>Email</span>
                  <input name="email" type="email" autoComplete="username" required />
                </label>
                <label className="field">
                  <span>Password</span>
                  <input name="password" type="password" autoComplete="current-password" required />
                </label>
                <Button type="submit" variant="primary">
                  Sign in
                </Button>
                {loginError ? <ErrorNote error={loginError} /> : null}
              </form>
              {bootstrap ? (
                <div className="credentials">
                  {bootstrap.accounts.map((account) => (
                    <div className="credential" key={account.email}>
                      <strong>
                        {account.role} · {account.tenant ?? 'platform'}
                      </strong>
                      <code>{account.email}</code>
                      <code>{account.password}</code>
                    </div>
                  ))}
                </div>
              ) : null}
            </>
          )}
        </div>
      </div>
    );
  }

  const isPlayer = session.user.role === 'player';
  const effectiveRoute = isPlayer ? '/play' : route;
  const title = NAV.flatMap((group) => group.items).find((item) => item.path === effectiveRoute)?.label ?? 'Console';

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark">Ω</div>
          <div>
            <div className="brand-name">
              UGTP <span>Ω∞</span>
            </div>
            <div className="brand-sub">Control plane</div>
          </div>
        </div>
        <nav className="nav">
          {NAV.map((group) => {
            const items = group.items.filter((item) => can(session, item.permission));
            if (!items.length) return null;
            return (
              <div key={group.group}>
                <div className="nav-label">{group.group}</div>
                {items.map((item) => (
                  <a
                    key={item.path}
                    href={`#${item.path}`}
                    className={effectiveRoute === item.path ? 'active' : undefined}
                    onClick={() => setRoute(item.path)}
                  >
                    <span className="icon">{item.glyph}</span>
                    {item.label}
                  </a>
                ))}
              </div>
            );
          })}
        </nav>
        <div className="sidebar-foot">
          <span className="env-pill">
            <span className="dot" /> Sandbox · sandbox PSP
          </span>
          <Button variant="ghost" onClick={() => void logout()}>
            Sign out
          </Button>
        </div>
      </aside>

      <div className="main">
        <header className="topbar">
          <div className="topbar-left">
            <span className="crumb">{session.tenant?.name ?? 'Platform'}</span>
            <h1>{title}</h1>
            {session.tenant ? <Badge tone="info">{session.tenant.jurisdiction_code}</Badge> : null}
          </div>
          <div className="topbar-right">
            {session.user.role === 'platform_admin' && session.tenants.length ? (
              <select
                value={session.tenant?.id ?? ''}
                onChange={(event) => chooseTenant(event.target.value)}
                style={{ width: 200 }}
              >
                {session.tenants.map((tenant) => (
                  <option key={tenant.id} value={tenant.id}>
                    {tenant.name} · {tenant.jurisdiction_code}
                  </option>
                ))}
              </select>
            ) : null}
            <div className="user-chip">
              <div className="avatar">{session.user.displayName.slice(0, 2).toUpperCase()}</div>
              <div className="user-meta">
                <strong>{session.user.displayName}</strong>
                <span>{session.user.role.replace('_', ' ')}</span>
              </div>
            </div>
          </div>
        </header>
        <main className="content">
          {effectiveRoute === '/players' ? <Operations section="players" session={session} /> : null}
          {effectiveRoute === '/agents' ? <Operations section="agents" session={session} /> : null}
          {effectiveRoute === '/finance' ? <Finance session={session} /> : null}
          {effectiveRoute === '/growth' ? <Growth session={session} /> : null}
          {effectiveRoute === '/compliance' ? <Compliance session={session} /> : null}
          {effectiveRoute === '/play' ? <Play session={session} /> : null}
          {!['/players', '/agents', '/finance', '/growth', '/compliance', '/play'].includes(effectiveRoute) ? (
            <Overview session={session} />
          ) : null}
        </main>
      </div>
    </div>
  );
}
