'use client';

import { useLocale } from 'next-intl';
import { Link, usePathname } from '@/i18n/navigation.ts';
import { routing, type AppLocale } from '@/i18n/routing.ts';

const LABEL: Record<AppLocale, string> = { ru: 'RU', be: 'BE', en: 'EN' };

/**
 * A real switcher: each pill is the SAME page, in another language — not a
 * jump back to the homepage. Client-only because it needs the current
 * pathname to build that link; the footer around it stays server-rendered.
 */
export function LanguageSwitcher({ ariaLabel }: { ariaLabel: string }) {
  const active = useLocale();
  const pathname = usePathname();

  return (
    <div className="lsw" aria-label={ariaLabel}>
      {routing.locales.map((locale) => (
        <Link
          key={locale}
          href={pathname}
          locale={locale}
          // Not prefetched (DEC-086): three extra RSC requests on every page
          // for a control people use once, and the RU pill's /ru/… is only a
          // 307 back to the page already on screen.
          prefetch={false}
          className={`lsw__pill${locale === active ? ' lsw__pill--active' : ''}`}
          aria-current={locale === active ? 'true' : undefined}
        >
          {LABEL[locale]}
        </Link>
      ))}
      <style>{`
        .lsw { display: inline-flex; align-items: center; gap: 0.3rem; }
        .lsw__pill {
          display: inline-flex;
          align-items: center;
          justify-content: center;
          min-width: 1.75rem;
          min-height: 1.5rem;
          padding: 0.2rem 0.4rem;
          border-radius: var(--radius-sm);
          font-size: var(--text-2xs);
          font-weight: 650;
          letter-spacing: 0.02em;
          color: var(--text-tertiary);
          transition: background-color 140ms ease, color 140ms ease;
        }
        @media (hover: hover) and (pointer: fine) {
          .lsw__pill:hover { background: var(--surface-sunken); color: var(--text-primary); }
        }
        .lsw__pill--active { background: var(--primary-soft); color: var(--primary); }
        @media (hover: hover) and (pointer: fine) {
          .lsw__pill--active:hover { background: var(--primary-soft-hover, var(--primary-soft)); }
        }
        /* A thumb needs 44px, the header has room for a 24px pill. The link
           itself is 44px tall and the pill is painted by ::before at its
           old height, so the touch area grows and the bar does not. Last in
           the block: it has to come after the rules whose background it
           moves onto the pseudo-element. */
        @media (pointer: coarse) {
          .lsw__pill { position: relative; isolation: isolate; min-height: 2.75rem; }
          .lsw__pill::before {
            content: '';
            position: absolute;
            z-index: -1;
            inset-block: 0.625rem;
            inset-inline: 0;
            border-radius: inherit;
          }
          .lsw__pill--active { background: transparent; }
          .lsw__pill--active::before { background: var(--primary-soft); }
        }
      `}</style>
    </div>
  );
}
