/* ==================================================================== *
 * A draft is allowed to be incomplete
 *
 * The wizard asks for a property type first and a price nine screens
 * later. Until now the table could not hold that: `title`, `city`,
 * `latitude`, `longitude` and `base_price_minor` were all NOT NULL, so
 * no row could exist before the final step and there was nowhere to
 * autosave to.
 *
 * The alternative — a second table holding wizard state as JSON — was
 * rejected. It would have meant two sources of truth for the same
 * listing, a dual write on every keystroke, and drafts that could not
 * appear in the landlord's dashboard until they were finished.
 *
 * Instead the columns become nullable and the requirement moves to where
 * it actually belongs: a listing must be COMPLETE to leave DRAFT. The
 * database still guarantees that anything a tenant can reach has a
 * title, a place and a price — it simply stops pretending that a
 * half-filled form does.
 *
 * `property_type` stays NOT NULL: it is the first question the wizard
 * asks, so a row never exists without it.
 * ==================================================================== */

ALTER TABLE property ALTER COLUMN title DROP NOT NULL;
ALTER TABLE property ALTER COLUMN city DROP NOT NULL;
ALTER TABLE property ALTER COLUMN latitude DROP NOT NULL;
ALTER TABLE property ALTER COLUMN longitude DROP NOT NULL;
ALTER TABLE property ALTER COLUMN public_latitude DROP NOT NULL;
ALTER TABLE property ALTER COLUMN public_longitude DROP NOT NULL;
ALTER TABLE property ALTER COLUMN base_price_minor DROP NOT NULL;

/* The inline CHECKs were written against non-nullable columns. In
   PostgreSQL a CHECK passes when its expression is NULL, so the range
   tests survive unchanged — but the two that assert a *shape* have to be
   restated so they tolerate an absent value. */
ALTER TABLE property DROP CONSTRAINT IF EXISTS property_title_check;
ALTER TABLE property DROP CONSTRAINT IF EXISTS property_base_price_minor_check;

ALTER TABLE property ADD CONSTRAINT property_title_length CHECK (
  title IS NULL OR length(btrim(title)) BETWEEN 8 AND 120);

ALTER TABLE property ADD CONSTRAINT property_base_price_positive CHECK (
  base_price_minor IS NULL OR base_price_minor > 0);

/* The real rule. Everything except a draft must be whole.
   `submitForModeration` checks the same things first so the landlord
   gets a sentence they can act on instead of a constraint violation;
   this is the backstop that makes it impossible to get past by any
   other route. */
ALTER TABLE property ADD CONSTRAINT property_complete_unless_draft CHECK (
  status = 'DRAFT' OR (
        title            IS NOT NULL
    AND city             IS NOT NULL AND btrim(city) <> ''
    AND latitude         IS NOT NULL
    AND longitude        IS NOT NULL
    AND public_latitude  IS NOT NULL
    AND public_longitude IS NOT NULL
    AND base_price_minor IS NOT NULL
  ));
