import type { Metadata } from 'next';
import Link from 'next/link';
import { Prose } from '@/ui/prose.tsx';
import { Icon } from '@/ui/icons.tsx';
import { CornflowerField, CornflowerMark } from '@/ui/brand.tsx';
import { Reveal } from '@/ui/reveal.tsx';
import { DEFAULT_SERVICE_FEE_BPS, BPS_DENOMINATOR } from '@/server/domain/money.ts';

const RATE_PERCENT = (BigInt(DEFAULT_SERVICE_FEE_BPS) * 100n) / BPS_DENOMINATOR;

export const metadata: Metadata = {
  title: 'О нас',
  description:
    'Кватэрка.by — площадка для размещения объявлений и общения между хозяином и арендатором в Беларуси, устроенная вокруг доверия, а не только поиска.',
};

/**
 * About.
 *
 * No team section: there is no public/ folder, no real photography, and
 * inventing names and headshots would be exactly the kind of fabrication
 * that makes a site look fake. The visual anchor is the brand mark instead.
 * Every claim below is the same honest framing already carried in the site
 * footer's legal paragraph and the how-it-works page — restated, not
 * invented.
 */
export default function AboutPage() {
  return (
    <>
      <nav className="container about-crumbs" aria-label="Хлебные крошки">
        <ol>
          <li>
            <Link href="/">Главная</Link>
          </li>
          <li aria-hidden="true">
            <Icon name="chevronRight" size={12} />
          </li>
          <li aria-current="page">О нас</li>
        </ol>
      </nav>

      <section className="about-hero">
        <CornflowerField className="about-hero__field" />
        <div className="container about-hero__inner">
          <CornflowerMark size={56} gradient />
          <p className="about-hero__tag">Инфраструктура доверия для аренды жилья в Беларуси</p>
        </div>
      </section>

      <Prose
        title="О нас"
        lede="Кватэрка — не доска объявлений. Это площадка для аренды жилья, устроенная вокруг одного вопроса: можно ли доверять человеку по ту сторону объявления."
      >
        <h2>Что мы делаем</h2>
        <p>
          Кватэрка.by — площадка для размещения объявлений о жилье и общения между хозяином и
          арендатором. Мы не сторона договора аренды: не принимаем арендную плату, не удерживаем
          депозит и не гарантируем, что жильё выглядит так же, как на фотографиях — расчёты и осмотр
          квартиры стороны ведут между собой напрямую.
        </p>
        <p>
          Что даёт площадка взамен — это то, что обычно теряется в переписке в мессенджере: единая
          история диалога, которая остаётся у обеих сторон, отзывы, которые можно оставить только по
          завершённой аренде, и разбор спора сотрудником, если что-то пошло не так.
        </p>

        <h2>Почему это нужно</h2>
        <p>
          На рынке краткосрочной и долгосрочной аренды в Беларуси сложнее всего не найти вариант, а
          понять, можно ли доверять человеку по ту сторону объявления. Это и есть инфраструктура
          доверия — не рекламная формулировка, а то, чем площадка буквально занята:
        </p>
        <ul>
          <li>
            Отзыв привязан к конкретной завершённой аренде и не может быть куплен или написан «просто
            так».
          </li>
          <li>Уровни проверки объясняют, что именно подтверждено, а не прячутся за одним числом.</li>
          <li>Переписка до подтверждения остаётся внутри площадки — у спора есть на что опереться.</li>
        </ul>
        <p>
          <Link href="/trust" className="link">
            Подробнее о доверии и безопасности
          </Link>
        </p>

        <Reveal as="div">
          <h2>Как мы зарабатываем</h2>
          <p>
            Публикация объявления, поиск и переписка ничего не стоят. Единственный источник дохода
            площадки — сбор {String(RATE_PERCENT)}% с хозяина, который списывается один раз и только
            после того, как аренда завершилась и обе стороны это подтвердили. Ни абонентской платы, ни
            платы за продвижение в поиске, ни комиссии с арендатора.
          </p>
          <p>
            <Link href="/host/fees" className="link">
              Как считается сбор
            </Link>
          </p>

          <h2>Связаться с нами</h2>
          <p>
            Отдельного канала поддержки — почты, чата или формы — на площадке пока нет, и мы не делаем
            вид, что он есть. Если у вас вопрос о бронировании, проверке профиля или объявлении, на
            странице поддержки указано, куда с ним идти.
          </p>
          <p>
            <Link href="/support" className="link">
              Поддержка
            </Link>{' '}
            ·{' '}
            <Link href="/faq" className="link">
              Частые вопросы
            </Link>
          </p>

          <div className="about-cta">
            <Link href="/search" className="btn btn-secondary">
              Смотреть квартиры
            </Link>
            <Link href="/dashboard/listings/new" className="btn btn-primary">
              Разместить квартиру
            </Link>
          </div>
        </Reveal>
      </Prose>

      <style>{`
        .about-crumbs { padding-top: var(--space-4); max-width: 42rem; margin-inline: auto; }
        .about-crumbs ol {
          display: flex; align-items: center; gap: 0.35rem;
          list-style: none; margin: 0; padding: 0;
          font-size: var(--text-xs); color: var(--text-tertiary);
        }
        .about-crumbs li { display: flex; align-items: center; }
        .about-crumbs a { color: var(--text-secondary); min-height: 1.75rem; display: inline-flex; align-items: center; }
        .about-crumbs a:hover { color: var(--primary); text-decoration: underline; text-underline-offset: 3px; }
        .about-crumbs li[aria-current='page'] { color: var(--text-primary); font-weight: 500; }

        /* A quiet brand band, not a photograph nobody has. Same gradient the
           home hero uses, scaled down — this page has no inventory to sell,
           just an identity to state plainly. */
        .about-hero {
          position: relative;
          overflow: hidden;
          margin-top: var(--space-4);
          padding-block: var(--space-6);
          background: var(--gradient-hero);
        }
        .about-hero__field { z-index: 0; }
        .about-hero__inner {
          position: relative; z-index: 1;
          display: flex; flex-direction: column; align-items: center; gap: var(--space-3);
          text-align: center;
        }
        .about-hero__tag {
          max-width: 30rem;
          font-size: var(--text-lg);
          color: var(--color-corn-100);
        }

        .about-cta { display: flex; flex-wrap: wrap; gap: var(--space-3); margin-top: var(--space-4); }
      `}</style>
    </>
  );
}
