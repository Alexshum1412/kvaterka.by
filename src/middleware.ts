import { NextResponse, type NextRequest } from 'next/server';

/**
 * Content Security Policy, with a per-request nonce.
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
 * redirect to it.
 */

const STATIC_ASSET = /^\/(?:_next\/static|_next\/image|favicon\.ico|icon\.svg|robots\.txt|sitemap\.xml)/;

export function middleware(request: NextRequest): NextResponse {
  // Static assets are served straight from disk and carry no markup, so a
  // per-request nonce would only defeat their caching.
  if (STATIC_ASSET.test(request.nextUrl.pathname)) return NextResponse.next();

  const nonce = crypto.randomUUID().replace(/-/g, '');
  const media = process.env.MEDIA_BUCKET_URL ?? '';

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
    `img-src 'self' data: blob:${media ? ` ${media}` : ''}`,
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
    `upgrade-insecure-requests`,
  ].join('; ');

  /* The nonce travels on the request so the framework can stamp its own
     scripts with it; browsers ignore 'unsafe-inline' when a nonce is present,
     so the fallback above is only read by browsers too old for nonces. */
  const headers = new Headers(request.headers);
  headers.set('x-nonce', nonce);

  const response = NextResponse.next({ request: { headers } });
  response.headers.set('Content-Security-Policy', policy);
  return response;
}

export const config = {
  matcher: [
    /* Everything except the static assets handled above and the API, which
       returns JSON: a policy on a payload no browser renders is noise, and the
       API's own error envelope is what governs there. */
    '/((?!api|_next/static|_next/image|favicon.ico).*)',
  ],
};
