'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { api, ApiError } from '@/lib/api-client.ts';
import { Icon } from '@/ui/icons.tsx';
import {
  BASIS_EXPECTED_DOCUMENT,
  OWNERSHIP_BASES,
  OWNERSHIP_BASIS_LABEL,
  type OwnershipBasis,
} from '@/server/domain/verification.ts';

/**
 * Asking to be verified.
 *
 * Two things worth stating about this form.
 *
 * It is honest about the stop. Identity-document collection is switched off
 * pending a legal answer (LEGAL-004), and rather than accept a request that
 * will sit unmoved forever, the form says so and still lets the person register
 * interest — with the consequence spelled out, not implied.
 *
 * It never asks twice. Resubmission after a refusal carries `supersedesId`, and
 * the server keeps the previous answers on the new request, so nobody retypes
 * an application because one photo was blurred.
 */

export function VerificationRequestForm({
  targetLevel,
  properties,
  collectionEnabled,
  supersedesId,
  prefill,
}: {
  targetLevel: 1 | 2;
  properties: readonly { id: string; title: string; city: string; verified: boolean }[];
  collectionEnabled: boolean;
  supersedesId?: string;
  prefill?: { ownershipBasis?: OwnershipBasis; note?: string };
}) {
  const router = useRouter();
  const [propertyId, setPropertyId] = useState(properties.find((p) => !p.verified)?.id ?? '');
  const [basis, setBasis] = useState<OwnershipBasis | ''>(prefill?.ownershipBasis ?? '');
  const [note, setNote] = useState(prefill?.note ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const needsProperty = targetLevel === 2;
  const canSubmit = !needsProperty || (propertyId !== '' && basis !== '');

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!canSubmit || busy) return;
    setBusy(true);
    setError(null);
    try {
      await api.post(
        '/me/verification',
        {
          targetLevel,
          ...(needsProperty ? { propertyId } : {}),
          ...(basis ? { ownershipBasis: basis } : {}),
          ...(note.trim() ? { note: note.trim() } : {}),
          ...(supersedesId ? { supersedesId } : {}),
        },
        { idempotencyKey: `verification:${targetLevel}:${propertyId || 'self'}` },
      );
      router.refresh();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Не удалось отправить заявку');
      setBusy(false);
    }
  }

  return (
    <form className="vrf" onSubmit={submit}>
      {!collectionEnabled && (
        <p className="vrf__stop">
          <Icon name="info" size={16} />
          <span>
            Приём документов пока не открыт: платформа не начнёт собирать документы, удостоверяющие
            личность, до юридического заключения. Заявку можно оставить — мы сообщим, когда проверка
            станет доступна, и до тех пор уровень не выдаётся никому.
          </span>
        </p>
      )}

      {needsProperty && (
        <>
          <label className="field">
            <span className="label">Какое жильё</span>
            <select
              className="select"
              value={propertyId}
              onChange={(e) => setPropertyId(e.target.value)}
              required
            >
              <option value="">Выберите объявление</option>
              {properties.map((p) => (
                <option key={p.id} value={p.id} disabled={p.verified}>
                  {p.title} · {p.city}
                  {p.verified ? ' (уже проверено)' : ''}
                </option>
              ))}
            </select>
            {properties.length === 0 && (
              <span className="hint">
                Сначала создайте объявление — право сдачи подтверждается для конкретного жилья.
              </span>
            )}
          </label>

          <fieldset className="vrf__basis">
            <legend className="label">На каком основании вы сдаёте это жильё</legend>
            <div className="vrf__options">
              {OWNERSHIP_BASES.map((b) => (
                <button
                  key={b}
                  type="button"
                  className="vrf__option"
                  aria-pressed={basis === b}
                  onClick={() => setBasis(basis === b ? '' : b)}
                >
                  <strong>{OWNERSHIP_BASIS_LABEL[b]}</strong>
                  <span>{BASIS_EXPECTED_DOCUMENT[b]}</span>
                </button>
              ))}
            </div>
            <span className="hint">
              От основания зависит, какой документ мы попросим. Само основание — это ваше заявление,
              а не подтверждение: документ всё равно понадобится.
            </span>
          </fieldset>
        </>
      )}

      <label className="field">
        <span className="label">Что нам полезно знать — по желанию</span>
        <textarea
          className="textarea"
          rows={3}
          maxLength={1000}
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder={
            needsProperty
              ? 'Например: собственность оформлена на девичью фамилию.'
              : 'Например: в паспорте другое написание имени.'
          }
        />
        <span className="hint">
          Не пишите здесь номер документа — он не нужен, и в заявке ему не место.
        </span>
      </label>

      {error && (
        <p className="error-text" role="alert">
          <Icon name="alert" size={15} />
          {error}
        </p>
      )}

      <button type="submit" className="btn btn-primary" disabled={!canSubmit || busy}>
        {busy ? 'Отправляем…' : supersedesId ? 'Отправить заново' : 'Отправить заявку'}
      </button>

      <style>{`
        .vrf { display: grid; gap: var(--space-4); max-width: 34rem; }
        .vrf__stop {
          display: flex; align-items: flex-start; gap: 0.5rem;
          padding: var(--space-3) var(--space-4);
          background: var(--primary-soft); border-radius: var(--radius-sm);
          font-size: var(--text-xs); line-height: 1.55; color: var(--text-secondary);
        }
        .vrf__stop > svg { color: var(--primary); flex: 0 0 auto; margin-top: 0.1rem; }
        .vrf__basis { border: none; margin: 0; padding: 0; display: grid; gap: var(--space-2); }
        .vrf__options { display: grid; gap: var(--space-2); }
        .vrf__option {
          display: grid; gap: 0.15rem; text-align: left;
          padding: var(--space-3); min-height: 3rem;
          background: var(--surface); border: 1px solid var(--border);
          border-radius: var(--radius-sm); cursor: pointer;
        }
        .vrf__option:hover { border-color: var(--border-control); }
        .vrf__option[aria-pressed='true'] { border-color: var(--primary); background: var(--primary-soft); }
        .vrf__option strong { font-size: var(--text-sm); }
        .vrf__option span { font-size: var(--text-2xs); color: var(--text-secondary); }
        .vrf .error-text { display: flex; align-items: center; gap: 0.35rem; }
        .vrf > .btn { justify-self: start; }
        @media (max-width: 480px) { .vrf > .btn { width: 100%; } }
      `}</style>
    </form>
  );
}
