import type { Metadata } from 'next';
import { notFound, redirect } from 'next/navigation';
import { currentUser, signInUrl } from '@/server/session.ts';
import { readyServices } from '@/server/runtime.ts';
import { can } from '@/server/auth/rbac.ts';
import { StaffShell } from '@/ui/staff-shell.tsx';
import { Icon } from '@/ui/icons.tsx';
import { PlaceHold, ReleaseHold, RunRetention } from '@/ui/retention-actions.tsx';
import {
  DATA_CLASS_LABEL,
  DISPOSITION_LABEL,
  HOLD_REASON_LABEL,
  HOLD_TARGET_LABEL,
  OPEN_LEGAL_DEPENDENCIES,
  RETENTION_STATE_LABEL,
  type DataClass,
  type Disposition,
  type HoldReasonCode,
  type HoldTargetType,
  type RetentionState,
} from '@/server/domain/retention.ts';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Хранение данных',
  robots: { index: false, follow: false },
};

/**
 * What the platform keeps, what it destroys, and what is stopping it.
 *
 * The page leads with the two things that are true today and easy to get wrong
 * by omission: no retention window has been chosen for identity documents, and
 * there is no storage to destroy them from. Stating both at the top means an
 * operator who runs the job and sees nothing happen already knows why, instead
 * of filing a bug.
 *
 * The catalogue at the bottom is the whole data-protection posture in one
 * table, generated from the same declaration the service reads — so it cannot
 * describe a policy the code does not implement.
 */

interface Overview {
  storage: { configured: boolean; describe: string };
  documents: { total: number; byState: Record<string, number>; exampleEligibility: { explanation: string } };
  holds: {
    id: string;
    target_type: HoldTargetType;
    target_id: string;
    reason_code: HoldReasonCode;
    reason: string;
    placed_at: string;
    placed_by_name: string;
    review_overdue: boolean;
  }[];
  runs: {
    id: string;
    job_name: string;
    status: string;
    started_at: string;
    finished_at: string | null;
    processed: number;
    skipped: number;
    failed: number;
  }[];
  stuck: { id: string; doc_type: string; purge_started_at: string }[];
  catalogue: {
    table: string;
    dataClass: DataClass;
    onErasure: Disposition;
    window: { kind: string; blockedBy?: string; why: string; column?: string };
    appendOnly: boolean;
    enforced: boolean;
    note: string | null;
  }[];
}

const RUN_TONE: Record<string, string> = {
  SUCCEEDED: 'verified',
  RUNNING: 'primary',
  FAILED: 'danger',
  ABANDONED: 'warning',
};

const when = (iso: string | null): string =>
  iso ? new Date(iso).toLocaleString('ru-BY', { dateStyle: 'short', timeStyle: 'short' }) : '—';

function windowLabel(w: Overview['catalogue'][number]['window']): { text: string; tone: string } {
  switch (w.kind) {
    case 'TECHNICAL':
      return { text: 'Технический срок', tone: 'verified' };
    case 'PER_ROW':
      return { text: `По строке (${w.column})`, tone: 'primary' };
    case 'INDEFINITE':
      return { text: 'Бессрочно', tone: 'neutral' };
    default:
      return { text: `Не определён · ${w.blockedBy}`, tone: 'warning' };
  }
}

export default async function RetentionPage() {
  const user = await currentUser();
  if (!user) redirect(signInUrl('/staff/retention'));
  // 404, not 403 — consistent with every other staff surface.
  if (!can(user.roles, 'retention.hold')) notFound();

  const services = await readyServices();
  const data = (await services.retention.overview()) as unknown as Overview;
  const isAdmin = user.roles.includes('ADMIN');
  const canRun = can(user.roles, 'retention.run');

  const heldCount = data.holds.length;
  const overdue = data.holds.filter((h) => h.review_overdue).length;

  return (
    <StaffShell
      roles={user.roles}
      current="/staff/retention"
      title="Хранение данных"
      subtitle="Что площадка хранит, что уничтожает и что этому мешает"
      badges={[
        { label: 'Удержаний', count: heldCount },
        { label: 'Просрочен пересмотр', count: overdue, tone: overdue > 0 ? 'warning' : undefined },
        { label: 'Незавершённых уничтожений', count: data.stuck.length, tone: data.stuck.length > 0 ? 'danger' : undefined },
      ]}
    >
      <div className="ret">
        {/* The two facts an operator needs before anything else. */}
        <section className="ret__state card">
          <h2 className="ret__h2">Состояние на сегодня</h2>
          <ul className="ret__facts">
            <li className={data.storage.configured ? 'ret__fact ret__fact--ok' : 'ret__fact ret__fact--warn'}>
              <Icon name={data.storage.configured ? 'checkCircle' : 'alert'} size={18} />
              <div>
                <strong>Приватное хранилище</strong>
                <p>
                  {data.storage.configured
                    ? data.storage.describe
                    : `${data.storage.describe}. Документы не уничтожаются: площадка не может подтвердить, что файл действительно удалён, а отметка об уничтожении без подтверждения — это ложная запись.`}
                </p>
              </div>
            </li>
            <li className="ret__fact ret__fact--warn">
              <Icon name="info" size={18} />
              <div>
                <strong>Срок хранения документов не выбран</strong>
                <p>
                  Это LEGAL-004. Пока вопрос открыт, площадка не назначает срок сама: у документа поле срока пустое, а
                  пустой срок означает «уничтожать нельзя». Ответ на вопрос — это одна запись в политике, а не правка кода.
                </p>
              </div>
            </li>
          </ul>

          {canRun ? (
            <RunRetention storageConfigured={data.storage.configured} />
          ) : (
            <p className="ret__muted">Запуск задания доступен администратору.</p>
          )}
        </section>

        {/* Documents by derived state. */}
        <section className="card">
          <h2 className="ret__h2">Документы, удостоверяющие личность</h2>
          {data.documents.total === 0 ? (
            <p className="ret__muted">
              Ни одного документа не загружено — сбор отключён до ответа по LEGAL-004, поэтому уничтожать пока нечего.
            </p>
          ) : (
            <ul className="ret__states">
              {Object.entries(data.documents.byState).map(([state, count]) => (
                <li key={state}>
                  <span className={`badge badge--${state === 'HELD' ? 'warning' : 'neutral'}`}>
                    {RETENTION_STATE_LABEL[state as RetentionState] ?? state}
                  </span>
                  <strong>{count}</strong>
                </li>
              ))}
            </ul>
          )}
        </section>

        {/* Stuck purges — bytes may or may not be gone; a person must look. */}
        {data.stuck.length > 0 && (
          <section className="card ret__stuck">
            <h2 className="ret__h2">
              <Icon name="alert" size={18} /> Незавершённые уничтожения
            </h2>
            <p className="ret__muted">
              Уничтожение началось и не подтвердилось. Задание повторит попытку само; если строка держится здесь долго,
              хранилище недоступно.
            </p>
            <ul className="ret__list">
              {data.stuck.map((s) => (
                <li key={s.id}>
                  <code>{s.doc_type}</code> · начато {when(s.purge_started_at)}
                </li>
              ))}
            </ul>
          </section>
        )}

        {/* Holds. */}
        <section className="card">
          <div className="ret__sectionHead">
            <h2 className="ret__h2">Удержания</h2>
            <PlaceHold />
          </div>
          <p className="ret__muted">
            Удержание запрещает уничтожение и ничего не открывает. Наложить его может служба поддержки и модерация;
            снять — только администратор, назвав причину.
          </p>

          {data.holds.length === 0 ? (
            <p className="ret__muted">Активных удержаний нет.</p>
          ) : (
            <ul className="ret__holds">
              {data.holds.map((h) => (
                <li key={h.id} className="ret__hold">
                  <div className="ret__holdMain">
                    <span className="badge badge--warning">{HOLD_REASON_LABEL[h.reason_code] ?? h.reason_code}</span>
                    <strong>{HOLD_TARGET_LABEL[h.target_type] ?? h.target_type}</strong>
                    <code className="ret__id">{h.target_id}</code>
                  </div>
                  <p className="ret__holdReason">{h.reason}</p>
                  <p className="ret__meta">
                    {h.placed_by_name}, {when(h.placed_at)}
                    {h.review_overdue && (
                      <span className="ret__overdue"> · пересмотр просрочен</span>
                    )}
                  </p>
                  {isAdmin && <ReleaseHold holdId={h.id} />}
                </li>
              ))}
            </ul>
          )}
        </section>

        {/* Runs. */}
        <section className="card">
          <h2 className="ret__h2">Запуски задания</h2>
          {data.runs.length === 0 ? (
            <p className="ret__muted">Задание ещё ни разу не запускалось.</p>
          ) : (
            <div className="ret__tableWrap">
              <table className="ret__table">
                <thead>
                  <tr>
                    <th>Начало</th>
                    <th>Статус</th>
                    <th>Обработано</th>
                    <th>Пропущено</th>
                    <th>Ошибок</th>
                  </tr>
                </thead>
                <tbody>
                  {data.runs.map((r) => (
                    <tr key={r.id}>
                      <td>{when(r.started_at)}</td>
                      <td>
                        <span className={`badge badge--${RUN_TONE[r.status] ?? 'neutral'}`}>{r.status}</span>
                      </td>
                      <td>{r.processed}</td>
                      <td>{r.skipped}</td>
                      <td>{r.failed}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        {/* The catalogue. */}
        <section className="card">
          <h2 className="ret__h2">Политика по таблицам</h2>
          <p className="ret__muted">
            Это та же декларация, которую читает служба хранения, — она не может описывать политику, которой нет в коде.
            Тест сверяет её со схемой базы: таблицу нельзя добавить, не сказав, что происходит с её данными.
          </p>
          <p className="ret__muted">
            Открытые юридические вопросы, от которых зависят сроки: {OPEN_LEGAL_DEPENDENCIES.join(', ')}.
          </p>

          <div className="ret__tableWrap">
            <table className="ret__table">
              <thead>
                <tr>
                  <th>Таблица</th>
                  <th>Класс</th>
                  <th>При закрытии счёта</th>
                  <th>Срок</th>
                </tr>
              </thead>
              <tbody>
                {data.catalogue.map((p) => {
                  const w = windowLabel(p.window);
                  return (
                    <tr key={p.table}>
                      <td>
                        <code className="ret__id">{p.table}</code>
                        {p.appendOnly && <span className="badge badge--neutral">только добавление</span>}
                        {p.enforced && <span className="badge badge--verified">задание работает</span>}
                        {p.note && <p className="ret__note">{p.note}</p>}
                      </td>
                      <td>{DATA_CLASS_LABEL[p.dataClass]}</td>
                      <td>{DISPOSITION_LABEL[p.onErasure]}</td>
                      <td>
                        <span className={`badge badge--${w.tone}`}>{w.text}</span>
                        <p className="ret__note">{p.window.why}</p>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>
      </div>

      <style>{`
        /* Every grid here is minmax(0, 1fr). An implicit grid column sizes to
           max-content, which is how the verification case page came to overflow
           375 by 71px: one long id set the width of the whole page. */
        .ret { display: grid; grid-template-columns: minmax(0, 1fr); gap: var(--space-4); min-width: 0; }
        .ret__h2 { display: flex; align-items: center; gap: var(--space-2); font-size: var(--text-base); font-weight: 600; margin-bottom: var(--space-3); }
        .ret__muted { font-size: var(--text-sm); color: var(--text-secondary); line-height: 1.55; margin-bottom: var(--space-3); }
        .ret__note { font-size: var(--text-2xs); color: var(--text-tertiary); line-height: 1.5; margin-top: 0.2rem; }
        .ret__meta { font-size: var(--text-2xs); color: var(--text-tertiary); }
        .ret__overdue { color: var(--warning); font-weight: 600; }
        .ret__error { font-size: var(--text-sm); color: var(--error); margin-top: var(--space-2); }

        /* Identifiers and table names are unbreakable tokens in a monospace
           face; without this they set the page width on a phone. */
        .ret__id { font-family: ui-monospace, monospace; font-size: var(--text-xs); overflow-wrap: anywhere; }

        .ret__facts { display: grid; gap: var(--space-3); margin: 0 0 var(--space-4); padding: 0; list-style: none; }
        .ret__fact { display: flex; align-items: flex-start; gap: 0.5rem; padding: var(--space-3); border-radius: var(--radius-sm); min-width: 0; }
        .ret__fact > svg { flex: 0 0 auto; margin-top: 0.15rem; }
        .ret__fact > div { min-width: 0; }
        .ret__fact strong { display: block; font-size: var(--text-sm); margin-bottom: 0.15rem; }
        .ret__fact p { font-size: var(--text-xs); line-height: 1.55; color: var(--text-secondary); }
        .ret__fact--ok { background: var(--success-soft); }
        .ret__fact--ok > svg { color: var(--success); }
        .ret__fact--warn { background: var(--warning-soft); }
        .ret__fact--warn > svg { color: var(--warning); }

        .ret__states { display: flex; flex-wrap: wrap; gap: var(--space-3); margin: 0; padding: 0; list-style: none; }
        .ret__states li { display: flex; align-items: center; gap: 0.4rem; }

        .ret__sectionHead { display: flex; align-items: center; justify-content: space-between; gap: var(--space-3); flex-wrap: wrap; margin-bottom: var(--space-2); }

        .ret__holds, .ret__list { display: grid; grid-template-columns: minmax(0, 1fr); gap: var(--space-3); margin: 0; padding: 0; list-style: none; }
        .ret__hold { display: grid; gap: 0.35rem; padding: var(--space-3); background: var(--surface-sunken); border-radius: var(--radius-sm); min-width: 0; }
        .ret__holdMain { display: flex; align-items: center; gap: var(--space-2); flex-wrap: wrap; min-width: 0; }
        .ret__holdReason { font-size: var(--text-sm); line-height: 1.5; white-space: pre-wrap; overflow-wrap: anywhere; }
        .ret__list li { font-size: var(--text-sm); }
        .ret__stuck { border-left: 3px solid var(--warning); }

        /* A wide table must scroll inside its own box, never scroll the page. */
        .ret__tableWrap { overflow-x: auto; -webkit-overflow-scrolling: touch; }
        .ret__table { width: 100%; border-collapse: collapse; font-size: var(--text-sm); }
        .ret__table th, .ret__table td { text-align: left; padding: var(--space-2) var(--space-3); border-bottom: 1px solid var(--border); vertical-align: top; }
        .ret__table th { font-size: var(--text-2xs); text-transform: uppercase; letter-spacing: 0.04em; color: var(--text-tertiary); font-weight: 600; white-space: nowrap; }
        .ret__table td .badge { margin-right: 0.25rem; }

        .ret__form { display: grid; gap: var(--space-3); padding: var(--space-3); background: var(--surface-sunken); border-radius: var(--radius-sm); margin-top: var(--space-3); min-width: 0; }
        .ret__form--inline { margin-top: var(--space-2); }
        .ret__formNote { display: flex; align-items: flex-start; gap: 0.4rem; font-size: var(--text-xs); line-height: 1.55; color: var(--text-secondary); }
        .ret__formNote--warn { color: var(--warning); }
        .ret__formActions { display: flex; gap: var(--space-2); flex-wrap: wrap; }

        .ret__run { display: grid; gap: var(--space-2); justify-items: start; }
        .ret__runNote { font-size: var(--text-xs); line-height: 1.55; color: var(--text-secondary); }
        .ret__report { padding: var(--space-3); background: var(--surface-sunken); border-radius: var(--radius-sm); font-size: var(--text-sm); display: grid; gap: 0.3rem; }
      `}</style>
    </StaffShell>
  );
}
