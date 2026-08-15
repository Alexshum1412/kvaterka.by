-- 0004_messaging.sql
-- Conversations, messages, and the anti-off-platform moderation trail.

CREATE TABLE conversation (
  id           uuid PRIMARY KEY,
  property_id  uuid REFERENCES property(id) ON DELETE SET NULL,
  booking_id   uuid REFERENCES booking(id) ON DELETE SET NULL,
  tenant_id    uuid NOT NULL REFERENCES app_user(id) ON DELETE RESTRICT,
  landlord_id  uuid NOT NULL REFERENCES app_user(id) ON DELETE RESTRICT,

  -- Contact details stay masked until the booking reaches CONFIRMED (spec §26).
  -- Stored on the conversation and audited so that "when did they get my phone
  -- number?" is always answerable.
  contact_release_state text NOT NULL DEFAULT 'BLOCKED'
                          CHECK (contact_release_state IN ('BLOCKED', 'RELEASED')),
  contact_released_at   timestamptz,
  contact_released_reason text,

  status       text NOT NULL DEFAULT 'ACTIVE'
                 CHECK (status IN ('ACTIVE', 'ARCHIVED', 'FROZEN')),
  last_message_at timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT conversation_two_distinct_parties CHECK (tenant_id <> landlord_id),
  CONSTRAINT conversation_release_needs_timestamp CHECK (
    (contact_release_state = 'RELEASED') = (contact_released_at IS NOT NULL))
);

CREATE TRIGGER conversation_updated_at BEFORE UPDATE ON conversation
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- One thread per (property, tenant) pair keeps history in one place instead of
-- fragmenting it across repeated enquiries.
CREATE UNIQUE INDEX conversation_property_tenant_idx ON conversation (property_id, tenant_id)
  WHERE property_id IS NOT NULL;
CREATE INDEX conversation_tenant_idx ON conversation (tenant_id, last_message_at DESC NULLS LAST);
CREATE INDEX conversation_landlord_idx ON conversation (landlord_id, last_message_at DESC NULLS LAST);
CREATE INDEX conversation_booking_idx ON conversation (booking_id) WHERE booking_id IS NOT NULL;

CREATE TABLE message (
  id              uuid PRIMARY KEY,
  conversation_id uuid NOT NULL REFERENCES conversation(id) ON DELETE CASCADE,
  sender_id       uuid REFERENCES app_user(id) ON DELETE SET NULL,
  kind            text NOT NULL DEFAULT 'TEXT'
                    CHECK (kind IN ('TEXT', 'IMAGE', 'SYSTEM', 'OFFER', 'BOOKING_UPDATE')),

  -- What the recipient sees. For a flagged message this is the redacted form;
  -- body_original keeps the untouched text for moderation and evidence.
  body            text NOT NULL DEFAULT '',
  body_original   text,
  storage_key     text,          -- for IMAGE
  metadata        jsonb,         -- offer id, booking status change, etc.

  moderation_state text NOT NULL DEFAULT 'CLEAN'
                    CHECK (moderation_state IN ('CLEAN', 'REDACTED', 'BLOCKED', 'FLAGGED')),

  read_at         timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  edited_at       timestamptz,
  deleted_at      timestamptz,

  CONSTRAINT message_system_has_no_sender CHECK (kind <> 'SYSTEM' OR sender_id IS NULL),
  CONSTRAINT message_original_kept_when_touched CHECK (
    moderation_state IN ('CLEAN', 'FLAGGED') OR body_original IS NOT NULL)
);

CREATE INDEX message_conversation_idx ON message (conversation_id, created_at DESC);
CREATE INDEX message_unread_idx ON message (conversation_id) WHERE read_at IS NULL AND deleted_at IS NULL;
CREATE INDEX message_moderation_idx ON message (moderation_state, created_at DESC)
  WHERE moderation_state <> 'CLEAN';

/* Why a message was touched. Append-only: the moderation trail must survive
   even if the message is later edited or deleted. */
CREATE TABLE message_moderation_event (
  id           bigserial PRIMARY KEY,
  message_id   uuid NOT NULL REFERENCES message(id) ON DELETE CASCADE,
  occurred_at  timestamptz NOT NULL DEFAULT now(),
  decision     text NOT NULL CHECK (decision IN ('ALLOW', 'REDACT', 'BLOCK', 'FLAG')),
  -- Which detectors fired, e.g. {PHONE_DIGITS, TELEGRAM_HANDLE}.
  detectors    text[] NOT NULL DEFAULT '{}',
  confidence   smallint CHECK (confidence BETWEEN 0 AND 100),
  -- The matched spans, for tuning the filter without re-reading private chats.
  matched_spans jsonb,
  reviewed_by  uuid REFERENCES app_user(id) ON DELETE SET NULL,
  review_outcome text CHECK (review_outcome IN ('UPHELD', 'OVERTURNED', 'PENDING'))
);

CREATE INDEX message_moderation_event_message_idx ON message_moderation_event (message_id, occurred_at);
CREATE TRIGGER message_moderation_event_append_only BEFORE UPDATE OR DELETE ON message_moderation_event
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
