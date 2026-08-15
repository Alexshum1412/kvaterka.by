/**
 * Two-sided completion confirmation (master spec §11).
 *
 * This is the most incentive-sensitive rule in the product, because the outcome
 * decides whether the landlord owes the platform a 5% service fee.
 *
 * THE ASYMMETRY THAT DRIVES THE DESIGN (DEC-008)
 *
 *   - A landlord who says "the rental happened" is admitting a debt. Nobody
 *     invents a debt against themselves, so that answer is self-incriminating
 *     and can be trusted on its own.
 *   - A landlord who says "it never happened", or who simply stays silent, may
 *     be honest — or may be dodging the fee. Those two cases are
 *     indistinguishable from a single answer, so silence must never be the
 *     cheapest route to avoiding the fee.
 *   - A tenant has no fee exposure either way, so a tenant's answer is the
 *     least corrupted signal available.
 *
 * Therefore: a tenant's unopposed "it happened" completes the booking and
 * accrues the fee, while a landlord's unopposed "it did not happen" is honoured
 * but recorded as a fraud signal so that a pattern of such claims surfaces.
 *
 * We never accrue a debt with no evidence at all: if both sides stay silent and
 * the platform holds no check-in record, the booking closes with no fee. The
 * platform is claiming money from a person; the burden of evidence is ours.
 */

import type { BookingState } from './states.ts';

export type CompletionAnswer = 'TOOK_PLACE' | 'DID_NOT_TAKE_PLACE';

export interface CompletionInputs {
  readonly tenantAnswer: CompletionAnswer | null;
  readonly landlordAnswer: CompletionAnswer | null;
  /** True when the tenant pressed check-in inside the platform. */
  readonly hasCheckInRecord: boolean;
  /** Confirmation window has elapsed. */
  readonly deadlinePassed: boolean;
}

export type CompletionOutcome =
  | { readonly kind: 'PENDING'; readonly reason: string }
  | {
      readonly kind: 'RESOLVED';
      readonly state: Extract<BookingState, 'COMPLETED' | 'NOT_TAKEN_PLACE' | 'DISPUTED'>;
      readonly accrueFee: boolean;
      readonly fraudSignal: FraudSignalKind | null;
      readonly reason: string;
    };

export type FraudSignalKind =
  /** Landlord alone claims the rental never happened — possible fee evasion. */
  | 'UNILATERAL_LANDLORD_DENIAL'
  /** Nobody confirmed and there is no check-in record. Weak signal, patterns matter. */
  | 'SILENT_COMPLETION_NO_EVIDENCE'
  /** The two parties contradict each other. */
  | 'COMPLETION_CONTRADICTION';

/**
 * Decide the outcome of a completion window. Pure: the caller supplies the clock
 * via `deadlinePassed`, so this is trivially testable and has no hidden time
 * dependency.
 */
export function resolveCompletion(input: CompletionInputs): CompletionOutcome {
  const { tenantAnswer, landlordAnswer, hasCheckInRecord, deadlinePassed } = input;

  // 1. Both answered and agree.
  if (tenantAnswer && landlordAnswer) {
    if (tenantAnswer === landlordAnswer) {
      return tenantAnswer === 'TOOK_PLACE'
        ? {
            kind: 'RESOLVED',
            state: 'COMPLETED',
            accrueFee: true,
            fraudSignal: null,
            reason: 'Both parties confirmed the rental took place.',
          }
        : {
            kind: 'RESOLVED',
            state: 'NOT_TAKEN_PLACE',
            accrueFee: false,
            fraudSignal: null,
            reason: 'Both parties confirmed the rental did not take place.',
          };
    }
    // 2. They contradict each other — a human must decide, and no fee accrues
    //    while the dispute is open.
    return {
      kind: 'RESOLVED',
      state: 'DISPUTED',
      accrueFee: false,
      fraudSignal: 'COMPLETION_CONTRADICTION',
      reason: 'The parties gave contradictory answers; escalated for review.',
    };
  }

  // 3. Landlord admits the rental happened. Self-incriminating, so it stands
  //    immediately without waiting for the tenant or the deadline.
  if (landlordAnswer === 'TOOK_PLACE' && tenantAnswer === null) {
    return {
      kind: 'RESOLVED',
      state: 'COMPLETED',
      accrueFee: true,
      fraudSignal: null,
      reason: 'Landlord confirmed the rental took place (admission against interest).',
    };
  }

  // Everything below needs the confirmation window to have closed.
  if (!deadlinePassed) {
    return {
      kind: 'PENDING',
      reason: tenantAnswer || landlordAnswer ? 'Awaiting the second party.' : 'Awaiting both parties.',
    };
  }

  // 4. Tenant said it happened; landlord stayed silent. Silence must not be a
  //    way to avoid the fee.
  if (tenantAnswer === 'TOOK_PLACE') {
    return {
      kind: 'RESOLVED',
      state: 'COMPLETED',
      accrueFee: true,
      fraudSignal: null,
      reason: 'Tenant confirmed the rental took place and the landlord did not respond in time.',
    };
  }

  // 5. Tenant said it did not happen; landlord stayed silent. The party with no
  //    financial incentive says there was no rental — believe them, no fee.
  if (tenantAnswer === 'DID_NOT_TAKE_PLACE') {
    return {
      kind: 'RESOLVED',
      state: 'NOT_TAKEN_PLACE',
      accrueFee: false,
      fraudSignal: null,
      reason: 'Tenant reported the rental did not take place and the landlord did not respond in time.',
    };
  }

  // 6. Landlord alone claims it did not happen. Honoured, but flagged: this is
  //    exactly the shape fee evasion takes.
  if (landlordAnswer === 'DID_NOT_TAKE_PLACE') {
    return {
      kind: 'RESOLVED',
      state: 'NOT_TAKEN_PLACE',
      accrueFee: false,
      fraudSignal: 'UNILATERAL_LANDLORD_DENIAL',
      reason: 'Only the landlord responded, stating the rental did not take place.',
    };
  }

  // 7. Total silence. Charge only against platform-held evidence.
  if (hasCheckInRecord) {
    return {
      kind: 'RESOLVED',
      state: 'COMPLETED',
      accrueFee: true,
      fraudSignal: null,
      reason: 'Neither party responded, but the platform holds a tenant check-in record.',
    };
  }

  return {
    kind: 'RESOLVED',
    state: 'NOT_TAKEN_PLACE',
    accrueFee: false,
    fraudSignal: 'SILENT_COMPLETION_NO_EVIDENCE',
    reason: 'Neither party responded and the platform holds no evidence the stay happened.',
  };
}

/** Default confirmation window after the stay ends. */
export const COMPLETION_WINDOW_DAYS = 7;

export function completionDeadline(stayEndsAt: Date, windowDays = COMPLETION_WINDOW_DAYS): Date {
  const d = new Date(stayEndsAt.getTime());
  d.setUTCDate(d.getUTCDate() + windowDays);
  return d;
}
