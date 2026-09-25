'use client';

import { useCallback, useEffect, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { api, ApiError } from '@/lib/api-client.ts';
import { Icon } from '@/ui/icons.tsx';
import { EmptyState } from '@/ui/primitives.tsx';

/**
 * The audit log console.
 *
 * `changes` on a row is whatever the writer passed `writeAudit()` — in
 * practice almost always `{ field: { from, to } }`, but nothing here enforces
 * that shape at the database boundary. `renderChanges` reads it structurally
 * and only trusts the compact "field: from → to" rendering when every value
 * actually looks like a diff; anything else falls back to a raw JSON dump
 * rather than crashing on a row this screen didn't anticipate.
 *
 * Filters live in component state, not the URL — re-fetched on submit,
 * exactly as asked — with two structural shortcuts (a row's actor or target
 * can be clicked to filter by it) since a log this size is mostly read by
 * following one thread at a time.
 */

export interface AuditEntry {
  id: string;
  occurred_at: string;
  actor_user_id: string | null;
  actor_role: string | null;
  action: string;
  target_type: string;
  target_id: string;
  changes: unknown;
  reason: string | null;
  correlation_id: string | null;
  source: string | null;
}

interface Filters {
  targetType: string;
  targetId: string;
  actorId: string;
  limit: string;
}

const DEFAULT_FILTERS: Filters = { targetType: '', targetId: '', actorId: '', limit: '100' };
const LIMIT_OPTIONS = [25, 50, 100, 200];

function isDiffShape(changes: unknown): changes is Record<string, { from: unknown; to: unknown }> {
  if (!changes || typeof changes !== 'object' || Array.isArray(changes)) return false;
  const entries = Object.entries(changes as Record<string, unknown>);
  if (entries.length === 0) return false;
  return entries.every(
    ([, v]) => v !== null && typeof v === 'object' && !Array.isArray(v) && 'from' in (v as object) && 'to' in (v as object),
  );
}

export function AuditLog() {
  const t = useTranslations('StaffAudit');
  const locale = useLocale();
  const [filters, setFilters] = useState<Filters>(DEFAULT_FILTERS);
  const [draft, setDraft] = useState<Filters>(DEFAULT_FILTERS);
  const [entries, setEntries] = useState<AuditEntry[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const dateFormat = new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'medium' });

  const load = useCallback(
    async (f: Filters) => {
      setLoading(true);
      setError(null);
      try {
        const params = new URLSearchParams();
        if (f.targetType.trim()) params.set('targetType', f.targetType.trim());
        if (f.targetId.trim()) params.set('targetId', f.targetId.trim());
        if (f.actorId.trim()) params.set('actorId', f.actorId.trim());
        if (f.limit) params.set('limit', f.limit);
        const qs = params.toString();
        const rows = await api.get<AuditEntry[]>(`/admin/audit${qs ? `?${qs}` : ''}`);
        setEntries(rows);
      } catch (e) {
        setError(e instanceof ApiError ? e.message : t('loadError'));
      } finally {
        setLoading(false);
      }
    },
    [t],
  );

  useEffect(() => {
    void load(DEFAULT_FILTERS);
    // Only ever runs once on mount — subsequent loads come from `apply`.
  }, []);

  function apply(next: Filters) {
    setFilters(next);
    setDraft(next);
    void load(next);
  }

  function reset() {
    apply(DEFAULT_FILTERS);
  }

  function stringifyValue(v: unknown): string {
    if (v === null || v === undefined || v === '') return t('valueEmpty');
    if (typeof v === 'boolean') return v ? t('valueTrue') : t('valueFalse');
    if (typeof v === 'object') return JSON.stringify(v);
    return String(v);
  }

  function renderChanges(changes: unknown) {
    if (changes == null || (typeof changes === 'object' && Object.keys(changes as object).length === 0)) {
      return <span className="al__muted">{t('noChanges')}</span>;
    }
    if (isDiffShape(changes)) {
      return (
        <ul className="al__diff">
          {Object.entries(changes).map(([field, v]) => (
            <li key={field}>
              <span className="al__diffField">{field}</span>
              <span className="al__diffValue">{stringifyValue(v.from)}</span>
              <Icon name="arrowRight" size={12} />
              <span className="al__diffValue">{stringifyValue(v.to)}</span>
            </li>
          ))}
        </ul>
      );
    }
    return <code className="al__raw">{JSON.stringify(changes)}</code>;
  }

  return (
    <div className="al">
      <form
        className="al__filters"
        onSubmit={(e) => {
          e.preventDefault();
          apply(draft);
        }}
      >
        <label className="field al__f">
          <span className="label">{t('filterTargetType')}</span>
          <input
            className="input"
            value={draft.targetType}
            onChange={(e) => setDraft((d) => ({ ...d, targetType: e.target.value }))}
            placeholder={t('filterTargetTypePlaceholder')}
          />
        </label>
        <label className="field al__f">
          <span className="label">{t('filterTargetId')}</span>
          <input className="input" value={draft.targetId} onChange={(e) => setDraft((d) => ({ ...d, targetId: e.target.value }))} />
        </label>
        <label className="field al__f">
          <span className="label">{t('filterActorId')}</span>
          <input className="input" value={draft.actorId} onChange={(e) => setDraft((d) => ({ ...d, actorId: e.target.value }))} />
        </label>
        <label className="field al__f al__f--limit">
          <span className="label">{t('filterLimit')}</span>
          <select className="select" value={draft.limit} onChange={(e) => setDraft((d) => ({ ...d, limit: e.target.value }))}>
            {LIMIT_OPTIONS.map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </label>
        <div className="al__filterActions">
          <button type="submit" className="btn btn-primary btn-sm">
            {t('apply')}
          </button>
          <button type="button" className="btn btn-ghost btn-sm" onClick={reset}>
            {t('reset')}
          </button>
        </div>
      </form>

      {loading && entries === null && <p className="al__loading">{t('loading')}</p>}

      {!loading && error && entries === null && (
        <div className="al__error" role="alert">
          <Icon name="alert" size={18} />
          <p>{error}</p>
          <button type="button" className="btn btn-secondary btn-sm" onClick={() => void load(filters)}>
            {t('retry')}
          </button>
        </div>
      )}

      {entries && entries.length === 0 && <EmptyState title={t('empty')} description={t('emptyHint')} />}

      {entries && entries.length > 0 && (
        <>
          <p className="al__count numeric">{t('resultCount', { count: entries.length })}</p>
          <div className="al__scroll">
            <table className="al__table">
              <thead>
                <tr>
                  <th scope="col">{t('columnTime')}</th>
                  <th scope="col">{t('columnActor')}</th>
                  <th scope="col">{t('columnAction')}</th>
                  <th scope="col">{t('columnTarget')}</th>
                  <th scope="col">{t('columnChanges')}</th>
                  <th scope="col">{t('columnReason')}</th>
                  <th scope="col">{t('columnSource')}</th>
                </tr>
              </thead>
              <tbody>
                {entries.map((entry) => (
                  <tr key={entry.id}>
                    <td className="al__time numeric">{dateFormat.format(new Date(entry.occurred_at))}</td>
                    <td className="al__actor">
                      {entry.actor_user_id ? (
                        <>
                          <button
                            type="button"
                            className="al__filterBtn"
                            title={t('filterByThis')}
                            onClick={() => apply({ ...filters, actorId: entry.actor_user_id! })}
                          >
                            {entry.actor_user_id}
                          </button>
                          {entry.actor_role && <span className="badge badge-solid-neutral al__roleBadge">{entry.actor_role}</span>}
                        </>
                      ) : (
                        <span className="al__muted">{t('systemActor')}</span>
                      )}
                    </td>
                    <td>
                      <code className="al__action">{entry.action}</code>
                    </td>
                    <td>
                      <button
                        type="button"
                        className="al__filterBtn"
                        title={t('filterByThis')}
                        onClick={() => apply({ ...filters, targetType: entry.target_type, targetId: entry.target_id })}
                      >
                        {entry.target_type}/{entry.target_id}
                      </button>
                    </td>
                    <td className="al__changesCell">{renderChanges(entry.changes)}</td>
                    <td className="al__reason">{entry.reason || <span className="al__muted">{t('noReason')}</span>}</td>
                    <td className="al__source">
                      {entry.source || '—'}
                      {entry.correlation_id && (
                        <span className="al__correlation">
                          {t('correlation')}: <code>{entry.correlation_id}</code>
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      <style>{`
        .al__filters { display: flex; gap: var(--space-2); flex-wrap: wrap; align-items: flex-end; margin-bottom: var(--space-4); }
        .al__f { flex: 1 1 11rem; min-width: 9rem; }
        .al__f--limit { flex: 0 1 7rem; min-width: 6rem; }
        .al__filterActions { display: flex; gap: var(--space-2); flex: 0 0 auto; }

        .al__loading { font-size: var(--text-sm); color: var(--text-secondary); padding: var(--space-8) 0; text-align: center; }
        .al__error {
          display: grid; justify-items: center; gap: var(--space-2);
          padding: var(--space-8) var(--space-4); text-align: center; color: var(--error);
        }
        .al__error > svg { color: var(--error); }
        .al__error > p { font-size: var(--text-sm); max-width: 42ch; }

        .al__count { font-size: var(--text-xs); color: var(--text-tertiary); margin-bottom: var(--space-2); }

        .al__scroll { overflow-x: auto; border: 1px solid var(--border); border-radius: var(--radius-md); }
        .al__table { width: 100%; border-collapse: collapse; font-size: var(--text-xs); }
        .al__table th, .al__table td { padding: var(--space-2) var(--space-3); text-align: left; vertical-align: top; }
        .al__table thead th {
          font-weight: 600; color: var(--text-secondary); border-bottom: 1px solid var(--border);
          white-space: nowrap; background: var(--surface-sunken);
        }
        .al__table tbody tr + tr td { border-top: 1px solid var(--border); }
        @media (hover: hover) and (pointer: fine) {
          .al__table tbody tr:hover td { background: var(--surface-sunken); }
        }

        .al__time { white-space: nowrap; color: var(--text-secondary); }
        .al__actor { white-space: nowrap; }
        .al__roleBadge { margin-left: 0.35rem; font-size: var(--text-2xs); }
        .al__action { font-family: ui-monospace, monospace; overflow-wrap: anywhere; }
        .al__muted { color: var(--text-tertiary); }

        .al__filterBtn {
          all: unset; cursor: pointer;
          font-family: ui-monospace, monospace; font-size: var(--text-xs);
          color: var(--text-secondary); overflow-wrap: anywhere;
        }
        @media (hover: hover) and (pointer: fine) {
          .al__filterBtn:hover { color: var(--primary); text-decoration: underline; }
        }
        .al__filterBtn:focus-visible { outline: 2px solid var(--primary); outline-offset: 2px; border-radius: 2px; }

        .al__changesCell { min-width: 16rem; }
        .al__diff { list-style: none; margin: 0; padding: 0; display: grid; gap: 0.2rem; }
        .al__diff li { display: flex; align-items: center; gap: 0.35rem; flex-wrap: wrap; line-height: 1.4; }
        .al__diffField { font-weight: 600; }
        .al__diffField::after { content: ':'; }
        .al__diffValue { color: var(--text-secondary); overflow-wrap: anywhere; }
        .al__diff li > svg { flex: 0 0 auto; color: var(--text-tertiary); }
        .al__raw { font-family: ui-monospace, monospace; overflow-wrap: anywhere; white-space: pre-wrap; color: var(--text-secondary); }

        .al__reason { max-width: 22ch; overflow-wrap: anywhere; }

        .al__source { white-space: nowrap; }
        .al__correlation { display: block; margin-top: 0.15rem; font-size: var(--text-2xs); color: var(--text-tertiary); }
        .al__correlation code { font-family: ui-monospace, monospace; overflow-wrap: anywhere; }
      `}</style>
    </div>
  );
}
