import { describe, it, expect } from 'vitest';
import {
  DATA_CLASS_LABEL,
  DISPOSITION_LABEL,
  ERASURE_BLOCKED_STEPS,
  ERASURE_BLOCKER_EXPLANATION,
  ERASURE_BLOCKERS,
  ERASURE_BUILT_STEPS,
  ERASURE_STEPS,
  HOLD_REASON_CODES,
  HOLD_REASON_LABEL,
  HOLD_REVIEW_DAYS,
  HOLD_TARGET_LABEL,
  HOLD_TARGET_TYPES,
  holdReviewOverdue,
  isTerminalRetention,
  OPEN_LEGAL_DEPENDENCIES,
  policyFor,
  PURGE_BLOCKER_LABEL,
  purgeEligibility,
  RETENTION_CATALOGUE,
  RETENTION_STATE_LABEL,
  RETENTION_STATES,
  retentionStateOf,
  type PurgeBlocker,
  type RetentionRow,
  type RetentionState,
} from './retention.ts';

const NOW = new Date('2026-06-01T12:00:00Z');
const PAST = new Date('2026-01-01T00:00:00Z');
const FUTURE = new Date('2027-01-01T00:00:00Z');

const row = (over: Partial<RetentionRow> = {}): RetentionRow => ({
  deletedAt: null,
  purgeAfter: null,
  purgedAt: null,
  held: false,
  ...over,
});

describe('retentionStateOf', () => {
  const cases: [string, RetentionRow, RetentionState][] = [
    ['nothing set at all', row(), 'ACTIVE'],
    ['window set, not yet due', row({ purgeAfter: FUTURE }), 'RETAINED'],
    ['window passed', row({ purgeAfter: PAST }), 'ELIGIBLE_FOR_PURGE'],
    ['soft deleted, no window', row({ deletedAt: PAST }), 'SOFT_DELETED'],
    ['soft deleted, window passed', row({ deletedAt: PAST, purgeAfter: PAST }), 'ELIGIBLE_FOR_PURGE'],
    ['soft deleted, window pending', row({ deletedAt: PAST, purgeAfter: FUTURE }), 'RETAINED'],
    ['purged', row({ purgedAt: PAST }), 'PURGED'],
    ['held', row({ held: true }), 'HELD'],
  ];

  for (const [name, input, expected] of cases) {
    it(`${name} → ${expected}`, () => {
      expect(retentionStateOf(input, NOW)).toBe(expected);
    });
  }

  it('PURGED beats everything, including a hold', () => {
    expect(retentionStateOf(row({ purgedAt: PAST, held: true, purgeAfter: PAST }), NOW)).toBe('PURGED');
  });

  /* The single most important assertion in this file. If HELD and
     ELIGIBLE_FOR_PURGE were ever evaluated the other way round, a held row
     would report itself purgeable and the console would offer a button that
     must not exist. */
  it('a hold beats a window that has already passed', () => {
    expect(retentionStateOf(row({ purgeAfter: PAST, held: true }), NOW)).toBe('HELD');
  });

  it('a window exactly at now is due, not pending', () => {
    expect(retentionStateOf(row({ purgeAfter: NOW }), NOW)).toBe('ELIGIBLE_FOR_PURGE');
  });

  it('a missing window never yields eligibility, however old the row', () => {
    // Fail-closed: the absence of a retention policy is not permission to destroy.
    expect(retentionStateOf(row({ deletedAt: new Date('2000-01-01') }), NOW)).toBe('SOFT_DELETED');
  });

  it('every declared state is reachable', () => {
    const reached = new Set<RetentionState>([
      ...cases.map(([, i]) => retentionStateOf(i, NOW)),
    ]);
    expect([...reached].sort()).toEqual([...RETENTION_STATES].sort());
  });

  it('only PURGED is terminal', () => {
    for (const s of RETENTION_STATES) expect(isTerminalRetention(s)).toBe(s === 'PURGED');
  });
});

describe('purgeEligibility', () => {
  const store = { storageConfigured: true };

  it('is eligible only when nothing at all objects', () => {
    const r = purgeEligibility(row({ purgeAfter: PAST }), NOW, store);
    expect(r.eligible).toBe(true);
    expect(r.blockers).toEqual([]);
    expect(r.explanation).toContain('можно уничтожать');
  });

  it('reports every blocker, not just the first', () => {
    const r = purgeEligibility(row({ held: true }), NOW, store);
    expect(r.blockers).toEqual(['LEGAL_HOLD', 'NO_RETENTION_POLICY']);
    expect(r.eligible).toBe(false);
  });

  it('an absent window blocks with NO_RETENTION_POLICY and names the legal question', () => {
    const r = purgeEligibility(row(), NOW, store);
    expect(r.blockers).toContain('NO_RETENTION_POLICY');
    expect(r.explanation).toContain('LEGAL-004');
  });

  it('a future window blocks with NOT_DUE, not NO_RETENTION_POLICY', () => {
    const r = purgeEligibility(row({ purgeAfter: FUTURE }), NOW, store);
    expect(r.blockers).toEqual(['NOT_DUE']);
  });

  it('unconfigured storage blocks on its own — the default', () => {
    const r = purgeEligibility(row({ purgeAfter: PAST }), NOW);
    expect(r.eligible).toBe(false);
    expect(r.blockers).toEqual(['STORAGE_UNAVAILABLE']);
    expect(r.explanation).toContain('не может подтвердить');
  });

  it('an already-purged row is blocked rather than silently re-purged', () => {
    expect(purgeEligibility(row({ purgedAt: PAST, purgeAfter: PAST }), NOW, store).blockers).toContain(
      'ALREADY_PURGED',
    );
  });

  it('every blocker has a label and an explanation', () => {
    const seen = new Set<PurgeBlocker>();
    for (const input of [
      row({ purgedAt: PAST }),
      row(),
      row({ purgeAfter: FUTURE }),
      row({ held: true }),
      row({ purgeAfter: PAST }),
    ]) {
      for (const b of purgeEligibility(input, NOW).blockers) seen.add(b);
    }
    expect(seen.size).toBe(Object.keys(PURGE_BLOCKER_LABEL).length);
    for (const b of seen) expect(PURGE_BLOCKER_LABEL[b].length).toBeGreaterThan(0);
  });
});

describe('the catalogue', () => {
  it('names every table exactly once', () => {
    const names = RETENTION_CATALOGUE.map((p) => p.table);
    expect(new Set(names).size).toBe(names.length);
  });

  it('is reachable by name', () => {
    expect(policyFor('verification_document')?.onErasure).toBe('PURGE_CONTENT');
    expect(policyFor('no_such_table')).toBeUndefined();
  });

  /* The rule the whole brief turns on: no invented durations. A window is
     either technical (the schema already decided), per-row (stored and
     auditable), indefinite (and says why), or UNKNOWN and names the question
     that would settle it. There is no fourth option and no number. */
  it('defines no retention period anywhere', () => {
    for (const p of RETENTION_CATALOGUE) {
      if (p.window.kind === 'UNKNOWN') {
        expect(p.window.blockedBy, p.table).toMatch(/^LEGAL-\d{3}$/);
        expect(p.window.why.length, p.table).toBeGreaterThan(0);
      }
      expect(JSON.stringify(p.window), p.table).not.toMatch(/\b(days?|дн|месяц|год|year|month)\b/i);
    }
  });

  it('financial and audit data is never scheduled for destruction', () => {
    for (const p of RETENTION_CATALOGUE) {
      if (p.dataClass === 'FINANCIAL' || p.dataClass === 'AUDIT') {
        expect(['KEEP', 'KEEP_AS_AUDIT'], `${p.table} (${p.dataClass})`).toContain(p.onErasure);
      }
    }
  });

  it('append-only tables are never hard-deleted on their own', () => {
    for (const p of RETENTION_CATALOGUE) {
      if (p.appendOnly) {
        expect(p.onErasure, p.table).not.toBe('HARD_DELETE');
        expect(p.onErasure, p.table).not.toBe('ANONYMISE');
      }
    }
  });

  it('only tables with a technical or per-row window are enforced today', () => {
    for (const p of RETENTION_CATALOGUE) {
      if (p.enforced) expect(['TECHNICAL', 'PER_ROW'], p.table).toContain(p.window.kind);
    }
  });

  it('hard deletion is reserved for rows with no audit or financial value', () => {
    for (const p of RETENTION_CATALOGUE) {
      if (p.onErasure === 'HARD_DELETE') {
        expect(['OPERATIONAL', 'PSEUDONYMOUS', 'PERSONAL'], p.table).toContain(p.dataClass);
        expect(p.appendOnly, p.table).not.toBe(true);
      }
    }
  });

  it('surfaces the open legal questions it depends on', () => {
    expect(OPEN_LEGAL_DEPENDENCIES).toContain('LEGAL-003');
    expect(OPEN_LEGAL_DEPENDENCIES).toContain('LEGAL-004');
    expect(OPEN_LEGAL_DEPENDENCIES).toContain('LEGAL-017');
    for (const ref of OPEN_LEGAL_DEPENDENCIES) expect(ref).toMatch(/^LEGAL-\d{3}$/);
  });

  it('every class and disposition used has a Russian label', () => {
    for (const p of RETENTION_CATALOGUE) {
      expect(DATA_CLASS_LABEL[p.dataClass], p.table).toBeTruthy();
      expect(DISPOSITION_LABEL[p.onErasure], p.table).toBeTruthy();
    }
  });
});

describe('legal hold vocabulary', () => {
  it('every target type and reason code has a label', () => {
    for (const t of HOLD_TARGET_TYPES) expect(HOLD_TARGET_LABEL[t]).toBeTruthy();
    for (const c of HOLD_REASON_CODES) expect(HOLD_REASON_LABEL[c]).toBeTruthy();
  });

  /* A reason code must describe why WE are holding, never assert a Belarusian
     legal requirement. LEGAL_QUESTION_UNRESOLVED is how an open question is
     named without pretending to know its answer. */
  it('no reason code claims a legal requirement', () => {
    for (const label of Object.values(HOLD_REASON_LABEL)) {
      expect(label).not.toMatch(/по закон|обязан|требован|законодательств/i);
    }
  });

  it('review becomes overdue only after the review cadence', () => {
    const placedAt = new Date('2026-01-01T00:00:00Z');
    const justBefore = new Date(placedAt.getTime() + (HOLD_REVIEW_DAYS - 1) * 86_400_000);
    const justAfter = new Date(placedAt.getTime() + HOLD_REVIEW_DAYS * 86_400_000);
    expect(holdReviewOverdue({ placedAt }, justBefore)).toBe(false);
    expect(holdReviewOverdue({ placedAt }, justAfter)).toBe(true);
  });
});

describe('erasure plan', () => {
  it('separates what is built from what a legal answer gates', () => {
    expect(ERASURE_BUILT_STEPS).toContain('REVOKE_SESSIONS');
    expect(ERASURE_BUILT_STEPS).toContain('CLOSE_ACCOUNT');
    expect(ERASURE_BUILT_STEPS).toContain('PRESERVE_REQUIRED');
    expect(ERASURE_BUILT_STEPS).not.toContain('ANONYMISE_PROFILE');
  });

  it('every unbuilt step names the question blocking it', () => {
    for (const s of ERASURE_BLOCKED_STEPS) expect(s.blockedBy, s.step).toMatch(/^LEGAL-\d{3}$/);
  });

  it('every built step has no blocker, and vice versa', () => {
    for (const s of ERASURE_STEPS) expect(s.built).toBe(s.blockedBy === null);
  });

  /* Destroying personal data is exactly the half that is not built. If this
     ever fails, someone has shipped a partial erasure — which looks finished
     to the person who asked for it and is not. */
  it('nothing that destroys personal data is marked built', () => {
    for (const s of ERASURE_STEPS) {
      if (s.step.startsWith('ANONYMISE') || s.step.startsWith('REDACT') || s.step.startsWith('PURGE')) {
        expect(s.built, s.step).toBe(false);
      }
    }
  });

  it('every erasure blocker explains itself in Russian', () => {
    for (const b of ERASURE_BLOCKERS) {
      expect(ERASURE_BLOCKER_EXPLANATION[b].length).toBeGreaterThan(20);
    }
  });
});

describe('labels', () => {
  it('every retention state has one', () => {
    for (const s of RETENTION_STATES) expect(RETENTION_STATE_LABEL[s]).toBeTruthy();
  });
});
