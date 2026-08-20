import type { MetadataRoute } from 'next';
import { env } from '@/server/runtime.ts';

export const dynamic = 'force-dynamic';

/**
 * Whether search engines may index this deployment at all.
 *
 * DEFAULTS TO NO, and that default is the point. The first deployment of this
 * platform is a closed staging one on the real domain: nobody is meant to find
 * it, sign up on it, or read a listing from it. A staging site indexed under
 * kvaterka.by would put demonstration flats and seeded people into search
 * results, and getting them back out again is somebody's week.
 *
 * Individual private surfaces already carry `robots: { index: false }` in their
 * own metadata — the dashboard, the staff consoles, the inbox, the reset page.
 * This is the whole-deployment switch above them, and it fails closed: a
 * deployment that forgets to set anything is not indexed. Turning it on is a
 * deliberate act performed once, when the product is genuinely launching.
 *
 * `SITE_INDEXABLE=true` is the only thing that opens it.
 */
export default function robots(): MetadataRoute.Robots {
  const base = env().PUBLIC_BASE_URL.replace(/\/$/, '');

  if (!env().SITE_INDEXABLE) {
    return {
      rules: [{ userAgent: '*', disallow: '/' }],
    };
  }

  return {
    rules: [
      {
        userAgent: '*',
        allow: '/',
        /* Belt and braces with the per-page metadata. A crawler that ignores
           one of these should still be told twice, and a future page added
           under these prefixes inherits the refusal rather than having to
           remember it. */
        disallow: ['/dashboard/', '/staff/', '/moderation/', '/notifications', '/bookings/', '/api/'],
      },
    ],
    sitemap: `${base}/sitemap.xml`,
  };
}
