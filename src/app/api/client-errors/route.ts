/**
 * Where the browser reports a crash (DEC-086).
 *
 * `[locale]/error.tsx` and `global-error.tsx` POST here when they render, so
 * a page that breaks in visitors' browsers shows up in `error_event` — and in
 * the watchdog's alerts — instead of only in a console nobody reads.
 *
 * Anonymous by necessity (a crash can happen before or without a session), so
 * it takes no identity, stores no IP, clips everything it keeps, and is
 * limited per IP so it cannot be used to flood the table.
 */

import { z } from 'zod';
import { ready } from '@/server/runtime.ts';
import { bucketForIp, checkRateLimit } from '@/server/api/rate-limit.ts';
import { recordError } from '@/server/services/error-log.ts';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const Body = z.object({
  message: z.string().max(2000),
  path: z.string().max(2000).optional(),
});

export async function POST(request: Request): Promise<Response> {
  const sql = await ready();
  const ip = request.headers.get('x-real-ip') ?? request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null;
  const limit = await checkRateLimit(sql, bucketForIp('client-errors', ip), 30, 3600);
  if (!limit.allowed) return new Response(null, { status: 429 });

  const text = (await request.text()).slice(0, 5000);
  let parsed: z.infer<typeof Body>;
  try {
    parsed = Body.parse(JSON.parse(text));
  } catch {
    return new Response(null, { status: 400 });
  }
  await recordError(sql, { source: 'CLIENT', message: parsed.message, path: parsed.path ?? null });
  return new Response(null, { status: 204 });
}
