'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { api, ApiError } from '@/lib/api-client.ts';
import { Icon } from '@/ui/icons.tsx';
import {
  MODERATION_REASON_CODES,
  MODERATION_REASON_SHORT,
  type ModerationReasonCode,
} from '@/server/domain/moderation.ts';

/**
 * The decision.
 *
 * Rejection is deliberately harder to do carelessly than approval: it
 * needs at least one structured reason before the button enables. That is
 * not friction for its own sake — the codes are what tell the landlord
 * what to fix and which wizard step to open, so a rejection without one
 * is a dead end for the person receiving it.
 *
 * Nothing is computed here. The service decides whether the transition is
 * legal, writes the history row and the audit record in one transaction,
 * and this component only reports what it said.
 */
export function ModerationDecision({
  propertyId,
  status,
}: {
  propertyId: string;
  status: string;
}) {
  const router = useRouter();
  const [mode, setMode] = useState<'none' | 'reject' | 'pause'>('none');
  const [codes, setCodes] = useState<ModerationReasonCode[]>([]);
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const canApprove = status === 'PENDING_MODERATION' || status === 'PAUSED';
  const canReject = status !== 'REJECTED';
  const canPause = status === 'PUBLISHED';

  async function decide(decision: 'PUBLISHED' | 'REJECTED' | 'PAUSED') {
    setBusy(true);
    setError(null);
    try {
      await api.post(`/admin/moderation/listings/${propertyId}`, {
        decision,
        ...(codes.length > 0 ? { reasonCodes: codes } : {}),
        ...(comment.trim() ? { reason: comment.trim() } : {}),
      });
      setDone(decision);
      // The queue counts and this listing's status both changed.
      router.refresh();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Не удалось сохранить решение');
    } finally {
      setBusy(false);
    }
  }

  function toggle(code: ModerationReasonCode) {
    setCodes((prev) => (prev.includes(code) ? prev.filter((c) => c !== code) : [...prev, code]));
  }

  if (done) {
    return (
      <div className="md__done" role="status">
        <Icon name="checkCircle" size={20} />
        <div>
          <strong>
            {done === 'PUBLISHED'
              ? 'Объявление опубликовано'
              : done === 'REJECTED'
                ? 'Объявление отклонено'
                : 'Объявление скрыто'}
          </strong>
          <p className="text-sm muted">
            {done === 'PUBLISHED'
              ? 'Оно уже доступно в поиске. Владелец получит уведомление.'
              : 'Владелец увидит причину и сможет вернуться к нужному шагу.'}
          </p>
        </div>
        <a href="/moderation" className="btn btn-secondary btn-sm">
          К очереди
        </a>
        <style>{`
          .md__done {
            display: flex; align-items: flex-start; gap: var(--space-3);
            padding: var(--space-4);
            background: var(--success-soft);
            border-radius: var(--radius-md);
          }
          .md__done > svg { color: var(--success); flex: 0 0 auto; margin-top: 0.1rem; }
          .md__done > div { flex: 1 1 auto; display: grid; gap: 0.2rem; }
        `}</style>
      </div>
    );
  }

  return (
    <div className="md">
      {mode === 'none' && (
        <div className="md__actions">
          {canApprove && (
            <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void decide('PUBLISHED')}>
              <Icon name="check" size={17} />
              {busy ? 'Сохраняем…' : 'Одобрить и опубликовать'}
            </button>
          )}
          {canReject && (
            <button type="button" className="btn btn-secondary" onClick={() => setMode('reject')}>
              Отклонить
            </button>
          )}
          {canPause && (
            <button type="button" className="btn btn-ghost" onClick={() => setMode('pause')}>
              Скрыть из поиска
            </button>
          )}
        </div>
      )}

      {mode !== 'none' && (
        <div className="md__form">
          <h3 className="title-sm">
            {mode === 'reject' ? 'Почему отклоняем?' : 'Почему скрываем?'}
          </h3>
          <p className="hint">
            Владелец увидит выбранные причины и сможет открыть нужный шаг заполнения. Выберите хотя
            бы одну.
          </p>

          <div className="md__codes">
            {MODERATION_REASON_CODES.map((code) => (
              <button
                key={code}
                type="button"
                className="chip chip-sm"
                aria-pressed={codes.includes(code)}
                onClick={() => toggle(code)}
              >
                {MODERATION_REASON_SHORT[code]}
              </button>
            ))}
          </div>

          <label className="field">
            <span className="label">Комментарий владельцу</span>
            <textarea
              className="textarea"
              rows={4}
              maxLength={1000}
              value={comment}
              onChange={(e) => setComment(e.target.value)}
              placeholder="Что именно нужно исправить. Этот текст увидит владелец."
            />
            <span className="hint">Необязательно, но обычно экономит один круг проверки.</span>
          </label>

          {error && (
            <p className="error-text" role="alert">
              {error}
            </p>
          )}

          <div className="md__formActions">
            <button type="button" className="btn btn-ghost" onClick={() => setMode('none')}>
              Отмена
            </button>
            <button
              type="button"
              className={mode === 'reject' ? 'btn btn-danger' : 'btn btn-primary'}
              disabled={busy || codes.length === 0}
              onClick={() => void decide(mode === 'reject' ? 'REJECTED' : 'PAUSED')}
            >
              {busy ? 'Сохраняем…' : mode === 'reject' ? 'Отклонить объявление' : 'Скрыть объявление'}
            </button>
          </div>
        </div>
      )}

      {error && mode === 'none' && (
        <p className="error-text" role="alert">
          {error}
        </p>
      )}

      <style>{`
        .md { display: grid; gap: var(--space-3); }
        .md__actions { display: flex; gap: var(--space-2); flex-wrap: wrap; }
        .md__form { display: grid; gap: var(--space-3); }
        .md__codes { display: flex; gap: var(--space-2); flex-wrap: wrap; }
        .md__formActions { display: flex; justify-content: flex-end; gap: var(--space-2); }
        @media (max-width: 480px) {
          .md__actions > .btn, .md__formActions > .btn { flex: 1 1 auto; }
        }
      `}</style>
    </div>
  );
}
