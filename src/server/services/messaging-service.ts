/**
 * Conversations and messages.
 *
 * The contact filter runs HERE, on the server, on every message, before the
 * text is stored. A client-side filter is decoration: anyone can call the API
 * directly. The original text is preserved in `body_original` for moderation
 * and dispute evidence, and every decision writes an append-only moderation
 * event so the rules can be tuned without re-reading private conversations.
 */

import { uuidv7 } from '../../lib/id.ts';
import { contactExchangeAllowed, filterMessage } from '../domain/messaging/contact-filter.ts';
import type { Db, Sql } from '../db/sql.ts';
import { DomainError, forbidden, invalid, notFound } from './errors.ts';
import { writeAudit } from './audit.ts';

export interface ConversationSummary {
  readonly id: string;
  readonly propertyId: string | null;
  readonly propertyTitle: string | null;
  readonly bookingId: string | null;
  readonly bookingStatus: string | null;
  readonly counterparty: { id: string; displayName: string; verificationLevel: number };
  readonly contactReleased: boolean;
  readonly lastMessageAt: string | null;
  readonly unreadCount: number;
}

export interface MessageView {
  readonly id: string;
  readonly conversationId: string;
  readonly senderId: string | null;
  readonly kind: string;
  readonly body: string;
  readonly moderationState: string;
  readonly createdAt: string;
  readonly readAt: string | null;
  readonly mine: boolean;
  /** Present only for the sender, explaining why their text was altered. */
  readonly filterNotice?: string;
}

const MAX_MESSAGE_LENGTH = 4000;

export class MessagingService {
  constructor(private readonly db: Db) {}

  /* ---------------------------------------------------------------- */

  async startConversation(propertyId: string, tenantId: string): Promise<{ id: string }> {
    return this.db.transaction(async (tx) => {
      const { rows } = await tx.query<{ owner_id: string; status: string }>(
        `SELECT owner_id, status FROM property WHERE id=$1 AND deleted_at IS NULL`,
        [propertyId],
      );
      const property = rows[0];
      if (!property) throw notFound('Объявление');
      if (property.status !== 'PUBLISHED') {
        throw new DomainError('CONFLICT', 'Объявление недоступно');
      }
      if (property.owner_id === tenantId) {
        throw invalid('Нельзя написать самому себе');
      }

      const existing = await tx.query<{ id: string }>(
        `SELECT id FROM conversation WHERE property_id=$1 AND tenant_id=$2`,
        [propertyId, tenantId],
      );
      if (existing.rows[0]) return { id: existing.rows[0].id };

      const id = uuidv7();
      await tx.query(
        `INSERT INTO conversation (id, property_id, tenant_id, landlord_id) VALUES ($1,$2,$3,$4)`,
        [id, propertyId, tenantId, property.owner_id],
      );
      return { id };
    });
  }

  /* ---------------------------------------------------------------- */

  async sendMessage(
    conversationId: string,
    senderId: string,
    text: string,
    opts: { locale?: 'ru' | 'be' | 'en' } = {},
  ): Promise<MessageView> {
    const trimmed = text.trim();
    if (trimmed.length === 0) throw invalid('Сообщение не может быть пустым');
    if (trimmed.length > MAX_MESSAGE_LENGTH) {
      throw invalid(`Сообщение слишком длинное (максимум ${MAX_MESSAGE_LENGTH} символов)`);
    }

    return this.db.transaction(async (tx) => {
      const conversation = await this.loadParticipant(tx, conversationId, senderId);

      if (conversation.status === 'FROZEN') {
        throw new DomainError('CONFLICT', 'Переписка заморожена модератором');
      }

      // Contacts unlock at confirmation. Both the stored release state and the
      // live booking status are consulted; they should agree, and if they do
      // not, the more restrictive answer wins.
      const released =
        conversation.contact_release_state === 'RELEASED' &&
        contactExchangeAllowed(conversation.booking_status);

      const verdict = filterMessage(trimmed, {
        contactReleased: released,
        locale: opts.locale ?? 'ru',
      });

      if (verdict.decision === 'BLOCK') {
        // Recorded even though nothing is delivered: a blocked attempt is the
        // strongest off-platform signal there is.
        await this.recordModeration(tx, null, conversationId, senderId, verdict, 'BLOCK');
        throw new DomainError(
          'VALIDATION_FAILED',
          verdict.reason ?? 'Сообщение содержит контактные данные и не может быть отправлено',
        );
      }

      const id = uuidv7();
      const moderationState =
        verdict.decision === 'REDACT' ? 'REDACTED' : verdict.decision === 'FLAG' ? 'FLAGGED' : 'CLEAN';

      await tx.query(
        `INSERT INTO message (id, conversation_id, sender_id, kind, body, body_original, moderation_state)
         VALUES ($1,$2,$3,'TEXT',$4,$5,$6)`,
        [
          id,
          conversationId,
          senderId,
          verdict.sanitized,
          // Only kept when the text was altered or flagged; a clean message has
          // nothing to preserve, and storing it twice is needless retention.
          moderationState === 'CLEAN' ? null : trimmed,
          moderationState,
        ],
      );

      await tx.query(`UPDATE conversation SET last_message_at = now() WHERE id=$1`, [conversationId]);

      if (moderationState !== 'CLEAN') {
        await this.recordModeration(tx, id, conversationId, senderId, verdict, verdict.decision);
      }

      return {
        id,
        conversationId,
        senderId,
        kind: 'TEXT',
        body: verdict.sanitized,
        moderationState,
        createdAt: new Date().toISOString(),
        readAt: null,
        mine: true,
        ...(verdict.reason ? { filterNotice: verdict.reason } : {}),
      };
    });
  }

  private async recordModeration(
    tx: Sql,
    messageId: string | null,
    conversationId: string,
    senderId: string,
    verdict: ReturnType<typeof filterMessage>,
    decision: string,
  ): Promise<void> {
    if (messageId) {
      await tx.query(
        `INSERT INTO message_moderation_event (message_id, decision, detectors, confidence, matched_spans)
         VALUES ($1,$2,$3,$4,$5::jsonb)`,
        [
          messageId,
          decision === 'REDACT' ? 'REDACT' : decision === 'FLAG' ? 'FLAG' : 'BLOCK',
          `{${verdict.detectors.join(',')}}`,
          verdict.confidence,
          JSON.stringify(verdict.matches.map((m) => ({ d: m.detector, s: m.start, e: m.end }))),
        ],
      );
    }

    if (decision === 'BLOCK') {
      await tx.query(
        `INSERT INTO fraud_signal (user_id, kind, severity, detail)
         VALUES ($1,'OFF_PLATFORM_CONTACT_ATTEMPT',2,$2::jsonb)`,
        [senderId, JSON.stringify({ conversationId, detectors: verdict.detectors })],
      );
    }
  }

  /* ---------------------------------------------------------------- */

  async listMessages(
    conversationId: string,
    viewerId: string,
    opts: { limit?: number; before?: string } = {},
  ): Promise<readonly MessageView[]> {
    await this.loadParticipant(this.db, conversationId, viewerId);
    const limit = Math.min(opts.limit ?? 50, 100);

    const { rows } = await this.db.query<Record<string, any>>(
      `SELECT id, conversation_id, sender_id, kind, body, moderation_state, created_at, read_at
         FROM message
        WHERE conversation_id=$1 AND deleted_at IS NULL
          AND ($2::timestamptz IS NULL OR created_at < $2)
        ORDER BY created_at DESC
        LIMIT $3`,
      [conversationId, opts.before ?? null, limit],
    );

    return rows.reverse().map((r) => ({
      id: r.id,
      conversationId: r.conversation_id,
      senderId: r.sender_id,
      kind: r.kind,
      body: r.body,
      moderationState: r.moderation_state,
      createdAt: r.created_at,
      readAt: r.read_at,
      mine: r.sender_id === viewerId,
    }));
  }

  async listConversations(userId: string): Promise<readonly ConversationSummary[]> {
    const { rows } = await this.db.query<Record<string, any>>(
      `SELECT c.id, c.property_id, c.booking_id, c.contact_release_state, c.last_message_at,
              p.title AS property_title,
              b.status AS booking_status,
              CASE WHEN c.tenant_id = $1 THEN c.landlord_id ELSE c.tenant_id END AS counterparty_id,
              cu.display_name AS counterparty_name,
              cu.verification_level AS counterparty_verification,
              (SELECT count(*)::int FROM message m
                WHERE m.conversation_id = c.id AND m.read_at IS NULL
                  AND m.sender_id IS DISTINCT FROM $1 AND m.deleted_at IS NULL) AS unread
         FROM conversation c
         LEFT JOIN property p ON p.id = c.property_id
         LEFT JOIN booking b ON b.id = c.booking_id
         JOIN app_user cu ON cu.id = CASE WHEN c.tenant_id = $1 THEN c.landlord_id ELSE c.tenant_id END
        WHERE c.tenant_id = $1 OR c.landlord_id = $1
        ORDER BY c.last_message_at DESC NULLS LAST, c.created_at DESC
        LIMIT 100`,
      [userId],
    );

    return rows.map((r) => ({
      id: r.id,
      propertyId: r.property_id,
      propertyTitle: r.property_title,
      bookingId: r.booking_id,
      bookingStatus: r.booking_status,
      counterparty: {
        id: r.counterparty_id,
        displayName: r.counterparty_name,
        verificationLevel: r.counterparty_verification,
      },
      contactReleased: r.contact_release_state === 'RELEASED',
      lastMessageAt: r.last_message_at,
      unreadCount: Number(r.unread),
    }));
  }

  async markRead(conversationId: string, viewerId: string): Promise<number> {
    await this.loadParticipant(this.db, conversationId, viewerId);
    const { rowCount } = await this.db.query(
      `UPDATE message SET read_at = now()
        WHERE conversation_id=$1 AND sender_id IS DISTINCT FROM $2 AND read_at IS NULL`,
      [conversationId, viewerId],
    );
    return rowCount;
  }

  async reportMessage(messageId: string, reporterId: string, category: string, detail?: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      const { rows } = await tx.query<{ conversation_id: string }>(
        `SELECT conversation_id FROM message WHERE id=$1`,
        [messageId],
      );
      if (!rows[0]) throw notFound('Сообщение');
      await this.loadParticipant(tx, rows[0].conversation_id, reporterId);

      await tx.query(
        `INSERT INTO report (id, reporter_id, target_type, target_id, category, detail)
         VALUES ($1,$2,'MESSAGE',$3,$4,$5)`,
        [uuidv7(), reporterId, messageId, category, detail ?? null],
      );
      await tx.query(
        `UPDATE message SET moderation_state='FLAGGED'
          WHERE id=$1 AND moderation_state='CLEAN'`,
        [messageId],
      );
      await writeAudit(tx, {
        actorUserId: reporterId,
        action: 'message.report',
        targetType: 'message',
        targetId: messageId,
        changes: { category },
      });
    });
  }

  /** Membership check. Every read and write path goes through this. */
  private async loadParticipant(
    sql: Sql,
    conversationId: string,
    userId: string,
  ): Promise<{
    id: string;
    tenant_id: string;
    landlord_id: string;
    contact_release_state: string;
    status: string;
    booking_status: string | null;
  }> {
    const { rows } = await sql.query<{
      id: string;
      tenant_id: string;
      landlord_id: string;
      contact_release_state: string;
      status: string;
      booking_status: string | null;
    }>(
      `SELECT c.id, c.tenant_id, c.landlord_id, c.contact_release_state, c.status,
              b.status AS booking_status
         FROM conversation c LEFT JOIN booking b ON b.id = c.booking_id
        WHERE c.id = $1`,
      [conversationId],
    );
    const row = rows[0];
    if (!row) throw notFound('Переписка');
    if (row.tenant_id !== userId && row.landlord_id !== userId) {
      throw forbidden('Вы не участник этой переписки');
    }
    return row;
  }
}
