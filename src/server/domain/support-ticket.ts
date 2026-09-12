/**
 * Support tickets: the vocabulary and the transitions.
 *
 * Pure — no I/O, no clock. Deliberately the small sibling of
 * `dispute.ts`'s transition table, not a copy of the dispute domain itself:
 * there is no priority engine here (see the migration's header comment for
 * why — a ticket has no "is a stay active right now" signal to derive one
 * from) and no severity list. What is worth reusing from the dispute domain
 * is the SHAPE — a table of legal moves that both the service and the
 * console read from, so the console can never offer a transition the
 * service would refuse — not the booking-specific content.
 */

/** Mirrors the `support_ticket.status` CHECK constraint. */
export const TICKET_STATUSES = [
  /** Submitted, nobody has looked yet. */
  'OPEN',
  /** A staff member has taken it and is working it. */
  'IN_PROGRESS',
  /** Staff asked the person something; the clock is on them now. */
  'WAITING_ON_USER',
  /** Decided. Terminal. */
  'RESOLVED',
  /** Closed without a resolution — duplicate, spam, withdrawn. Terminal. */
  'CLOSED',
] as const;

export type TicketStatus = (typeof TICKET_STATUSES)[number];

export const TERMINAL_TICKET_STATUSES: readonly TicketStatus[] = ['RESOLVED', 'CLOSED'];

export const isTerminalTicket = (s: TicketStatus): boolean => TERMINAL_TICKET_STATUSES.includes(s);

/**
 * A fresh, deliberately small vocabulary — NOT `DISPUTE_CATEGORIES`.
 * A dispute's categories describe what went wrong during a stay
 * (cleanliness, a no-show); a support ticket can be about an account nobody
 * can sign into, or a bug in the listing form, which have no honest home in
 * that list. See DEC-073.
 */
export const TICKET_CATEGORIES = ['ACCOUNT', 'BILLING', 'LISTING', 'TECHNICAL', 'SAFETY', 'OTHER'] as const;

export type TicketCategory = (typeof TICKET_CATEGORIES)[number];

/**
 * Russian labels for the staff console, same convention as
 * `DISPUTE_CATEGORY_LABEL` in `dispute.ts` (the operations console is not
 * localised the way the public site is). The public ticket form uses
 * `messages/*\/support-tickets.json` instead, because that screen IS
 * localised.
 */
export const TICKET_CATEGORY_LABEL: Record<TicketCategory, string> = {
  ACCOUNT: 'Аккаунт и вход',
  BILLING: 'Оплата и сборы',
  LISTING: 'Объявление',
  TECHNICAL: 'Техническая проблема',
  SAFETY: 'Безопасность',
  OTHER: 'Другое',
};

/* ------------------------------------------------------------------ *
 * Transitions
 * ------------------------------------------------------------------ */

export const TICKET_ACTIONS = ['TAKE', 'REQUEST_INFO', 'RESUME', 'RESOLVE', 'CLOSE', 'REOPEN'] as const;

export type TicketAction = (typeof TICKET_ACTIONS)[number];

/** The staff permission a transition requires. Mirrors rbac.ts exactly, same as dispute.ts. */
export type TicketPermission = 'case.handle' | 'case.resolve';

export interface TicketTransition {
  readonly from: TicketStatus;
  readonly action: TicketAction;
  readonly to: TicketStatus;
  readonly permission: TicketPermission;
  /** A written reason is mandatory: the row is the record of why. */
  readonly requiresReason: boolean;
  readonly note?: string;
}

/**
 * The table is the source of truth. `applyTicketAction()` is the only way a
 * status changes, so the staff console cannot invent a move the service
 * refuses — identical discipline to `DISPUTE_TRANSITIONS`.
 *
 * RESOLVE and CLOSE need `case.resolve`, same split as disputes: SUPPORT and
 * MODERATOR can work a ticket end to end but only ADMIN can actually decide
 * or close it. TAKE only exists from OPEN — once picked up, a ticket goes
 * back to IN_PROGRESS via RESUME (the person replied) rather than TAKE
 * again, so "who is working this" reads as one continuous fact rather than
 * a series of re-claims.
 */
export const TICKET_TRANSITIONS: readonly TicketTransition[] = [
  { from: 'OPEN', action: 'TAKE', to: 'IN_PROGRESS', permission: 'case.handle', requiresReason: false },
  { from: 'OPEN', action: 'CLOSE', to: 'CLOSED', permission: 'case.resolve', requiresReason: true },

  {
    from: 'IN_PROGRESS',
    action: 'REQUEST_INFO',
    to: 'WAITING_ON_USER',
    permission: 'case.handle',
    requiresReason: true,
    note: 'The reason is the message the person receives.',
  },
  { from: 'IN_PROGRESS', action: 'RESOLVE', to: 'RESOLVED', permission: 'case.resolve', requiresReason: true },
  { from: 'IN_PROGRESS', action: 'CLOSE', to: 'CLOSED', permission: 'case.resolve', requiresReason: true },

  { from: 'WAITING_ON_USER', action: 'RESUME', to: 'IN_PROGRESS', permission: 'case.handle', requiresReason: false },
  {
    from: 'WAITING_ON_USER',
    action: 'REQUEST_INFO',
    to: 'WAITING_ON_USER',
    permission: 'case.handle',
    requiresReason: true,
    note: 'Self-loop: a follow-up question while still waiting on the same person.',
  },
  { from: 'WAITING_ON_USER', action: 'RESOLVE', to: 'RESOLVED', permission: 'case.resolve', requiresReason: true },
  { from: 'WAITING_ON_USER', action: 'CLOSE', to: 'CLOSED', permission: 'case.resolve', requiresReason: true },

  // A decided ticket can be reopened, because "we answered too fast" has to
  // be expressible. Costs `case.resolve` and a written reason; the original
  // decision stays in the ticket_event history either way.
  { from: 'RESOLVED', action: 'REOPEN', to: 'IN_PROGRESS', permission: 'case.resolve', requiresReason: true },
  { from: 'CLOSED', action: 'REOPEN', to: 'IN_PROGRESS', permission: 'case.resolve', requiresReason: true },
];

export class IllegalTicketTransitionError extends Error {
  constructor(
    readonly from: TicketStatus,
    readonly action: TicketAction,
    readonly reason: 'NO_SUCH_TRANSITION' | 'REASON_REQUIRED',
  ) {
    super(`Illegal ticket transition: ${from} --${action}-->: ${reason}`);
    this.name = 'IllegalTicketTransitionError';
  }
}

export function applyTicketAction(
  from: TicketStatus,
  action: TicketAction,
  opts: { hasReason: boolean },
): TicketTransition {
  const match = TICKET_TRANSITIONS.find((t) => t.from === from && t.action === action);
  if (!match) throw new IllegalTicketTransitionError(from, action, 'NO_SUCH_TRANSITION');
  if (match.requiresReason && !opts.hasReason) {
    throw new IllegalTicketTransitionError(from, action, 'REASON_REQUIRED');
  }
  return match;
}

/** Every action available from a status to a holder of these permissions. */
export function availableTicketActions(
  from: TicketStatus,
  permissions: { canHandle: boolean; canResolve: boolean },
): readonly TicketTransition[] {
  return TICKET_TRANSITIONS.filter(
    (t) =>
      t.from === from &&
      (t.permission === 'case.resolve' ? permissions.canResolve : permissions.canHandle),
  );
}
