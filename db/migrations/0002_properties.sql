-- 0002_properties.sql
-- Properties (the "rental passport"), media, amenities, pricing and calendar.
--
-- DEC-009: Property and Listing are ONE aggregate, not two tables. The spec
-- lists both, but in this product a property has exactly one public offer, and
-- a duration/price matrix is expressed by pricing rules rather than by parallel
-- listings. Splitting them now would buy a join and no capability. What a
-- separate Listing table would really have given us — knowing what the offer
-- said at the moment somebody booked it — is provided instead by
-- listing_snapshot, which is immutable and referenced by every booking.

CREATE TABLE property (
  id            uuid PRIMARY KEY,
  owner_id      uuid NOT NULL REFERENCES app_user(id) ON DELETE RESTRICT,

  status        text NOT NULL DEFAULT 'DRAFT' CHECK (status IN (
                  'DRAFT',                -- landlord is still filling it in
                  'PENDING_MODERATION',   -- submitted, waiting for a moderator
                  'PUBLISHED',
                  'PAUSED',               -- landlord hid it, or staleness paused it
                  'REJECTED',
                  'ARCHIVED')),
  rejection_reason text,

  title         text NOT NULL CHECK (length(btrim(title)) BETWEEN 8 AND 120),
  description   text NOT NULL DEFAULT '',
  property_type text NOT NULL CHECK (property_type IN (
                  'APARTMENT', 'ROOM', 'HOUSE', 'COTTAGE', 'STUDIO', 'TOWNHOUSE')),

  -- --- location -----------------------------------------------------
  country_code  char(2) NOT NULL DEFAULT 'BY',
  region        text,
  city          text NOT NULL,
  district      text,
  street        text,
  house_number  text,
  -- Apartment number is exact-location data: never exposed before the booking
  -- reaches CONFIRMED (spec §19).
  apartment_number text,
  postal_code   text,
  latitude      double precision NOT NULL CHECK (latitude BETWEEN -90 AND 90),
  longitude     double precision NOT NULL CHECK (longitude BETWEEN -180 AND 180),
  -- How precisely the public map may show this property before booking.
  location_precision text NOT NULL DEFAULT 'APPROXIMATE'
                  CHECK (location_precision IN ('EXACT', 'APPROXIMATE')),
  -- Deterministic public offset so the blurred pin does not jitter between
  -- requests (a moving pin is a de-anonymisation oracle).
  public_latitude  double precision NOT NULL,
  public_longitude double precision NOT NULL,

  -- --- rental passport (structured, not free text; spec §21) ---------
  rooms         smallint CHECK (rooms BETWEEN 0 AND 30),
  area_sqm      numeric(7,2) CHECK (area_sqm > 0 AND area_sqm < 10000),
  floor         smallint,
  total_floors  smallint CHECK (total_floors > 0),
  beds          smallint CHECK (beds >= 0),
  bathrooms     smallint CHECK (bathrooms >= 0),
  max_guests    smallint NOT NULL DEFAULT 1 CHECK (max_guests BETWEEN 1 AND 50),

  -- --- house rules ---------------------------------------------------
  smoking_policy text NOT NULL DEFAULT 'PROHIBITED'
                  CHECK (smoking_policy IN ('PROHIBITED', 'ALLOWED', 'BALCONY_ONLY')),
  pets_policy    text NOT NULL DEFAULT 'PROHIBITED'
                  CHECK (pets_policy IN ('PROHIBITED', 'ALLOWED', 'SMALL_ONLY', 'ON_REQUEST')),
  children_allowed boolean NOT NULL DEFAULT true,
  parties_allowed  boolean NOT NULL DEFAULT false,
  quiet_hours_from time,
  quiet_hours_to   time,
  check_in_from    time NOT NULL DEFAULT '14:00',
  check_out_until  time NOT NULL DEFAULT '12:00',

  -- --- duration model (spec §6) --------------------------------------
  -- Nights is the single internal unit; the UI renders days/weeks/months/years.
  min_nights    integer NOT NULL DEFAULT 1 CHECK (min_nights >= 1),
  max_nights    integer NOT NULL DEFAULT 365 CHECK (max_nights >= 1),

  -- --- commercial terms ----------------------------------------------
  currency      char(3) NOT NULL DEFAULT 'BYN' CHECK (currency = 'BYN'),
  base_price_minor bigint NOT NULL CHECK (base_price_minor > 0),
  price_unit    text NOT NULL DEFAULT 'NIGHT' CHECK (price_unit IN ('NIGHT', 'MONTH')),
  cleaning_fee_minor bigint NOT NULL DEFAULT 0 CHECK (cleaning_fee_minor >= 0),
  -- Utilities that depend on a meter cannot be quoted up front; the UI must
  -- label them variable rather than fold them into a fake total (spec §8).
  utilities_mode text NOT NULL DEFAULT 'INCLUDED'
                  CHECK (utilities_mode IN ('INCLUDED', 'FIXED_EXTRA', 'VARIABLE_METERED')),
  utilities_fixed_minor bigint NOT NULL DEFAULT 0 CHECK (utilities_fixed_minor >= 0),
  utilities_note text,
  deposit_minor bigint NOT NULL DEFAULT 0 CHECK (deposit_minor >= 0),

  booking_mode  text NOT NULL DEFAULT 'REQUEST'
                  CHECK (booking_mode IN ('INSTANT', 'REQUEST', 'INSTANT_AND_REQUEST')),
  negotiation_enabled boolean NOT NULL DEFAULT false,

  -- --- verification & freshness ---------------------------------------
  property_verified_at   timestamptz,
  property_verified_by   uuid REFERENCES app_user(id),
  calendar_updated_at    timestamptz NOT NULL DEFAULT now(),
  content_updated_at     timestamptz NOT NULL DEFAULT now(),
  published_at           timestamptz,

  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  deleted_at    timestamptz,

  CONSTRAINT property_duration_range CHECK (max_nights >= min_nights),
  CONSTRAINT property_floor_within_building CHECK (
    floor IS NULL OR total_floors IS NULL OR floor <= total_floors),
  CONSTRAINT property_fixed_utilities_only_when_fixed CHECK (
    utilities_mode = 'FIXED_EXTRA' OR utilities_fixed_minor = 0),
  CONSTRAINT property_published_needs_timestamp CHECK (
    status <> 'PUBLISHED' OR published_at IS NOT NULL)
);

CREATE TRIGGER property_updated_at BEFORE UPDATE ON property
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE INDEX property_owner_idx  ON property (owner_id) WHERE deleted_at IS NULL;
CREATE INDEX property_status_idx ON property (status)   WHERE deleted_at IS NULL;
CREATE INDEX property_city_idx   ON property (lower(city)) WHERE status = 'PUBLISHED';
-- Radius search without PostGIS; the public (blurred) point is what search uses.
CREATE INDEX property_geo_idx ON property
  USING gist (ll_to_earth(public_latitude, public_longitude)) WHERE status = 'PUBLISHED';
CREATE INDEX property_price_idx ON property (base_price_minor) WHERE status = 'PUBLISHED';
CREATE INDEX property_freshness_idx ON property (calendar_updated_at DESC) WHERE status = 'PUBLISHED';
CREATE INDEX property_title_trgm_idx ON property USING gin (title gin_trgm_ops);

/* -------------------------------------------------------------------- *
 * Photos
 * -------------------------------------------------------------------- */

CREATE TABLE property_photo (
  id           uuid PRIMARY KEY,
  property_id  uuid NOT NULL REFERENCES property(id) ON DELETE CASCADE,
  storage_key  text NOT NULL,
  width        integer CHECK (width > 0),
  height       integer CHECK (height > 0),
  byte_size    integer CHECK (byte_size > 0),
  content_hash bytea,          -- duplicate/stolen-photo detection (spec §47)
  caption      text,
  sort_order   smallint NOT NULL DEFAULT 0,
  is_cover     boolean NOT NULL DEFAULT false,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX property_photo_property_idx ON property_photo (property_id, sort_order);
-- Exactly one cover per property, enforced by the database rather than by hope.
CREATE UNIQUE INDEX property_photo_single_cover_idx ON property_photo (property_id) WHERE is_cover;
CREATE INDEX property_photo_hash_idx ON property_photo (content_hash) WHERE content_hash IS NOT NULL;

/* -------------------------------------------------------------------- *
 * Amenities — a controlled vocabulary, because free text cannot be filtered
 * -------------------------------------------------------------------- */

CREATE TABLE amenity (
  code       text PRIMARY KEY,
  category   text NOT NULL,
  name_ru    text NOT NULL,
  name_be    text NOT NULL,
  name_en    text NOT NULL,
  icon       text,
  sort_order smallint NOT NULL DEFAULT 0
);

CREATE TABLE property_amenity (
  property_id uuid NOT NULL REFERENCES property(id) ON DELETE CASCADE,
  amenity_code text NOT NULL REFERENCES amenity(code) ON DELETE RESTRICT,
  PRIMARY KEY (property_id, amenity_code)
);

CREATE INDEX property_amenity_code_idx ON property_amenity (amenity_code);

/* -------------------------------------------------------------------- *
 * Pricing rules — tiered by length of stay, and seasonal by date range
 * -------------------------------------------------------------------- */

CREATE TABLE pricing_rule (
  id            uuid PRIMARY KEY,
  property_id   uuid NOT NULL REFERENCES property(id) ON DELETE CASCADE,
  kind          text NOT NULL CHECK (kind IN ('LENGTH_OF_STAY', 'SEASONAL')),

  -- LENGTH_OF_STAY: applies when the stay length falls inside [min,max] nights.
  min_nights    integer CHECK (min_nights >= 1),
  max_nights    integer CHECK (max_nights >= 1),

  -- SEASONAL: applies to stays overlapping this date range.
  season        daterange,

  price_minor   bigint NOT NULL CHECK (price_minor > 0),
  price_unit    text NOT NULL CHECK (price_unit IN ('NIGHT', 'MONTH')),
  priority      smallint NOT NULL DEFAULT 0,
  created_at    timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT pricing_rule_shape CHECK (
    (kind = 'LENGTH_OF_STAY' AND min_nights IS NOT NULL AND max_nights IS NOT NULL AND season IS NULL)
    OR
    (kind = 'SEASONAL' AND season IS NOT NULL)
  ),
  CONSTRAINT pricing_rule_night_range CHECK (max_nights IS NULL OR min_nights IS NULL OR max_nights >= min_nights)
);

CREATE INDEX pricing_rule_property_idx ON pricing_rule (property_id, kind, priority DESC);

/* -------------------------------------------------------------------- *
 * Calendar blocks — landlord-declared unavailability
 * -------------------------------------------------------------------- */

CREATE TABLE calendar_block (
  id          uuid PRIMARY KEY,
  property_id uuid NOT NULL REFERENCES property(id) ON DELETE CASCADE,
  period      daterange NOT NULL,
  reason      text NOT NULL DEFAULT 'BLOCKED'
                CHECK (reason IN ('BLOCKED', 'MAINTENANCE', 'PERSONAL_USE', 'EXTERNAL_BOOKING')),
  note        text,
  created_by  uuid REFERENCES app_user(id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  -- A landlord cannot block the same night twice; overlapping blocks are a
  -- calendar bug waiting to happen.
  CONSTRAINT calendar_block_no_overlap EXCLUDE USING gist (
    property_id WITH =,
    period WITH &&
  ),
  CONSTRAINT calendar_block_non_empty CHECK (NOT isempty(period))
);

CREATE INDEX calendar_block_property_idx ON calendar_block USING gist (property_id, period);
