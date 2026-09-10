'use client';

import { useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { api, ApiError } from '@/lib/api-client.ts';
import { Icon } from '@/ui/icons.tsx';

/**
 * One feature flag, as a card with its own toggle.
 *
 * Flipping the switch does not fire a request — it only reveals a form. Every
 * flag change is a written decision (a `reason` the audit log will carry
 * forever), never a silent click, so the switch is a draft of the next state
 * and «Сохранить» is the only thing that actually calls the API.
 *
 * A flag with `requires_legal_approval` additionally refuses to turn ON
 * without a `legalApprovalReference` — the backend enforces this (DEC-015,
 * the rewards/lottery gate) and would 400 without it, so the field appears
 * the moment it would be required rather than always, with one line saying
 * why it's there.
 */

export interface FeatureFlag {
  key: string;
  enabled: boolean;
  description: string | null;
  requires_legal_approval: boolean;
  updated_at: string | null;
}

export function FeatureFlagRow({
  flag,
  onChange,
}: {
  flag: FeatureFlag;
  onChange: (next: FeatureFlag) => void;
}) {
  const t = useTranslations('StaffFeatureFlags');
  const locale = useLocale();
  const [pending, setPending] = useState(flag.enabled);
  const [reason, setReason] = useState('');
  const [legalRef, setLegalRef] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [justSaved, setJustSaved] = useState(false);

  const dirty = pending !== flag.enabled;
  const needsLegal = pending && flag.requires_legal_approval;
  const reasonOk = reason.trim().length >= 3;
  const legalOk = !needsLegal || legalRef.trim().length > 0;
  const canSave = dirty && reasonOk && legalOk && !saving;

  const dateFormat = new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' });

  function handleToggle(next: boolean) {
    setPending(next);
    setError(null);
    setJustSaved(false);
  }

  function cancel() {
    setPending(flag.enabled);
    setReason('');
    setLegalRef('');
    setError(null);
  }

  async function save() {
    if (!canSave) return;
    setSaving(true);
    setError(null);
    try {
      await api.put(`/admin/feature-flags/${flag.key}`, {
        enabled: pending,
        reason: reason.trim(),
        ...(needsLegal ? { legalApprovalReference: legalRef.trim() } : {}),
      });
      onChange({ ...flag, enabled: pending, updated_at: new Date().toISOString() });
      setReason('');
      setLegalRef('');
      setJustSaved(true);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : t('saveError'));
    } finally {
      setSaving(false);
    }
  }

  return (
    <li className="ffr card">
      <div className="ffr__top">
        <label className="ffr__switch">
          <input
            type="checkbox"
            checked={pending}
            disabled={saving}
            aria-label={t('toggleAria', { key: flag.key, state: pending ? t('stateOn') : t('stateOff') })}
            onChange={(e) => handleToggle(e.target.checked)}
          />
          <span className="ffr__slider" aria-hidden="true" />
        </label>

        <div className="ffr__id">
          <code className="ffr__key">{flag.key}</code>
          <span className={pending ? 'badge badge-verified' : 'badge badge-solid-neutral'}>
            {pending ? t('stateOn') : t('stateOff')}
          </span>
          {flag.requires_legal_approval && (
            <span className="badge badge-warning" title={t('legalHint')}>
              <Icon name="shieldCheck" size={13} />
              {t('legalRequired')}
            </span>
          )}
        </div>
      </div>

      <p className="ffr__desc">{flag.description || t('noDescription')}</p>
      <p className="ffr__meta">
        {flag.updated_at ? t('updatedAt', { date: dateFormat.format(new Date(flag.updated_at)) }) : t('neverUpdated')}
      </p>

      {dirty && (
        <form
          className="ffr__form"
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          {error && (
            <p className="ffr__error" role="alert">
              <Icon name="alert" size={15} />
              {error}
            </p>
          )}

          <label className="field">
            <span className="label">{t('reasonLabel')}</span>
            <textarea
              className="textarea"
              rows={2}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder={t('reasonPlaceholder')}
              minLength={3}
              maxLength={500}
            />
            <span className="hint">{t('reasonHint')}</span>
          </label>

          {needsLegal && (
            <label className="field">
              <span className="label">{t('legalLabel')}</span>
              <input
                className="input"
                value={legalRef}
                onChange={(e) => setLegalRef(e.target.value)}
                placeholder={t('legalPlaceholder')}
                maxLength={300}
              />
              <span className="hint">{t('legalHint')}</span>
            </label>
          )}

          <div className="ffr__actions">
            <button type="submit" className="btn btn-primary btn-sm" disabled={!canSave}>
              {saving ? t('saving') : t('save')}
            </button>
            <button type="button" className="btn btn-ghost btn-sm" onClick={cancel} disabled={saving}>
              {t('cancel')}
            </button>
          </div>
        </form>
      )}

      {justSaved && !dirty && (
        <p className="ffr__saved">
          <Icon name="checkCircle" size={15} />
          {t('saved')}
        </p>
      )}

      <style>{`
        .ffr { display: grid; gap: 0.4rem; padding: var(--space-4); }

        .ffr__top { display: flex; align-items: center; gap: var(--space-3); flex-wrap: wrap; }

        .ffr__switch { position: relative; display: inline-flex; flex: 0 0 auto; width: 2.75rem; height: 1.5rem; }
        .ffr__switch input { position: absolute; inset: 0; margin: 0; opacity: 0; cursor: pointer; z-index: 1; }
        .ffr__switch input:disabled { cursor: not-allowed; }
        .ffr__slider {
          position: absolute; inset: 0;
          background: var(--surface-sunken); border: 1px solid var(--border);
          border-radius: var(--radius-full);
          transition: background 160ms ease, border-color 160ms ease;
        }
        .ffr__slider::before {
          content: ''; position: absolute; top: 0.1rem; left: 0.1rem;
          width: 1.1rem; height: 1.1rem; border-radius: 50%;
          background: var(--surface); box-shadow: var(--shadow-raised);
          transition: transform 160ms ease;
        }
        .ffr__switch input:checked + .ffr__slider { background: var(--primary); border-color: var(--primary); }
        .ffr__switch input:checked + .ffr__slider::before { transform: translateX(1.25rem); background: #fff; }
        .ffr__switch input:disabled + .ffr__slider { opacity: 0.5; }
        .ffr__switch input:focus-visible + .ffr__slider { outline: 2px solid var(--primary); outline-offset: 2px; }

        .ffr__id { display: flex; align-items: center; gap: var(--space-2); flex-wrap: wrap; min-width: 0; }
        .ffr__key { font-family: ui-monospace, monospace; font-size: var(--text-sm); font-weight: 600; overflow-wrap: anywhere; }

        .ffr__desc { font-size: var(--text-sm); color: var(--text-secondary); line-height: 1.5; }
        .ffr__meta { font-size: var(--text-2xs); color: var(--text-tertiary); }

        .ffr__form { display: grid; gap: var(--space-3); padding-top: var(--space-3); margin-top: 0.2rem; border-top: 1px solid var(--border); }
        .ffr__error { display: flex; align-items: center; gap: 0.4rem; font-size: var(--text-sm); color: var(--error); }
        .ffr__error > svg { flex: 0 0 auto; }
        .ffr__actions { display: flex; gap: var(--space-2); flex-wrap: wrap; }

        .ffr__saved { display: flex; align-items: center; gap: 0.4rem; font-size: var(--text-xs); color: var(--success); }

        @media (max-width: 520px) {
          .ffr__actions > * { flex: 1 1 auto; }
        }
      `}</style>
    </li>
  );
}
