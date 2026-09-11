/**
 * "Sign in with Google" — step 2, where Google sends the browser back.
 *
 * Exchanges the authorization code for an id_token server-to-server (the
 * client secret never touches the browser), verifies that token's signature
 * the cheap way — asking Google's own tokeninfo endpoint rather than
 * fetching and caching Google's JWKS and verifying a JWT signature by hand,
 * a real difference in code for a login flow that is not on any hot path —
 * and hands the verified claims to `continueWithGoogle`, which already knows
 * how to turn them into a session (new account, linked account, or existing
 * Google sign-in).
 *
 * Every failure here redirects to `/login?error=...` rather than rendering
 * an error page of its own: the login screen is where "try again" already
 * lives, and a second error surface would just be a second thing to keep in
 * sync with it.
 */
import { env } from '@/server/runtime.ts';
import { readyServices } from '@/server/runtime.ts';
import { DomainError } from '@/server/services/errors.ts';
import { sessionCookie } from '@/server/api/routes/auth.ts';
import { SESSION_TTL_DAYS } from '@/server/auth/auth-service.ts';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const STATE_COOKIE = 'kv_google_state';
const NEXT_COOKIE = 'kv_google_next';

function readCookie(request: Request, name: string): string | null {
  const cookie = request.headers.get('cookie');
  if (!cookie) return null;
  for (const part of cookie.split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name && rest.length > 0) return decodeURIComponent(rest.join('='));
  }
  return null;
}

function clearedCookie(name: string): string {
  return `${name}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}

function failure(baseUrl: string, code: string): Response {
  return Response.redirect(`${baseUrl}/login?error=${code}`, 302);
}

interface GoogleTokenResponse {
  readonly id_token?: string;
  readonly error?: string;
}

interface GoogleTokenInfo {
  readonly aud?: string;
  readonly sub?: string;
  readonly email?: string;
  readonly email_verified?: string;
  readonly name?: string;
}

export async function GET(request: Request): Promise<Response> {
  const config = env();
  const baseUrl = config.PUBLIC_BASE_URL;

  if (!config.GOOGLE_CLIENT_ID || !config.GOOGLE_CLIENT_SECRET) {
    return failure(baseUrl, 'google_unconfigured');
  }

  const url = new URL(request.url);
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  const googleError = url.searchParams.get('error');
  const expectedState = readCookie(request, STATE_COOKIE);
  const next = readCookie(request, NEXT_COOKIE) ?? '/dashboard';

  const clearStateCookies = [clearedCookie(STATE_COOKIE), clearedCookie(NEXT_COOKIE)];

  if (googleError) {
    // The person declined on Google's own consent screen — not a bug.
    return failure(baseUrl, 'google_cancelled');
  }
  if (!code || !state || !expectedState || state !== expectedState) {
    return failure(baseUrl, 'google_state_mismatch');
  }

  try {
    const redirectUri = `${baseUrl}/api/auth/google/callback`;
    const tokenResponse = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: config.GOOGLE_CLIENT_ID,
        client_secret: config.GOOGLE_CLIENT_SECRET,
        redirect_uri: redirectUri,
        grant_type: 'authorization_code',
      }),
    });
    const tokenBody = (await tokenResponse.json()) as GoogleTokenResponse;
    if (!tokenResponse.ok || !tokenBody.id_token) {
      return failure(baseUrl, 'google_token_exchange_failed');
    }

    // Verified server-side by Google itself: a forged or expired id_token is
    // rejected by this call before any claim in it is trusted.
    const infoResponse = await fetch(
      `https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(tokenBody.id_token)}`,
    );
    if (!infoResponse.ok) return failure(baseUrl, 'google_token_invalid');
    const info = (await infoResponse.json()) as GoogleTokenInfo;

    // tokeninfo verifies the signature; it does NOT check who the token was
    // issued for. Skipping this line would accept a token minted for a
    // completely different application that also happens to use Google
    // sign-in — the audience check is what makes this OUR login.
    if (info.aud !== config.GOOGLE_CLIENT_ID || !info.sub || !info.email) {
      return failure(baseUrl, 'google_token_invalid');
    }

    const services = await readyServices();
    const { session } = await services.auth.continueWithGoogle(
      {
        sub: info.sub,
        email: info.email,
        emailVerified: info.email_verified === 'true',
        name: info.name ?? null,
      },
      {
        ip: request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null,
        userAgent: request.headers.get('user-agent'),
      },
    );

    const headers = new Headers({ Location: `${baseUrl}${next}` });
    headers.append('Set-Cookie', sessionCookie(session.token, SESSION_TTL_DAYS * 86_400));
    for (const c of clearStateCookies) headers.append('Set-Cookie', c);
    return new Response(null, { status: 302, headers });
  } catch (error) {
    const code = error instanceof DomainError ? 'google_denied' : 'google_error';
    const headers = new Headers({ Location: `${baseUrl}/login?error=${code}` });
    for (const c of clearStateCookies) headers.append('Set-Cookie', c);
    return new Response(null, { status: 302, headers });
  }
}
