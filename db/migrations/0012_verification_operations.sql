/* ==================================================================== *
 * Verification operations.
 *
 * The tables existed and were well designed. What they had no room for was
 * the operational half: who is working a request, why it was refused in a
 * form a machine can act on, what the applicant is told versus what staff
 * write to each other, and how somebody tries again without starting over.
 *
 * There was also no submission path anywhere in the product — rows only
 * ever existed in tests — so nothing here is a rewrite; it is the parts
 * that were never built.
 * ==================================================================== */

/* -- 1. NEEDS_INFO ---------------------------------------------------- *
 *
 * Rejecting a request that is merely incomplete throws away work the
 * applicant already did and teaches them nothing. Listing moderation
 * learned this and grew NEEDS_CORRECTION (DEC-030); this is the same
 * lesson in the same shape.
 */
ALTER TABLE verification_request DROP CONSTRAINT verification_request_status_check;

ALTER TABLE verification_request ADD CONSTRAINT verification_request_status_check CHECK (
  status IN ('SUBMITTED', 'IN_REVIEW', 'NEEDS_INFO', 'APPROVED', 'REJECTED', 'EXPIRED'));

/* -- 2. Operational columns ------------------------------------------ */

ALTER TABLE verification_request
  ADD COLUMN assigned_to uuid REFERENCES app_user(id) ON DELETE SET NULL,

  /* Structured and machine-readable, validated against the same vocabulary
     as src/server/domain/verification.ts. Branch conditions in the UI, so a
     new code is a code change anyway — the same argument as the moderation
     reason codes in 0009. */
  ADD COLUMN reason_codes text[] NOT NULL DEFAULT '{}' CHECK (
    reason_codes <@ ARRAY[
      'IDENTITY_DOCUMENT_UNREADABLE',
      'IDENTITY_DATA_MISMATCH',
      'SELFIE_MISMATCH',
      'DOCUMENT_EXPIRED',
      'DOCUMENT_MISSING',
      'RIGHT_TO_RENT_NOT_CONFIRMED',
      'PROPERTY_DOCUMENT_INSUFFICIENT',
      'INFORMATION_INCONSISTENT',
      'SUSPICIOUS_ACTIVITY',
      'OTHER']::text[]),

  /* Two audiences, two columns.
   *
   * `decision_note` already existed and was ambiguous: nothing in the
   * product ever showed it, so it was impossible to tell whether it was
   * meant for the applicant or for colleagues. It is now explicitly the
   * INTERNAL note, and `applicant_message` is what the person is told.
   *
   * Keeping them apart is not tidiness. A verifier writing "photo looks
   * doctored, third attempt from this device" needs somewhere to write it,
   * and that sentence must not be deliverable to the applicant by any code
   * path — telling somebody which signal fired tells them what to avoid. */
  ADD COLUMN applicant_message text,

  /* What the applicant declared, as structured data rather than prose:
     ownership basis for a property request, and which documents they say
     they attached. Never treated as evidence on its own — the domain
     requires a document as well. */
  ADD COLUMN declared jsonb NOT NULL DEFAULT '{}',

  /* The resubmission chain. A rejected or NEEDS_INFO request is never
     edited — it is superseded, so the history of what was refused and why
     survives intact and a pattern of attempts stays visible. */
  ADD COLUMN supersedes_id uuid REFERENCES verification_request(id) ON DELETE SET NULL,

  ADD COLUMN submitted_at timestamptz NOT NULL DEFAULT now();

/* A decided request must carry its decision. `decided_by` and `decided_at`
   existed and nothing required them, so a request could sit in APPROVED
   with no record of who granted the badge — for the one table in the
   product whose output is a public claim about a person, that cannot be
   optional. A rejection additionally needs at least one reason code: an
   unexplained refusal is a dead end for the person receiving it. */
ALTER TABLE verification_request ADD CONSTRAINT verification_decision_is_recorded CHECK (
  status NOT IN ('APPROVED', 'REJECTED')
  OR (decided_by IS NOT NULL AND decided_at IS NOT NULL));

ALTER TABLE verification_request ADD CONSTRAINT verification_rejection_has_reason CHECK (
  status <> 'REJECTED' OR cardinality(reason_codes) > 0);

/* One live request per user per kind per property. Without this, a
   double-tapped submit button produces two identical applications and two
   verifiers duplicate the work. Scoped to the open statuses so a
   resubmission after a refusal is still possible — the same shape as the
   booking duplicate guard (DEC-034). */
CREATE UNIQUE INDEX verification_request_one_live_idx
  ON verification_request (user_id, kind, COALESCE(property_id, '00000000-0000-0000-0000-000000000000'::uuid))
  WHERE status IN ('SUBMITTED', 'IN_REVIEW', 'NEEDS_INFO');

CREATE INDEX verification_request_assignee_idx ON verification_request (assigned_to, created_at DESC)
  WHERE assigned_to IS NOT NULL AND status IN ('SUBMITTED', 'IN_REVIEW', 'NEEDS_INFO');

/* -- 3. Request history ---------------------------------------------- *
 *
 * Append-only, with the same visibility split as `case_event` (DEC-043) and
 * for the same reason: one stream holds both what the applicant did and
 * what staff wrote about them, and without an explicit column every future
 * query has to remember which event types are safe to show. Default
 * INTERNAL, so an event type added later is invisible until somebody
 * deliberately says otherwise.
 */
CREATE TABLE verification_event (
  id            bigserial PRIMARY KEY,
  request_id    uuid NOT NULL REFERENCES verification_request(id) ON DELETE CASCADE,
  occurred_at   timestamptz NOT NULL DEFAULT now(),
  actor_user_id uuid REFERENCES app_user(id) ON DELETE SET NULL,
  actor_role    text,
  event_type    text NOT NULL,
  note          text,
  reason_codes  text[] NOT NULL DEFAULT '{}',
  visibility    text NOT NULL DEFAULT 'INTERNAL' CHECK (visibility IN ('INTERNAL', 'APPLICANT')),
  payload       jsonb
);

CREATE INDEX verification_event_request_idx ON verification_event (request_id, occurred_at);
CREATE INDEX verification_event_applicant_idx ON verification_event (request_id, occurred_at)
  WHERE visibility = 'APPLICANT';

CREATE TRIGGER verification_event_append_only BEFORE UPDATE OR DELETE ON verification_event
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

/* -- 4. Documents keep their private namespace ------------------------ *
 *
 * `storage_key` was unconstrained, so nothing stopped a document being
 * written with a key like `listings/…`, which /media serves publicly. The
 * media route already refuses to serve anything under `private/`, so
 * requiring the prefix here closes the loop from the other end: a document
 * row cannot exist outside the namespace that route will not serve.
 */
ALTER TABLE verification_document ADD CONSTRAINT verification_document_is_private CHECK (
  storage_key LIKE 'private/%');
