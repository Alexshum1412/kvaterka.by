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
 * The one line that leaves the platform.
 *
 * These land with a third party — an SMTP relay, Telegram's servers — so each
 * says that something happened and nothing about who, which flat, or how much.
 * The detail stays behind a login.
 */
export const NOTIFICATION_CATEGORY_TITLE: Record<string, string> = {
  BOOKING_REQUEST: 'Новый запрос на бронирование',
  BOOKING_DECISION: 'Решение по бронированию',
  BOOKING_REMINDER: 'Напоминание о бронировании',
  BOOKING_CANCELLED: 'Бронирование отменено',
  MESSAGE: 'Новое сообщение',
  CHECK_IN: 'Заезд',
  CHECK_OUT: 'Выезд',
  COMPLETION_REQUEST: 'Подтвердите, что аренда состоялась',
  REVIEW_REQUEST: 'Можно оставить отзыв',
  REVIEW_PUBLISHED: 'Отзыв опубликован',
  DEBT: 'Есть задолженность по комиссии',
  VERIFICATION: 'Решение по проверке',
  SECURITY: 'Безопасность аккаунта',
  MODERATION: 'Решение модерации',
};

/**
 * Categories a person is never asked to consent to, and cannot switch off.
 *
 * SECURITY is the account itself — somebody signed in, a factor changed.
 * DEBT is money owed. MODERATION is a decision taken about their content.
 * Silencing any of these leaves a person unaware of something that is
 * happening to them, which is a different thing from sparing them a marketing
 * message. Everything else is a product notification and is theirs to turn off.
 *
 * This is a product judgement, not a legal one: no Belarusian requirement is
 * asserted here, and if one turns out to apply the list is the place to change.
 */
export const TRANSACTIONAL_CATEGORIES: readonly NotificationCategory[] = [
  'SECURITY',
  'DEBT',
  'MODERATION',
  'VERIFICATION',
];

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

  /* ================================================================ *
   * The outbox
   * ================================================================ */

  /**
   * Take work, exclusively.
   *
   * The previous version of this method was named `claimPending` and claimed
   * nothing: a bare SELECT, no lock, no status change. Two workers running at
   * once would both read the same rows and both send them, which for a
   * notification means a person is told the same thing twice. Nothing called
   * it, so the defect had never fired.
   *
   * Now a row moves to SENDING inside the claiming statement itself. A second
   * worker's UPDATE finds nothing left matching `status='PENDING'`, so the
   * exclusivity is the database's rather than a convention between workers.
   * `FOR UPDATE SKIP LOCKED` means the second worker moves on to other rows
   * instead of blocking behind the first.
   *
   * Only channels with a live provider are claimed. A row for a channel that
   * cannot send is left PENDING rather than claimed and failed — so when a
   * provider is eventually configured, the backlog goes out, and until then
   * the queue depth is the honest measure of what is undelivered.
   */
  async claimForDelivery(
    channels: readonly Channel[],
    limit = 50,
    now: Date = new Date(),
  ): Promise<ClaimedNotification[]> {
    if (channels.length === 0) return [];
    const { rows } = await this.db.query<ClaimedNotification>(
      `UPDATE notification n
          SET status='SENDING', claimed_at=$3, attempts = attempts + 1
        WHERE n.id IN (
          SELECT id FROM notification
           WHERE status='PENDING'
             AND channel = ANY($1)
             AND (next_attempt_at IS NULL OR next_attempt_at <= $3)
             AND attempts < $4
           ORDER BY next_attempt_at NULLS FIRST, created_at
           LIMIT $2
           FOR UPDATE SKIP LOCKED)
        RETURNING n.id, n.user_id, n.category, n.channel, n.payload, n.attempts`,
      [channels as unknown as string[], limit, now.toISOString(), MAX_DELIVERY_ATTEMPTS],
    );
    return rows;
  }

  /**
   * Rows a worker took and never settled, because it crashed.
   *
   * Returned to PENDING rather than failed: the send may or may not have
   * happened, and this system is at-least-once. Delivering twice is a nuisance;
   * never delivering a security notice is not.
   */
  async reclaimAbandoned(leaseMinutes = 5): Promise<number> {
    const { rowCount } = await this.db.query(
      `UPDATE notification
          SET status='PENDING', claimed_at=NULL
        WHERE status='SENDING'
          AND claimed_at < now() - ($1 || ' minutes')::interval`,
      [String(leaseMinutes)],
    );
    return rowCount;
  }

  /**
   * Confirm a delivery.
   *
   * `AND status='SENDING'` is the important half: only a row THIS worker
   * claimed can be marked sent. A stale worker returning after its lease
   * expired cannot overwrite a row another worker has since re-sent.
   */
  async markSent(notificationId: string, detail = 'ok'): Promise<void> {
    await this.db.query(
      `UPDATE notification SET status='SENT', sent_at=now(), last_error=NULL, claimed_at=NULL
        WHERE id=$1 AND status='SENDING'`,
      [notificationId],
    );
    void detail;
  }

  /**
   * A delivery that failed, and whether it is worth trying again.
   *
   * The distinction is the whole point. A timeout is worth retrying; an
   * address the provider rejected is not, and retrying it forever is how a
   * queue turns one bad row into a permanent load on somebody else's service.
   *
   * The backoff is exponential with jitter. Without jitter, a provider outage
   * synchronises every failed row onto the same retry instant, and the
   * recovery is a thundering herd against a service that has only just come
   * back — which is how an outage becomes a longer outage.
   */
  async markFailed(
    notificationId: string,
    error: string,
    kind: 'TRANSIENT' | 'PERMANENT' = 'TRANSIENT',
    now: Date = new Date(),
  ): Promise<void> {
    if (kind === 'PERMANENT') {
      await this.db.query(
        `UPDATE notification SET status='FAILED', last_error=$2, claimed_at=NULL WHERE id=$1`,
        [notificationId, error.slice(0, 500)],
      );
      return;
    }

    /* One statement. The delay has to be computed from the attempt count the
       row already carries, and `random()` supplies the jitter — without it a
       provider outage synchronises every failed row onto the same retry
       instant, and the recovery is a thundering herd against a service that
       has only just come back. Capped at 2^6 minutes so the ladder stops at
       roughly an hour rather than growing without bound. */
    await this.db.query(
      `UPDATE notification
          SET last_error = $2,
              claimed_at = NULL,
              status = CASE WHEN attempts >= $3 THEN 'FAILED' ELSE 'PENDING' END,
              next_attempt_at = CASE
                WHEN attempts >= $3 THEN NULL
                ELSE $4::timestamptz
                     + (power(2, least(attempts, 6)) * (0.5 + random())) * interval '1 minute'
              END
        WHERE id=$1`,
      [notificationId, error.slice(0, 500), MAX_DELIVERY_ATTEMPTS, now.toISOString()],
    );
  }

  /** Consent withdrawn between enqueue and send. Not a failure — a decision. */
  async markSuppressed(notificationId: string, reason: string): Promise<void> {
    await this.db.query(
      `UPDATE notification SET status='SUPPRESSED', last_error=$2, claimed_at=NULL WHERE id=$1`,
      [notificationId, reason.slice(0, 500)],
    );
  }

  /**
   * Where a notification should actually go, resolved NOW.
   *
   * Deliberately not read from the payload. A payload is written when the event
   * happens and delivered later; an address baked in at enqueue time would send
   * a corrected email to the old address, and would keep sending to a Telegram
   * chat somebody has since unlinked. Resolving late also means withdrawal of
   * consent takes effect on everything still queued.
   *
   * Returns null when there is nowhere to send — a phone-only account has no
   * email address, and `app_user` requires only one of the two.
   */
  async resolveAddress(userId: string, channel: Channel): Promise<string | null> {
    if (channel === 'IN_APP') return userId;
    if (channel === 'EMAIL') {
      const { rows } = await this.db.query<{ email: string | null }>(
        `SELECT email FROM app_user WHERE id=$1 AND deleted_at IS NULL`,
        [userId],
      );
      return rows[0]?.email ?? null;
    }
    const { rows } = await this.db.query<{ telegram_chat_id: string }>(
      `SELECT telegram_chat_id FROM telegram_connection WHERE user_id=$1 AND unlinked_at IS NULL`,
      [userId],
    );
    return rows[0] ? String(rows[0].telegram_chat_id) : null;
  }

  /** What is queued, delivered and stuck — for the console. */
  async backlog(): Promise<Record<string, unknown>> {
    const { rows } = await this.db.query(
      `SELECT channel, status, count(*)::int AS count,
              min(created_at) AS oldest
         FROM notification
        GROUP BY channel, status
        ORDER BY channel, status`,
    );
    return { byChannelAndStatus: rows };
  }
}

/** After this many attempts a row is given up on. */
export const MAX_DELIVERY_ATTEMPTS = 6;

export interface ClaimedNotification {
  readonly id: string;
  readonly user_id: string;
  readonly category: NotificationCategory;
  readonly channel: Channel;
  readonly payload: Record<string, unknown>;
  readonly attempts: number;
}

/**
 * The retry ladder, expressed in TypeScript for tests and for the console.
 *
 * The authoritative copy is the SQL in `markFailed`, because the delay must be
 * computed from the attempt count in the same statement that writes it. This
 * mirrors it: minutes = 2^attempts, capped, times a jitter factor in [0.5, 1.5).
 */
export function backoffMinutes(attempts: number): { min: number; max: number } {
  const base = 2 ** Math.min(attempts, 6);
  return { min: base * 0.5, max: base * 1.5 };
}
