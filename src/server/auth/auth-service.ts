/**
 * Registration, login, sessions.
 *
 * Design points that matter:
 *   - session tokens are stored hashed and rotated, with the previous id kept so
 *     that replay of a rotated token is detectable rather than merely rejected;
 *   - login failures are indistinguishable to the caller regardless of whether
 *     the account exists, and a dummy verification runs on the miss path so the
 *     response time does not leak the answer either;
 *   - every security-relevant event writes an audit row in the same transaction.
 */

import { createHash } from 'node:crypto';
import type { Db, Sql } from '../db/sql.ts';
import { hasErrorCode, PG_ERROR } from '../db/sql.ts';
import { uuidv7 } from '../../lib/id.ts';
import { DomainError, invalid, notFound as notFoundError } from '../services/errors.ts';
import { writeAudit } from '../services/audit.ts';
import { generateToken, hashPassword, hashToken, verifyPassword } from './credentials.ts';
import type { Role } from './rbac.ts';
import {
  effectiveRoles,
  generateRecoveryCodes,
  generateTotpSecret,
  isLockedOut,
  lockedUntil,
  normaliseRecoveryCode,
  otpauthUri,
  requiresTwoFactor,
  verifyTotp,
  withheldRoles,
  GENERIC_CHALLENGE_ERROR,
  type AuthLevel,
} from '../domain/two-factor.ts';

/** A hash of a real argon2id output, used to burn time on the account-miss path. */
const DUMMY_HASH =
  '$argon2id$v=19$m=19456,t=2,p=1$c29tZXNhbHRzb21lc2FsdA$J8mQKzZ0m1WQ0mQZ8mQKzZ0m1WQ0mQZ8mQKzZ0m1WQ0';

export const SESSION_TTL_DAYS = 30;
export const VERIFICATION_TTL_HOURS = 24;
export const MAX_FAILED_LOGINS = 8;

export interface RegisterInput {
  readonly email?: string;
  readonly phone?: string;
  readonly password: string;
  readonly displayName: string;
  readonly accountKind?: 'PRIVATE' | 'COMPANY';
  readonly companyName?: string;
  readonly locale?: 'ru' | 'be' | 'en';
}

export interface SessionContext {
  readonly userId: string;
  readonly sessionId: string;
  /**
   * The roles this session may actually exercise — NOT necessarily the roles
   * the user was granted. A staff member who has not satisfied their second
   * factor is handed the ordinary-user subset, which is what makes every
   * `can()` in the codebase enforce 2FA without knowing it exists.
   */
  readonly roles: readonly Role[];
  readonly displayName: string;
  readonly status: string;
  readonly emailVerified: boolean;
  readonly authLevel: AuthLevel;
  /** Staff roles held but not currently usable, so the UI can explain. */
  readonly withheldRoles: readonly Role[];
  /** When a second factor was last confirmed for a sensitive action. */
  readonly stepUpAt: Date | null;
  /** Whether an authenticator is set up at all. False means enrolment is due. */
  readonly twoFactorEnrolled: boolean;
}

export interface IssuedSession {
  readonly token: string;
  readonly sessionId: string;
  readonly expiresAt: Date;
}

export interface RequestMeta {
  readonly userAgent?: string | null;
  /** Raw address; hashed before storage, never persisted in the clear. */
  readonly ip?: string | null;
  readonly correlationId?: string | null;
}

const hashIp = (ip?: string | null): Buffer | null =>
  ip ? createHash('sha256').update(ip).digest() : null;

export class AuthService {
  constructor(private readonly db: Db) {}

  /* ---------------------------------------------------------------- */

  async register(input: RegisterInput, meta: RequestMeta = {}): Promise<{ userId: string; verificationToken: string }> {
    if (!input.email && !input.phone) throw invalid('Укажите email или номер телефона');
    if (input.displayName.trim().length < 2) throw invalid('Укажите имя');
    if (input.accountKind === 'COMPANY' && !input.companyName?.trim()) {
      throw invalid('Для аккаунта компании укажите название компании');
    }

    const passwordHash = await hashPassword(input.password);
    const userId = uuidv7();

    return this.db.transaction(async (tx) => {
      try {
        await tx.query(
          `INSERT INTO app_user (id, email, phone, password_hash, display_name, account_kind, company_name, locale)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [
            userId,
            input.email?.trim() ?? null,
            input.phone?.trim() ?? null,
            passwordHash,
            input.displayName.trim(),
            input.accountKind ?? 'PRIVATE',
            input.companyName?.trim() ?? null,
            input.locale ?? 'ru',
          ],
        );
      } catch (e) {
        if (hasErrorCode(e, PG_ERROR.UNIQUE_VIOLATION)) {
          // Deliberately vague: confirming which addresses are registered turns
          // the signup form into an account-enumeration oracle.
          throw new DomainError('ALREADY_EXISTS', 'Не удалось создать аккаунт с этими данными');
        }
        throw e;
      }

      // Everyone starts as a tenant; the landlord role is granted when a first
      // listing is created, so a browsing user carries no listing permissions.
      await tx.query(`INSERT INTO user_role (user_id, role) VALUES ($1,'TENANT')`, [userId]);

      const verificationToken = await this.issueAuthToken(tx, userId, 'EMAIL_VERIFICATION', VERIFICATION_TTL_HOURS);

      await writeAudit(tx, {
        actorUserId: userId,
        action: 'auth.register',
        targetType: 'user',
        targetId: userId,
        changes: { accountKind: { from: null, to: input.accountKind ?? 'PRIVATE' } },
        correlationId: meta.correlationId ?? null,
        ipHash: hashIp(meta.ip),
      });

      return { userId, verificationToken };
    });
  }

  /* ---------------------------------------------------------------- */

  /**
   * Authenticate and open a session.
   *
   * Every failure raises the same error with the same message, and the
   * account-miss path still performs an argon2 verification against a dummy
   * hash so that timing does not reveal whether the account exists.
   */
  async login(
    identifier: string,
    password: string,
    meta: RequestMeta = {},
  ): Promise<{ session: IssuedSession; context: SessionContext }> {
    const { rows } = await this.db.query<{
      id: string;
      password_hash: string | null;
      display_name: string;
      status: string;
      email_verified_at: string | null;
    }>(
      `SELECT id, password_hash, display_name, status, email_verified_at
         FROM app_user
        WHERE (email = $1 OR phone = $1) AND deleted_at IS NULL`,
      [identifier.trim()],
    );

    const user = rows[0];
    const ok = await verifyPassword(user?.password_hash ?? DUMMY_HASH, password);

    if (!user || !user.password_hash || !ok) {
      if (user) await this.recordFailedLogin(user.id, meta);
      throw new DomainError('UNAUTHENTICATED', 'Неверный email/телефон или пароль');
    }

    if (user.status === 'SUSPENDED' || user.status === 'DELETED') {
      throw new DomainError('ACCOUNT_RESTRICTED', 'Аккаунт заблокирован. Обратитесь в поддержку.');
    }

    if (await this.tooManyRecentFailures(user.id)) {
      throw new DomainError('RATE_LIMITED', 'Слишком много попыток входа. Попробуйте позже.');
    }

    const session = await this.db.transaction(async (tx) => {
      const issued = await this.createSession(tx, user.id, meta, null);
      await writeAudit(tx, {
        actorUserId: user.id,
        action: 'auth.login',
        targetType: 'user',
        targetId: user.id,
        correlationId: meta.correlationId ?? null,
        ipHash: hashIp(meta.ip),
      });
      return issued;
    });

    const context = await this.resolveSession(session.token);
    if (!context) throw new DomainError('UNAUTHENTICATED', 'Не удалось создать сессию');
    return { session, context };
  }

  /* ---------------------------------------------------------------- */

  /** Resolve a bearer token to a caller identity, or null if it is not usable. */
  async resolveSession(token: string): Promise<SessionContext | null> {
    const { rows } = await this.db.query<{
      session_id: string;
      user_id: string;
      display_name: string;
      status: string;
      email_verified_at: string | null;
      revoked_at: string | null;
      expired: boolean;
      auth_level: AuthLevel;
      step_up_at: Date | null;
      totp_confirmed_at: Date | null;
    }>(
      `SELECT s.id AS session_id, u.id AS user_id, u.display_name, u.status,
              u.email_verified_at, s.revoked_at, (s.expires_at <= now()) AS expired,
              s.auth_level, s.step_up_at, t.confirmed_at AS totp_confirmed_at
         FROM user_session s
         JOIN app_user u ON u.id = s.user_id
         LEFT JOIN user_totp t ON t.user_id = u.id
        WHERE s.token_hash = $1 AND u.deleted_at IS NULL`,
      [hashToken(token)],
    );

    const row = rows[0];
    if (!row || row.revoked_at !== null || row.expired) return null;
    if (row.status === 'SUSPENDED' || row.status === 'DELETED') return null;

    await this.db.query(`UPDATE user_session SET last_seen_at = now() WHERE id = $1`, [row.session_id]);

    const granted = (
      await this.db.query<{ role: Role }>(`SELECT role FROM user_role WHERE user_id = $1`, [row.user_id])
    ).rows.map((r) => r.role);

    /* THE ENFORCEMENT POINT.
     *
     * Everything that authorises anything in this codebase reads `roles` from
     * here: the router's permission gate, every staff page's own `can()` call,
     * and every capability object a page hands to a service. Withholding the
     * staff roles from a session that has not passed its second factor is
     * therefore not one check among many — it is the only one, and it cannot be
     * forgotten at a call site because no call site performs it.
     *
     * A check added to router.ts instead would have protected exactly one
     * endpoint and left the moderation queue, the dispute files, the
     * verification console and the retention console reachable on a password. */
    const effective = effectiveRoles(granted, row.auth_level);

    return {
      userId: row.user_id,
      sessionId: row.session_id,
      roles: effective,
      displayName: row.display_name,
      status: row.status,
      emailVerified: row.email_verified_at !== null,
      authLevel: row.auth_level,
      withheldRoles: withheldRoles(granted, row.auth_level),
      stepUpAt: row.step_up_at,
      twoFactorEnrolled: row.totp_confirmed_at !== null,
    };
  }

  /** The roles a user actually holds, ignoring what this session may exercise. */
  async grantedRoles(userId: string): Promise<readonly Role[]> {
    const { rows } = await this.db.query<{ role: Role }>(`SELECT role FROM user_role WHERE user_id=$1`, [
      userId,
    ]);
    return rows.map((r) => r.role);
  }

  /**
   * Rotate a session: issue a new token, revoke the old one, and link them.
   *
   * The link is the point. If the revoked token is presented afterwards it is
   * not merely expired — it is evidence that somebody else holds a copy, which
   * is a signal worth acting on.
   */
  async rotateSession(currentToken: string, meta: RequestMeta = {}): Promise<IssuedSession> {
    return this.db.transaction(async (tx) => {
      const { rows } = await tx.query<{
        id: string;
        user_id: string;
        auth_level: AuthLevel;
        step_up_at: Date | null;
      }>(
        `SELECT id, user_id, auth_level, step_up_at FROM user_session
          WHERE token_hash = $1 AND revoked_at IS NULL AND expires_at > now() FOR UPDATE`,
        [hashToken(currentToken)],
      );
      const current = rows[0];
      if (!current) throw new DomainError('UNAUTHENTICATED', 'Сессия недействительна');

      const issued = await this.createSession(tx, current.user_id, meta, current.id, {
        authLevel: current.auth_level,
        stepUpAt: current.step_up_at,
      });
      await tx.query(
        `UPDATE user_session SET revoked_at = now(), revoked_reason = 'ROTATED' WHERE id = $1`,
        [current.id],
      );
      return issued;
    });
  }

  async logout(token: string, meta: RequestMeta = {}): Promise<void> {
    await this.db.transaction(async (tx) => {
      const { rows } = await tx.query<{ id: string; user_id: string }>(
        `UPDATE user_session SET revoked_at = now(), revoked_reason = 'LOGOUT'
          WHERE token_hash = $1 AND revoked_at IS NULL
          RETURNING id, user_id`,
        [hashToken(token)],
      );
      const row = rows[0];
      if (!row) return;
      await writeAudit(tx, {
        actorUserId: row.user_id,
        action: 'auth.logout',
        targetType: 'session',
        targetId: row.id,
        correlationId: meta.correlationId ?? null,
      });
    });
  }

  /** Revoke every session — used on password change and on compromise. */
  async revokeAllSessions(userId: string, reason: string): Promise<number> {
    const { rowCount } = await this.db.query(
      `UPDATE user_session SET revoked_at = now(), revoked_reason = $2
        WHERE user_id = $1 AND revoked_at IS NULL`,
      [userId, reason],
    );
    return rowCount;
  }

  /* ---------------------------------------------------------------- */

  async verifyEmail(token: string): Promise<string> {
    return this.db.transaction(async (tx) => {
      const userId = await this.consumeAuthToken(tx, token, 'EMAIL_VERIFICATION');
      await tx.query(`UPDATE app_user SET email_verified_at = now() WHERE id = $1`, [userId]);
      await writeAudit(tx, {
        actorUserId: userId,
        action: 'auth.verify_email',
        targetType: 'user',
        targetId: userId,
      });
      return userId;
    });
  }

  async requestPasswordReset(identifier: string): Promise<string | null> {
    const { rows } = await this.db.query<{ id: string }>(
      `SELECT id FROM app_user WHERE (email = $1 OR phone = $1) AND deleted_at IS NULL`,
      [identifier.trim()],
    );
    const user = rows[0];
    // Null, not an error: the caller must respond identically either way so the
    // endpoint cannot be used to discover which addresses are registered.
    if (!user) return null;

    return this.db.transaction(async (tx) => this.issueAuthToken(tx, user.id, 'PASSWORD_RESET', 2));
  }

  /**
   * Complete a reset. Consumes the token, replaces the hash, and revokes every
   * existing session — if the reset was triggered by a compromise, leaving the
   * attacker's session alive would defeat the entire exercise.
   */
  async resetPassword(token: string, newPassword: string, meta: RequestMeta = {}): Promise<void> {
    const passwordHash = await hashPassword(newPassword);
    await this.db.transaction(async (tx) => {
      const userId = await this.consumeAuthToken(tx, token, 'PASSWORD_RESET');
      await tx.query(`UPDATE app_user SET password_hash = $2 WHERE id = $1`, [userId, passwordHash]);
      await tx.query(
        `UPDATE user_session SET revoked_at = now(), revoked_reason = 'PASSWORD_RESET'
          WHERE user_id = $1 AND revoked_at IS NULL`,
        [userId],
      );
      await writeAudit(tx, {
        actorUserId: userId,
        action: 'auth.password_reset',
        targetType: 'user',
        targetId: userId,
        correlationId: meta.correlationId ?? null,
        ipHash: hashIp(meta.ip),
      });
    });
  }

  /**
   * Change the password of a signed-in user.
   *
   * Requires the current password even though the caller already holds a valid
   * session: it is the only thing that distinguishes the account owner from
   * somebody sitting at their unlocked laptop, and a stolen session must not be
   * upgradeable into permanent account takeover.
   */
  async changePassword(
    userId: string,
    currentPassword: string,
    newPassword: string,
    meta: RequestMeta & { keepSessionId?: string } = {},
  ): Promise<void> {
    const { rows } = await this.db.query<{ password_hash: string | null }>(
      `SELECT password_hash FROM app_user WHERE id=$1 AND deleted_at IS NULL`,
      [userId],
    );
    const current = rows[0];
    if (!current?.password_hash || !(await verifyPassword(current.password_hash, currentPassword))) {
      throw new DomainError('UNAUTHENTICATED', 'Текущий пароль указан неверно');
    }

    const passwordHash = await hashPassword(newPassword);

    await this.db.transaction(async (tx) => {
      await tx.query(`UPDATE app_user SET password_hash=$2 WHERE id=$1`, [userId, passwordHash]);
      // Every other session dies. If the password was changed because of a
      // compromise, leaving the attacker signed in would defeat the point.
      await tx.query(
        `UPDATE user_session SET revoked_at=now(), revoked_reason='PASSWORD_CHANGED'
          WHERE user_id=$1 AND revoked_at IS NULL
            AND ($2::uuid IS NULL OR id <> $2::uuid)`,
        [userId, meta.keepSessionId ?? null],
      );
      await writeAudit(tx, {
        actorUserId: userId,
        action: 'auth.password_changed',
        targetType: 'user',
        targetId: userId,
        correlationId: meta.correlationId ?? null,
        ipHash: hashIp(meta.ip),
      });
    });
  }

  /** Sessions the user can see and revoke. Tokens are never included. */
  async listSessions(userId: string): Promise<Record<string, unknown>[]> {
    const { rows } = await this.db.query<Record<string, any>>(
      `SELECT id, user_agent, created_at, last_seen_at, expires_at
         FROM user_session
        WHERE user_id=$1 AND revoked_at IS NULL AND expires_at > now()
        ORDER BY last_seen_at DESC`,
      [userId],
    );
    return rows.map((r) => ({
      id: r.id,
      userAgent: r.user_agent,
      createdAt: r.created_at,
      lastSeenAt: r.last_seen_at,
      expiresAt: r.expires_at,
    }));
  }

  /** "Sign out everywhere else" — keeps the caller's own session alive. */
  async revokeOtherSessions(userId: string, keepSessionId: string): Promise<number> {
    const { rowCount } = await this.db.query(
      `UPDATE user_session SET revoked_at=now(), revoked_reason='USER_REVOKED_OTHERS'
        WHERE user_id=$1 AND id <> $2 AND revoked_at IS NULL`,
      [userId, keepSessionId],
    );
    return rowCount;
  }

  async grantRole(userId: string, role: Role, grantedBy: string, reason: string): Promise<void> {
    if (!reason?.trim()) throw invalid('Укажите причину предоставления роли');
    await this.db.transaction(async (tx) => {
      await tx.query(
        `INSERT INTO user_role (user_id, role, granted_by) VALUES ($1,$2,$3)
         ON CONFLICT (user_id, role) DO NOTHING`,
        [userId, role, grantedBy],
      );
      await writeAudit(tx, {
        actorUserId: grantedBy,
        actorRole: 'ADMIN',
        action: 'auth.grant_role',
        targetType: 'user',
        targetId: userId,
        changes: { role: { from: null, to: role } },
        reason,
        source: 'admin',
      });
    });
  }

  /* ---------------------------------------------------------------- */

  /* ================================================================ *
   * Two-factor authentication
   * ================================================================ */

  /**
   * Start enrolment: mint a secret and hand back the URI for a QR code.
   *
   * Deliberately re-mintable. An unconfirmed secret is worthless — nothing
   * trusts it until a code proves the person actually scanned it — so a second
   * visit to the enrolment page after a failed scan replaces it rather than
   * resuming something half-done. Once confirmed, this refuses: replacing a
   * working authenticator is a reset, which is a different and audited act.
   */
  async beginTotpEnrolment(userId: string, account: string): Promise<{ secret: string; uri: string }> {
    const existing = await this.db.query<{ confirmed_at: Date | null }>(
      `SELECT confirmed_at FROM user_totp WHERE user_id=$1`,
      [userId],
    );
    if (existing.rows[0]?.confirmed_at) {
      throw new DomainError('CONFLICT', 'Двухфакторная проверка уже настроена');
    }

    const secret = generateTotpSecret();
    await this.db.query(
      `INSERT INTO user_totp (user_id, secret_base32) VALUES ($1,$2)
       ON CONFLICT (user_id) DO UPDATE
         SET secret_base32 = EXCLUDED.secret_base32,
             confirmed_at = NULL, last_used_step = NULL,
             failed_attempts = 0, last_failure_at = NULL`,
      [userId, secret],
    );
    return { secret, uri: otpauthUri(secret, account) };
  }

  /**
   * Finish enrolment: prove the authenticator works, and get the codes.
   *
   * The current session is promoted here. Requiring a fresh login immediately
   * after enrolling would be a confusing dead end — the person has just proved
   * possession, which is exactly what a challenge asks for.
   *
   * Recovery codes are returned once, in this response, and never again. They
   * are stored only as hashes, so the platform genuinely cannot show them
   * later; that is the property that makes them worth having.
   */
  async confirmTotpEnrolment(
    userId: string,
    sessionId: string,
    code: string,
    now: Date = new Date(),
  ): Promise<{ recoveryCodes: string[] }> {
    return this.db.transaction(async (tx) => {
      const { rows } = await tx.query<{ secret_base32: string; confirmed_at: Date | null }>(
        `SELECT secret_base32, confirmed_at FROM user_totp WHERE user_id=$1 FOR UPDATE`,
        [userId],
      );
      const totp = rows[0];
      if (!totp) throw new DomainError('CONFLICT', 'Сначала начните настройку');
      if (totp.confirmed_at) throw new DomainError('CONFLICT', 'Двухфакторная проверка уже настроена');

      const result = verifyTotp(totp.secret_base32, code, now);
      if (!result.valid) throw new DomainError('VALIDATION_FAILED', GENERIC_CHALLENGE_ERROR);

      await tx.query(
        `UPDATE user_totp SET confirmed_at = now(), last_used_step = $2, failed_attempts = 0 WHERE user_id=$1`,
        [userId, result.step],
      );

      const codes = generateRecoveryCodes();
      for (const plain of codes) {
        await tx.query(
          `INSERT INTO two_factor_recovery_code (id, user_id, code_hash) VALUES ($1,$2,$3)`,
          [uuidv7(), userId, hashToken(normaliseRecoveryCode(plain))],
        );
      }

      await tx.query(
        `UPDATE user_session SET auth_level='TWO_FACTOR', step_up_at=now() WHERE id=$1`,
        [sessionId],
      );

      await writeAudit(tx, {
        actorUserId: userId,
        action: 'auth.2fa.enrolled',
        targetType: 'user',
        targetId: userId,
      });

      return { recoveryCodes: codes };
    });
  }

  /**
   * Answer a challenge with a TOTP code or a recovery code.
   *
   * Both paths share one attempt counter, which is what makes the arithmetic
   * work: a recovery code is 40 bits, and 40 bits behind an escalating lockout
   * is unguessable, but 40 bits with its own generous counter would not be.
   *
   * Every failure produces the same message. Distinguishing "not enrolled" from
   * "wrong code" from "already used" would tell somebody holding a stolen code
   * exactly which part of their attack was working.
   */
  async answerChallenge(
    userId: string,
    sessionId: string,
    code: string,
    now: Date = new Date(),
  ): Promise<{ ok: true }> {
    /* THE FAILURE COUNTER IS WRITTEN OUTSIDE THE TRANSACTION, AND THAT IS THE
       WHOLE POINT OF THIS SHAPE.

       The obvious implementation — increment `failed_attempts` and then throw,
       both inside one transaction — does not work: the throw rolls the
       transaction back, taking the increment with it. The counter stays at
       zero, the lockout never engages, and an attacker may guess for ever
       while every individual response looks correctly rejected. A test caught
       this; nothing about the code reads as wrong.

       So the transaction decides, commits only what should survive a success,
       and the rejection is recorded afterwards by a statement of its own. */
    const outcome = await this.db.transaction(async (tx) => {
      const { rows } = await tx.query<{
        secret_base32: string;
        confirmed_at: Date | null;
        last_used_step: string | null;
        failed_attempts: number;
        last_failure_at: Date | null;
      }>(
        `SELECT secret_base32, confirmed_at, last_used_step, failed_attempts, last_failure_at
           FROM user_totp WHERE user_id=$1 FOR UPDATE`,
        [userId],
      );
      const totp = rows[0];
      if (!totp?.confirmed_at) return { kind: 'REJECT' as const, record: false };

      if (isLockedOut(totp.failed_attempts) && totp.last_failure_at) {
        if (now < lockedUntil(totp.failed_attempts, totp.last_failure_at)) {
          return { kind: 'LOCKED' as const };
        }
      }

      const lastStep = totp.last_used_step === null ? null : Number(totp.last_used_step);
      const totpResult = verifyTotp(totp.secret_base32, code, now, { lastUsedStep: lastStep });

      let matchedRecoveryId: string | null = null;
      if (!totpResult.valid) {
        // Only consulted when the authenticator did not match, so a valid TOTP
        // code never burns a recovery code.
        const recovery = await tx.query<{ id: string }>(
          `SELECT id FROM two_factor_recovery_code
            WHERE user_id=$1 AND code_hash=$2 AND used_at IS NULL`,
          [userId, hashToken(normaliseRecoveryCode(code))],
        );
        matchedRecoveryId = recovery.rows[0]?.id ?? null;
      }

      if (!totpResult.valid && !matchedRecoveryId) {
        return { kind: 'REJECT' as const, record: true };
      }

      if (matchedRecoveryId) {
        // Single use, enforced by the update's own predicate rather than by
        // having read it a moment ago.
        const spent = await tx.query(
          `UPDATE two_factor_recovery_code SET used_at=now() WHERE id=$1 AND used_at IS NULL`,
          [matchedRecoveryId],
        );
        if (spent.rowCount === 0) return { kind: 'REJECT' as const, record: true };
      }

      await tx.query(
        `UPDATE user_totp
            SET failed_attempts = 0, last_failure_at = NULL,
                last_used_step = COALESCE($2, last_used_step)
          WHERE user_id=$1`,
        [userId, totpResult.step],
      );
      await tx.query(
        `UPDATE user_session SET auth_level='TWO_FACTOR', step_up_at=now() WHERE id=$1`,
        [sessionId],
      );
      await writeAudit(tx, {
        actorUserId: userId,
        action: matchedRecoveryId ? 'auth.2fa.recovery_used' : 'auth.2fa.passed',
        targetType: 'user',
        targetId: userId,
      });
      return { kind: 'PASS' as const };
    });

    if (outcome.kind === 'PASS') return { ok: true as const };

    if (outcome.kind === 'LOCKED') {
      throw new DomainError('RATE_LIMITED', 'Слишком много попыток. Попробуйте позже.');
    }

    if (outcome.record) {
      // Its own transaction, so it commits even though the caller is about to
      // receive an error. The audit row travels with it.
      await this.db.transaction(async (tx) => {
        await tx.query(
          `UPDATE user_totp SET failed_attempts = failed_attempts + 1, last_failure_at = now()
            WHERE user_id=$1`,
          [userId],
        );
        await writeAudit(tx, {
          actorUserId: userId,
          action: 'auth.2fa.failed',
          targetType: 'user',
          targetId: userId,
          // The reason is recorded; the submitted code never is.
          reason: 'invalid code',
        });
      });
    }

    /* Every failure says the same thing. Distinguishing "not enrolled" from
       "wrong code" from "already used" would tell somebody holding a stolen
       code exactly which half of their attack was working. */
    throw new DomainError('VALIDATION_FAILED', GENERIC_CHALLENGE_ERROR);
  }

  /** How many recovery codes remain, for the reminder on the security page. */
  async recoveryCodesRemaining(userId: string): Promise<number> {
    const { rows } = await this.db.query<{ c: string }>(
      `SELECT count(*)::text c FROM two_factor_recovery_code WHERE user_id=$1 AND used_at IS NULL`,
      [userId],
    );
    return Number(rows[0]!.c);
  }

  /**
   * Turn 2FA off for oneself.
   *
   * Requires a current code: otherwise a stolen session — which is the thing
   * the second factor exists to survive — could simply remove it.
   */
  async disableTotp(userId: string, code: string, now: Date = new Date()): Promise<void> {
    await this.db.transaction(async (tx) => {
      const { rows } = await tx.query<{ secret_base32: string; confirmed_at: Date | null }>(
        `SELECT secret_base32, confirmed_at FROM user_totp WHERE user_id=$1 FOR UPDATE`,
        [userId],
      );
      const totp = rows[0];
      if (!totp?.confirmed_at) throw notFoundError('Двухфакторная проверка');
      if (!verifyTotp(totp.secret_base32, code, now).valid) {
        throw new DomainError('VALIDATION_FAILED', GENERIC_CHALLENGE_ERROR);
      }

      await tx.query(`DELETE FROM two_factor_recovery_code WHERE user_id=$1`, [userId]);
      await tx.query(`DELETE FROM user_totp WHERE user_id=$1`, [userId]);
      // Every session drops back to PASSWORD, so staff roles are withheld until
      // the person enrols again.
      await tx.query(
        `UPDATE user_session SET auth_level='PASSWORD', step_up_at=NULL WHERE user_id=$1 AND revoked_at IS NULL`,
        [userId],
      );
      await writeAudit(tx, {
        actorUserId: userId,
        action: 'auth.2fa.disabled',
        targetType: 'user',
        targetId: userId,
      });
    });
  }

  /**
   * Clear somebody else's authenticator — the lost-phone path.
   *
   * Gated on `role.grant` at the route, which only ADMIN holds, so SUPPORT
   * cannot strip a colleague's second factor. That is permission selection
   * rather than new enforcement code, and it is deliberate: the ability to
   * remove another person's 2FA is the ability to become them.
   *
   * It does not enrol a replacement. The person re-enrols themselves, so the
   * administrator never sees a secret.
   */
  async resetTotpFor(targetUserId: string, actor: { userId: string; role: string }, reason: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx.query(`DELETE FROM two_factor_recovery_code WHERE user_id=$1`, [targetUserId]);
      await tx.query(`DELETE FROM user_totp WHERE user_id=$1`, [targetUserId]);
      await tx.query(
        `UPDATE user_session SET revoked_at=now(), revoked_reason='2FA_RESET'
          WHERE user_id=$1 AND revoked_at IS NULL`,
        [targetUserId],
      );
      await writeAudit(tx, {
        actorUserId: actor.userId,
        actorRole: actor.role,
        action: 'auth.2fa.reset',
        targetType: 'user',
        targetId: targetUserId,
        reason,
        source: 'admin',
      });
    });
  }

  /** Refresh the step-up stamp after a fresh challenge. */
  async recordStepUp(sessionId: string): Promise<void> {
    await this.db.query(`UPDATE user_session SET step_up_at=now() WHERE id=$1`, [sessionId]);
  }

  /** Whether this account must enrol before it can use its staff roles. */
  async twoFactorRequired(userId: string): Promise<boolean> {
    return requiresTwoFactor(await this.grantedRoles(userId));
  }

  private async createSession(
    tx: Sql,
    userId: string,
    meta: RequestMeta,
    previousId: string | null,
    /* Carried across a rotation. A session that had satisfied its second factor
       must not be silently demoted by refreshing its token — that would present
       as the console 404ing at random, and the fix people would reach for is to
       weaken the check. */
    inherit: { authLevel: AuthLevel; stepUpAt: Date | null } = { authLevel: 'PASSWORD', stepUpAt: null },
  ): Promise<IssuedSession> {
    const token = generateToken();
    const sessionId = uuidv7();
    const expiresAt = new Date(Date.now() + SESSION_TTL_DAYS * 86_400_000);

    await tx.query(
      `INSERT INTO user_session
         (id, user_id, token_hash, previous_id, user_agent, ip_hash, expires_at, auth_level, step_up_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [
        sessionId,
        userId,
        hashToken(token),
        previousId,
        meta.userAgent ?? null,
        hashIp(meta.ip),
        expiresAt.toISOString(),
        inherit.authLevel,
        inherit.stepUpAt,
      ],
    );

    return { token, sessionId, expiresAt };
  }

  private async issueAuthToken(
    tx: Sql,
    userId: string,
    purpose: 'EMAIL_VERIFICATION' | 'PASSWORD_RESET' | 'PHONE_OTP' | 'TELEGRAM_LINK',
    ttlHours: number,
  ): Promise<string> {
    // Only one live token per purpose: issuing a new reset link must invalidate
    // the previous one.
    await tx.query(
      `UPDATE auth_token SET consumed_at = now()
        WHERE user_id = $1 AND purpose = $2 AND consumed_at IS NULL`,
      [userId, purpose],
    );

    const token = generateToken();
    await tx.query(
      `INSERT INTO auth_token (id, user_id, purpose, token_hash, expires_at)
       VALUES ($1,$2,$3,$4, now() + ($5 || ' hours')::interval)`,
      [uuidv7(), userId, purpose, hashToken(token), String(ttlHours)],
    );
    return token;
  }

  private async consumeAuthToken(tx: Sql, token: string, purpose: string): Promise<string> {
    const { rows } = await tx.query<{ id: string; user_id: string }>(
      `UPDATE auth_token SET consumed_at = now()
        WHERE token_hash = $1 AND purpose = $2 AND consumed_at IS NULL AND expires_at > now()
        RETURNING id, user_id`,
      [hashToken(token), purpose],
    );
    const row = rows[0];
    if (!row) throw new DomainError('UNAUTHENTICATED', 'Ссылка недействительна или устарела');
    return row.user_id;
  }

  private async recordFailedLogin(userId: string, meta: RequestMeta): Promise<void> {
    await this.db.transaction(async (tx) => {
      await writeAudit(tx, {
        actorUserId: userId,
        action: 'auth.login_failed',
        targetType: 'user',
        targetId: userId,
        correlationId: meta.correlationId ?? null,
        ipHash: hashIp(meta.ip),
      });
    });
  }

  private async tooManyRecentFailures(userId: string): Promise<boolean> {
    const { rows } = await this.db.query<{ c: string }>(
      `SELECT count(*)::text AS c FROM audit_log
        WHERE actor_user_id = $1 AND action = 'auth.login_failed'
          AND occurred_at > now() - interval '15 minutes'`,
      [userId],
    );
    return Number(rows[0]!.c) >= MAX_FAILED_LOGINS;
  }
}
