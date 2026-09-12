/**
 * Paid placement — colour highlight.
 *
 * A separate product from boost/pin: this one buys a visual treatment on the
 * listing card (a coloured border/background — see listing-card.tsx), never
 * a change to search order. search-service.ts's `orderClause()` never joins
 * `listing_highlight` for exactly that reason; it is read only for the
 * `isHighlighted` flag the card renders from.
 *
 * Same post-paid ledger charge as BoostService and the same table shape as
 * `listing_boost` (see 0020_promotion_tiers.sql) — one tier, one row per
 * purchase, no schedule to split across rows.
 */

import { uuidv7 } from '../../lib/id.ts';
import type { Db } from '../db/sql.ts';
import { HIGHLIGHT_TIERS, type HighlightTierId } from '../domain/promotion-tiers.ts';
import { invalid, notFound } from './errors.ts';
import { writeAudit } from './audit.ts';

export type { HighlightTierId };
export { HIGHLIGHT_TIERS };

export interface HighlightPurchaseResult {
  readonly highlightId: string;
  readonly startsAt: string;
  readonly endsAt: string;
}

export class HighlightService {
  constructor(private readonly db: Db) {}

  async purchase(propertyId: string, userId: string, tierId: HighlightTierId): Promise<HighlightPurchaseResult> {
    const tier = HIGHLIGHT_TIERS[tierId];
    if (!tier) throw invalid('Неизвестный тариф выделения');

    return this.db.transaction(async (tx) => {
      const { rows } = await tx.query<{ owner_id: string; status: string }>(
        `SELECT owner_id, status FROM property WHERE id=$1 AND deleted_at IS NULL FOR UPDATE`,
        [propertyId],
      );
      const property = rows[0];
      if (!property) throw notFound('Объявление');
      if (property.owner_id !== userId) throw notFound('Объявление');
      if (property.status !== 'PUBLISHED') {
        throw invalid('Выделить можно только опубликованное объявление');
      }

      const highlightId = uuidv7();
      const { rows: highlightRows } = await tx.query<{ starts_at: Date; ends_at: Date }>(
        `INSERT INTO listing_highlight (id, property_id, purchased_by, amount_minor, ends_at)
         VALUES ($1,$2,$3,$4, now() + ($5::int * interval '1 day'))
         RETURNING starts_at, ends_at`,
        [highlightId, propertyId, userId, tier.priceMinor.toString(), tier.durationDays],
      );
      const row = highlightRows[0]!;

      await tx.query(
        `INSERT INTO ledger_entry (landlord_id, entry_type, amount_minor, reason, created_by)
         VALUES ($1,'HIGHLIGHT_CHARGED',$2,$3,$4)`,
        [userId, (-tier.priceMinor).toString(), `Цветное выделение объявления на ${tier.durationDays} дн.`, userId],
      );

      await writeAudit(tx, {
        actorUserId: userId,
        actorRole: 'LANDLORD',
        action: 'listing.highlight_purchased',
        targetType: 'property',
        targetId: propertyId,
        changes: { highlight: { from: null, to: tierId } },
      });

      return {
        highlightId,
        startsAt: new Date(row.starts_at).toISOString(),
        endsAt: new Date(row.ends_at).toISOString(),
      };
    });
  }

  /** The listing's current active highlight, if any — for the dashboard to show its status. */
  async activeFor(propertyId: string): Promise<{ endsAt: string } | null> {
    const { rows } = await this.db.query<{ ends_at: Date }>(
      `SELECT ends_at FROM listing_highlight
        WHERE property_id=$1 AND status='ACTIVE' AND starts_at <= now() AND ends_at > now()
        ORDER BY ends_at DESC LIMIT 1`,
      [propertyId],
    );
    const row = rows[0];
    return row ? { endsAt: new Date(row.ends_at).toISOString() } : null;
  }
}
