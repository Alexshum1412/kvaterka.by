import Link from 'next/link';
import { CornflowerMark } from '@/ui/brand.tsx';
import { SearchForm } from '@/ui/search-form.tsx';

/**
 * The 404.
 *
 * This route mattered more than a missing page usually does, because 404 is
 * load-bearing in this product: every screen a caller may not see answers 404
 * rather than 403, so that an address cannot be used to discover that
 * something exists. Without this file all of those answers rendered the
 * framework's unstyled default — which reads as a broken site to the ordinary
 * person who simply mistyped, and tells the prober they found something
 * unusual.
 *
 * The one real chance to recover a mistyped listing link is a fresh search,
 * so the search module — the same one the home page floats above its hero —
 * sits right here rather than making the visitor navigate away first.
 */
export default function NotFound() {
  return (
    <div className="container nf">
      <div className="nf__hero">
        <span className="nf__mark" aria-hidden="true">
          <CornflowerMark size={104} gradient />
        </span>
        <p className="nf__eyebrow">404</p>
        <h1 className="nf__title">Кажется, такой страницы нет</h1>
        <p className="nf__body">
          Возможно, адрес набран с ошибкой, объявление сняли с публикации или у этой страницы другой
          владелец.
        </p>
        <Link href="/" className="btn btn-primary btn-lg nf__cta">
          На главную
        </Link>
      </div>

      <div className="nf__search">
        <p className="nf__search-label">Или найдите жильё заново</p>
        <SearchForm />
      </div>

      <style>{`
        .nf {
          padding-block: var(--space-8) var(--space-7);
          display: flex;
          flex-direction: column;
          align-items: center;
        }

        .nf__hero {
          max-width: 30rem;
          display: flex;
          flex-direction: column;
          align-items: center;
          text-align: center;
        }
        .nf__mark {
          display: inline-flex;
          margin-bottom: var(--space-4);
          filter: drop-shadow(0 10px 20px rgb(11 37 69 / 0.18));
        }
        .nf__eyebrow {
          font-size: var(--text-xs);
          font-weight: 700;
          letter-spacing: 0.08em;
          color: var(--text-tertiary);
          margin-bottom: var(--space-2);
        }
        .nf__title { font-size: var(--text-2xl); }
        .nf__body {
          margin-top: var(--space-3);
          max-width: 40ch;
          font-size: var(--text-sm);
          line-height: 1.6;
          color: var(--text-secondary);
        }
        .nf__cta { margin-top: var(--space-5); }

        .nf__search {
          width: 100%;
          max-width: 40rem;
          margin-top: var(--space-8);
        }
        .nf__search-label {
          margin-bottom: var(--space-3);
          text-align: center;
          font-size: var(--text-sm);
          font-weight: 500;
          color: var(--text-secondary);
        }
      `}</style>
    </div>
  );
}
