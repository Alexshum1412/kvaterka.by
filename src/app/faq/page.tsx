import type { Metadata } from 'next';
import Link from 'next/link';
import { Prose } from '@/ui/prose.tsx';
import { Icon } from '@/ui/icons.tsx';
import { Reveal } from '@/ui/reveal.tsx';
import { DEFAULT_SERVICE_FEE_BPS, BPS_DENOMINATOR } from '@/server/domain/money.ts';

/* Same source the ledger actually charges against (see /host/fees) — this
   page cannot drift into quoting a rate the platform doesn't apply. */
const RATE_PERCENT = (BigInt(DEFAULT_SERVICE_FEE_BPS) * 100n) / BPS_DENOMINATOR;

export const metadata: Metadata = {
  title: 'Вопросы и ответы',
  description:
    'Как забронировать квартиру, как отменить запрос, какие документы нужны для проверки и есть ли скрытые платежи на Кватэрке.by.',
};

/**
 * FAQ.
 *
 * A real accordion — native <details>/<summary>, no client state. Every
 * answer here is traceable to something implemented: the booking state
 * machine (src/server/domain/booking/states.ts) for the request/cancel
 * questions, verification.ts for what proof is currently accepted, and the
 * host/fees page's own rate constant for the money question. Where the
 * honest answer is "this isn't finished yet" — identity documents — it says
 * so instead of describing a policy that doesn't exist.
 */
export default function FaqPage() {
  return (
    <>
      <nav className="container faq-crumbs" aria-label="Хлебные крошки">
        <ol>
          <li>
            <Link href="/">Главная</Link>
          </li>
          <li aria-hidden="true">
            <Icon name="chevronRight" size={12} />
          </li>
          <li aria-current="page">Вопросы и ответы</li>
        </ol>
      </nav>

      <Prose
        title="Вопросы и ответы"
        lede="Коротко о том, как устроена площадка — без «зависит от менеджера»: у каждого ответа здесь есть механизм в коде, который именно так себя и ведёт."
      >
        <h2>Бронирование</h2>
        <div className="faq-list">
          <details className="faq-item">
            <summary className="faq-item__q">
              <span>Как забронировать квартиру?</span>
              <Icon name="chevronDown" size={20} className="faq-item__chev" />
            </summary>
            <div className="faq-item__a">
              <p>
                Найдите жильё через поиск и отправьте запрос на нужные даты — это ещё не бронирование, а
                обращение к хозяину. Пока идёт переписка, на карте виден только район: точный адрес
                открывается, когда хозяин подтвердит запрос. После подтверждения даты закрепляются за
                вами, и обе стороны получают контакты друг друга.
              </p>
              <p>
                <Link href="/how-it-works" className="link">
                  Подробнее о том, как это работает
                </Link>
              </p>
            </div>
          </details>

          <details className="faq-item">
            <summary className="faq-item__q">
              <span>Как отменить запрос или уже подтверждённое бронирование?</span>
              <Icon name="chevronDown" size={20} className="faq-item__chev" />
            </summary>
            <div className="faq-item__a">
              <p>
                Пока хозяин не ответил на запрос, вы можете отозвать его в любой момент — календарь ещё
                ничем не занят, и это ничего не портит. После того как бронирование подтверждено,
                отменить его может любая сторона из карточки бронирования; если это делает хозяин,
                площадка фиксирует это отдельно — такие отмены сильнее всего бьют по арендатору.
              </p>
              <p>
                Сбор 5% с отменённой или несостоявшейся аренды не начисляется — он начисляется только за
                аренду, которая действительно состоялась.
              </p>
            </div>
          </details>

          <details className="faq-item">
            <summary className="faq-item__q">
              <span>Что будет, если хозяин не отвечает на запрос?</span>
              <Icon name="chevronDown" size={20} className="faq-item__chev" />
            </summary>
            <div className="faq-item__a">
              <p>
                Запрос не висит бесконечно. Если хозяин не ответит в срок, он истекает сам — вы не
                остаётесь в неизвестности и можете обратиться к другому варианту.
              </p>
            </div>
          </details>
        </div>

        <h2>Деньги и доверие</h2>
        <div className="faq-list">
          <details className="faq-item">
            <summary className="faq-item__q">
              <span>Есть ли скрытые платежи?</span>
              <Icon name="chevronDown" size={20} className="faq-item__chev" />
            </summary>
            <div className="faq-item__a">
              <p>
                Публикация объявления, поиск и переписка бесплатны для всех. Единственный сбор площадки —{' '}
                {String(RATE_PERCENT)}% с хозяина, и он начисляется один раз, только после того как обе
                стороны подтвердили, что аренда состоялась. Арендатор платит хозяину ровно ту сумму, о
                которой вы договорились, — с него площадка не берёт ничего.
              </p>
              <p>
                <Link href="/host/fees" className="link">
                  Как считается сбор
                </Link>
              </p>
            </div>
          </details>

          <details className="faq-item">
            <summary className="faq-item__q">
              <span>Какие документы нужны для верификации?</span>
              <Icon name="chevronDown" size={20} className="faq-item__chev" />
            </summary>
            <div className="faq-item__a">
              <p>
                Сейчас — никакие. Базовый уровень «Новичок» подтверждается почтой и телефоном, и это
                доступно всем сразу. Уровни «Личность подтверждена» и «Verified» устроены под документы,
                но приём документов временно выключен до юридического решения, поэтому эти уровни
                никому пока не выдаются — мы не показываем значок, за которым ничего не стоит.
              </p>
              <p>
                <Link href="/trust" className="link">
                  Подробнее об уровнях проверки
                </Link>
              </p>
            </div>
          </details>

          <details className="faq-item">
            <summary className="faq-item__q">
              <span>Как связаться с хозяином до бронирования?</span>
              <Icon name="chevronDown" size={20} className="faq-item__chev" />
            </summary>
            <div className="faq-item__a">
              <p>
                Только через переписку внутри Кватэрки — это единственный канал, пока бронирование не
                подтверждено. Если в сообщении попадается номер телефона, ссылка на мессенджер или
                другой способ увести разговор с площадки, этот фрагмент скрывается, а отправителю
                объясняется, почему. После подтверждения бронирования контакты открываются обеим
                сторонам.
              </p>
            </div>
          </details>
        </div>

        <Reveal as="div">
          <h2>Проживание</h2>
          <div className="faq-list">
            <details className="faq-item">
              <summary className="faq-item__q">
                <span>Можно ли заехать ночью?</span>
                <Icon name="chevronDown" size={20} className="faq-item__chev" />
              </summary>
              <div className="faq-item__a">
                <p>
                  Единого правила по всей площадке нет — время заезда указывает сам хозяин в объявлении,
                  и у каждого оно своё. Если нужен ночной заезд, обсудите это в переписке до
                  подтверждения: хозяин либо согласится, либо предложит другое время.
                </p>
              </div>
            </details>

            <details className="faq-item">
              <summary className="faq-item__q">
                <span>Что делать, если во время аренды что-то пошло не так?</span>
                <Icon name="chevronDown" size={20} className="faq-item__chev" />
              </summary>
              <div className="faq-item__a">
                <p>
                  Откройте карточку бронирования и нажмите «Открыть спор». Спор рассматривает сотрудник
                  — по переписке и отметкам о заезде и выезде, а не со слов одной стороны, и решение
                  фиксируется в неизменяемом журнале.
                </p>
                <p>
                  <Link href="/trust" className="link">
                    Как устроено доверие
                  </Link>{' '}
                  ·{' '}
                  <Link href="/support" className="link">
                    Поддержка
                  </Link>
                </p>
              </div>
            </details>
          </div>
        </Reveal>

        <p className="faq-more">
          Не нашли ответ?{' '}
          <Link href="/support" className="link">
            Раздел поддержки
          </Link>{' '}
          подскажет, куда идти дальше.
        </p>
      </Prose>

      <style>{`
        .faq-crumbs { padding-top: var(--space-4); max-width: 42rem; margin-inline: auto; }
        .faq-crumbs ol {
          display: flex; align-items: center; gap: 0.35rem;
          list-style: none; margin: 0; padding: 0;
          font-size: var(--text-xs); color: var(--text-tertiary);
        }
        .faq-crumbs li { display: flex; align-items: center; }
        .faq-crumbs a { color: var(--text-secondary); min-height: 1.75rem; display: inline-flex; align-items: center; }
        .faq-crumbs a:hover { color: var(--primary); text-decoration: underline; text-underline-offset: 3px; }
        .faq-crumbs li[aria-current='page'] { color: var(--text-primary); font-weight: 500; }

        .faq-list { display: flex; flex-direction: column; gap: var(--space-3); margin-bottom: var(--space-3); }

        /* A control, not a card: a visible border so it reads as clickable,
           the way every other control in this system does. */
        .faq-item {
          background: var(--surface);
          border: 1px solid var(--border);
          border-radius: var(--radius-md);
        }

        .faq-item__q {
          display: flex; align-items: center; justify-content: space-between; gap: var(--space-3);
          min-height: 2.75rem;
          padding: var(--space-4) var(--space-5);
          cursor: pointer;
          list-style: none;
          font-size: var(--text-sm);
          font-weight: 600;
          color: var(--text-primary);
          border-radius: var(--radius-md);
          transition: background-color 140ms ease;
        }
        .faq-item__q::-webkit-details-marker { display: none; }
        .faq-item__q:hover { background: var(--surface-sunken); }

        .faq-item__chev { color: var(--text-tertiary); transition: transform 200ms ease; }
        .faq-item[open] .faq-item__chev { transform: rotate(180deg); }
        .faq-item[open] .faq-item__q { border-radius: var(--radius-md) var(--radius-md) 0 0; }

        .faq-item__a { padding: 0 var(--space-5) var(--space-4); font-size: var(--text-sm); line-height: 1.7; }
        .faq-item__a p { margin-bottom: var(--space-2); color: var(--text-secondary); }
        .faq-item__a p:last-child { margin-bottom: 0; }

        .faq-more { margin-top: var(--space-5); color: var(--text-secondary); }
      `}</style>
    </>
  );
}
