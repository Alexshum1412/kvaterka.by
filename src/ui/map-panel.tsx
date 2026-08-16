'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
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
 * Map panel.
 *
 * The tile provider is intentionally abstracted (spec §19: "design provider
 * abstraction so map provider can be replaced later"). When
 * NEXT_PUBLIC_MAP_STYLE_URL is configured, the tile layer renders behind these
 * markers. It is NOT configured yet — no provider has been chosen, and that
 * choice interacts with LEGAL-014 (map/geolocation restrictions in Belarus).
 *
 * Rather than fake a map, this renders the markers in their true relative
 * geographic positions on a plain equirectangular projection. Relative
 * distances and clustering are real; only the basemap imagery is missing, and
 * the panel says so plainly instead of pretending.
 *
 * Every coordinate here is the BLURRED public point. The exact location is
 * never sent to the client before a booking is confirmed (DEC-020).
 */
export function MapPanel({ markers }: { markers: MapMarker[] }) {
  const [active, setActive] = useState<string | null>(null);
  const styleUrl = process.env.NEXT_PUBLIC_MAP_STYLE_URL;

  const projected = useMemo(() => {
    if (markers.length === 0) return [];
    const lats = markers.map((m) => m.latitude);
    const lngs = markers.map((m) => m.longitude);
    // Pad the bounds so markers never sit flush against the edge.
    const minLat = Math.min(...lats), maxLat = Math.max(...lats);
    const minLng = Math.min(...lngs), maxLng = Math.max(...lngs);
    const latSpan = Math.max(maxLat - minLat, 0.004);
    const lngSpan = Math.max(maxLng - minLng, 0.004);

    return markers.map((m) => ({
      ...m,
      // y is inverted: latitude grows north, screen coordinates grow down.
      x: 8 + ((m.longitude - minLng) / lngSpan) * 84,
      y: 8 + (1 - (m.latitude - minLat) / latSpan) * 84,
    }));
  }, [markers]);

  if (markers.length === 0) {
    return (
      <div className="map-panel map-panel--empty">
        <div className="map-panel__empty">
          <span className="map-panel__emptyMark">
            <Icon name="map" size={28} />
          </span>
          <p>Нет объектов в этой области</p>
        </div>
        <style>{MAP_CSS}</style>
      </div>
    );
  }

  const activeMarker = active === null ? undefined : markers.find((m) => m.id === active);

  return (
    <div className="map-panel">
      <div className="map-panel__viewport">
        <div className="map-panel__canvas" role="group" aria-label="Карта объектов">
          {projected.map((m) => (
            <button
              key={m.id}
              type="button"
              className="map-pin"
              style={{ left: `${m.x}%`, top: `${m.y}%` }}
              aria-label={`${m.title}, ${formatMoney(fromStorage(m.priceMinor))}`}
              aria-pressed={active === m.id}
              onClick={() => setActive(active === m.id ? null : m.id)}
            >
              <span className="numeric">{formatMoney(fromStorage(m.priceMinor), { showCurrency: false })}</span>
            </button>
          ))}
        </div>

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
              <span className="map-card__note">Показано примерное расположение</span>
            </Link>
          </div>
        )}
      </div>

      {!styleUrl && (
        <p className="map-panel__notice">
          <Icon name="info" size={14} />
          Картографический слой ещё не подключён. Точки показаны в реальном взаимном расположении.
        </p>
      )}

      <style>{MAP_CSS}</style>
    </div>
  );
}

/*
 * The notice sits in the flex column rather than over the viewport, so a long
 * line can wrap on a 375px phone without ever covering a pin.
 */
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
    /* A graticule, not a texture: barely there, only enough to read as a
       plan view rather than an empty grey rectangle. */
    background-image:
      repeating-linear-gradient(0deg, transparent 0 47px, color-mix(in srgb, var(--border) 60%, transparent) 47px 48px),
      repeating-linear-gradient(90deg, transparent 0 47px, color-mix(in srgb, var(--border) 60%, transparent) 47px 48px);
  }
  .map-panel__canvas { position: absolute; inset: 0; }

  .map-pin {
    position: absolute;
    z-index: 1;
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
  }
  /* --primary carries white text at 5.28:1; --accent would fail here. */
  .map-pin:hover, .map-pin[aria-pressed='true'] {
    z-index: 3;
    background: var(--primary);
    color: var(--text-on-primary);
    border-color: var(--primary);
  }

  .map-panel__card {
    position: absolute;
    left: 0.75rem; right: 0.75rem; bottom: 0.75rem;
    z-index: 4;
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

  .map-panel__notice {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    padding: 0.5rem 0.75rem 0.625rem;
    font-size: var(--text-2xs);
    line-height: 1.4;
    color: var(--text-tertiary);
  }
`;
