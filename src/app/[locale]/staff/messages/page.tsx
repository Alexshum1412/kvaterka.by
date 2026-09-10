import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import { redirect } from '@/i18n/navigation.ts';
import { currentUser, signInUrl } from '@/server/session.ts';
import { ready } from '@/server/runtime.ts';
import { can } from '@/server/auth/rbac.ts';
import { StaffShell } from '@/ui/staff-shell.tsx';
import { Icon } from '@/ui/icons.tsx';

export const dynamic = 'force-dynamic';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('StaffMessages');
  return { title: t('title'), robots: { index: false, follow: false } };
}

/**
 * Messages the contact filter touched.
 *
 * READ-ONLY. There is no `/admin/moderation/messages/:id/decide` yet, so
 * this page does not pretend to have one — same honest pattern the
 * operations overview uses for a queue with no screen at all («Экран ещё не
 * готов — данные доступны через API»), except here the screen exists and
 * the data is real and browsable; only the decide-action is missing.
 *
 * `body_original` is shown next to `body` because moderating a redaction
 * without seeing what was redacted is impossible — the same reasoning the
 * API route itself documents. A FLAGGED message is never rewritten, so its
 * `body_original` (when the write path set one) is identical to `body` —
 * nothing to compare, so only the single text is shown.
 */

interface MessageRow {
  id: string;
  conversation_id: string;
  sender_id: string;
  body: string;
  body_original: string | null;
  moderation_state: 'FLAGGED' | 'REDACTED' | 'BLOCKED';
  created_at: string;
  detectors: string[];
  confidence: number | null;
}

const STATE_TONE: Record<MessageRow['moderation_state'], string> = {
  FLAGGED: 'warning',
  REDACTED: 'primary',
  BLOCKED: 'danger',
};

const DETECTOR_KEY: Record<string, string> = {
  EMAIL: 'detectorEmail',
  EMAIL_OBFUSCATED: 'detectorEmailObfuscated',
  PHONE_DIGITS: 'detectorPhoneDigits',
  PHONE_SPELLED_OUT: 'detectorPhoneSpelledOut',
  MESSENGER_KEYWORD: 'detectorMessengerKeyword',
  HANDLE: 'detectorHandle',
  URL: 'detectorUrl',
  SOCIAL_NETWORK: 'detectorSocialNetwork',
};

function when(iso: string): string {
  return new Date(iso).toLocaleString('ru-BY', { dateStyle: 'short', timeStyle: 'short' });
}

export default async function StaffMessagesPage() {
  const user = await currentUser();
  const locale = await getLocale();
  if (!user) redirect({ href: signInUrl('/staff/messages'), locale });
  // 404, not 403 — consistent with every other staff surface.
  if (!can(user!.roles, 'message.review')) notFound();

  const t = await getTranslations('StaffMessages');
  const database = await ready();

  // Original text is included because moderating a redaction without seeing
  // what was redacted is impossible. Access lands in the audit log — same
  // query the API route runs, read straight from the database rather than
  // by round-tripping through HTTP.
  const { rows: items } = await database.query<MessageRow>(
    `SELECT m.id, m.conversation_id, m.sender_id, m.body, m.body_original, m.moderation_state,
            m.created_at, e.detectors, e.confidence
       FROM message m
       LEFT JOIN LATERAL (
         SELECT detectors, confidence FROM message_moderation_event
          WHERE message_id = m.id ORDER BY id DESC LIMIT 1) e ON true
      WHERE m.moderation_state IN ('FLAGGED','REDACTED','BLOCKED')
      ORDER BY m.created_at DESC LIMIT 100`,
  );

  const stateLabel: Record<MessageRow['moderation_state'], string> = {
    FLAGGED: t('stateFlagged'),
    REDACTED: t('stateRedacted'),
    BLOCKED: t('stateBlocked'),
  };

  return (
    <StaffShell
      roles={user!.roles}
      withheldRoles={user!.withheldRoles}
      current="/staff/messages"
      title={t('title')}
      subtitle={t('subtitle')}
      badges={[{ label: t('badgeQueue'), count: items.length, tone: items.length > 0 ? 'warning' : undefined }]}
    >
      <p className="mq2__notice">
        <Icon name="eye" size={16} />
        {t('readOnlyNotice')}
      </p>

      {items.length === 0 ? (
        <div className="mq2__empty">
          <Icon name="checkCircle" size={26} />
          <p className="title-sm">{t('emptyTitle')}</p>
          <p className="text-sm muted">{t('emptyBody')}</p>
        </div>
      ) : (
        <ul className="mq2__list">
          {items.map((item) => {
            const original = item.body_original;
            const showOriginal = original !== null && original !== item.body;
            return (
              <li key={item.id} className="mq2__row">
                <div className="mq2__head">
                  <span className={`badge badge-${STATE_TONE[item.moderation_state]}`}>
                    {stateLabel[item.moderation_state]}
                  </span>
                  {item.confidence !== null && (
                    <span className="mq2__confidence">
                      {t('confidenceLabel')} {item.confidence}%
                    </span>
                  )}
                  {item.detectors.map((d) => (
                    <span key={d} className="mq2__tag">
                      {DETECTOR_KEY[d] ? t(DETECTOR_KEY[d]!) : d}
                    </span>
                  ))}
                  <span className="mq2__time">{when(item.created_at)}</span>
                </div>

                <div className={showOriginal ? 'mq2__bodies mq2__bodies--split' : 'mq2__bodies'}>
                  <div className="mq2__body">
                    <span className="mq2__bodyLabel">{t('seenLabel')}</span>
                    <p className="mq2__bodyText">
                      {item.body ? item.body : <span className="muted">{t('bodyEmpty')}</span>}
                    </p>
                  </div>
                  {showOriginal && (
                    <div className="mq2__body mq2__body--original">
                      <span className="mq2__bodyLabel">{t('originalLabel')}</span>
                      <p className="mq2__bodyText">{original}</p>
                    </div>
                  )}
                </div>
                {!showOriginal && <p className="mq2__sameNote">{t('sameNote')}</p>}

                <p className="mq2__meta">
                  {t('senderLabel')} <code className="mq2__id">{item.sender_id}</code>
                  {' · '}
                  {t('conversationLabel')} <code className="mq2__id">{item.conversation_id}</code>
                </p>
              </li>
            );
          })}
        </ul>
      )}

      <style>{`
        .mq2__notice {
          display: flex; align-items: flex-start; gap: 0.45rem;
          padding: var(--space-3) var(--space-4); margin-bottom: var(--space-4);
          background: var(--surface-sunken); border-radius: var(--radius-sm);
          font-size: var(--text-xs); line-height: 1.5; color: var(--text-secondary);
        }
        .mq2__notice > svg { color: var(--text-tertiary); flex: 0 0 auto; margin-top: 0.1rem; }

        .mq2__list { display: grid; gap: var(--space-3); list-style: none; margin: 0; padding: 0; }
        .mq2__row { display: grid; gap: var(--space-2); padding: var(--space-4); background: var(--surface); border-radius: var(--radius-md); min-width: 0; }

        .mq2__head { display: flex; align-items: center; gap: var(--space-2); flex-wrap: wrap; }
        .mq2__confidence { font-size: var(--text-2xs); color: var(--text-tertiary); }
        .mq2__tag {
          font-size: var(--text-2xs); font-weight: 500; color: var(--text-secondary);
          background: var(--surface-sunken); border-radius: var(--radius-full);
          padding: 0.05rem 0.5rem;
        }
        .mq2__time { font-size: var(--text-2xs); color: var(--text-tertiary); margin-left: auto; }

        .mq2__bodies { display: grid; grid-template-columns: minmax(0, 1fr); gap: var(--space-2); }
        .mq2__bodies--split { grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); }
        .mq2__body { display: grid; gap: 0.2rem; padding: var(--space-3); background: var(--surface-sunken); border-radius: var(--radius-sm); min-width: 0; }
        /* The redacted/blocked original is the evidence a decision hinges
           on — a rule, not only a colour, marks it out from the polite copy
           everyone else already saw. */
        .mq2__body--original { box-shadow: inset 3px 0 0 var(--warning); }
        .mq2__bodyLabel { font-size: var(--text-2xs); font-weight: 600; text-transform: uppercase; letter-spacing: 0.04em; color: var(--text-tertiary); }
        .mq2__bodyText { font-size: var(--text-sm); line-height: 1.55; white-space: pre-wrap; overflow-wrap: anywhere; }

        .mq2__sameNote { font-size: var(--text-2xs); color: var(--text-tertiary); font-style: italic; }

        .mq2__meta { font-size: var(--text-2xs); color: var(--text-tertiary); }
        /* An id is one unbreakable token; without this it sets the row's
           width on a phone. */
        .mq2__id { font-family: ui-monospace, monospace; overflow-wrap: anywhere; }

        .mq2__empty { display: grid; justify-items: center; gap: 0.3rem; padding: var(--space-8) var(--space-4); text-align: center; }
        .mq2__empty > svg { color: var(--success); margin-bottom: var(--space-2); }

        @media (max-width: 640px) {
          .mq2__bodies--split { grid-template-columns: minmax(0, 1fr); }
          .mq2__time { margin-left: 0; }
        }
      `}</style>
    </StaffShell>
  );
}
