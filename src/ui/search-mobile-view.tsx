'use client';

import { useState, type ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import { Icon } from '@/ui/icons.tsx';
import { MapPanel, type MapMarker } from '@/ui/map-panel.tsx';

type View = 'list' | 'map';

/**
 * Results/map split for the search page.
 *
 * Side by side on desktop, as always — that layout is untouched. Below the
 * 1024px breakpoint there is only room for one at a time, and the previous
 * affordance for the other one was a small text link that anchor-scrolled
 * to an inline map block; it read as a footnote, not as a real view, and
 * nothing told a visitor who had scrolled past it that the map even
 * existed. A fixed bottom dock — the same shape as the booking dock on the
 * listing page (`.lst__dock`) — makes "list" and "map" two equally visible
 * destinations instead.
 *
 * The map panel is remounted on toggle (`key={view}`) rather than simply
 * shown or hidden with CSS. Leaflet measures its tile grid from the
 * container's size at mount time; a container that was `display:none` still
 * reports zero size, which is the classic "grey tiles until the window is
 * resized" bug. Giving it a fresh key on every switch to 'map' guarantees it
 * always mounts into an already-visible, already-sized container.
 *
 * The results grid has no such problem — it is plain markup, already
 * rendered by the server parent — so it only needs a CSS toggle, not a key.
 */
export function SearchMobileView({
  children,
  markers,
  mapAriaLabel,
}: {
  /** The results grid, already rendered by the server parent (page.tsx). */
  children: ReactNode;
  markers: readonly MapMarker[];
  mapAriaLabel: string;
}) {
  const t = useTranslations('Search');
  const [view, setView] = useState<View>('list');

  return (
    <div className="smv">
      <div className="srch__layout">
        <div className="srch__results" data-active={view === 'list'}>
          {children}
        </div>

        <aside className="srch__map" id="map" aria-label={mapAriaLabel} data-active={view === 'map'}>
          <MapPanel key={view} markers={markers as MapMarker[]} />
        </aside>
      </div>

      <div className="smv__dock" role="group" aria-label={t('mobileView.ariaLabel')}>
        <button type="button" className="smv__dockBtn" aria-pressed={view === 'list'} onClick={() => setView('list')}>
          <Icon name="list" size={18} />
          {t('mobileView.listTab')}
        </button>
        <button type="button" className="smv__dockBtn" aria-pressed={view === 'map'} onClick={() => setView('map')}>
          <Icon name="map" size={18} />
          {t('mobileView.mapTab')}
        </button>
      </div>

      <style>{`
        .srch__layout { display: grid; gap: var(--space-5); }
        .srch__results {
          display: grid;
          gap: var(--space-5) var(--space-4);
          grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
        }
        @media (max-width: 560px) {
          /* On a phone this becomes a photo feed, which is what browsing
             housing actually is. */
          .srch__results { grid-template-columns: 1fr; gap: var(--space-6); }
        }

        .srch__map { order: 1; min-height: 20rem; scroll-margin-top: 5rem; }

        /* Below the desktop breakpoint only one panel is on screen at a
           time — the dock below decides which. */
        @media (max-width: 1023.98px) {
          .srch__results[data-active='false'], .srch__map[data-active='false'] { display: none; }
          /* The dock floats over the page, so the visible panel has to end
             above it — same reasoning as .lst__dock reserving space on the
             listing page. */
          .srch__results[data-active='true'] { padding-bottom: 6rem; }
          .srch__map[data-active='true'] {
            height: calc(100dvh - var(--header-height) - 4.75rem);
          }
        }

        @media (min-width: 1024px) {
          .srch__layout { grid-template-columns: minmax(0, 1fr) 21rem; align-items: start; }
          .srch__map {
            order: 0;
            position: sticky;
            top: calc(var(--header-height) + 0.75rem);
            /* dvh, not vh: iOS Safari changes the viewport as the toolbar
               collapses and vh makes the panel jump. */
            height: calc(100dvh - var(--header-height) - 1.5rem);
          }
        }

        .smv__dock {
          position: fixed;
          inset-inline: 0;
          bottom: 0;
          z-index: 30;
          display: flex;
          gap: var(--space-2);
          padding: var(--space-3) var(--space-4);
          /* Safe-area inset so the bar clears the iOS home indicator. */
          padding-bottom: max(var(--space-3), env(safe-area-inset-bottom));
          background: var(--surface);
          border-top: 1px solid var(--border);
          box-shadow: 0 -6px 20px rgb(11 37 69 / 0.08);
        }
        .smv__dockBtn {
          flex: 1 1 0;
          display: inline-flex; align-items: center; justify-content: center; gap: 0.4rem;
          min-height: 2.75rem;
          border: 1px solid var(--border-control);
          border-radius: var(--radius-sm);
          background: var(--surface);
          color: var(--text-secondary);
          font: inherit; font-size: var(--text-sm); font-weight: 600;
          cursor: pointer;
        }
        .smv__dockBtn[aria-pressed='true'] {
          background: var(--primary-soft);
          border-color: var(--primary);
          color: var(--primary);
        }
        @media (min-width: 1024px) { .smv__dock { display: none; } }
      `}</style>
    </div>
  );
}
