import { useState, type FormEvent, type ReactNode } from 'react';
import { ApiClientError } from './api';

export type Row = Record<string, any>;

export function Panel(props: { title: string; subtitle?: string; actions?: ReactNode; children: ReactNode }) {
  return (
    <section className="panel">
      <header className="panel-head">
        <div>
          <h2>{props.title}</h2>
          {props.subtitle ? <p className="muted small">{props.subtitle}</p> : null}
        </div>
        {props.actions ? <div className="row gap">{props.actions}</div> : null}
      </header>
      {props.children}
    </section>
  );
}

export function Stat(props: { label: string; value: ReactNode; hint?: string; tone?: 'gold' | 'green' | 'red' }) {
  return (
    <div className={`stat ${props.tone ?? ''}`}>
      <span className="stat-label">{props.label}</span>
      <strong className="stat-value">{props.value}</strong>
      {props.hint ? <span className="stat-hint">{props.hint}</span> : null}
    </div>
  );
}

export function Badge(props: { children: ReactNode; tone?: 'neutral' | 'good' | 'warn' | 'bad' | 'info' }) {
  return <span className={`badge ${props.tone ?? 'neutral'}`}>{props.children}</span>;
}

export function statusTone(status: string): 'neutral' | 'good' | 'warn' | 'bad' | 'info' {
  const good = ['active', 'paid', 'captured', 'verified', 'confirmed', 'reconciled', 'won', 'approved', 'posted', 'open'];
  const warn = ['pending', 'pending_approval', 'draft', 'claimed', 'pending_verification', 'requested', 'initiated', 'authorized'];
  const bad = ['rejected', 'failed', 'suspended', 'revoked', 'expired', 'terminated', 'disputed', 'lost', 'closed', 'self_excluded', 'reversed'];
  if (good.includes(status)) return 'good';
  if (warn.includes(status)) return 'warn';
  if (bad.includes(status)) return 'bad';
  return 'neutral';
}

export function Button(props: {
  children: ReactNode;
  variant?: 'primary' | 'ghost' | 'danger' | 'subtle';
  type?: 'button' | 'submit';
  disabled?: boolean;
  onClick?: () => void;
}) {
  return (
    <button
      className={`btn ${props.variant ?? 'subtle'}`}
      type={props.type ?? 'button'}
      disabled={props.disabled}
      onClick={props.onClick}
    >
      {props.children}
    </button>
  );
}

export interface Column<T> {
  key: string;
  label: string;
  render?: (row: T) => ReactNode;
  align?: 'right' | 'left';
}

export function Table<T extends Record<string, unknown>>(props: {
  columns: Column<T>[];
  rows: T[];
  empty?: string;
  actions?: (row: T) => ReactNode;
}) {
  if (!props.rows.length) return <p className="empty">{props.empty ?? 'No records yet.'}</p>;
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            {props.columns.map((col) => (
              <th key={col.key} className={col.align === 'right' ? 'right' : undefined}>
                {col.label}
              </th>
            ))}
            {props.actions ? <th className="right">Actions</th> : null}
          </tr>
        </thead>
        <tbody>
          {props.rows.map((row, index) => (
            <tr key={String(row.id ?? index)}>
              {props.columns.map((col) => (
                <td key={col.key} className={col.align === 'right' ? 'right mono' : undefined}>
                  {col.render ? col.render(row) : String(row[col.key] ?? '—')}
                </td>
              ))}
              {props.actions ? <td className="right actions-cell">{props.actions(row)}</td> : null}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export interface Field {
  name: string;
  label: string;
  type?: 'text' | 'number' | 'password' | 'select' | 'date';
  placeholder?: string;
  defaultValue?: string | number;
  options?: { value: string; label: string }[];
  required?: boolean;
  width?: 'sm' | 'md' | 'lg';
}

export function Form(props: {
  fields: Field[];
  submitLabel: string;
  onSubmit: (values: Record<string, string>) => Promise<unknown>;
  onDone?: () => void;
  inline?: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const values: Record<string, string> = {};
    for (const field of props.fields) values[field.name] = String(data.get(field.name) ?? '');
    setBusy(true);
    setError(null);
    setDone(false);
    try {
      await props.onSubmit(values);
      setDone(true);
      form.reset();
      props.onDone?.();
      setTimeout(() => setDone(false), 2500);
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : 'Request failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className={`form ${props.inline ? 'inline' : ''}`} onSubmit={submit}>
      {props.fields.map((field) => (
        <label key={field.name} className={`field ${field.width ?? 'md'}`}>
          <span>{field.label}</span>
          {field.type === 'select' ? (
            <select name={field.name} defaultValue={field.defaultValue} required={field.required}>
              {(field.options ?? []).map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          ) : (
            <input
              name={field.name}
              type={field.type ?? 'text'}
              placeholder={field.placeholder}
              defaultValue={field.defaultValue}
              required={field.required}
            />
          )}
        </label>
      ))}
      <Button type="submit" variant="primary" disabled={busy}>
        {busy ? 'Working…' : props.submitLabel}
      </Button>
      {error ? <p className="form-error">{error}</p> : null}
      {done ? <p className="form-ok">Done</p> : null}
    </form>
  );
}

export function ErrorNote(props: { error: unknown }) {
  if (!props.error) return null;
  const message = props.error instanceof Error ? props.error.message : String(props.error);
  return <p className="form-error">{message}</p>;
}
