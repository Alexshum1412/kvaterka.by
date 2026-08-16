/**
 * Endpoint-level idempotency.
 *
 * A client that retries after a timeout must not create a second booking or a
 * second review. Two layers cooperate:
 *
 *   1. This table, which replays the ORIGINAL response for a repeated key —
 *      so the caller sees the same booking id, not a confusing conflict.
 *   2. The domain guarantees underneath (unique constraints, the state machine),
 *      which hold even if a client sends no key at all.
 *
 * Neither layer is sufficient alone: (1) without (2) is defeated by a client
 * that forgets the header; (2) without (1) is correct but returns errors where
 * the caller expected success.
 */

import { createHash } from 'node:crypto';
import type { Db } from '../db/sql.ts';
import { hasErrorCode, PG_ERROR } from '../db/sql.ts';
import { DomainError } from '../services/errors.ts';
import type { ApiResponse } from './http.ts';

export const IDEMPOTENCY_HEADER = 'idempotency-key';
const MAX_KEY_LENGTH = 200;

/**
 * Normalise whatever the driver hands back for a `bytea` column.
 *
 * The two drivers disagree: node-postgres yields a Buffer, PGlite yields a
 * Uint8Array, and a `\x`-prefixed hex string is possible when a column is read
 * as text. `Buffer.isBuffer` is false for a Uint8Array, so a naive check
 * silently falls through to the wrong branch and every hash comparison fails —
 * which is exactly how a working idempotency replay turns into a 409.
 */
function toBuffer(value: Buffer | Uint8Array | string): Buffer {
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) return Buffer.from(value);
  return Buffer.from(value.replace(/^\\x/, ''), 'hex');
}

export function hashRequest(scope: string, body: unknown): Buffer {
  return createHash('sha256')
    .update(scope)
    .update('\n')
    .update(JSON.stringify(body ?? null))
    .digest();
}

export type IdempotencyLookup =
  | { readonly kind: 'PROCEED'; readonly recordId: number }
  | { readonly kind: 'REPLAY'; readonly response: ApiResponse };

/**
 * Claim a key, or return the stored response for one already completed.
 *
 * Throws when the same key arrives with a different payload — that is either a
 * client bug or an attempt to read back somebody else's result, and silently
 * replaying the wrong response would be worse than failing.
 */
export async function beginIdempotent(
  db: Db,
  userId: string,
  scope: string,
  key: string,
  body: unknown,
): Promise<IdempotencyLookup> {
  if (key.length > MAX_KEY_LENGTH) {
    throw new DomainError('VALIDATION_FAILED', 'Idempotency-Key слишком длинный');
  }

  const requestHash = hashRequest(scope, body);

  try {
    const { rows } = await db.query<{ id: number }>(
      `INSERT INTO idempotency_record (user_id, scope, key, request_hash)
       VALUES ($1,$2,$3,$4) RETURNING id`,
      [userId, scope, key, requestHash],
    );
    return { kind: 'PROCEED', recordId: Number(rows[0]!.id) };
  } catch (e) {
    if (!hasErrorCode(e, PG_ERROR.UNIQUE_VIOLATION)) throw e;
  }

  const { rows } = await db.query<{
    id: number;
    state: string;
    status_code: number | null;
    response_body: unknown;
    request_hash: Buffer | Uint8Array | string;
  }>(
    `SELECT id, state, status_code, response_body, request_hash
       FROM idempotency_record WHERE user_id=$1 AND scope=$2 AND key=$3`,
    [userId, scope, key],
  );

  const record = rows[0];
  if (!record) {
    // The row vanished between the insert conflict and this read (expiry sweep).
    // Treating it as a fresh request is safe: the domain guards still apply.
    return beginIdempotent(db, userId, scope, key, body);
  }

  const storedHash = toBuffer(record.request_hash);

  if (!storedHash.equals(requestHash)) {
    throw new DomainError(
      'CONFLICT',
      'Этот Idempotency-Key уже использован с другими данными',
    );
  }

  if (record.state === 'COMPLETED' && record.status_code !== null) {
    return {
      kind: 'REPLAY',
      response: {
        status: record.status_code,
        body: record.response_body,
        headers: { 'idempotent-replay': 'true' },
      },
    };
  }

  // An identical request is still in flight. Returning 409 rather than blocking
  // keeps a hung first attempt from holding the retry open indefinitely.
  throw new DomainError('CONFLICT', 'Запрос с этим Idempotency-Key ещё выполняется');
}

export async function completeIdempotent(
  db: Db,
  recordId: number,
  response: ApiResponse,
): Promise<void> {
  await db.query(
    `UPDATE idempotency_record
        SET state='COMPLETED', status_code=$2, response_body=$3::jsonb, completed_at=now()
      WHERE id=$1`,
    [recordId, response.status, JSON.stringify(response.body ?? null)],
  );
}

/**
 * Release a claimed key after a failure, so the client can genuinely retry.
 * Only successful responses are worth replaying.
 */
export async function abandonIdempotent(db: Db, recordId: number): Promise<void> {
  await db.query(`DELETE FROM idempotency_record WHERE id=$1 AND state='IN_PROGRESS'`, [recordId]);
}

export async function pruneIdempotencyRecords(db: Db): Promise<number> {
  const { rowCount } = await db.query(`DELETE FROM idempotency_record WHERE expires_at < now()`);
  return rowCount;
}
