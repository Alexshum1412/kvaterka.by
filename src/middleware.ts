import { NextResponse, NextRequest } from 'next/server';
import createIntlMiddleware from 'next-intl/middleware';
import { routing } from './i18n/routing.ts';

const handleI18nRouting = createIntlMiddleware(routing);

/**
 * Content Security Policy, with a per-request nonce — composed with locale
 * routing (next-intl).
 *
 * The nonce has to be set on the REQUEST headers before next-intl runs, not
 * added to its response afterwards: next-intl builds its own forwarded
 * headers from `request.headers` internally (`new Headers(request.headers)`,
 * read from its actual source), and a header added to the response object it
 * returns never reaches that internal copy. So this middleware rebuilds the
 * incoming request with `x-nonce` already set, then hands THAT to next-intl,
 * and only adds the CSP header to the response next-intl produces. Verified
 * against next-intl's middleware source rather than assumed.
 *
 * The other five headers — HSTS, nosniff, frame denial, Referrer-Policy,
 * Permissions-Policy — are static and live in `next.config.ts`. CSP cannot,
 * because the only version worth having names a nonce that changes on every
 * request, and a header in the config is one fixed string.
 *
 * WHAT THIS BUYS, AND WHAT IT DOES NOT
 *
 * `script-src` is the half that matters. With `'nonce-…'` and
 * `'strict-dynamic'`, a script executes only if the server marked it — so an
 * injected `<script>`, an `onclick` attribute, or a `javascript:` URL simply
 * does not run, whatever managed to get it into the page. That is the control
 * that turns an XSS bug from an account takeover into a rendering glitch.
 * React escapes by default and nothing here uses `dangerouslySetInnerHTML` on
 * user content, so this is a second line rather than the first.
 *
 * `style-src` keeps `'unsafe-inline'`, and that is a real weakening, stated
 * rather than hidden. Fifty-five components carry their styles in an inline
 * `<style>` block next to the markup they style — a deliberate choice this
 * codebase made long before CSP was on the table — and React does not attach a
 * nonce to those. The honest options were: weaken style-src, extract 55
 * stylesheets in a security change that touches every screen, or ship no CSP
 * at all. Inline STYLE cannot exfiltrate a session the way inline SCRIPT can;
 * its worst case is defacement and, with attribute selectors, some limited
 * data inference. Taking the strong half now beats waiting for the perfect one.
 *
 * `img-src` allows `data:` because the QR code on the two-factor screen is
 * drawn in the browser and never leaves it, which is the point of drawing it
 * there. The media bucket is added when configured, since listing photos
 * redirect to it. OpenStreetMap's tile hosts are allowed for the same
 * concrete reason: the Leaflet map panel requests raster tiles directly from
 * `*.tile.openstreetmap.org`, and nothing else on the site does.
 */

const STATIC_ASSET = /^\/(?:_next\/static|_next\/image|favicon\.ico|icon\.svg|robots\.txt|sitemap\.xml)/;

export default function middleware(request: NextRequest): NextResponse {
  // Static assets are served straight from disk and carry no markup, so a
  // per-request nonce would only defeat their caching.
  if (STATIC_ASSET.test(request.nextUrl.pathname)) return NextResponse.next();

  const nonce = crypto.randomUUID().replace(/-/g, '');
  const media = process.env.MEDIA_BUCKET_URL ?? '';

  // Rebuild the request with the nonce already on its headers, so
  // next-intl's own header-forwarding (rewrite for the unprefixed default
  // locale, or a plain pass-through for /be/… and /en/…) carries it along.
  const headersWithNonce = new Headers(request.headers);
  headersWithNonce.set('x-nonce', nonce);
  const requestWithNonce = new NextRequest(request, { headers: headersWithNonce });

  const response = handleI18nRouting(requestWithNonce);

  const policy = [
    `default-src 'self'`,
    // 'strict-dynamic' lets a nonced loader pull in the chunks it needs, which
    // is how the App Router bootstraps, without opening the door to anything
    // the server did not mark.
    // 'unsafe-eval' in development ONLY. Next's dev server compiles modules
    // through eval() for hot reload, so without it every page reloads into a
    // wall of CSP errors and nobody can work — and the temptation then is to
    // drop the policy altogether. A production build emits no eval, which is
    // why this is a development affordance rather than a permanent hole; the
    // browser check that found it was running against the dev server.
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic' 'unsafe-inline' https:${
      process.env.NODE_ENV === 'development' ? ` 'unsafe-eval'` : ''
    }`,
    `style-src 'self' 'unsafe-inline'`,
    // OpenStreetMap's tile servers, for the Leaflet map (LEGAL-014) — the
    // browser fetches these directly, so OSM's servers see the visitor's IP
    // for every tile the same way any third-party <img> host would.
    `img-src 'self' data: blob: https://*.tile.openstreetmap.org${media ? ` ${media}` : ''}`,
    `font-src 'self'`,
    // No third-party analytics, no external API. If that changes, this line is
    // the place it has to be argued for.
    `connect-src 'self'`,
    `object-src 'none'`,
    `base-uri 'self'`,
    // A login form that can POST elsewhere is a credential-harvesting bug.
    `form-action 'self'`,
    // Belt and braces with X-Frame-Options, which older browsers honour and
    // this directive supersedes.
    `frame-ancestors 'none'`,
    /* Not on a plain-http loopback host. There is no https://localhost to
       upgrade to, so the directive turned next-intl's own /ru/… → /… redirect
       into a TLS error and broke client navigation in any local production
       build (`next start`) — which is exactly what the browser e2e suite runs.
       A public host never matches, so production keeps the directive. */
    ...(isLoopback(request.nextUrl.hostname) ? [] : [`upgrade-insecure-requests`]),
  ].join('; ');

  /* The nonce travels on the request (set above, before next-intl ran) so the
     framework can stamp its own scripts with it; browsers ignore
     'unsafe-inline' when a nonce is present, so the fallback above is only
     read by browsers too old for nonces. */
  response.headers.set('Content-Security-Policy', policy);
  return response;
}

function isLoopback(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]';
}

export const config = {
  matcher: [
    /* Everything except the static assets handled above, the API (which
       returns JSON: a policy on a payload no browser renders is noise, and the
       API's own error envelope is what governs there), and /media — the photo
       route lives outside the [locale] segment on purpose (a photograph is not
       localized content), so letting next-intl see it here would rewrite every
       image request to a /<locale>/media/... URL with no matching route,
       404ing every photo on the site. The web app manifest is excluded for
       the same reason: next-intl rewrote it to /ru/manifest.webmanifest,
       which has no route, so every browser asking for it got a 404. */
    '/((?!api|_next/static|_next/image|favicon.ico|media|manifest.webmanifest).*)',
  ],
};
