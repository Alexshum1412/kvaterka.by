import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { currentUser, signInUrl } from '@/server/session.ts';
import { readyServices } from '@/server/runtime.ts';
import { Icon } from '@/ui/icons.tsx';
import { CloseAccount } from '@/ui/close-account.tsx';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Учётная запись',
  robots: { index: false, follow: false },
};

/**
 * Closing an account.
 *
 * The hard part of this page is honesty. Somebody who clicks «удалить аккаунт»
 * usually means «уничтожьте мои данные», and that is not what happens: access
 * ends, the profile disappears from the site, and the records the platform is
 * built on — completed bookings, the fee ledger, reviews the person left about
 * other people — stay exactly where they are.
 *
 * So the page never uses the word «удалить» for what it does. It says
 * «закрыть», lists what survives before the button rather than after it, and
 * names the steps that are NOT built with the legal question each waits on. A
 * screen that quietly implied erasure would be the single most misleading
 * surface in the product.
 */

interface Status {
  status: string;
  closedAt: string | null;
  canClose: boolean;
  blockers: { code: string; explanation: string }[];
  steps: { step: string; what: string; built: boolean; blockedBy: string | null }[];
  survives: string[];
  outstandingBalanceMinor: string;
}

export default async function AccountPage() {
  const user = await currentUser();
  if (!user) redirect(signInUrl('/dashboard/account'));

  const services = await readyServices();
  const status = (await services.retention.erasureStatus(user.userId)) as unknown as Status;

  const built = status.steps.filter((s) => s.built);
  const notBuilt = status.steps.filter((s) => !s.built);
  const owes = BigInt(status.outstandingBalanceMinor || '0') < 0n;

  return (
    <div className="container acc">
      <header className="acc__head">
        <h1>Учётная запись</h1>
        <p className="acc__lede">
          Здесь можно закрыть учётную запись. Ниже честно написано, что при этом происходит, а что остаётся.
        </p>
      </header>

      {status.closedAt ? (
        <section className="card acc__closed">
          <Icon name="checkCircle" size={20} />
          <div>
            <h2>Учётная запись закрыта</h2>
            <p>Доступ прекращён, профиль скрыт с площадки. Если это ошибка — напишите в поддержку.</p>
          </div>
        </section>
      ) : (
        <>
          <section className="card">
            <h2 className="acc__h2">Что произойдёт</h2>
            <ul className="acc__steps">
              {built.map((s) => (
                <li key={s.step} className="acc__step acc__step--yes">
                  <Icon name="check" size={16} />
                  {s.what}
                </li>
              ))}
            </ul>
          </section>

          {/* The half that does not happen, named rather than omitted. */}
          <section className="card acc__pending">
            <h2 className="acc__h2">Чего закрытие НЕ делает</h2>
            <p className="acc__muted">
              Уничтожение персональных данных пока не реализовано, и это сознательно: пока не решено, что именно
              площадка обязана хранить и как долго, наполовину выполненное удаление хуже невыполненного — оно выглядит
              завершённым.
            </p>
            <ul className="acc__steps">
              {notBuilt.map((s) => (
                <li key={s.step} className="acc__step acc__step--no">
                  <Icon name="close" size={16} />
                  <span>
                    {s.what}
                    <em className="acc__blocked"> — ждёт решения {s.blockedBy}</em>
                  </span>
                </li>
              ))}
            </ul>
          </section>

          <section className="card">
            <h2 className="acc__h2">Что остаётся</h2>
            <ul className="acc__survives">
              {status.survives.map((s) => (
                <li key={s}>{s}</li>
              ))}
            </ul>
            {owes && (
              <p className="acc__debt">
                <Icon name="alert" size={16} />
                За вами числится задолженность по комиссии. Закрытие счёта её не отменяет — и не мешает закрытию:
                удерживать учётную запись из-за денег было бы давлением, а не защитой данных.
              </p>
            )}
          </section>

          {status.canClose ? (
            <CloseAccount />
          ) : (
            <section className="card acc__blockers">
              <h2 className="acc__h2">Сейчас закрыть нельзя</h2>
              <ul>
                {status.blockers.map((b) => (
                  <li key={b.code}>{b.explanation}</li>
                ))}
              </ul>
            </section>
          )}
        </>
      )}

      <style>{`
        .acc { display: grid; grid-template-columns: minmax(0, 1fr); gap: var(--space-4); max-width: 44rem; padding-block: var(--space-6) var(--space-8); min-width: 0; }
        .acc__head h1 { font-size: var(--text-2xl); font-weight: 600; }
        .acc__lede { font-size: var(--text-sm); color: var(--text-secondary); line-height: 1.6; margin-top: var(--space-2); }
        .acc__h2 { font-size: var(--text-base); font-weight: 600; margin-bottom: var(--space-3); }
        .acc__muted { font-size: var(--text-sm); color: var(--text-secondary); line-height: 1.6; margin-bottom: var(--space-3); }

        .acc__steps { display: grid; grid-template-columns: minmax(0, 1fr); gap: var(--space-2); margin: 0; padding: 0; list-style: none; }
        .acc__step { display: flex; align-items: flex-start; gap: 0.45rem; font-size: var(--text-sm); line-height: 1.55; min-width: 0; }
        .acc__step > svg { flex: 0 0 auto; margin-top: 0.2rem; }
        .acc__step--yes > svg { color: var(--success); }
        .acc__step--no { color: var(--text-secondary); }
        .acc__step--no > svg { color: var(--text-tertiary); }
        .acc__blocked { font-style: normal; color: var(--text-tertiary); font-size: var(--text-xs); }

        .acc__pending { border-left: 3px solid var(--warning); }
        .acc__survives { display: grid; gap: var(--space-2); margin: 0; padding-left: 1.1rem; font-size: var(--text-sm); line-height: 1.55; }
        .acc__debt { display: flex; align-items: flex-start; gap: 0.45rem; margin-top: var(--space-3); padding: var(--space-3); background: var(--warning-soft); border-radius: var(--radius-sm); font-size: var(--text-xs); line-height: 1.55; }
        .acc__debt > svg { flex: 0 0 auto; margin-top: 0.15rem; color: var(--warning); }

        .acc__danger { border-left: 3px solid var(--error); }
        .acc__blockers { border-left: 3px solid var(--warning); }
        .acc__blockers ul { display: grid; gap: var(--space-2); margin: 0; padding-left: 1.1rem; font-size: var(--text-sm); line-height: 1.55; }
        .acc__actions { display: flex; gap: var(--space-2); flex-wrap: wrap; margin-top: var(--space-3); }
        .acc__error { display: flex; align-items: center; gap: 0.4rem; font-size: var(--text-sm); color: var(--error); margin-top: var(--space-2); }
        .acc__closed { display: flex; align-items: flex-start; gap: var(--space-3); }
        .acc__closed > svg { color: var(--success); flex: 0 0 auto; margin-top: 0.2rem; }
        .acc__closed h2 { font-size: var(--text-base); font-weight: 600; }
        .acc__closed p { font-size: var(--text-sm); color: var(--text-secondary); margin-top: 0.25rem; }
      `}</style>
    </div>
  );
}
