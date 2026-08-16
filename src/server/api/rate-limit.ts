/**
 * Fixed-window rate limiting backed by the database.
 *
 * DEC-019: Redis would be faster, but a counter in process memory is wrong the
 * moment there is more than one instance — and being wrong about a login limit
 * is exactly the failure that matters. PostgreSQL gives a shared, correct
 * counter with one upsert per request, which is affordable at MVP volume.
 */

import { createHash } from 'node:crypto';
import type { Sql } from '../db/sql.ts';
import { DomainError } from '../services/errors.ts';

export interface RateLimitResult {
  readonly allowed: boolean;
  readonly limit: number;
  readonly remaining: number;
  readonly resetAt: Date;
}

/** IPs are hashed before they are used as a bucket key, as they are anywhere else. */
export const bucketForIp = (name: string, ip: string | null): string =>
  `${name}:ip:${ip ? createHash('sha256').update(ip).digest('hex').slice(0, 32) : 'unknown'}`;

export const bucketForUser = (name: string, userId: string): string => `${name}:user:${userId}`;

export async function checkRateLimit(
  sql: Sql,
  bucket: string,
  limit: number,
  windowSeconds: number,
  now: Date = new Date(),
): Promise<RateLimitResult> {
  // Align to a fixed window so concurrent requests share one row and the
  // upsert below can settle contention atomically.
  const windowMs = windowSeconds * 1000;
  const windowStart = new Date(Math.floor(now.getTime() / windowMs) * windowMs);

  const { rows } = await sql.query<{ hits: number }>(
    `INSERT INTO rate_limit_counter (bucket, window_start, hits)
     VALUES ($1, $2, 1)
     ON CONFLICT (bucket, window_start)
     DO UPDATE SET hits = rate_limit_counter.hits + 1
     RETURNING hits`,
    [bucket, windowStart.toISOString()],
  );

  const hits = Number(rows[0]?.hits ?? 1);
  return {
    allowed: hits <= limit,
    limit,
    remaining: Math.max(0, limit - hits),
    resetAt: new Date(windowStart.getTime() + windowMs),
  };
}

export function rateLimitError(result: RateLimitResult): DomainError {
  const seconds = Math.max(1, Math.ceil((result.resetAt.getTime() - Date.now()) / 1000));
  return new DomainError('RATE_LIMITED', 'Слишком много запросов. Попробуйте позже.', {
    retryAfterSeconds: seconds,
  });
}

/** Housekeeping for the scheduled worker. */
export async function pruneRateLimitCounters(sql: Sql, olderThanHours = 24): Promise<number> {
  const { rowCount } = await sql.query(
    `DELETE FROM rate_limit_counter WHERE window_start < now() - ($1 || ' hours')::interval`,
    [String(olderThanHours)],
  );
  return rowCount;
}
