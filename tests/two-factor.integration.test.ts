/**
 * Staff two-factor authentication, over the real dispatcher.
 *
 * The suite is mostly about what does NOT work. A second factor is only worth
 * having if every path to a staff capability is closed without it, and this
 * codebase has two such paths: the API router, and server components that call
 * services directly. So the assertions come in pairs — the route is refused AND
 * the roles a page would read are empty — because a design that closed only the
 * first would pass a naive suite and protect nothing.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestDb, type TestDb } from '@/server/db/testing.ts';
import { ApiTestClient } from './support/api-client.ts';
import { AuthService } from '@/server/auth/auth-service.ts';
import { can } from '@/server/auth/rbac.ts';
import { totpCodeFor, totpStep, TOTP_STEP_SECONDS } from '@/server/domain/two-factor.ts';

let db: TestDb;
let api: ApiTestClient;
let auth: AuthService;

beforeAll(async () => {
  db = await createTestDb();
  api = new ApiTestClient(db);
  auth = new AuthService(db);
}, 120_000);

afterAll(async () => {
  await db?.close();
});

beforeEach(async () => {
  await db.truncateAll();
  await api.resetRateLimits();
});

/** A staff member who has a role and has NOT satisfied a second factor. */
async function passwordOnlyStaff(role: 'ADMIN' | 'VERIFIER' | 'SUPPORT' | 'MODERATOR' | 'FINANCE' = 'ADMIN') {
  const s = await api.signUp();
  await api.grantRoleWithoutTwoFactor(s.userId, role);
  return s;
}

/** Enrol properly, through the real endpoints, and return the codes. */
async function enrol(token: string) {
  const begin = await api.post('/me/2fa/enrol', {}, { token });
  const secret = begin.body.secret as string;
  const code = totpCodeFor(secret, totpStep(new Date()));
  const confirm = await api.post('/me/2fa/confirm', { code }, { token });
  return { secret, recoveryCodes: confirm.body.recoveryCodes as string[], confirm };
}

/* ================================================================== *
 * The enforcement itself
 * ================================================================== */

describe('a staff role is withheld until the second factor is satisfied', () => {
  it('refuses the API', async () => {
    const admin = await passwordOnlyStaff('ADMIN');
    expect((await api.get('/admin/overview', { token: admin.token })).status).toBe(403);
    expect((await api.get('/admin/retention', { token: admin.token })).status).toBe(403);
  });

  /* The half a router-only design would have missed. Staff pages never touch
     the dispatcher — they resolve the session themselves and call `can()` — so
     this asserts the roles those pages would actually read. */
  it('empties the roles a server component would read', async () => {
    const verifier = await passwordOnlyStaff('VERIFIER');
    const session = await auth.resolveSession(verifier.token);

    // Every registered account carries TENANT; what must be gone is the staff half.
    expect(session!.roles).not.toContain('VERIFIER');
    expect(can(session!.roles, 'verification.review')).toBe(false);
    expect(can(session!.roles, 'document.read')).toBe(false);
    // And the UI is told why, so it can prompt rather than show a bare 404.
    expect(session!.withheldRoles).toEqual(['VERIFIER']);
    expect(session!.authLevel).toBe('PASSWORD');
  });

  it('leaves an ordinary account completely untouched', async () => {
    const user = await api.signUp();
    const session = await auth.resolveSession(user.token);
    expect(session!.withheldRoles).toEqual([]);
    // Their own things still work — this is the regression that would make
    // every tenant suffer for a staff control.
    expect((await api.get('/me/profile', { token: user.token })).status).toBe(200);
    expect((await api.get('/me/account/closure', { token: user.token })).status).toBe(200);
  });

  it('a landlord who is also staff keeps the landlord half', async () => {
    const s = await api.signUp();
    await api.grantRoleWithoutTwoFactor(s.userId, 'MODERATOR');
    await db.query(`INSERT INTO user_role (user_id, role) VALUES ($1,'LANDLORD') ON CONFLICT DO NOTHING`, [
      s.userId,
    ]);
    const session = await auth.resolveSession(s.token);
    expect(session!.roles).toContain('LANDLORD');
    expect(session!.roles).not.toContain('MODERATOR');
    expect(session!.withheldRoles).toEqual(['MODERATOR']);
  });

  it('grants everything back once the challenge is answered', async () => {
    const admin = await passwordOnlyStaff('ADMIN');
    await enrol(admin.token);

    const session = await auth.resolveSession(admin.token);
    expect(session!.authLevel).toBe('TWO_FACTOR');
    expect(session!.roles).toContain('ADMIN');
    expect((await api.get('/admin/overview', { token: admin.token })).status).toBe(200);
  });

  /* The enrolment route must stay reachable from the state it exists to
     resolve, or a staff member is locked out of the only way back in. */
  it('leaves the enrolment route reachable while roles are withheld', async () => {
    const admin = await passwordOnlyStaff('ADMIN');
    expect((await api.get('/me/2fa', { token: admin.token })).status).toBe(200);
    expect((await api.post('/me/2fa/enrol', {}, { token: admin.token })).status).toBe(200);
  });

  it('reports what is required and what is withheld', async () => {
    const admin = await passwordOnlyStaff('ADMIN');
    const res = await api.get('/me/2fa', { token: admin.token });
    expect(res.body.required).toBe(true);
    expect(res.body.enrolled).toBe(false);
    expect(res.body.withheldRoles).toEqual(['ADMIN']);
    expect(res.body.grantedRoles).toContain('ADMIN');
  });
});

/* ================================================================== *
 * Enrolment
 * ================================================================== */

describe('enrolment', () => {
  it('hands back a secret and an otpauth URI, then recovery codes', async () => {
    const admin = await passwordOnlyStaff();
    const begin = await api.post('/me/2fa/enrol', {}, { token: admin.token });
    expect(begin.body.uri).toContain('otpauth://totp/');

    const { recoveryCodes } = await enrol2(admin.token, begin.body.secret as string);
    expect(recoveryCodes.length).toBe(10);
    expect(new Set(recoveryCodes).size).toBe(10);
  });

  async function enrol2(token: string, secret: string) {
    const code = totpCodeFor(secret, totpStep(new Date()));
    const res = await api.post('/me/2fa/confirm', { code }, { token });
    expect(res.status).toBe(200);
    return { recoveryCodes: res.body.recoveryCodes as string[] };
  }

  it('refuses a wrong code and does not enrol', async () => {
    const admin = await passwordOnlyStaff();
    await api.post('/me/2fa/enrol', {}, { token: admin.token });
    const res = await api.post('/me/2fa/confirm', { code: '000000' }, { token: admin.token });
    expect(res.status).toBe(422);
    expect((await api.get('/me/2fa', { token: admin.token })).body.enrolled).toBe(false);
  });

  it('promotes the current session, so enrolling is not a dead end', async () => {
    const admin = await passwordOnlyStaff();
    await enrol(admin.token);
    // No re-login required.
    expect((await api.get('/admin/overview', { token: admin.token })).status).toBe(200);
  });

  it('refuses to enrol twice', async () => {
    const admin = await passwordOnlyStaff();
    await enrol(admin.token);
    expect((await api.post('/me/2fa/enrol', {}, { token: admin.token })).status).toBe(409);
  });

  it('never returns the secret again after confirmation', async () => {
    const admin = await passwordOnlyStaff();
    await enrol(admin.token);
    const status = await api.get('/me/2fa', { token: admin.token });
    expect(JSON.stringify(status.body)).not.toMatch(/secret/i);
  });

  it('stores recovery codes only as hashes', async () => {
    const admin = await passwordOnlyStaff();
    const { recoveryCodes } = await enrol(admin.token);
    const { rows } = await db.query<{ c: string }>(
      `SELECT count(*)::text c FROM two_factor_recovery_code WHERE user_id=$1`,
      [admin.userId],
    );
    expect(rows[0]!.c).toBe('10');
    // The plaintext must appear nowhere — the platform genuinely cannot show
    // these again, which is what makes them worth writing down.
    const dump = await db.query<{ code_hash: Buffer }>(
      `SELECT code_hash FROM two_factor_recovery_code WHERE user_id=$1`,
      [admin.userId],
    );
    const hashes = dump.rows.map((r) => r.code_hash.toString('hex')).join('');
    for (const code of recoveryCodes) expect(hashes).not.toContain(Buffer.from(code).toString('hex'));
  });
});

/* ================================================================== *
 * The challenge
 * ================================================================== */

describe('the challenge', () => {
  it('accepts a valid code', async () => {
    const admin = await passwordOnlyStaff();
    const { secret } = await enrol(admin.token);
    await api.post('/me/2fa/disable', { code: totpCodeFor(secret, totpStep(new Date())) }, { token: admin.token });
    // Re-enrol and drop back to PASSWORD to exercise the challenge path.
    const fresh = await enrol(admin.token);
    await db.query(`UPDATE user_session SET auth_level='PASSWORD' WHERE user_id=$1`, [admin.userId]);

    const later = new Date(Date.now() + TOTP_STEP_SECONDS * 2000);
    const res = await api.post(
      '/me/2fa/challenge',
      { code: totpCodeFor(fresh.secret, totpStep(later)) },
      { token: admin.token, now: later },
    );
    expect(res.status).toBe(200);
    expect((await auth.resolveSession(admin.token))!.authLevel).toBe('TWO_FACTOR');
  });

  /* Without this a code stays usable for its whole window — anybody who reads
     it over a shoulder or captures it on a phishing page has up to a minute. */
  it('refuses a replayed code', async () => {
    const admin = await passwordOnlyStaff();
    const { secret } = await enrol(admin.token);
    await db.query(`UPDATE user_session SET auth_level='PASSWORD' WHERE user_id=$1`, [admin.userId]);

    const code = totpCodeFor(secret, totpStep(new Date()));
    // The enrolment already spent this step.
    const res = await api.post('/me/2fa/challenge', { code }, { token: admin.token });
    expect(res.status).toBe(422);
    expect((await auth.resolveSession(admin.token))!.authLevel).toBe('PASSWORD');
  });

  it('refuses a code from a different secret', async () => {
    const admin = await passwordOnlyStaff();
    await enrol(admin.token);
    await db.query(`UPDATE user_session SET auth_level='PASSWORD' WHERE user_id=$1`, [admin.userId]);
    const res = await api.post('/me/2fa/challenge', { code: '123456' }, { token: admin.token });
    expect(res.status).toBe(422);
  });

  it('says the same thing however it fails', async () => {
    const enrolled = await passwordOnlyStaff();
    await enrol(enrolled.token);
    await db.query(`UPDATE user_session SET auth_level='PASSWORD' WHERE user_id=$1`, [enrolled.userId]);
    const notEnrolled = await passwordOnlyStaff('SUPPORT');

    const a = await api.post('/me/2fa/challenge', { code: '000000' }, { token: enrolled.token });
    const b = await api.post('/me/2fa/challenge', { code: '000000' }, { token: notEnrolled.token });
    // Distinguishing them would tell somebody holding a stolen code which half
    // of their attack was working.
    expect(a.status).toBe(b.status);
    expect(a.body.error?.message ?? a.body.message).toBe(b.body.error?.message ?? b.body.message);
  });

  it('locks out after repeated failures and records every attempt', async () => {
    const admin = await passwordOnlyStaff();
    await enrol(admin.token);
    await db.query(`UPDATE user_session SET auth_level='PASSWORD' WHERE user_id=$1`, [admin.userId]);

    /* Distinct source addresses on purpose: the per-IP limit would otherwise
       fire first and this would prove the wrong control. What is under test is
       the per-ACCOUNT lockout, which follows the account wherever it is
       attacked from — the property that makes distributed guessing useless. */
    for (let i = 0; i < 5; i += 1) {
      await api.post('/me/2fa/challenge', { code: '000000' }, { token: admin.token, ip: `203.0.113.${i + 1}` });
    }
    const res = await api.post('/me/2fa/challenge', { code: '000000' }, { token: admin.token, ip: '203.0.113.99' });
    expect(res.status).toBe(429);

    const { rows } = await db.query<{ failed_attempts: number }>(
      `SELECT failed_attempts FROM user_totp WHERE user_id=$1`,
      [admin.userId],
    );
    expect(rows[0]!.failed_attempts).toBeGreaterThanOrEqual(5);
  });

  it('never writes a submitted code to the audit log', async () => {
    const admin = await passwordOnlyStaff();
    await enrol(admin.token);
    await db.query(`UPDATE user_session SET auth_level='PASSWORD' WHERE user_id=$1`, [admin.userId]);
    await api.post('/me/2fa/challenge', { code: '424242' }, { token: admin.token });

    const { rows } = await db.query<{ blob: string }>(
      `SELECT coalesce(changes::text,'') || coalesce(reason,'') AS blob FROM audit_log WHERE actor_user_id=$1`,
      [admin.userId],
    );
    for (const r of rows) expect(r.blob).not.toContain('424242');
  });
});

/* ================================================================== *
 * Recovery codes
 * ================================================================== */

describe('recovery codes', () => {
  it('work once', async () => {
    const admin = await passwordOnlyStaff();
    const { recoveryCodes } = await enrol(admin.token);
    await db.query(`UPDATE user_session SET auth_level='PASSWORD' WHERE user_id=$1`, [admin.userId]);

    const first = await api.post('/me/2fa/challenge', { code: recoveryCodes[0]! }, { token: admin.token });
    expect(first.status).toBe(200);
    expect((await auth.resolveSession(admin.token))!.roles).toContain('ADMIN');
  });

  it('refuse a second use of the same code', async () => {
    const admin = await passwordOnlyStaff();
    const { recoveryCodes } = await enrol(admin.token);
    await db.query(`UPDATE user_session SET auth_level='PASSWORD' WHERE user_id=$1`, [admin.userId]);

    await api.post('/me/2fa/challenge', { code: recoveryCodes[0]! }, { token: admin.token });
    await db.query(`UPDATE user_session SET auth_level='PASSWORD' WHERE user_id=$1`, [admin.userId]);

    const again = await api.post('/me/2fa/challenge', { code: recoveryCodes[0]! }, { token: admin.token });
    expect(again.status).toBe(422);
  });

  it('are forgiving about how they are typed', async () => {
    const admin = await passwordOnlyStaff();
    const { recoveryCodes } = await enrol(admin.token);
    await db.query(`UPDATE user_session SET auth_level='PASSWORD' WHERE user_id=$1`, [admin.userId]);

    const messy = recoveryCodes[1]!.toLowerCase().replace('-', ' ');
    expect((await api.post('/me/2fa/challenge', { code: messy }, { token: admin.token })).status).toBe(200);
  });

  it('report how many are left', async () => {
    const admin = await passwordOnlyStaff();
    const { recoveryCodes } = await enrol(admin.token);
    await db.query(`UPDATE user_session SET auth_level='PASSWORD' WHERE user_id=$1`, [admin.userId]);
    await api.post('/me/2fa/challenge', { code: recoveryCodes[0]! }, { token: admin.token });

    expect((await api.get('/me/2fa', { token: admin.token })).body.recoveryCodesRemaining).toBe(9);
  });

  it('a valid authenticator code never burns one', async () => {
    const admin = await passwordOnlyStaff();
    const { secret } = await enrol(admin.token);
    await db.query(`UPDATE user_session SET auth_level='PASSWORD' WHERE user_id=$1`, [admin.userId]);

    const later = new Date(Date.now() + TOTP_STEP_SECONDS * 2000);
    await api.post(
      '/me/2fa/challenge',
      { code: totpCodeFor(secret, totpStep(later)) },
      { token: admin.token, now: later },
    );
    expect((await api.get('/me/2fa', { token: admin.token })).body.recoveryCodesRemaining).toBe(10);
  });
});

/* ================================================================== *
 * Sessions
 * ================================================================== */

describe('sessions', () => {
  /* The likeliest bug in the slice, and it would present as "the console
     randomly 404s" — whose obvious fix is to weaken the control. */
  it('a rotated session keeps its authentication level', async () => {
    const admin = await passwordOnlyStaff();
    await enrol(admin.token);

    const rotated = await auth.rotateSession(admin.token);
    const session = await auth.resolveSession(rotated.token);
    expect(session!.authLevel).toBe('TWO_FACTOR');
    expect(session!.roles).toContain('ADMIN');
  });

  it('disabling 2FA drops every session back and withholds the roles again', async () => {
    const admin = await passwordOnlyStaff();
    const { secret } = await enrol(admin.token);
    expect((await api.get('/admin/overview', { token: admin.token })).status).toBe(200);

    const later = new Date(Date.now() + TOTP_STEP_SECONDS * 2000);
    const res = await api.post(
      '/me/2fa/disable',
      { code: totpCodeFor(secret, totpStep(later)) },
      { token: admin.token, now: later },
    );
    expect(res.status).toBe(200);
    expect((await api.get('/admin/overview', { token: admin.token })).status).toBe(403);
  });

  it('disabling requires a current code, so a stolen session cannot remove it', async () => {
    const admin = await passwordOnlyStaff();
    await enrol(admin.token);
    expect((await api.post('/me/2fa/disable', { code: '000000' }, { token: admin.token })).status).toBe(422);
    expect((await api.get('/admin/overview', { token: admin.token })).status).toBe(200);
  });
});

/* ================================================================== *
 * Reset, and who may do it
 * ================================================================== */

describe('resetting somebody else', () => {
  it('SUPPORT cannot strip a colleague’s second factor', async () => {
    const support = await api.signUp();
    await api.grantRole(support.userId, 'SUPPORT');
    const victim = await passwordOnlyStaff('VERIFIER');
    await enrol(victim.token);

    const res = await api.post(
      `/admin/users/${victim.userId}/2fa/reset`,
      { reason: 'просят по телефону' },
      { token: support.token },
    );
    expect(res.status).toBe(403);
  });

  it('ADMIN can, with a reason, and it revokes every session', async () => {
    const admin = await api.signUp();
    await api.grantRole(admin.userId, 'ADMIN');
    const victim = await passwordOnlyStaff('VERIFIER');
    await enrol(victim.token);

    const res = await api.post(
      `/admin/users/${victim.userId}/2fa/reset`,
      { reason: 'потерян телефон, личность подтверждена руководителем' },
      { token: admin.token },
    );
    expect(res.status).toBe(200);

    // Their session is gone entirely, not merely demoted.
    expect(await auth.resolveSession(victim.token)).toBeNull();
    const { rows } = await db.query<{ c: string }>(
      `SELECT count(*)::text c FROM user_totp WHERE user_id=$1`,
      [victim.userId],
    );
    expect(rows[0]!.c).toBe('0');
  });

  it('records who reset whom and why', async () => {
    const admin = await api.signUp();
    await api.grantRole(admin.userId, 'ADMIN');
    const victim = await passwordOnlyStaff('VERIFIER');
    await enrol(victim.token);
    await api.post(
      `/admin/users/${victim.userId}/2fa/reset`,
      { reason: 'потерян телефон' },
      { token: admin.token },
    );

    const { rows } = await db.query<{ action: string; reason: string }>(
      `SELECT action, reason FROM audit_log WHERE target_id=$1 AND action='auth.2fa.reset'`,
      [victim.userId],
    );
    expect(rows.length).toBe(1);
    expect(rows[0]!.reason).toContain('телефон');
  });
});

/* ================================================================== *
 * Step-up
 * ================================================================== */

describe('step-up', () => {
  it('refuses a sensitive action on a stale confirmation', async () => {
    const admin = await api.signUp();
    await api.grantRole(admin.userId, 'ADMIN');
    const target = await api.signUp();

    // Ordinary staff work still passes.
    expect((await api.get('/admin/overview', { token: admin.token })).status).toBe(200);

    await api.expireStepUp(admin.userId);
    // Suspending an account is on the step-up list.
    const res = await api.post(
      `/admin/users/${target.userId}/restrict`,
      { status: 'RESTRICTED', reason: 'проверка' },
      { token: admin.token },
    );
    expect(res.status).toBe(403);
    expect(res.errorCode).toBe('STEP_UP_REQUIRED');
  });

  it('lets ordinary staff work continue on a stale confirmation', async () => {
    const support = await api.signUp();
    await api.grantRole(support.userId, 'SUPPORT');
    await api.expireStepUp(support.userId);
    // Re-prompting for this all day would train people to type codes without
    // reading what they confirm.
    expect((await api.get('/admin/overview', { token: support.token })).status).toBe(200);
  });

  it('a fresh challenge restores it', async () => {
    const admin = await passwordOnlyStaff('ADMIN');
    const { secret } = await enrol(admin.token);
    const target = await api.signUp();
    await api.expireStepUp(admin.userId);

    const later = new Date(Date.now() + TOTP_STEP_SECONDS * 2000);
    await api.post(
      '/me/2fa/challenge',
      { code: totpCodeFor(secret, totpStep(later)) },
      { token: admin.token, now: later },
    );

    const res = await api.post(
      `/admin/users/${target.userId}/restrict`,
      { status: 'RESTRICTED', reason: 'проверка' },
      { token: admin.token },
    );
    expect(res.status).toBe(200);
  });
});
