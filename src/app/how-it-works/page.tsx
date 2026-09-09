import type { Metadata } from 'next';
import Link from 'next/link';
import { Prose } from '@/ui/prose.tsx';
import { Icon, type IconName } from '@/ui/icons.tsx';
import { Reveal } from '@/ui/reveal.tsx';

export const metadata: Metadata = {
  title: 'Как это работает',
  description:
    'Кватэрка соединяет арендаторов и хозяев напрямую: аренду вы платите друг другу, площадка берёт 5% с хозяина после завершённой аренды.',
};

const TENANT_STEPS: { icon: IconName; title: string; body: string }[] = [
  {
    icon: 'search',
    title: 'Найдите квартиру',
    body:
      'Поиск понимает не только «на сутки» и «на год», но и промежуточные сроки — от нескольких дней ' +
      'до нескольких месяцев.',
  },
  {
    icon: 'message',
    title: 'Отправьте запрос',
    body:
      'Это ещё не бронирование: хозяин видит ваш запрос и отвечает. Если он не ответит в срок, запрос ' +
      'истекает сам, и вы не остаётесь в неизвестности.',
  },
  {
    icon: 'users',
    title: 'Договоритесь в переписке',
    body:
      'До подтверждения переписка идёт внутри площадки. Так у обеих сторон остаётся запись ' +
      'договорённостей, если позже возникнет спор.',
  },
  {
    icon: 'key',
    title: 'Заезжайте и отметьте заезд',
    body: 'Точный адрес открывается после подтверждения — до этого момента на карте виден только район.',
  },
  {
    icon: 'checkCircle',
    title: 'Подтвердите, что аренда состоялась',
    body: 'Это делают обе стороны. Именно подтверждение, а не оплата, закрывает аренду.',
  },
  {
    icon: 'star',
    title: 'Оставьте отзыв',
    body:
      'Отзывы обеих сторон публикуются одновременно, поэтому никто не может сначала прочитать чужой и ' +
      'подстроить свой.',
  },
];

export default function HowItWorksPage() {
  return (
    <>
      <nav aria-label="Хлебные крошки" className="page-crumb">
        <ol>
          <li>
            <Link href="/">Главная</Link>
            <Icon name="chevronRight" size={14} />
          </li>
          <li aria-current="page">Как это работает</li>
        </ol>
      </nav>

      <Prose
        title="Как это работает"
        lede="Кватэрка — не доска объявлений. Это площадка, которая помнит, что произошло: кто с кем договорился, состоялась ли аренда и что обе стороны потом сказали друг о друге."
      >
        <h2>Для арендатора</h2>
        <ol className="step-list" role="list">
          {TENANT_STEPS.map((step) => (
            <li key={step.title} className="step-list__item">
              <span className="step-list__glyph">
                <Icon name={step.icon} size={20} />
              </span>
              <div className="step-list__copy">
                <b>{step.title}</b>
                <p>{step.body}</p>
              </div>
            </li>
          ))}
        </ol>

        <Reveal as="div">
          <h2>Для хозяина</h2>
          <p>
            Публикация бесплатна. Объявление проходит модерацию, после чего появляется в поиске. Вы
            отвечаете на запросы, подтверждаете аренду и получаете деньги напрямую от арендатора.
          </p>
          <p>
            Площадка берёт <strong>5% сбора</strong> — только с хозяина и только после того, как обе
            стороны подтвердили, что аренда состоялась.{' '}
            <Link href="/host/fees" className="link">
              Подробнее о сборе
            </Link>
            .
          </p>
        </Reveal>

        <Reveal as="div">
          <h2>Деньги за аренду площадка не трогает</h2>
          <p>
            Арендную плату и залог вы передаёте друг другу сами, как договорились. Кватэрка не
            является стороной вашей сделки, не принимает платежи за аренду и не хранит ваши деньги.
          </p>

          <div className="prose__note">
            <p>
              <strong>Что это значит на практике.</strong> Площадка не может «вернуть вам деньги»,
              потому что она их не получала. Что она может — сохранить переписку, подтверждения заезда
              и выезда и рассмотреть спор на основании этих записей.
            </p>
          </div>

          <p>
            <Link href="/search" className="btn btn-primary">
              Смотреть квартиры
            </Link>
          </p>
        </Reveal>
      </Prose>

      <style>{`
        .page-crumb {
          max-width: 42rem;
          margin-inline: auto;
          padding-inline: 1rem;
          padding-block: var(--space-4) 0;
          font-size: var(--text-xs);
          color: var(--text-tertiary);
        }
        .page-crumb ol { display: flex; align-items: center; flex-wrap: wrap; gap: 0.35rem; list-style: none; padding: 0; margin: 0; }
        .page-crumb li { display: flex; align-items: center; gap: 0.35rem; }
        .page-crumb a { color: var(--text-tertiary); font-weight: 500; }
        .page-crumb a:hover { color: var(--primary); text-decoration: underline; text-underline-offset: 3px; }
        .page-crumb li[aria-current] { color: var(--text-secondary); font-weight: 500; }
        .page-crumb svg { flex: 0 0 auto; }
        @media (min-width: 768px) { .page-crumb { padding-inline: 1.5rem; } }

        /* Same icon-circle language as the home page's trust grid, applied to
           a sequential process instead of independent reasons — so it stays
           a vertical list rather than a grid. */
        .step-list { list-style: none; padding: 0; margin: 0; display: flex; flex-direction: column; gap: var(--space-5); }
        .step-list__item { display: flex; align-items: flex-start; gap: var(--space-4); }
        .step-list__glyph {
          display: inline-flex; align-items: center; justify-content: center;
          flex: 0 0 auto;
          width: 2.75rem; height: 2.75rem;
          border-radius: var(--radius-full);
          background: var(--primary-soft);
          color: var(--primary);
        }
        .step-list__copy b { display: block; color: var(--text-primary); font-weight: 600; font-size: var(--text-base); margin-bottom: 0.2rem; }
        .step-list__copy p { margin: 0; color: var(--text-secondary); font-size: var(--text-sm); line-height: 1.6; }
      `}</style>
    </>
  );
}
