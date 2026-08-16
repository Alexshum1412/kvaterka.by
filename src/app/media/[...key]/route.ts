/**
 * Media delivery.
 *
 * Listing photos are referenced by storage key throughout the domain. This
 * route is the single place that turns a key into bytes, which is what makes
 * the storage backend swappable (spec §54, and the media/documents bucket
 * split enforced in runtime.ts).
 *
 * STATE OF PLAY, stated plainly: no object storage is configured yet, so there
 * are no real photographs to serve. Rather than 404 — which renders a broken
 * image on every card and makes the interface impossible to evaluate — this
 * returns a deterministic generated placeholder derived from the key.
 *
 * It is deliberately obviously a placeholder: a flat tinted panel with the
 * cornflower mark. It must never be mistaken for a real photograph, because
 * pretending a photo exists is exactly the kind of fake completion this
 * project refuses. Identity documents are NOT served here under any
 * circumstances — they live in a separate private bucket behind
 * `document.read` and an access log.
 */

import { createHash } from 'node:crypto';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** Muted, desaturated tints. These read as "no photo yet", not as decoration. */
const TINTS: readonly [string, string][] = [
  ['#dfe6f2', '#c8d3e6'],
  ['#e2ebfc', '#c6d8f8'],
  ['#e6ecf3', '#d2dbe6'],
  ['#e9eef6', '#cfd9e8'],
  ['#dde7f4', '#c2d1e6'],
];

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ key: string[] }> },
): Promise<Response> {
  const { key } = await params;
  const storageKey = key.join('/');

  // A key must never be able to escape its namespace or reach the private
  // document bucket by path traversal.
  if (storageKey.includes('..') || storageKey.startsWith('private/')) {
    return new Response('Not found', { status: 404 });
  }

  const mediaBucket = process.env.MEDIA_BUCKET_URL;
  if (mediaBucket) {
    // Real storage configured: redirect to it. A signed-URL implementation
    // replaces this line when the provider is chosen.
    return Response.redirect(`${mediaBucket.replace(/\/$/, '')}/${storageKey}`, 302);
  }

  const digest = createHash('sha256').update(storageKey).digest();
  const [from, to] = TINTS[digest[0]! % TINTS.length]!;
  const rotation = (digest[1]! % 40) - 20;

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 900 600" width="900" height="600">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="${from}"/>
      <stop offset="1" stop-color="${to}"/>
    </linearGradient>
  </defs>
  <rect width="900" height="600" fill="url(#g)"/>
  <g transform="translate(450 300) rotate(${rotation}) scale(3.2) translate(-16 -16)" fill="#ffffff" opacity="0.55">
    <path d="M16 5.4 L18.4 9.2 L17.3 10.6 L18.1 12.6 L16 14 L13.9 12.6 L14.7 10.6 L13.6 9.2 Z"/>
    <path d="M16 5.4 L18.4 9.2 L17.3 10.6 L18.1 12.6 L16 14 L13.9 12.6 L14.7 10.6 L13.6 9.2 Z" transform="rotate(72 16 16)"/>
    <path d="M16 5.4 L18.4 9.2 L17.3 10.6 L18.1 12.6 L16 14 L13.9 12.6 L14.7 10.6 L13.6 9.2 Z" transform="rotate(144 16 16)"/>
    <path d="M16 5.4 L18.4 9.2 L17.3 10.6 L18.1 12.6 L16 14 L13.9 12.6 L14.7 10.6 L13.6 9.2 Z" transform="rotate(216 16 16)"/>
    <path d="M16 5.4 L18.4 9.2 L17.3 10.6 L18.1 12.6 L16 14 L13.9 12.6 L14.7 10.6 L13.6 9.2 Z" transform="rotate(288 16 16)"/>
    <circle cx="16" cy="16" r="3.1"/>
  </g>
</svg>`;

  return new Response(svg, {
    status: 200,
    headers: {
      'content-type': 'image/svg+xml; charset=utf-8',
      // Deterministic from the key, so it is safe to cache hard.
      'cache-control': 'public, max-age=3600',
      'x-media-placeholder': 'true',
    },
  });
}
