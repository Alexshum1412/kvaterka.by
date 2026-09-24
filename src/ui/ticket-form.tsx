'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { useRouter } from '@/i18n/navigation.ts';
import { api, ApiError } from '@/lib/api-client.ts';
import { Icon } from '@/ui/icons.tsx';
import { TICKET_CATEGORIES, type TicketCategory } from '@/server/domain/support-ticket.ts';

/**
 * FNV-1a, hex. Not a security hash — an ASCII-safe fingerprint of the text so
 * an idempotency key can depend on what was typed without putting what was
 * typed (almost always Cyrillic on this site) into a header: `fetch` throws
 * "String contains non ISO-8859-1 code point" if a header value isn't
 * Latin-1, which silently broke every submission before this existed.
 */
function asciiDigest(input: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

/**
 * The general "contact support" form (DEC-073).
 *
 * Same shape as `VerificationRequestForm`: a plain POST, an idempotency key
 * so a double-tap on a slow connection cannot file the same ticket twice,
 * and a client-side minimum on the summary that mirrors the server's own
 * (`TicketService.create`) so the person sees the rule before they hit
 * submit rather than only after.
 *
 * On success this navigates straight to the new ticket's own thread —
 * unlike most forms in this codebase that just `router.refresh()` in place,
 * because a ticket has somewhere to go: its own chat, where the first
 * message is the summary just typed here.
 */
export function TicketForm({ properties }: { properties: readonly { id: string; title: string }[] }) {
  const router = useRouter();
  const t = useTranslations('SupportTickets');
  const [category, setCategory] = useState<TicketCategory | ''>('');
  const [propertyId, setPropertyId] = useState('');
  const [summary, setSummary] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<{ id: string; reference: string } | null>(null);

  const canSubmit = category !== '' && summary.trim().length >= 10;

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!canSubmit || busy) return;
    setBusy(true);
    setError(null);
    try {
      const result = await api.post<{ id: string; reference: string }>(
        '/me/tickets',
        {
          category,
          ...(propertyId ? { propertyId } : {}),
          summary: summary.trim(),
        },
        {
          idempotencyKey: `ticket-create:${category}:${propertyId || 'none'}:${asciiDigest(summary.trim())}`,
        },
      );
      setSuccess(result);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : t('formError'));
    } finally {
      setBusy(false);
    }
  }

  if (success) {
    return (
      <div className="tf__success">
        <Icon name="checkCircle" size={22} />
        <div>
          <p className="title-sm">{t('formSuccessTitle')}</p>
          <p className="text-sm muted">{t('formSuccessBody', { reference: success.reference })}</p>
        </div>
        <button
          type="button"
          className="btn btn-primary btn-sm"
          onClick={() => router.push(`/dashboard/support/${success.id}`)}
        >
          {t('formSuccessLink')}
        </button>
      </div>
    );
  }

  return (
    <form className="tf" onSubmit={submit}>
      <label className="field">
        <span className="label">{t('formCategoryLabel')}</span>
        <select
          className="select"
          value={category}
          onChange={(e) => setCategory(e.target.value as TicketCategory)}
          required
        >
          <option value="">{t('formCategoryPlaceholder')}</option>
          {TICKET_CATEGORIES.map((c) => (
            <option key={c} value={c}>
              {t(`category_${c}`)}
            </option>
          ))}
        </select>
      </label>

      <label className="field">
        <span className="label">{t('formPropertyLabel')}</span>
        <select className="select" value={propertyId} onChange={(e) => setPropertyId(e.target.value)}>
          <option value="">{t('formPropertyNone')}</option>
          {properties.map((p) => (
            <option key={p.id} value={p.id}>
              {p.title.trim() || t('formPropertyUntitled')}
            </option>
          ))}
        </select>
        {properties.length === 0 && <span className="hint">{t('formPropertyEmpty')}</span>}
      </label>

      <label className="field">
        <span className="label">{t('formSummaryLabel')}</span>
        <textarea
          className="textarea"
          rows={5}
          maxLength={4000}
          value={summary}
          onChange={(e) => setSummary(e.target.value)}
          placeholder={t('formSummaryPlaceholder')}
          required
        />
        <span className="hint">{t('formSummaryHint')}</span>
      </label>

      {error && (
        <p className="error-text" role="alert">
          <Icon name="alert" size={15} />
          {error}
        </p>
      )}

      <button type="submit" className="btn btn-primary" disabled={!canSubmit || busy}>
        {busy ? t('formSubmitting') : t('formSubmit')}
      </button>

      <style>{`
        .tf { display: grid; gap: var(--space-4); max-width: 34rem; }
        .tf .error-text { display: flex; align-items: center; gap: 0.35rem; }
        .tf > .btn { justify-self: start; }

        .tf__success {
          display: grid; grid-template-columns: auto 1fr; gap: var(--space-3);
          align-items: start; max-width: 34rem;
          padding: var(--space-4); background: var(--success-soft); border-radius: var(--radius-md);
        }
        .tf__success > svg { color: var(--success); margin-top: 0.15rem; }
        .tf__success > .btn { grid-column: 2; justify-self: start; }

        @media (max-width: 480px) {
          .tf > .btn { width: 100%; }
          .tf__success { grid-template-columns: auto 1fr; }
          .tf__success > .btn { width: 100%; }
        }
      `}</style>
    </form>
  );
}
