/**
 * "Sign in with Google" — step 1, the redirect to Google.
 *
 * Sits outside the JSON route table for the same reason `/api/uploads` and
 * the Telegram webhook do: this is a browser navigation that ends in a 302,
 * not a JSON request/response the dispatcher's shape expects.
 *
 * `state` is a CSRF guard, not a login secret: it proves the browser that
 * lands on the callback is the same one that started here, so a link into
 * the callback crafted by someone else (with a `code` they obtained some
 * other way) cannot be replayed against this session. It travels in a
 * short-lived, httpOnly, SameSite=Lax cookie rather than in the URL, so nothing
 * in server logs or a referrer header can leak a value that matters.
 */
import { env } from '@/server/runtime.ts';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const STATE_COOKIE = 'kv_google_state';
const NEXT_COOKIE = 'kv_google_next';

function randomState(): string {
  // 24 bytes of entropy, base64url — plenty for a CSRF token nobody needs to
  // type, and short enough to be an unremarkable cookie value.
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return Buffer.from(bytes).toString('base64url');
}

export async function GET(request: Request): Promise<Response> {
  const config = env();
  const url = new URL(request.url);

  if (!config.GOOGLE_CLIENT_ID) {
    return Response.redirect(`${config.PUBLIC_BASE_URL}/login?error=google_unconfigured`, 302);
  }

  const next = url.searchParams.get('next');
  const safeNext = next && next.startsWith('/') && !next.startsWith('//') ? next : '/dashboard';

  const state = randomState();
  const redirectUri = `${config.PUBLIC_BASE_URL}/api/auth/google/callback`;

  const authUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  authUrl.searchParams.set('client_id', config.GOOGLE_CLIENT_ID);
  authUrl.searchParams.set('redirect_uri', redirectUri);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('scope', 'openid email profile');
  authUrl.searchParams.set('state', state);
  authUrl.searchParams.set('access_type', 'online');
  authUrl.searchParams.set('prompt', 'select_account');

  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  const headers = new Headers({ Location: authUrl.toString() });
  headers.append(
    'Set-Cookie',
    `${STATE_COOKIE}=${state}; Path=/; HttpOnly; SameSite=Lax; Max-Age=600${secure}`,
  );
  headers.append(
    'Set-Cookie',
    `${NEXT_COOKIE}=${encodeURIComponent(safeNext)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=600${secure}`,
  );

  return new Response(null, { status: 302, headers });
}
