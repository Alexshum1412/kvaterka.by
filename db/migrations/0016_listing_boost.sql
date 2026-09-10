-- 0016_listing_boost.sql
-- Paid placement: a landlord may pay to pin a PUBLISHED listing to the top of
-- search results for a period. Charged through the same post-paid ledger every
-- other charge on the platform already uses — there is no live payment
-- gateway, here or anywhere else (see src/server/services/boost-service.ts).
--
-- Not folded into `service_fee`: a service fee is EARNED, by a completed
-- rental, and its shape (base_minor/bps/fee_minor) exists to make a percentage
-- recomputable. A boost is bought outright at a flat price and needs a
-- validity window instead (starts_at/ends_at), which service_fee has no use
-- for. One listing may be boosted many times over its life — a lapsed boost is
-- history, not clutter — so `status` is its own column rather than something
-- derived solely from `ends_at`, matching how the rest of this schema prefers
-- an explicit status a human can read over a date a human has to do arithmetic
-- on.

CREATE TABLE listing_boost (
  id            uuid PRIMARY KEY,
  property_id   uuid NOT NULL REFERENCES property(id),
  purchased_by  uuid NOT NULL REFERENCES app_user(id),
  amount_minor  bigint NOT NULL CHECK (amount_minor > 0),
  starts_at     timestamptz NOT NULL DEFAULT now(),
  ends_at       timestamptz NOT NULL,
  status        text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'EXPIRED', 'CANCELLED')),
  created_at    timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT listing_boost_ends_after_starts CHECK (ends_at > starts_at)
);

-- The search service's lookup at query time: "is this property boosted right
-- now?". A property is boosted at most a handful of times a year, so the
-- partial index stays small however old the table gets.
CREATE INDEX listing_boost_active_idx ON listing_boost (property_id) WHERE status = 'ACTIVE';

/* ==================================================================== *
 * The ledger needs a name for this charge.
 *
 * `ledger_entry.entry_type` was closed to five values in 0005: one accrual
 * (FEE_ACCRUED, always the 5% rental commission) and four staff/credit types.
 * A boost purchase is neither — it is the landlord spending money on their own
 * initiative, in the same post-paid model FEE_ACCRUED already uses, but on a
 * different thing entirely. Reusing FEE_ACCRUED would make every future report
 * that sums "commission owed" silently include boost charges, and reusing
 * ADJUSTMENT would record a landlord's own purchase as a staff correction.
 * Both are the kind of misdescription 0015 exists to warn against, so this
 * gets its own name instead.
 * ==================================================================== */
ALTER TABLE ledger_entry DROP CONSTRAINT ledger_entry_entry_type_check;
ALTER TABLE ledger_entry ADD CONSTRAINT ledger_entry_entry_type_check CHECK (entry_type IN (
  'FEE_ACCRUED',      -- negative: landlord now owes the platform
  'PAYMENT_RECEIVED', -- positive: debt reduced
  'FEE_WAIVED',       -- positive: platform forgave the fee
  'FEE_WRITTEN_OFF',  -- positive: uncollectable
  'ADJUSTMENT',       -- signed: correction, always with a reason
  'BOOST_CHARGED'));  -- negative: landlord paid to pin a listing in search

-- Same sign discipline as `ledger_fee_accrual_is_negative`: a charge against
-- the landlord is always negative, so the balance (SUM(amount_minor)) needs no
-- per-type branching to read as debt.
ALTER TABLE ledger_entry ADD CONSTRAINT ledger_boost_charge_is_negative CHECK (
  entry_type <> 'BOOST_CHARGED' OR amount_minor < 0);
