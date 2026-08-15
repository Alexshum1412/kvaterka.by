/**
 * Password hashing and opaque token handling.
 */

import { hash as argonHash, verify as argonVerify } from '@node-rs/argon2';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * @node-rs/argon2 exports `Algorithm` as an ambient const enum, which cannot be
 * read under `isolatedModules`. The numeric value is part of the argon2 spec's
 * variant ordering (d = 0, i = 1, id = 2) and is stable, so it is named here
 * rather than imported.
 */
const ARGON2ID = 2;

/**
 * argon2id parameters.
 *
 * 19 MiB / 2 passes / 1 lane is the OWASP-documented minimum configuration for
 * argon2id. Memory cost is the parameter that actually hurts GPU attackers, so
 * it is the one raised first if this is ever tuned upward.
 */
const ARGON_OPTIONS = {
  algorithm: ARGON2ID,
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
} as const;

export const MIN_PASSWORD_LENGTH = 10;

export class WeakPasswordError extends Error {
  constructor(readonly reason: string) {
    super(reason);
    this.name = 'WeakPasswordError';
  }
}

/**
 * Length over composition rules. Mandatory symbol/digit classes push people
 * toward "Password1!" — predictable, and no stronger than a longer passphrase.
 */
export function assertPasswordAcceptable(password: string): void {
  if (password.length < MIN_PASSWORD_LENGTH) {
    throw new WeakPasswordError(`Пароль должен содержать не менее ${MIN_PASSWORD_LENGTH} символов`);
  }
  if (password.length > 256) {
    throw new WeakPasswordError('Пароль слишком длинный');
  }
  if (/^\s+$/.test(password)) {
    throw new WeakPasswordError('Пароль не может состоять только из пробелов');
  }
  const normalised = password.toLowerCase().replace(/\s/g, '');
  const banned = ['password', 'пароль', 'qwerty', '123456789', 'kvaterka', 'quaterka', 'iloveyou', 'admin123'];
  if (banned.some((b) => normalised.includes(b))) {
    throw new WeakPasswordError('Этот пароль слишком распространён');
  }
}

export async function hashPassword(password: string): Promise<string> {
  assertPasswordAcceptable(password);
  return argonHash(password, ARGON_OPTIONS);
}

/**
 * Verify a password. Returns false rather than throwing on a malformed hash, so
 * a corrupted row cannot be distinguished from a wrong password by an attacker.
 */
export async function verifyPassword(storedHash: string, password: string): Promise<boolean> {
  try {
    return await argonVerify(storedHash, password);
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------ *
 * Opaque tokens (sessions, email verification, password reset, OTP)
 * ------------------------------------------------------------------ */

/**
 * 32 bytes of CSPRNG entropy, base64url encoded. Not a JWT: these tokens must
 * be revocable the instant a user logs out or an account is compromised, and a
 * self-contained signed token cannot be.
 */
export function generateToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

/**
 * Tokens are stored hashed, never in plaintext. A database leak must not hand
 * the attacker live sessions.
 *
 * SHA-256 without a slow KDF is correct here and would be wrong for a password:
 * a 256-bit random token has no guessable structure, so there is nothing for an
 * offline attacker to iterate over.
 */
export function hashToken(token: string): Buffer {
  return createHash('sha256').update(token).digest();
}

/** Constant-time comparison, for anywhere a digest is compared in application code. */
export function tokensMatch(a: Buffer, b: Buffer): boolean {
  return a.length === b.length && timingSafeEqual(a, b);
}
