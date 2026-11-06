import { useCallback, useEffect, useState } from 'react';
import { api, can, money, number, when, type Session } from '../api';
import { Badge, ErrorNote, Panel, Stat, Table, statusTone, type Row } from '../ui';

export default function Overview({ session }: { session: Session }) {
  const [data, setData] = useState<Row | null>(null);
  const [licences, setLicences] = useState<Row[]>([]);
  const [error, setError] = useState<unknown>(null);

  const load = useCallback(async () => {
    try {
      const overview = await api<Row>('/overview');
      setData(overview);
      if (can(session, 'compliance:read')) {
        const licenceData = await api<{ licences: Row[] }>('/compliance/licences');
        setLicences(licenceData.licences);
      }
      setError(null);
    } catch (err) {
      setError(err);
    }
  }, [session]);

  useEffect(() => {
    void load();
  }, [load]);

  if (error) {
    return (
      <Panel title="Overview">
        <div className="pad">
          <ErrorNote error={error} />
        </div>
      </Panel>
    );
  }
  if (!data) {
    return (
      <Panel title="Overview">
        <p className="pad muted">Loading console…</p>
      </Panel>
    );
  }

  const jurisdiction = (data.jurisdiction ?? {}) as Row;
  const licence = licences[0];
  const rounds = (data.recentRounds ?? []) as Row[];

  return (
    <>
      <div className="hero">
        <div>
          <h2>{String(data.tenant?.name ?? 'Tenant')}</h2>
          <p>
            {jurisdiction.name ?? 'Unknown jurisdiction'} · {jurisdiction.authority ?? 'No authority on file'} ·
            legal basis {jurisdiction.legal_basis ?? 'not assessed'}
          </p>
        </div>
        <div className="row gap wrap">
          <Badge tone={data.ledgerBalanced ? 'good' : 'bad'}>
            {data.ledgerBalanced ? 'Ledger balanced' : 'Ledger mismatch'}
          </Badge>
          <Badge
            tone={
              jurisdiction.money_gaming === 'prohibited'
                ? 'bad'
                : jurisdiction.money_gaming === 'permitted_with_licence'
                  ? 'good'
                  : 'warn'
            }
          >
            money gaming · {String(jurisdiction.money_gaming ?? 'unknown')}
          </Badge>
        </div>
      </div>

      <div className="grid cols-4">
        <Stat label="Players" value={number(data.players as number)} hint="registered in tenant" />
        <Stat
          label="Gross gaming revenue"
          value={money(data.grossGamingRevenueMinor as number)}
          hint={`${money(data.wageredMinor as number)} wagered`}
          tone="gold"
        />
        <Stat
          label="Pending withdrawals"
          value={money(data.pendingWithdrawalMinor as number)}
          hint={`${number(data.pendingWithdrawals as number)} awaiting approval`}
          tone={Number(data.pendingWithdrawals) ? 'red' : undefined}
        />
        <Stat label="Ledger postings" value={number(data.postings as number)} hint="append-only entries" tone="green" />
      </div>

      <div className="grid cols-2">
        <Panel
          title="Regulatory authorization"
          subtitle="A capability is available only when an active, verified licence covers it."
        >
          <div className="pad stack">
            {!licence ? (
              <p className="muted small">
                No licence on file. Every regulated money action (deposit, withdrawal, real-money wager,
                redemption, credit, affiliate payout, settlement confirmation) will be denied.
              </p>
            ) : (
              <>
                <div className="kv">
                  <span>Licence</span>
                  <strong>{String(licence.licence_number)}</strong>
                </div>
                <div className="kv">
                  <span>Status</span>
                  <Badge tone={statusTone(String(licence.status))}>{String(licence.status)}</Badge>
                </div>
                <div className="kv">
                  <span>Authority</span>
                  <span>{String(licence.authority)}</span>
                </div>
                <div className="kv">
                  <span>Valid until</span>
                  <span>{when(licence.valid_to as number)}</span>
                </div>
                <div className="kv">
                  <span>Verified</span>
                  <span>{licence.verified_at ? when(licence.verified_at as number) : 'not verified'}</span>
                </div>
                <div className="kv">
                  <span>Activities</span>
                  <span className="mono">{String(licence.activities_json ?? '')}</span>
                </div>
                <div className="kv">
                  <span>Evidence</span>
                  <span className="mono">{String(licence.evidence_ref ?? '—')}</span>
                </div>
              </>
            )}
          </div>
        </Panel>

        <Panel title="Financial invariants" subtitle="Checked on every overview request and in CI.">
          <div className="pad stack">
            <div className="kv">
              <span>Double-entry balance</span>
              <span>{data.ledgerBalanced ? 'All asset postings net to zero' : 'Mismatch detected'}</span>
            </div>
            <div className="kv">
              <span>Gaming revenue</span>
              <span>{money(data.grossGamingRevenueMinor as number)}</span>
            </div>
            <div className="kv">
              <span>Pending settlement</span>
              <span>{money(data.pendingWithdrawalMinor as number)}</span>
            </div>
            <div className="kv">
              <span>Agents</span>
              <span>{number(data.agents as number)}</span>
            </div>
            <p className="muted small">
              Balances are a projection of append-only postings. Corrections create reversal transactions;
              no financial history is edited or deleted.
            </p>
          </div>
        </Panel>
      </div>

      <Panel title="Recent rounds" subtitle="Server-authoritative outcomes with provably fair seeds.">
        <Table
          columns={[
            { key: 'game_code', label: 'Game' },
            { key: 'stake_minor', label: 'Stake', align: 'right', render: (row) => money(row.stake_minor) },
            { key: 'payout_minor', label: 'Payout', align: 'right', render: (row) => money(row.payout_minor) },
            {
              key: 'status',
              label: 'Outcome',
              render: (row) => <Badge tone={statusTone(String(row.status))}>{String(row.status)}</Badge>,
            },
            { key: 'created_at', label: 'When', render: (row) => when(row.created_at as number) },
          ]}
          rows={rounds}
          empty="No rounds played in this tenant yet."
        />
      </Panel>
    </>
  );
}
