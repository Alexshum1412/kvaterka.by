/**
 * Landlord balance, service fees and debt restrictions.
 *
 * The ledger is append-only and the balance is always SUM(amount_minor); there
 * is no mutable balance column that could drift from the entries that produced
 * it. Corrections are new rows carrying a reason and an author.
 *
 * LEGAL NOTE (LEGAL-016): whether this fee is enforceable as modelled has NOT
 * been confirmed by a Belarusian lawyer. The `fee.enforcement` feature flag
 * exists so the fee can be recorded as informational rather than as a payable
 * debt without a schema change or a rewrite of history.
 */

import { formatMoney, fromStorage, money, toDecimalString, type Money } from '../domain/money.ts';
import { verifyStoredFee } from '../domain/pricing.ts';
import type { Db } from '../db/sql.ts';
import { forbidden, invalid, notFound } from './errors.ts';
import { writeAudit } from './audit.ts';

/**
 * Debt above this threshold restricts NEW commercial activity.
 * Chosen as roughly one fee on a typical stay, so a single unpaid fee does not
 * instantly disable an account, but an accumulating balance does.
 */
export const DEBT_RESTRICTION_THRESHOLD_MINOR = 5000n; // 50.00 BYN
export const DEBT_GRACE_DAYS = 14;

export interface BalanceView {
  readonly userId: string;
  readonly balanceMinor: string;
  readonly balanceFormatted: string;
  readonly hasDebt: boolean;
  readonly outstandingFees: number;
  readonly restrictions: readonly Restriction[];
  readonly entries: readonly LedgerEntryView[];
}

export interface LedgerEntryView {
  readonly id: string;
  readonly type: string;
  readonly amountMinor: string;
  readonly bookingId: string | null;
  readonly reason: string | null;
  readonly createdAt: string;
}

export type Restriction =
  | 'CANNOT_PUBLISH_NEW_LISTINGS'
  | 'CANNOT_ACCEPT_NEW_BOOKINGS'
  | 'CANNOT_USE_PROMOTION'
  | 'INSTANT_BOOKING_DISABLED';

export class FinanceService {
  constructor(private readonly db: Db) {}

  async balance(userId: string): Promise<BalanceView> {
    const [balanceRow, feeRow, entries] = await Promise.all([
      this.db.query<{ balance: string }>(
        `SELECT COALESCE(SUM(amount_minor),0)::text AS balance FROM ledger_entry WHERE landlord_id=$1`,
        [userId],
      ),
      this.db.query<{ c: string }>(
        `SELECT count(*)::text AS c FROM service_fee WHERE landlord_id=$1 AND status='PAYABLE'`,
        [userId],
      ),
      this.db.query<Record<string, any>>(
        `SELECT id::text AS id, entry_type, amount_minor::text AS amount_minor, booking_id, reason, created_at
           FROM ledger_entry WHERE landlord_id=$1 ORDER BY created_at DESC LIMIT 100`,
        [userId],
      ),
    ]);

    const balanceMinor = BigInt(balanceRow.rows[0]!.balance);
    const balance: Money = money(balanceMinor);

    return {
      userId,
      balanceMinor: balanceMinor.toString(),
      balanceFormatted: formatMoney(balance),
      hasDebt: balanceMinor < 0n,
      outstandingFees: Number(feeRow.rows[0]!.c),
      restrictions: await this.restrictionsFor(userId),
      entries: entries.rows.map((r) => ({
        id: r.id,
        type: r.entry_type,
        amountMinor: r.amount_minor,
        bookingId: r.booking_id,
        reason: r.reason,
        createdAt: r.created_at,
      })),
    };
  }

  /**
   * What a landlord may not do while in debt.
   *
   * DELIBERATELY NARROW (spec §12). Debt restricts NEW commercial activity
   * only. It never touches an active booking, an ongoing conversation, or the
   * ability to complete a stay — punishing a landlord mid-rental punishes their
   * tenant, who did nothing wrong.
   */
  async restrictionsFor(userId: string): Promise<readonly Restriction[]> {
    if (!(await this.flagEnabled('fee.enforcement'))) return [];

    const { rows } = await this.db.query<{ balance: string; overdue: string }>(
      `SELECT COALESCE((SELECT SUM(amount_minor) FROM ledger_entry WHERE landlord_id=$1),0)::text AS balance,
              (SELECT count(*)::text FROM service_fee
                WHERE landlord_id=$1 AND status='PAYABLE' AND due_at < now()) AS overdue`,
      [userId],
    );

    const balance = BigInt(rows[0]!.balance);
    const overdue = Number(rows[0]!.overdue);

    if (balance >= 0n || -balance < DEBT_RESTRICTION_THRESHOLD_MINOR) return [];

    // Inside the grace period the landlord keeps taking bookings; only the
    // discretionary extras stop.
    if (overdue === 0) return ['CANNOT_USE_PROMOTION'];

    return [
      'CANNOT_PUBLISH_NEW_LISTINGS',
      'CANNOT_ACCEPT_NEW_BOOKINGS',
      'CANNOT_USE_PROMOTION',
      'INSTANT_BOOKING_DISABLED',
    ];
  }

  async assertNotRestricted(userId: string, restriction: Restriction): Promise<void> {
    const restrictions = await this.restrictionsFor(userId);
    if (restrictions.includes(restriction)) {
      throw forbidden(
        'Действие недоступно из-за задолженности по сервисному сбору. Погасите задолженность, чтобы продолжить.',
      );
    }
  }

  async listFees(userId: string): Promise<Record<string, unknown>[]> {
    const { rows } = await this.db.query<Record<string, any>>(
      `SELECT sf.id, sf.booking_id, b.reference, sf.base_minor::text AS base_minor, sf.bps,
              sf.fee_minor::text AS fee_minor, sf.status, sf.due_at, sf.accrued_at, sf.settled_at
         FROM service_fee sf JOIN booking b ON b.id = sf.booking_id
        WHERE sf.landlord_id=$1 ORDER BY sf.accrued_at DESC LIMIT 100`,
      [userId],
    );

    return rows.map((r) => ({
      id: r.id,
      bookingId: r.booking_id,
      bookingReference: r.reference,
      baseMinor: r.base_minor,
      ratePercent: r.bps / 100,
      feeMinor: r.fee_minor,
      feeFormatted: formatMoney(fromStorage(r.fee_minor)),
      status: r.status,
      dueAt: r.due_at,
      accruedAt: r.accrued_at,
      settledAt: r.settled_at,
      // Every fee can be recomputed from its own stored inputs. Surfacing this
      // makes the number checkable by the person being charged.
      arithmeticVerified: verifyStoredFee(BigInt(r.base_minor), r.bps, BigInt(r.fee_minor)),
      explanation: `${toDecimalString(fromStorage(r.base_minor))} × ${r.bps / 100}% = ${toDecimalString(fromStorage(r.fee_minor))} BYN`,
    }));
  }

  /* ---------------------------------------------------------------- *
   * Staff operations (FINANCE / ADMIN)
   * ---------------------------------------------------------------- */

  async recordPayment(
    landlordId: string,
    amountMinor: string,
    actorId: string,
    reference: string,
  ): Promise<void> {
    const amount = BigInt(amountMinor);
    if (amount <= 0n) throw invalid('Сумма платежа должна быть больше нуля');
    if (!reference?.trim()) throw invalid('Укажите основание платежа');

    await this.db.transaction(async (tx) => {
      await tx.query(
        `INSERT INTO ledger_entry (landlord_id, entry_type, amount_minor, reason, created_by)
         VALUES ($1,'PAYMENT_RECEIVED',$2,$3,$4)`,
        [landlordId, amount.toString(), reference, actorId],
      );

      // Settle oldest first, and only as far as the payment reaches.
      let remaining = amount;
      const { rows } = await tx.query<{ id: string; fee_minor: string }>(
        `SELECT id, fee_minor::text AS fee_minor FROM service_fee
          WHERE landlord_id=$1 AND status='PAYABLE' ORDER BY accrued_at`,
        [landlordId],
      );
      for (const fee of rows) {
        const feeAmount = BigInt(fee.fee_minor);
        if (remaining < feeAmount) break;
        await tx.query(`UPDATE service_fee SET status='PAID', settled_at=now() WHERE id=$1`, [fee.id]);
        remaining -= feeAmount;
      }

      await writeAudit(tx, {
        actorUserId: actorId,
        actorRole: 'FINANCE',
        action: 'finance.payment_received',
        targetType: 'user',
        targetId: landlordId,
        changes: { amountMinor: amount.toString() },
        reason: reference,
        source: 'admin',
      });
    });
  }

  async waiveFee(feeId: string, actorId: string, reason: string): Promise<void> {
    if (!reason?.trim()) throw invalid('Укажите причину списания сбора');

    await this.db.transaction(async (tx) => {
      const { rows } = await tx.query<{ landlord_id: string; fee_minor: string; status: string }>(
        `SELECT landlord_id, fee_minor::text AS fee_minor, status FROM service_fee WHERE id=$1 FOR UPDATE`,
        [feeId],
      );
      const fee = rows[0];
      if (!fee) throw notFound('Сервисный сбор');
      if (fee.status !== 'PAYABLE') throw invalid('Этот сбор уже закрыт');

      await tx.query(
        `UPDATE service_fee SET status='WAIVED', waived_by=$2, waived_reason=$3, settled_at=now() WHERE id=$1`,
        [feeId, actorId, reason],
      );
      // The accrual stays; a compensating credit records the waiver, so the
      // history shows both that a fee arose and that it was forgiven.
      await tx.query(
        `INSERT INTO ledger_entry (landlord_id, entry_type, amount_minor, service_fee_id, reason, created_by)
         VALUES ($1,'FEE_WAIVED',$2,$3,$4,$5)`,
        [fee.landlord_id, fee.fee_minor, feeId, reason, actorId],
      );

      await writeAudit(tx, {
        actorUserId: actorId,
        actorRole: 'FINANCE',
        action: 'finance.fee_waived',
        targetType: 'service_fee',
        targetId: feeId,
        changes: { amountMinor: fee.fee_minor },
        reason,
        source: 'admin',
      });
    });
  }

  async adjust(landlordId: string, amountMinor: string, actorId: string, reason: string): Promise<void> {
    if (!reason?.trim()) throw invalid('Корректировка требует обоснования');
    const amount = BigInt(amountMinor);
    if (amount === 0n) throw invalid('Корректировка не может быть нулевой');

    await this.db.transaction(async (tx) => {
      await tx.query(
        `INSERT INTO ledger_entry (landlord_id, entry_type, amount_minor, reason, created_by)
         VALUES ($1,'ADJUSTMENT',$2,$3,$4)`,
        [landlordId, amount.toString(), reason, actorId],
      );
      await writeAudit(tx, {
        actorUserId: actorId,
        actorRole: 'FINANCE',
        action: 'finance.adjustment',
        targetType: 'user',
        targetId: landlordId,
        changes: { amountMinor: amount.toString() },
        reason,
        source: 'admin',
      });
    });
  }

  /* ---------------------------------------------------------------- */

  async flagEnabled(key: string): Promise<boolean> {
    const { rows } = await this.db.query<{ enabled: boolean }>(
      `SELECT enabled FROM feature_flag WHERE key=$1`,
      [key],
    );
    return rows[0]?.enabled ?? false;
  }
}
