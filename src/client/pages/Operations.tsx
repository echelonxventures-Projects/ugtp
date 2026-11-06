import { useCallback, useEffect, useState } from 'react';
import { api, can, money, when, type Session } from '../api';
import { Badge, Button, ErrorNote, Form, Panel, Table, statusTone, type Row } from '../ui';

export default function Operations({ session, section }: { session: Session; section: 'players' | 'agents' }) {
  const [players, setPlayers] = useState<Row[]>([]);
  const [agents, setAgents] = useState<Row[]>([]);
  const [facilities, setFacilities] = useState<Row[]>([]);
  const [error, setError] = useState<unknown>(null);

  const load = useCallback(async () => {
    try {
      const playerData = await api<{ players: Row[] }>('/players');
      setPlayers(playerData.players);
      if (section === 'agents') {
        const agentData = await api<{ agents: Row[] }>('/agents');
        setAgents(agentData.agents);
        const facilityData = await api<{ facilities: Row[] }>('/credit/facilities');
        setFacilities(facilityData.facilities);
      }
      setError(null);
    } catch (err) {
      setError(err);
    }
  }, [section]);

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

  if (section === 'players') {
    return (
      <>
        <Panel title="Players" subtitle="Identity status, jurisdiction and wallet balances.">
          {error ? <div className="pad"><ErrorNote error={error} /></div> : null}
          <Table
            columns={[
              {
                key: 'display_name',
                label: 'Player',
                render: (row) => (
                  <div className="stack">
                    <strong>{String(row.display_name)}</strong>
                    <span className="muted small">{String(row.email)}</span>
                  </div>
                ),
              },
              { key: 'jurisdiction_code', label: 'Jurisdiction' },
              {
                key: 'kyc_status',
                label: 'KYC',
                render: (row) => <Badge tone={statusTone(String(row.kyc_status))}>{String(row.kyc_status)}</Badge>,
              },
              {
                key: 'status',
                label: 'Status',
                render: (row) => <Badge tone={statusTone(String(row.status))}>{String(row.status)}</Badge>,
              },
              { key: 'usd_minor', label: 'Cash', align: 'right', render: (row) => money(row.usd_minor) },
              { key: 'xcr_minor', label: 'Play credits', align: 'right', render: (row) => money(row.xcr_minor) },
              {
                key: 'actions',
                label: 'Actions',
                render: (row) => (
                  <div className="row gap">
                    {row.kyc_status !== 'verified' ? (
                      <Button
                        onClick={() =>
                          void act(() => api(`/players/${row.id}`, { method: 'PATCH', body: { kycStatus: 'verified' } }))
                        }
                      >
                        Verify KYC
                      </Button>
                    ) : null}
                    {row.status === 'active' ? (
                      <Button
                        variant="danger"
                        onClick={() =>
                          void act(() => api(`/players/${row.id}`, { method: 'PATCH', body: { status: 'suspended' } }))
                        }
                      >
                        Suspend
                      </Button>
                    ) : (
                      <Button
                        onClick={() =>
                          void act(() => api(`/players/${row.id}`, { method: 'PATCH', body: { status: 'active' } }))
                        }
                      >
                        Reactivate
                      </Button>
                    )}
                  </div>
                ),
              },
            ]}
            rows={players}
            empty="No players yet."
          />
        </Panel>

        {can(session, 'player:write') ? (
          <Panel
            title="Onboard player"
            subtitle="A play-credit grant is issued through the ledger as a non-monetary asset."
          >
            <Form
              submitLabel="Create player"
              fields={[
                { name: 'displayName', label: 'Name', width: 'md' },
                { name: 'email', label: 'Email', type: 'text', width: 'lg' },
                { name: 'password', label: 'Temp password', type: 'password', width: 'md' },
                { name: 'playCredits', label: 'Play credits (minor)', type: 'number', defaultValue: 100000, width: 'sm' },
              ]}
              onSubmit={async (values) => {
                await api('/players', {
                  method: 'POST',
                  body: {
                    displayName: values.displayName,
                    email: values.email,
                    password: values.password,
                    playCredits: Number(values.playCredits || 0),
                  },
                });
                await load();
              }}
            />
          </Panel>
        ) : null}
      </>
    );
  }

  return (
    <>
      <Panel title="Agent hierarchy" subtitle="Tenant-scoped, acyclic and depth-bounded to five levels.">
        {error ? <div className="pad"><ErrorNote error={error} /></div> : null}
        <Table
          columns={[
            { key: 'name', label: 'Agent', render: (row) => <div className="stack"><strong>{String(row.name)}</strong><span className="muted small mono">{String(row.code)}</span></div> },
            { key: 'agent_type', label: 'Type' },
            { key: 'parent_name', label: 'Parent', render: (row) => String(row.parent_name ?? '—') },
            { key: 'status', label: 'Status', render: (row) => <Badge tone={statusTone(String(row.status))}>{String(row.status)}</Badge> },
            { key: 'players', label: 'Players', align: 'right' },
            { key: 'credit_outstanding_minor', label: 'Credit exposure', align: 'right', render: (row) => money(row.credit_outstanding_minor) },
            {
              key: 'actions',
              label: 'Actions',
              render: (row) => (
                <div className="row gap">
                  {row.status === 'active' ? (
                    <Button variant="danger" onClick={() => void act(() => api(`/agents/${row.id}/status`, { method: 'PATCH', body: { status: 'suspended' } }))}>
                      Suspend
                    </Button>
                  ) : (
                    <Button onClick={() => void act(() => api(`/agents/${row.id}/status`, { method: 'PATCH', body: { status: 'active' } }))}>
                      Activate
                    </Button>
                  )}
                </div>
              ),
            },
          ]}
          rows={agents}
          empty="No agents yet."
        />
      </Panel>

      <Panel title="Create agent" subtitle="Agent permissions are explicit and never inherited from a parent.">
        <Form
          submitLabel="Create agent"
          fields={[
            { name: 'name', label: 'Name', width: 'md' },
            { name: 'code', label: 'Code', width: 'sm' },
            {
              name: 'agentType',
              label: 'Type',
              type: 'select',
              options: [
                { value: 'master', label: 'Master' },
                { value: 'regional', label: 'Regional' },
                { value: 'sub', label: 'Sub-agent' },
                { value: 'distributor', label: 'Distributor' },
                { value: 'franchise', label: 'Franchise' },
              ],
            },
            { name: 'parentId', label: 'Parent id (optional)', width: 'lg' },
            { name: 'creditLimitMinor', label: 'Credit ceiling (minor)', type: 'number', width: 'sm' },
          ]}
          onSubmit={async (values) => {
            await api('/agents', {
              method: 'POST',
              body: {
                name: values.name,
                code: values.code,
                agentType: values.agentType,
                parentId: values.parentId || null,
                creditLimitMinor: Number(values.creditLimitMinor || 0),
              },
            });
            await load();
          }}
        />
        <div className="pad">
          <Form
            submitLabel="Change parent"
            inline
            fields={[
              { name: 'agentId', label: 'Agent id', width: 'lg' },
              { name: 'parentId', label: 'New parent id', width: 'lg' },
            ]}
            onSubmit={async (values) => {
              await api(`/agents/${values.agentId}/parent`, {
                method: 'PATCH',
                body: { parentId: values.parentId || null },
              });
              await load();
            }}
          />
        </div>
      </Panel>

      <Panel title="Credit facilities" subtitle="Draws are bounded by limit and outstanding exposure; larger draws need a second approver.">
        <Table
          columns={[
            { key: 'subject', label: 'Subject', render: (row) => <div className="stack"><Badge tone="info">{String(row.subject_type)}</Badge><span className="mono small">{String(row.subject_id)}</span></div> },
            { key: 'limit_minor', label: 'Limit', align: 'right', render: (row) => money(row.limit_minor) },
            { key: 'outstanding_minor', label: 'Outstanding', align: 'right', render: (row) => money(row.outstanding_minor) },
            { key: 'status', label: 'Status', render: (row) => <Badge tone={statusTone(String(row.status))}>{String(row.status)}</Badge> },
            { key: 'policy_ref', label: 'Policy' },
            { key: 'created_at', label: 'Opened', render: (row) => when(row.created_at as number) },
            {
              key: 'actions',
              label: 'Actions',
              render: (row) =>
                row.status === 'pending_approval' ? (
                  <Button onClick={() => void act(() => api(`/credit/facilities/${row.id}/activate`, { method: 'POST', body: {} }))}>
                    Approve
                  </Button>
                ) : null,
            },
          ]}
          rows={facilities}
          empty="No credit facilities."
        />
        <div className="pad">
          <Form
            submitLabel="Request facility"
            inline
            fields={[
              {
                name: 'subjectType',
                label: 'Subject',
                type: 'select',
                options: [
                  { value: 'player', label: 'Player' },
                  { value: 'agent', label: 'Agent' },
                ],
              },
              { name: 'subjectId', label: 'Subject id', width: 'lg' },
              { name: 'limitMinor', label: 'Limit (minor)', type: 'number', placeholder: '100000', width: 'sm' },
              { name: 'policyRef', label: 'Policy reference', defaultValue: 'credit-policy-v1', width: 'md' },
            ]}
            onSubmit={async (values) => {
              await api('/credit/facilities', {
                method: 'POST',
                body: {
                  subjectType: values.subjectType,
                  subjectId: values.subjectId,
                  limitMinor: Number(values.limitMinor),
                  policyRef: values.policyRef,
                },
              });
              await load();
            }}
          />
        </div>
      </Panel>

      <Panel title="Credit operation" subtitle="Every movement is a ledger transaction with idempotency and audit.">
        <Form
          submitLabel="Post credit movement"
          fields={[
            { name: 'facilityId', label: 'Facility id', width: 'lg' },
            {
              name: 'action',
              label: 'Action',
              type: 'select',
              options: [
                { value: 'draw', label: 'Draw' },
                { value: 'repay', label: 'Repay' },
              ],
            },
            { name: 'amountMinor', label: 'Amount (minor)', type: 'number', width: 'sm' },
            { name: 'reason', label: 'Reason', width: 'lg' },
          ]}
          onSubmit={async (values) => {
            const facilityId = values.facilityId;
            if (values.action === 'draw') {
              await api(`/credit/facilities/${facilityId}/draw`, {
                method: 'POST',
                body: { amountMinor: Number(values.amountMinor), reason: values.reason || 'operator draw' },
              });
            } else {
              await api(`/credit/facilities/${facilityId}/repay`, {
                method: 'POST',
                body: { amountMinor: Number(values.amountMinor), reason: values.reason || 'repayment' },
              });
            }
            await load();
          }}
        />
      </Panel>
    </>
  );
}
