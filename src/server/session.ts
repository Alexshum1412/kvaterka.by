/**
 * Session access for server components.
 *
 * Reads the same HttpOnly cookie the API dispatcher reads, through the same
 * `resolveSession`, so a page and an endpoint can never disagree about who the
 * caller is. Pages never receive the raw token — only the resolved identity.
 */

import { cookies } from 'next/headers';
import { SESSION_COOKIE } from './api/router.ts';
import { readyServices } from './runtime.ts';
import type { Role } from './auth/rbac.ts';

export interface PageCaller {
  readonly userId: string;
  readonly sessionId: string;
  readonly roles: readonly Role[];
  readonly displayName: string;
  readonly emailVerified: boolean;
}

export async function currentUser(): Promise<PageCaller | null> {
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
  };
}

/** Redirect to sign-in, preserving where the user was heading. */
export function signInUrl(returnTo: string): string {
  return `/login?next=${encodeURIComponent(returnTo)}`;
}
