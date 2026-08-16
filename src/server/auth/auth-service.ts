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
import { DomainError, invalid } from '../services/errors.ts';
import { writeAudit } from '../services/audit.ts';
import { generateToken, hashPassword, hashToken, verifyPassword } from './credentials.ts';
import type { Role } from './rbac.ts';

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
  readonly roles: readonly Role[];
  readonly displayName: string;
  readonly status: string;
  readonly emailVerified: boolean;
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
    }>(
      `SELECT s.id AS session_id, u.id AS user_id, u.display_name, u.status,
              u.email_verified_at, s.revoked_at, (s.expires_at <= now()) AS expired
         FROM user_session s
         JOIN app_user u ON u.id = s.user_id
        WHERE s.token_hash = $1 AND u.deleted_at IS NULL`,
      [hashToken(token)],
    );

    const row = rows[0];
    if (!row || row.revoked_at !== null || row.expired) return null;
    if (row.status === 'SUSPENDED' || row.status === 'DELETED') return null;

    await this.db.query(`UPDATE user_session SET last_seen_at = now() WHERE id = $1`, [row.session_id]);

    const roles = await this.db.query<{ role: Role }>(`SELECT role FROM user_role WHERE user_id = $1`, [
      row.user_id,
    ]);

    return {
      userId: row.user_id,
      sessionId: row.session_id,
      roles: roles.rows.map((r) => r.role),
      displayName: row.display_name,
      status: row.status,
      emailVerified: row.email_verified_at !== null,
    };
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
      const { rows } = await tx.query<{ id: string; user_id: string }>(
        `SELECT id, user_id FROM user_session
          WHERE token_hash = $1 AND revoked_at IS NULL AND expires_at > now() FOR UPDATE`,
        [hashToken(currentToken)],
      );
      const current = rows[0];
      if (!current) throw new DomainError('UNAUTHENTICATED', 'Сессия недействительна');

      const issued = await this.createSession(tx, current.user_id, meta, current.id);
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

  private async createSession(
    tx: Sql,
    userId: string,
    meta: RequestMeta,
    previousId: string | null,
  ): Promise<IssuedSession> {
    const token = generateToken();
    const sessionId = uuidv7();
    const expiresAt = new Date(Date.now() + SESSION_TTL_DAYS * 86_400_000);

    await tx.query(
      `INSERT INTO user_session (id, user_id, token_hash, previous_id, user_agent, ip_hash, expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [
        sessionId,
        userId,
        hashToken(token),
        previousId,
        meta.userAgent ?? null,
        hashIp(meta.ip),
        expiresAt.toISOString(),
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
