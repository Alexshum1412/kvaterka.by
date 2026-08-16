import Link from 'next/link';
import { CornflowerMark } from './brand.tsx';

export function SiteHeader() {
  return (
    <header className="site-header">
      <div className="container row" style={{ minHeight: '3.75rem', gap: '1rem' }}>
        <Link href="/" className="row site-header__brand" aria-label="Кватэрка.by, на главную">
          <span style={{ color: 'var(--primary)', display: 'flex' }}>
            <CornflowerMark size={26} />
          </span>
          <span className="site-header__word">
            Кватэрка<span className="site-header__tld">.by</span>
          </span>
        </Link>

        <nav className="grow row site-header__nav" aria-label="Основная навигация">
          <Link href="/search" className="btn btn-ghost">
            Найти жильё
          </Link>
          <Link href="/dashboard" className="btn btn-ghost hide-sm">
            Мои квартиры
          </Link>
          <Link href="/login" className="btn btn-secondary">
            Войти
          </Link>
        </nav>
      </div>

      <style>{`
        .site-header {
          border-bottom: 1px solid var(--border);
          background: var(--surface-raised);
          position: sticky;
          top: 0;
          z-index: 40;
        }
        .site-header__brand { gap: 0.5rem; min-height: 2.75rem; }
        .site-header__word {
          font-weight: 700;
          font-size: var(--text-lg);
          letter-spacing: -0.02em;
          color: var(--text-primary);
          white-space: nowrap;
        }
        /* The domain is not part of the spoken name; equal weight would make
           the wordmark read as a URL rather than as a brand. */
        .site-header__tld { font-weight: 500; color: var(--text-secondary); }
        .site-header__nav { gap: 0.25rem; justify-content: flex-end; }
        @media (max-width: 600px) { .hide-sm { display: none; } }
      `}</style>
    </header>
  );
}
