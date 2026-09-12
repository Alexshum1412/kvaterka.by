/**
 * Paid placement — "поднять объявление в ленте".
 *
 * A landlord pays to pin an already-published listing to the top of search
 * results. Charged through the same post-paid ledger every other charge on
 * the platform already uses (see finance-service.ts): there is no live
 * payment gateway anywhere in this codebase, and this feature does not
 * invent one either. The purchase simply records a negative ledger entry
 * against the landlord's balance, the same debit convention FEE_ACCRUED
 * already uses, and settles later like any other post-paid debt.
 *
 * Ranking itself never reads this table's price. search-service.ts's
 * `orderClause()` treats a boost as a separate tier placed ABOVE whatever
 * sort the visitor picked (and below a pin — see pin-service.ts) — it never
 * enters the relevance score, so paying cannot buy a better organic rank,
 * only a place above it.
 *
 * TIERS (DEC-072) live in `../domain/promotion-tiers.ts`, not here — see that
 * module's header for what they are and why. This service owns only the
 * purchase itself: validating the listing, inserting the scheduled rows, and
 * writing the ledger charge and audit log.
 */

import { uuidv7 } from '../../lib/id.ts';
import type { Db } from '../db/sql.ts';
import { BOOST_TIERS, splitBoostAmount, type BoostTierId } from '../domain/promotion-tiers.ts';
import { invalid, notFound } from './errors.ts';
import { writeAudit } from './audit.ts';

export type { BoostTierId };
export { BOOST_TIERS };

export interface PurchasedBoostRow {
  readonly boostId: string;
  readonly startsAt: string;
  readonly endsAt: string;
}

export interface BoostPurchaseResult {
  readonly tierId: BoostTierId;
  readonly priceMinor: string;
  readonly boosts: readonly PurchasedBoostRow[];
}

export interface ActiveBoost {
  readonly endsAt: string;
}

export class BoostService {
  constructor(private readonly db: Db) {}

  async purchase(propertyId: string, userId: string, tierId: BoostTierId): Promise<BoostPurchaseResult> {
    const tier = BOOST_TIERS[tierId];
    if (!tier) throw invalid('Неизвестный тариф поднятия');

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

      const shares = splitBoostAmount(tier.priceMinor, tier.count);
      const boosts: PurchasedBoostRow[] = [];

      // `now()` is stable for the whole transaction in PostgreSQL (it means
      // "transaction start time", not "statement time"), so every row below
      // schedules off the identical instant — there is no clock drift to
      // reason about between the first row and the last.
      for (let i = 0; i < tier.count; i += 1) {
        const boostId = uuidv7();
        const offsetDays = i * tier.intervalDays;
        const { rows: boostRows } = await tx.query<{ starts_at: Date; ends_at: Date }>(
          `INSERT INTO listing_boost (id, property_id, purchased_by, amount_minor, starts_at, ends_at)
           VALUES ($1, $2, $3, $4,
                   now() + ($5::int * interval '1 day'),
                   now() + ($5::int * interval '1 day') + ($6::int * interval '1 day'))
           RETURNING starts_at, ends_at`,
          [boostId, propertyId, userId, shares[i]!.toString(), offsetDays, tier.boostDurationDays],
        );
        const row = boostRows[0]!;
        boosts.push({
          boostId,
          startsAt: new Date(row.starts_at).toISOString(),
          endsAt: new Date(row.ends_at).toISOString(),
        });
      }

      await tx.query(
        `INSERT INTO ledger_entry (landlord_id, entry_type, amount_minor, reason, created_by)
         VALUES ($1,'BOOST_CHARGED',$2,$3,$4)`,
        [
          userId,
          (-tier.priceMinor).toString(),
          `Поднятие объявления в поиске — тариф ${tierId} (${tier.count} шт.)`,
          userId,
        ],
      );

      await writeAudit(tx, {
        actorUserId: userId,
        actorRole: 'LANDLORD',
        action: 'listing.boost_purchased',
        targetType: 'property',
        targetId: propertyId,
        changes: { boost: { from: null, to: tierId } },
      });

      return { tierId, priceMinor: tier.priceMinor.toString(), boosts };
    });
  }

  /** The listing's current active boost, if any — for the dashboard to show its status. */
  async activeFor(propertyId: string): Promise<ActiveBoost | null> {
    const { rows } = await this.db.query<{ ends_at: Date }>(
      `SELECT ends_at FROM listing_boost
        WHERE property_id=$1 AND status='ACTIVE' AND starts_at <= now() AND ends_at > now()
        ORDER BY ends_at DESC LIMIT 1`,
      [propertyId],
    );
    const row = rows[0];
    return row ? { endsAt: new Date(row.ends_at).toISOString() } : null;
  }
}
