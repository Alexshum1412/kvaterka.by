/**
 * Two-factor authentication for staff.
 *
 * Pure — no I/O, no clock beyond what the caller passes in. The service layer
 * reads these rules; it does not restate them.
 *
 * WHY THIS IS NOT A LIBRARY
 *
 * TOTP is a hash, a counter and eight lines of bit manipulation (RFC 6238).
 * This project's dependency list is deliberately five packages long, and a
 * dependency that lives on the authentication path is one whose every future
 * version is a supply-chain decision. `node:crypto` already provides the only
 * primitive required.
 *
 * THE CENTRAL DESIGN DECISION IS NOT HERE — IT IS IN HOW ROLES ARE RESOLVED.
 *
 * A 2FA check placed at the HTTP layer would be decoration in this codebase,
 * because server components reach privileged services without passing through
 * the router at all (`src/app/staff/**` call `services.*` directly after their
 * own `can()` check). Any design of the form "add a check to the route" leaves
 * every console page unprotected and cannot be made safe by remembering harder.
 *
 * So the capability is WITHHELD rather than checked: a session that has not
 * satisfied its second factor does not carry staff roles at all. `can()` then
 * returns false everywhere, in the router and in a page and in a service,
 * because the role is not in the array — there is no check to forget. This
 * module supplies the policy; `AuthService.resolveSession` applies it.
 */

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { ROLES, type Permission, type Role } from '../auth/rbac.ts';

/* ================================================================== *
 * Policy: who needs a second factor, and for what
 * ================================================================== */

/**
 * Roles that may not operate on a password alone.
 *
 * Every staff role is here, and the reasoning is the same for all five: each
 * can reach something a password-only compromise must not reach — someone's
 * passport, someone's dispute, someone's debt, or the switch that decides what
 * the platform destroys. There is no staff role whose blast radius is small
 * enough to leave outside.
 *
 * TENANT and LANDLORD are deliberately absent. An ordinary account holds no
 * staff permission, and imposing an authenticator app on somebody renting a
 * flat for the weekend would be security theatre paid for by the wrong person.
 *
 * Derived by SUBTRACTION from `ROLES` rather than listed, so that a role added
 * in future is covered the moment it exists. A hand-written list would leave
 * the next staff role unprotected until somebody remembered this file, and
 * "remembered to add it" is precisely the failure this design is avoiding
 * everywhere else.
 */
export const TWO_FACTOR_ROLES: readonly Role[] = ROLES.filter((r) => r !== 'TENANT' && r !== 'LANDLORD');

export const requiresTwoFactor = (roles: readonly Role[]): boolean =>
  roles.some((r) => TWO_FACTOR_ROLES.includes(r));

/**
 * Permissions that additionally demand a RECENT confirmation, not merely a
 * session that once passed a challenge.
 *
 * The distinction that matters: ordinary staff work — reading a queue, taking a
 * case, writing a note — happens all day and re-prompting for it would train
 * people to type codes without reading what they are confirming, which is worse
 * than not prompting. These are the acts that are hard to undo or that touch
 * something irreversible, and each is rare enough that a prompt is noticed.
 */
export const STEP_UP_PERMISSIONS: readonly Permission[] = [
  /** Opening somebody's passport. The narrowest permission in the system. */
  'document.read',
  /** Granting a trust badge a tenant will rely on. */
  'verification.decide',
  /** Money: writing the ledger, or forgiving a fee. */
  'ledger.adjust',
  'fee.waive',
  /** Taking somebody's account away. */
  'user.suspend',
  /** Handing out privilege, including this one. */
  'role.grant',
  /** Switching a legally gated feature on. */
  'feature_flag.write',
  /** Re-enabling destruction of data somebody ordered kept. */
  'retention.hold',
];

export const needsStepUp = (permission: Permission): boolean => STEP_UP_PERMISSIONS.includes(permission);

/**
 * How long a confirmation counts as recent.
 *
 * Fifteen minutes is a working session at one task, not a working day. Long
 * enough to open six documents in a row without a second prompt; short enough
 * that a machine left unlocked at lunch is not a standing authorisation to read
 * passports.
 *
 * This is a security cadence, not a retention period — it decides how often a
 * person re-confirms, never how long any data is kept.
 */
export const STEP_UP_WINDOW_SECONDS = 15 * 60;

export const stepUpSatisfied = (confirmedAt: Date | null, now: Date): boolean =>
  confirmedAt !== null && now.getTime() - confirmedAt.getTime() <= STEP_UP_WINDOW_SECONDS * 1000;

/* ================================================================== *
 * Authentication level
 * ================================================================== */

/**
 * What a session has actually proved.
 *
 * Stored on `user_session`, not derived, because it is a historical fact about
 * an event that happened: this session passed a challenge at this moment.
 */
export const AUTH_LEVELS = [
  /** A password was accepted. For an ordinary account this is full access. */
  'PASSWORD',
  /** A second factor was accepted for this session. */
  'TWO_FACTOR',
] as const;

export type AuthLevel = (typeof AUTH_LEVELS)[number];

/**
 * The roles a session may actually exercise.
 *
 * This is the whole enforcement mechanism. A staff member on a PASSWORD session
 * is handed an empty role list, so every `can()` in the codebase — router,
 * page, service — answers false without knowing 2FA exists.
 *
 * Their ordinary-user access is untouched: a moderator who is also a landlord
 * still sees their own flats. Only the staff grants are withheld.
 */
export function effectiveRoles(granted: readonly Role[], level: AuthLevel): readonly Role[] {
  if (level === 'TWO_FACTOR') return granted;
  return granted.filter((r) => !TWO_FACTOR_ROLES.includes(r));
}

/** Roles held but not currently usable, so the UI can explain rather than 404. */
export function withheldRoles(granted: readonly Role[], level: AuthLevel): readonly Role[] {
  if (level === 'TWO_FACTOR') return [];
  return granted.filter((r) => TWO_FACTOR_ROLES.includes(r));
}

/* ================================================================== *
 * TOTP (RFC 6238)
 * ================================================================== */

/** Thirty seconds is the interoperable default; every authenticator assumes it. */
export const TOTP_STEP_SECONDS = 30;
export const TOTP_DIGITS = 6;

/**
 * How far out of step a code may be.
 *
 * One step either side, so a phone whose clock is up to thirty seconds off, or
 * a person who starts typing as the code rolls over, still gets in. Each extra
 * step of tolerance multiplies the guessing surface, so this stays at one.
 */
export const TOTP_DRIFT_STEPS = 1;

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** RFC 4648 base32, no padding — the encoding every authenticator app expects. */
export function base32Encode(bytes: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(input: string): Buffer {
  const clean = input.toUpperCase().replace(/[^A-Z2-7]/g, '');
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const char of clean) {
    const index = BASE32.indexOf(char);
    if (index < 0) continue;
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** 160 bits, matching the HMAC-SHA1 block the algorithm uses. */
export function generateTotpSecret(): string {
  return base32Encode(randomBytes(20));
}

export const totpStep = (now: Date): number => Math.floor(now.getTime() / 1000 / TOTP_STEP_SECONDS);

/**
 * The code for one counter value.
 *
 * Dynamic truncation per RFC 4226 §5.3: the low nibble of the last byte picks
 * where to read four bytes, the top bit is masked off to dodge sign confusion,
 * and the result is taken modulo 10^digits.
 */
export function totpCodeFor(secretBase32: string, step: number): string {
  const key = base32Decode(secretBase32);
  const counter = Buffer.alloc(8);
  counter.writeUInt32BE(Math.floor(step / 0x100000000), 0);
  counter.writeUInt32BE(step >>> 0, 4);

  const digest = createHmac('sha1', key).update(counter).digest();
  const offset = digest[digest.length - 1]! & 0x0f;
  const binary =
    ((digest[offset]! & 0x7f) << 24) |
    ((digest[offset + 1]! & 0xff) << 16) |
    ((digest[offset + 2]! & 0xff) << 8) |
    (digest[offset + 3]! & 0xff);

  return String(binary % 10 ** TOTP_DIGITS).padStart(TOTP_DIGITS, '0');
}

export interface TotpResult {
  readonly valid: boolean;
  /** The step the code belongs to. Stored to refuse the same code twice. */
  readonly step: number | null;
}

/**
 * Verify a code, and say WHICH step it matched.
 *
 * Returning the step is the point. A TOTP code stays valid for its whole
 * window, so correctness alone lets the same code be replayed — anybody who
 * reads it over a shoulder, or off a phishing page, has up to sixty seconds to
 * use it again. The caller records the matched step and refuses anything at or
 * below it, which makes every code single-use.
 *
 * The comparison is constant-time. The codes are short and the window is small,
 * so a timing attack here is not the likeliest threat — but comparing secrets
 * with `===` is the kind of thing that is right until the day the surrounding
 * code changes.
 */
export function verifyTotp(
  secretBase32: string,
  code: string,
  now: Date,
  opts: { lastUsedStep?: number | null } = {},
): TotpResult {
  const cleaned = code.replace(/\D/g, '');
  if (cleaned.length !== TOTP_DIGITS) return { valid: false, step: null };

  const current = totpStep(now);
  for (let offset = -TOTP_DRIFT_STEPS; offset <= TOTP_DRIFT_STEPS; offset += 1) {
    const step = current + offset;
    // Replay: this code, or an older one, has already been spent.
    if (opts.lastUsedStep != null && step <= opts.lastUsedStep) continue;

    const expected = Buffer.from(totpCodeFor(secretBase32, step));
    const actual = Buffer.from(cleaned);
    if (expected.length === actual.length && timingSafeEqual(expected, actual)) {
      return { valid: true, step };
    }
  }
  return { valid: false, step: null };
}

/**
 * The URI an authenticator app reads from a QR code.
 *
 * The label carries the account so a person with several work accounts can tell
 * them apart in a list of six-digit codes that otherwise look identical.
 */
export function otpauthUri(secretBase32: string, account: string, issuer = 'Кватэрка.by'): string {
  const label = encodeURIComponent(`${issuer}:${account}`);
  const params = new URLSearchParams({
    secret: secretBase32,
    issuer,
    algorithm: 'SHA1',
    digits: String(TOTP_DIGITS),
    period: String(TOTP_STEP_SECONDS),
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}

/* ================================================================== *
 * Recovery codes
 * ================================================================== */

/**
 * Ten codes. Enough that losing a phone is an inconvenience rather than an
 * incident, few enough that a person still treats the list as worth keeping.
 */
export const RECOVERY_CODE_COUNT = 10;

/** 40 bits per code — far beyond guessing, and still readable aloud. */
const RECOVERY_BYTES = 5;

/**
 * Grouped into two blocks so it can be transcribed without losing your place.
 * Uppercase base32 with no ambiguous characters, because these get written down.
 */
export function generateRecoveryCodes(count = RECOVERY_CODE_COUNT): string[] {
  return Array.from({ length: count }, () => {
    const raw = base32Encode(randomBytes(RECOVERY_BYTES)).slice(0, 8);
    return `${raw.slice(0, 4)}-${raw.slice(4, 8)}`;
  });
}

/** Normalise before hashing so case and the dash do not decide correctness. */
export const normaliseRecoveryCode = (code: string): string =>
  code.toUpperCase().replace(/[^A-Z2-7]/g, '');

/* ================================================================== *
 * Failure vocabulary
 * ================================================================== */

/**
 * Every reason a challenge fails.
 *
 * They exist for the audit row and for the operator reading it, NOT for the
 * response: a caller is told the same thing whichever of these fired. Saying
 * «код верный, но просрочен» tells somebody holding a stolen code that they
 * have the right secret and the wrong clock.
 */
export const TWO_FACTOR_FAILURES = [
  'NOT_ENROLLED',
  'INVALID_CODE',
  'REPLAYED_CODE',
  'RECOVERY_CODE_SPENT',
  'LOCKED_OUT',
] as const;

export type TwoFactorFailure = (typeof TWO_FACTOR_FAILURES)[number];

/** The one message any failure produces. */
export const GENERIC_CHALLENGE_ERROR = 'Неверный код подтверждения';

/**
 * Attempts before a challenge is locked, and for how long.
 *
 * A six-digit code is one in a million per guess, which sounds safe and is not
 * on its own. A FIXED fifteen-minute lockout allows five guesses every quarter
 * hour — about 175 000 a year, or a one-in-six chance of hitting a given code
 * within a year of patient attacking. For an account that can open somebody's
 * passport that is not an acceptable number, and the arithmetic is easy to wave
 * through because "5 attempts then locked" sounds strict.
 *
 * So the lockout doubles: fifteen minutes, then thirty, then an hour, and so
 * on, capped at a day. An honest person who mistypes a code twice never reaches
 * the second step; a script gets roughly seventy attempts a year, which is
 * about one chance in fourteen thousand of ever succeeding.
 *
 * The counter is cleared only by a SUCCESSFUL challenge, never by waiting. That
 * is what stops an attacker sitting out each lockout and starting fresh.
 */
export const MAX_CHALLENGE_ATTEMPTS = 5;
export const BASE_LOCKOUT_SECONDS = 15 * 60;
export const MAX_LOCKOUT_SECONDS = 24 * 60 * 60;

export const isLockedOut = (attempts: number): boolean => attempts >= MAX_CHALLENGE_ATTEMPTS;

/**
 * How long to wait after `attempts` consecutive failures.
 *
 * Doubling per completed block of failures beyond the first, so the honest
 * mistype path is unaffected and the sustained-guessing path becomes useless.
 */
export function lockoutSeconds(attempts: number): number {
  if (attempts < MAX_CHALLENGE_ATTEMPTS) return 0;
  const blocks = Math.floor(attempts / MAX_CHALLENGE_ATTEMPTS) - 1;
  return Math.min(BASE_LOCKOUT_SECONDS * 2 ** blocks, MAX_LOCKOUT_SECONDS);
}

/** When the account may try again, given the last failure. */
export const lockedUntil = (attempts: number, lastFailureAt: Date): Date =>
  new Date(lastFailureAt.getTime() + lockoutSeconds(attempts) * 1000);
