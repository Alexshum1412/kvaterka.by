/**
 * Booking lifecycle: states, events, and the transition table.
 *
 * DESIGN NOTE (DEC-006): the master specification's suggested state list mixes
 * two different aggregates — DRAFT / PENDING_MODERATION / PUBLISHED describe a
 * *listing*, not a *booking*. Merging them would give one enum two owners, two
 * lifecycles and two sets of permissions, which is how state machines rot. They
 * are modelled separately here: `ListingStatus` in ../listing/states.ts.
 *
 * The table below is the single source of truth. Nothing else in the codebase
 * may mutate `booking.status`; every change goes through `applyEvent()`, which
 * is what makes the audit trail complete by construction.
 */

export const BOOKING_STATES = [
  /** Tenant asked about a property; no dates are held. */
  'INQUIRY',
  /** Tenant asked to book specific dates. Does NOT hold the calendar. */
  'REQUESTED',
  /** A price/terms offer is on the table awaiting the counterparty. */
  'OFFER_PENDING',
  /** Landlord refused the request. Terminal. */
  'DECLINED',
  /** Tenant pulled the request before any decision. Terminal. */
  'WITHDRAWN',
  /** Nobody acted within the response window. Terminal. */
  'EXPIRED',
  /** Dates are locked and the calendar is held. Financial terms are frozen. */
  'CONFIRMED',
  /** Tenant confirmed arrival. */
  'CHECKED_IN',
  /** Stay end reached; awaiting two-sided completion confirmation. */
  'COMPLETION_PENDING',
  /** Both sides agree the rental happened. Service fee accrues exactly once. */
  'COMPLETED',
  /** Both sides agree the rental never happened. No fee. Terminal. */
  'NOT_TAKEN_PLACE',
  /** Tenant cancelled after confirmation. Terminal. */
  'CANCELLED_BY_TENANT',
  /** Landlord cancelled after confirmation. Terminal. */
  'CANCELLED_BY_LANDLORD',
  /** A case is open. Completion side effects are frozen until an admin rules. */
  'DISPUTED',
] as const;

export type BookingState = (typeof BOOKING_STATES)[number];

/** States in which the booking occupies the calendar and blocks overlaps. */
export const CALENDAR_BLOCKING_STATES: readonly BookingState[] = [
  'CONFIRMED',
  'CHECKED_IN',
  'COMPLETION_PENDING',
  'DISPUTED',
  'COMPLETED',
] as const;

/**
 * REQUESTED deliberately does NOT block the calendar (DEC-007): several tenants
 * may request the same dates, the landlord picks one, and the database EXCLUDE
 * constraint makes the first acceptance win. Blocking on request would let a
 * tenant freeze a landlord's calendar for free.
 */
export const TERMINAL_STATES: readonly BookingState[] = [
  'DECLINED',
  'WITHDRAWN',
  'EXPIRED',
  'COMPLETED',
  'NOT_TAKEN_PLACE',
  'CANCELLED_BY_TENANT',
  'CANCELLED_BY_LANDLORD',
] as const;

export const isTerminal = (s: BookingState): boolean => TERMINAL_STATES.includes(s);
export const blocksCalendar = (s: BookingState): boolean => CALENDAR_BLOCKING_STATES.includes(s);

/* ------------------------------------------------------------------ */

export const BOOKING_EVENTS = [
  'INQUIRE',
  'REQUEST',
  'MAKE_OFFER',
  'COUNTER_OFFER',
  'ACCEPT_OFFER',
  'INSTANT_BOOK',
  'ACCEPT_REQUEST',
  'DECLINE_REQUEST',
  'WITHDRAW',
  'EXPIRE',
  'CANCEL_BY_TENANT',
  'CANCEL_BY_LANDLORD',
  'CHECK_IN',
  'REACH_STAY_END',
  'CONFIRM_COMPLETION',
  'RESOLVE_COMPLETION',
  'OPEN_DISPUTE',
  'RESOLVE_DISPUTE_AS_COMPLETED',
  'RESOLVE_DISPUTE_AS_NOT_TAKEN_PLACE',
  'RESOLVE_DISPUTE_AS_CANCELLED',
] as const;

export type BookingEventType = (typeof BOOKING_EVENTS)[number];

/** Who is allowed to trigger a transition. SYSTEM = scheduled job / internal. */
export type Actor = 'TENANT' | 'LANDLORD' | 'ADMIN' | 'SYSTEM';

/**
 * Named side effects. The state machine is pure — it only *declares* what must
 * happen. `BookingService` executes these inside the same database transaction
 * as the status change, so a state change and its consequences cannot diverge.
 */
export type SideEffect =
  | 'HOLD_CALENDAR'
  | 'RELEASE_CALENDAR'
  | 'FREEZE_FINANCIAL_TERMS'
  | 'ACCRUE_SERVICE_FEE'
  | 'OPEN_REVIEW_WINDOW'
  | 'AUTO_DECLINE_COMPETING_REQUESTS'
  | 'RELEASE_CONTACT_DETAILS'
  | 'NOTIFY_TENANT'
  | 'NOTIFY_LANDLORD'
  | 'NOTIFY_ADMIN'
  | 'RECORD_FRAUD_SIGNAL';

export interface TransitionRule {
  readonly from: BookingState;
  readonly event: BookingEventType;
  readonly to: BookingState;
  readonly actors: readonly Actor[];
  readonly effects: readonly SideEffect[];
  /** Human-readable rule, mirrored into USER_FLOWS.md. */
  readonly note?: string;
}

export const TRANSITIONS: readonly TransitionRule[] = [
  // --- pre-booking conversation ---------------------------------------
  { from: 'INQUIRY', event: 'REQUEST', to: 'REQUESTED', actors: ['TENANT'], effects: ['NOTIFY_LANDLORD'] },
  { from: 'INQUIRY', event: 'MAKE_OFFER', to: 'OFFER_PENDING', actors: ['TENANT', 'LANDLORD'], effects: ['NOTIFY_TENANT', 'NOTIFY_LANDLORD'] },
  { from: 'INQUIRY', event: 'EXPIRE', to: 'EXPIRED', actors: ['SYSTEM'], effects: [] },
  { from: 'INQUIRY', event: 'WITHDRAW', to: 'WITHDRAWN', actors: ['TENANT'], effects: [] },

  // --- negotiation ------------------------------------------------------
  { from: 'OFFER_PENDING', event: 'COUNTER_OFFER', to: 'OFFER_PENDING', actors: ['TENANT', 'LANDLORD'], effects: ['NOTIFY_TENANT', 'NOTIFY_LANDLORD'], note: 'Self-loop; each counteroffer is an immutable BookingOffer row.' },
  {
    from: 'OFFER_PENDING',
    event: 'ACCEPT_OFFER',
    to: 'CONFIRMED',
    actors: ['TENANT', 'LANDLORD'],
    effects: ['FREEZE_FINANCIAL_TERMS', 'HOLD_CALENDAR', 'AUTO_DECLINE_COMPETING_REQUESTS', 'RELEASE_CONTACT_DETAILS', 'NOTIFY_TENANT', 'NOTIFY_LANDLORD'],
    note: 'Accepting party must be the one who did not make the last offer (guarded in service).',
  },
  { from: 'OFFER_PENDING', event: 'DECLINE_REQUEST', to: 'DECLINED', actors: ['LANDLORD'], effects: ['NOTIFY_TENANT'] },
  { from: 'OFFER_PENDING', event: 'WITHDRAW', to: 'WITHDRAWN', actors: ['TENANT'], effects: ['NOTIFY_LANDLORD'] },
  { from: 'OFFER_PENDING', event: 'EXPIRE', to: 'EXPIRED', actors: ['SYSTEM'], effects: ['NOTIFY_TENANT', 'NOTIFY_LANDLORD'] },

  // --- request-to-book --------------------------------------------------
  {
    from: 'REQUESTED',
    event: 'ACCEPT_REQUEST',
    to: 'CONFIRMED',
    actors: ['LANDLORD'],
    effects: ['FREEZE_FINANCIAL_TERMS', 'HOLD_CALENDAR', 'AUTO_DECLINE_COMPETING_REQUESTS', 'RELEASE_CONTACT_DETAILS', 'NOTIFY_TENANT'],
  },
  { from: 'REQUESTED', event: 'DECLINE_REQUEST', to: 'DECLINED', actors: ['LANDLORD'], effects: ['NOTIFY_TENANT'] },
  { from: 'REQUESTED', event: 'COUNTER_OFFER', to: 'OFFER_PENDING', actors: ['LANDLORD'], effects: ['NOTIFY_TENANT'] },
  { from: 'REQUESTED', event: 'WITHDRAW', to: 'WITHDRAWN', actors: ['TENANT'], effects: ['NOTIFY_LANDLORD'] },
  { from: 'REQUESTED', event: 'EXPIRE', to: 'EXPIRED', actors: ['SYSTEM'], effects: ['NOTIFY_TENANT', 'NOTIFY_LANDLORD'], note: 'Landlord response window elapsed.' },

  // --- instant booking --------------------------------------------------
  {
    from: 'INQUIRY',
    event: 'INSTANT_BOOK',
    to: 'CONFIRMED',
    actors: ['TENANT'],
    effects: ['FREEZE_FINANCIAL_TERMS', 'HOLD_CALENDAR', 'AUTO_DECLINE_COMPETING_REQUESTS', 'RELEASE_CONTACT_DETAILS', 'NOTIFY_TENANT', 'NOTIFY_LANDLORD'],
  },

  // --- confirmed stay ---------------------------------------------------
  { from: 'CONFIRMED', event: 'CANCEL_BY_TENANT', to: 'CANCELLED_BY_TENANT', actors: ['TENANT'], effects: ['RELEASE_CALENDAR', 'NOTIFY_LANDLORD'] },
  { from: 'CONFIRMED', event: 'CANCEL_BY_LANDLORD', to: 'CANCELLED_BY_LANDLORD', actors: ['LANDLORD'], effects: ['RELEASE_CALENDAR', 'NOTIFY_TENANT', 'RECORD_FRAUD_SIGNAL'], note: 'Landlord cancellations damage tenants most; always signalled for trust scoring.' },
  { from: 'CONFIRMED', event: 'CHECK_IN', to: 'CHECKED_IN', actors: ['TENANT'], effects: ['NOTIFY_LANDLORD'] },
  { from: 'CONFIRMED', event: 'REACH_STAY_END', to: 'COMPLETION_PENDING', actors: ['SYSTEM'], effects: ['NOTIFY_TENANT', 'NOTIFY_LANDLORD'], note: 'Tenant never pressed check-in but the stay window passed.' },
  { from: 'CONFIRMED', event: 'OPEN_DISPUTE', to: 'DISPUTED', actors: ['TENANT', 'LANDLORD'], effects: ['NOTIFY_ADMIN'] },

  { from: 'CHECKED_IN', event: 'REACH_STAY_END', to: 'COMPLETION_PENDING', actors: ['SYSTEM'], effects: ['NOTIFY_TENANT', 'NOTIFY_LANDLORD'] },
  { from: 'CHECKED_IN', event: 'CANCEL_BY_TENANT', to: 'CANCELLED_BY_TENANT', actors: ['TENANT'], effects: ['RELEASE_CALENDAR', 'NOTIFY_LANDLORD'], note: 'Early departure. Fee consequences are decided at completion, not here.' },
  { from: 'CHECKED_IN', event: 'OPEN_DISPUTE', to: 'DISPUTED', actors: ['TENANT', 'LANDLORD'], effects: ['NOTIFY_ADMIN'] },

  // --- two-sided completion --------------------------------------------
  {
    from: 'COMPLETION_PENDING',
    event: 'CONFIRM_COMPLETION',
    to: 'COMPLETION_PENDING',
    actors: ['TENANT', 'LANDLORD'],
    effects: [],
    note: 'Self-loop: records one side’s answer. RESOLVE_COMPLETION decides the outcome.',
  },
  {
    from: 'COMPLETION_PENDING',
    event: 'RESOLVE_COMPLETION',
    to: 'COMPLETED',
    actors: ['SYSTEM'],
    effects: ['ACCRUE_SERVICE_FEE', 'OPEN_REVIEW_WINDOW', 'NOTIFY_TENANT', 'NOTIFY_LANDLORD'],
    note: 'Chosen when the evidence says the rental happened. See resolveCompletion().',
  },
  {
    from: 'COMPLETION_PENDING',
    event: 'RESOLVE_COMPLETION',
    to: 'NOT_TAKEN_PLACE',
    actors: ['SYSTEM'],
    effects: ['RELEASE_CALENDAR', 'NOTIFY_TENANT', 'NOTIFY_LANDLORD'],
    note: 'No fee is owed when the rental demonstrably did not happen.',
  },
  {
    from: 'COMPLETION_PENDING',
    event: 'RESOLVE_COMPLETION',
    to: 'DISPUTED',
    actors: ['SYSTEM'],
    effects: ['NOTIFY_ADMIN', 'NOTIFY_TENANT', 'NOTIFY_LANDLORD'],
    note: 'The two sides contradict each other.',
  },
  { from: 'COMPLETION_PENDING', event: 'OPEN_DISPUTE', to: 'DISPUTED', actors: ['TENANT', 'LANDLORD'], effects: ['NOTIFY_ADMIN'] },

  // --- disputes ---------------------------------------------------------
  { from: 'DISPUTED', event: 'RESOLVE_DISPUTE_AS_COMPLETED', to: 'COMPLETED', actors: ['ADMIN'], effects: ['ACCRUE_SERVICE_FEE', 'OPEN_REVIEW_WINDOW', 'NOTIFY_TENANT', 'NOTIFY_LANDLORD'] },
  { from: 'DISPUTED', event: 'RESOLVE_DISPUTE_AS_NOT_TAKEN_PLACE', to: 'NOT_TAKEN_PLACE', actors: ['ADMIN'], effects: ['RELEASE_CALENDAR', 'NOTIFY_TENANT', 'NOTIFY_LANDLORD'] },
  { from: 'DISPUTED', event: 'RESOLVE_DISPUTE_AS_CANCELLED', to: 'CANCELLED_BY_LANDLORD', actors: ['ADMIN'], effects: ['RELEASE_CALENDAR', 'NOTIFY_TENANT', 'NOTIFY_LANDLORD'] },
];

/* ------------------------------------------------------------------ */

export class IllegalTransitionError extends Error {
  constructor(
    readonly from: BookingState,
    readonly event: BookingEventType,
    readonly actor: Actor,
    reason: 'NO_SUCH_TRANSITION' | 'ACTOR_NOT_ALLOWED' | 'AMBIGUOUS_TARGET',
  ) {
    super(`Illegal booking transition: ${from} --${event}--> (actor ${actor}): ${reason}`);
    this.name = 'IllegalTransitionError';
  }
}

export interface TransitionResult {
  readonly to: BookingState;
  readonly effects: readonly SideEffect[];
}

/**
 * Resolve a transition. Pure: no I/O, no clock, no randomness.
 *
 * `intendedTarget` is required only for RESOLVE_COMPLETION, the single event
 * that can legitimately lead to three different states depending on evidence
 * gathered by `resolveCompletion()`.
 */
export function applyEvent(
  from: BookingState,
  event: BookingEventType,
  actor: Actor,
  intendedTarget?: BookingState,
): TransitionResult {
  const candidates = TRANSITIONS.filter((t) => t.from === from && t.event === event);
  if (candidates.length === 0) throw new IllegalTransitionError(from, event, actor, 'NO_SUCH_TRANSITION');

  const permitted = candidates.filter((t) => t.actors.includes(actor));
  if (permitted.length === 0) throw new IllegalTransitionError(from, event, actor, 'ACTOR_NOT_ALLOWED');

  let chosen = permitted[0]!;
  if (permitted.length > 1) {
    if (!intendedTarget) throw new IllegalTransitionError(from, event, actor, 'AMBIGUOUS_TARGET');
    const match = permitted.find((t) => t.to === intendedTarget);
    if (!match) throw new IllegalTransitionError(from, event, actor, 'AMBIGUOUS_TARGET');
    chosen = match;
  } else if (intendedTarget && chosen.to !== intendedTarget) {
    throw new IllegalTransitionError(from, event, actor, 'AMBIGUOUS_TARGET');
  }

  return { to: chosen.to, effects: chosen.effects };
}

export function canApply(from: BookingState, event: BookingEventType, actor: Actor): boolean {
  return TRANSITIONS.some((t) => t.from === from && t.event === event && t.actors.includes(actor));
}

/** Every event a given actor could currently fire. Drives which buttons render. */
export function availableEvents(from: BookingState, actor: Actor): readonly BookingEventType[] {
  return [...new Set(TRANSITIONS.filter((t) => t.from === from && t.actors.includes(actor)).map((t) => t.event))];
}
