/**
 * Paid placement — pin to the top.
 *
 * The strongest placement product: ranked ABOVE a boosted-but-unpinned
 * listing in every sort branch (see search-service.ts's `orderClause()`,
 * `pinTier` prepended ahead of `boostTier`). Same post-paid ledger charge and
 * the same table shape as `listing_boost`/`listing_highlight` (see
 * 0020_promotion_tiers.sql) — three duration tiers, one row per purchase, no
 * schedule to split across rows (a pin is one continuous placement, not a
 * series of bumps the way a multi-count boost tier is).
 */

import { uuidv7 } from '../../lib/id.ts';
import type { Db } from '../db/sql.ts';
import { PIN_TIERS, type PinTierId } from '../domain/promotion-tiers.ts';
import { invalid, notFound } from './errors.ts';
import { writeAudit } from './audit.ts';

export type { PinTierId };
export { PIN_TIERS };

export interface PinPurchaseResult {
  readonly pinId: string;
  readonly startsAt: string;
  readonly endsAt: string;
}

export class PinService {
  constructor(private readonly db: Db) {}

  async purchase(propertyId: string, userId: string, tierId: PinTierId): Promise<PinPurchaseResult> {
    const tier = PIN_TIERS[tierId];
    if (!tier) throw invalid('Неизвестный тариф закрепления');

    return this.db.transaction(async (tx) => {
      const { rows } = await tx.query<{ owner_id: string; status: string }>(
        `SELECT owner_id, status FROM property WHERE id=$1 AND deleted_at IS NULL FOR UPDATE`,
        [propertyId],
      );
      const property = rows[0];
      if (!property) throw notFound('Объявление');
      if (property.owner_id !== userId) throw notFound('Объявление');
      if (property.status !== 'PUBLISHED') {
        throw invalid('Закрепить можно только опубликованное объявление');
      }

      const pinId = uuidv7();
      const { rows: pinRows } = await tx.query<{ starts_at: Date; ends_at: Date }>(
        `INSERT INTO listing_pin (id, property_id, purchased_by, amount_minor, ends_at)
         VALUES ($1,$2,$3,$4, now() + ($5::int * interval '1 day'))
         RETURNING starts_at, ends_at`,
        [pinId, propertyId, userId, tier.priceMinor.toString(), tier.durationDays],
      );
      const row = pinRows[0]!;

      await tx.query(
        `INSERT INTO ledger_entry (landlord_id, entry_type, amount_minor, reason, created_by)
         VALUES ($1,'PIN_CHARGED',$2,$3,$4)`,
        [userId, (-tier.priceMinor).toString(), `Закрепление объявления в топе на ${tier.durationDays} дн.`, userId],
      );

      await writeAudit(tx, {
        actorUserId: userId,
        actorRole: 'LANDLORD',
        action: 'listing.pin_purchased',
        targetType: 'property',
        targetId: propertyId,
        changes: { pin: { from: null, to: tierId } },
      });

      return { pinId, startsAt: new Date(row.starts_at).toISOString(), endsAt: new Date(row.ends_at).toISOString() };
    });
  }

  /** The listing's current active pin, if any — for the dashboard to show its status. */
  async activeFor(propertyId: string): Promise<{ endsAt: string } | null> {
    const { rows } = await this.db.query<{ ends_at: Date }>(
      `SELECT ends_at FROM listing_pin
        WHERE property_id=$1 AND status='ACTIVE' AND starts_at <= now() AND ends_at > now()
        ORDER BY ends_at DESC LIMIT 1`,
      [propertyId],
    );
    const row = rows[0];
    return row ? { endsAt: new Date(row.ends_at).toISOString() } : null;
  }
}
