'use client';

import { useEffect, useRef } from 'react';
import type { LeafletMouseEvent, Map as LeafletMap, Marker as LeafletMarker } from 'leaflet';
import 'leaflet/dist/leaflet.css';

const BELARUS_CENTER: [number, number] = [53.9, 27.56];
const BELARUS_ZOOM = 6;
const CITY_ZOOM = 13;

/**
 * Click-or-drag pin picker for a listing's location.
 *
 * Exists because a listing cannot leave DRAFT without `latitude`/`longitude`
 * (`property_complete_unless_draft`, db/migrations/0008), and the city field
 * next to this accepts free text now — a host can type a place that isn't in
 * the popular-city list, and this is the only way for them to still supply a
 * point for it, since there is no geocoding integration in front of it.
 *
 * A fresh Leaflet map for one draggable pin, not `MapPanel`: that component
 * is built around a read-only array of priced listing markers, and forcing a
 * single editable point through that shape would be the wrong end of the
 * abstraction. Same OSM raster tiles, same LEGAL-014 provider choice.
 */
export function LocationPicker({
  latitude,
  longitude,
  onChange,
  ariaLabel,
}: {
  latitude: number | null;
  longitude: number | null;
  onChange: (latitude: number, longitude: number) => void;
  ariaLabel: string;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<LeafletMap | null>(null);
  const markerRef = useRef<LeafletMarker | null>(null);
  // The map is built once (see the mount effect's empty deps below); this
  // ref lets its drag/click handlers, set up on that first render, still
  // always call the CURRENT `onChange` rather than whatever closure existed
  // when the map was constructed.
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  useEffect(() => {
    if (!containerRef.current) return;
    let cancelled = false;

    (async () => {
      const L = (await import('leaflet')).default;
      if (cancelled || !containerRef.current) return;

      const map = L.map(containerRef.current, { zoomControl: true });
      mapRef.current = map;

      L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        maxZoom: 19,
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
      }).addTo(map);

      const start: [number, number] = latitude != null && longitude != null ? [latitude, longitude] : BELARUS_CENTER;
      map.setView(start, latitude != null ? CITY_ZOOM : BELARUS_ZOOM);

      const icon = L.divIcon({
        html: '<span class="loc-pin__dot"></span>',
        className: 'loc-pin',
        iconSize: [20, 20],
        iconAnchor: [10, 10],
      });
      const marker = L.marker(start, { icon, draggable: true }).addTo(map);
      markerRef.current = marker;

      marker.on('dragend', () => {
        const pos = marker.getLatLng();
        onChangeRef.current(pos.lat, pos.lng);
      });
      map.on('click', (e: LeafletMouseEvent) => {
        marker.setLatLng(e.latlng);
        onChangeRef.current(e.latlng.lat, e.latlng.lng);
      });
    })();

    return () => {
      cancelled = true;
      mapRef.current?.remove();
      mapRef.current = null;
      markerRef.current = null;
    };
    // Mounts the map exactly once; coordinate changes that originate OUTSIDE
    // this component (picking a known city) are handled by the effect below
    // instead of tearing the whole map down on every keystroke.
  }, []);

  // Follows a coordinate change that came from outside (the city field
  // filling in a known centre) — a drag/click already moved the marker
  // itself, so this only has to act when the incoming point disagrees with
  // where the marker already is.
  useEffect(() => {
    if (latitude == null || longitude == null) return;
    const map = mapRef.current;
    const marker = markerRef.current;
    if (!map || !marker) return;
    const current = marker.getLatLng();
    if (Math.abs(current.lat - latitude) < 1e-9 && Math.abs(current.lng - longitude) < 1e-9) return;
    marker.setLatLng([latitude, longitude]);
    map.setView([latitude, longitude], Math.max(map.getZoom(), CITY_ZOOM));
  }, [latitude, longitude]);

  return (
    <>
      <div ref={containerRef} className="loc-pin-panel" role="group" aria-label={ariaLabel} />
      <style>{`
        .loc-pin-panel {
          height: 14rem;
          border: 1px solid var(--border);
          border-radius: var(--radius-lg);
          overflow: hidden;
        }
        .loc-pin__dot {
          display: block;
          width: 1.1rem;
          height: 1.1rem;
          border-radius: var(--radius-full);
          background: var(--primary);
          border: 2px solid var(--surface);
          box-shadow: var(--shadow-subtle);
          cursor: grab;
        }
      `}</style>
    </>
  );
}
