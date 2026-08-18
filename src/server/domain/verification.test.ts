import { describe, expect, it } from 'vitest';
import {
  applicantExplanation,
  applyVerificationAction,
  availableVerificationActions,
  evidenceSufficiency,
  firstFixTarget,
  IllegalVerificationTransitionError,
  isVerificationOverdue,
  kindForLevel,
  LEVEL_CLAIM,
  LEVEL_EXPLANATION,
  LEVEL_LABEL,
  REASON_FIX_TARGET,
  REASON_FOR_APPLICANT,
  VERIFICATION_REASON_CODES,
  VERIFICATION_SLA_HOURS,
  VERIFICATION_STATUSES,
  VERIFICATION_TRANSITIONS,
  verificationPriorityOf,
  type ActorCapabilities,
  type EvidenceInputs,
  type VerificationStatus,
} from './verification.ts';

const VERIFIER: ActorCapabilities = { canReview: true, canDecide: true, canReadDocuments: true };
const ADMIN: ActorCapabilities = { canReview: true, canDecide: true, canReadDocuments: false };
const REVIEWER: ActorCapabilities = { canReview: true, canDecide: false, canReadDocuments: false };
const NOBODY: ActorCapabilities = { canReview: false, canDecide: false, canReadDocuments: false };

const FULL_IDENTITY: EvidenceInputs = {
  kind: 'IDENTITY',
  identityDocumentCount: 1,
  hasSelfie: true,
  propertyDocumentCount: 0,
  hasDeclaredBasis: false,
  documentCollectionEnabled: true,
};

const FULL_PROPERTY: EvidenceInputs = {
  kind: 'PROPERTY_OWNERSHIP',
  identityDocumentCount: 1,
  hasSelfie: true,
  propertyDocumentCount: 1,
  hasDeclaredBasis: true,
  documentCollectionEnabled: true,
};

/* ================================================================== */

describe('levels are described as platform checks, not legal conclusions', () => {
  it('never claims a legal guarantee anywhere in the wording', () => {
    const all = [
      ...Object.values(LEVEL_LABEL),
      ...Object.values(LEVEL_CLAIM),
      ...Object.values(LEVEL_EXPLANATION),
      ...Object.values(REASON_FOR_APPLICANT),
    ].join(' ');

    // The exact phrasings the brief rules out, and the claims behind them.
    for (const forbidden of [
      'юридически подтвержд',
      'юридически заверен',
      'гарантируем',
      'гарантия безопасности',
      'подтверждено законом',
      'право собственности подтверждено',
    ]) {
      expect(all.toLowerCase(), forbidden).not.toContain(forbidden);
    }
  });

  it('says who did the checking', () => {
    expect(LEVEL_CLAIM[1]).toContain('платформой');
    expect(LEVEL_CLAIM[2]).toContain('платформой');
    // And says plainly what it is not.
    expect(LEVEL_EXPLANATION[1]).toContain('не юридическая экспертиза');
    expect(LEVEL_EXPLANATION[2]).toContain('не гарантирует');
  });

  it('maps a level to the kind of check it needs', () => {
    expect(kindForLevel(1)).toBe('IDENTITY');
    expect(kindForLevel(2)).toBe('PROPERTY_OWNERSHIP');
  });
});

/* ================================================================== */

describe('transition table integrity', () => {
  it('references only declared statuses', () => {
    for (const t of VERIFICATION_TRANSITIONS) {
      expect(VERIFICATION_STATUSES).toContain(t.from);
      expect(VERIFICATION_STATUSES).toContain(t.to);
    }
  });

  it('requires document access for approval and for nothing else', () => {
    const needing = VERIFICATION_TRANSITIONS.filter((t) => t.requiresDocumentAccess);
    expect(needing.length).toBeGreaterThan(0);
    for (const t of needing) expect(t.action).toBe('APPROVE');
  });

  it('requires a reason for every refusal', () => {
    for (const t of VERIFICATION_TRANSITIONS.filter((x) => x.to === 'REJECTED' || x.to === 'NEEDS_INFO')) {
      expect(t.requiresReason, `${t.from}--${t.action}`).toBe(true);
    }
  });

  it('never lets a mere reviewer decide', () => {
    for (const t of VERIFICATION_TRANSITIONS.filter((x) => x.to === 'APPROVED' || x.to === 'REJECTED')) {
      expect(t.permission).toBe('verification.decide');
    }
  });

  it('has no way to approve from NEEDS_INFO', () => {
    // Approving the version already called insufficient would be incoherent;
    // the applicant resubmits, which creates a fresh request.
    const fromNeedsInfo = VERIFICATION_TRANSITIONS.filter((t) => t.from === 'NEEDS_INFO');
    expect(fromNeedsInfo.map((t) => t.action)).not.toContain('APPROVE');
  });
});

describe('applyVerificationAction', () => {
  it('walks a request to approval', () => {
    let s: VerificationStatus = 'SUBMITTED';
    s = applyVerificationAction(s, 'TAKE', { hasReason: false, actor: VERIFIER }).to;
    expect(s).toBe('IN_REVIEW');
    s = applyVerificationAction(s, 'APPROVE', { hasReason: false, actor: VERIFIER, evidence: FULL_IDENTITY }).to;
    expect(s).toBe('APPROVED');
  });

  it('refuses approval to an actor who cannot open the documents', () => {
    // This is the incoherence the slice found: ADMIN holds verification.decide
    // and deliberately not document.read, so before this it could grant an
    // identity badge it was structurally forbidden from examining.
    expect(() =>
      applyVerificationAction('IN_REVIEW', 'APPROVE', { hasReason: false, actor: ADMIN, evidence: FULL_IDENTITY }),
    ).toThrow(/DOCUMENT_ACCESS_REQUIRED/);
  });

  it('lets that same actor refuse — you need not look to say "incomplete"', () => {
    expect(
      applyVerificationAction('IN_REVIEW', 'REJECT', { hasReason: true, actor: ADMIN }).to,
    ).toBe('REJECTED');
  });

  it('refuses approval with no evidence, whoever is asking', () => {
    expect(() =>
      applyVerificationAction('IN_REVIEW', 'APPROVE', {
        hasReason: false,
        actor: VERIFIER,
        evidence: { ...FULL_IDENTITY, identityDocumentCount: 0 },
      }),
    ).toThrow(/INSUFFICIENT_EVIDENCE/);

    // And with no evidence argument at all, which is the accidental-call case.
    expect(() =>
      applyVerificationAction('IN_REVIEW', 'APPROVE', { hasReason: false, actor: VERIFIER }),
    ).toThrow(/INSUFFICIENT_EVIDENCE/);
  });

  it('refuses a refusal with no reason', () => {
    expect(() =>
      applyVerificationAction('IN_REVIEW', 'REJECT', { hasReason: false, actor: VERIFIER }),
    ).toThrow(/REASON_REQUIRED/);
  });

  it('refuses a move the table does not define', () => {
    expect(() =>
      applyVerificationAction('APPROVED', 'REJECT', { hasReason: true, actor: VERIFIER }),
    ).toThrow(IllegalVerificationTransitionError);
    expect(() =>
      applyVerificationAction('SUBMITTED', 'APPROVE', { hasReason: false, actor: VERIFIER, evidence: FULL_IDENTITY }),
    ).toThrow(/NO_SUCH_TRANSITION/);
  });
});

describe('availableVerificationActions drives the console', () => {
  it('hides approve from somebody who cannot open a document', () => {
    const forAdmin = availableVerificationActions('IN_REVIEW', ADMIN).map((t) => t.action);
    expect(forAdmin).not.toContain('APPROVE');
    expect(forAdmin).toContain('REJECT');

    const forVerifier = availableVerificationActions('IN_REVIEW', VERIFIER).map((t) => t.action);
    expect(forVerifier).toContain('APPROVE');
  });

  it('offers a reviewer only the working moves', () => {
    const actions = availableVerificationActions('SUBMITTED', REVIEWER).map((t) => t.action);
    expect(new Set(actions)).toEqual(new Set(['TAKE', 'REQUEST_INFO', 'EXPIRE']));
  });

  it('offers nothing to somebody with no permissions', () => {
    for (const status of VERIFICATION_STATUSES) {
      expect(availableVerificationActions(status, NOBODY)).toEqual([]);
    }
  });
});

/* ================================================================== */

describe('evidence sufficiency is the fail-closed gate', () => {
  it('refuses everything while document collection is disabled', () => {
    const result = evidenceSufficiency({ ...FULL_PROPERTY, documentCollectionEnabled: false });
    expect(result.sufficient).toBe(false);
    expect(result.missing).toEqual(['DOCUMENT_COLLECTION_DISABLED']);
    // And says why, mentioning the legal question rather than looking broken.
    expect(result.explanation).toContain('LEGAL-004');
  });

  it('needs a document and a selfie for identity', () => {
    expect(evidenceSufficiency(FULL_IDENTITY).sufficient).toBe(true);
    expect(evidenceSufficiency({ ...FULL_IDENTITY, hasSelfie: false }).missing).toContain('NO_SELFIE');
    expect(evidenceSufficiency({ ...FULL_IDENTITY, identityDocumentCount: 0 }).missing).toContain(
      'NO_IDENTITY_DOCUMENT',
    );
  });

  it('needs identity AND property evidence for a right-to-let check', () => {
    expect(evidenceSufficiency(FULL_PROPERTY).sufficient).toBe(true);
    expect(evidenceSufficiency({ ...FULL_PROPERTY, propertyDocumentCount: 0 }).missing).toContain(
      'NO_PROPERTY_DOCUMENT',
    );
    // A declaration alone is never enough — that is the whole point of it being
    // a declaration.
    expect(
      evidenceSufficiency({ ...FULL_PROPERTY, propertyDocumentCount: 0, hasDeclaredBasis: true }).sufficient,
    ).toBe(false);
    expect(evidenceSufficiency({ ...FULL_PROPERTY, hasDeclaredBasis: false }).missing).toContain(
      'NO_DECLARED_BASIS',
    );
  });

  it('still requires identity evidence on a property request', () => {
    expect(
      evidenceSufficiency({ ...FULL_PROPERTY, identityDocumentCount: 0 }).missing,
    ).toContain('NO_IDENTITY_DOCUMENT');
  });
});

/* ================================================================== */

describe('rejection vocabulary', () => {
  it('gives every code an applicant explanation and a place to fix it', () => {
    for (const code of VERIFICATION_REASON_CODES) {
      expect(REASON_FOR_APPLICANT[code], code).toBeTruthy();
      expect(REASON_FIX_TARGET[code], code).toBeTruthy();
    }
  });

  it('tells a suspected-fraud applicant nothing about the signal', () => {
    const text = REASON_FOR_APPLICANT.SUSPICIOUS_ACTIVITY.toLowerCase();
    // No hint about what was detected — that would be a tutorial.
    for (const leak of ['устройств', 'ip', 'дубликат', 'повтор', 'сигнал']) {
      expect(text, leak).not.toContain(leak);
    }
    expect(REASON_FIX_TARGET.SUSPICIOUS_ACTIVITY).toBe('SUPPORT');
  });

  it('picks the earliest fix target so the button points somewhere precise', () => {
    expect(firstFixTarget(['SELFIE_MISMATCH', 'IDENTITY_DATA_MISMATCH'])).toBe('PROFILE_NAME');
    expect(firstFixTarget(['SELFIE_MISMATCH'])).toBe('SELFIE');
    expect(firstFixTarget([])).toBeNull();
  });

  it('builds a stable, de-duplicated explanation', () => {
    const lines = applicantExplanation(['DOCUMENT_EXPIRED', 'DOCUMENT_EXPIRED', 'SELFIE_MISMATCH']);
    expect(lines).toHaveLength(2);
    // Declaration order, not call order, so two verifiers produce the same letter.
    expect(lines[0]).toBe(REASON_FOR_APPLICANT.SELFIE_MISMATCH);
  });
});

/* ================================================================== */

describe('queue priority', () => {
  const base = { kind: 'IDENTITY' as const, hasPublishedListing: false, hasFraudSignal: false, ageHours: 1 };

  it('raises somebody whose listing is already bookable', () => {
    // They are being chosen by tenants right now on an unverified profile.
    expect(verificationPriorityOf({ ...base, hasPublishedListing: true })).toBe('HIGH');
  });

  it('raises a fraud signal and an aged request', () => {
    expect(verificationPriorityOf({ ...base, hasFraudSignal: true })).toBe('HIGH');
    expect(verificationPriorityOf({ ...base, ageHours: VERIFICATION_SLA_HOURS.NORMAL })).toBe('HIGH');
  });

  it('is deterministic', () => {
    for (const hasPublishedListing of [true, false]) {
      for (const ageHours of [0, 50, 200]) {
        const input = { ...base, hasPublishedListing, ageHours };
        expect(verificationPriorityOf(input)).toBe(verificationPriorityOf(input));
      }
    }
  });

  it('tightens the target as priority rises', () => {
    expect(VERIFICATION_SLA_HOURS.HIGH).toBeLessThan(VERIFICATION_SLA_HOURS.NORMAL);
    expect(isVerificationOverdue('HIGH', VERIFICATION_SLA_HOURS.HIGH + 1)).toBe(true);
    expect(isVerificationOverdue('HIGH', VERIFICATION_SLA_HOURS.HIGH)).toBe(false);
  });
});
