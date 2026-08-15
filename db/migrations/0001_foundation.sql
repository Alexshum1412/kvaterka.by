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

CREATE EXTENSION IF NOT EXISTS btree_gist;   -- EXCLUDE (uuid =, daterange &&)
CREATE EXTENSION IF NOT EXISTS pg_trgm;      -- typo-tolerant search
CREATE EXTENSION IF NOT EXISTS citext;       -- case-insensitive email
CREATE EXTENSION IF NOT EXISTS cube;         -- required by earthdistance
CREATE EXTENSION IF NOT EXISTS earthdistance;-- radius search without PostGIS

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
  email             citext UNIQUE,
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
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE INDEX app_user_active_idx ON app_user (status) WHERE deleted_at IS NULL;

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
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
