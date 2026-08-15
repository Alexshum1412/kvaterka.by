-- 0005_trust_and_money.sql
-- Reviews, service fees, the landlord ledger, verification, disputes,
-- fraud signals and notifications.

/* ==================================================================== *
 * Reviews (spec §28–§30)
 * ==================================================================== */

CREATE TABLE review (
  id           uuid PRIMARY KEY,
  booking_id   uuid NOT NULL REFERENCES booking(id) ON DELETE RESTRICT,
  author_id    uuid NOT NULL REFERENCES app_user(id) ON DELETE RESTRICT,
  subject_id   uuid NOT NULL REFERENCES app_user(id) ON DELETE RESTRICT,
  property_id  uuid REFERENCES property(id) ON DELETE SET NULL,
  author_role  text NOT NULL CHECK (author_role IN ('TENANT', 'LANDLORD')),

  overall      smallint NOT NULL CHECK (overall BETWEEN 1 AND 5),

  -- Tenant-side dimensions.
  cleanliness      smallint CHECK (cleanliness BETWEEN 1 AND 5),
  accuracy         smallint CHECK (accuracy BETWEEN 1 AND 5),
  check_in_rating  smallint CHECK (check_in_rating BETWEEN 1 AND 5),
  location_rating  smallint CHECK (location_rating BETWEEN 1 AND 5),
  value_rating     smallint CHECK (value_rating BETWEEN 1 AND 5),
  rules_clarity    smallint CHECK (rules_clarity BETWEEN 1 AND 5),

  -- Landlord-side dimensions.
  rule_compliance  smallint CHECK (rule_compliance BETWEEN 1 AND 5),
  property_condition smallint CHECK (property_condition BETWEEN 1 AND 5),
  timeliness       smallint CHECK (timeliness BETWEEN 1 AND 5),

  -- Shared.
  communication    smallint CHECK (communication BETWEEN 1 AND 5),

  body             text NOT NULL DEFAULT '',
  what_was_good    text,
  what_to_improve  text,
  would_rent_again boolean,

  -- Tenant-confirmed facts, e.g. {"wifi": true, "workspace": false}. Feeds the
  -- "guests confirmed" layer that distinguishes claims from evidence (spec §35).
  confirmed_facts  jsonb NOT NULL DEFAULT '{}',

  status       text NOT NULL DEFAULT 'PENDING'
                 CHECK (status IN ('PENDING', 'PUBLISHED', 'HIDDEN', 'REMOVED')),
  published_at timestamptz,
  edited_at    timestamptz,
  moderation_note text,
  created_at   timestamptz NOT NULL DEFAULT now(),

  -- One review per side per rental (spec §30). Enforced by the database, so a
  -- duplicate submit or a retried request cannot create a second one.
  CONSTRAINT review_one_per_side UNIQUE (booking_id, author_role),
  CONSTRAINT review_author_is_not_subject CHECK (author_id <> subject_id),
  CONSTRAINT review_published_has_timestamp CHECK (
    (status = 'PUBLISHED') = (published_at IS NOT NULL)),
  -- Each role must fill in its own dimension set and nothing from the other's.
  CONSTRAINT review_tenant_dimensions CHECK (
    author_role <> 'TENANT' OR (
      cleanliness IS NOT NULL AND accuracy IS NOT NULL AND communication IS NOT NULL
      AND rule_compliance IS NULL AND property_condition IS NULL AND timeliness IS NULL)),
  CONSTRAINT review_landlord_dimensions CHECK (
    author_role <> 'LANDLORD' OR (
      rule_compliance IS NOT NULL AND property_condition IS NOT NULL AND communication IS NOT NULL
      AND cleanliness IS NULL AND accuracy IS NULL AND check_in_rating IS NULL
      AND location_rating IS NULL AND value_rating IS NULL AND rules_clarity IS NULL))
);

CREATE INDEX review_subject_idx  ON review (subject_id, created_at DESC) WHERE status = 'PUBLISHED';
CREATE INDEX review_property_idx ON review (property_id, created_at DESC) WHERE status = 'PUBLISHED';
CREATE INDEX review_booking_idx  ON review (booking_id);
CREATE INDEX review_pending_idx  ON review (created_at) WHERE status = 'PENDING';

/* ==================================================================== *
 * Service fee — exactly one per completed booking
 * ==================================================================== */

CREATE TABLE service_fee (
  id             uuid PRIMARY KEY,
  -- THE duplicate-fee guard. A retried completion, a double-clicked admin
  -- button and a re-run job all collide here instead of charging twice.
  booking_id     uuid NOT NULL UNIQUE REFERENCES booking(id) ON DELETE RESTRICT,
  landlord_id    uuid NOT NULL REFERENCES app_user(id) ON DELETE RESTRICT,

  currency       char(3) NOT NULL DEFAULT 'BYN' CHECK (currency = 'BYN'),
  -- All three inputs are stored so the fee can be recomputed and checked years
  -- later: fee_minor MUST equal round_half_away(base_minor * bps / 10000).
  base_minor     bigint NOT NULL CHECK (base_minor >= 0),
  bps            integer NOT NULL CHECK (bps BETWEEN 0 AND 10000),
  fee_minor      bigint NOT NULL CHECK (fee_minor >= 0),

  status         text NOT NULL DEFAULT 'PAYABLE'
                   CHECK (status IN ('PAYABLE', 'PAID', 'WAIVED', 'WRITTEN_OFF')),
  due_at         timestamptz,
  accrued_at     timestamptz NOT NULL DEFAULT now(),
  settled_at     timestamptz,
  waived_by      uuid REFERENCES app_user(id),
  waived_reason  text,

  CONSTRAINT service_fee_waived_needs_reason CHECK (
    status <> 'WAIVED' OR (waived_by IS NOT NULL AND waived_reason IS NOT NULL))
);

CREATE INDEX service_fee_landlord_idx ON service_fee (landlord_id, accrued_at DESC);
CREATE INDEX service_fee_outstanding_idx ON service_fee (due_at) WHERE status = 'PAYABLE';

/* ==================================================================== *
 * Landlord ledger — append-only, the authoritative balance
 * ==================================================================== */

CREATE TABLE ledger_entry (
  id            bigserial PRIMARY KEY,
  landlord_id   uuid NOT NULL REFERENCES app_user(id) ON DELETE RESTRICT,
  entry_type    text NOT NULL CHECK (entry_type IN (
                  'FEE_ACCRUED',      -- negative: landlord now owes the platform
                  'PAYMENT_RECEIVED', -- positive: debt reduced
                  'FEE_WAIVED',       -- positive: platform forgave the fee
                  'FEE_WRITTEN_OFF',  -- positive: uncollectable
                  'ADJUSTMENT')),     -- signed: correction, always with a reason
  currency      char(3) NOT NULL DEFAULT 'BYN' CHECK (currency = 'BYN'),
  -- Signed. Balance = SUM(amount_minor); a negative balance is landlord debt.
  amount_minor  bigint NOT NULL,
  service_fee_id uuid REFERENCES service_fee(id) ON DELETE RESTRICT,
  booking_id    uuid REFERENCES booking(id) ON DELETE RESTRICT,
  reason        text,
  created_by    uuid REFERENCES app_user(id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT ledger_fee_accrual_is_negative CHECK (
    entry_type <> 'FEE_ACCRUED' OR amount_minor < 0),
  CONSTRAINT ledger_credit_is_positive CHECK (
    entry_type NOT IN ('PAYMENT_RECEIVED', 'FEE_WAIVED', 'FEE_WRITTEN_OFF') OR amount_minor > 0),
  CONSTRAINT ledger_adjustment_needs_reason CHECK (
    entry_type <> 'ADJUSTMENT' OR (reason IS NOT NULL AND created_by IS NOT NULL))
);

CREATE INDEX ledger_entry_landlord_idx ON ledger_entry (landlord_id, created_at DESC);
CREATE INDEX ledger_entry_fee_idx ON ledger_entry (service_fee_id) WHERE service_fee_id IS NOT NULL;
-- One accrual entry per fee: the ledger cannot be double-charged either.
CREATE UNIQUE INDEX ledger_entry_one_accrual_per_fee_idx ON ledger_entry (service_fee_id)
  WHERE entry_type = 'FEE_ACCRUED';

-- Money records are never edited or deleted. Corrections are new rows.
CREATE TRIGGER ledger_entry_append_only BEFORE UPDATE OR DELETE ON ledger_entry
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

/* ==================================================================== *
 * Verification (spec §15–§17)
 * ==================================================================== */

CREATE TABLE verification_request (
  id           uuid PRIMARY KEY,
  user_id      uuid NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  property_id  uuid REFERENCES property(id) ON DELETE CASCADE,
  kind         text NOT NULL CHECK (kind IN ('IDENTITY', 'PROPERTY_OWNERSHIP')),
  target_level smallint CHECK (target_level BETWEEN 1 AND 2),
  status       text NOT NULL DEFAULT 'SUBMITTED'
                 CHECK (status IN ('SUBMITTED', 'IN_REVIEW', 'APPROVED', 'REJECTED', 'EXPIRED')),
  decided_by   uuid REFERENCES app_user(id),
  decided_at   timestamptz,
  decision_note text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT verification_property_kind CHECK (
    (kind = 'PROPERTY_OWNERSHIP') = (property_id IS NOT NULL))
);

CREATE TRIGGER verification_request_updated_at BEFORE UPDATE ON verification_request
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE INDEX verification_request_queue_idx ON verification_request (status, created_at)
  WHERE status IN ('SUBMITTED', 'IN_REVIEW');
CREATE INDEX verification_request_user_idx ON verification_request (user_id, created_at DESC);

/* Identity documents live in a separate private bucket (spec §54) and are
   referenced only by key. No column here ever holds document contents. */
CREATE TABLE verification_document (
  id            uuid PRIMARY KEY,
  request_id    uuid NOT NULL REFERENCES verification_request(id) ON DELETE CASCADE,
  doc_type      text NOT NULL CHECK (doc_type IN (
                  'PASSPORT', 'ID_CARD', 'SELFIE', 'OWNERSHIP_CERTIFICATE',
                  'POWER_OF_ATTORNEY', 'UTILITY_BILL', 'OTHER')),
  storage_key   text NOT NULL,          -- private bucket, server-side encrypted
  content_hash  bytea,
  uploaded_at   timestamptz NOT NULL DEFAULT now(),
  -- Retention: documents are purged after the decision plus the statutory
  -- window. Enforced by a scheduled job; the date is stored per row so the
  -- policy is auditable rather than implicit.
  purge_after   timestamptz,
  purged_at     timestamptz
);

CREATE INDEX verification_document_request_idx ON verification_document (request_id);
CREATE INDEX verification_document_purge_idx ON verification_document (purge_after)
  WHERE purged_at IS NULL;

/* Every single read of an identity document is logged. Support staff do not
   have the VERIFIER role and therefore cannot reach these at all. */
CREATE TABLE document_access_log (
  id          bigserial PRIMARY KEY,
  document_id uuid NOT NULL REFERENCES verification_document(id) ON DELETE CASCADE,
  actor_user_id uuid NOT NULL REFERENCES app_user(id) ON DELETE RESTRICT,
  actor_role  text NOT NULL,
  accessed_at timestamptz NOT NULL DEFAULT now(),
  purpose     text NOT NULL,
  ip_hash     bytea
);

CREATE INDEX document_access_log_doc_idx ON document_access_log (document_id, accessed_at DESC);
CREATE INDEX document_access_log_actor_idx ON document_access_log (actor_user_id, accessed_at DESC);
CREATE TRIGGER document_access_log_append_only BEFORE UPDATE OR DELETE ON document_access_log
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

/* ==================================================================== *
 * Disputes (spec §38)
 * ==================================================================== */

CREATE TABLE dispute_case (
  id           uuid PRIMARY KEY,
  reference    text NOT NULL UNIQUE,
  booking_id   uuid REFERENCES booking(id) ON DELETE RESTRICT,
  opened_by    uuid NOT NULL REFERENCES app_user(id) ON DELETE RESTRICT,
  against_user_id uuid REFERENCES app_user(id) ON DELETE RESTRICT,
  category     text NOT NULL CHECK (category IN (
                 'LISTING_MISMATCH', 'ACCESS_PROBLEM', 'CLEANLINESS', 'PROPERTY_DAMAGE',
                 'PAYMENT_DISAGREEMENT', 'COMMUNICATION', 'SUSPECTED_FRAUD',
                 'CANCELLATION', 'NO_SHOW', 'OTHER')),
  status       text NOT NULL DEFAULT 'OPEN' CHECK (status IN (
                 'OPEN', 'UNDER_REVIEW', 'WAITING_FOR_PARTY', 'RESOLVED', 'CLOSED', 'ESCALATED')),
  summary      text NOT NULL,
  assigned_to  uuid REFERENCES app_user(id) ON DELETE SET NULL,
  resolution   text,
  resolved_at  timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TRIGGER dispute_case_updated_at BEFORE UPDATE ON dispute_case
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE INDEX dispute_case_status_idx ON dispute_case (status, created_at);
CREATE INDEX dispute_case_booking_idx ON dispute_case (booking_id);

CREATE TABLE case_event (
  id          bigserial PRIMARY KEY,
  case_id     uuid NOT NULL REFERENCES dispute_case(id) ON DELETE CASCADE,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  actor_user_id uuid REFERENCES app_user(id) ON DELETE SET NULL,
  actor_role  text,
  event_type  text NOT NULL,
  note        text,
  attachment_key text,
  payload     jsonb
);

CREATE INDEX case_event_case_idx ON case_event (case_id, occurred_at);
CREATE TRIGGER case_event_append_only BEFORE UPDATE OR DELETE ON case_event
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

/* ==================================================================== *
 * Fraud signals (spec §47) — signals, never a single opaque verdict
 * ==================================================================== */

CREATE TABLE fraud_signal (
  id           bigserial PRIMARY KEY,
  user_id      uuid REFERENCES app_user(id) ON DELETE CASCADE,
  property_id  uuid REFERENCES property(id) ON DELETE CASCADE,
  booking_id   uuid REFERENCES booking(id) ON DELETE CASCADE,
  kind         text NOT NULL,
  severity     smallint NOT NULL DEFAULT 1 CHECK (severity BETWEEN 1 AND 5),
  detail       jsonb,
  detected_at  timestamptz NOT NULL DEFAULT now(),
  reviewed_by  uuid REFERENCES app_user(id) ON DELETE SET NULL,
  reviewed_at  timestamptz,
  review_outcome text CHECK (review_outcome IN ('CONFIRMED', 'DISMISSED', 'PENDING'))
);

CREATE INDEX fraud_signal_user_idx ON fraud_signal (user_id, detected_at DESC);
CREATE INDEX fraud_signal_open_idx ON fraud_signal (detected_at DESC) WHERE reviewed_at IS NULL;

/* ==================================================================== *
 * Notifications & Telegram
 * ==================================================================== */

CREATE TABLE notification (
  id            uuid PRIMARY KEY,
  user_id       uuid NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  category      text NOT NULL,
  channel       text NOT NULL CHECK (channel IN ('IN_APP', 'EMAIL', 'TELEGRAM')),
  -- Deduplication key: the same domain event delivered twice by a retried job
  -- must not produce two messages (spec §55).
  dedupe_key    text NOT NULL,
  payload       jsonb NOT NULL DEFAULT '{}',
  status        text NOT NULL DEFAULT 'PENDING'
                  CHECK (status IN ('PENDING', 'SENT', 'FAILED', 'SUPPRESSED')),
  attempts      smallint NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  last_error    text,
  read_at       timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  sent_at       timestamptz
);

CREATE UNIQUE INDEX notification_dedupe_idx ON notification (user_id, channel, dedupe_key);
CREATE INDEX notification_inbox_idx ON notification (user_id, created_at DESC) WHERE channel = 'IN_APP';
CREATE INDEX notification_outbox_idx ON notification (status, created_at) WHERE status = 'PENDING';

CREATE TABLE notification_preference (
  user_id    uuid NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  category   text NOT NULL,
  channel    text NOT NULL CHECK (channel IN ('IN_APP', 'EMAIL', 'TELEGRAM')),
  enabled    boolean NOT NULL DEFAULT true,
  PRIMARY KEY (user_id, category, channel)
);

CREATE TABLE telegram_connection (
  user_id      uuid PRIMARY KEY REFERENCES app_user(id) ON DELETE CASCADE,
  telegram_chat_id bigint NOT NULL UNIQUE,
  telegram_username text,
  linked_at    timestamptz NOT NULL DEFAULT now(),
  unlinked_at  timestamptz
);

/* ==================================================================== *
 * Tenant-side conveniences
 * ==================================================================== */

CREATE TABLE favorite (
  user_id     uuid NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  property_id uuid NOT NULL REFERENCES property(id) ON DELETE CASCADE,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, property_id)
);

CREATE TABLE saved_search (
  id         uuid PRIMARY KEY,
  user_id    uuid NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  name       text NOT NULL,
  query      jsonb NOT NULL,
  notify     boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_run_at timestamptz
);

CREATE INDEX saved_search_user_idx ON saved_search (user_id);

CREATE TABLE report (
  id           uuid PRIMARY KEY,
  reporter_id  uuid NOT NULL REFERENCES app_user(id) ON DELETE RESTRICT,
  target_type  text NOT NULL CHECK (target_type IN ('PROPERTY', 'USER', 'MESSAGE', 'REVIEW')),
  target_id    text NOT NULL,
  category     text NOT NULL,
  detail       text,
  status       text NOT NULL DEFAULT 'OPEN'
                 CHECK (status IN ('OPEN', 'REVIEWING', 'ACTIONED', 'DISMISSED')),
  handled_by   uuid REFERENCES app_user(id) ON DELETE SET NULL,
  handled_at   timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX report_queue_idx ON report (status, created_at) WHERE status IN ('OPEN', 'REVIEWING');
CREATE INDEX report_target_idx ON report (target_type, target_id);

/* ==================================================================== *
 * Feature flags (spec §64) — rewards/lottery stays off until legal sign-off
 * ==================================================================== */

CREATE TABLE feature_flag (
  key         text PRIMARY KEY,
  enabled     boolean NOT NULL DEFAULT false,
  description text NOT NULL,
  -- Flags that must not be switched on without a documented legal decision.
  requires_legal_approval boolean NOT NULL DEFAULT false,
  updated_by  uuid REFERENCES app_user(id) ON DELETE SET NULL,
  updated_at  timestamptz NOT NULL DEFAULT now()
);
