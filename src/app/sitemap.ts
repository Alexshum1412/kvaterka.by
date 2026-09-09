import type { MetadataRoute } from 'next';
import { env } from '@/server/runtime.ts';

export const dynamic = 'force-dynamic';

/**
 * The static/marketing surface only — search results and listing pages are
 * not enumerated here. There is no bound on how many listings exist, a full
 * crawl of them is a database query per URL at build/request time, and
 * `/search` is already the correct entry point for a crawler to discover
 * them from links. This file is for the pages a crawler cannot otherwise
 * find a path to.
 *
 * Same fail-closed posture as `robots.ts`: nothing is worth listing on a
 * deployment nobody is meant to find yet.
 */
export default function sitemap(): MetadataRoute.Sitemap {
  if (!env().SITE_INDEXABLE) return [];

  const base = env().PUBLIC_BASE_URL.replace(/\/$/, '');
  const now = new Date();

  const pages: { path: string; priority: number; changeFrequency: MetadataRoute.Sitemap[number]['changeFrequency'] }[] = [
    { path: '/', priority: 1, changeFrequency: 'daily' },
    { path: '/search', priority: 0.9, changeFrequency: 'daily' },
    { path: '/how-it-works', priority: 0.5, changeFrequency: 'monthly' },
    { path: '/trust', priority: 0.5, changeFrequency: 'monthly' },
    { path: '/faq', priority: 0.5, changeFrequency: 'monthly' },
    { path: '/about', priority: 0.4, changeFrequency: 'monthly' },
    { path: '/host', priority: 0.6, changeFrequency: 'monthly' },
    { path: '/host/fees', priority: 0.4, changeFrequency: 'monthly' },
    { path: '/support', priority: 0.3, changeFrequency: 'monthly' },
    { path: '/terms', priority: 0.2, changeFrequency: 'yearly' },
    { path: '/privacy', priority: 0.2, changeFrequency: 'yearly' },
  ];

  return pages.map((p) => ({
    url: `${base}${p.path}`,
    lastModified: now,
    changeFrequency: p.changeFrequency,
    priority: p.priority,
  }));
}
