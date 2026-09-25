import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestDb, type TestDb } from '@/server/db/testing.ts';
import { AuthService, MAX_REGISTRATION_CODE_ATTEMPTS } from '@/server/auth/auth-service.ts';
import type { DomainError } from '@/server/services/errors.ts';
import {
  assertPasswordAcceptable,
  hashPassword,
  hashToken,
  verifyPassword,
  WeakPasswordError,
} from '@/server/auth/credentials.ts';
import {
  can,
  isStaff,
  permissionsFor,
  requiresReason,
  requiresTwoFactor,
  ROLES,
} from '@/server/auth/rbac.ts';

let db: TestDb;
let auth: AuthService;

beforeAll(async () => {
  db = await createTestDb();
  auth = new AuthService(db);
}, 120_000);

afterAll(async () => {
  await db?.close();
});

beforeEach(async () => {
  await db.truncateAll();
});

const GOOD_PASSWORD = 'karotkaja-vulica-2026';

/**
 * Registration is now two calls — `beginRegistration` writes a pending row
 * and hands back a code, `confirmRegistration` spends it and creates the
 * real account. Most describe blocks below (login, sessions, RBAC…) do not
 * care about that mechanism at all; they just need a real, usable account to
 * exist, so this helper does both steps and returns what the old one-step
 * `register()` used to: a userId ready to log in with. The mechanism itself
 * gets its own tests in the `registration` block.
 */
const register = async (over: Partial<Parameters<AuthService['beginRegistration']>[0]> = {}) => {
  const input = {
    email: `user-${Math.random().toString(36).slice(2)}@example.by`,
    password: GOOD_PASSWORD,
    displayName: 'Ірына Арандатар',
    ...over,
  };
  const { identifier, code } = await auth.beginRegistration(input);
  const { session, context } = await auth.confirmRegistration(identifier, code, input.password);
  return { userId: context.userId, identifier, session };
};

/* ================================================================== */

describe('password hashing', () => {
  it('produces an argon2id hash, not the password', async () => {
    const h = await hashPassword(GOOD_PASSWORD);
    expect(h).toMatch(/^\$argon2id\$/);
    expect(h).not.toContain(GOOD_PASSWORD);
  });

  it('salts, so the same password hashes differently every time', async () => {
    const [a, b] = await Promise.all([hashPassword(GOOD_PASSWORD), hashPassword(GOOD_PASSWORD)]);
    expect(a).not.toBe(b);
    expect(await verifyPassword(a, GOOD_PASSWORD)).toBe(true);
    expect(await verifyPassword(b, GOOD_PASSWORD)).toBe(true);
  });

  it('rejects the wrong password', async () => {
    expect(await verifyPassword(await hashPassword(GOOD_PASSWORD), 'wrong-password-x')).toBe(false);
  });

  it('returns false rather than throwing on a corrupted hash', async () => {
    expect(await verifyPassword('not-a-hash', GOOD_PASSWORD)).toBe(false);
  });

  it.each(['short', '         ', 'password123456', 'мой пароль 12345'])('rejects weak password %s', (p) => {
    expect(() => assertPasswordAcceptable(p)).toThrow(WeakPasswordError);
  });

  it('accepts a long passphrase without demanding symbol classes', () => {
    expect(() => assertPasswordAcceptable('тры катэджы каля возера')).not.toThrow();
  });
});

describe('token storage', () => {
  it('hashes tokens so a database leak yields nothing usable', () => {
    const digest = hashToken('some-token');
    expect(digest).toHaveLength(32);
    expect(digest.toString('utf8')).not.toContain('some-token');
  });

  it('is deterministic for lookup but differs per token', () => {
    expect(hashToken('a').equals(hashToken('a'))).toBe(true);
    expect(hashToken('a').equals(hashToken('b'))).toBe(false);
  });
});

/* ================================================================== */

describe('registration', () => {
  it('does not create an account until the code is confirmed', async () => {
    const email = `pending-${Math.random().toString(36).slice(2)}@example.by`;
    await auth.beginRegistration({ email, password: GOOD_PASSWORD, displayName: 'Прэтэндэнт' });

    const users = await db.query<{ c: string }>(
      `SELECT count(*)::text AS c FROM app_user WHERE lower(email)=lower($1)`,
      [email],
    );
    expect(users.rows[0]!.c).toBe('0');

    const pending = await db.query<{ c: string }>(
      `SELECT count(*)::text AS c FROM pending_registration WHERE lower(email)=lower($1)`,
      [email],
    );
    expect(pending.rows[0]!.c).toBe('1');
  });

  it('confirming creates an already-verified account with a tenant role', async () => {
    const { userId } = await register();
    const { rows } = await db.query<{ email_verified_at: string | null; password_hash: string }>(
      `SELECT email_verified_at, password_hash FROM app_user WHERE id=$1`,
      [userId],
    );
    expect(rows[0]!.email_verified_at).not.toBeNull();
    expect(rows[0]!.password_hash).toMatch(/^\$argon2id\$/);

    const roles = await db.query<{ role: string }>(`SELECT role FROM user_role WHERE user_id=$1`, [userId]);
    expect(roles.rows.map((r) => r.role)).toEqual(['TENANT']);
  });

  it('deletes the pending row once confirmed', async () => {
    const email = `confirmed-${Math.random().toString(36).slice(2)}@example.by`;
    const { identifier, code } = await auth.beginRegistration({
      email,
      password: GOOD_PASSWORD,
      displayName: 'Гаспадар',
    });
    await auth.confirmRegistration(identifier, code, GOOD_PASSWORD);

    const { rows } = await db.query<{ c: string }>(
      `SELECT count(*)::text AS c FROM pending_registration WHERE lower(email)=lower($1)`,
      [email],
    );
    expect(rows[0]!.c).toBe('0');
  });

  it('confirming logs the new account straight in', async () => {
    const { identifier, code } = await auth.beginRegistration({
      email: `autologin-${Math.random().toString(36).slice(2)}@example.by`,
      password: GOOD_PASSWORD,
      displayName: 'Наведнік',
    });
    const { context } = await auth.confirmRegistration(identifier, code, GOOD_PASSWORD);
    expect(context.userId).toBeTruthy();
    expect(context.roles).toContain('TENANT');
  });

  it('never stores the password in plaintext anywhere', async () => {
    await register();
    const { rows } = await db.query<{ c: string }>(
      `SELECT count(*)::text AS c FROM app_user WHERE password_hash LIKE '%' || $1 || '%'`,
      [GOOD_PASSWORD],
    );
    expect(rows[0]!.c).toBe('0');
  });

  it('writes auth.register and auth.email_confirmed audit rows on confirm', async () => {
    const { userId } = await register();
    const { rows } = await db.query<{ action: string }>(
      `SELECT action FROM audit_log WHERE target_id=$1 AND action IN ('auth.register','auth.email_confirmed') ORDER BY action`,
      [userId],
    );
    expect(rows.map((r) => r.action)).toEqual(['auth.email_confirmed', 'auth.register']);
  });

  it('rejects the wrong code without confirming', async () => {
    const { identifier } = await auth.beginRegistration({
      email: `wrongcode-${Math.random().toString(36).slice(2)}@example.by`,
      password: GOOD_PASSWORD,
      displayName: 'Скептык',
    });
    await expect(auth.confirmRegistration(identifier, '000000', GOOD_PASSWORD)).rejects.toMatchObject({
      code: 'UNAUTHENTICATED',
    });

    const { rows } = await db.query<{ c: string }>(
      `SELECT count(*)::text AS c FROM app_user WHERE lower(email)=lower($1)`,
      [identifier],
    );
    expect(rows[0]!.c).toBe('0');
  });

  it('locks out after too many wrong codes, even before it expires', async () => {
    const { identifier } = await auth.beginRegistration({
      email: `lockout-${Math.random().toString(36).slice(2)}@example.by`,
      password: GOOD_PASSWORD,
      displayName: 'Упарты',
    });
    for (let i = 0; i < 6; i += 1) {
      await expect(auth.confirmRegistration(identifier, '000000', GOOD_PASSWORD)).rejects.toThrow();
    }
    await expect(auth.confirmRegistration(identifier, '000000', GOOD_PASSWORD)).rejects.toMatchObject({
      code: 'RATE_LIMITED',
    });
  });

  it('rejects an expired code', async () => {
    const { identifier } = await auth.beginRegistration({
      email: `expired-${Math.random().toString(36).slice(2)}@example.by`,
      password: GOOD_PASSWORD,
      displayName: 'Спазніўся',
    });
    await db.query(`UPDATE pending_registration SET expires_at = now() - interval '1 minute'`);
    await expect(auth.confirmRegistration(identifier, '000000', GOOD_PASSWORD)).rejects.toMatchObject({
      code: 'UNAUTHENTICATED',
    });
  });

  describe('confirming needs the password chosen at registration', () => {
    const WRONG_PASSWORD_MESSAGE = 'Пароль не совпадает с указанным при регистрации.';
    const ATTACKER_PASSWORD = 'hitry-sused-parol-2026';

    const begin = (label: string) =>
      auth.beginRegistration({
        email: `${label}-${Math.random().toString(36).slice(2)}@example.by`,
        password: GOOD_PASSWORD,
        displayName: 'Уладальнік пароля',
      });
    const failure = (attempt: Promise<unknown>) =>
      attempt.then(
        () => null,
        (e: unknown) => e as DomainError,
      );
    const usersFor = async (email: string) =>
      Number(
        (
          await db.query<{ c: string }>(
            `SELECT count(*)::text AS c FROM app_user WHERE lower(email)=lower($1)`,
            [email],
          )
        ).rows[0]!.c,
      );
    const pendingFor = async (email: string) =>
      (
        await db.query<{ attempts: number }>(
          `SELECT attempts FROM pending_registration WHERE lower(email)=lower($1)`,
          [email],
        )
      ).rows[0];

    it.each([
      ['a different password', ATTACKER_PASSWORD],
      ['an empty password', ''],
      ['the right password with a trailing space', `${GOOD_PASSWORD} `],
      ['the right password in another case', GOOD_PASSWORD.toUpperCase()],
    ])('refuses the right code with %s and creates no account', async (_label, wrong) => {
      const { identifier, code } = await begin('wrongpw');

      const error = await failure(auth.confirmRegistration(identifier, code, wrong));
      expect(error).toMatchObject({ code: 'UNAUTHENTICATED', status: 401 });
      expect(error!.message).toBe(WRONG_PASSWORD_MESSAGE);

      expect(await usersFor(identifier)).toBe(0);
      expect((await pendingFor(identifier))?.attempts).toBe(1);
    });

    it('does not burn the code: the right password still confirms afterwards', async () => {
      const { identifier, code } = await begin('retry');
      await expect(auth.confirmRegistration(identifier, code, ATTACKER_PASSWORD)).rejects.toThrow();

      const { context } = await auth.confirmRegistration(identifier, code, GOOD_PASSWORD);
      expect(context.roles).toContain('TENANT');
      expect(await usersFor(identifier)).toBe(1);
      expect(await pendingFor(identifier)).toBeUndefined();
    });

    it('creates the account with the password chosen at registration', async () => {
      const { identifier, code } = await begin('ownpw');
      await auth.confirmRegistration(identifier, code, GOOD_PASSWORD);

      await expect(auth.login(identifier, GOOD_PASSWORD)).resolves.toBeTruthy();
    });

    it('checks the code before the password, so a wrong code learns nothing about the password', async () => {
      const { identifier } = await begin('order');

      const error = await failure(auth.confirmRegistration(identifier, '000000', ATTACKER_PASSWORD));
      expect(error).toMatchObject({ code: 'UNAUTHENTICATED' });
      expect(error!.message).toBe('Код неверен или устарел');
      expect((await pendingFor(identifier))?.attempts).toBe(1);
    });

    it('counts wrong passwords toward the lockout, even for the right code and password afterwards', async () => {
      const { identifier, code } = await begin('pwlock');
      for (let i = 0; i < MAX_REGISTRATION_CODE_ATTEMPTS; i += 1) {
        await expect(auth.confirmRegistration(identifier, code, ATTACKER_PASSWORD)).rejects.toMatchObject({
          code: 'UNAUTHENTICATED',
        });
      }
      expect((await pendingFor(identifier))?.attempts).toBe(MAX_REGISTRATION_CODE_ATTEMPTS);

      await expect(auth.confirmRegistration(identifier, code, GOOD_PASSWORD)).rejects.toMatchObject({
        code: 'RATE_LIMITED',
      });
      expect(await usersFor(identifier)).toBe(0);
    });

    it('a victim handed an attacker-initiated code cannot finish, and can register for themselves', async () => {
      const email = `victim-${Math.random().toString(36).slice(2)}@example.by`;

      // The attacker submits the victim's address first with a password of their own…
      const attacker = await auth.beginRegistration({
        email,
        password: ATTACKER_PASSWORD,
        displayName: 'Падман',
      });
      // …and the victim, holding the genuine-looking mail, types its code with
      // the only password they know.
      await expect(auth.confirmRegistration(email, attacker.code, GOOD_PASSWORD)).rejects.toThrow(
        WRONG_PASSWORD_MESSAGE,
      );
      expect(await usersFor(email)).toBe(0);

      // Registering for themselves replaces the attacker's pending row.
      const own = await auth.beginRegistration({ email, password: GOOD_PASSWORD, displayName: 'Сапраўдны' });
      const { context } = await auth.confirmRegistration(email, own.code, GOOD_PASSWORD);
      expect(context.displayName).toBe('Сапраўдны');

      await expect(auth.login(email, GOOD_PASSWORD)).resolves.toBeTruthy();
      await expect(auth.login(email, ATTACKER_PASSWORD)).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
    });
  });

  it('resending replaces the code and resets the attempt counter', async () => {
    const { identifier, code: firstCode } = await auth.beginRegistration({
      email: `resend-${Math.random().toString(36).slice(2)}@example.by`,
      password: GOOD_PASSWORD,
      displayName: 'Другая спроба',
    });
    const secondCode = await auth.resendRegistrationCode(identifier);
    expect(secondCode).toBeTruthy();
    expect(secondCode).not.toBe(firstCode);

    await expect(auth.confirmRegistration(identifier, firstCode, GOOD_PASSWORD)).rejects.toThrow();
    await expect(auth.confirmRegistration(identifier, secondCode!, GOOD_PASSWORD)).resolves.toBeTruthy();
  });

  it('resend returns null rather than revealing that nothing is pending', async () => {
    expect(await auth.resendRegistrationCode('nobody-pending@example.by')).toBeNull();
  });

  it('registering again with the same address replaces the old pending attempt', async () => {
    const email = `retry-${Math.random().toString(36).slice(2)}@example.by`;
    const first = await auth.beginRegistration({
      email,
      password: GOOD_PASSWORD,
      displayName: 'Першая спроба',
    });
    const second = await auth.beginRegistration({
      email,
      password: GOOD_PASSWORD,
      displayName: 'Другая спроба',
    });

    await expect(auth.confirmRegistration(email, first.code, GOOD_PASSWORD)).rejects.toThrow();
    await expect(auth.confirmRegistration(email, second.code, GOOD_PASSWORD)).resolves.toBeTruthy();
  });

  it('does not reveal that an email already holds a real account', async () => {
    const email = 'taken@example.by';
    await register({ email });
    await expect(
      auth.beginRegistration({ email, password: GOOD_PASSWORD, displayName: 'Хтосьці' }),
    ).rejects.toMatchObject({
      code: 'ALREADY_EXISTS',
    });
    // The message must not confirm the address exists.
    await expect(
      auth.beginRegistration({ email, password: GOOD_PASSWORD, displayName: 'Хтосьці' }),
    ).rejects.toThrow(/Не удалось создать аккаунт/);
  });

  it('rejects a company account with no company name', async () => {
    await expect(
      auth.beginRegistration({
        email: `company-${Math.random().toString(36).slice(2)}@example.by`,
        password: GOOD_PASSWORD,
        displayName: 'Кампанія',
        accountKind: 'COMPANY',
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('rejects an account with neither email nor phone', async () => {
    await expect(
      auth.beginRegistration({ password: GOOD_PASSWORD, displayName: 'Ghost' }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('rejects a weak password before touching the database', async () => {
    await expect(
      auth.beginRegistration({
        email: `weak-${Math.random().toString(36).slice(2)}@example.by`,
        password: 'qwerty',
        displayName: 'Слабы',
      }),
    ).rejects.toThrow(WeakPasswordError);
    const { rows } = await db.query<{ c: string }>(`SELECT count(*)::text AS c FROM pending_registration`);
    expect(rows[0]!.c).toBe('0');
  });
});

/* ================================================================== */

describe('sign in with Google', () => {
  const google = (over: Partial<Parameters<AuthService['continueWithGoogle']>[0]> = {}) => ({
    sub: `sub-${Math.random().toString(36).slice(2)}`,
    email: `google-${Math.random().toString(36).slice(2)}@example.by`,
    emailVerified: true,
    name: 'Гугл Карыстальнік',
    ...over,
  });

  it('refuses when Google reports the email as unverified', async () => {
    await expect(auth.continueWithGoogle(google({ emailVerified: false }))).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    });
  });

  it('creates a new, already-verified account on first sign-in', async () => {
    const g = google();
    const { context } = await auth.continueWithGoogle(g);
    expect(context.roles).toContain('TENANT');

    const { rows } = await db.query<{ email_verified_at: string | null; google_sub: string | null }>(
      `SELECT email_verified_at, google_sub FROM app_user WHERE id=$1`,
      [context.userId],
    );
    expect(rows[0]!.email_verified_at).not.toBeNull();
    expect(rows[0]!.google_sub).toBe(g.sub);
  });

  it('signing in again with the same Google account reaches the same user', async () => {
    const g = google();
    const first = await auth.continueWithGoogle(g);
    const second = await auth.continueWithGoogle(g);
    expect(second.context.userId).toBe(first.context.userId);

    const { rows } = await db.query<{ c: string }>(
      `SELECT count(*)::text AS c FROM app_user WHERE google_sub=$1`,
      [g.sub],
    );
    expect(rows[0]!.c).toBe('1');
  });

  it('links Google to an existing password account with the same email, rather than duplicating it', async () => {
    const email = `linkme-${Math.random().toString(36).slice(2)}@example.by`;
    const { userId } = await register({ email });

    const { context } = await auth.continueWithGoogle(google({ email }));
    expect(context.userId).toBe(userId);

    const { rows } = await db.query<{ c: string }>(
      `SELECT count(*)::text AS c FROM app_user WHERE lower(email)=lower($1)`,
      [email],
    );
    expect(rows[0]!.c).toBe('1');
  });

  it('writes an audit row for a brand-new Google account', async () => {
    const g = google();
    const { context } = await auth.continueWithGoogle(g);
    const { rows } = await db.query<{ c: string }>(
      `SELECT count(*)::text AS c FROM audit_log WHERE action='auth.register' AND target_id=$1`,
      [context.userId],
    );
    expect(rows[0]!.c).toBe('1');
  });
});

/* ================================================================== */

describe('login', () => {
  it('issues a working session', async () => {
    const email = 'login@example.by';
    await register({ email });
    const { session, context } = await auth.login(email, GOOD_PASSWORD);

    expect(session.token).toBeTruthy();
    expect(context.roles).toContain('TENANT');
    expect(await auth.resolveSession(session.token)).toMatchObject({ userId: context.userId });
  });

  it('stores only a hash of the session token', async () => {
    const email = 'hash@example.by';
    await register({ email });
    const { session } = await auth.login(email, GOOD_PASSWORD);

    const { rows } = await db.query<{ c: string }>(
      `SELECT count(*)::text AS c FROM user_session WHERE token_hash = $1`,
      [hashToken(session.token)],
    );
    expect(rows[0]!.c).toBe('1');

    // The raw token must appear nowhere in the table.
    const raw = await db.query<{ c: string }>(
      `SELECT count(*)::text AS c FROM user_session WHERE encode(token_hash,'escape') LIKE '%' || $1 || '%'`,
      [session.token],
    );
    expect(raw.rows[0]!.c).toBe('0');
  });

  it('rejects a wrong password with the same error as an unknown account', async () => {
    const email = 'same@example.by';
    await register({ email });
    // Awaited one at a time: creating both promises up front leaves the second
    // rejection unhandled for a tick, which Node reports as an unhandled error.
    await expect(auth.login(email, 'definitely-not-it-123')).rejects.toThrow(
      /Неверный email\/телефон или пароль/,
    );
    await expect(auth.login('nobody@example.by', GOOD_PASSWORD)).rejects.toThrow(
      /Неверный email\/телефон или пароль/,
    );
  });

  it('records failed attempts for later analysis', async () => {
    const email = 'failed@example.by';
    const { userId } = await register({ email });
    await expect(auth.login(email, 'wrong-password-here')).rejects.toThrow();

    const { rows } = await db.query<{ c: string }>(
      `SELECT count(*)::text AS c FROM audit_log WHERE action='auth.login_failed' AND actor_user_id=$1`,
      [userId],
    );
    expect(rows[0]!.c).toBe('1');
  });

  it('locks out after repeated failures even with the correct password', async () => {
    const email = 'bruteforce@example.by';
    await register({ email });
    for (let i = 0; i < 8; i += 1) {
      await expect(auth.login(email, `wrong-attempt-${i}`)).rejects.toThrow();
    }
    await expect(auth.login(email, GOOD_PASSWORD)).rejects.toMatchObject({ code: 'RATE_LIMITED' });
  });

  it('refuses a suspended account', async () => {
    const email = 'suspended@example.by';
    const { userId } = await register({ email });
    await db.query(`UPDATE app_user SET status='SUSPENDED' WHERE id=$1`, [userId]);
    await expect(auth.login(email, GOOD_PASSWORD)).rejects.toMatchObject({ code: 'ACCOUNT_RESTRICTED' });
  });

  it('does not hash IP addresses into the clear', async () => {
    const email = 'ip@example.by';
    await register({ email });
    await auth.login(email, GOOD_PASSWORD, { ip: '203.0.113.7' });
    const { rows } = await db.query<{ c: string }>(
      `SELECT count(*)::text AS c FROM audit_log WHERE encode(ip_hash,'escape') LIKE '%203.0.113.7%'`,
    );
    expect(rows[0]!.c).toBe('0');
  });
});

/* ================================================================== */

describe('sessions', () => {
  const loggedIn = async () => {
    const email = `sess-${Math.random().toString(36).slice(2)}@example.by`;
    await register({ email });
    return auth.login(email, GOOD_PASSWORD);
  };

  it('rejects a random token', async () => {
    expect(await auth.resolveSession('not-a-real-token')).toBeNull();
  });

  it('rejects an expired session', async () => {
    const { session } = await loggedIn();
    // Simulate a session created long ago that has since lapsed. Backdating
    // created_at as well is required: the schema refuses a session whose expiry
    // precedes its creation, which is itself worth having.
    await db.query(
      `UPDATE user_session
          SET created_at = now() - interval '40 days', expires_at = now() - interval '1 hour'
        WHERE id=$1`,
      [session.sessionId],
    );
    expect(await auth.resolveSession(session.token)).toBeNull();
  });

  it('rejects a revoked session', async () => {
    const { session } = await loggedIn();
    await auth.logout(session.token);
    expect(await auth.resolveSession(session.token)).toBeNull();
  });

  it('rejects sessions of a suspended user without needing to revoke them', async () => {
    const { session, context } = await loggedIn();
    await db.query(`UPDATE app_user SET status='SUSPENDED' WHERE id=$1`, [context.userId]);
    expect(await auth.resolveSession(session.token)).toBeNull();
  });

  it('rotates to a new token and kills the old one', async () => {
    const { session } = await loggedIn();
    const rotated = await auth.rotateSession(session.token);

    expect(rotated.token).not.toBe(session.token);
    expect(await auth.resolveSession(rotated.token)).not.toBeNull();
    expect(await auth.resolveSession(session.token)).toBeNull();
  });

  it('keeps the rotation chain so a replayed old token is attributable', async () => {
    const { session } = await loggedIn();
    const rotated = await auth.rotateSession(session.token);
    const { rows } = await db.query<{ previous_id: string; revoked_reason: string }>(
      `SELECT s.previous_id, p.revoked_reason
         FROM user_session s JOIN user_session p ON p.id = s.previous_id
        WHERE s.id = $1`,
      [rotated.sessionId],
    );
    expect(rows[0]!.previous_id).toBe(session.sessionId);
    expect(rows[0]!.revoked_reason).toBe('ROTATED');
  });

  it('refuses to rotate an already-revoked token', async () => {
    const { session } = await loggedIn();
    await auth.rotateSession(session.token);
    await expect(auth.rotateSession(session.token)).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
  });

  it('revokes every session at once when required', async () => {
    const email = 'multi@example.by';
    // register() itself confirms the account, which mints a first session —
    // so three are live going in, not two.
    const registered = await register({ email });
    const a = await auth.login(email, GOOD_PASSWORD);
    const b = await auth.login(email, GOOD_PASSWORD);

    expect(await auth.revokeAllSessions(a.context.userId, 'COMPROMISE')).toBe(3);
    expect(await auth.resolveSession(registered.session.token)).toBeNull();
    expect(await auth.resolveSession(a.session.token)).toBeNull();
    expect(await auth.resolveSession(b.session.token)).toBeNull();
  });
});

/* ================================================================== */

describe('password reset', () => {
  it('returns null for an unknown account instead of revealing it', async () => {
    expect(await auth.requestPasswordReset('nobody@example.by')).toBeNull();
  });

  it('resets the password and invalidates the old one', async () => {
    const email = 'reset@example.by';
    await register({ email });
    const token = await auth.requestPasswordReset(email);
    expect(token).toBeTruthy();

    await auth.resetPassword(token!, 'novy-parol-dlia-mianie');

    await expect(auth.login(email, GOOD_PASSWORD)).rejects.toThrow();
    await expect(auth.login(email, 'novy-parol-dlia-mianie')).resolves.toBeTruthy();
  });

  it('kills every existing session on reset — an attacker must not survive it', async () => {
    const email = 'compromised@example.by';
    await register({ email });
    const { session } = await auth.login(email, GOOD_PASSWORD);
    expect(await auth.resolveSession(session.token)).not.toBeNull();

    const token = await auth.requestPasswordReset(email);
    await auth.resetPassword(token!, 'zusim-novy-parol-tut');

    expect(await auth.resolveSession(session.token)).toBeNull();
  });

  it('invalidates a previously issued reset link when a new one is requested', async () => {
    const email = 'twolinks@example.by';
    await register({ email });
    const first = await auth.requestPasswordReset(email);
    const second = await auth.requestPasswordReset(email);

    await expect(auth.resetPassword(first!, 'parol-numar-adzin-x')).rejects.toThrow();
    await expect(auth.resetPassword(second!, 'parol-numar-dva-xx')).resolves.toBeUndefined();
  });
});

/* ================================================================== */

describe('RBAC', () => {
  it('gives ordinary users no staff permissions', () => {
    expect(permissionsFor(['TENANT', 'LANDLORD']).size).toBe(0);
    expect(isStaff(['TENANT', 'LANDLORD'])).toBe(false);
  });

  it('does NOT let support staff read identity documents', () => {
    // The central privacy guarantee of the verification subsystem.
    expect(can(['SUPPORT'], 'document.read')).toBe(false);
    expect(can(['MODERATOR'], 'document.read')).toBe(false);
    expect(can(['FINANCE'], 'document.read')).toBe(false);
    expect(can(['ADMIN'], 'document.read')).toBe(false);
    expect(can(['VERIFIER'], 'document.read')).toBe(true);
  });

  it('does not let support staff touch money', () => {
    expect(can(['SUPPORT'], 'fee.waive')).toBe(false);
    expect(can(['SUPPORT'], 'ledger.adjust')).toBe(false);
    expect(can(['FINANCE'], 'ledger.adjust')).toBe(true);
  });

  it('does not let a moderator suspend accounts', () => {
    expect(can(['MODERATOR'], 'user.suspend')).toBe(false);
    expect(can(['ADMIN'], 'user.suspend')).toBe(true);
  });

  it('requires a second factor for every staff role and none for users', () => {
    for (const role of ROLES) {
      const staff = role !== 'TENANT' && role !== 'LANDLORD';
      expect(requiresTwoFactor([role])).toBe(staff);
    }
  });

  it('requires a written reason for every sensitive action', () => {
    for (const p of ['user.suspend', 'fee.waive', 'ledger.adjust', 'document.read', 'role.grant'] as const) {
      expect(requiresReason(p)).toBe(true);
    }
    expect(requiresReason('user.view')).toBe(false);
  });

  it('combines permissions across multiple roles', () => {
    const combined = permissionsFor(['MODERATOR', 'VERIFIER']);
    expect(combined.has('listing.moderate')).toBe(true);
    expect(combined.has('document.read')).toBe(true);
  });

  it('records who granted a role and why', async () => {
    const { userId: admin } = await register({ email: 'admin@example.by' });
    const { userId: target } = await register({ email: 'target@example.by' });

    await auth.grantRole(target, 'MODERATOR', admin, 'Присоединился к команде модерации');

    const { rows } = await db.query<{ granted_by: string }>(
      `SELECT granted_by FROM user_role WHERE user_id=$1 AND role='MODERATOR'`,
      [target],
    );
    expect(rows[0]!.granted_by).toBe(admin);

    const audit = await db.query<{ reason: string }>(
      `SELECT reason FROM audit_log WHERE action='auth.grant_role' AND target_id=$1`,
      [target],
    );
    expect(audit.rows[0]!.reason).toMatch(/модерации/);
  });

  it('refuses to grant a role without a reason', async () => {
    const { userId: admin } = await register({ email: 'admin2@example.by' });
    const { userId: target } = await register({ email: 'target2@example.by' });
    await expect(auth.grantRole(target, 'ADMIN', admin, '   ')).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    });
  });
});
