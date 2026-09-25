-- The watchdog's NOTIFICATION_FAILURES check (watchdog.ts, DEC-086) counts
-- failures by `coalesce(claimed_at, created_at)` over the last day. Nothing
-- indexed that, so every lifecycle sweep and every admin view of /staff read
-- the whole notification table: 58 ms at 1M rows on PostgreSQL, growing with
-- it. Partial on FAILED, which stays a small fraction of the outbox; with the
-- index the same count is an index range scan (0.2 ms at 1M rows).

CREATE INDEX notification_failed_idx ON notification ((coalesce(claimed_at, created_at))) WHERE status = 'FAILED';
