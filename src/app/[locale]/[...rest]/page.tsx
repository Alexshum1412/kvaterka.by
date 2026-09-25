import { notFound } from 'next/navigation';

/**
 * Any address that matches no route under a locale.
 *
 * `[locale]/not-found.tsx` only renders for a `notFound()` thrown inside the
 * `[locale]` tree. A path that matches nothing at all never enters that tree,
 * so it fell through to the framework's bare English "This page could not be
 * found." — no header, no brand, no way back. Catching the rest of the path
 * here and throwing from inside the tree routes every mistyped URL to the
 * localized 404 instead. Static and dynamic routes still win over a
 * catch-all, so this only ever sees what would otherwise have been a 404.
 */
export default function CatchAll() {
  notFound();
}
