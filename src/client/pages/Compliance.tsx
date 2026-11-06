import { useCallback, useEffect, useState } from 'react';
import { api, can, when, type Session } from '../api';
import { Badge, Button, ErrorNote, Form, Panel, Table, statusTone, type Row } from '../ui';

export default function Compliance({ session }: { session: Session }) {
  const [jurisdictions, setJurisdictions] = useState<Row[]>([]);
  const [licences, setLicences] = useState<Row[]>([]);
  const [approvals, setApprovals] = useState<Row[]>([]);
  const [entries, setEntries] = useState<Row[]>([]);
  const [error, setError] = useState<unknown>(null);

  const load = useCallback(async () => {
    try {
      const [jurisdictionData, licenceData, approvalData, auditData] = await Promise.all([
        api<{ jurisdictions: Row[] }>('/compliance/jurisdictions'),
        api<{ licences: Row[] }>('/compliance/licences'),
        can(session, 'audit:read') ? api<{ approvals: Row[] }>('/approvals') : Promise.resolve({ approvals: [] }),
        can(session, 'audit:read') ? api<{ entries: Row[] }>('/audit') : Promise.resolve({ entries: [] }),
      ]);
      setJurisdictions(jurisdictionData.jurisdictions);
      setLicences(licenceData.licences);
      setApprovals(approvalData.approvals);
      setEntries(auditData.entries);
      setError(null);
    } catch (err) {
      setError(err);
    }
  }, [session]);

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

  const canCompliance = can(session, 'compliance:write');

  return (
    <>
      {error ? (
        <Panel title="Action failed">
          <div className="pad"><ErrorNote error={error} /></div>
        </Panel>
      ) : null}

      <Panel
        title="Jurisdiction profiles"
        subtitle="Fail-closed: unknown, prohibited or unassessed profiles deny regulated money activity."
      >
        <Table
          columns={[
            {
              key: 'code',
              label: 'Code',
              render: (row) => (
                <div className="stack">
                  <strong>{String(row.code)}</strong>
                  <span className="muted small">{String(row.name)}</span>
                </div>
              ),
            },
            {
              key: 'money_gaming',
              label: 'Money gaming',
              render: (row) => (
                <Badge
                  tone={
                    row.money_gaming === 'prohibited'
                      ? 'bad'
                      : row.money_gaming === 'permitted_with_licence'
                        ? 'good'
                        : 'warn'
                  }
                >
                  {String(row.money_gaming)}
                </Badge>
              ),
            },
            { key: 'affiliate_payout', label: 'Affiliate payout' },
            { key: 'credit', label: 'Credit' },
            { key: 'authority', label: 'Authority', render: (row) => String(row.authority ?? '—') },
            { key: 'legal_basis', label: 'Legal basis', render: (row) => <span className="small muted">{String(row.legal_basis ?? '—')}</span> },
          ]}
          rows={jurisdictions}
          empty="No jurisdiction profiles."
        />
        <p className="pad muted small">
          Authorization is enforced in code, not configuration. A feature flag cannot bypass a prohibited
          profile; a licence claim is not authorization until compliance verifies evidence.
        </p>
      </Panel>

      <Panel title="Licences" subtitle="Active + verified + in-date + activity coverage is required for each regulated action.">
        <Table
          columns={[
            { key: 'licence_number', label: 'Licence', render: (row) => <span className="mono">{String(row.licence_number)}</span> },
            { key: 'jurisdiction_code', label: 'Jur.' },
            { key: 'authority', label: 'Authority' },
            {
              key: 'status',
              label: 'Status',
              render: (row) => <Badge tone={statusTone(String(row.status))}>{String(row.status)}</Badge>,
            },
            { key: 'valid_to', label: 'Valid to', render: (row) => when(row.valid_to as number) },
            {
              key: 'verified_at',
              label: 'Verified',
              render: (row) => (row.verified_at ? <Badge tone="good">verified</Badge> : <Badge tone="warn">unverified</Badge>),
            },
            { key: 'evidence_ref', label: 'Evidence', render: (row) => <span className="mono small">{String(row.evidence_ref ?? '—')}</span> },
          ]}
          rows={licences}
          empty="No licences on file. All regulated money actions are denied."
        />
        {canCompliance ? (
          <div className="pad">
            <Form
              submitLabel="Verify licence"
              inline
              fields={[
                { name: 'licenceId', label: 'Licence id', width: 'lg' },
                { name: 'evidenceRef', label: 'Evidence reference', width: 'lg' },
              ]}
              onSubmit={async (values) => {
                await api(`/compliance/licences/${values.licenceId}/verify`, {
                  method: 'POST',
                  body: { evidenceRef: values.evidenceRef },
                });
                await load();
              }}
            />
            <Form
              submitLabel="Register licence"
              inline
              fields={[
                { name: 'jurisdictionCode', label: 'Jurisdiction', width: 'sm' },
                { name: 'authority', label: 'Authority', width: 'lg' },
                { name: 'licenceNumber', label: 'Number', width: 'md' },
                { name: 'validFrom', label: 'From', type: 'date', width: 'md' },
                { name: 'validTo', label: 'To', type: 'date', width: 'md' },
                { name: 'evidenceRef', label: 'Evidence ref', width: 'md' },
              ]}
              onSubmit={async (values) => {
                await api('/compliance/licences', {
                  method: 'POST',
                  body: {
                    jurisdictionCode: values.jurisdictionCode.toUpperCase(),
                    authority: values.authority,
                    licenceNumber: values.licenceNumber,
                    validFrom: new Date(`${values.validFrom}T00:00:00Z`).getTime(),
                    validTo: new Date(`${values.validTo}T23:59:59Z`).getTime(),
                    activities: ['deposit', 'withdrawal', 'wager', 'redemption', 'credit', 'affiliate_payout', 'settlement'],
                    gameCategories: ['casino'],
                    evidenceRef: values.evidenceRef,
                  },
                });
                await load();
              }}
            />
          </div>
        ) : null}
      </Panel>

      <Panel title="Approval queue" subtitle="Segregation of duties: a requester cannot decide their own request.">
        <Table
          columns={[
            { key: 'action', label: 'Action' },
            { key: 'subject_type', label: 'Subject' },
            { key: 'subject_id', label: 'Subject id', render: (row) => <span className="mono small">{String(row.subject_id)}</span> },
            { key: 'amount_minor', label: 'Amount', align: 'right', render: (row) => (row.amount_minor ? String(row.amount_minor) : '—') },
            {
              key: 'status',
              label: 'Status',
              render: (row) => <Badge tone={statusTone(String(row.status))}>{String(row.status)}</Badge>,
            },
            { key: 'required_permission', label: 'Requires', render: (row) => <span className="mono small">{String(row.required_permission)}</span> },
            {
              key: 'actions',
              label: 'Actions',
              render: (row) =>
                row.status === 'pending' ? (
                  <div className="row gap">
                    <Button onClick={() => void act(() => api(`/approvals/${row.id}/decide`, { method: 'POST', body: { approve: true } }))}>
                      Approve
                    </Button>
                    <Button variant="danger" onClick={() => void act(() => api(`/approvals/${row.id}/decide`, { method: 'POST', body: { approve: false } }))}>
                      Reject
                    </Button>
                  </div>
                ) : null,
            },
          ]}
          rows={approvals}
          empty="No approval requests."
        />
      </Panel>

      <Panel title="Audit trail" subtitle="Append-only record of every privileged mutation.">
        <Table
          columns={[
            { key: 'action', label: 'Action', render: (row) => <span className="mono">{String(row.action)}</span> },
            { key: 'subject_id', label: 'Subject', render: (row) => <span className="mono small">{String(row.subject_id ?? '—')}</span> },
            { key: 'actor_id', label: 'Actor', render: (row) => <span className="mono small">{String(row.actor_id ?? 'system')}</span> },
            { key: 'meta_json', label: 'Detail', render: (row) => <span className="small muted">{String(row.meta_json)}</span> },
            { key: 'created_at', label: 'When', render: (row) => when(row.created_at as number) },
          ]}
          rows={entries}
          empty="No audit entries."
        />
      </Panel>
    </>
  );
}
