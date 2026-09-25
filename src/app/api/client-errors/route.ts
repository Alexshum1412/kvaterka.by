/**
 * Where the browser reports a crash (DEC-086).
 *
 * `[locale]/error.tsx` and `global-error.tsx` POST here when they render, so
 * a page that breaks in visitors' browsers shows up in `error_event` — and in
 * the watchdog's alerts — instead of only in a console nobody reads.
 *
 * Anonymous by necessity (a crash can happen before or without a session), so
 * it takes no identity, stores no IP, and bounds everything it accepts: the
 * body is capped in bytes while it is read, not after it is buffered; the
 * text is clipped by `recordError`; and requests are limited per IP AND across
 * all callers, because the IP comes from a header a client can rewrite and a
 * per-IP limit alone is then no limit.
 */

import { z } from 'zod';
import { ready } from '@/server/runtime.ts';
import { bucketForIp, checkRateLimit } from '@/server/api/rate-limit.ts';
import { recordError } from '@/server/services/error-log.ts';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** A report is a message and a path; anything longer is not one. */
const MAX_BODY_BYTES = 8 * 1024;
const GLOBAL_PER_MINUTE = 60;

/* No `.max()` on the strings: a crash report whose message is long is still a
   crash report, and rejecting it lost it. The byte cap bounds the input and
   `recordError` clips what is stored. */
const Body = z.object({
  message: z.string(),
  path: z.string().optional(),
});

/** The body as text, or null once it grows past `max` bytes (the rest is never read). */
async function readCapped(request: Request, max: number): Promise<string | null> {
  const reader = request.body?.getReader();
  if (!reader) return '';
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

export async function POST(request: Request): Promise<Response> {
  const declared = Number(request.headers.get('content-length'));
  if (declared > MAX_BODY_BYTES) return new Response(null, { status: 413 });

  const sql = await ready();
  const ip = request.headers.get('x-real-ip') ?? request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null;
  const limit = await checkRateLimit(sql, bucketForIp('client-errors', ip), 30, 3600);
  if (!limit.allowed) return new Response(null, { status: 429 });
  const overall = await checkRateLimit(sql, 'client-errors:all', GLOBAL_PER_MINUTE, 60);
  if (!overall.allowed) return new Response(null, { status: 429 });

  let parsed: z.infer<typeof Body>;
  try {
    const text = await readCapped(request, MAX_BODY_BYTES);
    if (text === null) return new Response(null, { status: 413 });
    parsed = Body.parse(JSON.parse(text));
  } catch {
    return new Response(null, { status: 400 });
  }
  await recordError(sql, { source: 'CLIENT', message: parsed.message, path: parsed.path ?? null });
  return new Response(null, { status: 204 });
}
