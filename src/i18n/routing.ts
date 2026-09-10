/**
 * The three locales the platform serves, and how they show up in the URL.
 *
 * `localePrefix: 'as-needed'` keeps Russian — the only locale anything was
 * ever indexed or bookmarked under — unprefixed at `/…`, exactly as it was
 * before this file existed. Belarusian and English get a real prefix
 * (`/be/…`, `/en/…`): a separate, shareable, separately-indexable URL per
 * language, not a cookie that silently changes what the same link shows.
 */
import { defineRouting } from 'next-intl/routing';

export const routing = defineRouting({
  locales: ['ru', 'be', 'en'],
  defaultLocale: 'ru',
  localePrefix: 'as-needed',
});

export type AppLocale = (typeof routing.locales)[number];
