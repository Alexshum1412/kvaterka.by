import createNextIntlPlugin from 'next-intl/plugin';

const withNextIntl = createNextIntlPlugin('./src/i18n/request.ts');

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,

  // `next dev`'s own route indicator — never part of a build a visitor
  // sees — renders fixed over the bottom-left corner of every page. On
  // this layout that is never empty ground: it sits on the price in the
  // listing page's sticky booking bar, and on the "Список" tab in the
  // search page's bottom dock (`search-mobile-view.tsx`'s `.smv__dock`).
  // Every corner here carries a real control at some width (the header
  // fills both top corners, the two docks fill both bottom ones), so
  // there is no position that does not eventually sit on something —
  // off is the only placement that never covers a tap target or a price.
  devIndicators: false,

  // The server bundle must not try to bundle native/wasm database drivers.
  serverExternalPackages: ['pg', '@node-rs/argon2', '@electric-sql/pglite'],

  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=(self)' },
          {
            key: 'Strict-Transport-Security',
            value: 'max-age=31536000; includeSubDomains',
          },
        ],
      },
      {
        // Private surfaces must never be indexed (spec §59). Matched with and
        // without a locale prefix — `/dashboard/…` (ru, unprefixed) and
        // `/be/dashboard/…` / `/en/dashboard/…` are the same private surface.
        source: '/(dashboard|bookings|chat|settings)/:path*',
        headers: [{ key: 'X-Robots-Tag', value: 'noindex, nofollow' }],
      },
      {
        source: '/(be|en)/(dashboard|bookings|chat|settings)/:path*',
        headers: [{ key: 'X-Robots-Tag', value: 'noindex, nofollow' }],
      },
    ];
  },
};

export default withNextIntl(nextConfig);
