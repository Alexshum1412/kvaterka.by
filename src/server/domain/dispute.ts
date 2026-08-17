/**
 * Dispute cases: the vocabulary, the transitions, and how a case gets its
 * priority.
 *
 * Pure — no I/O, no clock beyond what the caller passes in. The service layer
 * reads these rules; it does not restate them.
 *
 * TWO DELIBERATE ABSENCES
 *
 * There is no `priority` column. Priority is DERIVED, every time, from facts
 * that already exist: the category, whether the stay is still running, whether
 * the platform holds a fraud signal, and how long the case has been open. A
 * stored column would be one more thing to keep in sync, and — more to the
 * point — one more thing a user could hope to influence. A derived one cannot
 * be set by anybody, which is exactly what §14 asks for.
 *
 * There is no resolution logic here either. Deciding a case does not decide the
 * booking: `RESOLVE_DISPUTE_AS_*` in the booking state machine is the only way
 * a booking leaves DISPUTED, and it is the only thing that can accrue or waive
 * a fee. This module never touches money.
 */

/** Mirrors the `dispute_case.status` CHECK constraint. Do not extend casually. */
export const DISPUTE_STATUSES = [
  /** Filed by a party, nobody has looked yet. */
  'OPEN',
  /** A staff member has taken it and is working. */
  'UNDER_REVIEW',
  /** Staff asked a party for something and the clock is on them. */
  'WAITING_FOR_PARTY',
  /** Needs a decision above the handler's authority. */
  'ESCALATED',
  /** Decided. Terminal. */
  'RESOLVED',
  /** Closed without a decision — duplicate, withdrawn, out of scope. Terminal. */
  'CLOSED',
] as const;

export type DisputeStatus = (typeof DISPUTE_STATUSES)[number];

export const TERMINAL_DISPUTE_STATUSES: readonly DisputeStatus[] = ['RESOLVED', 'CLOSED'];

export const isTerminalDispute = (s: DisputeStatus): boolean =>
  TERMINAL_DISPUTE_STATUSES.includes(s);

/** Mirrors the `dispute_case.category` CHECK constraint (0011 adds SAFETY_CONCERN). */
export const DISPUTE_CATEGORIES = [
  'LISTING_MISMATCH',
  'ACCESS_PROBLEM',
  'CLEANLINESS',
  'PROPERTY_DAMAGE',
  'PAYMENT_DISAGREEMENT',
  'COMMUNICATION',
  'SAFETY_CONCERN',
  'SUSPECTED_FRAUD',
  'CANCELLATION',
  'NO_SHOW',
  'OTHER',
] as const;

export type DisputeCategory = (typeof DISPUTE_CATEGORIES)[number];

export const DISPUTE_CATEGORY_LABEL: Record<DisputeCategory, string> = {
  LISTING_MISMATCH: 'Не соответствует объявлению',
  ACCESS_PROBLEM: 'Проблема с доступом',
  CLEANLINESS: 'Чистота',
  PROPERTY_DAMAGE: 'Повреждение имущества',
  PAYMENT_DISAGREEMENT: 'Разногласия по оплате',
  COMMUNICATION: 'Общение',
  SAFETY_CONCERN: 'Безопасность',
  SUSPECTED_FRAUD: 'Подозрение на мошенничество',
  CANCELLATION: 'Отмена',
  NO_SHOW: 'Сторона не пришла',
  OTHER: 'Другое',
};

/**
 * Categories that must never sit in a queue behind a complaint about towels.
 * Named here rather than inline so the list is reviewable in one place.
 */
export const SEVERE_CATEGORIES: readonly DisputeCategory[] = ['SAFETY_CONCERN', 'SUSPECTED_FRAUD'];

/* ------------------------------------------------------------------ *
 * Transitions
 * ------------------------------------------------------------------ */

export const DISPUTE_ACTIONS = [
  'TAKE',
  'REQUEST_INFORMATION',
  'RESUME',
  'ESCALATE',
  'RESOLVE',
  'CLOSE',
  'REOPEN',
] as const;

export type DisputeAction = (typeof DISPUTE_ACTIONS)[number];

/** The staff permission a transition requires. Mirrors rbac.ts exactly. */
export type CasePermission = 'case.handle' | 'case.resolve';

export interface DisputeTransition {
  readonly from: DisputeStatus;
  readonly action: DisputeAction;
  readonly to: DisputeStatus;
  readonly permission: CasePermission;
  /** A written reason is mandatory: the row is the record of why. */
  readonly requiresReason: boolean;
  readonly note?: string;
}

/**
 * The table is the source of truth. `applyDisputeAction()` is the only way a
 * status changes, so a staff console cannot invent a move the service refuses.
 *
 * RESOLVE and CLOSE need `case.resolve`, which only ADMIN holds. SUPPORT and
 * MODERATOR can work a case all the way to a recommendation and escalate it,
 * but they cannot close it — closing is what stops the parties being heard.
 */
export const DISPUTE_TRANSITIONS: readonly DisputeTransition[] = [
  { from: 'OPEN', action: 'TAKE', to: 'UNDER_REVIEW', permission: 'case.handle', requiresReason: false },
  { from: 'OPEN', action: 'ESCALATE', to: 'ESCALATED', permission: 'case.handle', requiresReason: true },
  { from: 'OPEN', action: 'CLOSE', to: 'CLOSED', permission: 'case.resolve', requiresReason: true },

  { from: 'UNDER_REVIEW', action: 'REQUEST_INFORMATION', to: 'WAITING_FOR_PARTY', permission: 'case.handle', requiresReason: true, note: 'The reason is the message the party receives.' },
  { from: 'UNDER_REVIEW', action: 'ESCALATE', to: 'ESCALATED', permission: 'case.handle', requiresReason: true },
  { from: 'UNDER_REVIEW', action: 'RESOLVE', to: 'RESOLVED', permission: 'case.resolve', requiresReason: true },
  { from: 'UNDER_REVIEW', action: 'CLOSE', to: 'CLOSED', permission: 'case.resolve', requiresReason: true },

  { from: 'WAITING_FOR_PARTY', action: 'RESUME', to: 'UNDER_REVIEW', permission: 'case.handle', requiresReason: false },
  { from: 'WAITING_FOR_PARTY', action: 'REQUEST_INFORMATION', to: 'WAITING_FOR_PARTY', permission: 'case.handle', requiresReason: true, note: 'Self-loop: a follow-up request to the same party.' },
  { from: 'WAITING_FOR_PARTY', action: 'ESCALATE', to: 'ESCALATED', permission: 'case.handle', requiresReason: true },
  { from: 'WAITING_FOR_PARTY', action: 'RESOLVE', to: 'RESOLVED', permission: 'case.resolve', requiresReason: true },
  { from: 'WAITING_FOR_PARTY', action: 'CLOSE', to: 'CLOSED', permission: 'case.resolve', requiresReason: true },

  { from: 'ESCALATED', action: 'TAKE', to: 'UNDER_REVIEW', permission: 'case.resolve', requiresReason: false, note: 'Only somebody who could decide it may pull it back down.' },
  { from: 'ESCALATED', action: 'RESOLVE', to: 'RESOLVED', permission: 'case.resolve', requiresReason: true },
  { from: 'ESCALATED', action: 'CLOSE', to: 'CLOSED', permission: 'case.resolve', requiresReason: true },

  // A decided case can be reopened, because "we got it wrong" has to be
  // expressible. It costs `case.resolve` and a written reason, and the original
  // decision stays in the case_event history either way.
  { from: 'RESOLVED', action: 'REOPEN', to: 'UNDER_REVIEW', permission: 'case.resolve', requiresReason: true },
  { from: 'CLOSED', action: 'REOPEN', to: 'UNDER_REVIEW', permission: 'case.resolve', requiresReason: true },
];

export class IllegalDisputeTransitionError extends Error {
  constructor(
    readonly from: DisputeStatus,
    readonly action: DisputeAction,
    readonly reason: 'NO_SUCH_TRANSITION' | 'REASON_REQUIRED',
  ) {
    super(`Illegal dispute transition: ${from} --${action}-->: ${reason}`);
    this.name = 'IllegalDisputeTransitionError';
  }
}

export function applyDisputeAction(
  from: DisputeStatus,
  action: DisputeAction,
  opts: { hasReason: boolean },
): DisputeTransition {
  const match = DISPUTE_TRANSITIONS.find((t) => t.from === from && t.action === action);
  if (!match) throw new IllegalDisputeTransitionError(from, action, 'NO_SUCH_TRANSITION');
  if (match.requiresReason && !opts.hasReason) {
    throw new IllegalDisputeTransitionError(from, action, 'REASON_REQUIRED');
  }
  return match;
}

/** Every action available from a status to a holder of these permissions. */
export function availableDisputeActions(
  from: DisputeStatus,
  permissions: { canHandle: boolean; canResolve: boolean },
): readonly DisputeTransition[] {
  return DISPUTE_TRANSITIONS.filter(
    (t) =>
      t.from === from &&
      (t.permission === 'case.resolve' ? permissions.canResolve : permissions.canHandle),
  );
}

/* ------------------------------------------------------------------ *
 * Priority
 * ------------------------------------------------------------------ */

export const DISPUTE_PRIORITIES = ['LOW', 'NORMAL', 'HIGH', 'URGENT'] as const;
export type DisputePriority = (typeof DISPUTE_PRIORITIES)[number];

export interface PriorityInputs {
  readonly category: DisputeCategory;
  /** Booking status at the time of asking; null when the case has no booking. */
  readonly bookingStatus: string | null;
  /** True when the platform already holds a fraud signal against either party. */
  readonly hasFraudSignal: boolean;
  readonly ageHours: number;
}

/**
 * Booking states in which somebody is currently living in the property. A
 * complaint from inside a stay is a different thing from a complaint about one
 * that ended last month: the person is still there.
 */
const ACTIVE_STAY_STATES = new Set(['CONFIRMED', 'CHECKED_IN']);

/** Hours after which an unresolved case is late, by the priority it started at. */
export const SLA_HOURS: Record<DisputePriority, number> = {
  URGENT: 4,
  HIGH: 24,
  NORMAL: 72,
  LOW: 168,
};

/**
 * Deterministic: the same inputs always give the same answer, and every input
 * is a fact the platform already holds. Nothing a user writes can raise it.
 */
export function priorityOf(input: PriorityInputs): DisputePriority {
  const activeStay = input.bookingStatus !== null && ACTIVE_STAY_STATES.has(input.bookingStatus);

  // Somebody is in the property and says it is not safe. Nothing outranks this.
  if (input.category === 'SAFETY_CONCERN') return activeStay ? 'URGENT' : 'HIGH';

  if (input.category === 'SUSPECTED_FRAUD' || input.hasFraudSignal) {
    return activeStay ? 'URGENT' : 'HIGH';
  }

  // Anything that leaves a person without the home they booked, while the stay
  // is running, is an emergency for them even if it is routine for us.
  if (activeStay && (input.category === 'ACCESS_PROBLEM' || input.category === 'NO_SHOW')) {
    return 'URGENT';
  }
  if (activeStay) return 'HIGH';

  // Age alone escalates, so nothing rots quietly at the bottom of the queue.
  if (input.ageHours >= SLA_HOURS.NORMAL) return 'HIGH';
  if (input.category === 'PROPERTY_DAMAGE' || input.category === 'PAYMENT_DISAGREEMENT') {
    return 'NORMAL';
  }
  if (input.category === 'COMMUNICATION' || input.category === 'OTHER') return 'LOW';
  return 'NORMAL';
}

/** Whether a case has been open past the target for its priority. */
export function isOverdue(priority: DisputePriority, ageHours: number): boolean {
  return ageHours > SLA_HOURS[priority];
}

/**
 * SQL for the same rule, so ordering and pagination happen in the database.
 *
 * It has to exist in two places because the queue cannot sort or paginate on a
 * value computed in JavaScript after the rows arrive — that would mean loading
 * the whole table to order it, which §4 rules out. Two implementations of one
 * rule will drift, so `tests/staff-operations.integration.test.ts` runs the
 * matrix of every category × booking state through both and asserts they agree.
 *
 * Expects `dc` (dispute_case), `b` (booking, left-joined) and a boolean
 * `has_fraud_signal` in scope.
 */
export const PRIORITY_SQL = `
  CASE
    WHEN dc.category = 'SAFETY_CONCERN'
      THEN CASE WHEN b.status IN ('CONFIRMED','CHECKED_IN') THEN 'URGENT' ELSE 'HIGH' END
    WHEN dc.category = 'SUSPECTED_FRAUD' OR fs.has_signal
      THEN CASE WHEN b.status IN ('CONFIRMED','CHECKED_IN') THEN 'URGENT' ELSE 'HIGH' END
    WHEN b.status IN ('CONFIRMED','CHECKED_IN') AND dc.category IN ('ACCESS_PROBLEM','NO_SHOW')
      THEN 'URGENT'
    WHEN b.status IN ('CONFIRMED','CHECKED_IN') THEN 'HIGH'
    WHEN EXTRACT(EPOCH FROM (now() - dc.created_at)) / 3600 >= ${SLA_HOURS.NORMAL} THEN 'HIGH'
    WHEN dc.category IN ('PROPERTY_DAMAGE','PAYMENT_DISAGREEMENT') THEN 'NORMAL'
    WHEN dc.category IN ('COMMUNICATION','OTHER') THEN 'LOW'
    ELSE 'NORMAL'
  END`;

/** Ordering weight, most urgent first. Used by the queue's ORDER BY. */
export const PRIORITY_RANK_SQL = `
  CASE ${PRIORITY_SQL}
    WHEN 'URGENT' THEN 0 WHEN 'HIGH' THEN 1 WHEN 'NORMAL' THEN 2 ELSE 3
  END`;
