/* ==================================================================== *
 * Staff operations for dispute cases.
 *
 * The tables already existed and were designed for this; what follows is
 * the smallest set of changes needed to run a real queue on them.
 * ==================================================================== */

/* -- 1. A safety category ------------------------------------------- *
 *
 * The original vocabulary has no way to say "I do not feel safe here".
 * The nearest options were ACCESS_PROBLEM (about a key) and OTHER (about
 * nothing), and a safety report filed as OTHER sits in the queue behind a
 * complaint about towels. Priority routing is the whole reason categories
 * are structured, so the one category that must never be routed as
 * ordinary feedback has to exist.
 */
ALTER TABLE dispute_case DROP CONSTRAINT dispute_case_category_check;

ALTER TABLE dispute_case ADD CONSTRAINT dispute_case_category_check CHECK (
  category IN (
    'LISTING_MISMATCH', 'ACCESS_PROBLEM', 'CLEANLINESS', 'PROPERTY_DAMAGE',
    'PAYMENT_DISAGREEMENT', 'COMMUNICATION', 'SAFETY_CONCERN', 'SUSPECTED_FRAUD',
    'CANCELLATION', 'NO_SHOW', 'OTHER'));

/* -- 2. Indexes the queue actually uses ------------------------------ *
 *
 * `dispute_case_status_idx (status, created_at)` already covers the tab
 * counts. These two cover the other things the console does on every page
 * load: "what is assigned to me", and the open-case join to a booking that
 * the priority rule reads.
 */
CREATE INDEX dispute_case_assignee_idx ON dispute_case (assigned_to, created_at DESC)
  WHERE assigned_to IS NOT NULL AND status NOT IN ('RESOLVED', 'CLOSED');

CREATE INDEX dispute_case_open_idx ON dispute_case (created_at)
  WHERE status NOT IN ('RESOLVED', 'CLOSED');

/* -- 3. A resolution needs an author and a decision ------------------ *
 *
 * `resolution` and `resolved_at` existed but nothing required them to
 * arrive together, or at all, when a case reached a terminal status — so a
 * case could be marked RESOLVED with no record of what was decided or by
 * whom. For an accountability record that is the one thing that must not
 * be optional.
 *
 * `resolved_by` is new. The constraint is written so that historical rows
 * (there are none in production yet, but the rule must be honest about it)
 * cannot be created without it going forward.
 */
ALTER TABLE dispute_case ADD COLUMN resolved_by uuid REFERENCES app_user(id) ON DELETE SET NULL;

ALTER TABLE dispute_case ADD CONSTRAINT dispute_case_resolution_is_recorded CHECK (
  status NOT IN ('RESOLVED', 'CLOSED')
  OR (resolution IS NOT NULL AND btrim(resolution) <> ''
      AND resolved_at IS NOT NULL AND resolved_by IS NOT NULL));

/* -- 4. Case events carry a visibility --------------------------------- *
 *
 * `case_event` is one append-only stream holding two different kinds of
 * thing: what a party did (they opened the case, they answered) and what
 * staff wrote to each other (an internal note, a suspicion, a next step).
 * Without a column separating them, every read has to remember which
 * event_type values are safe to show a tenant — and one forgetful join is
 * an internal note in somebody's inbox.
 *
 * Default INTERNAL: a new event type added later is invisible to users
 * until somebody deliberately says otherwise. Fail closed.
 */
ALTER TABLE case_event ADD COLUMN visibility text NOT NULL DEFAULT 'INTERNAL'
  CHECK (visibility IN ('INTERNAL', 'PARTIES'));

CREATE INDEX case_event_visible_idx ON case_event (case_id, occurred_at)
  WHERE visibility = 'PARTIES';

/* Backfill: the only event type written before this migration is
 * OPENED_BY_PARTY, whose note is the party's own words about their own
 * case. Leaving it INTERNAL would hide somebody's own submission from
 * them.
 *
 * `case_event` is append-only by trigger, so the backfill has to lower it
 * and put it back. That is safe here and only here: a migration runs in a
 * single transaction, so either both statements commit or neither does,
 * and the table cannot be left writable. It is spelled out rather than
 * done quietly because "the append-only table was briefly not append-only"
 * is exactly the kind of thing a future reader deserves to find in the
 * history rather than discover.
 */
ALTER TABLE case_event DISABLE TRIGGER case_event_append_only;

UPDATE case_event SET visibility = 'PARTIES' WHERE event_type = 'OPENED_BY_PARTY';

ALTER TABLE case_event ENABLE TRIGGER case_event_append_only;
