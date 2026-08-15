import { describe, expect, it } from 'vitest';
import {
  applyEvent,
  availableEvents,
  blocksCalendar,
  BOOKING_STATES,
  canApply,
  IllegalTransitionError,
  isTerminal,
  TRANSITIONS,
  type BookingState,
} from './states.ts';

describe('transition table integrity', () => {
  it('references only declared states', () => {
    for (const t of TRANSITIONS) {
      expect(BOOKING_STATES).toContain(t.from);
      expect(BOOKING_STATES).toContain(t.to);
    }
  });

  it('never allows an outgoing transition from a terminal state', () => {
    const offenders = TRANSITIONS.filter((t) => isTerminal(t.from)).map((t) => `${t.from}--${t.event}`);
    expect(offenders).toEqual([]);
  });

  it('leaves no state unreachable except the entry state', () => {
    const reachable = new Set<BookingState>(TRANSITIONS.map((t) => t.to));
    const unreachable = BOOKING_STATES.filter((s) => s !== 'INQUIRY' && !reachable.has(s));
    expect(unreachable).toEqual([]);
  });

  it('gives every non-terminal state a way out (no dead ends)', () => {
    const withExit = new Set<BookingState>(TRANSITIONS.map((t) => t.from));
    const stuck = BOOKING_STATES.filter((s) => !isTerminal(s) && !withExit.has(s));
    expect(stuck).toEqual([]);
  });

  it('assigns at least one actor to every transition', () => {
    expect(TRANSITIONS.filter((t) => t.actors.length === 0)).toEqual([]);
  });

  it('only ever accrues the service fee on a transition into COMPLETED', () => {
    const accruing = TRANSITIONS.filter((t) => t.effects.includes('ACCRUE_SERVICE_FEE'));
    expect(accruing.length).toBeGreaterThan(0);
    for (const t of accruing) expect(t.to).toBe('COMPLETED');
  });

  it('holds the calendar exactly when entering a blocking state', () => {
    for (const t of TRANSITIONS) {
      if (t.effects.includes('HOLD_CALENDAR')) expect(blocksCalendar(t.to)).toBe(true);
      if (t.effects.includes('RELEASE_CALENDAR')) expect(blocksCalendar(t.to)).toBe(false);
    }
  });

  it('freezes financial terms on every path into CONFIRMED', () => {
    for (const t of TRANSITIONS.filter((x) => x.to === 'CONFIRMED')) {
      expect(t.effects).toContain('FREEZE_FINANCIAL_TERMS');
    }
  });

  it('opens the review window only from a completed rental', () => {
    for (const t of TRANSITIONS.filter((x) => x.effects.includes('OPEN_REVIEW_WINDOW'))) {
      expect(t.to).toBe('COMPLETED');
    }
  });

  it('does not release contact details before a booking is confirmed', () => {
    for (const t of TRANSITIONS.filter((x) => x.effects.includes('RELEASE_CONTACT_DETAILS'))) {
      expect(t.to).toBe('CONFIRMED');
    }
  });
});

describe('applyEvent', () => {
  it('walks the happy path from inquiry to completion', () => {
    let s: BookingState = 'INQUIRY';
    s = applyEvent(s, 'REQUEST', 'TENANT').to;
    expect(s).toBe('REQUESTED');
    s = applyEvent(s, 'ACCEPT_REQUEST', 'LANDLORD').to;
    expect(s).toBe('CONFIRMED');
    s = applyEvent(s, 'CHECK_IN', 'TENANT').to;
    expect(s).toBe('CHECKED_IN');
    s = applyEvent(s, 'REACH_STAY_END', 'SYSTEM').to;
    expect(s).toBe('COMPLETION_PENDING');
    const done = applyEvent(s, 'RESOLVE_COMPLETION', 'SYSTEM', 'COMPLETED');
    expect(done.to).toBe('COMPLETED');
    expect(done.effects).toContain('ACCRUE_SERVICE_FEE');
  });

  it('supports instant booking straight to CONFIRMED', () => {
    const r = applyEvent('INQUIRY', 'INSTANT_BOOK', 'TENANT');
    expect(r.to).toBe('CONFIRMED');
    expect(r.effects).toContain('AUTO_DECLINE_COMPETING_REQUESTS');
  });

  it('refuses an unknown transition', () => {
    expect(() => applyEvent('CONFIRMED', 'ACCEPT_REQUEST', 'LANDLORD')).toThrow(IllegalTransitionError);
  });

  it('refuses a transition from a terminal state', () => {
    expect(() => applyEvent('COMPLETED', 'CANCEL_BY_TENANT', 'TENANT')).toThrow(IllegalTransitionError);
  });

  describe('authorization', () => {
    it('does not let a tenant accept their own booking request', () => {
      expect(() => applyEvent('REQUESTED', 'ACCEPT_REQUEST', 'TENANT')).toThrow(/ACTOR_NOT_ALLOWED/);
    });

    it('does not let a landlord withdraw the tenant’s request', () => {
      expect(() => applyEvent('REQUESTED', 'WITHDRAW', 'LANDLORD')).toThrow(/ACTOR_NOT_ALLOWED/);
    });

    it('does not let a tenant decline their own request', () => {
      expect(() => applyEvent('REQUESTED', 'DECLINE_REQUEST', 'TENANT')).toThrow(/ACTOR_NOT_ALLOWED/);
    });

    it('does not let a landlord cancel as if they were the tenant', () => {
      expect(() => applyEvent('CONFIRMED', 'CANCEL_BY_TENANT', 'LANDLORD')).toThrow(/ACTOR_NOT_ALLOWED/);
    });

    it('does not let a landlord resolve their own dispute', () => {
      expect(() => applyEvent('DISPUTED', 'RESOLVE_DISPUTE_AS_NOT_TAKEN_PLACE', 'LANDLORD')).toThrow(
        /ACTOR_NOT_ALLOWED/,
      );
      expect(() => applyEvent('DISPUTED', 'RESOLVE_DISPUTE_AS_NOT_TAKEN_PLACE', 'ADMIN').to).not.toThrow;
    });

    it('does not let a tenant fake a system expiry', () => {
      expect(() => applyEvent('REQUESTED', 'EXPIRE', 'TENANT')).toThrow(/ACTOR_NOT_ALLOWED/);
    });

    it('does not let a tenant self-resolve completion (fee bypass)', () => {
      expect(() => applyEvent('COMPLETION_PENDING', 'RESOLVE_COMPLETION', 'TENANT', 'COMPLETED')).toThrow(
        /ACTOR_NOT_ALLOWED/,
      );
    });

    it('does not let a landlord jump straight to NOT_TAKEN_PLACE to dodge the fee', () => {
      expect(() =>
        applyEvent('COMPLETION_PENDING', 'RESOLVE_COMPLETION', 'LANDLORD', 'NOT_TAKEN_PLACE'),
      ).toThrow(/ACTOR_NOT_ALLOWED/);
    });
  });

  describe('ambiguous targets', () => {
    it('requires an explicit target when one event has several outcomes', () => {
      expect(() => applyEvent('COMPLETION_PENDING', 'RESOLVE_COMPLETION', 'SYSTEM')).toThrow(/AMBIGUOUS_TARGET/);
    });

    it('accepts each legitimate target', () => {
      for (const target of ['COMPLETED', 'NOT_TAKEN_PLACE', 'DISPUTED'] as const) {
        expect(applyEvent('COMPLETION_PENDING', 'RESOLVE_COMPLETION', 'SYSTEM', target).to).toBe(target);
      }
    });

    it('rejects a target that is not reachable by that event', () => {
      expect(() => applyEvent('COMPLETION_PENDING', 'RESOLVE_COMPLETION', 'SYSTEM', 'CONFIRMED')).toThrow(
        /AMBIGUOUS_TARGET/,
      );
    });

    it('rejects a mismatched target on an unambiguous transition', () => {
      expect(() => applyEvent('REQUESTED', 'ACCEPT_REQUEST', 'LANDLORD', 'DECLINED')).toThrow(/AMBIGUOUS_TARGET/);
    });
  });
});

describe('availableEvents drives the UI', () => {
  it('offers a landlord accept/decline/counter on a pending request', () => {
    expect(new Set(availableEvents('REQUESTED', 'LANDLORD'))).toEqual(
      new Set(['ACCEPT_REQUEST', 'DECLINE_REQUEST', 'COUNTER_OFFER']),
    );
  });

  it('offers a tenant nothing on a terminal booking', () => {
    expect(availableEvents('COMPLETED', 'TENANT')).toEqual([]);
  });

  it('agrees with canApply', () => {
    for (const s of BOOKING_STATES) {
      for (const actor of ['TENANT', 'LANDLORD', 'ADMIN', 'SYSTEM'] as const) {
        for (const e of availableEvents(s, actor)) expect(canApply(s, e, actor)).toBe(true);
      }
    }
  });
});
