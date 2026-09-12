/* ==================================================================== *
 * General-purpose support tickets (DEC-073).
 *
 * The booking-dispute tables (`dispute_case`/`case_event`) were not
 * extended for this. A dispute freezes a booking into DISPUTED the moment
 * it opens and requires two named sides (`opened_by` vs `against_user_id`)
 * — both are load-bearing for that feature and both are wrong for "my
 * photos won't upload" or "how is the fee calculated", which has no
 * booking to freeze and nobody to be against. `support_ticket` is the
 * dispute shape stripped to what a generic contact channel actually needs:
 * an optional listing instead of a mandatory booking, one submitter and no
 * counterparty, and a plain OPEN → IN_PROGRESS → RESOLVED/CLOSED workflow
 * with no derived priority — there is no "is a stay active right now"
 * signal for a ticket that may not be about a stay at all. See DEC-073 for
 * the full reasoning.
 *
 * `ticket_event` reuses the identical append-only, visibility-tagged
 * pattern `case_event` established in 0005/0011 (`forbid_mutation()`,
 * `INTERNAL` vs `PARTIES`) — the pattern is worth repeating exactly, the
 * table is not worth sharing: a ticket's history must never be joinable
 * into a dispute's, and a schema change to one workflow must never risk the
 * other.
 * ==================================================================== */

CREATE TABLE support_ticket (
  id           uuid PRIMARY KEY,
  reference    text NOT NULL UNIQUE,
  opened_by    uuid NOT NULL REFERENCES app_user(id) ON DELETE RESTRICT,
  -- A fresh, deliberately small vocabulary. Not DISPUTE_CATEGORIES: a
  -- dispute's categories describe what went wrong DURING A STAY
  -- (cleanliness, access, a no-show); a support ticket can be about an
  -- account nobody can log into or a bug in the listing form, which have no
  -- honest home in that list.
  category     text NOT NULL CHECK (category IN (
                 'ACCOUNT', 'BILLING', 'LISTING', 'TECHNICAL', 'SAFETY', 'OTHER')),
  -- Optional and unconstrained by role or ownership on purpose: "this
  -- listing looks like a scam" is a legitimate ticket naming someone ELSE's
  -- property, so this is a plain reference, not `owner_id = property.owner_id`.
  property_id  uuid REFERENCES property(id) ON DELETE SET NULL,
  summary      text NOT NULL,
  status       text NOT NULL DEFAULT 'OPEN' CHECK (status IN (
                 'OPEN', 'IN_PROGRESS', 'WAITING_ON_USER', 'RESOLVED', 'CLOSED')),
  assigned_to  uuid REFERENCES app_user(id) ON DELETE SET NULL,
  resolution   text,
  resolved_at  timestamptz,
  resolved_by  uuid REFERENCES app_user(id) ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),

  -- Same rule as `dispute_case_resolution_is_recorded` (0011): a terminal
  -- ticket must carry who decided it and what they decided, enforced by the
  -- database rather than trusted to application code.
  CONSTRAINT support_ticket_resolution_is_recorded CHECK (
    status NOT IN ('RESOLVED', 'CLOSED')
    OR (resolution IS NOT NULL AND btrim(resolution) <> ''
        AND resolved_at IS NOT NULL AND resolved_by IS NOT NULL))
);

CREATE TRIGGER support_ticket_updated_at BEFORE UPDATE ON support_ticket
  FOR EACH ROW EXECUTE PROCEDURE set_updated_at();

-- Mirrors dispute_case's index shape: the tab counts, "assigned to me", and
-- the caller's own list.
CREATE INDEX support_ticket_status_idx ON support_ticket (status, created_at);
CREATE INDEX support_ticket_assignee_idx ON support_ticket (assigned_to, created_at DESC)
  WHERE assigned_to IS NOT NULL AND status NOT IN ('RESOLVED', 'CLOSED');
CREATE INDEX support_ticket_opened_by_idx ON support_ticket (opened_by, created_at DESC);
CREATE INDEX support_ticket_property_idx ON support_ticket (property_id) WHERE property_id IS NOT NULL;

CREATE TABLE ticket_event (
  id            bigserial PRIMARY KEY,
  ticket_id     uuid NOT NULL REFERENCES support_ticket(id) ON DELETE CASCADE,
  occurred_at   timestamptz NOT NULL DEFAULT now(),
  actor_user_id uuid REFERENCES app_user(id) ON DELETE SET NULL,
  actor_role    text,
  event_type    text NOT NULL,
  note          text,
  -- INTERNAL by default (fail closed, same reasoning as case_event.visibility
  -- in 0011): a new event type added later stays invisible to the ticket's
  -- own author until something deliberately marks it PARTIES.
  visibility    text NOT NULL DEFAULT 'INTERNAL' CHECK (visibility IN ('INTERNAL', 'PARTIES')),
  payload       jsonb
);

CREATE INDEX ticket_event_ticket_idx ON ticket_event (ticket_id, occurred_at);
CREATE INDEX ticket_event_visible_idx ON ticket_event (ticket_id, occurred_at)
  WHERE visibility = 'PARTIES';

-- Same trigger function 0001 defined for ledger_entry/audit_log/case_event.
-- A ticket's history — including the "chat" thread the user sees — must be
-- exactly as tamper-proof as a dispute's: nobody, staff included, rewrites
-- what was said after the fact.
CREATE TRIGGER ticket_event_append_only BEFORE UPDATE OR DELETE ON ticket_event
  FOR EACH ROW EXECUTE PROCEDURE forbid_mutation();
