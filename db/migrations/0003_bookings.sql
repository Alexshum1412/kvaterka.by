-- 0003_bookings.sql
-- Bookings, negotiation offers, the append-only event log, check-in/check-out.
--
-- The single most important line in this file is booking_no_overlap: double
-- booking is prevented by a database EXCLUDE constraint, not by an application
-- "check then insert", which is a race by construction (DEC-010).

/* -------------------------------------------------------------------- *
 * Immutable snapshot of what the offer said when it was booked.
 * Disputes are unwinnable without this: a landlord can edit a property at any
 * time, and the tenant booked whatever it said at that moment.
 * -------------------------------------------------------------------- */

CREATE TABLE listing_snapshot (
  id          uuid PRIMARY KEY,
  property_id uuid NOT NULL REFERENCES property(id) ON DELETE RESTRICT,
  -- Full rendered content of the offer at capture time.
  content     jsonb NOT NULL,
  content_hash bytea NOT NULL,
  captured_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX listing_snapshot_property_idx ON listing_snapshot (property_id, captured_at DESC);
CREATE TRIGGER listing_snapshot_append_only BEFORE UPDATE OR DELETE ON listing_snapshot
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

/* -------------------------------------------------------------------- *
 * Booking
 * -------------------------------------------------------------------- */

CREATE TABLE booking (
  id            uuid PRIMARY KEY,
  reference     text NOT NULL UNIQUE,   -- short human code shown in chat/support
  property_id   uuid NOT NULL REFERENCES property(id) ON DELETE RESTRICT,
  tenant_id     uuid NOT NULL REFERENCES app_user(id) ON DELETE RESTRICT,
  -- Denormalised from property.owner_id so that authorisation checks and the
  -- landlord dashboard never need a join, and so that a later ownership
  -- transfer cannot silently re-point historical bookings at a new person.
  landlord_id   uuid NOT NULL REFERENCES app_user(id) ON DELETE RESTRICT,
  snapshot_id   uuid REFERENCES listing_snapshot(id) ON DELETE RESTRICT,

  status        text NOT NULL CHECK (status IN (
                  'INQUIRY', 'REQUESTED', 'OFFER_PENDING', 'DECLINED', 'WITHDRAWN', 'EXPIRED',
                  'CONFIRMED', 'CHECKED_IN', 'COMPLETION_PENDING', 'COMPLETED',
                  'NOT_TAKEN_PLACE', 'CANCELLED_BY_TENANT', 'CANCELLED_BY_LANDLORD', 'DISPUTED')),

  -- Day granularity with '[)' bounds: the checkout day is free for the next
  -- tenant, which is why adjacent bookings must not collide.
  stay_period   daterange NOT NULL,
  nights        integer NOT NULL GENERATED ALWAYS AS (
                  upper(stay_period) - lower(stay_period)) STORED,
  guests        smallint NOT NULL DEFAULT 1 CHECK (guests >= 1),

  booking_mode  text NOT NULL CHECK (booking_mode IN ('INSTANT', 'REQUEST', 'NEGOTIATED')),

  -- --- financial terms, frozen at CONFIRMED (spec §8) ----------------
  currency              char(3) NOT NULL DEFAULT 'BYN' CHECK (currency = 'BYN'),
  rent_minor            bigint NOT NULL CHECK (rent_minor >= 0),
  cleaning_fee_minor    bigint NOT NULL DEFAULT 0 CHECK (cleaning_fee_minor >= 0),
  utilities_fixed_minor bigint NOT NULL DEFAULT 0 CHECK (utilities_fixed_minor >= 0),
  utilities_mode        text NOT NULL DEFAULT 'INCLUDED'
                          CHECK (utilities_mode IN ('INCLUDED', 'FIXED_EXTRA', 'VARIABLE_METERED')),
  deposit_minor         bigint NOT NULL DEFAULT 0 CHECK (deposit_minor >= 0),
  -- What the tenant is told to expect, excluding metered utilities.
  total_expected_minor  bigint NOT NULL CHECK (total_expected_minor >= 0),
  -- The base the 5% is computed from. Stored, not derived at fee time, so the
  -- fee stays reproducible even if the pricing rules change later.
  fee_base_minor        bigint NOT NULL CHECK (fee_base_minor >= 0),
  service_fee_bps       integer NOT NULL DEFAULT 500
                          CHECK (service_fee_bps BETWEEN 0 AND 10000),
  terms_frozen_at       timestamptz,

  -- --- two-sided completion (spec §11) --------------------------------
  tenant_completion_answer   text CHECK (tenant_completion_answer IN ('TOOK_PLACE', 'DID_NOT_TAKE_PLACE')),
  landlord_completion_answer text CHECK (landlord_completion_answer IN ('TOOK_PLACE', 'DID_NOT_TAKE_PLACE')),
  tenant_completion_at       timestamptz,
  landlord_completion_at     timestamptz,
  completion_deadline_at     timestamptz,
  completion_reason          text,

  -- --- lifecycle timestamps -------------------------------------------
  requested_at  timestamptz,
  responded_at  timestamptz,
  confirmed_at  timestamptz,
  checked_in_at timestamptz,
  completed_at  timestamptz,
  cancelled_at  timestamptz,
  cancellation_reason text,
  expires_at    timestamptz,        -- response window for REQUESTED/OFFER_PENDING

  -- Makes a retried "create booking" POST safe (spec §63).
  idempotency_key text,

  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT booking_period_non_empty CHECK (NOT isempty(stay_period)),
  CONSTRAINT booking_period_bounded CHECK (
    lower(stay_period) IS NOT NULL AND upper(stay_period) IS NOT NULL),
  CONSTRAINT booking_tenant_is_not_landlord CHECK (tenant_id <> landlord_id),
  -- Confirmed money must be frozen money.
  CONSTRAINT booking_confirmed_terms_frozen CHECK (
    confirmed_at IS NULL OR terms_frozen_at IS NOT NULL),
  CONSTRAINT booking_completed_has_timestamp CHECK (
    status <> 'COMPLETED' OR completed_at IS NOT NULL),
  CONSTRAINT booking_answer_needs_timestamp CHECK (
    (tenant_completion_answer IS NULL) = (tenant_completion_at IS NULL)),
  CONSTRAINT booking_landlord_answer_needs_timestamp CHECK (
    (landlord_completion_answer IS NULL) = (landlord_completion_at IS NULL)),

  /* ---------------------------------------------------------------- *
   * DOUBLE-BOOKING PREVENTION
   *
   * Two concurrent transactions confirming overlapping dates for the same
   * property cannot both commit: the second one fails with SQLSTATE 23P01.
   * REQUESTED is deliberately absent from the predicate — competing requests
   * are allowed and the first acceptance wins (DEC-007).
   * ---------------------------------------------------------------- */
  CONSTRAINT booking_no_overlap EXCLUDE USING gist (
    property_id WITH =,
    stay_period WITH &&
  ) WHERE (status IN ('CONFIRMED', 'CHECKED_IN', 'COMPLETION_PENDING', 'DISPUTED', 'COMPLETED'))
);

CREATE TRIGGER booking_updated_at BEFORE UPDATE ON booking
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE INDEX booking_tenant_idx   ON booking (tenant_id, created_at DESC);
CREATE INDEX booking_landlord_idx ON booking (landlord_id, created_at DESC);
CREATE INDEX booking_property_idx ON booking USING gist (property_id, stay_period);
CREATE INDEX booking_status_idx   ON booking (status);
-- Scheduled jobs: expire stale requests, open completion windows.
CREATE INDEX booking_expiry_idx ON booking (expires_at)
  WHERE status IN ('REQUESTED', 'OFFER_PENDING', 'INQUIRY');
CREATE INDEX booking_completion_due_idx ON booking (completion_deadline_at)
  WHERE status = 'COMPLETION_PENDING';
-- Idempotent creation, scoped per tenant so keys cannot collide across users.
CREATE UNIQUE INDEX booking_idempotency_idx ON booking (tenant_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

/* A booking must not land on dates the landlord has blocked. This crosses two
   tables, so an EXCLUDE constraint cannot express it; a constraint trigger can.
   Checked on the booking side only — blocking a night that is already booked is
   rejected by the calendar service with a clearer message. */
CREATE OR REPLACE FUNCTION booking_respects_calendar_blocks() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status IN ('CONFIRMED', 'CHECKED_IN', 'COMPLETION_PENDING', 'DISPUTED', 'COMPLETED') THEN
    IF EXISTS (
      SELECT 1 FROM calendar_block cb
      WHERE cb.property_id = NEW.property_id
        AND cb.period && NEW.stay_period
    ) THEN
      RAISE EXCEPTION 'Booking % overlaps a calendar block on property %', NEW.id, NEW.property_id
        USING ERRCODE = 'exclusion_violation';
    END IF;
  END IF;
  RETURN NEW;
END $$;

CREATE CONSTRAINT TRIGGER booking_calendar_block_guard
  AFTER INSERT OR UPDATE OF status, stay_period, property_id ON booking
  DEFERRABLE INITIALLY IMMEDIATE
  FOR EACH ROW EXECUTE FUNCTION booking_respects_calendar_blocks();

/* -------------------------------------------------------------------- *
 * Negotiation offers — an immutable chain, never an editable "current price"
 * -------------------------------------------------------------------- */

CREATE TABLE booking_offer (
  id            uuid PRIMARY KEY,
  booking_id    uuid NOT NULL REFERENCES booking(id) ON DELETE CASCADE,
  sequence      integer NOT NULL CHECK (sequence >= 1),
  proposed_by   text NOT NULL CHECK (proposed_by IN ('TENANT', 'LANDLORD')),
  proposed_by_user_id uuid NOT NULL REFERENCES app_user(id) ON DELETE RESTRICT,

  currency      char(3) NOT NULL DEFAULT 'BYN' CHECK (currency = 'BYN'),
  rent_minor            bigint NOT NULL CHECK (rent_minor >= 0),
  cleaning_fee_minor    bigint NOT NULL DEFAULT 0 CHECK (cleaning_fee_minor >= 0),
  utilities_fixed_minor bigint NOT NULL DEFAULT 0 CHECK (utilities_fixed_minor >= 0),
  total_expected_minor  bigint NOT NULL CHECK (total_expected_minor >= 0),
  stay_period   daterange NOT NULL,
  message       text,

  status        text NOT NULL DEFAULT 'PENDING'
                  CHECK (status IN ('PENDING', 'ACCEPTED', 'REJECTED', 'SUPERSEDED', 'EXPIRED')),
  expires_at    timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  resolved_at   timestamptz,

  UNIQUE (booking_id, sequence)
);

CREATE INDEX booking_offer_booking_idx ON booking_offer (booking_id, sequence DESC);
-- At most one live offer per booking: no "which price did we agree?" ambiguity.
CREATE UNIQUE INDEX booking_offer_single_pending_idx ON booking_offer (booking_id)
  WHERE status = 'PENDING';

/* -------------------------------------------------------------------- *
 * Booking event log — append-only, one row per state transition
 * -------------------------------------------------------------------- */

CREATE TABLE booking_event (
  id            bigserial PRIMARY KEY,
  booking_id    uuid NOT NULL REFERENCES booking(id) ON DELETE CASCADE,
  occurred_at   timestamptz NOT NULL DEFAULT now(),
  event_type    text NOT NULL,
  actor         text NOT NULL CHECK (actor IN ('TENANT', 'LANDLORD', 'ADMIN', 'SYSTEM')),
  actor_user_id uuid REFERENCES app_user(id) ON DELETE SET NULL,
  from_status   text,
  to_status     text NOT NULL,
  effects       text[] NOT NULL DEFAULT '{}',
  payload       jsonb,
  correlation_id uuid
);

CREATE INDEX booking_event_booking_idx ON booking_event (booking_id, occurred_at);
CREATE TRIGGER booking_event_append_only BEFORE UPDATE OR DELETE ON booking_event
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

/* -------------------------------------------------------------------- *
 * Check-in / check-out and the property condition timeline (spec §36/§37)
 * -------------------------------------------------------------------- */

CREATE TABLE stay_event (
  id           uuid PRIMARY KEY,
  booking_id   uuid NOT NULL REFERENCES booking(id) ON DELETE CASCADE,
  kind         text NOT NULL CHECK (kind IN ('CHECK_IN', 'CHECK_OUT')),
  reported_by  text NOT NULL CHECK (reported_by IN ('TENANT', 'LANDLORD')),
  reported_by_user_id uuid NOT NULL REFERENCES app_user(id) ON DELETE RESTRICT,
  occurred_at  timestamptz NOT NULL DEFAULT now(),
  condition_ok boolean,
  note         text,
  -- Each side may file its own check-in and check-out record, and only one.
  UNIQUE (booking_id, kind, reported_by)
);

CREATE INDEX stay_event_booking_idx ON stay_event (booking_id, occurred_at);

CREATE TABLE stay_photo (
  id            uuid PRIMARY KEY,
  stay_event_id uuid NOT NULL REFERENCES stay_event(id) ON DELETE CASCADE,
  storage_key   text NOT NULL,
  content_hash  bytea,
  caption       text,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX stay_photo_event_idx ON stay_photo (stay_event_id);
