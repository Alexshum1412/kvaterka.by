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
| BOOK-014 | A disputed booking has an exit | `RESOLVE_DISPUTE_AS_*` through the FSM, ADMIN only (DEC-042) | TESTED |
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
| VERIFY-002 | Property verification separate from identity | Distinct fields and badges | TESTED |
| VERIFY-003 | An applicant can actually ask to be verified | Submission, resubmission preserving answers, one live request per kind | TESTED |
| VERIFY-004 | A level is never granted with no evidence | `evidenceSufficiency()` gates every approval (DEC-045) | TESTED |
| VERIFY-005 | Approving requires being able to open the documents | APPROVE needs `document.read`; ADMIN is refused (DEC-046) | TESTED |
| VERIFY-006 | Structured refusal codes with a fix target | Ten codes, each with applicant text and a destination (DEC-047) | TESTED |
| VERIFY-007 | Internal note never reaches the applicant | Separate column, separate event visibility | TESTED |
| VERIFY-008 | Documents fail closed twice over | Legal flag AND private storage, independently (LEGAL-004) | TESTED |
| VERIFY-009 | Level wording claims a platform check, not a legal conclusion | Asserted against a forbidden-phrase list (DEC-049) | TESTED |
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
| ADMIN-001 | Admin panel exists in MVP | Moderation, verification, cases, users, flags | IN PROGRESS — moderation + disputes have screens; verification, reports and users are API-only |
| ADMIN-002 | All admin actions audited | Actor, target, diff, reason | TESTED (dispute + booking-outcome paths) |
| ADMIN-003 | No manual DB edits for business operations | Every operation has an audited code path | IN PROGRESS |
| CASE-001 | Dispute queue ordered by what is most pressing | Active stay, safety/fraud, then age; server-side filter and paging | TESTED |
| CASE-002 | Deterministic priority users cannot set | Derived from category, booking state, signals and age (DEC-041) | TESTED |
| CASE-003 | Case workflow through a transition table | Only declared moves; a reason required for consequential ones | TESTED |
| CASE-004 | Deciding a case is separate from deciding the booking | `case.resolve` for both; no amount crosses the boundary (DEC-042) | TESTED |
| CASE-005 | Internal notes never reach the parties | `case_event.visibility` defaults to INTERNAL (DEC-043) | TESTED |
| CASE-006 | Evidence assembled per entitlement | Messages need `message.review`, finance `debt.view` (DEC-044) | TESTED |
| CASE-007 | Identity documents unreachable from a case | No role, including ADMIN, reaches one from the console | TESTED |
| CASE-008 | Assignment to staff who work cases | Assign, reassign, unassign; every change in the case history | TESTED |
| CASE-009 | Staff communication through the notification queue | The console is never exposed; internal notes never sent | TESTED |
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

Still not implemented at that point, and deliberately not restated there:
payment processing, escrow, `PRICE-008` negotiation, stay photos on
check-in/check-out records, and any scheduler that calls `lifecycle.run` on its
own. `REV-002`'s review window is opened by the transition (DEC-035); bookings
completed before that fix still carry a NULL deadline and are not backfilled.

## Status reconciliation — the staff operations slice

Verified by `tests/staff-operations.integration.test.ts` (39 tests) and
`src/server/domain/dispute.test.ts` (22 tests), plus a browser walkthrough of
the whole case lifecycle. Only rows those suites exercise are restated:

| ID | Restated status | Evidence |
|---|---|---|
| ADMIN-002 | TESTED | four staff actions each produce an audit row with actor, ADMIN role, reason and before/after state; the log refuses UPDATE and DELETE |
| CASE-001 | TESTED | an active-stay safety report sorts above a ten-day-old routine case; filtering and paging happen in SQL |
| CASE-002 | TESTED | `priorityOf()` and `PRIORITY_SQL` agree across every category × booking state, and on the signal and age escalations |
| CASE-003 | TESTED | a move the table does not define is 409, a consequential move with no reason is 422 |
| CASE-004 | TESTED | SUPPORT and MODERATOR are refused both `RESOLVE` and the booking outcome; a posted `feeMinor` changes nothing |
| CASE-005 | TESTED | an internal note is absent from both parties' booking payloads and cannot be edited or deleted |
| CASE-006 | TESTED | SUPPORT sees finance and not messages, MODERATOR the reverse; an unavailable section is absent, not empty |
| CASE-007 | TESTED | SUPPORT, MODERATOR, FINANCE and ADMIN are all refused a document; VERIFIER must state a purpose and the read is logged |
| CASE-008 | TESTED | assign / reassign / unassign, refused for a user who does not work cases |
| CASE-009 | TESTED | the request reaches the tenant's inbox; the internal note and the console path do not |
| BOOK-014 | TESTED | `RESOLVE_DISPUTE_AS_*` moves a DISPUTED booking and accrues the fee from its frozen terms; refused from any other state |
| FEE-004 | TESTED | a dispute outcome cannot fabricate an amount, and the ledger still refuses UPDATE and DELETE |

Still not implemented, and deliberately not restated: payment processing,
escrow, `PRICE-008` negotiation, stay photos, any scheduler that calls
`lifecycle.run` on its own, and screens for the report, verification and user
queues — those remain API-only behind their existing permissions, and the
overview says so on the card rather than linking nowhere. There is no
resolution-template or bulk-action support, and no SLA notification: overdue is
computed and shown, and nothing chases it.

The intended platform role is unchanged: a venue connecting the parties, with rent
paid directly between them. No new legal claim is made here, and no legally gated
feature was enabled. Dispute handling is described throughout as «рассмотрение
обращения» and «решение по обращению» — an internal review, not arbitration.

## Status reconciliation — the verification slice

Verified by `tests/verification.integration.test.ts` (42 tests) and
`src/server/domain/verification.test.ts` (29 tests), plus a browser walkthrough
of both sides. Only rows those suites exercise are restated:

| ID | Restated status | Evidence |
|---|---|---|
| VERIFY-001 | TESTED | levels 0/1/2 with level 2 reachable only via a property request by somebody already holding level 1 |
| VERIFY-003 | TESTED | a submitted request appears in the verifier queue; a second submit returns the first rather than duplicating it |
| VERIFY-004 | TESTED | approval refused with the flag off, with no documents, and with a document but no selfie — the level stays 0 in every case |
| VERIFY-005 | TESTED | ADMIN is offered no approve action and refused 403 on both the new and the legacy endpoint; VERIFIER succeeds on both |
| VERIFY-006 | TESTED | an empty rejection is 422; codes reach the applicant with explanations and a fix target |
| VERIFY-007 | TESTED | the internal note is absent from the applicant's view, their timeline and their notifications |
| VERIFY-008 | TESTED | `FEATURE_DISABLED` with the flag off, `NOT_IMPLEMENTED` with the flag on and no bucket |
| VERIFY-009 | TESTED | no forbidden legal phrasing in any level label, claim, explanation or refusal text |
| ADMIN-002 | TESTED | submit, take, assign and reject each produce an audit row with actor, role and reason |

**Deliberately not built, and not claimed.** There is no document upload path that
works — collection is gated on LEGAL-004 and on private object storage that does
not exist, and both refuse independently. There is no purge job, so
`purge_after` is a stored intention rather than an enforced policy. There is no
selfie-matching, liveness check or third-party KYC integration. Approving is
impossible today by design, and the console says so rather than looking broken.
