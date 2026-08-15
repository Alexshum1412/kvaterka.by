import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestDb, type TestDb } from '@/server/db/testing.ts';
import { AuthService } from '@/server/auth/auth-service.ts';
import { assertPasswordAcceptable, hashPassword, hashToken, verifyPassword, WeakPasswordError } from '@/server/auth/credentials.ts';
import { can, isStaff, permissionsFor, requiresReason, requiresTwoFactor, ROLES } from '@/server/auth/rbac.ts';

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

const register = (over: Partial<Parameters<AuthService['register']>[0]> = {}) =>
  auth.register({
    email: `user-${Math.random().toString(36).slice(2)}@example.by`,
    password: GOOD_PASSWORD,
    displayName: 'Ірына Арандатар',
    ...over,
  });

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
  it('creates an account with a tenant role and an unverified email', async () => {
    const { userId } = await register();
    const { rows } = await db.query<{ email_verified_at: string | null; password_hash: string }>(
      `SELECT email_verified_at, password_hash FROM app_user WHERE id=$1`,
      [userId],
    );
    expect(rows[0]!.email_verified_at).toBeNull();
    expect(rows[0]!.password_hash).toMatch(/^\$argon2id\$/);

    const roles = await db.query<{ role: string }>(`SELECT role FROM user_role WHERE user_id=$1`, [userId]);
    expect(roles.rows.map((r) => r.role)).toEqual(['TENANT']);
  });

  it('never stores the password in plaintext anywhere', async () => {
    await register();
    const { rows } = await db.query<{ c: string }>(
      `SELECT count(*)::text AS c FROM app_user WHERE password_hash LIKE '%' || $1 || '%'`,
      [GOOD_PASSWORD],
    );
    expect(rows[0]!.c).toBe('0');
  });

  it('writes an audit row', async () => {
    const { userId } = await register();
    const { rows } = await db.query<{ c: string }>(
      `SELECT count(*)::text AS c FROM audit_log WHERE action='auth.register' AND target_id=$1`,
      [userId],
    );
    expect(rows[0]!.c).toBe('1');
  });

  it('does not reveal that an email is already registered', async () => {
    const email = 'taken@example.by';
    await register({ email });
    await expect(register({ email })).rejects.toMatchObject({ code: 'ALREADY_EXISTS' });
    // The message must not confirm the address exists.
    await expect(register({ email })).rejects.toThrow(/Не удалось создать аккаунт/);
  });

  it('rejects a company account with no company name', async () => {
    await expect(register({ accountKind: 'COMPANY' })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('rejects an account with neither email nor phone', async () => {
    await expect(
      auth.register({ password: GOOD_PASSWORD, displayName: 'Ghost' }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('rejects a weak password before touching the database', async () => {
    await expect(register({ password: 'qwerty' })).rejects.toThrow(WeakPasswordError);
    const { rows } = await db.query<{ c: string }>(`SELECT count(*)::text AS c FROM app_user`);
    expect(rows[0]!.c).toBe('0');
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
    await register({ email });
    const a = await auth.login(email, GOOD_PASSWORD);
    const b = await auth.login(email, GOOD_PASSWORD);

    expect(await auth.revokeAllSessions(a.context.userId, 'COMPROMISE')).toBe(2);
    expect(await auth.resolveSession(a.session.token)).toBeNull();
    expect(await auth.resolveSession(b.session.token)).toBeNull();
  });
});

/* ================================================================== */

describe('email verification and password reset', () => {
  it('verifies an email exactly once', async () => {
    const { userId, verificationToken } = await register();
    expect(await auth.verifyEmail(verificationToken)).toBe(userId);
    await expect(auth.verifyEmail(verificationToken)).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
  });

  it('rejects an expired verification token', async () => {
    const { verificationToken } = await register();
    await db.query(`UPDATE auth_token SET expires_at = now() - interval '1 hour'`);
    await expect(auth.verifyEmail(verificationToken)).rejects.toThrow();
  });

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

  it('cannot use a reset token as a verification token', async () => {
    const email = 'crosspurpose@example.by';
    await register({ email });
    const reset = await auth.requestPasswordReset(email);
    await expect(auth.verifyEmail(reset!)).rejects.toThrow();
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
