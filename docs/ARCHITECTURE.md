# Архитектура kvaterka.by

Как устроена система, схема базы данных и сценарии пользователей в одном месте. Раньше это были три файла: ARCHITECTURE.md, DATABASE_DESIGN.md и USER_FLOWS.md. Там, где текст расходится с кодом, прав код (`src/server/domain/booking/states.ts`, `db/migrations/`).

## Содержание

- Архитектура
- База данных
- Пользовательские сценарии

---

## Архитектура

### 1. Shape of the system

One deployable Next.js application, one PostgreSQL database, and scheduled work driven from outside the application by a credentialed caller rather than by a worker process. Deliberately not microservices — the spec warns against premature distribution (§51), and nothing here has independent scaling needs yet.

```
                    ┌──────────────────────────────────────┐
   Browser  ───────▶│  Next.js (App Router)                │
   (mobile first)   │  ├─ RSC pages: search, listing, SEO  │
                    │  ├─ Route handlers: /api/*           │
                    │  └─ Server actions: forms            │
                    └───────────────┬──────────────────────┘
                                    │  (in-process calls, no HTTP hop)
                    ┌───────────────▼──────────────────────┐
                    │  Application services                │
                    │  BookingService · ListingService     │
                    │  ReviewService  · VerificationService│
                    │  MessagingService · AdminService     │
                    │   - own the transaction boundary     │
                    │   - write audit rows in-transaction  │
                    └───────────────┬──────────────────────┘
                    ┌───────────────▼──────────────────────┐
                    │  Domain (pure, framework-free)       │
                    │  money · pricing · booking FSM       │
                    │  completion · contact-filter · trust │
                    │   - no I/O, no clock, no randomness  │
                    └───────────────┬──────────────────────┘
                    ┌───────────────▼──────────────────────┐
                    │  PostgreSQL 10.23+                   │
                    │  no extensions · no superuser        │
                    │  UTF8 + a UTF-8 locale (DEC-064)     │
                    │   - the invariants live HERE         │
                    └──────────────────────────────────────┘
        ┌─────────────────┐   ┌──────────────┐   ┌──────────────┐
        │ Object storage  │   │ Worker/cron  │   │ Telegram Bot │
        │ public / private│   │ expiry, jobs │   │ (notify only)│
        └─────────────────┘   └──────────────┘   └──────────────┘
```

### 2. Layering rule

The dependency arrow points one way only:

```
app (Next) → services → domain → (nothing)
                ↓
            db adapters
```

- **Domain** is pure TypeScript. No database, no `Date.now()` inside decision functions, no framework imports. This is why `resolveCompletion()` can be exhaustively tested across all 36 input combinations, and why the booking transition table can be asserted for structural integrity.
- **Services** own transactions. Every public method either commits everything or commits nothing, including its audit row.
- **Adapters** (`pglite.ts`, `postgres.ts`) implement one small `Db` interface. Tests and production run the same SQL through different drivers.

A domain module importing a service, or a service importing from `app/`, is an architecture bug.

### 3. Where correctness lives

The central architectural claim: **invariants belong in the database, not in application code.**

Application checks are advisory — they produce good error messages. The database constraint is the guarantee, and it keeps holding when a new code path, an admin script or a future developer forgets.

| Invariant | Enforced by |
|---|---|
| No overlapping confirmed bookings | `PRIMARY KEY (property_id, night)` on `property_occupancy` |
| No booking on landlord-blocked dates | constraint trigger `booking_calendar_block_guard` |
| No overlapping calendar blocks | the same primary key — blocks and bookings claim the same nights |
| One service fee per booking | `service_fee.booking_id UNIQUE` |
| One fee accrual per fee | unique partial index on `ledger_entry` |
| Money records never change | `forbid_mutation()` trigger |
| Audit/events never change | `forbid_mutation()` trigger |
| One review per side per rental | `UNIQUE (booking_id, author_role)` |
| Reviewer ≠ subject | CHECK |
| Tenant ≠ landlord | CHECK |
| Confirmed booking has frozen terms | CHECK |
| One cover photo per property | unique partial index |
| One live offer per booking | unique partial index |
| Idempotent booking creation | unique partial index on `(tenant_id, idempotency_key)` |

### 4. Booking state machine

`src/server/domain/booking/states.ts` holds a declarative transition table: `from × event × actor → to + effects`. `applyEvent()` is the only way a booking status changes.

Effects are **declared, not executed** by the domain. The service executes them inside the same transaction as the status change, so a state change and its consequences cannot diverge — a booking cannot become `COMPLETED` without its fee, and a fee cannot exist without the completion that justifies it.

```
INQUIRY ──REQUEST──▶ REQUESTED ──ACCEPT_REQUEST──▶ CONFIRMED
   │                     │                             │
   │                     ├─DECLINE──▶ DECLINED         ├─CHECK_IN──▶ CHECKED_IN
   │                     ├─COUNTER──▶ OFFER_PENDING    │                 │
   ├─INSTANT_BOOK────────┼─────────────────────────────┘                 │
   │                     └─EXPIRE───▶ EXPIRED          └─REACH_STAY_END──┤
   │                                                                     ▼
   └─MAKE_OFFER──▶ OFFER_PENDING ──ACCEPT_OFFER──▶ CONFIRMED   COMPLETION_PENDING
                                                                         │
                                        ┌────────────────────────────────┤
                                        ▼                ▼               ▼
                                   COMPLETED     NOT_TAKEN_PLACE     DISPUTED
                                  (fee accrues)     (no fee)        (no fee yet)
```

Calendar-blocking states: `CONFIRMED`, `CHECKED_IN`, `COMPLETION_PENDING`, `DISPUTED`, `COMPLETED`. `REQUESTED` deliberately does not block (DEC-007). `COMPLETED` stays in the set so history cannot be retroactively overlapped.

Full transition semantics, including who may trigger what, are in «Пользовательские сценарии» below.

### 5. Money flow

```
property pricing ──quote()──▶ booking (terms FROZEN at CONFIRMED)
                                   │  rent + cleaning + fixed utilities = fee_base_minor
                                   │  (deposit and metered utilities excluded)
                                   ▼
                          completion resolves to COMPLETED
                                   ▼
        service_fee (base, bps, fee)  ── UNIQUE(booking_id) ──▶ charged at most once
                                   ▼
        ledger_entry FEE_ACCRUED (negative, immutable)
                                   ▼
        landlord balance = SUM(amount_minor)   ← negative means debt
```

The fee stores all three inputs (`base_minor`, `bps`, `fee_minor`) so `verifyStoredFee()` can re-derive and check it at any point in the future. Balance is always computed from the ledger; there is no mutable balance column to drift.

### 6. Security boundaries

| Boundary | Control |
|---|---|
| Anonymous → public content | Published listings only, approximate location, no contact details |
| Authenticated → own resources | Actor resolved from the database row, never from the request body |
| Tenant ↔ landlord | Contact details released only from `CONFIRMED` onward, and the release is timestamped and audited |
| Staff → user data | Role-based; `SUPPORT` cannot reach identity documents at all |
| Staff → identity documents | `VERIFIER` role only, and every single read is written to `document_access_log` |
| Any actor → financial history | Append-only; corrections are new rows |

Identity documents and property photos live in separate object-storage buckets with different access policies (spec §54); no document is ever served from a public URL.

### 7. Asynchronous work

A worker process handles what must happen without a user present:

There is no worker process. The jobs below are permission-gated POST routes called by a scheduler, because a Next.js server may run as several short-lived instances, so an in-process timer would either never fire or fire N times. A caller with a credential is honest about who is doing the work, and the permission is auditable.

**The caller is a machine principal, not an admin account** (DEC-058). The three job permissions were always documented as machine credentials, but were held by ADMIN — and ADMIN is withheld until a second factor is satisfied, which no cron can do. `scripts/run-jobs.mjs` presents `JOB_RUNNER_TOKEN` in the `x-job-token` header; it authorises those three routes and nothing else, and reads nothing at all. With the variable unset there is no machine principal, and the jobs stay reachable only by a human holding the permission.

| Job | Route | Cadence | Effect | State |
|---|---|---|---|---|
| Open completion windows | `/admin/lifecycle/run` | daily | stay end reached → `COMPLETION_PENDING`, deadline set | **built** |
| Resolve elapsed completions | `/admin/lifecycle/run` | daily | `resolveExpiredCompletion()` on the stored evidence | **built** |
| Publish review windows | `/admin/lifecycle/run` | daily | one-sided reviews published once the window closes | **built** |
| Expired credential sweep | `/admin/retention/run` | daily | expired sessions, consumed tokens, idempotency records, rate-limit counters | **built** |
| Document retention | `/admin/retention/run` | daily | destroy documents past `purge_after` | **built, destroys nothing** — no window is ever set (LEGAL-004) and no object store exists. Both refuse independently. |
| Expire stale requests | `/admin/lifecycle/run` | hourly | `INQUIRY`/`REQUESTED`/`OFFER_PENDING` past `expires_at` → `EXPIRED`, both sides notified | **built** |
| Notification outbox | `/admin/notifications/run` | frequent | claim → send → settle, with an escalating retry | **built**; delivers IN_APP only, because no external provider is configured |
| Calendar staleness | — | daily | freshness signals, landlord reminders | **not built** |

Every job is idempotent, and two guards make that true rather than hoped for. Per item, the guards are the same database constraints the interactive paths rely on. Per run, `job_run` carries a partial unique index on `(job_name) WHERE status='RUNNING'`, so a second concurrent runner is turned away by the database rather than doing the work twice — and a run abandoned by a dead process is reclaimed after a lease. The table is also the answer to "did last night's job fire?", which nothing could answer before.

### 8. Notifications

Domain services never call an email or Telegram API directly. They write a `notification` row with a `dedupe_key`; the outbox worker delivers it. The unique index on `(user_id, channel, dedupe_key)` means a retried job cannot send the same message twice — required by spec §55, and the same discipline as the fee guard.

Telegram is a notification channel only. The canonical conversation always stays in `message`, per spec §27.

**Delivery, precisely.** A domain service writes a `notification` row and returns; the worker claims it (moving it to `SENDING`, exclusively), calls a provider with no transaction open, then settles it. That ordering is forced: a crash between the send and the settle leaves the row claimed, the lease reclaims it, and it is sent again — **at-least-once**, which is the strongest thing that can honestly be said when no provider can confirm receipt atomically with our commit.

A provider returns one of three outcomes. `DELIVERED` is the only route to `SENT`. `TRANSIENT` retries with exponential backoff and jitter. `PERMANENT` does not retry at all, because retrying an address a provider has rejected is, at scale, an accidental attack on somebody who has already said no.

**Today only `IN_APP` can reach anybody**, and it is genuinely real — the row *is* the message the inbox reads. `EMAIL` needs `SMTP_URL` and a client; `TELEGRAM` needs `TELEGRAM_BOT_TOKEN` and the bot webhook that would make `completeTelegramLink` reachable, so there are currently zero linked chats. Both refuse rather than reporting success, and a row for an unconfigured channel is never claimed — so the backlog is the honest measure of what is undelivered, and it goes out when a provider is configured.

### 9. Search and map

Deliberately no search cluster (spec §53 warns against it). PostgreSQL provides everything the MVP needs:

- **Geo**: a latitude/longitude rectangle served by a plain btree index, then haversine in plain SQL sharing its earth radius with `src/server/domain/geo.ts`. No PostGIS and no `earthdistance` dependency (DEC-063).
- **Text**: `to_tsvector('russian', …)` with a core GIN index. Typo tolerance is **gone** with `pg_trgm`, which needs a superuser the host does not grant (DEC-063).
- **Filters**: ordinary indexed columns, because amenities and rules are structured values rather than free text.

Search always queries `public_latitude/longitude` — the deterministic blurred point. The exact address is exposed only after `CONFIRMED`.

### 10. Configuration and environments

Environment variables are validated once at startup with Zod; an invalid configuration fails fast rather than surfacing as a mysterious runtime error. Secrets never enter the repository. Belarus-specific values (currency, locale, timezone, address format, legal notice text) are centralised so a second market does not require touching every subsystem (spec §5).

---

## База данных

PostgreSQL 10.23+ (CI runs a real 10.23 under a non-superuser role; PGlite runs 18.3). No extensions. Schema defined by the SQL files in `db/migrations/`, applied verbatim and in order by `src/server/db/migrator.ts`.

### Conventions

- Money is `bigint` minor units (kopecks) plus an explicit `currency` column. No `numeric`, no float, anywhere.
- Timestamps are `timestamptz`, stored UTC.
- Enumerations are `text` + `CHECK`, not native enum types: adding a value is an ordinary migration instead of a lock-heavy `ALTER TYPE`.
- Primary keys are UUIDv7 generated by the application (DEC-011); append-only log tables use `bigserial`.
- Stay periods are `daterange` with `[)` bounds — the checkout day belongs to the next tenant.
- Tables a human edits carry `created_at`/`updated_at`, maintained by the `set_updated_at()` trigger rather than by trusting application code.

### Extensions

| Extension | Purpose |
|---|---|
| ~~`btree_gist`~~ | replaced by `property_occupancy` — one row per occupied night, guarded by its primary key |
| ~~`pg_trgm`~~ | replaced by core `to_tsvector`/`plainto_tsquery` with a GIN index. **Typo tolerance was lost, not replaced** |
| ~~`citext`~~ | replaced by a unique index on `lower(email)` — the same guarantee, no extension |
| ~~`cube` + `earthdistance`~~ | replaced by a lat/lng rectangle on a btree index, then haversine in plain SQL |

### Entities

#### Identity — `0001_foundation.sql`

| Table | Notes |
|---|---|
| `app_user` | Email is `text`, with case-insensitive uniqueness enforced by a unique index on `lower(email)`. `CHECK` requires email or phone. A `COMPANY` account must carry a company name — agencies may not pose as private individuals (§4.2). `verification_level` 0–2 is *identity* assurance only. |
| `user_role` | Roles are rows, not a column: a person is routinely both tenant and landlord, and staff roles must be grantable independently. `TENANT`, `LANDLORD`, `SUPPORT`, `MODERATOR`, `VERIFIER`, `FINANCE`, `ADMIN`. |
| `user_session` | Stores a **SHA-256 of the token**, never the token. `previous_id` forms a rotation chain so replay of a rotated token is detectable. IP is stored hashed. |
| `auth_token` | Single-use tokens for verification, reset, OTP, Telegram linking. |
| `audit_log` | Append-only. Actor, target, action, JSON diff, reason, correlation id. |

#### Property — `0002_properties.sql`

| Table | Notes |
|---|---|
| `property` | The rental passport as structured columns, not free text, because critical search criteria must be filterable (§22). Holds both the exact point and a deterministic `public_latitude/longitude`; a blurred pin that moved between requests would be a de-anonymisation oracle. Duration is stored in **nights** as the single internal unit (§6). |
| `property_photo` | Unique partial index gives exactly one cover per property. `content_hash` supports stolen/duplicate-photo detection. |
| `amenity` / `property_amenity` | Controlled vocabulary with ru/be/en names. |
| `pricing_rule` | `LENGTH_OF_STAY` and `SEASONAL`, with a `CHECK` ensuring each kind carries the right fields and no others. |
| `calendar_block` | `EXCLUDE` prevents a landlord blocking the same night twice. |

Notable `property` constraints: `max_nights >= min_nights`; `floor <= total_floors`; fixed utilities amount only when `utilities_mode = 'FIXED_EXTRA'`; a `PUBLISHED` row must have `published_at`.

Indexes: partial by status for the published set; GiST over `ll_to_earth(public_*)` for radius search; GIN trigram on title; freshness index on `calendar_updated_at` for ranking.

#### Booking — `0003_bookings.sql`

`listing_snapshot` is append-only and hash-stamped: the immutable record of what the offer said when it was booked. Without it, a landlord editing their property after the fact makes any dispute unwinnable.

`booking` carries the frozen financial terms:

| Column group | Purpose |
|---|---|
| `rent_minor`, `cleaning_fee_minor`, `utilities_fixed_minor`, `deposit_minor` | the agreed components |
| `total_expected_minor` | what the tenant commits to — excludes deposit and metered utilities |
| `fee_base_minor`, `service_fee_bps` | stored so the fee stays reproducible even if pricing changes later |
| `terms_frozen_at` | a `CHECK` ties it to `confirmed_at`: a confirmed booking with unfrozen terms cannot exist |
| `nights` | maintained by the `booking_nights` BEFORE trigger — computed, never trusted from the caller. Was a generated column, which is PostgreSQL 12+ |

**The constraint that matters most:**

```sql
CREATE TABLE property_occupancy (
  property_id uuid NOT NULL REFERENCES property(id)       ON DELETE CASCADE,
  night       date NOT NULL,
  booking_id  uuid          REFERENCES booking(id)        ON DELETE CASCADE,
  block_id    uuid          REFERENCES calendar_block(id) ON DELETE CASCADE,
  PRIMARY KEY (property_id, night),
  CONSTRAINT property_occupancy_one_claimant CHECK (
    (booking_id IS NOT NULL AND block_id IS NULL) OR
    (booking_id IS NULL     AND block_id IS NOT NULL))
);
```

One row per occupied night, written only by the two triggers in
`0003_bookings.sql`. No service inserts here and none may: a service changes a
booking's status or inserts a block, and the database decides whether that was
allowed.

This replaced two `EXCLUDE USING gist` constraints and a cross-table constraint
trigger. They needed `btree_gist` — a GiST index over a uuid equality column has
no operator class in core PostgreSQL — and extensions need a superuser the
production host does not grant. Read together the three rules were one rule:
**a night on a property can be spoken for once.** Written that way it needs a
primary key.

The error did not change with the mechanism. Both triggers re-raise as SQLSTATE
`23P01` (`exclusion_violation`) carrying the constraint name the application
already caught, so every catch site and every existing test reads what it read
before. See DEC-063.

It also closed a race: placing a block over a booked night used to be checked by
a `SELECT` and then an `INSERT` in the calendar service, so a confirmation and a
block could both pass their checks and both commit. They now collide on a key.

Two concurrent transactions confirming overlapping dates cannot both commit; the loser gets SQLSTATE `23P01`, which the service translates into "these dates are taken". `REQUESTED` is absent from the predicate on purpose (DEC-007).

`booking_calendar_block_guard` is a constraint trigger, because the rule spans two tables and `EXCLUDE` cannot express it.

Supporting tables: `booking_offer` (immutable negotiation chain, unique partial index allowing at most one `PENDING` offer per booking), `booking_event` (append-only, one row per transition, with the declared effects), `stay_event` + `stay_photo` (check-in/check-out and the condition timeline, unique per booking × kind × reporter).

#### Messaging — `0004_messaging.sql`

`conversation` carries `contact_release_state` with a `CHECK` tying `RELEASED` to a timestamp, so "when did they get my number?" is always answerable.

`message` keeps both `body` (what the recipient sees, possibly redacted) and `body_original` (untouched, for moderation and evidence), with a `CHECK` that a redacted or blocked message must have kept its original.

`message_moderation_event` is append-only and records which detectors fired and where, so the filter can be tuned without anyone re-reading private conversations.

#### Trust and money — `0005_trust_and_money.sql`

**`review`** — `UNIQUE (booking_id, author_role)` is the one-review-per-side guarantee. Two `CHECK` constraints ensure each role fills in its own dimension set and none of the other's. `confirmed_facts` jsonb feeds the "guests confirmed" layer (§35). A review must reference a booking, which is how "only completed rentals produce reviews" is anchored.

**`service_fee`** — `booking_id UNIQUE` is the duplicate-fee guard. Stores `base_minor`, `bps` and `fee_minor` together so the arithmetic is auditable. A `WAIVED` fee must name who waived it and why.

**`ledger_entry`** — append-only, signed amounts, balance is `SUM(amount_minor)`; negative means the landlord owes the platform. `CHECK`s ensure `FEE_ACCRUED` is negative, credits are positive, and a manual `ADJUSTMENT` carries both a reason and an author. A unique partial index permits exactly one `FEE_ACCRUED` row per fee.

**Verification** — `verification_request`, `verification_document` (private bucket keys only; `purge_after` makes the retention policy a stored, auditable value rather than an implicit convention), and `document_access_log`, which is append-only and records every single read.

**Also here:** `dispute_case` + `case_event`, `fraud_signal` (signals with severity, never one opaque verdict), `notification` (+ `notification_preference`, `telegram_connection`) with a unique dedupe key per user × channel, `favorite` (composite PK `(user_id, property_id)` — the dedupe, which is what lets the API expose an idempotent PUT/DELETE pair with no idempotency record; DEC-025), `saved_search`, `report`, and `feature_flag` with `requires_legal_approval` for the rewards gate (DEC-015).

#### Moderation — `0009_moderation_reviews.sql`, `0010_review_cascade.sql`

**`listing_moderation_review`** — one row per moderation decision, append-only. `reason_codes text[]` is CHECK-constrained against the same vocabulary as `src/server/domain/moderation.ts`; a `REJECTED` row must carry at least one. `from_status` records what the listing was before the decision so the history still reads correctly after later transitions. The single `property.rejection_reason` column remains as the *current* reason (the dashboard and wizard read it); this table is the history behind it, and it is what lets a resubmission show a moderator what a colleague already asked for (DEC-030).

Its append-only trigger is not the shared `forbid_mutation()`: deleting a listing must be able to cascade into its history, while deleting a history row on its own must not be possible. `forbid_review_mutation()` separates those by checking whether the parent still exists (DEC-031).

**`property.submitted_at`** — the moderation queue orders by how long a landlord has actually waited, and a resubmission moves them to the back of the line. A partial index covers the pending queue.

#### Tables the completion and review slice brought into use — no migration

That slice added **no migration**. Everything it needed already existed, which is worth recording because "the schema was designed for this" is a claim that should be checkable:

**`stay_event`** — `UNIQUE (booking_id, kind, reported_by)` with `kind IN ('CHECK_IN','CHECK_OUT')`. Written for the first time by `checkIn()` and `checkOut()`; the uniqueness means a retried request adds no second piece of "evidence". The flag the completion rules actually read is still `booking.checked_in_at`, in the same transaction — this table is the trail behind that flag, not a competing source of truth (DEC-037). `stay_photo` remains unused: photo attachment is not built.

**`booking.review_deadline_at`** — added in `0006_api_support.sql` with an index over `status = 'COMPLETED'`, and never written until now. `applyResolution()` stamps it on the transition into `COMPLETED` only (DEC-035).

**`dispute_case` + `case_event`** — the category `CHECK` already carried the vocabulary the completion screen needed. One open case per booking; a second report from the other party appends a `case_event` rather than opening a second case. `resolution` stays NULL: there is no automated resolution path (DEC-036).

**`report`** — `target_type` already allowed `'REVIEW'`. Reporting a review files a row here and changes nothing about `review.status` (DEC-040).

**`review.moderation_note`** — now carries the names of the contact-filter detectors that fired on a review's free text, so a redaction is visible to `review.moderate` without the removed text being stored anywhere public (DEC-039).

#### Staff operations — `0011_dispute_operations.sql`

**`dispute_case.category`** gains `SAFETY_CONCERN`. The original vocabulary had no way to say "I do not feel safe here": the nearest options were `ACCESS_PROBLEM` (about a key) and `OTHER` (about nothing), and a safety report filed as `OTHER` queues behind a complaint about towels. Priority routing is the whole reason categories are structured, so the one category that must never be routed as ordinary feedback has to exist.

**`dispute_case.resolved_by`** is new, and a `CHECK` now requires that a terminal case carries all three of `resolution`, `resolved_at` and `resolved_by`. The first two existed but nothing required them, so a case could reach `RESOLVED` with no record of what was decided or by whom — the one thing an accountability record must not leave optional.

**`case_event.visibility`** (`INTERNAL` | `PARTIES`, defaulting to `INTERNAL`) separates what a party did from what staff wrote to each other. Without it, every read has to remember which `event_type` values are safe to show a tenant, and one forgetful join is an internal note in somebody's inbox (DEC-043). The default is the safe one, so an event type added later is invisible until somebody deliberately says otherwise. The migration backfills the existing `OPENED_BY_PARTY` rows, which required lowering the append-only trigger for one statement inside the migration's transaction — spelled out in the file rather than done quietly.

**Indexes** `dispute_case_assignee_idx` and `dispute_case_open_idx` are partial, covering the two queries the console runs on every page load: "what is assigned to me" and the open-case set the priority rule joins against.

**No priority column** — deliberately. Priority is derived from category, booking state, fraud signals and age, in `priorityOf()` and in `PRIORITY_SQL`, and a test asserts the two agree across the whole matrix (DEC-041).

#### Verification operations — `0012_verification_operations.sql`

The three verification tables existed and were well designed. What they had no room for was the operational half — and, more to the point, nothing in the product could create a row in them: `verification_request` was written only by tests, so the queue was permanently empty in production and always would have been.

**`verification_request`** gains `assigned_to`, structured `reason_codes` (CHECK-constrained against the same vocabulary as `domain/verification.ts`), `applicant_message`, `declared` for the structured ownership basis, `supersedes_id` for the resubmission chain, `submitted_at`, and the `NEEDS_INFO` status. `decision_note` is now explicitly the INTERNAL note; `applicant_message` is what the person is told (DEC-047).

**Two CHECKs the table did not have.** A decided request must carry `decided_by` and `decided_at` — for the one table whose output is a public claim about a person, "who granted this" cannot be optional. A rejection must additionally carry at least one reason code, because an unexplained refusal is a dead end for whoever receives it.

**`verification_request_one_live_idx`** is a partial unique index: one live request per user per kind per property. A double-tapped submit is not two applications for a verifier to duplicate work on, and it is scoped to the open statuses so resubmission after a refusal still works — the same shape as the booking duplicate guard (DEC-034).

**`verification_event`** is new: append-only, with the same `visibility` split and the same INTERNAL default as `case_event` (DEC-043), so an event type added later is invisible to applicants until somebody deliberately says otherwise.

**`verification_document_is_private`** requires `storage_key LIKE 'private/%'`. The media route already refuses to serve anything under `private/`; this closes the loop from the other end, so a document row cannot exist outside the namespace that route declines. Note that no document row can be created at all today — see LEGAL-004.

**No priority column**, for the same reasons as disputes (DEC-041): it is derived from the kind, whether the applicant has a listing already taking bookings, fraud signals and age, in both `verificationPriorityOf()` and `VERIFICATION_PRIORITY_SQL`.

#### Data lifecycle and holds — `0013_retention_and_holds.sql`

**`legal_hold`** is polymorphic on `(target_type, target_id)`, following `audit_log`'s convention rather than seven nullable foreign keys. It has **no foreign key to any target on purpose**: a hold whose subject was removed would disappear exactly when it was doing its job. `placed_by` and `released_by` are `RESTRICT`, so somebody who has ever frozen another person's data cannot themselves be erased out of the record. A partial unique index gives one live hold per target; a CHECK makes release atomic — `released_at`, `released_by` and a non-empty `release_reason` arrive together or not at all. It is deliberately **not** append-only, because release is an UPDATE that `forbid_mutation()` would refuse; tamper-evidence comes from `audit_log`, written in the same transaction as both the placement and the release.

**`job_run`** exists because `/admin/lifecycle/run` had shipped with no record that it ran and no guard against running twice. The partial unique index on `(job_name) WHERE status='RUNNING'` **is** the mutex — not an advisory lock, because those live on one connection and this application talks to Postgres through a pool, so a lock taken in one transaction is gone by the next item. A row is visible to every connection, excludes the second runner, survives a restart, and answers "did last night's job fire?". A run abandoned by a dead process is reclaimed after a lease. `detail` holds counters and step names only — never a storage key.

**`verification_document.purge_started_at`** exists because destroying an object and committing a row cannot be one transaction, and only one ordering is recoverable. Claim (`purge_started_at`), destroy the bytes, confirm (`purged_at`). `purged_at` is an assertion that the bytes are gone, never a request to purge — see DEC-051. A row where the first is set and the second is not is a purge that did not finish; the next run retries it and the console shows it.

**Foreign keys retargeted to RESTRICT.** `fraud_signal` cascaded from `app_user`, `property` and `booking`, and alone among the tables holding an accusation it had no append-only trigger — so deleting a fresh account destroyed the antifraud record of why it was suspicious, and nothing refused. `verification_request` cascaded from `app_user` and `property` too; that one only destroyed history when the request had no `verification_event` rows yet, because once it has any, the append-only trigger fires during the cascade and aborts. The protection existed and depended on whether an event happened to have been written. Both are now guarantees rather than accidents, and the refusal is a legible foreign-key error instead of a `restrict_violation` raised from inside a trigger three tables away.

**`app_user.closure_requested_at`** is separate from `deleted_at` so that a closure request which is refused — an active booking, an open dispute — still leaves a trace that it was made.

**No `lifecycle_state` column on any table.** Retention state is derived from the timestamps that already exist plus the holds (DEC-050). A stored eligibility flag would be a cached permission to destroy data, written before a hold arrived and still true afterwards.

### Append-only tables

`audit_log`, `ledger_entry`, `booking_event`, `listing_snapshot`, `case_event`, `verification_event`, `document_access_log`, `message_moderation_event`, and `listing_moderation_review` via the cascade-aware variant (DEC-031).

Each carries a `BEFORE UPDATE OR DELETE` trigger raising `restrict_violation`. This holds against the application, against an admin tool, and against a manual `UPDATE` at a psql prompt. `TRUNCATE` is not blocked by row triggers, which is what makes the test reset fast.

**A cascade into one of these aborts the parent delete**, because a row trigger fires during a cascade exactly as it does on a direct delete. Five of them sit behind an `ON DELETE CASCADE`: `document_access_log`→`verification_document`, `verification_event`→`verification_request`, `case_event`→`dispute_case`, `booking_event`→`booking`, `message_moderation_event`→`message`. This was verified against a real database, and `0010_review_cascade.sql` records the same behaviour being discovered on a sixth.

That is why **purging is an UPDATE and never a DELETE** (DEC-051): a delete-based purge would fail on exactly the records that matter most, and `verification_document` already carried `purged_at` — a row that records its own purge cannot be a row that was removed. The remaining cascades are left untouched because nothing hard-deletes those parents; the decision not to generalise DEC-031 to them is recorded rather than left to be re-derived.

### Migrations

Filenames are `NNNN_name.sql`, applied in order, each in its own transaction, recorded in `schema_migration` with a SHA-256 checksum. Editing an already-applied migration is refused with an explicit error rather than allowed to diverge from production. The full schema builds from empty in ~4s under PGlite, asserted by a test.

---

## Пользовательские сценарии

Transition semantics are defined by the table in `src/server/domain/booking/states.ts`; this document is its readable form. Where they disagree, the code is authoritative — and the tests will say so.

---

### 1. Booking transitions

| From | Event | Actor | To | Effects |
|---|---|---|---|---|
| INQUIRY | REQUEST | Tenant | REQUESTED | notify landlord |
| INQUIRY | INSTANT_BOOK | Tenant | CONFIRMED | freeze terms, hold calendar, auto-decline competitors, release contacts, notify both |
| INQUIRY | MAKE_OFFER | Tenant/Landlord | OFFER_PENDING | notify both |
| INQUIRY | WITHDRAW / EXPIRE | Tenant / System | WITHDRAWN / EXPIRED | — |
| REQUESTED | ACCEPT_REQUEST | Landlord | CONFIRMED | freeze terms, hold calendar, auto-decline competitors, release contacts, notify tenant |
| REQUESTED | DECLINE_REQUEST | Landlord | DECLINED | notify tenant |
| REQUESTED | COUNTER_OFFER | Landlord | OFFER_PENDING | notify tenant |
| REQUESTED | WITHDRAW | Tenant | WITHDRAWN | notify landlord |
| REQUESTED | EXPIRE | System | EXPIRED | notify both |
| OFFER_PENDING | COUNTER_OFFER | Tenant/Landlord | OFFER_PENDING | notify both |
| OFFER_PENDING | ACCEPT_OFFER | Tenant/Landlord | CONFIRMED | freeze terms, hold calendar, auto-decline competitors, release contacts |
| OFFER_PENDING | DECLINE_REQUEST | Landlord | DECLINED | notify tenant |
| CONFIRMED | CHECK_IN | Tenant | CHECKED_IN | notify landlord |
| CONFIRMED | CANCEL_BY_TENANT | Tenant | CANCELLED_BY_TENANT | release calendar |
| CONFIRMED | CANCEL_BY_LANDLORD | Landlord | CANCELLED_BY_LANDLORD | release calendar, **fraud signal** |
| CONFIRMED / CHECKED_IN | REACH_STAY_END | System | COMPLETION_PENDING | notify both |
| CONFIRMED / CHECKED_IN / COMPLETION_PENDING | OPEN_DISPUTE | Tenant/Landlord | DISPUTED | notify admin |
| COMPLETION_PENDING | CONFIRM_COMPLETION | Tenant/Landlord | COMPLETION_PENDING | records one answer |
| COMPLETION_PENDING | RESOLVE_COMPLETION | System | COMPLETED | **accrue fee**, open reviews |
| COMPLETION_PENDING | RESOLVE_COMPLETION | System | NOT_TAKEN_PLACE | release calendar, no fee |
| COMPLETION_PENDING | RESOLVE_COMPLETION | System | DISPUTED | notify admin, no fee |
| DISPUTED | RESOLVE_DISPUTE_AS_* | **Admin only** | COMPLETED / NOT_TAKEN_PLACE / CANCELLED_BY_LANDLORD | per outcome |

A landlord cancellation always emits a fraud signal — it is the failure mode that damages tenants most, and it must feed trust scoring even when a single instance is innocent.

---

### 2. Tenant: search → stay → review

1. **Search** — city, dates, filters, or a map area. Sees approximate pins, total prices, verification badges. No account needed.
2. **Listing** — full rental passport, honest price breakdown (mandatory charges summed; metered utilities shown separately as variable), house rules, reviews, landlord trust profile. Exact address **not** shown.
3. **Contact or book** — messaging requires an account. Contact details are filtered until confirmation, with the reason stated in plain language.
4. **Request or instant book** — request does not hold the calendar; instant booking confirms immediately or fails with "these dates are taken".
5. **Confirmed** — terms frozen. Exact address and contact details released; the release is timestamped and audited.
6. **Check-in** — confirm arrival, optionally attach condition photos.
7. **Stay ends** — completion window opens; both parties asked whether the rental took place.
8. **Completion** — confirming completes the rental; the tenant's answer is decisive after the deadline because the tenant has no fee exposure.
9. **Review** — structured, one per side, published when both submit or on timeout.

### 3. Landlord: listing → income

1. **Create listing** — type, address, precision, photos (1 minimum), passport fields, amenities, rules, duration range, pricing, calendar, booking mode.
2. **Moderation** — approved or rejected with a reason.
3. **Published** — appears in search; freshness affects ranking.
4. **Requests** — accept, decline or counter. Accepting auto-declines overlapping competitors, each told why.
5. **Stay** — calendar held; chat available with contacts released.
6. **Completion** — confirm whether the rental happened. Confirming "yes" is an admission of the fee and is trusted immediately; silence does not avoid the fee if the tenant confirms.
7. **Fee** — 5% of the frozen base becomes a payable debt; balance goes negative.
8. **Debt** — restricts *new* commercial activity (new listings, accepting new bookings, promotion). It never interferes with an active booking, because punishing a landlord mid-stay punishes their tenant.

### 4. Completion decision table

| Tenant | Landlord | Deadline | Outcome | Fee | Signal |
|---|---|---|---|---|---|
| took place | took place | any | COMPLETED | yes | — |
| did not | did not | any | NOT_TAKEN_PLACE | no | — |
| took place | did not | any | DISPUTED | no | contradiction |
| did not | took place | any | DISPUTED | no | contradiction |
| — | took place | any | COMPLETED | yes | — (admission against interest) |
| took place | — | passed | COMPLETED | yes | — |
| did not | — | passed | NOT_TAKEN_PLACE | no | — |
| — | did not | passed | NOT_TAKEN_PLACE | no | **unilateral landlord denial** |
| — | — | passed, check-in exists | COMPLETED | yes | — |
| — | — | passed, no evidence | NOT_TAKEN_PLACE | no | silent, no evidence |
| any single answer | — | not passed | still pending | no | — |

### 5. Admin

Moderation queue → decision with reason → audited. Verification queue → `VERIFIER` opens documents (every read logged) → decision → level updated. Disputes → evidence review → resolution, which is the only path that can move a booking out of `DISPUTED`. Every administrative action writes an audit row with actor, target, diff and reason.

### 6. Telegram linking

User requests linking → single-use token in `auth_token` → user confirms in the bot → `telegram_connection` created → per-category preferences apply. Unlinking is immediate. Telegram carries notifications only; the conversation itself never leaves the platform.
