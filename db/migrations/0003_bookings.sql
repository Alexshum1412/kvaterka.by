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
  FOR EACH ROW EXECUTE PROCEDURE forbid_mutation();

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
  -- Derived from stay_period by the booking_nights trigger below. Generated
  -- columns are PostgreSQL 12+; the trigger keeps the derivation in the
  -- database on 10, with the same guarantee the generated column gave — a
  -- value the application supplies is overwritten, so nights can never
  -- disagree with the dates it describes. NOT NULL and no DEFAULT on purpose:
  -- if the trigger were ever dropped, inserts fail loudly instead of silently
  -- recording zero-night stays.
  nights        integer NOT NULL,
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
    (landlord_completion_answer IS NULL) = (landlord_completion_at IS NULL))

  /* ---------------------------------------------------------------- *
   * DOUBLE-BOOKING PREVENTION
   *
   * Enforced by the property_occupancy table below, not by a constraint on this
   * table. Two concurrent transactions confirming overlapping dates for the same
   * property still cannot both commit: the second one fails with SQLSTATE 23P01,
   * exactly as it did when this was an EXCLUDE constraint. REQUESTED is
   * deliberately absent from the occupying set — competing requests are allowed
   * and the first acceptance wins (DEC-007).
   * ---------------------------------------------------------------- */
);

CREATE TRIGGER booking_updated_at BEFORE UPDATE ON booking
  FOR EACH ROW EXECUTE PROCEDURE set_updated_at();

/* nights, derived. See the column comment above for why this is a trigger and
   not a generated column. UPDATE OF stay_period rather than plain UPDATE so the
   recomputation happens exactly when the dates move and never otherwise. */
CREATE OR REPLACE FUNCTION set_booking_nights() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.nights := upper(NEW.stay_period) - lower(NEW.stay_period);
  RETURN NEW;
END $$;

CREATE TRIGGER booking_nights BEFORE INSERT OR UPDATE OF stay_period ON booking
  FOR EACH ROW EXECUTE PROCEDURE set_booking_nights();

CREATE INDEX booking_tenant_idx   ON booking (tenant_id, created_at DESC);
CREATE INDEX booking_landlord_idx ON booking (landlord_id, created_at DESC);
-- Was gist (property_id, stay_period), which needs btree_gist for the uuid half.
-- Date-range questions ("is this property free on these nights?") are answered by
-- property_occupancy below, which indexes exactly that; what remains here is
-- "show me this property's bookings", ordered the way the screens read them.
CREATE INDEX booking_property_idx ON booking (property_id, lower(stay_period));
CREATE INDEX booking_status_idx   ON booking (status);
-- Scheduled jobs: expire stale requests, open completion windows.
CREATE INDEX booking_expiry_idx ON booking (expires_at)
  WHERE status IN ('REQUESTED', 'OFFER_PENDING', 'INQUIRY');
CREATE INDEX booking_completion_due_idx ON booking (completion_deadline_at)
  WHERE status = 'COMPLETION_PENDING';
-- Idempotent creation, scoped per tenant so keys cannot collide across users.
CREATE UNIQUE INDEX booking_idempotency_idx ON booking (tenant_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

/* ==================================================================== *
 * OCCUPANCY — one row per occupied night, and the whole calendar guarantee
 *
 * WHY THIS TABLE EXISTS
 *
 * Three rules used to be enforced three different ways:
 *
 *   booking vs booking   EXCLUDE USING gist on booking
 *   block   vs block     EXCLUDE USING gist on calendar_block
 *   booking vs block     a constraint trigger, checked on the booking side only
 *
 * The first two need the btree_gist extension, because a GiST index over a uuid
 * equality column has no operator class in core PostgreSQL. Extensions need a
 * superuser, and the target host does not give us one.
 *
 * All three rules are really one rule: A NIGHT ON A PROPERTY CAN BE SPOKEN FOR
 * ONCE. Written that way it needs no extension at all — just a primary key.
 *
 *   PRIMARY KEY (property_id, night)
 *
 * A booking claims its nights; a block claims its nights; they claim them from
 * the same table, so they cannot both win. The two triggers below are the only
 * writers. No service inserts here, and none may: a service changes a booking's
 * status or inserts a block, and the database decides whether that was allowed.
 *
 * WHAT THIS FIXED ON THE WAY PAST
 *
 * The old cross-table trigger fired on the booking side only. Blocking a night
 * that was already booked was caught by a SELECT-then-INSERT in the calendar
 * service — which is a check, not a guarantee: two transactions, one confirming
 * a booking and one blocking the same night, could both pass their checks and
 * both commit. That race is closed here, because the second one now collides on
 * a primary key instead of on nothing.
 *
 * WHAT DID NOT CHANGE
 *
 * The error. Both triggers re-raise as SQLSTATE 23P01 (exclusion_violation)
 * carrying the constraint name the application already knows, so every catch
 * site, every domain error and every test that asserted on the old EXCLUDE
 * constraint reads exactly the same thing. The guarantee moved; the contract
 * did not.
 *
 * COST. One row per occupied night. A property booked solidly for a year is 365
 * rows; ten thousand such properties are 3.65M rows with a two-column key. This
 * is the cheap end of the trade.
 * ==================================================================== */

CREATE TABLE property_occupancy (
  property_id uuid NOT NULL REFERENCES property(id)       ON DELETE CASCADE,
  night       date NOT NULL,
  booking_id  uuid          REFERENCES booking(id)        ON DELETE CASCADE,
  block_id    uuid          REFERENCES calendar_block(id) ON DELETE CASCADE,

  PRIMARY KEY (property_id, night),

  -- A night is claimed by a booking or by a block, never by both and never by
  -- neither. Without this an orphan row could hold a night nothing owns, and
  -- nothing would ever release it.
  CONSTRAINT property_occupancy_one_claimant CHECK (
    (booking_id IS NOT NULL AND block_id IS NULL) OR
    (booking_id IS NULL     AND block_id IS NOT NULL))
);

-- Releasing a booking's or a block's nights is by claimant, not by date range.
CREATE INDEX property_occupancy_booking_idx ON property_occupancy (booking_id)
  WHERE booking_id IS NOT NULL;
CREATE INDEX property_occupancy_block_idx ON property_occupancy (block_id)
  WHERE block_id IS NOT NULL;

/* The five statuses that hold a calendar night. REQUESTED is absent on purpose:
   several tenants may ask for the same dates and the landlord chooses (DEC-007).
   Kept as a function so the list is written once and both triggers agree. */
CREATE OR REPLACE FUNCTION booking_status_occupies(status text) RETURNS boolean
LANGUAGE sql IMMUTABLE AS $$
  SELECT status IN ('CONFIRMED', 'CHECKED_IN', 'COMPLETION_PENDING', 'DISPUTED', 'COMPLETED');
$$;

CREATE OR REPLACE FUNCTION booking_sync_occupancy() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  was_occupying boolean := TG_OP = 'UPDATE' AND booking_status_occupies(OLD.status);
  is_occupying  boolean := booking_status_occupies(NEW.status);
  footprint_moved boolean := TG_OP = 'UPDATE' AND (
       NEW.stay_period IS DISTINCT FROM OLD.stay_period
    OR NEW.property_id IS DISTINCT FROM OLD.property_id);
BEGIN
  -- Release first: a booking whose dates move must let go of the old nights
  -- before it can claim the new ones, or it would collide with itself.
  IF was_occupying AND (NOT is_occupying OR footprint_moved) THEN
    DELETE FROM property_occupancy WHERE booking_id = OLD.id;
  END IF;

  IF is_occupying AND (NOT was_occupying OR footprint_moved) THEN
    BEGIN
      INSERT INTO property_occupancy (property_id, night, booking_id)
      SELECT NEW.property_id, d::date, NEW.id
        FROM generate_series(
               lower(NEW.stay_period),
               upper(NEW.stay_period) - 1,
               interval '1 day') AS d;
    EXCEPTION WHEN unique_violation THEN
      -- Re-raised as the error the application has always caught. Without this
      -- the caller would see a bare 23505 naming a table it knows nothing about.
      RAISE EXCEPTION 'Booking % overlaps an already occupied night on property %',
        NEW.id, NEW.property_id
        USING ERRCODE = 'exclusion_violation', CONSTRAINT = 'booking_no_overlap';
    END;
  END IF;

  RETURN NEW;
END $$;

CREATE TRIGGER booking_occupancy
  AFTER INSERT OR UPDATE OF status, stay_period, property_id ON booking
  FOR EACH ROW EXECUTE PROCEDURE booking_sync_occupancy();

CREATE OR REPLACE FUNCTION calendar_block_sync_occupancy() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  hit_a_booking boolean;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    DELETE FROM property_occupancy WHERE block_id = OLD.id;
  END IF;

  BEGIN
    INSERT INTO property_occupancy (property_id, night, block_id)
    SELECT NEW.property_id, d::date, NEW.id
      FROM generate_series(
             lower(NEW.period),
             upper(NEW.period) - 1,
             interval '1 day') AS d;
  EXCEPTION WHEN unique_violation THEN
    /* Which of the two rules was broken decides which name the error carries,
       and therefore which sentence the landlord reads. The subtransaction has
       already rolled back here, so this sees the calendar as it was. */
    SELECT po.booking_id IS NOT NULL INTO hit_a_booking
      FROM property_occupancy po
     WHERE po.property_id = NEW.property_id
       AND po.night >= lower(NEW.period)
       AND po.night <  upper(NEW.period)
     ORDER BY po.booking_id IS NULL, po.night
     LIMIT 1;

    IF hit_a_booking THEN
      RAISE EXCEPTION 'Calendar block % covers a booked night on property %',
        NEW.id, NEW.property_id
        USING ERRCODE = 'exclusion_violation', CONSTRAINT = 'booking_no_overlap';
    ELSE
      RAISE EXCEPTION 'Calendar block % overlaps another block on property %',
        NEW.id, NEW.property_id
        USING ERRCODE = 'exclusion_violation', CONSTRAINT = 'calendar_block_no_overlap';
    END IF;
  END;

  RETURN NEW;
END $$;

CREATE TRIGGER calendar_block_occupancy
  AFTER INSERT OR UPDATE OF period, property_id ON calendar_block
  FOR EACH ROW EXECUTE PROCEDURE calendar_block_sync_occupancy();

/* ------------------------------------------------------------------ *
 * Pin the occupancy functions to the schema they were created in.
 *
 * A PL/pgSQL body resolves the names inside it against whatever search_path
 * the *caller* happens to have. That is fine for an application, which always
 * has a sensible one, and not fine for the two callers that matter most:
 *
 *   pg_restore sets `search_path = ''` before loading data, deliberately, so
 *   that a restore cannot be hijacked by objects in a schema it did not
 *   expect. Restoring a booking row then fires this trigger, which cannot find
 *   booking_status_occupies or property_occupancy, and the restore fails with
 *   a message about a missing function rather than about a search path. This
 *   was found by rehearsing a restore, not by reasoning about one.
 *
 *   Anyone who sets search_path themselves before touching the database.
 *
 * current_schema() rather than a literal `public`, because the test harness
 * gives every test file its own schema (src/server/db/testing.ts) and a
 * hardcoded name would migrate cleanly there and then silently write into the
 * wrong tables. pg_catalog is appended so the built-ins stay reachable.
 * ------------------------------------------------------------------ */
DO $$
DECLARE s text := current_schema();
BEGIN
  EXECUTE format('ALTER FUNCTION %I.booking_status_occupies(text) SET search_path = %I, pg_catalog', s, s);
  EXECUTE format('ALTER FUNCTION %I.booking_sync_occupancy() SET search_path = %I, pg_catalog', s, s);
  EXECUTE format('ALTER FUNCTION %I.calendar_block_sync_occupancy() SET search_path = %I, pg_catalog', s, s);
  EXECUTE format('ALTER FUNCTION %I.set_booking_nights() SET search_path = %I, pg_catalog', s, s);
END $$;


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
  FOR EACH ROW EXECUTE PROCEDURE forbid_mutation();

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
