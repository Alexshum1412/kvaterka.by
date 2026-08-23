-- 0001_foundation.sql
-- Extensions, shared helpers, identity, sessions, audit.
--
-- Conventions used throughout the schema:
--   * money is ALWAYS bigint minor units (kopecks) + an explicit currency column;
--     there is no numeric/float money anywhere (see src/server/domain/money.ts).
--   * timestamps are timestamptz, always stored UTC.
--   * user-facing enumerations are text + CHECK, not native enum types, so that
--     adding a value is an ordinary migration rather than a lock-heavy ALTER TYPE.
--   * every table that a human can change carries created_at/updated_at.

/* NO EXTENSIONS. This schema deploys onto shared hosting where CREATE EXTENSION
   is refused — it needs a superuser, and the account is not one. Five were once
   used here and each has been replaced by something core PostgreSQL already had:

     btree_gist     -> property_occupancy, a primary key on (property_id, night)
     pg_trgm        -> to_tsvector/plainto_tsquery, indexed with core GIN
     citext         -> a unique index on lower(email)
     cube           -> gone with earthdistance
     earthdistance  -> a latitude/longitude rectangle, then plain-SQL haversine

   The result runs unchanged on PostgreSQL 10, 16 and 18. Re-adding an extension
   here is a deployment regression, and tests/pg10-compatibility.test.ts fails the
   build if anyone does. */

/* ------------------------------------------------------------------ *
 * The database must be able to lower-case Cyrillic.
 *
 * This is not a formality. Under LC_CTYPE=C, lower('МИНСК') returns 'МИНСК'
 * unchanged: city matching stops working, and the Russian text-search
 * configuration stops folding case, so a tenant who types 'минск' finds nothing
 * while one who types 'Минск' finds everything. Nothing else fails, no error is
 * raised anywhere, and the search box simply appears to be broken for most of
 * the people using it.
 *
 * Encoding must be UTF8 and LC_CTYPE must be a real locale — ru_RU.UTF-8,
 * be_BY.UTF-8, en_US.UTF-8 and C.UTF-8 all fold Cyrillic correctly; plain C and
 * POSIX do not. A misconfigured database now refuses to migrate instead of
 * quietly serving a broken search.
 * ------------------------------------------------------------------ */
DO $$
BEGIN
  IF current_setting('server_encoding') <> 'UTF8' THEN
    RAISE EXCEPTION
      'Database encoding is %, expected UTF8. Recreate the database with ENCODING ''UTF8''.',
      current_setting('server_encoding')
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  IF lower('МИНСК') <> 'минск' THEN
    RAISE EXCEPTION
      'This database cannot lower-case Cyrillic (LC_CTYPE=%). Russian search and city '
      'matching would silently return nothing. Recreate it with a UTF-8 locale, '
      'for example: CREATE DATABASE kvaterka ENCODING ''UTF8'' LC_COLLATE ''ru_RU.UTF-8'' '
      'LC_CTYPE ''ru_RU.UTF-8'' TEMPLATE template0;',
      current_setting('lc_ctype')
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_ts_config WHERE cfgname = 'russian') THEN
    RAISE EXCEPTION 'The "russian" text-search configuration is missing; listing search cannot work.'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
END $$;

-- Keeps updated_at honest without trusting application code.
CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END $$;

-- Attached to append-only tables (ledger, audit, booking events).
CREATE OR REPLACE FUNCTION forbid_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Table % is append-only; % is not permitted', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'restrict_violation';
END $$;

/* ==================================================================== *
 * Identity
 * ==================================================================== */

CREATE TABLE app_user (
  id                uuid PRIMARY KEY,
  -- Uniqueness is case-insensitive and lives in app_user_email_lower_idx below,
  -- not in a UNIQUE here. Two accounts differing only in capitalisation are an
  -- account-takeover vector, not a cosmetic duplicate.
  email             text,
  phone             text UNIQUE,
  password_hash     text,                       -- argon2id; NULL for not-yet-set
  display_name      text NOT NULL,
  -- A company must never masquerade as a private person (spec §4.2).
  account_kind      text NOT NULL DEFAULT 'PRIVATE'
                      CHECK (account_kind IN ('PRIVATE', 'COMPANY')),
  company_name      text,
  company_reg_no    text,
  locale            text NOT NULL DEFAULT 'ru' CHECK (locale IN ('ru', 'be', 'en')),

  email_verified_at timestamptz,
  phone_verified_at timestamptz,

  -- Identity assurance, separate from property verification (spec §15/§16).
  verification_level smallint NOT NULL DEFAULT 0 CHECK (verification_level BETWEEN 0 AND 2),

  status            text NOT NULL DEFAULT 'ACTIVE'
                      CHECK (status IN ('ACTIVE', 'RESTRICTED', 'SUSPENDED', 'DELETED')),
  suspended_reason  text,

  -- Denormalised trust surface, recomputed by the trust service. Never authoritative.
  trust_score       smallint CHECK (trust_score BETWEEN 0 AND 100),
  completed_rentals_as_tenant   integer NOT NULL DEFAULT 0 CHECK (completed_rentals_as_tenant >= 0),
  completed_rentals_as_landlord integer NOT NULL DEFAULT 0 CHECK (completed_rentals_as_landlord >= 0),

  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  deleted_at        timestamptz,

  -- At least one contact channel must exist, or the account cannot be reached.
  CONSTRAINT app_user_has_contact CHECK (email IS NOT NULL OR phone IS NOT NULL),
  CONSTRAINT app_user_company_named CHECK (
    account_kind <> 'COMPANY' OR (company_name IS NOT NULL AND length(btrim(company_name)) > 0)
  )
);

CREATE TRIGGER app_user_updated_at BEFORE UPDATE ON app_user
  FOR EACH ROW EXECUTE PROCEDURE set_updated_at();

CREATE INDEX app_user_active_idx ON app_user (status) WHERE deleted_at IS NULL;

/* What `email citext UNIQUE` used to guarantee: Test@Email.com and
   test@email.com cannot both exist. The type is gone — it needs an extension —
   but the guarantee is not, and it is a security property rather than a tidiness
   one. Every lookup compares lower(email) so it reads this index; see
   src/server/auth/auth-service.ts.

   NOT PARTIAL, AND THAT TOOK A TEST TO LEARN. The obvious form is
   `WHERE email IS NOT NULL`, since an account may be reachable by phone alone
   (app_user_has_contact above). It is also useless: to use a partial index the
   planner must prove the query implies the predicate, and PostgreSQL 10 does
   not derive `email IS NOT NULL` from `lower(email) = $1`. The login lookup
   fell back to a sequential scan of every account, correctly and silently.

   The predicate is unnecessary anyway. lower(NULL) is NULL, and a unique index
   treats NULLs as distinct, so any number of accounts may have no email at all —
   which is asserted in tests/pg10-compatibility.test.ts rather than assumed. */
CREATE UNIQUE INDEX app_user_email_lower_idx ON app_user (lower(email));

/* Roles are separate rows rather than a column: a user can be tenant AND
   landlord at once, and staff roles must be grantable independently. */
CREATE TABLE user_role (
  user_id    uuid NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  role       text NOT NULL CHECK (role IN (
                'TENANT', 'LANDLORD',
                'SUPPORT',        -- read-only + case handling, no identity documents
                'MODERATOR',      -- content moderation, listing decisions
                'VERIFIER',       -- may open identity documents
                'FINANCE',        -- fee/debt operations
                'ADMIN'           -- full administrative access
             )),
  granted_by uuid REFERENCES app_user(id),
  granted_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, role)
);

CREATE INDEX user_role_role_idx ON user_role (role);

/* ==================================================================== *
 * Sessions
 * ==================================================================== */

CREATE TABLE user_session (
  id             uuid PRIMARY KEY,
  user_id        uuid NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  -- Only a SHA-256 of the token is stored: a database leak must not hand the
  -- attacker live sessions.
  token_hash     bytea NOT NULL UNIQUE,
  -- Rotation chain, so a stolen-and-replayed old token is detectable.
  previous_id    uuid REFERENCES user_session(id) ON DELETE SET NULL,
  user_agent     text,
  ip_hash        bytea,          -- hashed, never the raw address (privacy §49)
  created_at     timestamptz NOT NULL DEFAULT now(),
  last_seen_at   timestamptz NOT NULL DEFAULT now(),
  expires_at     timestamptz NOT NULL,
  revoked_at     timestamptz,
  revoked_reason text,
  CONSTRAINT user_session_expiry_after_creation CHECK (expires_at > created_at)
);

CREATE INDEX user_session_user_idx ON user_session (user_id) WHERE revoked_at IS NULL;
CREATE INDEX user_session_expiry_idx ON user_session (expires_at) WHERE revoked_at IS NULL;

/* Short-lived, single-use tokens: email verification, password reset, phone OTP. */
CREATE TABLE auth_token (
  id           uuid PRIMARY KEY,
  user_id      uuid NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  purpose      text NOT NULL CHECK (purpose IN (
                  'EMAIL_VERIFICATION', 'PASSWORD_RESET', 'PHONE_OTP', 'TELEGRAM_LINK')),
  token_hash   bytea NOT NULL UNIQUE,
  expires_at   timestamptz NOT NULL,
  consumed_at  timestamptz,
  attempts     smallint NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX auth_token_user_purpose_idx ON auth_token (user_id, purpose) WHERE consumed_at IS NULL;

/* ==================================================================== *
 * Audit log (append-only)
 * ==================================================================== */

CREATE TABLE audit_log (
  id             bigserial PRIMARY KEY,
  occurred_at    timestamptz NOT NULL DEFAULT now(),
  -- NULL actor = system/scheduled job.
  actor_user_id  uuid REFERENCES app_user(id) ON DELETE SET NULL,
  actor_role     text,
  action         text NOT NULL,
  target_type    text NOT NULL,
  target_id      text NOT NULL,
  -- Diff, not full snapshots: keeps the log readable and avoids duplicating
  -- personal data into a table with a long retention period.
  changes        jsonb,
  reason         text,
  correlation_id uuid,
  source         text NOT NULL DEFAULT 'web' CHECK (source IN ('web', 'api', 'job', 'admin', 'system')),
  ip_hash        bytea
);

CREATE INDEX audit_log_target_idx ON audit_log (target_type, target_id, occurred_at DESC);
CREATE INDEX audit_log_actor_idx ON audit_log (actor_user_id, occurred_at DESC);
CREATE INDEX audit_log_correlation_idx ON audit_log (correlation_id) WHERE correlation_id IS NOT NULL;

-- Audit rows may only ever be inserted. Nothing in the application, and no
-- support operator, can rewrite history through ordinary SQL.
CREATE TRIGGER audit_log_append_only BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE PROCEDURE forbid_mutation();
