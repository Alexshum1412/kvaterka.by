/**
 * Session access for server components.
 *
 * Reads the same HttpOnly cookie the API dispatcher reads, through the same
 * `resolveSession`, so a page and an endpoint can never disagree about who the
 * caller is. Pages never receive the raw token — only the resolved identity.
 */

import { cache } from 'react';
import { cookies } from 'next/headers';
import { SESSION_COOKIE } from './api/router.ts';
import { readyServices } from './runtime.ts';
import type { Role } from './auth/rbac.ts';

export interface PageCaller {
  readonly userId: string;
  readonly sessionId: string;
  /**
   * EFFECTIVE roles. A staff member who has not satisfied their second factor
   * carries none of their staff grants here, so every `can()` on every page
   * denies without the page needing to know that 2FA exists.
   */
  readonly roles: readonly Role[];
  readonly displayName: string;
  readonly emailVerified: boolean;
  /** Held but withheld — the page shows a prompt instead of a bare 404. */
  readonly withheldRoles: readonly Role[];
  readonly twoFactorEnrolled: boolean;
}

/**
 * Memoised for the lifetime of one request. The layout, the header and the
 * page itself all need to know who is calling, and without this each of
 * them costs a separate session lookup on every render.
 */
export const currentUser = cache(async (): Promise<PageCaller | null> => {
  const store = await cookies();
  const token = store.get(SESSION_COOKIE)?.value;
  if (!token) return null;

  const services = await readyServices();
  const session = await services.auth.resolveSession(token);
  if (!session) return null;

  return {
    userId: session.userId,
    sessionId: session.sessionId,
    roles: session.roles,
    displayName: session.displayName,
    emailVerified: session.emailVerified,
    withheldRoles: session.withheldRoles,
    twoFactorEnrolled: session.twoFactorEnrolled,
  };
});

/** Redirect to sign-in, preserving where the user was heading. */
export function signInUrl(returnTo: string): string {
  return `/login?next=${encodeURIComponent(returnTo)}`;
}
