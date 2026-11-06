import { useCallback, useEffect, useState } from 'react';
import { api, bps, can, money, when, type Session } from '../api';
import { Badge, Button, ErrorNote, Form, Panel, Table, statusTone, type Row } from '../ui';

function dateInput(daysAgo = 0): string {
  const date = new Date(Date.now() - daysAgo * 86_400_000);
  return date.toISOString().slice(0, 10);
}

export default function Growth({ session }: { session: Session }) {
  const [affiliates, setAffiliates] = useState<Row[]>([]);
  const [commissions, setCommissions] = useState<Row[]>([]);
  const [payouts, setPayouts] = useState<Row[]>([]);
  const [error, setError] = useState<unknown>(null);
  const [note, setNote] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const data = await api<{ affiliates: Row[]; commissions: Row[]; payouts: Row[] }>('/affiliates');
      setAffiliates(data.affiliates);
      setCommissions(data.commissions);
      setPayouts(data.payouts);
      setError(null);
    } catch (err) {
      setError(err);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function act(fn: () => Promise<unknown>) {
    try {
      await fn();
      await load();
    } catch (err) {
      setError(err);
    }
  }

  const canApprove = can(session, 'affiliate:approve');

  return (
    <>
      {error ? (
        <Panel title="Action failed">
          <div className="pad"><ErrorNote error={error} /></div>
        </Panel>
      ) : null}

      <Panel title="Affiliates" subtitle="Attribution is unique per player and bound to a versioned contract.">
        <Table
          columns={[
            {
              key: 'name',
              label: 'Affiliate',
              render: (row) => (
                <div className="stack">
                  <strong>{String(row.name)}</strong>
                  <span className="muted small mono">{String(row.code)}</span>
                </div>
              ),
            },
            {
              key: 'status',
              label: 'Status',
              render: (row) => <Badge tone={statusTone(String(row.status))}>{String(row.status)}</Badge>,
            },
            { key: 'model', label: 'Model', render: (row) => String(row.model ?? '—') },
            { key: 'contract_version', label: 'Contract v', align: 'right', render: (row) => String(row.contract_version ?? '—') },
            { key: 'players', label: 'Attributed players', align: 'right' },
            { key: 'tax_withholding_bps', label: 'Withholding', align: 'right', render: (row) => bps(row.tax_withholding_bps) },
            {
              key: 'actions',
              label: 'Actions',
              render: (row) =>
                canApprove && row.status !== 'active' ? (
                  <Button onClick={() => void act(() => api(`/affiliates/${row.id}/status`, { method: 'PATCH', body: { status: 'active' } }))}>
                    Activate
                  </Button>
                ) : canApprove && row.status === 'active' ? (
                  <Button variant="danger" onClick={() => void act(() => api(`/affiliates/${row.id}/status`, { method: 'PATCH', body: { status: 'suspended' } }))}>
                    Suspend
                  </Button>
                ) : null,
            },
          ]}
          rows={affiliates}
          empty="No affiliates."
        />
        <div className="pad">
          <Form
            submitLabel="Create affiliate"
            inline
            fields={[
              { name: 'name', label: 'Name', width: 'md' },
              { name: 'code', label: 'Code', width: 'sm' },
              { name: 'taxWithholdingBps', label: 'Withholding (bps)', type: 'number', defaultValue: 1500, width: 'sm' },
            ]}
            onSubmit={async (values) => {
              await api('/affiliates', {
                method: 'POST',
                body: { name: values.name, code: values.code, taxWithholdingBps: Number(values.taxWithholdingBps) },
              });
              await load();
            }}
          />
          <Form
            submitLabel="Publish contract"
            inline
            fields={[
              { name: 'affiliateId', label: 'Affiliate id', width: 'lg' },
              {
                name: 'model',
                label: 'Model',
                type: 'select',
                options: [
                  { value: 'revenue_share', label: 'Revenue share' },
                  { value: 'cpa', label: 'CPA' },
                  { value: 'hybrid', label: 'Hybrid' },
                  { value: 'tiered', label: 'Tiered' },
                ],
              },
              { name: 'revshareBps', label: 'Rev share (bps)', type: 'number', defaultValue: 2500, width: 'sm' },
              { name: 'cpaMinor', label: 'CPA (minor)', type: 'number', defaultValue: 5000, width: 'sm' },
              { name: 'minPayoutMinor', label: 'Min payout (minor)', type: 'number', defaultValue: 1000, width: 'sm' },
            ]}
            onSubmit={async (values) => {
              await api(`/affiliates/${values.affiliateId}/contracts`, {
                method: 'POST',
                body: {
                  model: values.model,
                  revshareBps: Number(values.revshareBps),
                  cpaMinor: Number(values.cpaMinor),
                  minPayoutMinor: Number(values.minPayoutMinor),
                },
              });
              await load();
            }}
          />
          <Form
            submitLabel="Attribute player"
            inline
            fields={[
              { name: 'affiliateId', label: 'Affiliate id', width: 'lg' },
              { name: 'playerId', label: 'Player id', width: 'lg' },
              { name: 'campaign', label: 'Campaign', width: 'md' },
            ]}
            onSubmit={async (values) => {
              await api(`/affiliates/${values.affiliateId}/attribute`, {
                method: 'POST',
                body: { playerId: values.playerId, campaign: values.campaign || undefined },
              });
              await load();
            }}
          />
          <Form
            submitLabel="Calculate commission"
            inline
            fields={[
              { name: 'affiliateId', label: 'Affiliate id', width: 'lg' },
              { name: 'periodStart', label: 'From', type: 'date', defaultValue: dateInput(30), width: 'md' },
              { name: 'periodEnd', label: 'To', type: 'date', defaultValue: dateInput(0), width: 'md' },
            ]}
            onSubmit={async (values) => {
              await api(`/affiliates/${values.affiliateId}/commissions`, {
                method: 'POST',
                body: {
                  periodStart: new Date(`${values.periodStart}T00:00:00Z`).getTime(),
                  periodEnd: new Date(`${values.periodEnd}T23:59:59Z`).getTime(),
                },
              });
              await load();
            }}
          />
        </div>
      </Panel>

      <Panel
        title="Commission statements"
        subtitle="Every statement is reproducible from its stored source lines and contract version."
      >
        {note ? <p className="pad form-ok">{note}</p> : null}
        <Table
          columns={[
            { key: 'affiliate_name', label: 'Affiliate' },
            { key: 'contract_version', label: 'Contract v', align: 'right' },
            { key: 'amount_minor', label: 'Amount', align: 'right', render: (row) => money(row.amount_minor) },
            {
              key: 'status',
              label: 'Status',
              render: (row) => <Badge tone={statusTone(String(row.status))}>{String(row.status)}</Badge>,
            },
            {
              key: 'period',
              label: 'Period',
              render: (row) => (
                <span className="small muted">
                  {when(row.period_start as number)} → {when(row.period_end as number)}
                </span>
              ),
            },
            {
              key: 'actions',
              label: 'Actions',
              render: (row) => (
                <div className="row gap">
                  <Button
                    onClick={() =>
                      void act(async () => {
                        const result = await api<{ matches: boolean; storedAmountMinor: number; recomputedAmountMinor: number }>(
                          `/commissions/${row.id}/verify`,
                        );
                        setNote(
                          result.matches
                            ? `Reproduced ${money(result.recomputedAmountMinor)} from source lines.`
                            : `Mismatch: stored ${money(result.storedAmountMinor)} vs ${money(result.recomputedAmountMinor)}`,
                        );
                      })
                    }
                  >
                    Verify
                  </Button>
                  {canApprove && row.status === 'draft' ? (
                    <Button onClick={() => void act(() => api(`/commissions/${row.id}/approve`, { method: 'POST', body: {} }))}>
                      Approve
                    </Button>
                  ) : null}
                  {can(session, 'affiliate:write') && row.status === 'approved' ? (
                    <Button onClick={() => void act(() => api(`/commissions/${row.id}/payout`, { method: 'POST', body: {} }))}>
                      Request payout
                    </Button>
                  ) : null}
                </div>
              ),
            },
          ]}
          rows={commissions}
          empty="No commissions calculated."
        />
      </Panel>

      <Panel title="Affiliate payouts" subtitle="Requester cannot approve. Jurisdiction policy is re-checked at execution.">
        <Table
          columns={[
            { key: 'affiliate_name', label: 'Affiliate' },
            { key: 'amount_minor', label: 'Gross', align: 'right', render: (row) => money(row.amount_minor) },
            { key: 'withheld_minor', label: 'Withheld', align: 'right', render: (row) => money(row.withheld_minor) },
            { key: 'net_minor', label: 'Net', align: 'right', render: (row) => money(row.net_minor) },
            {
              key: 'status',
              label: 'Status',
              render: (row) => <Badge tone={statusTone(String(row.status))}>{String(row.status)}</Badge>,
            },
            { key: 'provider_ref', label: 'Provider ref', render: (row) => <span className="mono small">{String(row.provider_ref ?? '—')}</span> },
            {
              key: 'actions',
              label: 'Actions',
              render: (row) =>
                canApprove && row.status === 'pending_approval' ? (
                  <div className="row gap">
                    <Button onClick={() => void act(() => api(`/payouts/${row.id}/approve`, { method: 'POST', body: {} }))}>
                      Approve payout
                    </Button>
                    <Button variant="danger" onClick={() => void act(() => api(`/payouts/${row.id}/reject`, { method: 'POST', body: {} }))}>
                      Reject
                    </Button>
                  </div>
                ) : null,
            },
          ]}
          rows={payouts}
          empty="No affiliate payouts."
        />
      </Panel>
    </>
  );
}
