import { defineRoute, noContent, type AnyRoute } from '../http.ts';

/* ================================================================== *
 * Favourites
 *
 * PUT and DELETE rather than POST and a POST-to-unsave, because saving a
 * listing is a statement about desired state, not an event. Both verbs
 * are then idempotent by definition, which is exactly what a heart
 * button on a phone with a poor connection needs: no idempotency key, no
 * replay record, and no way for a double tap to produce a wrong result.
 *
 * No permission is declared. These are self-scoped — the caller's own
 * shortlist — and the authorization matrix test enumerates routes that
 * DO declare one, so adding a permission here would assert a privilege
 * that does not exist.
 * ================================================================== */

export const favoriteRoutes: AnyRoute[] = [
  defineRoute({
    method: 'GET',
    path: '/favorites',
    summary: 'Property ids the caller has saved',
    tags: ['favorites'],
    auth: 'required',
    async handler({ ctx, caller }) {
      return { propertyIds: await ctx.services.favorites.list(caller.userId) };
    },
  }),

  defineRoute({
    method: 'PUT',
    path: '/favorites/:propertyId',
    summary: 'Save a listing',
    tags: ['favorites'],
    auth: 'required',
    // Generous, because this is a one-tap control used while browsing,
    // but bounded so it cannot be run as an id-probing loop.
    rateLimit: { limit: 300, windowSeconds: 3600, by: 'user', bucket: 'favorite:write' },
    async handler({ params, ctx, caller }) {
      await ctx.services.favorites.add(caller.userId, params.propertyId!);
      return noContent();
    },
  }),

  defineRoute({
    method: 'DELETE',
    path: '/favorites/:propertyId',
    summary: 'Remove a saved listing',
    tags: ['favorites'],
    auth: 'required',
    rateLimit: { limit: 300, windowSeconds: 3600, by: 'user', bucket: 'favorite:write' },
    async handler({ params, ctx, caller }) {
      await ctx.services.favorites.remove(caller.userId, params.propertyId!);
      return noContent();
    },
  }),
];
