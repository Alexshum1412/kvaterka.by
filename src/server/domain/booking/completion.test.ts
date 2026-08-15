import { describe, expect, it } from 'vitest';
import { completionDeadline, resolveCompletion, type CompletionInputs } from './completion.ts';

const base: CompletionInputs = {
  tenantAnswer: null,
  landlordAnswer: null,
  hasCheckInRecord: false,
  deadlinePassed: false,
};
const at = (o: Partial<CompletionInputs>): CompletionInputs => ({ ...base, ...o });

describe('both parties answered', () => {
  it('completes and charges the fee when both say it happened', () => {
    const r = resolveCompletion(at({ tenantAnswer: 'TOOK_PLACE', landlordAnswer: 'TOOK_PLACE' }));
    expect(r).toMatchObject({ kind: 'RESOLVED', state: 'COMPLETED', accrueFee: true, fraudSignal: null });
  });

  it('charges nothing when both say it did not happen', () => {
    const r = resolveCompletion(
      at({ tenantAnswer: 'DID_NOT_TAKE_PLACE', landlordAnswer: 'DID_NOT_TAKE_PLACE' }),
    );
    expect(r).toMatchObject({ kind: 'RESOLVED', state: 'NOT_TAKEN_PLACE', accrueFee: false });
  });

  it('escalates a contradiction without charging anyone', () => {
    const r = resolveCompletion(at({ tenantAnswer: 'TOOK_PLACE', landlordAnswer: 'DID_NOT_TAKE_PLACE' }));
    expect(r).toMatchObject({
      kind: 'RESOLVED',
      state: 'DISPUTED',
      accrueFee: false,
      fraudSignal: 'COMPLETION_CONTRADICTION',
    });
  });

  it('escalates the mirrored contradiction too', () => {
    const r = resolveCompletion(at({ tenantAnswer: 'DID_NOT_TAKE_PLACE', landlordAnswer: 'TOOK_PLACE' }));
    expect(r).toMatchObject({ state: 'DISPUTED', accrueFee: false });
  });
});

describe('before the deadline', () => {
  it('waits when nobody has answered', () => {
    expect(resolveCompletion(base).kind).toBe('PENDING');
  });

  it('waits when only the tenant has answered', () => {
    expect(resolveCompletion(at({ tenantAnswer: 'TOOK_PLACE' })).kind).toBe('PENDING');
  });

  it('does NOT wait when the landlord admits the rental happened', () => {
    // An admission against interest needs no corroboration.
    const r = resolveCompletion(at({ landlordAnswer: 'TOOK_PLACE' }));
    expect(r).toMatchObject({ kind: 'RESOLVED', state: 'COMPLETED', accrueFee: true });
  });

  it('waits when the landlord alone denies the rental', () => {
    // A denial is not self-incriminating, so the tenant gets the full window.
    expect(resolveCompletion(at({ landlordAnswer: 'DID_NOT_TAKE_PLACE' })).kind).toBe('PENDING');
  });
});

describe('after the deadline — fee-evasion resistance', () => {
  it('charges the fee when the tenant confirms and the landlord stays silent', () => {
    const r = resolveCompletion(at({ tenantAnswer: 'TOOK_PLACE', deadlinePassed: true }));
    expect(r).toMatchObject({ kind: 'RESOLVED', state: 'COMPLETED', accrueFee: true });
  });

  it('honours a lone landlord denial but records a fraud signal', () => {
    const r = resolveCompletion(at({ landlordAnswer: 'DID_NOT_TAKE_PLACE', deadlinePassed: true }));
    expect(r).toMatchObject({
      state: 'NOT_TAKEN_PLACE',
      accrueFee: false,
      fraudSignal: 'UNILATERAL_LANDLORD_DENIAL',
    });
  });

  it('believes a lone tenant denial without flagging the tenant', () => {
    const r = resolveCompletion(at({ tenantAnswer: 'DID_NOT_TAKE_PLACE', deadlinePassed: true }));
    expect(r).toMatchObject({ state: 'NOT_TAKEN_PLACE', accrueFee: false, fraudSignal: null });
  });

  it('charges on total silence when a check-in record exists', () => {
    const r = resolveCompletion(at({ deadlinePassed: true, hasCheckInRecord: true }));
    expect(r).toMatchObject({ state: 'COMPLETED', accrueFee: true });
  });

  it('never charges on total silence with no evidence at all', () => {
    const r = resolveCompletion(at({ deadlinePassed: true, hasCheckInRecord: false }));
    expect(r).toMatchObject({
      state: 'NOT_TAKEN_PLACE',
      accrueFee: false,
      fraudSignal: 'SILENT_COMPLETION_NO_EVIDENCE',
    });
  });
});

describe('invariants across the whole input space', () => {
  const answers = [null, 'TOOK_PLACE', 'DID_NOT_TAKE_PLACE'] as const;
  const all = answers.flatMap((t) =>
    answers.flatMap((l) =>
      [true, false].flatMap((checkIn) =>
        [true, false].map((passed) =>
          at({ tenantAnswer: t, landlordAnswer: l, hasCheckInRecord: checkIn, deadlinePassed: passed }),
        ),
      ),
    ),
  );

  it('covers every combination without throwing', () => {
    expect(all).toHaveLength(36);
    for (const input of all) expect(() => resolveCompletion(input)).not.toThrow();
  });

  it('only ever charges a fee together with the COMPLETED state', () => {
    for (const input of all) {
      const r = resolveCompletion(input);
      if (r.kind === 'RESOLVED' && r.accrueFee) expect(r.state).toBe('COMPLETED');
    }
  });

  it('never charges a fee while a dispute is open', () => {
    for (const input of all) {
      const r = resolveCompletion(input);
      if (r.kind === 'RESOLVED' && r.state === 'DISPUTED') expect(r.accrueFee).toBe(false);
    }
  });

  it('never charges a fee when the tenant says the rental did not happen', () => {
    for (const input of all.filter((i) => i.tenantAnswer === 'DID_NOT_TAKE_PLACE')) {
      const r = resolveCompletion(input);
      if (r.kind === 'RESOLVED') expect(r.accrueFee).toBe(false);
    }
  });

  it('always reaches a decision once the deadline has passed', () => {
    for (const input of all.filter((i) => i.deadlinePassed)) {
      expect(resolveCompletion(input).kind).toBe('RESOLVED');
    }
  });

  it('gives a landlord no silent path out of a fee the tenant has confirmed', () => {
    for (const input of all.filter((i) => i.tenantAnswer === 'TOOK_PLACE' && i.landlordAnswer !== 'DID_NOT_TAKE_PLACE')) {
      const r = resolveCompletion(input);
      if (r.kind === 'RESOLVED') {
        expect(r.state).toBe('COMPLETED');
        expect(r.accrueFee).toBe(true);
      }
    }
  });

  it('always explains itself', () => {
    for (const input of all) expect(resolveCompletion(input).reason.length).toBeGreaterThan(10);
  });
});

describe('completionDeadline', () => {
  it('adds the confirmation window in UTC', () => {
    expect(completionDeadline(new Date('2026-09-10T12:00:00Z')).toISOString()).toBe('2026-09-17T12:00:00.000Z');
  });

  it('crosses a month boundary correctly', () => {
    expect(completionDeadline(new Date('2026-08-30T00:00:00Z')).toISOString()).toBe('2026-09-06T00:00:00.000Z');
  });

  it('does not mutate its argument', () => {
    const d = new Date('2026-09-10T12:00:00Z');
    completionDeadline(d);
    expect(d.toISOString()).toBe('2026-09-10T12:00:00.000Z');
  });
});
