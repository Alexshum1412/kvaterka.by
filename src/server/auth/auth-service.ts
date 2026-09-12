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
import { generateNumericCode, generateToken, hashPassword, hashToken, tokensMatch, verifyPassword } from './credentials.ts';
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
/** A staff-created account's setup link lives longer than a self-service
 * reset (2h): nobody is locked out waiting on it, so there is no reason to
 * rush the person it was sent to. */
export const STAFF_ACCOUNT_SETUP_TTL_HOURS = 72;
export const MAX_FAILED_LOGINS = 8;
export const REGISTRATION_CODE_TTL_MINUTES = 30;
/** 6 digits is a million combinations; capping wrong guesses here is what
 * keeps that a real barrier rather than something a script exhausts before
 * the code even expires. */
export const MAX_REGISTRATION_CODE_ATTEMPTS = 6;

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
  /** Verified via a linked Telegram account — see 0018. */
  readonly phoneVerified: boolean;
  readonly authLevel: AuthLevel;
  /** Staff roles held but not currently usable, so the UI can explain. */
  readonly withheldRoles: readonly Role[];
  /** When a second factor was last confirmed for a sensitive action. */
  readonly stepUpAt: Date | null;
  /** Whether an authenticator is set up at all. False means enrolment is due. */
  readonly twoFactorEnrolled: boolean;
  /** Storage key of the uploaded profile picture — see 0022. Null means "no photo, draw the initial". */
  readonly avatarStorageKey: string | null;
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

  /**
   * Step 1 of registration: prove the inputs are usable and hand back a code
   * to send. Deliberately writes no `app_user` row — an email that nobody
   * has proven they can read must not become a working account, or the cost
   * of squatting a hundred addresses is zero. `pending_registration` is the
   * holding area; `confirmRegistration` is the only door out of it.
   */
  async beginRegistration(input: RegisterInput, meta: RequestMeta = {}): Promise<{ identifier: string; code: string }> {
    if (!input.email && !input.phone) throw invalid('Укажите email или номер телефона');
    if (input.displayName.trim().length < 2) throw invalid('Укажите имя');
    if (input.accountKind === 'COMPANY' && !input.companyName?.trim()) {
      throw invalid('Для аккаунта компании укажите название компании');
    }

    const identifier = (input.email ?? input.phone)!.trim();

    // Same vague-error posture the old flow used: confirming which addresses
    // already hold a real account turns this into an enumeration oracle.
    const { rows: existingRows } = await this.db.query<{ id: string }>(
      `SELECT id FROM app_user WHERE (lower(email) = lower($1) OR phone = $1) AND deleted_at IS NULL`,
      [identifier],
    );
    if (existingRows[0]) {
      throw new DomainError('ALREADY_EXISTS', 'Не удалось создать аккаунт с этими данными');
    }

    const passwordHash = await hashPassword(input.password);
    const code = generateNumericCode();
    const pendingId = uuidv7();

    await this.db.transaction(async (tx) => {
      // One live attempt per address. A second submission (lost email, typo,
      // change of mind) replaces it outright rather than needing its own
      // "resend" bookkeeping — registering again IS the resend.
      await tx.query(
        `DELETE FROM pending_registration
          WHERE (email IS NOT NULL AND lower(email) = lower($1)) OR (phone IS NOT NULL AND phone = $1)`,
        [identifier],
      );
      try {
        await tx.query(
          `INSERT INTO pending_registration
             (id, email, phone, password_hash, display_name, account_kind, company_name, locale, code_hash, expires_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9, now() + ($10 || ' minutes')::interval)`,
          [
            pendingId,
            input.email?.trim() ?? null,
            input.phone?.trim() ?? null,
            passwordHash,
            input.displayName.trim(),
            input.accountKind ?? 'PRIVATE',
            input.companyName?.trim() ?? null,
            input.locale ?? 'ru',
            hashToken(code),
            String(REGISTRATION_CODE_TTL_MINUTES),
          ],
        );
      } catch (e) {
        if (hasErrorCode(e, PG_ERROR.UNIQUE_VIOLATION)) {
          throw new DomainError('ALREADY_EXISTS', 'Не удалось создать аккаунт с этими данными');
        }
        throw e;
      }
    });

    void meta; // reserved: no audit row yet — nothing has been created to audit.
    return { identifier, code };
  }

  /**
   * Step 2: spend the code, create the real account, and log it straight in.
   *
   * Auto-login is deliberate, not a shortcut — the person just proved control
   * of the address AND typed the password that will protect the account, in
   * the same breath a login normally happens in. Asking them to now log in
   * separately would be a second form for no safety gained.
   */
  async confirmRegistration(
    identifier: string,
    code: string,
    meta: RequestMeta = {},
  ): Promise<{ session: IssuedSession; context: SessionContext }> {
    const GENERIC = 'Код неверен или устарел';

    /* THE ATTEMPT COUNTER IS WRITTEN OUTSIDE THE TRANSACTION THAT DECIDED IT,
       AND THAT IS THE WHOLE POINT OF THIS SHAPE — same reasoning, and the
       same bug it avoids, as `answerChallenge`'s own comment above.
       Incrementing `attempts` and then throwing, both inside one
       transaction, does not work: the throw rolls the transaction back and
       takes the increment with it, so the counter never moves and the
       lockout never engages no matter how many wrong codes arrive. So the
       transaction below only ever DECIDES an outcome and returns it; nothing
       that must survive a "wrong code" response is written inside a branch
       that also throws. */
    const outcome = await this.db.transaction(async (tx) => {
      const { rows } = await tx.query<{
        id: string;
        email: string | null;
        phone: string | null;
        password_hash: string;
        display_name: string;
        account_kind: string;
        company_name: string | null;
        locale: string;
        code_hash: Buffer;
        attempts: number;
        expires_at: Date;
      }>(
        `SELECT id, email, phone, password_hash, display_name, account_kind, company_name, locale,
                code_hash, attempts, expires_at
           FROM pending_registration
          WHERE (email IS NOT NULL AND lower(email) = lower($1)) OR (phone IS NOT NULL AND phone = $1)
          FOR UPDATE`,
        [identifier.trim()],
      );
      const pending = rows[0];
      if (!pending) return { kind: 'REJECT' as const };

      if (pending.expires_at.getTime() <= Date.now()) {
        await tx.query(`DELETE FROM pending_registration WHERE id = $1`, [pending.id]);
        return { kind: 'REJECT' as const };
      }
      if (pending.attempts >= MAX_REGISTRATION_CODE_ATTEMPTS) {
        return { kind: 'LOCKED' as const };
      }
      if (!tokensMatch(hashToken(code.trim()), pending.code_hash)) {
        return { kind: 'WRONG' as const, pendingId: pending.id };
      }

      const userId = uuidv7();
      try {
        await tx.query(
          `INSERT INTO app_user
             (id, email, phone, password_hash, display_name, account_kind, company_name, locale, email_verified_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8, now())`,
          [
            userId,
            pending.email,
            pending.phone,
            pending.password_hash,
            pending.display_name,
            pending.account_kind,
            pending.company_name,
            pending.locale,
          ],
        );
      } catch (e) {
        if (hasErrorCode(e, PG_ERROR.UNIQUE_VIOLATION)) {
          // Somebody else finished registering this exact address first — a
          // race, not a normal path. Either way this pending row is stale.
          await tx.query(`DELETE FROM pending_registration WHERE id = $1`, [pending.id]);
          return { kind: 'ALREADY_EXISTS' as const };
        }
        throw e;
      }

      // Everyone starts as a tenant; the landlord role is granted when a first
      // listing is created, so a browsing user carries no listing permissions.
      await tx.query(`INSERT INTO user_role (user_id, role) VALUES ($1,'TENANT')`, [userId]);
      await tx.query(`DELETE FROM pending_registration WHERE id = $1`, [pending.id]);

      const issued = await this.createSession(tx, userId, meta, null);

      await writeAudit(tx, {
        actorUserId: userId,
        action: 'auth.register',
        targetType: 'user',
        targetId: userId,
        changes: { accountKind: { from: null, to: pending.account_kind } },
        correlationId: meta.correlationId ?? null,
        ipHash: hashIp(meta.ip),
      });
      await writeAudit(tx, {
        actorUserId: userId,
        action: 'auth.email_confirmed',
        targetType: 'user',
        targetId: userId,
        correlationId: meta.correlationId ?? null,
      });

      return { kind: 'OK' as const, issued };
    });

    if (outcome.kind === 'OK') {
      const context = await this.resolveSession(outcome.issued.token);
      if (!context) throw new DomainError('UNAUTHENTICATED', 'Не удалось создать сессию');
      return { session: outcome.issued, context };
    }

    if (outcome.kind === 'ALREADY_EXISTS') {
      throw new DomainError('ALREADY_EXISTS', 'Не удалось создать аккаунт с этими данными');
    }

    if (outcome.kind === 'LOCKED') {
      throw new DomainError('RATE_LIMITED', 'Слишком много попыток. Запросите код ещё раз.');
    }

    if (outcome.kind === 'WRONG') {
      // Its own statement, so it commits even though this call is about to
      // throw — see the comment above.
      await this.db.query(`UPDATE pending_registration SET attempts = attempts + 1 WHERE id = $1`, [
        outcome.pendingId,
      ]);
    }

    throw new DomainError('UNAUTHENTICATED', GENERIC);
  }

  /**
   * A fresh code for a pending registration. Returns null rather than
   * throwing when nothing is pending — same reasoning as
   * `requestPasswordReset`: the caller must respond identically either way,
   * or this becomes a second oracle for which addresses are mid-signup.
   */
  async resendRegistrationCode(identifier: string): Promise<string | null> {
    return this.db.transaction(async (tx) => {
      const { rows } = await tx.query<{ id: string }>(
        `SELECT id FROM pending_registration
          WHERE (email IS NOT NULL AND lower(email) = lower($1)) OR (phone IS NOT NULL AND phone = $1)
          FOR UPDATE`,
        [identifier.trim()],
      );
      const pending = rows[0];
      if (!pending) return null;

      const code = generateNumericCode();
      await tx.query(
        `UPDATE pending_registration
            SET code_hash = $2, attempts = 0, expires_at = now() + ($3 || ' minutes')::interval
          WHERE id = $1`,
        [pending.id, hashToken(code), String(REGISTRATION_CODE_TTL_MINUTES)],
      );
      return code;
    });
  }

  /**
   * Sign in with Google — completes or begins the account in one step.
   *
   * Google has already proven control of the inbox (that is what
   * `emailVerified` asserts on its side), so there is no code to type and no
   * `pending_registration` row: a brand-new signer becomes a real, already-
   * verified `app_user` immediately. This is the one path allowed to skip
   * the pending table, and it is allowed to precisely because Google already
   * did the work that table exists to require of everyone else.
   */
  async continueWithGoogle(
    google: { sub: string; email: string; emailVerified: boolean; name: string | null },
    meta: RequestMeta = {},
  ): Promise<{ session: IssuedSession; context: SessionContext }> {
    if (!google.emailVerified) {
      throw new DomainError('VALIDATION_FAILED', 'Google сообщает, что этот email не подтверждён');
    }

    const session = await this.db.transaction(async (tx) => {
      const bySub = await tx.query<{ id: string }>(
        `SELECT id FROM app_user WHERE google_sub = $1 AND deleted_at IS NULL`,
        [google.sub],
      );
      if (bySub.rows[0]) {
        return this.createSession(tx, bySub.rows[0]!.id, meta, null);
      }

      const byEmail = await tx.query<{ id: string }>(
        `SELECT id FROM app_user WHERE lower(email) = lower($1) AND deleted_at IS NULL`,
        [google.email],
      );
      if (byEmail.rows[0]) {
        // An existing password account signing in with Google for the first
        // time: link it, rather than mint a second account for one person.
        const userId = byEmail.rows[0]!.id;
        await tx.query(`UPDATE app_user SET google_sub = $2 WHERE id = $1`, [userId, google.sub]);
        await writeAudit(tx, {
          actorUserId: userId,
          action: 'auth.google_linked',
          targetType: 'user',
          targetId: userId,
          correlationId: meta.correlationId ?? null,
        });
        return this.createSession(tx, userId, meta, null);
      }

      const userId = uuidv7();
      // No password: this account can only sign in through Google until its
      // owner sets one via "forgot password" — the same unusable-hash shape
      // `createStaffManagedAccount` uses, and for the same reason: there must
      // never be a moment where a guessed or default password authenticates
      // as this user.
      const passwordHash = await hashPassword(generateToken());
      const displayName = google.name?.trim() || google.email.split('@')[0]!;
      await tx.query(
        `INSERT INTO app_user (id, email, password_hash, display_name, account_kind, locale, email_verified_at, google_sub)
         VALUES ($1,$2,$3,$4,'PRIVATE','ru', now(), $5)`,
        [userId, google.email, passwordHash, displayName, google.sub],
      );
      await tx.query(`INSERT INTO user_role (user_id, role) VALUES ($1,'TENANT')`, [userId]);
      await writeAudit(tx, {
        actorUserId: userId,
        action: 'auth.register',
        targetType: 'user',
        targetId: userId,
        changes: { accountKind: { from: null, to: 'PRIVATE' } },
        correlationId: meta.correlationId ?? null,
        ipHash: hashIp(meta.ip),
      });
      return this.createSession(tx, userId, meta, null);
    });

    const context = await this.resolveSession(session.token);
    if (!context) throw new DomainError('UNAUTHENTICATED', 'Не удалось создать сессию');
    return { session, context };
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
      /* lower() on both sides rather than a bare `email = $1`, because the
         column is plain text now. It was citext, whose whole purpose was to
         make this comparison case-insensitive without anyone having to
         remember; citext needs an extension the production host will not
         install. This form reads app_user_email_lower_idx, the unique index
         that carries the same guarantee, so the query is no slower and
         Test@Email.com still signs in as test@email.com. */
      `SELECT id, password_hash, display_name, status, email_verified_at
         FROM app_user
        WHERE (lower(email) = lower($1) OR phone = $1) AND deleted_at IS NULL`,
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
      phone_verified_at: string | null;
      revoked_at: string | null;
      expired: boolean;
      auth_level: AuthLevel;
      step_up_at: Date | null;
      totp_confirmed_at: Date | null;
      avatar_storage_key: string | null;
    }>(
      `SELECT s.id AS session_id, u.id AS user_id, u.display_name, u.status,
              u.email_verified_at, u.phone_verified_at, s.revoked_at, (s.expires_at <= now()) AS expired,
              s.auth_level, s.step_up_at, t.confirmed_at AS totp_confirmed_at, u.avatar_storage_key
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
      phoneVerified: row.phone_verified_at !== null,
      authLevel: row.auth_level,
      withheldRoles: withheldRoles(granted, row.auth_level),
      stepUpAt: row.step_up_at,
      twoFactorEnrolled: row.totp_confirmed_at !== null,
      avatarStorageKey: row.avatar_storage_key,
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

  async requestPasswordReset(identifier: string): Promise<string | null> {
    const { rows } = await this.db.query<{ id: string }>(
      `SELECT id FROM app_user WHERE (lower(email) = lower($1) OR phone = $1) AND deleted_at IS NULL`,
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
  /**
   * Prove the person at the keyboard knows the account password.
   *
   * The same reasoning `changePassword` applies, extracted because enrolling a
   * second factor needs it just as badly and did not have it. A session token
   * is a weaker thing to hold than a password — it is what a stolen laptop, a
   * borrowed browser or an XSS bug yields — and any operation that turns a
   * session into DURABLE control of the account has to ask for the stronger
   * one.
   *
   * The error is deliberately the same wording `changePassword` uses. Whether
   * an account has a password at all (an invited staff member may not yet) is
   * not something a prober should learn from the difference.
   */
  async assertPassword(userId: string, password: string): Promise<void> {
    const { rows } = await this.db.query<{ password_hash: string | null }>(
      `SELECT password_hash FROM app_user WHERE id=$1 AND deleted_at IS NULL`,
      [userId],
    );
    const stored = rows[0]?.password_hash;
    if (!stored || !(await verifyPassword(stored, password))) {
      throw new DomainError('UNAUTHENTICATED', 'Текущий пароль указан неверно');
    }
  }

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

  /**
   * The other half of `grantRole`. Kept as a hard delete on `user_role`
   * rather than a soft-revoke flag: a role is either held or it is not, and
   * `permissionsFor()` reads this table directly — a "revoked but still a
   * row" state would need every reader to know to filter it out.
   *
   * Refuses to take away someone's own TENANT role via this path — that is
   * what account closure is for, and doing it through role revocation would
   * leave the account in a state the rest of the product does not expect.
   */
  async revokeRole(userId: string, role: Role, revokedBy: string, reason: string): Promise<void> {
    if (!reason?.trim()) throw invalid('Укажите причину отзыва роли');
    if (role === 'TENANT') throw invalid('Роль TENANT нельзя отозвать — для этого есть закрытие аккаунта');
    await this.db.transaction(async (tx) => {
      const { rowCount } = await tx.query(`DELETE FROM user_role WHERE user_id=$1 AND role=$2`, [userId, role]);
      if (rowCount === 0) return;
      await writeAudit(tx, {
        actorUserId: revokedBy,
        actorRole: 'ADMIN',
        action: 'auth.revoke_role',
        targetType: 'user',
        targetId: userId,
        changes: { role: { from: role, to: null } },
        reason,
        source: 'admin',
      });
    });
  }

  /** Every role currently held, for the admin user-detail screen. */
  async listRoles(userId: string): Promise<Role[]> {
    const { rows } = await this.db.query<{ role: Role }>(`SELECT role FROM user_role WHERE user_id=$1 ORDER BY role`, [
      userId,
    ]);
    return rows.map((r) => r.role);
  }

  /**
   * Staff-initiated account creation (support setting someone up with an
   * operator role, an admin onboarding another admin). Distinct from
   * `register`: there is no password from the caller — one is generated and
   * never handed back, so the new account is unusable until its owner sets
   * their own via the password-reset flow, delivered to the address the
   * admin typed. If that email is wrong, the account simply sits unusable
   * rather than being usable by whoever fat-fingered it.
   */
  async createStaffManagedAccount(
    input: { email?: string; phone?: string; displayName: string; roles: readonly Role[] },
    createdBy: string,
    reason: string,
  ): Promise<{ userId: string; resetToken: string }> {
    if (!reason?.trim()) throw invalid('Укажите причину создания учётной записи');
    if (!input.email && !input.phone) throw invalid('Укажите email или телефон');
    if (input.displayName.trim().length < 2) throw invalid('Укажите имя');

    const userId = uuidv7();
    // Unusable password: a random hash nobody can ever type. The account
    // becomes usable only once its owner sets a real password via the reset
    // token below — there is never a moment where an admin-known password
    // could authenticate as this user.
    const passwordHash = await hashPassword(generateToken());

    return this.db.transaction(async (tx) => {
      try {
        await tx.query(
          `INSERT INTO app_user (id, email, phone, password_hash, display_name, account_kind, locale)
           VALUES ($1,$2,$3,$4,$5,'PRIVATE','ru')`,
          [userId, input.email?.trim() ?? null, input.phone?.trim() ?? null, passwordHash, input.displayName.trim()],
        );
      } catch (e) {
        if (hasErrorCode(e, PG_ERROR.UNIQUE_VIOLATION)) {
          throw new DomainError('ALREADY_EXISTS', 'Учётная запись с этими данными уже существует');
        }
        throw e;
      }

      await tx.query(`INSERT INTO user_role (user_id, role) VALUES ($1,'TENANT')`, [userId]);
      for (const role of input.roles) {
        if (role === 'TENANT') continue;
        await tx.query(`INSERT INTO user_role (user_id, role, granted_by) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`, [
          userId,
          role,
          createdBy,
        ]);
      }

      const resetToken = await this.issueAuthToken(tx, userId, 'PASSWORD_RESET', STAFF_ACCOUNT_SETUP_TTL_HOURS);

      await writeAudit(tx, {
        actorUserId: createdBy,
        actorRole: 'ADMIN',
        action: 'auth.create_staff_account',
        targetType: 'user',
        targetId: userId,
        changes: { roles: { from: null, to: input.roles } },
        reason,
        source: 'admin',
      });

      return { userId, resetToken };
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
    purpose: 'PASSWORD_RESET' | 'PHONE_OTP' | 'TELEGRAM_LINK',
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
