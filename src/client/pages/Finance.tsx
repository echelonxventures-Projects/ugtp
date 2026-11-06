import { useCallback, useEffect, useState } from 'react';
import { api, can, money, when, type Session } from '../api';
import { Badge, Button, ErrorNote, Form, Panel, Table, statusTone, type Row } from '../ui';

export default function Finance({ session }: { session: Session }) {
  const [payments, setPayments] = useState<Row[]>([]);
  const [settlements, setSettlements] = useState<Row[]>([]);
  const [redemptions, setRedemptions] = useState<Row[]>([]);
  const [error, setError] = useState<unknown>(null);

  const load = useCallback(async () => {
    try {
      const [paymentData, settlementData, redemptionData] = await Promise.all([
        api<{ payments: Row[] }>('/payments'),
        api<{ settlements: Row[] }>('/settlements'),
        api<{ redemptions: Row[] }>('/redemptions'),
      ]);
      setPayments(paymentData.payments);
      setSettlements(settlementData.settlements);
      setRedemptions(redemptionData.redemptions);
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

  const canWrite = can(session, 'payment:write');
  const canApprove = can(session, 'payment:approve');

  return (
    <>
      {error ? (
        <Panel title="Action failed">
          <div className="pad"><ErrorNote error={error} /></div>
        </Panel>
      ) : null}

      <Panel title="Payments" subtitle="Sandbox PSP. Withdrawals hold funds until a different operator approves.">
        <Table
          columns={[
            {
              key: 'player',
              label: 'Player',
              render: (row) => (
                <div className="stack">
                  <strong>{String(row.display_name)}</strong>
                  <span className="muted small">{String(row.email)}</span>
                </div>
              ),
            },
            { key: 'direction', label: 'Direction' },
            { key: 'amount_minor', label: 'Amount', align: 'right', render: (row) => money(row.amount_minor) },
            { key: 'method', label: 'Method' },
            {
              key: 'status',
              label: 'Status',
              render: (row) => <Badge tone={statusTone(String(row.status))}>{String(row.status)}</Badge>,
            },
            { key: 'provider_ref', label: 'Provider ref', render: (row) => <span className="mono small">{String(row.provider_ref ?? '—')}</span> },
            { key: 'created_at', label: 'Created', render: (row) => when(row.created_at as number) },
            {
              key: 'actions',
              label: 'Actions',
              render: (row) =>
                canApprove && row.status === 'pending_approval' && row.direction === 'withdrawal' ? (
                  <div className="row gap">
                    <Button
                      onClick={() =>
                        void act(() =>
                          api(`/payments/${row.id}/approve`, { method: 'POST', body: {} }),
                        )
                      }
                    >
                      Pay out
                    </Button>
                    <Button
                      variant="danger"
                      onClick={() =>
                        void act(() =>
                          api(`/payments/${row.id}/reject`, {
                            method: 'POST',
                            body: { reason: 'Rejected by operator' },
                          }),
                        )
                      }
                    >
                      Reject
                    </Button>
                  </div>
                ) : null,
            },
          ]}
          rows={payments}
          empty="No payments yet."
        />
        {canWrite ? (
          <div className="pad">
            <Form
              submitLabel="Deposit"
              inline
              fields={[
                { name: 'playerId', label: 'Player id', width: 'lg' },
                { name: 'amountMinor', label: 'Amount (minor)', type: 'number', width: 'sm' },
                { name: 'method', label: 'Method', defaultValue: 'sandbox_card', width: 'md' },
              ]}
              onSubmit={async (values) => {
                await api('/payments/deposit', {
                  method: 'POST',
                  body: { playerId: values.playerId, amountMinor: Number(values.amountMinor), method: values.method },
                });
                await load();
              }}
            />
            <Form
              submitLabel="Request withdrawal"
              inline
              fields={[
                { name: 'playerId', label: 'Player id', width: 'lg' },
                { name: 'amountMinor', label: 'Amount (minor)', type: 'number', width: 'sm' },
                { name: 'method', label: 'Method', defaultValue: 'bank_transfer', width: 'md' },
              ]}
              onSubmit={async (values) => {
                await api('/payments/withdrawals', {
                  method: 'POST',
                  body: { playerId: values.playerId, amountMinor: Number(values.amountMinor), method: values.method },
                });
                await load();
              }}
            />
          </div>
        ) : null}
      </Panel>

      <Panel
        title="Settlements"
        subtitle="An external claim is never confirmed without evidence and a second approver."
      >
        <Table
          columns={[
            { key: 'kind', label: 'Kind' },
            { key: 'counterparty', label: 'Counterparty' },
            { key: 'amount_minor', label: 'Amount', align: 'right', render: (row) => money(row.amount_minor) },
            { key: 'source', label: 'Source' },
            {
              key: 'status',
              label: 'Status',
              render: (row) => <Badge tone={statusTone(String(row.status))}>{String(row.status)}</Badge>,
            },
            { key: 'evidence_ref', label: 'Evidence', render: (row) => <span className="mono small">{String(row.evidence_ref ?? '—')}</span> },
            { key: 'created_at', label: 'Created', render: (row) => when(row.created_at as number) },
          ]}
          rows={settlements}
          empty="No settlements."
        />
        <div className="pad">
          <Form
            submitLabel="Create settlement"
            inline
            fields={[
              {
                name: 'kind',
                label: 'Kind',
                type: 'select',
                options: [
                  { value: 'off_platform', label: 'Off-platform' },
                  { value: 'game_cash', label: 'Game cash' },
                  { value: 'agent', label: 'Agent' },
                  { value: 'operator', label: 'Operator' },
                  { value: 'partner', label: 'Partner' },
                ],
              },
              {
                name: 'source',
                label: 'Source',
                type: 'select',
                options: [
                  { value: 'external', label: 'External claim' },
                  { value: 'platform', label: 'Platform' },
                ],
              },
              { name: 'counterparty', label: 'Counterparty', width: 'md' },
              { name: 'amountMinor', label: 'Amount (minor)', type: 'number', width: 'sm' },
              { name: 'evidenceRef', label: 'Evidence ref', width: 'md' },
            ]}
            onSubmit={async (values) => {
              await api('/settlements', {
                method: 'POST',
                body: {
                  kind: values.kind,
                  source: values.source,
                  counterparty: values.counterparty,
                  amountMinor: Number(values.amountMinor),
                  evidenceRef: values.evidenceRef || undefined,
                },
              });
              await load();
            }}
          />
          <Form
            submitLabel="Apply transition"
            inline
            fields={[
              { name: 'settlementId', label: 'Settlement id', width: 'lg' },
              {
                name: 'next',
                label: 'Next state',
                type: 'select',
                options: [
                  { value: 'pending_verification', label: 'Submit for verification' },
                  { value: 'verified', label: 'Verify' },
                  { value: 'confirmed', label: 'Confirm' },
                  { value: 'reconciled', label: 'Reconcile' },
                  { value: 'disputed', label: 'Dispute' },
                  { value: 'reversed', label: 'Reverse' },
                ],
              },
              { name: 'evidenceRef', label: 'Evidence ref', width: 'md' },
              { name: 'reason', label: 'Reason (reversal)', width: 'md' },
            ]}
            onSubmit={async (values) => {
              await api(`/settlements/${values.settlementId}/transition`, {
                method: 'POST',
                body: {
                  next: values.next,
                  evidenceRef: values.evidenceRef || undefined,
                  reason: values.reason || undefined,
                },
              });
              await load();
            }}
          />
        </div>
      </Panel>

      <Panel
        title="Redemptions"
        subtitle="Only monetary, redeemable assets can be converted; play credits can never be cashed out."
      >
        <Table
          columns={[
            {
              key: 'player',
              label: 'Player',
              render: (row) => (
                <div className="stack">
                  <strong>{String(row.display_name)}</strong>
                  <span className="muted small">{String(row.email)}</span>
                </div>
              ),
            },
            { key: 'asset_code', label: 'Asset' },
            { key: 'units', label: 'Units', align: 'right' },
            { key: 'amount_minor', label: 'Payout', align: 'right', render: (row) => money(row.amount_minor) },
            {
              key: 'status',
              label: 'Status',
              render: (row) => <Badge tone={statusTone(String(row.status))}>{String(row.status)}</Badge>,
            },
            { key: 'created_at', label: 'Requested', render: (row) => when(row.created_at as number) },
            {
              key: 'actions',
              label: 'Actions',
              render: (row) =>
                row.status === 'pending_approval' && can(session, 'redemption:approve') ? (
                  <div className="row gap">
                    <Button onClick={() => void act(() => api(`/redemptions/${row.id}/approve`, { method: 'POST', body: {} }))}>
                      Approve
                    </Button>
                    <Button variant="danger" onClick={() => void act(() => api(`/redemptions/${row.id}/reject`, { method: 'POST', body: {} }))}>
                      Reject
                    </Button>
                  </div>
                ) : null,
            },
          ]}
          rows={redemptions}
          empty="No redemptions."
        />
        <div className="pad">
          <Form
            submitLabel="Request redemption"
            inline
            fields={[
              { name: 'playerId', label: 'Player id', width: 'lg' },
              { name: 'units', label: 'Units (minor)', type: 'number', width: 'sm' },
              { name: 'assetCode', label: 'Asset', defaultValue: 'USD', width: 'sm' },
            ]}
            onSubmit={async (values) => {
              await api('/redemptions', {
                method: 'POST',
                body: { playerId: values.playerId, units: Number(values.units), assetCode: values.assetCode },
              });
              await load();
            }}
          />
        </div>
      </Panel>
    </>
  );
}
