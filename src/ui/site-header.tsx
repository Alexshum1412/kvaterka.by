import Link from 'next/link';

/**
 * The mark is a doorway/window aperture — a rental product about getting
 * through a door, drawn as a simple geometric form that survives at 20 px on a
 * phone. Deliberately not a house-with-a-roof pictogram, which every listings
 * site already uses.
 */
export function Logo({ size = 28 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" role="img" aria-label="Kvaterka" fill="none">
      <rect x="1.25" y="1.25" width="29.5" height="29.5" rx="8" stroke="currentColor" strokeWidth="2.5" />
      <path d="M11 23V13.5a5 5 0 0 1 10 0V23" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />
      <circle cx="19" cy="18.5" r="1.6" fill="currentColor" />
    </svg>
  );
}

export function SiteHeader() {
  return (
    <header
      style={{
        borderBottom: '1px solid var(--border)',
        background: 'var(--bg-raised)',
        position: 'sticky',
        top: 0,
        zIndex: 40,
      }}
    >
      <div className="container row" style={{ minHeight: '3.75rem', gap: '1rem' }}>
        <Link href="/" className="row" style={{ gap: '0.5rem', color: 'var(--primary)' }}>
          <Logo />
          <span
            style={{
              fontWeight: 700,
              fontSize: 'var(--text-lg)',
              letterSpacing: '-0.02em',
              color: 'var(--fg)',
            }}
          >
            Kvaterka
          </span>
        </Link>

        <nav className="grow row" style={{ gap: '0.25rem', justifyContent: 'flex-end' }} aria-label="Основная навигация">
          <Link href="/search" className="btn btn-ghost">
            Найти жильё
          </Link>
          {/* Hidden below 600px: on a phone the search bar is the primary
              action and a landlord entry point would crowd it out. */}
          <Link href="/host" className="btn btn-ghost hide-sm">
            Сдать жильё
          </Link>
          <Link href="/login" className="btn btn-secondary">
            Войти
          </Link>
        </nav>
      </div>

      <style>{`
        @media (max-width: 600px) { .hide-sm { display: none; } }
      `}</style>
    </header>
  );
}
