/**
 * Paid placement — "поднять объявление в ленте".
 *
 * A landlord pays a flat price to pin an already-published listing to the top
 * of search results for a fixed window. Charged through the same post-paid
 * ledger every other charge on the platform already uses (see
 * finance-service.ts): there is no live payment gateway anywhere in this
 * codebase, and this feature does not invent one either. The purchase simply
 * records a negative ledger entry against the landlord's balance, the same
 * debit convention FEE_ACCRUED already uses, and settles later like any other
 * post-paid debt.
 *
 * Ranking itself never reads this table's price. search-service.ts's
 * `orderClause()` treats a boost as a separate top tier placed ABOVE whatever
 * sort the visitor picked — it never enters the relevance score, so paying
 * cannot buy a better organic rank, only a place above it.
 */

import { uuidv7 } from '../../lib/id.ts';
import type { Db } from '../db/sql.ts';
import { invalid, notFound } from './errors.ts';
import { writeAudit } from './audit.ts';

/**
 * PLACEHOLDER PRICE. 15.00 BYN for a week is a guess with no demand data
 * behind it — the operator should tune this once real usage exists.
 */
export const BOOST_PRICE_MINOR = 1_500_00n;
export const BOOST_DURATION_DAYS = 7;

export interface ActiveBoost {
  readonly endsAt: string;
}

export class BoostService {
  constructor(private readonly db: Db) {}

  async purchase(
    propertyId: string,
    userId: string,
    days: number = BOOST_DURATION_DAYS,
  ): Promise<{ boostId: string; endsAt: string }> {
    return this.db.transaction(async (tx) => {
      const { rows } = await tx.query<{ owner_id: string; status: string }>(
        `SELECT owner_id, status FROM property WHERE id=$1 AND deleted_at IS NULL FOR UPDATE`,
        [propertyId],
      );
      const property = rows[0];
      if (!property) throw notFound('Объявление');
      // Same answer for "not yours" as for "does not exist" (as
      // ListingService.getForOwner does): a 403 here would confirm to a
      // stranger that this id belongs to someone's listing at all.
      if (property.owner_id !== userId) throw notFound('Объявление');
      if (property.status !== 'PUBLISHED') {
        throw invalid('Поднять можно только опубликованное объявление');
      }

      const boostId = uuidv7();
      const { rows: boostRows } = await tx.query<{ ends_at: Date }>(
        `INSERT INTO listing_boost (id, property_id, purchased_by, amount_minor, ends_at)
         VALUES ($1,$2,$3,$4, now() + ($5::int * interval '1 day'))
         RETURNING ends_at`,
        [boostId, propertyId, userId, BOOST_PRICE_MINOR.toString(), days],
      );
      const endsAt = boostRows[0]!.ends_at;

      await tx.query(
        `INSERT INTO ledger_entry (landlord_id, entry_type, amount_minor, reason, created_by)
         VALUES ($1,'BOOST_CHARGED',$2,$3,$4)`,
        [
          userId,
          (-BOOST_PRICE_MINOR).toString(),
          `Поднятие объявления в поиске на ${days} дн.`,
          userId,
        ],
      );

      await writeAudit(tx, {
        actorUserId: userId,
        actorRole: 'LANDLORD',
        action: 'listing.boost_purchased',
        targetType: 'property',
        targetId: propertyId,
        changes: { boost: { from: null, to: 'ACTIVE' } },
      });

      return { boostId, endsAt: new Date(endsAt).toISOString() };
    });
  }

  /** The listing's current active boost, if any — for the dashboard to show its status. */
  async activeFor(propertyId: string): Promise<ActiveBoost | null> {
    const { rows } = await this.db.query<{ ends_at: Date }>(
      `SELECT ends_at FROM listing_boost
        WHERE property_id=$1 AND status='ACTIVE' AND ends_at > now()
        ORDER BY ends_at DESC LIMIT 1`,
      [propertyId],
    );
    const row = rows[0];
    return row ? { endsAt: new Date(row.ends_at).toISOString() } : null;
  }
}
