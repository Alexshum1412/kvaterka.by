'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
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
        <p style={{ color: 'var(--fg-subtle)', fontSize: 'var(--text-sm)' }}>Нет объектов в этой области</p>
      </div>
    );
  }

  return (
    <div className="map-panel">
      {!styleUrl && (
        <p className="map-panel__notice">
          Картографический слой ещё не подключён. Точки показаны в реальном взаимном расположении.
        </p>
      )}

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

      {active && (
        <div className="map-panel__card card">
          {(() => {
            const marker = markers.find((m) => m.id === active)!;
            return (
              <Link href={`/listing/${marker.id}`} className="stack" style={{ gap: '0.25rem', padding: '0.75rem' }}>
                <strong className="clamp-2" style={{ fontSize: 'var(--text-sm)' }}>
                  {marker.title}
                </strong>
                <span className="numeric" style={{ fontSize: 'var(--text-sm)' }}>
                  {formatMoney(fromStorage(marker.priceMinor))}
                </span>
                <span style={{ fontSize: 'var(--text-2xs)', color: 'var(--fg-subtle)' }}>
                  Показано примерное расположение
                </span>
              </Link>
            );
          })()}
        </div>
      )}

      <style>{`
        .map-panel {
          position: relative;
          border: 1px solid var(--border);
          border-radius: var(--radius-lg);
          background:
            linear-gradient(var(--bg-sunken), var(--bg-sunken)),
            repeating-linear-gradient(0deg, transparent 0 39px, var(--border) 39px 40px),
            repeating-linear-gradient(90deg, transparent 0 39px, var(--border) 39px 40px);
          background-blend-mode: normal;
          overflow: hidden;
          min-height: 18rem;
          height: 100%;
        }
        .map-panel--empty { display: grid; place-items: center; }
        .map-panel__canvas { position: absolute; inset: 0; }
        .map-panel__notice {
          position: absolute; inset-inline: 0; top: 0; z-index: 2;
          margin: 0; padding: 0.4rem 0.75rem;
          font-size: var(--text-2xs);
          color: var(--fg-muted);
          background: color-mix(in srgb, var(--bg-raised) 92%, transparent);
          border-bottom: 1px solid var(--border);
        }
        .map-pin {
          position: absolute;
          transform: translate(-50%, -50%);
          min-height: 2.25rem;
          padding: 0.4rem 0.7rem;
          background: var(--bg-raised);
          color: var(--fg);
          border: 1px solid var(--border-strong);
          border-radius: var(--radius-full);
          box-shadow: var(--shadow-card);
          font-size: var(--text-xs);
          font-weight: 600;
          cursor: pointer;
          white-space: nowrap;
        }
        .map-pin:hover, .map-pin[aria-pressed='true'] {
          background: var(--primary);
          color: var(--primary-fg);
          border-color: var(--primary);
          z-index: 3;
        }
        .map-panel__card {
          position: absolute; left: 0.75rem; right: 0.75rem; bottom: 0.75rem;
          z-index: 4;
        }
      `}</style>
    </div>
  );
}
