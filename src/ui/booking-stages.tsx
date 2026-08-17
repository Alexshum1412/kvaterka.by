import { Icon } from '@/ui/icons.tsx';

/**
 * Where this booking is in the rental, as five steps.
 *
 * It is a projection of the FSM, not a second state model: every booking state
 * maps to exactly one step here, and nothing reads or writes status through
 * this file. A booking that left the happy path (declined, withdrawn, expired,
 * cancelled, not-taken-place, disputed) gets no strip at all — drawing four
 * grey circles after "Отменено" would suggest something is still coming.
 *
 * Purely presentational and server-rendered: no client JavaScript for a row of
 * five labels.
 */

const STAGES = [
  { key: 'REQUEST', label: 'Заявка', icon: 'message' as const },
  { key: 'CONFIRMED', label: 'Подтверждено', icon: 'checkCircle' as const },
  { key: 'STAY', label: 'Проживание', icon: 'key' as const },
  { key: 'COMPLETION', label: 'Подтверждение', icon: 'clock' as const },
  { key: 'DONE', label: 'Завершено', icon: 'star' as const },
] as const;

/** Booking state → index of the step it is currently at. */
const STAGE_OF: Record<string, number> = {
  INQUIRY: 0,
  REQUESTED: 0,
  OFFER_PENDING: 0,
  CONFIRMED: 1,
  CHECKED_IN: 2,
  COMPLETION_PENDING: 3,
  COMPLETED: 4,
};

const OFF_PATH = new Set([
  'DECLINED',
  'WITHDRAWN',
  'EXPIRED',
  'CANCELLED_BY_TENANT',
  'CANCELLED_BY_LANDLORD',
  'NOT_TAKEN_PLACE',
  'DISPUTED',
]);

export function BookingStages({ status }: { status: string }) {
  if (OFF_PATH.has(status)) return null;
  const current = STAGE_OF[status];
  if (current === undefined) return null;

  return (
    <ol className="bs" aria-label="Этап аренды">
      {STAGES.map((stage, index) => {
        const state = index < current ? 'past' : index === current ? 'now' : 'future';
        return (
          <li key={stage.key} className="bs__step" data-state={state}>
            <span className="bs__mark" aria-hidden="true">
              {state === 'past' ? <Icon name="check" size={13} /> : <Icon name={stage.icon} size={13} />}
            </span>
            <span className="bs__label">{stage.label}</span>
            {/* The only accessible statement of position — the visual states
                above are decoration, and colour alone never carries it. */}
            {state === 'now' && <span className="sr-only">— текущий этап</span>}
          </li>
        );
      })}

      <style>{`
        .bs {
          display: grid; grid-auto-flow: column; grid-auto-columns: 1fr;
          gap: var(--space-1);
          margin: 0 0 var(--space-5); padding: 0; list-style: none;
        }
        .bs__step { display: grid; justify-items: center; gap: 0.35rem; position: relative; min-width: 0; }
        /* The connector: drawn from each step to the previous one, so the line
           can be tinted by the step it arrives at. */
        .bs__step:not(:first-child)::before {
          content: ''; position: absolute; top: 0.6875rem; right: 50%; left: -50%;
          height: 2px; background: var(--border);
        }
        .bs__step[data-state='past']::before,
        .bs__step[data-state='now']::before { background: var(--primary); }

        .bs__mark {
          position: relative; z-index: 1;
          display: grid; place-items: center;
          width: 1.5rem; height: 1.5rem; border-radius: var(--radius-full);
          background: var(--surface-sunken); color: var(--text-tertiary);
        }
        .bs__step[data-state='past'] .bs__mark { background: var(--primary); color: var(--text-on-primary); }
        .bs__step[data-state='now'] .bs__mark {
          background: var(--primary); color: var(--text-on-primary);
          box-shadow: 0 0 0 4px var(--primary-soft);
        }

        .bs__label {
          font-size: var(--text-2xs); text-align: center; line-height: 1.25;
          color: var(--text-tertiary);
        }
        .bs__step[data-state='now'] .bs__label { color: var(--text-primary); font-weight: 600; }
        .bs__step[data-state='past'] .bs__label { color: var(--text-secondary); }

        /* On a narrow phone five words do not fit side by side; the marks and
           the current label still do. */
        @media (max-width: 400px) {
          .bs__step[data-state='future'] .bs__label { display: none; }
        }
      `}</style>
    </ol>
  );
}
