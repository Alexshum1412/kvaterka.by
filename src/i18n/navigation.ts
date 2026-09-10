/**
 * Locale-aware navigation primitives.
 *
 * Use these instead of `next/link` and `next/navigation` everywhere inside
 * `src/app/[locale]/**` and the components it renders: a plain `next/link`
 * `Link` forgets the current locale prefix on every click, which is a silent
 * "your language reset" bug rather than a loud one.
 */
import { createNavigation } from 'next-intl/navigation';
import { routing } from './routing.ts';

export const { Link, redirect, usePathname, useRouter, getPathname } = createNavigation(routing);
