import type { Metadata } from 'next';
import Link from 'next/link';
import { Prose } from '@/ui/prose.tsx';
import { Icon, type IconName } from '@/ui/icons.tsx';
import { Reveal } from '@/ui/reveal.tsx';

export const metadata: Metadata = {
  title: 'Сдать квартиру',
  description:
    'Публикация бесплатна, сбор 5% — только после состоявшейся аренды. Как разместить квартиру на Кватэрка.by.',
};

const STEPS: { icon: IconName; title: string; body: string }[] = [
  {
    icon: 'edit',
    title: 'Опишите квартиру',
    body: 'Черновик сохраняется сам на каждом шаге, так что заполнять можно в несколько заходов.',
  },
  {
    icon: 'image',
    title: 'Добавьте фотографии',
    body: 'Фотографии — главное, на что смотрят. Объявление без них публиковать нельзя.',
  },
  {
    icon: 'calendar',
    title: 'Укажите сроки и цену',
    body:
      'Срок задаётся диапазоном ночей, поэтому одно объявление может подходить и на неделю, и на ' +
      'несколько месяцев.',
  },
  {
    icon: 'checkCircle',
    title: 'Отправьте на модерацию',
    body:
      'Проверяем объявление и публикуем. Если что-то не так — вернём с понятной причиной, а не с ' +
      'отказом без объяснений.',
  },
];

export default function HostPage() {
  return (
    <>
      <nav aria-label="Хлебные крошки" className="page-crumb">
        <ol>
          <li>
            <Link href="/">Главная</Link>
            <Icon name="chevronRight" size={14} />
          </li>
          <li aria-current="page">Сдать квартиру</li>
        </ol>
      </nav>

      <Prose
        title="Сдать квартиру"
        lede="Публикация бесплатна. Площадка зарабатывает только тогда, когда заработали вы: 5% после аренды, которую обе стороны подтвердили."
      >
        <h2>Как разместить</h2>
        <ol className="step-list" role="list">
          {STEPS.map((step) => (
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
          <h2>Календарь — ваш</h2>
          <p>
            Даты, которые вы закрыли, забронировать невозможно: это ограничение самой базы данных, а не
            проверка в интерфейсе. Двойное бронирование одних и тех же дат тоже невозможно —{' '}
            <strong>по построению</strong>, а не по внимательности.
          </p>

          <h2>Запросы и ответы</h2>
          <p>
            Арендатор отправляет запрос, вы отвечаете. Неотвеченный запрос истекает сам — арендатор не
            остаётся в подвешенном состоянии, а у вас не копится очередь просроченных.
          </p>
        </Reveal>

        <Reveal as="div">
          <h2>Деньги</h2>
          <p>
            Арендную плату и залог арендатор передаёт вам напрямую. Площадка их не принимает и не хранит.
            Сбор 5% начисляется после завершённой аренды —{' '}
            <Link href="/host/fees" className="link">
              подробно о сборе
            </Link>
            .
          </p>

          <p>
            <Link href="/dashboard/listings/new" className="btn btn-primary">
              Разместить квартиру
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
