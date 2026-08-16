/**
 * Favourites.
 *
 * Deliberately thin — the `favorite` table's composite primary key does
 * the real work, which is why saving twice is a no-op and un-saving is a
 * delete. But it is a service rather than a query inside a route handler
 * for one substantive reason: the visibility rule.
 *
 * Only a PUBLISHED listing may be saved. Without that check, saving
 * becomes an existence oracle — a stranger could probe ids and learn
 * which drafts and paused listings exist from whether the call
 * succeeded. That rule belongs next to the data, not in the router.
 */

import type { Db } from '../db/sql.ts';
import { DomainError } from './errors.ts';

export class FavoriteService {
  constructor(private readonly db: Db) {}

  /** Property ids the user has saved, newest first. */
  async list(userId: string): Promise<string[]> {
    const { rows } = await this.db.query<{ property_id: string }>(
      `SELECT property_id FROM favorite WHERE user_id = $1 ORDER BY created_at DESC`,
      [userId],
    );
    return rows.map((r) => r.property_id);
  }

  /**
   * Saving is idempotent: a double tap on a phone, or a request retried
   * after a dropped connection, must not be an error.
   */
  async add(userId: string, propertyId: string): Promise<void> {
    const { rows } = await this.db.query<{ status: string }>(
      `SELECT status FROM property WHERE id = $1 AND deleted_at IS NULL`,
      [propertyId],
    );
    // Identical response for "no such listing" and "not published", so the
    // endpoint cannot be used to enumerate unpublished properties.
    if (rows[0]?.status !== 'PUBLISHED') {
      throw new DomainError('NOT_FOUND', 'Объявление не найдено');
    }

    await this.db.query(
      `INSERT INTO favorite (user_id, property_id) VALUES ($1, $2)
         ON CONFLICT (user_id, property_id) DO NOTHING`,
      [userId, propertyId],
    );
  }

  /** Also idempotent: removing something already gone is success. */
  async remove(userId: string, propertyId: string): Promise<void> {
    await this.db.query(`DELETE FROM favorite WHERE user_id = $1 AND property_id = $2`, [
      userId,
      propertyId,
    ]);
  }

  /**
   * The saved set restricted to the ids on screen.
   *
   * A results page renders a few dozen cards, and asking "is this one
   * saved" per card would be a query per card. This answers the whole
   * page in one round trip.
   */
  async savedAmong(userId: string, propertyIds: readonly string[]): Promise<Set<string>> {
    if (propertyIds.length === 0) return new Set();
    const { rows } = await this.db.query<{ property_id: string }>(
      `SELECT property_id FROM favorite WHERE user_id = $1 AND property_id = ANY($2::uuid[])`,
      [userId, [...propertyIds]],
    );
    return new Set(rows.map((r) => r.property_id));
  }
}
