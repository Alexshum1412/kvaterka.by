/**
 * Geospatial helpers and location privacy.
 */

import { createHash } from 'node:crypto';

export interface LatLng {
  readonly latitude: number;
  readonly longitude: number;
}

export interface Bounds {
  readonly north: number;
  readonly south: number;
  readonly east: number;
  readonly west: number;
}

const EARTH_RADIUS_M = 6_371_000;
const toRadians = (deg: number): number => (deg * Math.PI) / 180;

export function distanceMeters(a: LatLng, b: LatLng): number {
  const dLat = toRadians(b.latitude - a.latitude);
  const dLng = toRadians(b.longitude - a.longitude);
  const lat1 = toRadians(a.latitude);
  const lat2 = toRadians(b.latitude);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.sin(dLng / 2) ** 2 * Math.cos(lat1) * Math.cos(lat2);
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Minimum and maximum displacement of a public pin from the true location. */
export const PUBLIC_OFFSET_MIN_M = 120;
export const PUBLIC_OFFSET_MAX_M = 350;

/**
 * Compute the blurred public location for a property.
 *
 * DETERMINISTIC BY DESIGN (DEC-020). The offset is derived from the property
 * id, so the pin lands in the same place on every request forever. A randomly
 * re-rolled offset would be a de-anonymisation oracle: an observer who reloads
 * the page a few hundred times can average the samples and recover the true
 * coordinates to within a few metres. Blurring is only privacy-preserving if
 * it is stable.
 *
 * The displacement is large enough to cover a city block and small enough that
 * the listing still appears in the right neighbourhood for search.
 */
export function publicLocationFor(propertyId: string, exact: LatLng): LatLng {
  const digest = createHash('sha256').update(propertyId).digest();

  // Two independent values from the digest: a bearing and a radius.
  const bearing = ((digest.readUInt32BE(0) / 0xffffffff) * 2 - 1) * Math.PI; // [-π, π]
  const radius =
    PUBLIC_OFFSET_MIN_M + (digest.readUInt32BE(4) / 0xffffffff) * (PUBLIC_OFFSET_MAX_M - PUBLIC_OFFSET_MIN_M);

  const latDelta = (radius * Math.cos(bearing)) / EARTH_RADIUS_M;
  const lngDelta =
    (radius * Math.sin(bearing)) / (EARTH_RADIUS_M * Math.cos(toRadians(exact.latitude)) || 1);

  return {
    latitude: round6(exact.latitude + (latDelta * 180) / Math.PI),
    longitude: round6(exact.longitude + (lngDelta * 180) / Math.PI),
  };
}

const round6 = (n: number): number => Math.round(n * 1e6) / 1e6;

export function isValidLatLng(value: LatLng): boolean {
  return (
    Number.isFinite(value.latitude) &&
    Number.isFinite(value.longitude) &&
    value.latitude >= -90 &&
    value.latitude <= 90 &&
    value.longitude >= -180 &&
    value.longitude <= 180
  );
}

/** Rough sanity check that a coordinate is inside Belarus (launch market). */
export function isWithinBelarus(value: LatLng): boolean {
  return (
    value.latitude >= 51.2 && value.latitude <= 56.2 && value.longitude >= 23.1 && value.longitude <= 32.8
  );
}

export function normalizeBounds(b: Bounds): Bounds {
  return {
    north: Math.max(b.north, b.south),
    south: Math.min(b.north, b.south),
    east: Math.max(b.east, b.west),
    west: Math.min(b.east, b.west),
  };
}

/** Guard against a map request that asks for the entire country at full detail. */
export function boundsAreReasonable(b: Bounds): boolean {
  const n = normalizeBounds(b);
  return n.north - n.south <= 5 && n.east - n.west <= 8;
}
