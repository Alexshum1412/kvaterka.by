'use client';

import { useEffect, useState } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { api, ApiError } from '@/lib/api-client.ts';
import { Icon } from './icons.tsx';

/**
 * Save a listing.
 *
 * Two things make this less trivial than it looks.
 *
 * A page renders up to two dozen cards, and each one needs to know
 * whether it is already saved. Asking per card would be a request per
 * card, so the whole set is fetched ONCE per page load and shared
 * through a module-level promise. Pages that already know the answer
 * server-side pass `initial` and skip the fetch entirely.
 *
 * And a signed-out visitor must get somewhere useful rather than an
 * error. There is no local shortlist to fall back on — pretending to
 * save something that is not saved anywhere would be a lie the user only
 * discovers after losing the flat they liked — so the control sends them
 * to sign in, remembering where they were.
 */

let savedIds: Promise<Set<string>> | null = null;

/** The layout stamps this on <body>; absent means "assume signed out". */
function signedIn(): boolean {
  return typeof document !== 'undefined' && document.body.dataset.auth === 'user';
}

function loadSavedIds(): Promise<Set<string>> {
  // Asking on behalf of a signed-out visitor can only ever 401, so don't.
  if (!signedIn()) return Promise.resolve(new Set<string>());
  savedIds ??= api
    .get<{ propertyIds: string[] }>('/favorites')
    .then((r) => new Set(r.propertyIds))
    .catch(() => new Set<string>());
  return savedIds;
}

/** Called after sign-in or sign-out so the next page does not reuse a stale set. */
export function resetFavouriteCache(): void {
  savedIds = null;
}

export function FavouriteButton({
  propertyId,
  initial,
  className,
}: {
  propertyId: string;
  initial?: boolean;
  className?: string;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const [saved, setSaved] = useState(initial ?? false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (initial !== undefined) return;
    let live = true;
    void loadSavedIds().then((set) => {
      if (live) setSaved(set.has(propertyId));
    });
    return () => {
      live = false;
    };
  }, [propertyId, initial]);

  async function toggle(event: React.MouseEvent) {
    // The card around this is a link; saving must not navigate.
    event.preventDefault();
    event.stopPropagation();
    if (busy) return;

    // A signed-out visitor gets somewhere useful instead of a failed
    // request and a heart that fills in and then empties again.
    if (!signedIn()) {
      router.push(`/login?next=${encodeURIComponent(pathname)}`);
      return;
    }

    const next = !saved;
    setSaved(next);
    setBusy(true);
    try {
      if (next) await api.put(`/favorites/${propertyId}`);
      else await api.delete(`/favorites/${propertyId}`);
      const set = await loadSavedIds();
      if (next) set.add(propertyId);
      else set.delete(propertyId);
    } catch (error) {
      setSaved(!next);
      if (error instanceof ApiError && error.status === 401) {
        router.push(`/login?next=${encodeURIComponent(pathname)}`);
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <button
      type="button"
      className={className ? `fav ${className}` : 'fav'}
      onClick={toggle}
      aria-pressed={saved}
      aria-label={saved ? 'Убрать из избранного' : 'Сохранить в избранное'}
      data-saved={saved ? 'true' : 'false'}
    >
      <Icon name="heart" size={19} solid={saved} />

      <style>{`
        .fav {
          position: relative;
          display: grid;
          place-items: center;
          width: 2.5rem;
          height: 2.5rem;
          padding: 0;
          border: 0;
          border-radius: var(--radius-full);
          /* Sits on a photograph, so it needs its own ground rather than
             a translucent tint that disappears over a pale interior. */
          background: color-mix(in srgb, var(--surface) 88%, transparent);
          backdrop-filter: blur(2px);
          color: var(--text-primary);
          cursor: pointer;
          box-shadow: var(--shadow-subtle);
          transition: background-color 140ms ease, color 140ms ease, transform 140ms ease;
        }
        /* The circle stays 40px so it does not crowd the photograph; the
           pseudo-element takes the hit area out to the full 44px. */
        .fav::before {
          content: '';
          position: absolute;
          inset: -0.125rem;
          border-radius: inherit;
        }
        .fav:hover { background: var(--surface); transform: scale(1.06); }
        .fav:active { transform: scale(0.96); }
        .fav[data-saved='true'] { color: var(--primary); background: var(--surface); }
      `}</style>
    </button>
  );
}
