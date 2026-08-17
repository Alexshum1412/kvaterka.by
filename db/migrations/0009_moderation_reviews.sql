/* ==================================================================== *
 * Moderation reviews
 *
 * `property.rejection_reason` is a single text column that the next
 * decision overwrites. That is enough to show a landlord what to fix
 * once, and not enough for anything else: a listing rejected twice for
 * the same thing looks identical to one rejected once, a moderator
 * reviewing a resubmission cannot see what a colleague already asked
 * for, and there is no way to count why listings get rejected.
 *
 * So each decision becomes a row. The column stays as the *current*
 * reason — the dashboard and the wizard already read it — and this table
 * is the history behind it.
 *
 * Why this is not a second audit log: `audit_log` records that an actor
 * performed an action, generically, across the whole system, and is
 * deliberately a diff rather than a domain record. This is a domain
 * record — the moderation decision itself, with the structured reasons
 * that drive what the landlord is told and which wizard step they are
 * sent back to. Both are written in the same transaction.
 *
 * Reasons are CODES, not prose. A free-text-only rejection cannot be
 * counted, cannot be translated, and cannot be linked to the step that
 * needs fixing. The optional comment carries the specifics.
 * ==================================================================== */

CREATE TABLE listing_moderation_review (
  id            uuid PRIMARY KEY,
  property_id   uuid NOT NULL REFERENCES property(id) ON DELETE CASCADE,
  -- SET NULL rather than RESTRICT: a moderator's account may be closed,
  -- and the decision must survive them.
  moderator_id  uuid REFERENCES app_user(id) ON DELETE SET NULL,

  decision      text NOT NULL CHECK (decision IN ('PUBLISHED', 'REJECTED', 'PAUSED')),

  /* Structured, and validated against the vocabulary rather than a
     lookup table: these codes are branch conditions in the UI, so a new
     one is a code change anyway. */
  reason_codes  text[] NOT NULL DEFAULT '{}' CHECK (
    reason_codes <@ ARRAY[
      'INSUFFICIENT_PHOTOS',
      'POOR_PHOTO_QUALITY',
      'INCORRECT_INFORMATION',
      'INSUFFICIENT_DESCRIPTION',
      'INCORRECT_PRICE',
      'INCORRECT_LOCATION',
      'PROHIBITED_CONTENT',
      'SUSPICIOUS_INFORMATION',
      'MISSING_INFORMATION',
      'VERIFICATION_REQUIRED',
      'OTHER'
    ]::text[]),

  /* A rejection has to tell the landlord something. Approvals need not. */
  CONSTRAINT review_rejection_needs_reason CHECK (
    decision <> 'REJECTED' OR cardinality(reason_codes) > 0),

  comment       text CHECK (comment IS NULL OR length(comment) <= 2000),
  /* The status the listing was in when the decision was taken, so the
     history reads correctly even after later transitions. */
  from_status   text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);

/* The queries this table exists for: one listing's history, newest
   first, and a moderator's own recent decisions. */
CREATE INDEX listing_moderation_review_property_idx
  ON listing_moderation_review (property_id, created_at DESC);
CREATE INDEX listing_moderation_review_moderator_idx
  ON listing_moderation_review (moderator_id, created_at DESC);

/* History that can be edited is not history. */
CREATE TRIGGER listing_moderation_review_append_only
  BEFORE UPDATE OR DELETE ON listing_moderation_review
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

/* Submission time, so the queue can be ordered by how long a landlord
   has actually been waiting rather than by when the listing was first
   created. A resubmission moves it. */
ALTER TABLE property ADD COLUMN submitted_at timestamptz;

CREATE INDEX property_pending_moderation_idx
  ON property (submitted_at)
  WHERE status = 'PENDING_MODERATION' AND deleted_at IS NULL;

/* Existing pending listings have been waiting since they were created. */
UPDATE property SET submitted_at = created_at WHERE status = 'PENDING_MODERATION';
