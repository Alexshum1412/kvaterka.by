/* ==================================================================== *
 * Data lifecycle: legal holds, job runs, and the foreign keys that were
 * quietly letting history be destroyed.
 *
 * Three things happen here, and only the first is new machinery.
 *
 * 1. `legal_hold` — an explicit, audited reason not to destroy something.
 * 2. `job_run` — so a scheduled job cannot run twice at once, and so that
 *    somebody can tell whether it ran at all.
 * 3. Foreign-key repairs. `fraud_signal` cascaded from `app_user` with no
 *    append-only protection: deleting a fresh account destroyed the antifraud
 *    record of why it was suspicious, and nothing anywhere refused. That is
 *    the "delete the accusation by deleting the accused" path, and it is the
 *    most serious finding of this slice.
 *
 * NOT DONE HERE, DELIBERATELY: no `lifecycle_state` column on any table.
 * Retention state is derived from the timestamps that already exist plus the
 * holds below (`domain/retention.ts`). A stored eligibility flag would be a
 * cached permission to destroy data — written before a hold arrived and still
 * saying "yes" afterwards. DEC-041 settled this for dispute priority; the
 * stakes here are higher, so the same answer applies with more force.
 * ==================================================================== */

/* -- 1. Legal hold --------------------------------------------------- *
 *
 * Polymorphic, following `audit_log`'s (target_type, target_id) convention
 * rather than seven nullable foreign keys.
 *
 * There is no foreign key to any target, on purpose. A hold whose subject was
 * removed would disappear exactly when it was doing its job. `placed_by` and
 * `released_by` are RESTRICT, so a staff member who has ever frozen somebody's
 * data cannot themselves be erased out of the record.
 *
 * Not append-only: releasing a hold is an UPDATE, which `forbid_mutation()`
 * would refuse. Tamper-evidence comes from `audit_log` instead, written in the
 * same transaction as both the placement and the release.
 */
CREATE TABLE legal_hold (
  id             uuid PRIMARY KEY,
  target_type    text NOT NULL CHECK (target_type IN (
                   'user', 'property', 'booking', 'dispute_case',
                   'verification_request', 'verification_document', 'conversation')),
  target_id      uuid NOT NULL,

  -- Why WE are holding. None of these asserts a legal requirement:
  -- LEGAL_QUESTION_UNRESOLVED is how an open question is named without
  -- pretending to know its answer, with the number itself in `reason`.
  reason_code    text NOT NULL CHECK (reason_code IN (
                   'DISPUTE_OPEN', 'FRAUD_INVESTIGATION', 'MODERATION_INVESTIGATION',
                   'FINANCIAL_RECONCILIATION', 'SECURITY_INVESTIGATION', 'OFFICIAL_REQUEST',
                   'LEGAL_QUESTION_UNRESOLVED', 'USER_REQUEST', 'OTHER')),
  reason         text NOT NULL CHECK (length(btrim(reason)) > 0),

  placed_by      uuid NOT NULL REFERENCES app_user(id) ON DELETE RESTRICT,
  placed_at      timestamptz NOT NULL DEFAULT now(),

  released_by    uuid REFERENCES app_user(id) ON DELETE RESTRICT,
  released_at    timestamptz,
  release_reason text,

  -- Releasing is the dangerous direction: it re-enables destruction. So it
  -- cannot happen halfway, and it cannot happen without a stated reason.
  CONSTRAINT legal_hold_release_complete CHECK (
    (released_at IS NULL) = (released_by IS NULL)
    AND (released_at IS NULL OR length(btrim(coalesce(release_reason, ''))) > 0))
);

/* One live hold per target. A second request to hold something already held is
   not an error worth surfacing to staff, but two rows would mean releasing one
   silently leaves the other — so the database refuses and the service reports
   the existing hold instead. */
CREATE UNIQUE INDEX legal_hold_active_idx ON legal_hold (target_type, target_id)
  WHERE released_at IS NULL;

/* The purge path's lookup: "is anything holding this?" */
CREATE INDEX legal_hold_lookup_idx ON legal_hold (target_type, target_id, released_at);

/* The console's list, oldest first — a hold nobody has revisited is the thing
   worth seeing, because holds that accumulate unreviewed become an accidental
   keep-everything-forever policy. */
CREATE INDEX legal_hold_review_idx ON legal_hold (placed_at) WHERE released_at IS NULL;

/* -- 2. Job runs ----------------------------------------------------- *
 *
 * `POST /admin/lifecycle/run` has existed since the completion slice and has
 * no record that it ran, no protection against running twice, and no way to
 * answer "did the nightly job fire last night?". Adding a second such job
 * without fixing that would double the problem.
 *
 * The partial unique index below IS the mutex. Not an advisory lock: those are
 * held on one connection, and this application talks to Postgres through a
 * pool, so an advisory lock taken in one transaction is gone by the time the
 * next item is processed. A row visible to every connection both excludes the
 * second runner and tells an operator what is happening.
 */
CREATE TABLE job_run (
  id           uuid PRIMARY KEY,
  job_name     text NOT NULL,
  status       text NOT NULL DEFAULT 'RUNNING'
                 CHECK (status IN ('RUNNING', 'SUCCEEDED', 'FAILED', 'ABANDONED')),
  started_at   timestamptz NOT NULL DEFAULT now(),
  finished_at  timestamptz,
  -- Counters rather than a free-text log: they can be graphed, and they cannot
  -- accidentally accumulate personal data the way a message would.
  processed    integer NOT NULL DEFAULT 0 CHECK (processed >= 0),
  skipped      integer NOT NULL DEFAULT 0 CHECK (skipped  >= 0),
  failed       integer NOT NULL DEFAULT 0 CHECK (failed   >= 0),
  -- Identifiers and step names only. Never a storage key, never a document.
  detail       jsonb,
  triggered_by uuid REFERENCES app_user(id) ON DELETE SET NULL,

  CONSTRAINT job_run_finished_complete CHECK (
    (status = 'RUNNING') = (finished_at IS NULL))
);

CREATE UNIQUE INDEX job_run_one_active_idx ON job_run (job_name) WHERE status = 'RUNNING';
CREATE INDEX job_run_history_idx ON job_run (job_name, started_at DESC);

/* -- 3. Purge bookkeeping on documents -------------------------------- *
 *
 * Destroying bytes in object storage and committing a database row cannot be
 * one transaction. The order is forced by which failure is recoverable:
 *
 *   row gone, bytes remain  -> nothing remembers the key. Unrecoverable leak.
 *   row remains, bytes gone -> the read route already refuses. Harmless.
 *
 * So: claim the row (`purge_started_at`), destroy the bytes, then confirm
 * (`purged_at`). `purged_at` is not a request to purge — it is an assertion
 * that the bytes are gone, and it must never be written before that is true.
 *
 * A row with `purge_started_at` set and `purged_at` still NULL is a purge that
 * did not finish. The next run retries it; the console shows it if it stays
 * that way.
 */
ALTER TABLE verification_document ADD COLUMN purge_started_at timestamptz;

CREATE INDEX verification_document_stuck_purge_idx ON verification_document (purge_started_at)
  WHERE purge_started_at IS NOT NULL AND purged_at IS NULL;

/* `storage_key` is deliberately NOT cleared on purge. It is NOT NULL with a
   `private/%` CHECK (0012), the read route already refuses on `purged_at`, and
   the public media route refuses every `private/` key unconditionally. Keeping
   it is the only record of WHICH object was destroyed — evidence, at no cost. */

/* -- 4. Foreign keys that let history be destroyed -------------------- *
 *
 * `fraud_signal` is the serious one. All three of its parents cascade, and
 * unlike every other table holding an accusation it has no append-only
 * trigger. A newly-created account with a fraud signal and nothing else could
 * be deleted outright, taking the signal with it silently.
 *
 * `verification_request` cascaded from `app_user` and `property` too. That one
 * is subtler: it only destroyed history when the request had no
 * `verification_event` rows yet, because once it has any, the append-only
 * trigger fires during the cascade and aborts the whole statement. So the
 * protection existed but depended on whether an event happened to have been
 * written — an accident, not a guarantee. RESTRICT makes it a guarantee, and
 * makes the refusal a clear foreign-key error rather than a `restrict_violation`
 * raised from inside a trigger three tables away.
 */
ALTER TABLE fraud_signal DROP CONSTRAINT fraud_signal_user_id_fkey;
ALTER TABLE fraud_signal ADD CONSTRAINT fraud_signal_user_id_fkey
  FOREIGN KEY (user_id) REFERENCES app_user(id) ON DELETE RESTRICT;

ALTER TABLE fraud_signal DROP CONSTRAINT fraud_signal_property_id_fkey;
ALTER TABLE fraud_signal ADD CONSTRAINT fraud_signal_property_id_fkey
  FOREIGN KEY (property_id) REFERENCES property(id) ON DELETE RESTRICT;

ALTER TABLE fraud_signal DROP CONSTRAINT fraud_signal_booking_id_fkey;
ALTER TABLE fraud_signal ADD CONSTRAINT fraud_signal_booking_id_fkey
  FOREIGN KEY (booking_id) REFERENCES booking(id) ON DELETE RESTRICT;

ALTER TABLE verification_request DROP CONSTRAINT verification_request_user_id_fkey;
ALTER TABLE verification_request ADD CONSTRAINT verification_request_user_id_fkey
  FOREIGN KEY (user_id) REFERENCES app_user(id) ON DELETE RESTRICT;

ALTER TABLE verification_request DROP CONSTRAINT verification_request_property_id_fkey;
ALTER TABLE verification_request ADD CONSTRAINT verification_request_property_id_fkey
  FOREIGN KEY (property_id) REFERENCES property(id) ON DELETE RESTRICT;

/* -- 5. Indexes the sweeps need --------------------------------------- *
 *
 * `user_session_expiry_idx` already covers expired sessions (0001). These two
 * are what the token and notification sweeps scan.
 */
CREATE INDEX auth_token_expiry_idx ON auth_token (expires_at);
CREATE INDEX notification_age_idx  ON notification (created_at);

/* -- 6. Account closure ----------------------------------------------- *
 *
 * `app_user.deleted_at` and `status='DELETED'` have existed since 0001 and
 * nothing has ever written either. Closing an account is being built in this
 * slice; erasing one is not, and the difference needs to be legible in the
 * data rather than only in the code.
 *
 * `closure_requested_at` records that a person asked. It is separate from
 * `deleted_at` because a request that is refused — an active booking, an open
 * dispute — must still leave a trace that it was made.
 */
ALTER TABLE app_user ADD COLUMN closure_requested_at timestamptz;

CREATE INDEX app_user_closure_idx ON app_user (closure_requested_at)
  WHERE closure_requested_at IS NOT NULL AND deleted_at IS NULL;
