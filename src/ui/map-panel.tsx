'use client';

import { useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Map as LeafletMap, Marker as LeafletMarker } from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { Link } from '@/i18n/navigation.ts';
import { Icon } from '@/ui/icons.tsx';
import { formatMoney, fromStorage } from '@/server/domain/money.ts';

export interface MapMarker {
  id: string;
  latitude: number;
  longitude: number;
  precision: string;
  priceMinor: string;
  priceUnit: string;
  title: string;
}

/**
 * Map panel — real OpenStreetMap tiles via Leaflet (LEGAL-014: the user's own
 * explicit, direct choice of provider; flagged to them rather than decided
 * silently — see the register entry for what that means for tile requests).
 *
 * Leaflet touches `window` at import time, so it is dynamically imported
 * inside the effect rather than at module scope — a static import would
 * throw during this client component's server-side render pass.
 *
 * Markers are a custom `L.divIcon` built from the same price-pill markup the
 * previous placeholder used (`renderToStaticMarkup`, not a second copy of the
 * styles), so the product's own marker design carries over onto the real
 * basemap instead of Leaflet's default pin.
 *
 * Every coordinate here is the BLURRED public point. The exact location is
 * never sent to the client before a booking is confirmed (DEC-020).
 */
export function MapPanel({ markers }: { markers: MapMarker[] }) {
  const t = useTranslations('Listing');
  const [active, setActive] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<LeafletMap | null>(null);
  const markersRef = useRef<Map<string, LeafletMarker>>(new Map());

  const activeMarker = active === null ? undefined : markers.find((m) => m.id === active);

  useEffect(() => {
    if (!containerRef.current || markers.length === 0) return;
    let cancelled = false;

    (async () => {
      const L = (await import('leaflet')).default;
      if (cancelled || !containerRef.current) return;

      const map = L.map(containerRef.current, { attributionControl: true, zoomControl: true });
      mapRef.current = map;

      L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        maxZoom: 19,
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
      }).addTo(map);

      for (const marker of markers) {
        const icon = L.divIcon({
          html: renderToStaticMarkup(
            <span className="map-pin__inner">
              <span className="numeric">{formatMoney(fromStorage(marker.priceMinor), { showCurrency: false })}</span>
            </span>,
          ),
          className: 'map-pin',
          // A zero-size anchor box: width/height 0 with the default
          // `overflow: visible` shows the pill without Leaflet constraining
          // its box to a guessed size, and the anchor point (half of
          // iconSize) lands exactly on the marker's own wrapper div — the
          // inner span's CSS transform does the actual centering below.
          iconSize: [0, 0],
        });
        const leafletMarker = L.marker([marker.latitude, marker.longitude], {
          icon,
          alt: `${marker.title}, ${formatMoney(fromStorage(marker.priceMinor))}`,
        }).addTo(map);
        leafletMarker.on('click', () => setActive((prev) => (prev === marker.id ? null : marker.id)));
        markersRef.current.set(marker.id, leafletMarker);
      }

      if (markers.length === 1) {
        map.setView([markers[0]!.latitude, markers[0]!.longitude], 14);
      } else {
        const bounds = L.latLngBounds(markers.map((m) => [m.latitude, m.longitude] as [number, number]));
        map.fitBounds(bounds, { padding: [32, 32] });
      }
    })();

    return () => {
      cancelled = true;
      mapRef.current?.remove();
      mapRef.current = null;
      markersRef.current.clear();
    };
    // Markers are re-keyed by identity below via the marker id set, not by
    // deep-diffing lat/lng — a fresh marker set tears down and rebuilds the
    // whole map, which is cheap enough at listing-page and search-result scale.
  }, [markers]);

  // Reflects `active` onto the marker DOM (a CSS class) without rebuilding
  // the map — clicking a marker or the pin toggling must not re-fetch tiles.
  useEffect(() => {
    for (const [id, marker] of markersRef.current) {
      const el = marker.getElement();
      el?.classList.toggle('map-pin--active', id === active);
    }
  }, [active]);

  if (markers.length === 0) {
    return (
      <div className="map-panel map-panel--empty">
        <div className="map-panel__empty">
          <span className="map-panel__emptyMark">
            <Icon name="map" size={28} />
          </span>
          <p>{t('map.empty')}</p>
        </div>
        <style>{MAP_CSS}</style>
      </div>
    );
  }

  return (
    <div className="map-panel">
      <div className="map-panel__viewport">
        <div ref={containerRef} className="map-panel__canvas" role="group" aria-label={t('map.ariaLabel')} />

        {activeMarker && (
          <div className="map-panel__card card">
            <Link href={`/listing/${activeMarker.id}`} className="map-card">
              <span className="map-card__title clamp-2">{activeMarker.title}</span>
              <span className="map-card__foot">
                <span className="numeric map-card__price">
                  {formatMoney(fromStorage(activeMarker.priceMinor))}
                </span>
                <Icon name="chevronRight" size={16} />
              </span>
              <span className="map-card__note">{t('map.approximateLocation')}</span>
            </Link>
          </div>
        )}
      </div>

      <style>{MAP_CSS}</style>
    </div>
  );
}

const MAP_CSS = `
  .map-panel {
    position: relative;
    display: flex;
    flex-direction: column;
    background: var(--surface-sunken);
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    overflow: hidden;
    min-height: 18rem;
    height: 100%;
  }
  .map-panel--empty { align-items: center; justify-content: center; }
  .map-panel__empty {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0.5rem;
    padding: var(--space-5);
    text-align: center;
    font-size: var(--text-sm);
    color: var(--text-tertiary);
  }
  .map-panel__emptyMark { color: var(--border-control); }

  .map-panel__viewport {
    position: relative;
    flex: 1 1 auto;
    min-height: 12rem;
  }
  .map-panel__canvas { position: absolute; inset: 0; background: var(--surface-sunken); }

  /* Leaflet positions the marker's OWN wrapper div (.leaflet-marker-icon)
     with an inline transform so its top-left corner sits at the geo point;
     centering that on the point has to happen one level down, on this inner
     span, so it never fights leaflet's own transform for the same property. */
  .map-pin__inner {
    display: inline-flex;
    transform: translate(-50%, -50%);
    min-height: 2.5rem;
    padding: 0.4rem 0.7rem;
    background: var(--surface);
    color: var(--text-primary);
    border: 1px solid var(--border-strong);
    border-radius: var(--radius-full);
    box-shadow: var(--shadow-subtle);
    font: inherit;
    font-size: var(--text-xs);
    font-weight: 600;
    cursor: pointer;
    white-space: nowrap;
    transition: background-color 140ms ease, color 140ms ease, border-color 140ms ease;
    align-items: center;
  }
  /* --primary carries white text at 5.28:1; --accent would fail here. */
  .leaflet-marker-icon.map-pin--active .map-pin__inner {
    background: var(--primary);
    color: var(--text-on-primary);
    border-color: var(--primary);
  }
  @media (hover: hover) and (pointer: fine) {
    .leaflet-marker-icon.map-pin:hover .map-pin__inner {
      background: var(--primary);
      color: var(--text-on-primary);
      border-color: var(--primary);
    }
  }
  .leaflet-marker-icon.map-pin--active { z-index: 1000 !important; }

  .map-panel__card {
    position: absolute;
    left: 0.75rem; right: 0.75rem; bottom: 0.75rem;
    z-index: 1001;
    box-shadow: var(--shadow-overlay);
    overflow: hidden;
  }
  .map-card { display: flex; flex-direction: column; gap: 0.15rem; padding: 0.75rem; }
  .map-card__title { font-size: var(--text-sm); font-weight: 600; line-height: 1.35; }
  .map-card__foot {
    display: flex; align-items: center; justify-content: space-between; gap: 0.5rem;
    color: var(--text-tertiary);
  }
  .map-card__price { font-size: var(--text-base); font-weight: 600; color: var(--text-primary); }
  .map-card__note { font-size: var(--text-2xs); color: var(--text-tertiary); }
`;
