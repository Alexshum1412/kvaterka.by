import { describe, it, expect } from 'vitest';
import {
  AUTH_LEVELS,
  base32Decode,
  base32Encode,
  BASE_LOCKOUT_SECONDS,
  lockedUntil,
  lockoutSeconds,
  MAX_LOCKOUT_SECONDS,
  effectiveRoles,
  generateRecoveryCodes,
  generateTotpSecret,
  isLockedOut,
  MAX_CHALLENGE_ATTEMPTS,
  needsStepUp,
  normaliseRecoveryCode,
  otpauthUri,
  RECOVERY_CODE_COUNT,
  requiresTwoFactor,
  STEP_UP_PERMISSIONS,
  STEP_UP_WINDOW_SECONDS,
  stepUpSatisfied,
  TOTP_DRIFT_STEPS,
  TOTP_STEP_SECONDS,
  totpCodeFor,
  totpStep,
  TWO_FACTOR_ROLES,
  verifyTotp,
  withheldRoles,
} from './two-factor.ts';
import { PERMISSIONS, ROLES, type Role } from '../auth/rbac.ts';

/* RFC 4648 §10 test vectors — the encoding must be interoperable with every
   authenticator app, and "it round-trips with itself" would not prove that. */
describe('base32', () => {
  const vectors: [string, string][] = [
    ['', ''],
    ['f', 'MY'],
    ['fo', 'MZXQ'],
    ['foo', 'MZXW6'],
    ['foob', 'MZXW6YQ'],
    ['fooba', 'MZXW6YTB'],
    ['foobar', 'MZXW6YTBOI'],
  ];

  for (const [plain, encoded] of vectors) {
    it(`encodes ${plain || '(empty)'} as ${encoded || '(empty)'}`, () => {
      expect(base32Encode(Buffer.from(plain))).toBe(encoded);
    });
    it(`decodes ${encoded || '(empty)'} back`, () => {
      expect(base32Decode(encoded).toString()).toBe(plain);
    });
  }

  it('ignores spacing and case, so a transcribed secret still works', () => {
    expect(base32Decode('mz xw-6y tb').toString()).toBe('fooba');
  });
});

/* RFC 6238 Appendix B, the SHA-1 rows. The published vectors use an ASCII
   secret, so it is base32-encoded here first. Getting these right is the
   difference between "our tests pass" and "Google Authenticator works". */
describe('TOTP against the RFC 6238 vectors', () => {
  const secret = base32Encode(Buffer.from('12345678901234567890'));
  const cases: [number, string][] = [
    [59, '287082'],
    [1111111109, '081804'],
    [1111111111, '050471'],
    [1234567890, '005924'],
    [2000000000, '279037'],
    [20000000000, '353130'],
  ];

  for (const [unixSeconds, expected] of cases) {
    it(`t=${unixSeconds} → ${expected}`, () => {
      const step = Math.floor(unixSeconds / TOTP_STEP_SECONDS);
      expect(totpCodeFor(secret, step)).toBe(expected);
    });
  }
});

describe('verifyTotp', () => {
  const secret = generateTotpSecret();
  const now = new Date('2026-08-18T12:00:00Z');

  it('accepts the current code', () => {
    const code = totpCodeFor(secret, totpStep(now));
    expect(verifyTotp(secret, code, now).valid).toBe(true);
  });

  it('accepts one step either side, for a clock that has drifted', () => {
    for (const offset of [-TOTP_DRIFT_STEPS, TOTP_DRIFT_STEPS]) {
      const code = totpCodeFor(secret, totpStep(now) + offset);
      expect(verifyTotp(secret, code, now).valid, `offset ${offset}`).toBe(true);
    }
  });

  it('refuses two steps away', () => {
    for (const offset of [-2, 2]) {
      const code = totpCodeFor(secret, totpStep(now) + offset);
      expect(verifyTotp(secret, code, now).valid, `offset ${offset}`).toBe(false);
    }
  });

  it('refuses a code from another secret', () => {
    const other = totpCodeFor(generateTotpSecret(), totpStep(now));
    // Astronomically unlikely to collide; if it ever does, the assertion below
    // is the one that would flake, not a real failure.
    expect(verifyTotp(secret, other, now).valid).toBe(false);
  });

  it('refuses malformed input without throwing', () => {
    for (const bad of ['', '12345', '1234567', 'abcdef', '   ', '<script>']) {
      expect(verifyTotp(secret, bad, now).valid, bad).toBe(false);
    }
  });

  it('tolerates a code typed with spaces', () => {
    const step = totpStep(now);
    const code = totpCodeFor(secret, step);
    const spaced = `${code.slice(0, 3)} ${code.slice(3)}`;
    expect(verifyTotp(secret, spaced, now).valid).toBe(true);
  });

  it('reports which step matched, so the caller can spend it', () => {
    const step = totpStep(now);
    expect(verifyTotp(secret, totpCodeFor(secret, step), now).step).toBe(step);
  });

  /* The assertion that makes a code single-use. Without it, a code read over a
     shoulder or captured by a phishing page is good for up to sixty seconds. */
  it('refuses a code that has already been spent', () => {
    const step = totpStep(now);
    const code = totpCodeFor(secret, step);
    expect(verifyTotp(secret, code, now, { lastUsedStep: step }).valid).toBe(false);
  });

  it('refuses an older code once a newer one has been used', () => {
    const step = totpStep(now);
    const older = totpCodeFor(secret, step - 1);
    expect(verifyTotp(secret, older, now, { lastUsedStep: step }).valid).toBe(false);
  });

  it('still accepts the next step after one is spent', () => {
    const step = totpStep(now);
    const later = new Date(now.getTime() + TOTP_STEP_SECONDS * 1000);
    const code = totpCodeFor(secret, step + 1);
    expect(verifyTotp(secret, code, later, { lastUsedStep: step }).valid).toBe(true);
  });
});

describe('the otpauth URI', () => {
  it('carries everything an authenticator needs', () => {
    const uri = otpauthUri('JBSWY3DPEHPK3PXP', 'verifier@demo.kvaterka.by');
    expect(uri.startsWith('otpauth://totp/')).toBe(true);
    expect(uri).toContain('secret=JBSWY3DPEHPK3PXP');
    expect(uri).toContain('digits=6');
    expect(uri).toContain('period=30');
    expect(uri).toContain('algorithm=SHA1');
  });

  it('escapes the label so an address cannot break the URI', () => {
    expect(otpauthUri('AAAA', 'a b@c.by')).not.toContain(' ');
  });
});

describe('recovery codes', () => {
  it('generates the declared number, all distinct', () => {
    const codes = generateRecoveryCodes();
    expect(codes.length).toBe(RECOVERY_CODE_COUNT);
    expect(new Set(codes).size).toBe(RECOVERY_CODE_COUNT);
  });

  it('produces a shape a person can write down and read back', () => {
    for (const code of generateRecoveryCodes(20)) {
      expect(code).toMatch(/^[A-Z2-7]{4}-[A-Z2-7]{4}$/);
    }
  });

  it('normalises case and punctuation so transcription is forgiving', () => {
    expect(normaliseRecoveryCode('ab2d-ef34')).toBe('AB2DEF34');
    expect(normaliseRecoveryCode('AB2D EF34')).toBe('AB2DEF34');
    expect(normaliseRecoveryCode('AB2DEF34')).toBe('AB2DEF34');
  });

  it('does not collide across a large sample', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 50; i += 1) for (const c of generateRecoveryCodes()) seen.add(c);
    expect(seen.size).toBe(50 * RECOVERY_CODE_COUNT);
  });
});

describe('who needs a second factor', () => {
  it('covers every staff role and no ordinary one', () => {
    for (const role of ROLES) {
      const staff = role !== 'TENANT' && role !== 'LANDLORD';
      expect(requiresTwoFactor([role]), role).toBe(staff);
    }
  });

  it('a landlord who is also a moderator needs one', () => {
    expect(requiresTwoFactor(['LANDLORD', 'MODERATOR'])).toBe(true);
  });

  it('an ordinary account does not', () => {
    expect(requiresTwoFactor(['TENANT', 'LANDLORD'])).toBe(false);
    expect(requiresTwoFactor([])).toBe(false);
  });
});

/* The enforcement mechanism itself. A staff member on a password-only session
   is handed no staff roles, so every can() in the codebase — router, page and
   service alike — answers false without knowing that 2FA exists. */
describe('effective roles', () => {
  const granted: Role[] = ['LANDLORD', 'VERIFIER', 'ADMIN'];

  it('withholds staff roles from a password-only session', () => {
    expect(effectiveRoles(granted, 'PASSWORD')).toEqual(['LANDLORD']);
  });

  it('grants everything once the second factor is satisfied', () => {
    expect(effectiveRoles(granted, 'TWO_FACTOR')).toEqual(granted);
  });

  it('leaves an ordinary account completely untouched', () => {
    const ordinary: Role[] = ['TENANT', 'LANDLORD'];
    expect(effectiveRoles(ordinary, 'PASSWORD')).toEqual(ordinary);
  });

  it('reports what was withheld, so the UI can explain rather than 404', () => {
    expect(withheldRoles(granted, 'PASSWORD')).toEqual(['VERIFIER', 'ADMIN']);
    expect(withheldRoles(granted, 'TWO_FACTOR')).toEqual([]);
  });

  it('never invents a role the user was not granted', () => {
    for (const level of AUTH_LEVELS) {
      for (const role of effectiveRoles(granted, level)) expect(granted).toContain(role);
    }
  });
});

describe('step-up', () => {
  it('names only permissions that exist', () => {
    for (const p of STEP_UP_PERMISSIONS) expect(PERMISSIONS).toContain(p);
  });

  it('covers the acts that are hard to undo', () => {
    for (const p of ['document.read', 'verification.decide', 'ledger.adjust', 'role.grant'] as const) {
      expect(needsStepUp(p), p).toBe(true);
    }
  });

  it('leaves ordinary queue work alone, so prompts stay meaningful', () => {
    for (const p of ['case.view', 'user.view', 'listing.moderate', 'debt.view'] as const) {
      expect(needsStepUp(p), p).toBe(false);
    }
  });

  it('counts a recent confirmation and not an old one', () => {
    const now = new Date('2026-08-18T12:00:00Z');
    const fresh = new Date(now.getTime() - (STEP_UP_WINDOW_SECONDS - 60) * 1000);
    const stale = new Date(now.getTime() - (STEP_UP_WINDOW_SECONDS + 60) * 1000);
    expect(stepUpSatisfied(fresh, now)).toBe(true);
    expect(stepUpSatisfied(stale, now)).toBe(false);
    expect(stepUpSatisfied(null, now)).toBe(false);
  });
});

describe('lockout', () => {
  it('locks at the declared attempt count', () => {
    expect(isLockedOut(MAX_CHALLENGE_ATTEMPTS - 1)).toBe(false);
    expect(isLockedOut(MAX_CHALLENGE_ATTEMPTS)).toBe(true);
  });

  it('does not punish an honest mistype', () => {
    for (let a = 0; a < MAX_CHALLENGE_ATTEMPTS; a += 1) expect(lockoutSeconds(a)).toBe(0);
  });

  it('doubles the wait for each further block of failures', () => {
    expect(lockoutSeconds(5)).toBe(BASE_LOCKOUT_SECONDS);
    expect(lockoutSeconds(10)).toBe(BASE_LOCKOUT_SECONDS * 2);
    expect(lockoutSeconds(15)).toBe(BASE_LOCKOUT_SECONDS * 4);
    expect(lockoutSeconds(20)).toBe(BASE_LOCKOUT_SECONDS * 8);
  });

  it('caps, so a locked-out colleague is not locked out for a decade', () => {
    expect(lockoutSeconds(500)).toBe(MAX_LOCKOUT_SECONDS);
  });

  /* The assertion that justifies the parameters, with the real numbers.

     A FIXED fifteen-minute lockout allows ~175000 guesses a year against a 10^6
     keyspace — roughly a one-in-six chance of hitting a given code within a year
     of patient attacking. That is the number "5 attempts then locked" hides.

     Escalation brings it to ~1850 a year, about 0.19%, a ~95x improvement. It is
     not zero, and the cap is why: refusing a staff member for weeks because
     somebody attacked them is itself a denial of service, so the wait stops at a
     day. What makes the residual acceptable is that this is the SECOND factor —
     an attacker needs the password too — and that a staff account sitting locked
     for 24 hours at a time is loud, audited and noticed. */
  it('reduces sustained guessing by two orders of magnitude', () => {
    const YEAR = 365 * 24 * 60 * 60;
    let elapsed = 0;
    let attempts = 0;
    while (elapsed < YEAR) {
      attempts += MAX_CHALLENGE_ATTEMPTS;
      elapsed += lockoutSeconds(attempts);
    }
    const fixedLockoutAttempts = (YEAR / BASE_LOCKOUT_SECONDS) * MAX_CHALLENGE_ATTEMPTS;
    expect(attempts).toBeLessThan(fixedLockoutAttempts / 50);
    // Under 0.5% per year of continuous attack, against an attacker who must
    // already hold the password.
    expect(attempts / 10 ** 6).toBeLessThan(0.005);
  });

  it('computes when the account may try again', () => {
    const at = new Date('2026-08-18T12:00:00Z');
    expect(lockedUntil(5, at).getTime() - at.getTime()).toBe(BASE_LOCKOUT_SECONDS * 1000);
    expect(lockedUntil(1, at).getTime()).toBe(at.getTime());
  });
});
