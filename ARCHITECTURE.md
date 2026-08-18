# ARCHITECTURE.md

## 1. Shape of the system

One deployable Next.js application, one PostgreSQL database, one worker process for scheduled work. Deliberately not microservices — the spec warns against premature distribution (§51), and nothing here has independent scaling needs yet.

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
                    │  PostgreSQL 16+                      │
                    │  btree_gist · pg_trgm · citext       │
                    │  cube · earthdistance                │
                    │   - the invariants live HERE         │
                    └──────────────────────────────────────┘
        ┌─────────────────┐   ┌──────────────┐   ┌──────────────┐
        │ Object storage  │   │ Worker/cron  │   │ Telegram Bot │
        │ public / private│   │ expiry, jobs │   │ (notify only)│
        └─────────────────┘   └──────────────┘   └──────────────┘
```

## 2. Layering rule

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

## 3. Where correctness lives

The central architectural claim: **invariants belong in the database, not in application code.**

Application checks are advisory — they produce good error messages. The database constraint is the guarantee, and it keeps holding when a new code path, an admin script or a future developer forgets.

| Invariant | Enforced by |
|---|---|
| No overlapping confirmed bookings | `EXCLUDE USING gist` on `booking` |
| No booking on landlord-blocked dates | constraint trigger `booking_calendar_block_guard` |
| No overlapping calendar blocks | `EXCLUDE USING gist` on `calendar_block` |
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

## 4. Booking state machine

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

Full transition semantics, including who may trigger what, are in [USER_FLOWS.md](USER_FLOWS.md).

## 5. Money flow

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

## 6. Security boundaries

| Boundary | Control |
|---|---|
| Anonymous → public content | Published listings only, approximate location, no contact details |
| Authenticated → own resources | Actor resolved from the database row, never from the request body |
| Tenant ↔ landlord | Contact details released only from `CONFIRMED` onward, and the release is timestamped and audited |
| Staff → user data | Role-based; `SUPPORT` cannot reach identity documents at all |
| Staff → identity documents | `VERIFIER` role only, and every single read is written to `document_access_log` |
| Any actor → financial history | Append-only; corrections are new rows |

Identity documents and property photos live in separate object-storage buckets with different access policies (spec §54); no document is ever served from a public URL.

## 7. Asynchronous work

A worker process handles what must happen without a user present:

There is no worker process. Both jobs below are permission-gated POST routes called by a cron, because a Next.js server may run as several short-lived instances, so an in-process timer would either never fire or fire N times. A cron with a credential is honest about who is doing the work, and the permission is auditable.

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

## 8. Notifications

Domain services never call an email or Telegram API directly. They write a `notification` row with a `dedupe_key`; the outbox worker delivers it. The unique index on `(user_id, channel, dedupe_key)` means a retried job cannot send the same message twice — required by spec §55, and the same discipline as the fee guard.

Telegram is a notification channel only. The canonical conversation always stays in `message`, per spec §27.

**Delivery, precisely.** A domain service writes a `notification` row and returns; the worker claims it (moving it to `SENDING`, exclusively), calls a provider with no transaction open, then settles it. That ordering is forced: a crash between the send and the settle leaves the row claimed, the lease reclaims it, and it is sent again — **at-least-once**, which is the strongest thing that can honestly be said when no provider can confirm receipt atomically with our commit.

A provider returns one of three outcomes. `DELIVERED` is the only route to `SENT`. `TRANSIENT` retries with exponential backoff and jitter. `PERMANENT` does not retry at all, because retrying an address a provider has rejected is, at scale, an accidental attack on somebody who has already said no.

**Today only `IN_APP` can reach anybody**, and it is genuinely real — the row *is* the message the inbox reads. `EMAIL` needs `SMTP_URL` and a client; `TELEGRAM` needs `TELEGRAM_BOT_TOKEN` and the bot webhook that would make `completeTelegramLink` reachable, so there are currently zero linked chats. Both refuse rather than reporting success, and a row for an unconfigured channel is never claimed — so the backlog is the honest measure of what is undelivered, and it goes out when a provider is configured.

## 9. Search and map

Deliberately no search cluster (spec §53 warns against it). PostgreSQL provides everything the MVP needs:

- **Geo**: `earthdistance` over `ll_to_earth(public_latitude, public_longitude)` with a GiST index — bounding box first (index-assisted), then exact distance. No PostGIS dependency.
- **Text**: `to_tsvector('russian', …)` plus `pg_trgm` for typo tolerance (both verified working).
- **Filters**: ordinary indexed columns, because amenities and rules are structured values rather than free text.

Search always queries `public_latitude/longitude` — the deterministic blurred point. The exact address is exposed only after `CONFIRMED`.

## 10. Configuration and environments

Environment variables are validated once at startup with Zod; an invalid configuration fails fast rather than surfacing as a mysterious runtime error. Secrets never enter the repository. Belarus-specific values (currency, locale, timezone, address format, legal notice text) are centralised so a second market does not require touching every subsystem (spec §5).
