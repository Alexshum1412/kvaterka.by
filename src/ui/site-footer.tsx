import Link from 'next/link';
import { CornflowerMark } from './brand.tsx';

/**
 * The site footer.
 *
 * It sits on the page ground rather than on its own surface: a footer that
 * is lighter than the content above it stops competing with it, and a single
 * hairline is enough to say where the page ends.
 *
 * The legal paragraph stays. It is small and grey because it is reference
 * text, not a promise — but it states plainly what Кватэрка.by is and is
 * not, and that is the one thing on this page that may never be trimmed for
 * looks.
 */
export function SiteFooter() {
  return (
    <footer className="ftr">
      <div className="container ftr__inner">
        <div className="ftr__grid">
          <div className="ftr__brand">
            <span className="ftr__lockup">
              <CornflowerMark size={22} className="ftr__mark" />
              <span className="ftr__word">
                Кватэрка<span className="ftr__tld">.by</span>
              </span>
            </span>
          </div>

          <div className="ftr__col">
            <h2 className="ftr__head">Арендаторам</h2>
            <ul className="ftr__list">
              <li>
                <Link href="/search" className="ftr__link">
                  Поиск жилья
                </Link>
              </li>
              <li>
                <Link href="/how-it-works" className="ftr__link">
                  Как это работает
                </Link>
              </li>
              <li>
                <Link href="/trust" className="ftr__link">
                  Проверка и доверие
                </Link>
              </li>
            </ul>
          </div>

          <div className="ftr__col">
            <h2 className="ftr__head">Хозяевам</h2>
            <ul className="ftr__list">
              <li>
                <Link href="/host" className="ftr__link">
                  Сдать жильё
                </Link>
              </li>
              <li>
                <Link href="/host/fees" className="ftr__link">
                  Сервисный сбор
                </Link>
              </li>
            </ul>
          </div>

          <div className="ftr__col">
            <h2 className="ftr__head">Платформа</h2>
            <ul className="ftr__list">
              <li>
                <Link href="/terms" className="ftr__link">
                  Условия использования
                </Link>
              </li>
              <li>
                <Link href="/privacy" className="ftr__link">
                  Обработка данных
                </Link>
              </li>
              <li>
                <Link href="/support" className="ftr__link">
                  Поддержка
                </Link>
              </li>
            </ul>
          </div>
        </div>

        <p className="ftr__legal">
          Кватэрка.by — площадка для размещения объявлений и общения между хозяином и арендатором.
          Платформа не является стороной договора аренды и не принимает арендную плату: расчёты
          стороны ведут между собой напрямую. Сервисный сбор 5% платит хозяин после подтверждённой
          сделки.
        </p>

        <p className="ftr__copy">© {new Date().getFullYear()} Кватэрка.by · Беларусь</p>
      </div>

      <style>{`
        .ftr {
          margin-top: var(--space-8);
          border-top: 1px solid var(--border);
        }
        .ftr__inner { padding-block: var(--space-6); }

        .ftr__grid {
          display: grid;
          grid-template-columns: repeat(2, minmax(0, 1fr));
          gap: var(--space-5);
          margin-bottom: var(--space-6);
        }
        .ftr__brand { grid-column: 1 / -1; }
        .ftr__lockup { display: inline-flex; align-items: center; gap: 0.5rem; }
        .ftr__mark { color: var(--primary); }
        .ftr__word {
          font-size: var(--text-base);
          font-weight: 700;
          letter-spacing: -0.02em;
          color: var(--text-primary);
          white-space: nowrap;
        }
        .ftr__tld { font-weight: 500; color: var(--text-secondary); }

        .ftr__col { min-width: 0; }
        .ftr__head {
          margin-bottom: var(--space-1);
          font-size: var(--text-sm);
          font-weight: 600;
          letter-spacing: 0;
          color: var(--text-primary);
        }
        .ftr__list { list-style: none; margin: 0; padding: 0; }
        .ftr__link {
          display: inline-flex;
          align-items: center;
          min-height: 2.5rem;
          font-size: var(--text-sm);
          line-height: 1.4;
          color: var(--text-secondary);
          transition: color 140ms ease;
        }
        .ftr__link:hover {
          color: var(--text-primary);
          text-decoration: underline;
          text-underline-offset: 3px;
        }

        .ftr__legal {
          max-width: 72ch;
          font-size: var(--text-xs);
          line-height: 1.6;
          color: var(--text-tertiary);
        }
        .ftr__copy {
          margin-top: var(--space-3);
          font-size: var(--text-xs);
          color: var(--text-tertiary);
        }

        @media (min-width: 768px) {
          .ftr__grid {
            grid-template-columns: minmax(0, 1.3fr) repeat(3, minmax(0, 1fr));
            gap: var(--space-6);
          }
          .ftr__brand { grid-column: auto; }
        }
      `}</style>
    </footer>
  );
}
