/**
 * Notifications.
 *
 * Domain services never call an email or Telegram API directly — they enqueue a
 * row and return. A worker delivers it. That keeps a failing third party from
 * rolling back a booking, and makes delivery retryable.
 *
 * `(user_id, channel, dedupe_key)` is unique, so a re-run job cannot send the
 * same message twice (spec §55).
 *
 * Telegram defaults ON, same as IN_APP/EMAIL, the moment a person has a live
 * `telegram_connection` — linking the bot IS the consent (0021: a person who
 * bothers to open the bot and press Start wants to hear from it, and making
 * them separately flip a switch afterward is a second step nobody expects).
 * An explicit `notification_preference` row still lets a person turn any one
 * category off per channel; only the *absent-row* default changed.
 *
 * Enqueueing also makes one best-effort, AWAITED attempt to deliver
 * EMAIL/TELEGRAM rows immediately (`deliverHook`, wired by `container.ts`)
 * rather than leaving every message to wait for the next delivery-job tick —
 * see DEC-070. Only when the row's own INSERT was not itself inside a
 * caller's transaction (no `tx` argument): firing it before an enclosing
 * transaction commits would read a row that is not visible yet. Awaited,
 * not fire-and-forget, so this stays strictly sequential with the rest of
 * the request — never a second, un-awaited query racing whatever this
 * request does next. A row that fails, or skips, the immediate attempt is
 * untouched: it is still PENDING, and the scheduled job picks it up exactly
 * as before.
 */

import { uuidv7 } from '../../lib/id.ts';
import { hasErrorCode, PG_ERROR, type Db, type Sql } from '../db/sql.ts';
import { generateToken, hashToken } from '../auth/credentials.ts';
import { DomainError, invalid, notFound } from './errors.ts';
import { writeAudit } from './audit.ts';

/**
 * Telegram hands back phone numbers in whatever shape its own `contact`
 * payload uses (typically no leading `+`, occasional separators) —
 * normalised to the plain `+<digits>` form `app_user.phone` and the
 * registration form both already use, rather than trusting the provider's
 * formatting to already match.
 */
function normalizePhone(raw: string): string {
  const digits = raw.replace(/[^\d]/g, '');
  return `+${digits}`;
}

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
  /** A support ticket's status changed, or the other side wrote something
   * in the thread — DEC-073. Not mandatory/transactional: a support
   * conversation is not money owed or an account-security event, so a
   * person may switch it off like any other product notification. */
  'SUPPORT',
  /** The watchdog found a broken invariant (DEC-086). Administrators only —
   * the account page lists it for ADMIN and nobody else. */
  'OPERATIONS',
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
  SUPPORT: 'Обновление по обращению в поддержку',
  OPERATIONS: 'Нужна проверка команды: сторож нашёл сбой',
};

const NOTIFICATION_CATEGORY_TITLE_BE: Record<string, string> = {
  BOOKING_REQUEST: 'Новы запыт на браніраванне',
  BOOKING_DECISION: 'Рашэнне па браніраванні',
  BOOKING_REMINDER: 'Напамін пра браніраванне',
  BOOKING_CANCELLED: 'Браніраванне скасавана',
  MESSAGE: 'Новае паведамленне',
  CHECK_IN: 'Засяленне',
  CHECK_OUT: 'Выезд',
  COMPLETION_REQUEST: 'Пацвердзіце, што арэнда адбылася',
  REVIEW_REQUEST: 'Можна пакінуць водгук',
  REVIEW_PUBLISHED: 'Водгук апублікаваны',
  DEBT: 'Ёсць запазычанасць па камісіі',
  VERIFICATION: 'Рашэнне па праверцы',
  SECURITY: 'Бяспека акаунта',
  MODERATION: 'Рашэнне мадэрацыі',
  SUPPORT: 'Абнаўленне па зваротах у падтрымку',
  OPERATIONS: 'Патрэбна праверка каманды: вартаўнік знайшоў збой',
};

const NOTIFICATION_CATEGORY_TITLE_EN: Record<string, string> = {
  BOOKING_REQUEST: 'New booking request',
  BOOKING_DECISION: 'Booking decision',
  BOOKING_REMINDER: 'Booking reminder',
  BOOKING_CANCELLED: 'Booking cancelled',
  MESSAGE: 'New message',
  CHECK_IN: 'Check-in',
  CHECK_OUT: 'Check-out',
  COMPLETION_REQUEST: 'Confirm the stay took place',
  REVIEW_REQUEST: 'You can leave a review',
  REVIEW_PUBLISHED: 'Review published',
  DEBT: 'Outstanding commission balance',
  VERIFICATION: 'Verification decision',
  SECURITY: 'Account security',
  MODERATION: 'Moderation decision',
  SUPPORT: 'Support ticket update',
  OPERATIONS: 'Team check needed: the watchdog found a fault',
};

/** Locale-aware sibling of `NOTIFICATION_CATEGORY_TITLE` — same fixed,
 * closed vocabulary (a notification category is never user-typed text),
 * same reasoning as the *Localized helpers in src/ui/primitives.tsx. The
 * RU-only map above stays as the default/fallback and for any caller that
 * has not been updated to pass a locale (e.g. outbound email subjects,
 * which are a separate, not-yet-locale-aware concern). */
export function notificationCategoryTitle(category: string, locale: 'ru' | 'be' | 'en'): string | undefined {
  const table = locale === 'be' ? NOTIFICATION_CATEGORY_TITLE_BE : locale === 'en' ? NOTIFICATION_CATEGORY_TITLE_EN : NOTIFICATION_CATEGORY_TITLE;
  return table[category] ?? NOTIFICATION_CATEGORY_TITLE[category];
}

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
export const MANDATORY_IN_APP: readonly NotificationCategory[] = ['SECURITY', 'DEBT', 'MODERATION'];

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
   * Fired once, by `container.ts`, right after `DeliveryService` exists —
   * `enqueue()` cannot construct `DeliveryService` itself (that would be the
   * circular dependency the other direction: delivery already takes this
   * service as a constructor argument), so it calls out through this instead.
   * Awaited by `enqueue()`, but never allowed to THROW into it (the hook
   * itself always swallows its own errors — see `container.ts`'s wiring) —
   * see DEC-070 for why this is awaited rather than fire-and-forget.
   */
  private deliverHook?: (channel: Channel, notificationId: string) => Promise<void>;

  setDeliverHook(hook: (channel: Channel, notificationId: string) => Promise<void>): void {
    this.deliverHook = hook;
  }

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
        const { rows } = await sql.query<{ id: string }>(
          `INSERT INTO notification (id, user_id, category, channel, dedupe_key, payload, status)
           VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7)
           RETURNING id`,
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
        if (allowed) {
          queued.push(channel);
          // Best-effort only, and only when this INSERT was its own statement
          // (no `tx`) — so it already committed and the row is visible to the
          // connection `deliverHook` queries on. When `enqueue` runs INSIDE a
          // caller's transaction, firing the hook here would race a read
          // against writes that have not committed yet, so it is skipped —
          // that row still goes out on the next delivery-job tick, exactly as
          // it always has. IN_APP is skipped unconditionally: the row itself
          // is the message, already readable via inbox()/unreadCount().
          //
          // Awaited, not fired-and-forgotten: an un-awaited query here can
          // run concurrently with whatever the rest of this request does
          // next, and this codebase's test database (PGlite, a single
          // embedded connection, not a real connection pool) cannot survive
          // two logically-independent operations interleaved on it — it
          // threw "SAVEPOINT can only be used in transaction blocks" the one
          // time this was fire-and-forget. Awaiting keeps every query in one
          // request strictly sequential, which is correct everywhere, not
          // only under PGlite.
          if (!tx && channel !== 'IN_APP') await this.deliverHook?.(channel, rows[0]!.id);
        }
      } catch (e) {
        // Already queued for this exact event: the dedupe key did its job.
        if (!hasErrorCode(e, PG_ERROR.UNIQUE_VIOLATION)) throw e;
      }
    }
    return queued;
  }

  /**
   * Claim exactly one row, if it is still there to claim.
   *
   * The single-row sibling of `claimForDelivery()`, for the immediate
   * best-effort attempt `enqueue()` triggers via `deliverHook`. Same
   * exclusivity guarantee (`SENDING` inside the claiming statement, so the
   * scheduled job cannot double-send a row this already picked up) — just
   * scoped to one id instead of a batch, and silent (returns null) rather
   * than throwing when the row is gone, already claimed, or was never a
   * channel worth attempting (that last case cannot happen here since
   * `enqueue()` only calls this for a row it just inserted PENDING, but the
   * WHERE clause stays honest about what it actually requires regardless).
   */
  async claimOneForDelivery(notificationId: string, now: Date = new Date()): Promise<ClaimedNotification | null> {
    const { rows } = await this.db.query<ClaimedNotification>(
      `UPDATE notification
          SET status='SENDING', claimed_at=$2, attempts = attempts + 1
        WHERE id=$1 AND status='PENDING' AND (next_attempt_at IS NULL OR next_attempt_at <= $2)
        RETURNING id, user_id, category, channel, payload, attempts`,
      [notificationId, now.toISOString()],
    );
    return rows[0] ?? null;
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

    // Default: every channel on, including Telegram (0021) — linking the bot
    // is itself the consent; an absent row means "never touched the switch",
    // not "chose to opt out".
    if (rows.length === 0) return true;
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
      /* These defaults must be the SAME defaults `channelAllowed` applies when
         no row exists, or the settings screen describes a system that does
         something else. All three now default to true (0021) — see this
         file's header comment for why Telegram joined IN_APP/EMAIL here. */
      out[category] = { IN_APP: true, EMAIL: true, TELEGRAM: true };
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

  /**
   * How many unread in-app notifications this person has.
   *
   * Separate from `inbox()` because the header needs the number on every page
   * and the rows on none of them. Counting is one indexed aggregate; fetching
   * thirty rows and measuring them would put a payload on every render of the
   * site chrome.
   *
   * SUPPRESSED rows are excluded for the same reason `inbox()` excludes them:
   * a notification withheld by the person's own preference is not something
   * they have failed to read.
   */
  async unreadCount(userId: string): Promise<number> {
    const { rows } = await this.db.query<{ c: string }>(
      `SELECT count(*)::text AS c FROM notification
        WHERE user_id=$1 AND channel='IN_APP' AND status <> 'SUPPRESSED' AND read_at IS NULL`,
      [userId],
    );
    return Number(rows[0]?.c ?? 0);
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

  /**
   * What the bot itself can honestly say about a chat, from the chat id
   * alone — used by `/status` and `/unlink` in the webhook, which arrive
   * with nothing else to identify the sender by (same lookup
   * `completePhoneVerificationTelegramContact` above already makes: a live
   * `telegram_connection` row keyed by chat id). Joined with `app_user` in
   * one query rather than two, since `/status` needs both halves and
   * `/unlink` only needs `userId` — cheaper to compute the join once than to
   * give each command its own round trip.
   */
  async telegramLinkState(chatId: number): Promise<{ userId: string; phoneVerified: boolean } | null> {
    const { rows } = await this.db.query<{ user_id: string; phone_verified_at: Date | null }>(
      `SELECT tc.user_id, u.phone_verified_at
         FROM telegram_connection tc
         JOIN app_user u ON u.id = tc.user_id
        WHERE tc.telegram_chat_id=$1 AND tc.unlinked_at IS NULL`,
      [chatId],
    );
    const row = rows[0];
    return row ? { userId: row.user_id, phoneVerified: row.phone_verified_at !== null } : null;
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

  /* ---------------------------------------------------------------- *
   * Phone verification — proving control of a phone-backed Telegram
   * account, in place of a passport upload (0018; Telegram-only since 0021 —
   * VK and WhatsApp were dropped, see DECISIONS.md DEC-069).
   *
   * In Belarus a mobile number is tied to its owner at the point of sale, the
   * same fact a passport would establish, so this product treats "controls a
   * live Telegram account" as the identity signal Level 1 needs — see
   * LEGAL-004 in LEGAL_RISK_REGISTER.md for the reasoning and its still-open
   * legal question.
   *
   * ONE short-lived token (`PHONE_OTP`, reusing the purpose `auth_token`
   * already had — it was minted for an SMS one-time code that was never
   * built) drives the flow: Telegram consumes it as the `/start <token>`
   * deep-link parameter, identical in shape to
   * `beginTelegramLink`/`completeTelegramLink` above.
   *
   * TELEGRAM proves an actual phone number. After the token links the chat,
   * the bot asks for the account's contact via Telegram's own
   * `request_contact` button; Telegram supplies the number, already verified
   * by Telegram itself, and it becomes `app_user.phone`.
   */

  /** Mint the one token all three channels race to consume. */
  async beginPhoneVerification(userId: string): Promise<string> {
    const token = generateToken(8);
    await this.db.query(
      `INSERT INTO auth_token (id, user_id, purpose, token_hash, expires_at)
       VALUES ($1,$2,'PHONE_OTP',$3, now() + interval '30 minutes')`,
      [uuidv7(), userId, hashToken(token)],
    );
    return token;
  }

  private async consumePhoneVerificationToken(tx: Sql, token: string): Promise<string> {
    const { rows } = await tx.query<{ user_id: string }>(
      `UPDATE auth_token SET consumed_at=now()
        WHERE token_hash=$1 AND purpose='PHONE_OTP' AND consumed_at IS NULL AND expires_at > now()
        RETURNING user_id`,
      [hashToken(token)],
    );
    const row = rows[0];
    if (!row) throw new DomainError('UNAUTHENTICATED', 'Код подтверждения недействителен или устарел');
    return row.user_id;
  }

  /** Grants Level 1 the same way every channel below does: never lowers it. */
  private async grantPhoneVerifiedLevel(
    tx: Sql,
    userId: string,
    via: 'TELEGRAM',
    phone: string | null,
  ): Promise<void> {
    await tx.query(
      `UPDATE app_user
          SET phone_verified_at = now(),
              phone_verified_via = $2,
              phone = COALESCE($3, phone),
              verification_level = GREATEST(verification_level, 1)
        WHERE id = $1`,
      [userId, via, phone],
    );
    await writeAudit(tx, {
      actorUserId: userId,
      action: 'phone.verified',
      targetType: 'user',
      targetId: userId,
      changes: { via: { from: null, to: via } },
    });
  }

  /**
   * Step 1 of the Telegram flow: the deep link succeeded. Links the chat (the
   * same row `completeTelegramLink` writes, so this also satisfies Telegram
   * notification linking) but does NOT yet mark the phone verified — that
   * waits for the contact the bot is about to ask for, so Telegram's stronger
   * proof (a real number) is never skipped.
   */
  async beginTelegramPhoneLink(token: string, chatId: number, username?: string): Promise<string> {
    return this.db.transaction(async (tx) => {
      const userId = await this.consumePhoneVerificationToken(tx, token);
      await tx.query(
        `INSERT INTO telegram_connection (user_id, telegram_chat_id, telegram_username)
         VALUES ($1,$2,$3)
         ON CONFLICT (user_id) DO UPDATE
           SET telegram_chat_id = EXCLUDED.telegram_chat_id,
               telegram_username = EXCLUDED.telegram_username,
               linked_at = now(), unlinked_at = NULL`,
        [userId, chatId, username ?? null],
      );
      return userId;
    });
  }

  /** Step 2: the bot's `request_contact` button produced a real phone number. */
  async completePhoneVerificationTelegramContact(chatId: number, phoneNumber: string): Promise<string | null> {
    return this.db.transaction(async (tx) => {
      const { rows } = await tx.query<{ user_id: string }>(
        `SELECT user_id FROM telegram_connection WHERE telegram_chat_id=$1 AND unlinked_at IS NULL`,
        [chatId],
      );
      const userId = rows[0]?.user_id;
      // No pending link for this chat — somebody tapped an old contact-share
      // button, or is just poking the bot. Nothing to do; not an error.
      if (!userId) return null;
      await this.grantPhoneVerifiedLevel(tx, userId, 'TELEGRAM', normalizePhone(phoneNumber));
      return userId;
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
