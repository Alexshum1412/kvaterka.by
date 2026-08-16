import { Suspense } from 'react';
import Link from 'next/link';
import { SearchForm } from '@/ui/search-form.tsx';

export const dynamic = 'force-dynamic';

/**
 * Home.
 *
 * The job is to let someone start searching in the first screenful, and to
 * state the one promise the product is built on. No hero carousel, no
 * animated statistics — a person looking for a flat wants the search box.
 */
export default function HomePage() {
  return (
    <>
      <section className="hero">
        <div className="container stack" style={{ gap: '1.5rem', maxWidth: '900px' }}>
          <div className="stack" style={{ gap: '0.75rem' }}>
            <h1 style={{ fontSize: 'var(--text-4xl)' }}>Аренда без сюрпризов</h1>
            <p style={{ fontSize: 'var(--text-lg)', color: 'var(--text-secondary)', maxWidth: '52ch' }}>
              Квартиры на сутки, на месяц и на год. Честная итоговая цена, проверенные хозяева и
              отзывы только от тех, кто действительно снимал.
            </p>
          </div>

          <Suspense fallback={<div className="skeleton" style={{ height: '9rem' }} />}>
            <SearchForm />
          </Suspense>

          <div className="scroll-x" style={{ paddingTop: '0.25rem' }}>
            {['Минск', 'Гродно', 'Брест', 'Витебск', 'Гомель', 'Могилёв'].map((city) => (
              <Link key={city} href={`/search?city=${encodeURIComponent(city)}`} className="chip">
                {city}
              </Link>
            ))}
          </div>
        </div>
      </section>

      <section className="container" style={{ paddingBlock: '3rem' }}>
        <div className="promise-grid">
          {[
            {
              title: 'Итоговая цена сразу',
              body:
                'Аренда, уборка и обязательные платежи показаны одной суммой до бронирования. ' +
                'То, что нельзя посчитать заранее — например, коммуналку по счётчику — помечено отдельно, ' +
                'а не спрятано в мелком шрифте.',
            },
            {
              title: 'Понятно, с кем имеете дело',
              body:
                'Подтверждение личности и проверка права сдавать объект — это две разные отметки, ' +
                'и мы их не смешиваем. Компании обозначены как компании.',
            },
            {
              title: 'Отзывы после реальных сделок',
              body:
                'Отзыв можно оставить только по завершённой аренде, по одному с каждой стороны. ' +
                'Оба отзыва открываются одновременно — чтобы никто не подстраивал оценку под чужую.',
            },
            {
              title: 'История остаётся на платформе',
              body:
                'Переписка, даты, условия и подтверждения сохраняются. Если возникнет спор, ' +
                'у обеих сторон есть на что сослаться.',
            },
          ].map((item) => (
            <div key={item.title} className="panel stack" style={{ gap: '0.5rem' }}>
              <h2 style={{ fontSize: 'var(--text-lg)' }}>{item.title}</h2>
              <p style={{ fontSize: 'var(--text-sm)', color: 'var(--text-secondary)' }}>{item.body}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="container" style={{ paddingBottom: '3rem' }}>
        <div className="panel host-cta">
          <div className="stack grow" style={{ gap: '0.5rem' }}>
            <h2 style={{ fontSize: 'var(--text-xl)' }}>Сдаёте квартиру?</h2>
            <p style={{ color: 'var(--text-secondary)', fontSize: 'var(--text-sm)', maxWidth: '58ch' }}>
              Разместите объявление бесплатно. Сервисный сбор 5% платится только после того, как
              аренда состоялась и это подтвердили обе стороны. Деньги за аренду вы получаете
              напрямую от арендатора.
            </p>
          </div>
          <Link href="/host" className="btn btn-primary btn-lg">
            Разместить объявление
          </Link>
        </div>
      </section>

      <style>{`
        .hero {
          padding-block: clamp(2rem, 5vw, 4rem);
          background:
            linear-gradient(180deg, var(--primary-soft) 0%, transparent 70%),
            var(--background);
          border-bottom: 1px solid var(--border);
        }
        .promise-grid {
          display: grid;
          gap: 1rem;
          grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
        }
        .host-cta { display: flex; flex-direction: column; gap: 1rem; align-items: flex-start; }
        @media (min-width: 720px) {
          .host-cta { flex-direction: row; align-items: center; }
        }
      `}</style>
    </>
  );
}
