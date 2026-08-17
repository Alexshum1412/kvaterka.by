import { describe, expect, it } from 'vitest';
import {
  applyDisputeAction,
  availableDisputeActions,
  DISPUTE_CATEGORIES,
  DISPUTE_STATUSES,
  DISPUTE_TRANSITIONS,
  IllegalDisputeTransitionError,
  isOverdue,
  isTerminalDispute,
  priorityOf,
  SEVERE_CATEGORIES,
  SLA_HOURS,
  type DisputeCategory,
  type DisputeStatus,
} from './dispute.ts';

describe('transition table integrity', () => {
  it('references only declared statuses', () => {
    for (const t of DISPUTE_TRANSITIONS) {
      expect(DISPUTE_STATUSES).toContain(t.from);
      expect(DISPUTE_STATUSES).toContain(t.to);
    }
  });

  it('gives every status a way out, including the terminal ones', () => {
    const withExit = new Set(DISPUTE_TRANSITIONS.map((t) => t.from));
    // RESOLVED and CLOSED are terminal for the workflow but reopenable, because
    // "we decided this wrongly" has to be expressible.
    expect(DISPUTE_STATUSES.filter((s) => !withExit.has(s))).toEqual([]);
  });

  it('leaves no status unreachable except the entry status', () => {
    const reachable = new Set(DISPUTE_TRANSITIONS.map((t) => t.to));
    expect(DISPUTE_STATUSES.filter((s) => s !== 'OPEN' && !reachable.has(s))).toEqual([]);
  });

  it('requires a written reason for every consequential move', () => {
    // Taking a case and resuming it are bookkeeping. Everything that changes
    // what happens to a person must say why.
    const withoutReason = DISPUTE_TRANSITIONS.filter((t) => !t.requiresReason).map((t) => t.action);
    expect(new Set(withoutReason)).toEqual(new Set(['TAKE', 'RESUME']));
  });

  it('never lets case.handle alone close or resolve a case', () => {
    for (const t of DISPUTE_TRANSITIONS) {
      if (t.to === 'RESOLVED' || t.to === 'CLOSED') {
        expect(t.permission, `${t.from}--${t.action}`).toBe('case.resolve');
      }
    }
  });

  it('never lets case.handle alone reopen a decided case', () => {
    for (const t of DISPUTE_TRANSITIONS.filter((x) => x.action === 'REOPEN')) {
      expect(t.permission).toBe('case.resolve');
    }
  });
});

describe('applyDisputeAction', () => {
  it('walks a case from filing to a decision', () => {
    let s: DisputeStatus = 'OPEN';
    s = applyDisputeAction(s, 'TAKE', { hasReason: false }).to;
    expect(s).toBe('UNDER_REVIEW');
    s = applyDisputeAction(s, 'REQUEST_INFORMATION', { hasReason: true }).to;
    expect(s).toBe('WAITING_FOR_PARTY');
    s = applyDisputeAction(s, 'RESUME', { hasReason: false }).to;
    expect(s).toBe('UNDER_REVIEW');
    s = applyDisputeAction(s, 'RESOLVE', { hasReason: true }).to;
    expect(s).toBe('RESOLVED');
    expect(isTerminalDispute(s)).toBe(true);
  });

  it('refuses a move the table does not define', () => {
    expect(() => applyDisputeAction('OPEN', 'RESUME', { hasReason: false })).toThrow(
      IllegalDisputeTransitionError,
    );
    expect(() => applyDisputeAction('RESOLVED', 'ESCALATE', { hasReason: true })).toThrow(
      /NO_SUCH_TRANSITION/,
    );
  });

  it('refuses a consequential move with no reason', () => {
    expect(() => applyDisputeAction('UNDER_REVIEW', 'RESOLVE', { hasReason: false })).toThrow(
      /REASON_REQUIRED/,
    );
    expect(() => applyDisputeAction('OPEN', 'CLOSE', { hasReason: false })).toThrow(/REASON_REQUIRED/);
  });

  it('lets a follow-up request loop on WAITING_FOR_PARTY', () => {
    expect(applyDisputeAction('WAITING_FOR_PARTY', 'REQUEST_INFORMATION', { hasReason: true }).to).toBe(
      'WAITING_FOR_PARTY',
    );
  });
});

describe('availableDisputeActions drives the console', () => {
  it('offers a handler everything except deciding', () => {
    const actions = availableDisputeActions('UNDER_REVIEW', { canHandle: true, canResolve: false });
    expect(new Set(actions.map((a) => a.action))).toEqual(
      new Set(['REQUEST_INFORMATION', 'ESCALATE']),
    );
  });

  it('offers a resolver the decisions as well', () => {
    const actions = availableDisputeActions('UNDER_REVIEW', { canHandle: true, canResolve: true });
    expect(new Set(actions.map((a) => a.action))).toEqual(
      new Set(['REQUEST_INFORMATION', 'ESCALATE', 'RESOLVE', 'CLOSE']),
    );
  });

  it('offers nothing at all to somebody with neither permission', () => {
    for (const status of DISPUTE_STATUSES) {
      expect(availableDisputeActions(status, { canHandle: false, canResolve: false })).toEqual([]);
    }
  });

  it('does not let a handler pull an escalated case back down', () => {
    const actions = availableDisputeActions('ESCALATED', { canHandle: true, canResolve: false });
    expect(actions).toEqual([]);
  });
});

/* ================================================================== */

describe('priority', () => {
  const base = { bookingStatus: 'COMPLETION_PENDING', hasFraudSignal: false, ageHours: 1 } as const;

  it('is URGENT for a safety report during an active stay', () => {
    expect(priorityOf({ ...base, category: 'SAFETY_CONCERN', bookingStatus: 'CHECKED_IN' })).toBe('URGENT');
    expect(priorityOf({ ...base, category: 'SAFETY_CONCERN', bookingStatus: 'CONFIRMED' })).toBe('URGENT');
  });

  it('never treats a severe category as ordinary feedback', () => {
    for (const category of SEVERE_CATEGORIES) {
      for (const bookingStatus of [null, 'COMPLETED', 'CHECKED_IN', 'CANCELLED_BY_TENANT']) {
        const p = priorityOf({ ...base, category, bookingStatus });
        expect(['HIGH', 'URGENT'], `${category} / ${bookingStatus}`).toContain(p);
      }
    }
  });

  it('raises anything happening inside a live stay', () => {
    expect(priorityOf({ ...base, category: 'ACCESS_PROBLEM', bookingStatus: 'CHECKED_IN' })).toBe('URGENT');
    expect(priorityOf({ ...base, category: 'NO_SHOW', bookingStatus: 'CONFIRMED' })).toBe('URGENT');
    expect(priorityOf({ ...base, category: 'CLEANLINESS', bookingStatus: 'CHECKED_IN' })).toBe('HIGH');
  });

  it('treats an existing fraud signal as fraud', () => {
    expect(priorityOf({ ...base, category: 'CLEANLINESS', hasFraudSignal: true, bookingStatus: null })).toBe('HIGH');
  });

  it('escalates on age alone, so nothing rots at the bottom', () => {
    const old = { ...base, category: 'COMMUNICATION' as const, bookingStatus: null, ageHours: SLA_HOURS.NORMAL };
    expect(priorityOf({ ...old, ageHours: 1 })).toBe('LOW');
    expect(priorityOf(old)).toBe('HIGH');
  });

  it('is deterministic — the same inputs always give the same answer', () => {
    for (const category of DISPUTE_CATEGORIES) {
      for (const bookingStatus of [null, 'CONFIRMED', 'CHECKED_IN', 'COMPLETED']) {
        for (const ageHours of [0, 10, 100]) {
          const input = { category, bookingStatus, hasFraudSignal: false, ageHours };
          expect(priorityOf(input)).toBe(priorityOf(input));
        }
      }
    }
  });

  it('carries a target that gets tighter as priority rises', () => {
    expect(SLA_HOURS.URGENT).toBeLessThan(SLA_HOURS.HIGH);
    expect(SLA_HOURS.HIGH).toBeLessThan(SLA_HOURS.NORMAL);
    expect(SLA_HOURS.NORMAL).toBeLessThan(SLA_HOURS.LOW);
    expect(isOverdue('URGENT', SLA_HOURS.URGENT + 1)).toBe(true);
    expect(isOverdue('URGENT', SLA_HOURS.URGENT)).toBe(false);
  });

  it('assigns a priority to every category', () => {
    for (const category of DISPUTE_CATEGORIES as readonly DisputeCategory[]) {
      expect(priorityOf({ ...base, category })).toBeTruthy();
    }
  });
});
