-- 0020_promotion_tiers.sql
-- Two new paid placement add-ons alongside the existing boost (0016): a
-- colour highlight (visual styling only, no ranking effect) and a pin to the
-- top of search (a stronger placement than boost, ranked above it). Both
-- mirror listing_boost's shape exactly — same post-paid ledger charge, same
-- starts_at/ends_at validity window, same status vocabulary — because both
-- are the same kind of thing a boost already is: a landlord paying for a
-- period of something, not a one-off action with no duration.
--
-- Kept as two tables rather than one polymorphic "listing_promotion" table
-- with a `kind` column: a pin changes ranking (search-service.ts's
-- orderClause() joins it), a highlight changes rendering only (listing-card.tsx
-- reads it, orderClause() never does), and boost is its own table already.
-- Three narrow tables, each read by exactly the code that needs that one
-- thing, beat one wide table every reader has to filter.

CREATE TABLE listing_highlight (
  id            uuid PRIMARY KEY,
  property_id   uuid NOT NULL REFERENCES property(id),
  purchased_by  uuid NOT NULL REFERENCES app_user(id),
  amount_minor  bigint NOT NULL CHECK (amount_minor > 0),
  starts_at     timestamptz NOT NULL DEFAULT now(),
  ends_at       timestamptz NOT NULL,
  status        text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'EXPIRED', 'CANCELLED')),
  created_at    timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT listing_highlight_ends_after_starts CHECK (ends_at > starts_at)
);

-- Same reasoning as listing_boost_active_idx: "is this property highlighted
-- right now?" is the only lookup this table serves at request time, and the
-- partial index stays small however many highlights accumulate historically.
CREATE INDEX listing_highlight_active_idx ON listing_highlight (property_id) WHERE status = 'ACTIVE';

CREATE TABLE listing_pin (
  id            uuid PRIMARY KEY,
  property_id   uuid NOT NULL REFERENCES property(id),
  purchased_by  uuid NOT NULL REFERENCES app_user(id),
  amount_minor  bigint NOT NULL CHECK (amount_minor > 0),
  starts_at     timestamptz NOT NULL DEFAULT now(),
  ends_at       timestamptz NOT NULL,
  status        text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'EXPIRED', 'CANCELLED')),
  created_at    timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT listing_pin_ends_after_starts CHECK (ends_at > starts_at)
);

CREATE INDEX listing_pin_active_idx ON listing_pin (property_id) WHERE status = 'ACTIVE';

/* ==================================================================== *
 * The ledger needs a name for each new charge, same as 0016 did for
 * BOOST_CHARGED — this is that exact pattern, applied twice.
 * ==================================================================== */
ALTER TABLE ledger_entry DROP CONSTRAINT ledger_entry_entry_type_check;
ALTER TABLE ledger_entry ADD CONSTRAINT ledger_entry_entry_type_check CHECK (entry_type IN (
  'FEE_ACCRUED',       -- negative: landlord now owes the platform
  'PAYMENT_RECEIVED',  -- positive: debt reduced
  'FEE_WAIVED',        -- positive: platform forgave the fee
  'FEE_WRITTEN_OFF',   -- positive: uncollectable
  'ADJUSTMENT',        -- signed: correction, always with a reason
  'BOOST_CHARGED',     -- negative: landlord paid to pin a listing in search
  'HIGHLIGHT_CHARGED', -- negative: landlord paid for a colour-highlighted card
  'PIN_CHARGED'));     -- negative: landlord paid for guaranteed top placement

-- Same sign discipline as ledger_boost_charge_is_negative: a charge against
-- the landlord is always negative, so the balance (SUM(amount_minor)) needs no
-- per-type branching to read as debt.
ALTER TABLE ledger_entry ADD CONSTRAINT ledger_highlight_charge_is_negative CHECK (
  entry_type <> 'HIGHLIGHT_CHARGED' OR amount_minor < 0);
ALTER TABLE ledger_entry ADD CONSTRAINT ledger_pin_charge_is_negative CHECK (
  entry_type <> 'PIN_CHARGED' OR amount_minor < 0);
