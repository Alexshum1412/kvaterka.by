-- 0017_pending_registration.sql
-- An account must not exist until its email is confirmed. Before this, POST
-- /auth/register inserted into app_user immediately and sent a verification
-- link nobody was required to follow — an unverified row was a real account
-- in every way that matters (could log in, could act) the instant it was
-- created, which is exactly the shape a spammer wants: throw addresses at
-- the form, keep whichever ones did not bounce.
--
-- So registration now writes here, not to app_user. A row here is not an
-- account and never logs in; it becomes app_user only when its code is
-- confirmed, at which point this row is deleted. Rejecting an expired or
-- wrong code costs an attacker nothing more than trying again — which is the
-- point: the cost of squatting an address moves from "free" to "prove you
-- read that inbox".
--
-- code_hash follows auth_token's own rule: never store the code itself,
-- only its hash, so a database read cannot hand out a live code.
CREATE TABLE pending_registration (
  id             uuid PRIMARY KEY,
  email          text,
  phone          text,
  password_hash  text NOT NULL,
  display_name   text NOT NULL,
  account_kind   text NOT NULL DEFAULT 'PRIVATE' CHECK (account_kind IN ('PRIVATE', 'COMPANY')),
  company_name   text,
  locale         text NOT NULL DEFAULT 'ru' CHECK (locale IN ('ru', 'be', 'en')),
  code_hash      bytea NOT NULL,
  attempts       integer NOT NULL DEFAULT 0,
  expires_at     timestamptz NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),

  CHECK (email IS NOT NULL OR phone IS NOT NULL)
);

-- One pending attempt per address. A second POST /auth/register for the same
-- email does not create a second row — the service deletes and replaces it,
-- so a lost or expired code is recovered by registering again rather than by
-- needing its own "resend" bookkeeping.
CREATE UNIQUE INDEX pending_registration_email_lower_idx ON pending_registration (lower(email)) WHERE email IS NOT NULL;
CREATE UNIQUE INDEX pending_registration_phone_idx ON pending_registration (phone) WHERE phone IS NOT NULL;

/* ==================================================================== *
 * Sign-in with Google links a real Google account to app_user directly.
 * One provider, one nullable column — an `oauth_identity` table earns its
 * keep only once a second provider exists, and none does.
 *
 * Nullable and unique: most rows have no Google identity, and the ones that
 * do must not collide — the same Google account signing in twice must reach
 * the same app_user, never mint a second one.
 * ==================================================================== */
ALTER TABLE app_user ADD COLUMN google_sub text;
CREATE UNIQUE INDEX app_user_google_sub_idx ON app_user (google_sub) WHERE google_sub IS NOT NULL;
