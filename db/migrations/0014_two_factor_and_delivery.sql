/* ==================================================================== *
 * Staff two-factor authentication, and the notification outbox that
 * nothing was draining.
 *
 * TWO INDEPENDENT PROBLEMS, ONE MIGRATION, because both are the same
 * class of defect: a mechanism written, documented as working, and never
 * connected to anything.
 *
 *   `requiresTwoFactor()` has existed in rbac.ts since the auth slice and
 *   is called from nowhere. Staff reach identity documents, dispute files
 *   and the ledger on a password alone.
 *
 *   `claimPending`/`markSent`/`markFailed` have existed in
 *   NotificationService since the notification slice and are called from
 *   nowhere. Every notification the product has ever enqueued is still
 *   PENDING.
 * ==================================================================== */

/* -- 1. What a session has actually proved ---------------------------- *
 *
 * The enforcement mechanism is NOT a check added to a route. Server
 * components in the staff console pages reach privileged services directly —
 * `moderation/page.tsx` bypasses even the service layer and runs its own
 * SQL — so a check in the router would protect one endpoint and leave the
 * consoles open. Both paths do share one thing: they build their caller
 * from `AuthService.resolveSession`, and they authorise with `can(roles, …)`.
 *
 * So the ROLES are withheld. A session that has not satisfied its second
 * factor is handed a role array with the staff grants removed, and every
 * `can()` in the codebase answers false without knowing 2FA exists. There
 * is no call site that can forget the check, because there is no check.
 *
 * DEFAULT 'PASSWORD' is the fail-closed direction: every session that
 * exists when this migration runs — including any staff session open right
 * now — immediately loses its staff roles until it passes a challenge.
 */
ALTER TABLE user_session
  ADD COLUMN auth_level text NOT NULL DEFAULT 'PASSWORD'
    CHECK (auth_level IN ('PASSWORD', 'TWO_FACTOR')),
  /* When a second factor was last confirmed for a sensitive action. Distinct
     from auth_level: passing a challenge at login is not standing permission
     to read passports an hour later. */
  ADD COLUMN step_up_at timestamptz;

CREATE INDEX user_session_auth_level_idx ON user_session (user_id, auth_level)
  WHERE revoked_at IS NULL;

/* -- 2. The authenticator ---------------------------------------------- *
 *
 * `secret_base32` is stored in plaintext, and that is a real limitation
 * rather than an oversight. TOTP verification requires the secret, so it
 * cannot be hashed like a password; protecting it properly needs an
 * encryption-at-rest layer with a key held outside the database, and no
 * such layer exists in this project yet (nothing encrypts any column
 * today). What this buys today is a second factor against a stolen or
 * guessed PASSWORD; it does not defend against an attacker who already has
 * the database. That is written down in DEC-054 rather than implied.
 *
 * `last_used_step` is the replay guard. A TOTP code is valid for its whole
 * 30-second window, so verifying correctness alone lets the same code be
 * used twice — anyone reading it over a shoulder has up to a minute. The
 * matched step is recorded and anything at or below it is refused, which
 * makes every code single-use.
 */
CREATE TABLE user_totp (
  user_id         uuid PRIMARY KEY REFERENCES app_user(id) ON DELETE CASCADE,
  secret_base32   text NOT NULL,
  confirmed_at    timestamptz,
  last_used_step  bigint,
  /* Cleared only by a successful challenge, never by waiting — otherwise an
     attacker sits out each lockout and starts fresh. */
  failed_attempts integer NOT NULL DEFAULT 0 CHECK (failed_attempts >= 0),
  last_failure_at timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TRIGGER user_totp_updated_at BEFORE UPDATE ON user_totp
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

/* -- 3. Recovery codes -------------------------------------------------- *
 *
 * A dedicated table rather than `auth_token` with a new purpose, which was
 * the tempting reuse. `auth_token.expires_at` is NOT NULL and the retention
 * sweep deletes rows past it (`sweepExpiredCredentials`), so a recovery
 * code — which must not expire — would need a sentinel far-future date and
 * would couple account recovery to the credential sweep. A table whose
 * retention model IS expiry is the wrong home for a credential that has none.
 *
 * Hashed with SHA-256 rather than argon2. These are 40 bits of machine-
 * generated randomness, not a human-chosen password, so there is no
 * dictionary to slow down; the lockout counter they share with TOTP is what
 * makes guessing hopeless. Argon2 here would cost 100ms per verification to
 * defend against an attack that the shape of the secret already prevents.
 */
CREATE TABLE two_factor_recovery_code (
  id         uuid PRIMARY KEY,
  user_id    uuid NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  code_hash  bytea NOT NULL UNIQUE,
  used_at    timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX two_factor_recovery_unused_idx ON two_factor_recovery_code (user_id)
  WHERE used_at IS NULL;

/* -- 4. The outbox ------------------------------------------------------ *
 *
 * Two defects in the existing code, both of which this schema fixes.
 *
 * `claimPending` claims nothing. It is a bare SELECT with no lock and no
 * status change, so two workers running at once would both read the same
 * rows and both send them. SENDING plus `claimed_at` turns it into a real
 * claim: a row is taken by exactly one worker, and a worker that dies
 * leaves a row that can be identified and reclaimed rather than one lost
 * for ever.
 *
 * `markFailed` puts a row straight back to PENDING, so the very next run
 * re-sends it immediately. Against a provider outage that is a retry storm
 * — the same rows hammering a dead endpoint as fast as cron allows.
 * `next_attempt_at` is the backoff, and the outbox index orders by it.
 */
ALTER TABLE notification
  ADD COLUMN next_attempt_at timestamptz,
  ADD COLUMN claimed_at      timestamptz;

ALTER TABLE notification DROP CONSTRAINT notification_status_check;
ALTER TABLE notification ADD CONSTRAINT notification_status_check
  CHECK (status IN ('PENDING', 'SENDING', 'SENT', 'FAILED', 'SUPPRESSED'));

/* A row is deliverable when its backoff has elapsed. NULLS FIRST so a
   never-attempted row goes before one already waiting on a retry. */
DROP INDEX notification_outbox_idx;
CREATE INDEX notification_outbox_idx
  ON notification (next_attempt_at NULLS FIRST, created_at)
  WHERE status = 'PENDING';

/* Rows a worker claimed and never settled. */
CREATE INDEX notification_claimed_idx ON notification (claimed_at)
  WHERE status = 'SENDING';

/* -- 5. Booking expiry needs no schema --------------------------------- *
 *
 * `booking.expires_at` and `booking_expiry_idx` have existed since 0003,
 * and the FSM already declares EXPIRE from INQUIRY, REQUESTED and
 * OFFER_PENDING with actor SYSTEM. What was missing was only the code that
 * calls it. Nothing is added here, deliberately — recorded so the next
 * reader does not go looking for the migration that made expiry work.
 */
