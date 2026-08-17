import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import Link from 'next/link';
import { currentUser, signInUrl } from '@/server/session.ts';
import { readyServices } from '@/server/runtime.ts';
import { Icon } from '@/ui/icons.tsx';
import { Money, plural } from '@/ui/primitives.tsx';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Баланс и сервисный сбор',
  robots: { index: false, follow: false },
};

/**
 * The landlord's ledger.
 *
 * WHAT THIS PAGE IS: a record of what the platform has charged and what has
 * been credited. Every number comes from `FinanceService`, which derives the
 * balance as SUM(ledger_entry.amount_minor) — there is no balance column to
 * drift, and nothing here recomputes a fee in the browser.
 *
 * WHAT THIS PAGE IS NOT: a payment screen. Кватэрка.by does not process
 * payments, so there is no "Оплатить" button and no wording that implies a
 * transaction happened. The vocabulary is «сбор», «задолженность», «баланс».
 *
 * LEGAL: LEGAL-016 — whether the fee is enforceable as modelled has not been
 * confirmed by a Belarusian lawyer, and the page therefore describes the record
 * rather than asserting an obligation. Enforcement itself sits behind the
 * `fee.enforcement` flag, and restrictions only appear when it is on.
 */

const ENTRY_LABEL: Record<string, string> = {
  FEE_ACCRUED: 'Начислен сервисный сбор',
  FEE_WAIVED: 'Сбор списан платформой',
  PAYMENT_RECEIVED: 'Платёж зачтён',
  ADJUSTMENT: 'Корректировка',
  REFUND: 'Возврат',
};

const RESTRICTION_LABEL: Record<string, string> = {
  CANNOT_PUBLISH_NEW_LISTINGS: 'Публикация новых объявлений',
  CANNOT_ACCEPT_NEW_BOOKINGS: 'Подтверждение новых бронирований',
  CANNOT_USE_PROMOTION: 'Платное продвижение',
  INSTANT_BOOKING_DISABLED: 'Мгновенное бронирование',
};

const FEE_STATUS_LABEL: Record<string, { label: string; tone: string }> = {
  PAYABLE: { label: 'К оплате', tone: 'warning' },
  PAID: { label: 'Оплачено', tone: 'verified' },
  WAIVED: { label: 'Списано', tone: 'solid-neutral' },
  CANCELLED: { label: 'Отменено', tone: 'solid-neutral' },
};

const MONTHS = [
  'января', 'февраля', 'марта', 'апреля', 'мая', 'июня',
  'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря',
];

function day(value: string | null | undefined): string {
  if (!value) return '';
  const iso = new Date(value).toISOString();
  const [y, m, d] = iso.slice(0, 10).split('-');
  return `${Number(d)} ${MONTHS[Number(m) - 1]} ${y}`;
}

export default async function FinancePage() {
  const user = await currentUser();
  if (!user) redirect(signInUrl('/dashboard/finance'));

  const services = await readyServices();
  const [balance, fees] = await Promise.all([
    services.finance.balance(user.userId),
    services.finance.listFees(user.userId),
  ]);

  const debtMinor = BigInt(balance.balanceMinor) < 0n ? (-BigInt(balance.balanceMinor)).toString() : '0';
  const payable = fees.filter((f) => f.status === 'PAYABLE');

  return (
    <div className="container fin">
      <nav className="fin__back">
        <Link href="/dashboard" className="fin__backLink">
          <Icon name="arrowLeft" size={16} />
          Кабинет
        </Link>
      </nav>

      <header className="fin__head">
        <h1 className="title-lg">Сервисный сбор</h1>
        <p className="text-sm muted">
          Кватэрка.by берёт комиссию только с завершённых аренд. Арендную плату мы не принимаем и не
          переводим.
        </p>
      </header>

      <section className="fin__summary" aria-label="Баланс">
        <div className="fin__figure">
          <span className="fin__figureLabel">
            {balance.hasDebt ? 'Задолженность' : 'Баланс'}
          </span>
          <strong className={balance.hasDebt ? 'fin__amount fin__amount--debt' : 'fin__amount'}>
            <Money minor={balance.hasDebt ? debtMinor : balance.balanceMinor} />
          </strong>
          <span className="fin__figureHint">
            {balance.hasDebt
              ? `${payable.length} ${plural(payable.length, 'неоплаченный сбор', 'неоплаченных сбора', 'неоплаченных сборов')}`
              : 'Открытых начислений нет'}
          </span>
        </div>

        {balance.restrictions.length > 0 ? (
          <div className="fin__limits">
            <p className="fin__limitsTitle">
              <Icon name="alert" size={16} />
              Пока задолженность не погашена, недоступно
            </p>
            <ul className="fin__limitsList">
              {balance.restrictions.map((r) => (
                <li key={r}>{RESTRICTION_LABEL[r] ?? r}</li>
              ))}
            </ul>
            {/* DEC-022. Stated on the screen, not just in the code: a landlord
                who thinks a debt can freeze an ongoing rental will try to settle
                it by taking the tenant off-platform. */}
            <p className="hint fin__limitsNote">
              Активные бронирования, переписка и подтверждение завершения аренды продолжают работать —
              ограничения касаются только новой коммерческой активности.
            </p>
          </div>
        ) : (
          <p className="fin__ok">
            <Icon name="checkCircle" size={16} />
            Ограничений на аккаунт нет.
          </p>
        )}
      </section>

      <section className="fin__section">
        <h2 className="fin__h2">Начисления по арендам</h2>
        {fees.length === 0 ? (
          <p className="text-sm muted">
            Начислений пока нет. Сбор появляется здесь только после завершённой аренды.
          </p>
        ) : (
          <ul className="fin__fees">
            {fees.map((raw) => {
              const f = raw as Record<string, any>;
              const status = FEE_STATUS_LABEL[f.status] ?? { label: f.status, tone: 'solid-neutral' };
              return (
                <li key={f.id} className="fin__fee">
                  <div className="fin__feeTop">
                    <span className={`badge badge-${status.tone}`}>{status.label}</span>
                    <Link href={`/bookings/${f.bookingId}`} className="fin__feeRef numeric">
                      № {f.bookingReference}
                    </Link>
                    <strong className="fin__feeAmount">
                      <Money minor={String(f.feeMinor)} />
                    </strong>
                  </div>
                  {/* The arithmetic, spelled out. A person being charged should
                      be able to check the number without trusting us. */}
                  <p className="fin__feeMath numeric">{f.explanation}</p>
                  <p className="fin__feeMeta">
                    Начислено {day(f.accruedAt)}
                    {f.status === 'PAYABLE' && f.dueAt ? ` · срок до ${day(f.dueAt)}` : ''}
                    {f.status === 'PAID' && f.settledAt ? ` · закрыто ${day(f.settledAt)}` : ''}
                    {f.arithmeticVerified === false && (
                      <span className="fin__mismatch">
                        <Icon name="alert" size={13} />
                        расчёт требует проверки — напишите в поддержку
                      </span>
                    )}
                  </p>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <section className="fin__section">
        <h2 className="fin__h2">Движение по балансу</h2>
        {balance.entries.length === 0 ? (
          <p className="text-sm muted">Записей пока нет.</p>
        ) : (
          <ul className="fin__entries">
            {balance.entries.map((e) => (
              <li key={e.id} className="fin__entry">
                <span className="fin__entryMain">
                  <span className="fin__entryLabel">{ENTRY_LABEL[e.type] ?? e.type}</span>
                  {e.reason && <span className="fin__entryReason">{e.reason}</span>}
                </span>
                <span className="fin__entryRight">
                  <span
                    className={
                      BigInt(e.amountMinor) < 0n ? 'fin__entryAmount fin__entryAmount--minus' : 'fin__entryAmount'
                    }
                  >
                    {BigInt(e.amountMinor) > 0n ? '+' : ''}
                    <Money minor={e.amountMinor} />
                  </span>
                  <span className="fin__entryDay">{day(e.createdAt)}</span>
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <p className="hint fin__legal">
        Платформа не является платёжным агентом и не удерживает арендную плату. Порядок оплаты
        сервисного сбора согласовывается отдельно; способы оплаты в приложении пока не подключены.
      </p>

      <style>{`
        .fin { padding-block: var(--space-4) var(--space-8); max-width: 52rem; }
        .fin__back { margin-bottom: var(--space-3); }
        .fin__backLink { display: inline-flex; align-items: center; gap: 0.35rem; min-height: 2.75rem; font-size: var(--text-sm); color: var(--text-secondary); }
        .fin__backLink:hover { color: var(--text-primary); }
        .fin__head { display: grid; gap: 0.25rem; margin-bottom: var(--space-5); }
        .fin__head p { max-width: 60ch; }

        .fin__summary {
          display: grid; gap: var(--space-4);
          padding-block: var(--space-5);
          border-top: 1px solid var(--border); border-bottom: 1px solid var(--border);
        }
        @media (min-width: 700px) {
          .fin__summary { grid-template-columns: minmax(0, 14rem) minmax(0, 1fr); align-items: start; gap: var(--space-6); }
        }
        .fin__figure { display: grid; gap: 0.15rem; }
        .fin__figureLabel { font-size: var(--text-xs); color: var(--text-tertiary); }
        .fin__amount { font-size: var(--text-3xl); font-weight: 650; letter-spacing: -0.024em; }
        .fin__amount--debt { color: var(--warning); }
        .fin__figureHint { font-size: var(--text-xs); color: var(--text-secondary); }

        .fin__limits { display: grid; gap: var(--space-2); }
        .fin__limitsTitle { display: flex; align-items: center; gap: 0.35rem; font-size: var(--text-sm); font-weight: 600; color: var(--warning); }
        .fin__limitsList { display: grid; gap: 0.2rem; margin: 0; padding-left: 1.1rem; font-size: var(--text-sm); color: var(--text-secondary); }
        .fin__limitsNote { max-width: 58ch; }
        .fin__ok { display: flex; align-items: center; gap: 0.35rem; font-size: var(--text-sm); color: var(--success); font-weight: 500; }

        .fin__section { padding-block: var(--space-6); }
        .fin__section + .fin__section { border-top: 1px solid var(--border); }
        .fin__h2 { font-size: var(--text-lg); font-weight: 600; margin-bottom: var(--space-4); }

        .fin__fees { display: grid; gap: var(--space-4); margin: 0; padding: 0; list-style: none; }
        .fin__fee { display: grid; gap: 0.25rem; }
        .fin__feeTop { display: flex; align-items: center; gap: var(--space-2); flex-wrap: wrap; }
        .fin__feeRef { font-size: var(--text-xs); color: var(--text-secondary); }
        .fin__feeRef:hover { color: var(--primary); }
        .fin__feeAmount { margin-left: auto; font-size: var(--text-base); }
        .fin__feeMath { font-size: var(--text-xs); color: var(--text-secondary); }
        .fin__feeMeta { display: flex; align-items: center; gap: 0.4rem; flex-wrap: wrap; font-size: var(--text-2xs); color: var(--text-tertiary); }
        .fin__mismatch { display: inline-flex; align-items: center; gap: 0.25rem; color: var(--error); font-weight: 600; }

        .fin__entries { display: grid; gap: var(--space-1); margin: 0; padding: 0; list-style: none; }
        .fin__entry {
          display: flex; align-items: baseline; justify-content: space-between; gap: var(--space-4);
          padding-block: var(--space-2);
        }
        .fin__entry + .fin__entry { border-top: 1px solid var(--border); }
        .fin__entryMain { display: grid; gap: 0.1rem; min-width: 0; }
        .fin__entryLabel { font-size: var(--text-sm); }
        .fin__entryReason { font-size: var(--text-2xs); color: var(--text-tertiary); }
        .fin__entryRight { display: grid; justify-items: end; gap: 0.1rem; flex: 0 0 auto; }
        .fin__entryAmount { font-size: var(--text-sm); font-weight: 600; color: var(--success); }
        .fin__entryAmount--minus { color: var(--text-primary); }
        .fin__entryDay { font-size: var(--text-2xs); color: var(--text-tertiary); }

        .fin__legal { border-top: 1px solid var(--border); padding-top: var(--space-4); max-width: 62ch; }
      `}</style>
    </div>
  );
}
