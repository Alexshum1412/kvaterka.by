-- Self-hosted error tracking (DEC-086).
--
-- One row per distinct failure, not per occurrence: the fingerprint is a hash
-- of where it happened and the message with ids and numbers masked out, so a
-- crash that fires a thousand times is one row with count = 1000, and the
-- watchdog in the lifecycle job can tell "something new broke" apart from
-- "the same old thing again". No request bodies, no user ids, no IPs are
-- stored — only the message a developer needs and the page it came from.
--
-- PostgreSQL 10 compatible: plain table, ON CONFLICT upsert (9.5+).

CREATE TABLE error_event (
  fingerprint  text PRIMARY KEY,
  source       text NOT NULL CHECK (source IN ('API', 'CLIENT')),
  message      text NOT NULL CHECK (length(message) <= 500),
  path         text CHECK (length(path) <= 300),
  count        integer NOT NULL DEFAULT 1 CHECK (count > 0),
  first_seen   timestamptz NOT NULL DEFAULT now(),
  last_seen    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX error_event_last_seen_idx ON error_event (last_seen DESC);
