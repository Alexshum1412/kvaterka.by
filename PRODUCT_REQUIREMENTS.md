# PRODUCT_REQUIREMENTS.md

Traceability from the master specification to implementation. Status vocabulary per spec §75: **NOT STARTED · IN PROGRESS · IMPLEMENTED · TESTED · AUDITED · BLOCKED**.

`TESTED` means automated tests exist and pass. `IMPLEMENTED` means the code exists but is not yet covered by tests. Nothing is marked on the strength of a UI existing.

---

## AUTH — Accounts and access

| ID | Requirement | Acceptance criteria | Status |
|---|---|---|---|
| AUTH-001 | Registration by email or phone | Account creatable with either; DB rejects an account with neither | TESTED (schema) |
| AUTH-002 | Password hashing with a modern algorithm | argon2id, verified working on the target platform | IN PROGRESS |
| AUTH-003 | Session management with rotation | Token stored as SHA-256; rotation chain via `previous_id`; expiry enforced | NOT STARTED (schema TESTED) |
| AUTH-004 | Email/phone verification | Single-use tokens with expiry and attempt counting | NOT STARTED (schema TESTED) |
| AUTH-005 | Secure password reset | Single-use, expiring, invalidates sessions | NOT STARTED |
| AUTH-006 | Brute-force and rate limiting | Per-account and per-IP limits on auth endpoints | NOT STARTED |
| AUTH-007 | Admin 2FA | Staff roles require a second factor | NOT STARTED |
| AUTH-008 | RBAC least privilege | 7 roles; `SUPPORT` cannot reach identity documents | IN PROGRESS (roles modelled) |
| AUTH-009 | Guest browsing | Published listings readable without an account | NOT STARTED |
| AUTH-010 | Company accounts identify as companies | `COMPANY` without a company name is rejected by the DB | TESTED |

## LIST — Listings

| ID | Requirement | Acceptance criteria | Status |
|---|---|---|---|
| LIST-001 | Structured rental passport | Type, area, rooms, floor, beds, baths, capacity as typed columns | TESTED (schema) |
| LIST-002 | Creation flow, minimum 1 photo | Publishable with one photo; quality nudges optional | NOT STARTED |
| LIST-003 | Moderation before publication | `DRAFT → PENDING_MODERATION → PUBLISHED`; rejection carries a reason | NOT STARTED (schema TESTED) |
| LIST-004 | Photos with ordering and one cover | DB permits exactly one cover per property | TESTED |
| LIST-005 | Standardised amenities and rules | Controlled vocabulary, filterable | TESTED (schema) |
| LIST-006 | Duration range per listing | min/max nights; `max >= min` enforced | TESTED |
| LIST-007 | Approximate vs exact location | Deterministic public point; exact address only from `CONFIRMED` | TESTED (schema) |
| LIST-008 | Freshness signals | `calendar_updated_at` / `content_updated_at` maintained and indexed | TESTED (schema) |
| LIST-009 | Immutable snapshot at booking time | Snapshot captured and append-only | TESTED |

## PRICE — Pricing and transparency

| ID | Requirement | Acceptance criteria | Status |
|---|---|---|---|
| PRICE-001 | Fixed pricing per night or month | Monthly bills 30-night months exactly (DEC-012) | TESTED |
| PRICE-002 | Tiered pricing by length of stay | Correct tier selected; base used when none matches | TESTED |
| PRICE-003 | Seasonal pricing | Applied night by night; straddling stays split correctly | TESTED |
| PRICE-004 | Total price with no hidden fees | Mandatory charges sum exactly to the stated total | TESTED |
| PRICE-005 | Variable costs labelled, not hidden | Metered utilities appear as a zero-valued variable line | TESTED |
| PRICE-006 | Deposit excluded from total and fee base | Refundable, so neither | TESTED |
| PRICE-007 | Terms immutable after confirmation | Later property edits do not change a confirmed booking | TESTED |
| PRICE-008 | Negotiation / make an offer | Immutable offer chain; at most one live offer | IMPLEMENTED (schema + FSM); service NOT STARTED |

## BOOK — Booking

| ID | Requirement | Acceptance criteria | Status |
|---|---|---|---|
| BOOK-001 | Explicit state machine | Declarative table; `applyEvent()` the only mutator | TESTED |
| BOOK-002 | Instant booking | Straight to `CONFIRMED` where the listing allows it | TESTED |
| BOOK-003 | Request to book | Landlord accepts/declines/counters | TESTED |
| BOOK-004 | **No double booking under concurrency** | DB `EXCLUDE`; second overlapping confirmation fails | TESTED (constraint) / **PENDING real-server concurrency run** |
| BOOK-005 | Back-to-back stays allowed | Checkout day bookable by the next tenant | TESTED |
| BOOK-006 | Competing requests auto-declined | Losers declined with a stated reason in the same transaction | TESTED |
| BOOK-007 | Idempotent creation | Retry with the same key returns the original booking | TESTED |
| BOOK-008 | Cancellation frees the calendar | Cancelled dates immediately re-bookable | TESTED |
| BOOK-009 | Duration and guest limits enforced | Out-of-range requests rejected with a specific code | TESTED |
| BOOK-010 | Check-in / check-out records | One per booking × kind × reporter, with photos | TESTED (both, via `stay_event`); photo attachment NOT STARTED |
| BOOK-012 | A stay reaches the completion window | Tenant check-out, or the scheduled sweep (DEC-037) | TESTED |
| BOOK-013 | Either party can report a problem instead of answering | Opens a `dispute_case`; no automatic resolution (DEC-036) | TESTED |
| BOOK-011 | Request expiry | Unanswered requests expire on a schedule | IMPLEMENTED (FSM + index); worker NOT STARTED |

## FEE — Service fee and landlord debt

| ID | Requirement | Acceptance criteria | Status |
|---|---|---|---|
| FEE-001 | 5% of the final agreed amount | 1000 BYN → 50.00 BYN exactly | TESTED |
| FEE-002 | No floating point anywhere | Integer kopecks; `money()` rejects fractional numbers | TESTED |
| FEE-003 | Deterministic, reproducible rounding | Half away from zero; identical across 1000 evaluations | TESTED |
| FEE-004 | **Never charged twice** | Three independent guards; retries create nothing | TESTED |
| FEE-005 | Fee only on a completed rental | Only the `→ COMPLETED` transition accrues | TESTED |
| FEE-006 | Immutable ledger | Update/delete rejected by trigger | TESTED |
| FEE-007 | Balance from the ledger | `SUM(amount_minor)`; no mutable balance column | TESTED |
| FEE-008 | Auditable fee | `base`, `bps`, `fee` stored; `verifyStoredFee()` re-derives | TESTED |
| FEE-009 | Debt restricts new commercial activity, not active rentals | Restrictions must not harm a live booking | TESTED |
| FEE-010 | Reminders, grace period, admin override | With audit and reason | NOT STARTED |

## COMPLETE — Two-sided completion

| ID | Requirement | Acceptance criteria | Status |
|---|---|---|---|
| COMPLETE-001 | Both parties confirm | Agreement completes or voids the rental | TESTED |
| COMPLETE-002 | Contradiction escalates | `DISPUTED`, no fee | TESTED |
| COMPLETE-003 | Landlord silence cannot avoid the fee | Tenant's confirmation completes after the deadline | TESTED |
| COMPLETE-004 | Landlord admission trusted immediately | Completes without waiting | TESTED |
| COMPLETE-005 | Lone landlord denial flagged | Honoured + `UNILATERAL_LANDLORD_DENIAL` signal | TESTED |
| COMPLETE-006 | No debt without evidence | Total silence + no check-in → no fee | TESTED |
| COMPLETE-007 | Answers are final | Changing a submitted answer rejected | TESTED |

## CHAT — Messaging and anti-off-platform

| ID | Requirement | Acceptance criteria | Status |
|---|---|---|---|
| CHAT-001 | Internal chat with booking context | Text, images, system messages, unread state | NOT STARTED (schema TESTED) |
| CHAT-002 | Phone numbers detected | 10 real-world formats incl. spaced and symbol-separated | TESTED |
| CHAT-003 | Emails detected, including obfuscated | `(собака)`, `at … dot …` | TESTED |
| CHAT-004 | Messengers, handles, links detected | Telegram/Viber/WhatsApp, `@handle`, `t.me`, bare domains, "точка бай" | TESTED |
| CHAT-005 | Obfuscation resisted | Zero-width chars, Cyrillic homoglyphs, spelled-out digits (ru + be) | TESTED |
| CHAT-006 | **No false positives on normal chat** | 24-message ru/be corpus passes untouched | TESTED |
| CHAT-007 | Redact rather than swallow | Message delivered minus the contact, sender told why | TESTED |
| CHAT-008 | Contact release at the right stage | Released only from `CONFIRMED`; timestamped and audited | TESTED |
| CHAT-009 | Moderation trail | Detectors, confidence and spans recorded, append-only | IMPLEMENTED (schema) |

## REV — Reviews

| ID | Requirement | Acceptance criteria | Status |
|---|---|---|---|
| REV-001 | Two-sided reviews | Tenant→landlord and landlord→tenant | TESTED |
| REV-002 | Only after a completed rental | FK to booking; window opens on completion | TESTED |
| REV-003 | One per side per rental | DB unique constraint | TESTED |
| REV-004 | Structured dimensions per role | Each role's own set enforced by CHECK | TESTED |
| REV-005 | Anti-retaliation publication | Publish when both submit, or on timeout | TESTED |
| REV-006 | Cannot review yourself | CHECK | TESTED |
| REV-007 | Guest-confirmed facts | `confirmed_facts` feeds the evidence layer | TESTED |
| REV-008 | Review text is contact-filtered | Same filter as chat; redaction recorded (DEC-039) | TESTED |
| REV-009 | Published reviews are immutable; reporting does not hide | Report queues for `review.moderate` (DEC-040) | TESTED |

## VERIFY / TRUST

| ID | Requirement | Acceptance criteria | Status |
|---|---|---|---|
| VERIFY-001 | Levels 0/1/2 | Phone+email → identity → identity + property | IMPLEMENTED (schema) |
| VERIFY-002 | Property verification separate from identity | Distinct fields and badges | TESTED (schema) |
| VERIFY-003 | Documents encrypted and access-controlled | Private bucket, `VERIFIER` role only | NOT STARTED (schema TESTED) |
| VERIFY-004 | Every document read logged | Append-only access log | TESTED (schema) |
| VERIFY-005 | Retention and purge | `purge_after` per document, job-enforced | NOT STARTED |
| TRUST-001 | Behaviour-based trust score | Documented, gameable-resistant, cold-start handled | NOT STARTED |
| TRUST-002 | Trust cannot be bought | Paid promotion separate from organic ranking | NOT STARTED |
| TRUST-003 | Public profile reflects completed activity, and only that | Counts and rating update on completion; no contact details, no counterparties | TESTED |

## SEARCH / ADMIN / NOTIFY / LEGAL

| ID | Requirement | Acceptance criteria | Status |
|---|---|---|---|
| SEARCH-001 | Radius/geo search | `earthdistance` + GiST; correct inclusion/exclusion | TESTED (query level) |
| SEARCH-002 | Russian full-text with typo tolerance | Stemming + trigram similarity | TESTED (query level) |
| SEARCH-003 | Structured filters | Amenities, rules, price, duration, verification | NOT STARTED |
| SEARCH-004 | Map search with clustering and bounds | Mobile-first | NOT STARTED |
| ADMIN-001 | Admin panel exists in MVP | Moderation, verification, cases, users, flags | NOT STARTED |
| ADMIN-002 | All admin actions audited | Actor, target, diff, reason | IMPLEMENTED (mechanism) |
| ADMIN-003 | No manual DB edits for business operations | Every operation has an audited code path | IN PROGRESS |
| NOTIFY-001 | In-app / email / Telegram | Preferences per category and channel | NOT STARTED (schema TESTED) |
| NOTIFY-002 | Idempotent delivery | Dedupe key unique per user × channel | TESTED (schema) |
| NOTIFY-003 | Telegram is notifications only | Canonical history stays on-platform | IMPLEMENTED (by design) |
| LEGAL-001 | Legal risk register exists | Every topic with confidence and lawyer-review flag | IMPLEMENTED — see [LEGAL_RISK_REGISTER.md](LEGAL_RISK_REGISTER.md) |
| LEGAL-002 | Rewards/lottery gated | Feature flag with `requires_legal_approval`; no prize logic | IMPLEMENTED (DEC-015) |
| LEGAL-003 | Belarus legal verification | **BLOCKED** — requires a Belarus-qualified lawyer | BLOCKED |

## UX

| ID | Requirement | Acceptance criteria | Status |
|---|---|---|---|
| UX-001 | Mobile-first critical flows | Search, map, listing, booking, chat, calendar, check-in, review | NOT STARTED |
| UX-002 | Accessibility baseline | Keyboard, labels, semantics, contrast, focus, touch targets | NOT STARTED |
| UX-003 | Loading / empty / error states | Every async surface | NOT STARTED |
| UX-004 | Original design language | Not an Airbnb clone; own identity | NOT STARTED |
| UX-005 | Errors never leak internals | Stable codes, safe messages, correlation id | IMPLEMENTED (`errors.ts`) |

---

## Reconciliation — tenant journey slice (2026-08-17)

The status table above is **stale in parts**: several rows still read `NOT STARTED`
for things that have since shipped and are covered by tests. Rather than sweep the
whole table on the strength of a UI existing — which the status vocabulary
explicitly forbids — only the rows this slice's tests actually prove are restated
here. Everything else keeps its old value until someone verifies it row by row.

Verified by `tests/tenant-journey.integration.test.ts` (30 tests) and
`tests/moderation.integration.test.ts` (32 tests):

| ID | Restated status | Evidence |
|---|---|---|
| AUTH-009 | TESTED | anonymous search returns published listings; anonymous booking is 401 |
| LIST-002 | TESTED | wizard creates from a property type alone; submit refuses without a photo |
| LIST-003 | TESTED | `DRAFT → PENDING_MODERATION → PUBLISHED`, rejection carries structured reasons |
| BOOK-001 | TESTED | request creates `REQUESTED` without holding the calendar |
| BOOK-002 | TESTED | landlord accept confirms and holds the dates; decline frees them |
| BOOK-003 | TESTED | two tenants may request the same nights; only one confirmation succeeds |
| BOOK-004 | TESTED | idempotent with a key, and with none (DEC-034) |
| PRICE-001 | TESTED | quote returns integer minor units for the real stay |

Not implemented in that slice, and deliberately not restated there: payment
processing, escrow, reviews (the write path), completion beyond the existing FSM
states, and `PRICE-008` negotiation.

## Status reconciliation — the completion and review slice

Verified by `tests/completion-reviews.integration.test.ts` (56 tests) over the
real dispatcher, plus a browser walkthrough of the same journey. Only rows this
suite actually exercises are restated:

| ID | Restated status | Evidence |
|---|---|---|
| BOOK-010 | TESTED | check-in and check-out each write one `stay_event` per reporter; a retry is a no-op |
| BOOK-012 | TESTED | tenant check-out and the `lifecycle.run` sweep both reach `COMPLETION_PENDING`; neither completes a booking |
| BOOK-013 | TESTED | a report opens one `dispute_case`, freezes the fee, and leaves `resolution` NULL |
| FEE-001 | TESTED | 480.00 BYN base → 24.00 BYN; 99.99 → 5.00 with half-up rounding |
| FEE-004 | TESTED | three repeated confirmations produce one `service_fee` and one ledger accrual |
| FEE-005 | TESTED | `NOT_TAKEN_PLACE` and `DISPUTED` accrue nothing; silence with no check-in record accrues nothing |
| FEE-009 | TESTED | a restricted landlord cannot accept a NEW booking but can still check in, check out and complete an ACTIVE one |
| REV-001 | TESTED | both directions submit, and each side becomes eligible independently |
| REV-002 | TESTED | eligibility and submission both refused before completion and after cancellation |
| REV-005 | TESTED | the first review stays `PENDING` and invisible; both publish together, or a lone one publishes when the window closes |
| REV-007 | TESTED | confirmed facts aggregate as `confirmed`/`total`, including a contradiction |
| REV-008 | TESTED | a phone number and an email in review text are redacted and a moderation note is recorded |
| REV-009 | TESTED | reporting leaves the review `PUBLISHED`; reporting your own is refused |
| TRUST-003 | TESTED | completed-rental counts and rating update for both sides; the public profile carries no email, phone or counterparty id |

Still not implemented, and deliberately not restated: payment processing, escrow,
`PRICE-008` negotiation, a staff queue for dispute cases, stay photos on
check-in/check-out records, and any scheduler that calls `lifecycle.run` on its
own. `REV-002`'s review window is opened by the transition (DEC-035); bookings
completed before that fix still carry a NULL deadline and are not backfilled.

The intended platform role is unchanged: a venue connecting the parties, with rent
paid directly between them. No new legal claim is made here, and no legally gated
feature was enabled.
