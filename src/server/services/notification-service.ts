/**
 * Notifications.
 *
 * Domain services never call an email or Telegram API directly — they enqueue a
 * row and return. A worker delivers it. That keeps a failing third party from
 * rolling back a booking, and makes delivery retryable.
 *
 * Two rules the schema enforces rather than trusts:
 *   - `(user_id, channel, dedupe_key)` is unique, so a re-run job cannot send
 *     the same message twice (spec §55).
 *   - Telegram is opt-in. `notifications.telegram` is checked per user, per
 *     category, and a message is SUPPRESSED rather than sent when consent is
 *     absent — never sent "just this once".
 */

import { uuidv7 } from '../../lib/id.ts';
import { hasErrorCode, PG_ERROR, type Db, type Sql } from '../db/sql.ts';
import { generateToken, hashToken } from '../auth/credentials.ts';
import { DomainError, invalid, notFound } from './errors.ts';
import { writeAudit } from './audit.ts';

export type Channel = 'IN_APP' | 'EMAIL' | 'TELEGRAM';

export const NOTIFICATION_CATEGORIES = [
  'BOOKING_REQUEST',
  'BOOKING_DECISION',
  'BOOKING_REMINDER',
  'BOOKING_CANCELLED',
  'MESSAGE',
  'CHECK_IN',
  'CHECK_OUT',
  'COMPLETION_REQUEST',
  'REVIEW_REQUEST',
  'REVIEW_PUBLISHED',
  'DEBT',
  'VERIFICATION',
  'SECURITY',
  'MODERATION',
] as const;

export type NotificationCategory = (typeof NOTIFICATION_CATEGORIES)[number];

/**
 * Categories a user cannot switch off in-app. Security notices and money owed
 * are not marketing; suppressing them would leave someone unaware their account
 * was accessed or that they have a debt.
 */
const MANDATORY_IN_APP: readonly NotificationCategory[] = ['SECURITY', 'DEBT', 'MODERATION'];

export interface EnqueueInput {
  readonly userId: string;
  readonly category: NotificationCategory;
  readonly dedupeKey: string;
  readonly payload?: Record<string, unknown>;
  readonly channels?: readonly Channel[];
}

export class NotificationService {
  constructor(private readonly db: Db) {}

  /**
   * Queue a notification on every channel the user permits.
   * Returns the channels actually queued — an empty array is a valid outcome.
   */
  async enqueue(input: EnqueueInput, tx?: Sql): Promise<readonly Channel[]> {
    const sql = tx ?? this.db;
    const requested = input.channels ?? (['IN_APP', 'EMAIL', 'TELEGRAM'] as const);
    const queued: Channel[] = [];

    for (const channel of requested) {
      const allowed = await this.channelAllowed(sql, input.userId, input.category, channel);
      const status = allowed ? 'PENDING' : 'SUPPRESSED';

      try {
        await sql.query(
          `INSERT INTO notification (id, user_id, category, channel, dedupe_key, payload, status)
           VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7)`,
          [
            uuidv7(),
            input.userId,
            input.category,
            channel,
            input.dedupeKey,
            JSON.stringify(input.payload ?? {}),
            status,
          ],
        );
        if (allowed) queued.push(channel);
      } catch (e) {
        // Already queued for this exact event: the dedupe key did its job.
        if (!hasErrorCode(e, PG_ERROR.UNIQUE_VIOLATION)) throw e;
      }
    }
    return queued;
  }

  private async channelAllowed(
    sql: Sql,
    userId: string,
    category: NotificationCategory,
    channel: Channel,
  ): Promise<boolean> {
    if (channel === 'IN_APP' && MANDATORY_IN_APP.includes(category)) return true;

    if (channel === 'TELEGRAM') {
      // No linked account means no consent, regardless of preferences.
      const { rows } = await sql.query<{ c: string }>(
        `SELECT count(*)::text AS c FROM telegram_connection
          WHERE user_id=$1 AND unlinked_at IS NULL`,
        [userId],
      );
      if (Number(rows[0]!.c) === 0) return false;
    }

    const { rows } = await sql.query<{ enabled: boolean }>(
      `SELECT enabled FROM notification_preference WHERE user_id=$1 AND category=$2 AND channel=$3`,
      [userId, category, channel],
    );

    // Default: in-app and email on, Telegram off until explicitly enabled.
    if (rows.length === 0) return channel !== 'TELEGRAM';
    return rows[0]!.enabled;
  }

  async setPreference(
    userId: string,
    category: NotificationCategory,
    channel: Channel,
    enabled: boolean,
  ): Promise<void> {
    if (!enabled && channel === 'IN_APP' && MANDATORY_IN_APP.includes(category)) {
      throw invalid('Эти уведомления нельзя отключить — они касаются безопасности и финансов');
    }
    await this.db.query(
      `INSERT INTO notification_preference (user_id, category, channel, enabled)
       VALUES ($1,$2,$3,$4)
       ON CONFLICT (user_id, category, channel) DO UPDATE SET enabled = EXCLUDED.enabled`,
      [userId, category, channel, enabled],
    );
  }

  async getPreferences(userId: string): Promise<Record<string, Record<string, boolean>>> {
    const { rows } = await this.db.query<{ category: string; channel: string; enabled: boolean }>(
      `SELECT category, channel, enabled FROM notification_preference WHERE user_id=$1`,
      [userId],
    );
    const out: Record<string, Record<string, boolean>> = {};
    for (const category of NOTIFICATION_CATEGORIES) {
      out[category] = {
        IN_APP: MANDATORY_IN_APP.includes(category),
        EMAIL: true,
        TELEGRAM: false,
      };
    }
    for (const r of rows) {
      (out[r.category] ??= {})[r.channel] = r.enabled;
    }
    for (const category of MANDATORY_IN_APP) out[category]!.IN_APP = true;
    return out;
  }

  async inbox(userId: string, limit = 30, offset = 0): Promise<Record<string, unknown>[]> {
    const { rows } = await this.db.query<Record<string, any>>(
      `SELECT id, category, payload, read_at, created_at
         FROM notification
        WHERE user_id=$1 AND channel='IN_APP' AND status <> 'SUPPRESSED'
        ORDER BY created_at DESC LIMIT $2 OFFSET $3`,
      [userId, Math.min(limit, 100), offset],
    );
    return rows.map((r) => ({
      id: r.id,
      category: r.category,
      payload: r.payload,
      readAt: r.read_at,
      createdAt: r.created_at,
    }));
  }

  async markRead(userId: string, notificationId?: string): Promise<number> {
    const { rowCount } = notificationId
      ? await this.db.query(
          `UPDATE notification SET read_at=now() WHERE user_id=$1 AND id=$2 AND read_at IS NULL`,
          [userId, notificationId],
        )
      : await this.db.query(
          `UPDATE notification SET read_at=now()
            WHERE user_id=$1 AND channel='IN_APP' AND read_at IS NULL`,
          [userId],
        );
    return rowCount;
  }

  /* ---------------------------------------------------------------- *
   * Telegram linking — explicit, revocable consent
   * ---------------------------------------------------------------- */

  async beginTelegramLink(userId: string): Promise<string> {
    const token = generateToken(16);
    await this.db.query(
      `INSERT INTO auth_token (id, user_id, purpose, token_hash, expires_at)
       VALUES ($1,$2,'TELEGRAM_LINK',$3, now() + interval '15 minutes')`,
      [uuidv7(), userId, hashToken(token)],
    );
    return token;
  }

  /** Called by the bot once the user confirms inside Telegram. */
  async completeTelegramLink(token: string, chatId: number, username?: string): Promise<string> {
    return this.db.transaction(async (tx) => {
      const { rows } = await tx.query<{ user_id: string }>(
        `UPDATE auth_token SET consumed_at=now()
          WHERE token_hash=$1 AND purpose='TELEGRAM_LINK' AND consumed_at IS NULL AND expires_at > now()
          RETURNING user_id`,
        [hashToken(token)],
      );
      const row = rows[0];
      if (!row) throw new DomainError('UNAUTHENTICATED', 'Код привязки недействителен или устарел');

      await tx.query(
        `INSERT INTO telegram_connection (user_id, telegram_chat_id, telegram_username)
         VALUES ($1,$2,$3)
         ON CONFLICT (user_id) DO UPDATE
           SET telegram_chat_id = EXCLUDED.telegram_chat_id,
               telegram_username = EXCLUDED.telegram_username,
               linked_at = now(), unlinked_at = NULL`,
        [row.user_id, chatId, username ?? null],
      );

      await writeAudit(tx, {
        actorUserId: row.user_id,
        action: 'telegram.link',
        targetType: 'user',
        targetId: row.user_id,
      });
      return row.user_id;
    });
  }

  async unlinkTelegram(userId: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      const { rowCount } = await tx.query(
        `UPDATE telegram_connection SET unlinked_at=now() WHERE user_id=$1 AND unlinked_at IS NULL`,
        [userId],
      );
      if (rowCount === 0) throw notFound('Привязка Telegram');
      // Withdrawing consent must also stop future sends, not just this link.
      await tx.query(
        `UPDATE notification_preference SET enabled=false WHERE user_id=$1 AND channel='TELEGRAM'`,
        [userId],
      );
      await writeAudit(tx, {
        actorUserId: userId,
        action: 'telegram.unlink',
        targetType: 'user',
        targetId: userId,
      });
    });
  }

  /* ---------------------------------------------------------------- */

  /** Outbox batch for the delivery worker. */
  async claimPending(limit = 50): Promise<Record<string, unknown>[]> {
    const { rows } = await this.db.query<Record<string, any>>(
      `SELECT id, user_id, category, channel, payload, attempts
         FROM notification
        WHERE status='PENDING' AND attempts < 5
        ORDER BY created_at LIMIT $1`,
      [limit],
    );
    return rows;
  }

  async markSent(notificationId: string): Promise<void> {
    await this.db.query(`UPDATE notification SET status='SENT', sent_at=now() WHERE id=$1`, [notificationId]);
  }

  async markFailed(notificationId: string, error: string): Promise<void> {
    await this.db.query(
      `UPDATE notification
          SET attempts = attempts + 1,
              last_error = $2,
              status = CASE WHEN attempts + 1 >= 5 THEN 'FAILED' ELSE 'PENDING' END
        WHERE id=$1`,
      [notificationId, error.slice(0, 500)],
    );
  }
}
