'use client';

import { useEffect, useState, type ReactNode } from 'react';
import { usePathname } from '@/i18n/navigation.ts';
import { Icon } from '@/ui/icons.tsx';

/**
 * The nav's mobile fallback.
 *
 * Between the compact icon bar (below 768) and the full text nav (at
 * 900px) there was a stretch — tablet portrait, phone landscape — where
 * the header carried nothing but a search icon: "Мои поездки",
 * "Избранное", "Сообщения" and everything else were simply unreachable
 * without first opening the account menu and hunting from there.
 *
 * This wraps the SAME `<nav>` the desktop breakpoint already renders
 * (passed in as `children`, built server-side with the visitor's own
 * session and role data) behind a disclosure button, rather than
 * keeping a second copy of that link list in sync — the nav is always
 * in the DOM at every width; only its CSS changes, from "hidden" to
 * "inline in the bar" to "a dropdown panel," per the media queries
 * below.
 */
export function MobileNavMenu({
  children,
  openLabel,
  closeLabel,
}: {
  children: ReactNode;
  openLabel: string;
  closeLabel: string;
}) {
  const [open, setOpen] = useState(false);
  const pathname = usePathname();

  // A tap on a link inside is a navigation — the panel must not still be
  // open on the page that link led to.
  useEffect(() => {
    setOpen(false);
  }, [pathname]);

  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false);
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  return (
    <div className="sh__mobileNav" data-open={open}>
      <button
        type="button"
        className="sh__icon-link sh__menuBtn"
        aria-expanded={open}
        aria-controls="sh-mobile-nav"
        aria-label={open ? closeLabel : openLabel}
        onClick={() => setOpen((v) => !v)}
      >
        <Icon name={open ? 'close' : 'menu'} size={20} />
      </button>
      {open && (
        <button
          type="button"
          className="sh__menuScrim"
          aria-hidden="true"
          tabIndex={-1}
          onClick={() => setOpen(false)}
        />
      )}
      {children}

      <style>{`
        .sh__menuScrim {
          position: fixed; inset: 0; z-index: 1;
          background: rgb(11 37 69 / 0.25);
          border: 0; padding: 0; cursor: default;
        }
        @media (min-width: 900px) {
          .sh__menuScrim { display: none; }
        }

        /* Below the text-nav breakpoint, an open panel turns the same
           <nav> the desktop bar uses into a full-width dropdown — the
           id above is only ever the target of aria-controls, never a
           CSS hook, so this reads purely off the state this component
           owns. */
        @media (max-width: 899.98px) {
          .sh__mobileNav[data-open='true'] #sh-mobile-nav {
            display: flex;
            flex-direction: column;
            align-items: stretch;
            gap: 0.125rem;
            position: absolute;
            top: 100%;
            inset-inline: 0;
            z-index: 2;
            background: var(--surface);
            border-bottom: 1px solid var(--border);
            box-shadow: var(--shadow-overlay);
            padding: var(--space-3) var(--space-4) var(--space-4);
          }
          .sh__mobileNav[data-open='true'] #sh-mobile-nav .sh__link {
            display: flex;
            width: 100%;
            padding-block: 0.4rem;
            border-radius: var(--radius-sm);
          }
          @media (hover: hover) and (pointer: fine) {
            .sh__mobileNav[data-open='true'] #sh-mobile-nav .sh__link:hover {
              background: var(--surface-sunken);
            }
          }
        }
      `}</style>
    </div>
  );
}
