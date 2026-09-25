/**
 * Address geocoding proxy.
 *
 * Turns a host's typed address into a STARTING point for the listing-location
 * pin (`LocationPicker`, wired in from `listing-wizard.tsx`'s "Найти на карте"
 * button) — it never replaces manual placement, which stays the only thing a
 * listing actually needs to leave DRAFT (`property_complete_unless_draft`,
 * db/migrations/0008). A wrong or missing geocoding result degrades to
 * exactly what happens today: an empty pin the host drags into place by hand.
 *
 * PROVIDER CHOICE, FLAGGED (same posture as LEGAL-014 on `map-panel.tsx`/
 * `location-picker.tsx`, extended in docs/LEGAL.md for this route):
 * OpenStreetMap's Nominatim (https://nominatim.openstreetmap.org/search).
 * This product already sends every visitor's browser to OSM's tile servers
 * for the map itself, so Nominatim is the same ecosystem's standard geocoder
 * rather than a new third-party relationship — but it IS a new data flow (the
 * host's typed address text, not just a coordinate, now reaches OSM's
 * servers) and is called out as such rather than folded silently into the
 * existing tile-provider decision.
 *
 * WHY THIS RUNS ON THE SERVER, NOT THE BROWSER. Two independent reasons, both
 * required by Nominatim's usage policy (https://operations.osmfoundation.org/
 * policies/nominatim/): requests must carry a real identifying User-Agent or
 * Referer, which a browser's own fetch would send as this SITE's origin, not
 * as a client library naming itself honestly — and Nominatim's CORS policy is
 * unreliable enough that a browser-side call is also just fragile. Both are
 * fixed by making the call from here, where the header is one line and the
 * browser never talks to nominatim.openstreetmap.org at all.
 *
 * ALWAYS DEGRADES TO "NOTHING FOUND" (HTTP 200, `{ result: null }`), never a
 * hard error, for: no match, a malformed upstream response, a network
 * failure, and an upstream non-2xx (429 included — Nominatim's own rate
 * limit). Geocoding is a convenience layered on the always-available manual
 * pin, and the wizard's job is to fall back quietly, not to explain an HTTP
 * status a host typing an address has no reason to see.
 *
 * NOT RATE-LIMITED HERE beyond requiring a signed-in caller (this project's
 * `rate_limit_counter` machinery lives behind the JSON route table this file
 * deliberately sits outside of, the same way `uploads/route.ts` does) — the
 * real throttle is the wizard only calling this on an explicit button press,
 * never per keystroke, which is what actually bounds request volume against
 * the free public instance.
 */

import { currentUser } from '@/server/session.ts';
import { isValidLatLng, isWithinBelarus } from '@/server/domain/geo.ts';
import { ready } from '@/server/runtime.ts';
import { bucketForUser, checkRateLimit } from '@/server/api/rate-limit.ts';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const NOMINATIM_SEARCH_URL = 'https://nominatim.openstreetmap.org/search';
const REQUEST_TIMEOUT_MS = 5_000;
const MIN_QUERY_LENGTH = 3;
/** An address, not an essay: Nominatim gains nothing past this. */
const MAX_QUERY_LENGTH = 200;
/* Nominatim's usage policy allows one request a second for the whole app and
   bans the sending IP for more. This route had no limit at all, so a single
   signed-in account in a loop could get the server banned and take the
   wizard's "find on map" away from every host. 30 lookups per 10 minutes is
   several attempts per listing for a real person.
   ponytail: per account, not global — a crowd of accounts could still exceed
   1 rps together; a shared 1-per-second bucket is the upgrade if that ever
   shows up in the logs. */
const LOOKUPS_PER_WINDOW = 30;
const WINDOW_SECONDS = 600;

/** Not a secret: an env var only so a fork/staging deployment can point the
 *  identifying header at its own domain instead of this one's. */
const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL ?? 'http://localhost:3000').replace(/\/$/, '');

export interface GeocodeResult {
  readonly latitude: number;
  readonly longitude: number;
  readonly displayName: string;
}

function fail(status: number, code: string, message: string): Response {
  return Response.json({ error: { code, message } }, { status });
}

/** The one shape every "could not geocode" reason collapses to — see the
 *  file header's "ALWAYS DEGRADES" note for why this is 200, not an error. */
function nothingFound(): Response {
  return Response.json({ result: null }, { status: 200 });
}

interface NominatimRow {
  readonly lat?: unknown;
  readonly lon?: unknown;
  readonly display_name?: unknown;
}

export async function GET(request: Request): Promise<Response> {
  // Requires a session, not a specific role: a listing draft already exists
  // by the time a host reaches this wizard step (0008), so "signed in" is the
  // whole bar. This also keeps the proxy from being an anonymous, open relay
  // in front of the free public Nominatim instance.
  const user = await currentUser();
  if (!user) return fail(401, 'UNAUTHENTICATED', 'Войдите, чтобы искать адрес на карте');

  const q = (new URL(request.url).searchParams.get('q') ?? '').trim();
  if (q.length < MIN_QUERY_LENGTH) {
    return fail(400, 'QUERY_TOO_SHORT', 'Введите больше символов адреса');
  }
  if (q.length > MAX_QUERY_LENGTH) {
    return fail(400, 'QUERY_TOO_LONG', 'Адрес слишком длинный — оставьте город, улицу и дом');
  }

  const limit = await checkRateLimit(await ready(), bucketForUser('geocode', user.userId), LOOKUPS_PER_WINDOW, WINDOW_SECONDS);
  if (!limit.allowed) {
    return fail(429, 'RATE_LIMITED', 'Слишком много поисков подряд. Поставьте метку на карте вручную или попробуйте позже.');
  }

  const upstreamUrl = new URL(NOMINATIM_SEARCH_URL);
  upstreamUrl.searchParams.set('q', q);
  upstreamUrl.searchParams.set('format', 'jsonv2');
  upstreamUrl.searchParams.set('limit', '1');
  // Launch-market restriction (matches `isWithinBelarus` below), and it also
  // narrows Nominatim's own search space for a query this ambiguous.
  upstreamUrl.searchParams.set('countrycodes', 'by');

  let upstream: Response;
  try {
    upstream = await fetch(upstreamUrl, {
      headers: {
        // Nominatim's usage policy requires a real identifying User-Agent or
        // Referer — the default one Node's fetch sends is neither, and gets
        // silently deprioritised or blocked. Both are set, redundantly, so
        // whichever the policy actually checks is satisfied.
        'User-Agent': `Kvaterka.by listing wizard (+${PUBLIC_BASE_URL})`,
        Referer: PUBLIC_BASE_URL,
        'Accept-Language': 'ru,be,en',
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch {
    // Network failure, DNS, or the timeout above firing.
    return nothingFound();
  }

  if (!upstream.ok) {
    // Covers 429 (rate limited) and any other non-2xx the free instance
    // returns under load — same graceful fallback either way.
    return nothingFound();
  }

  let rows: unknown;
  try {
    rows = await upstream.json();
  } catch {
    return nothingFound();
  }

  const first = Array.isArray(rows) ? (rows[0] as NominatimRow | undefined) : undefined;
  const latitude = Number(first?.lat);
  const longitude = Number(first?.lon);
  const point = { latitude, longitude };

  // Belt and braces on top of `countrycodes=by`: an ambiguous or malformed
  // query is exactly the case where trusting the upstream blindly would place
  // a pin somewhere confidently wrong rather than visibly absent. The same
  // `assertLocation` in listing-service.ts would refuse this point anyway the
  // moment the wizard tried to save it — this just fails closer to the cause.
  if (!first || !isValidLatLng(point) || !isWithinBelarus(point)) {
    return nothingFound();
  }

  const result: GeocodeResult = {
    latitude,
    longitude,
    displayName: typeof first.display_name === 'string' ? first.display_name : q,
  };
  return Response.json({ result }, { status: 200 });
}
