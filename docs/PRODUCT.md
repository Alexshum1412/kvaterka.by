# Продукт: требования и спецификация

Первая часть — требования с идентификаторами (AUTH-001, BOOK-…) и их статус; раньше PRODUCT_REQUIREMENTS.md. Вторая — исходная спецификация, на которую ссылаются «spec §N» в коде и в DECISIONS.md; раньше CODEX_MASTER_PROMPT_BELARUS_RENTAL.md. Номера разделов сохранены.

## Содержание

- Требования и их статус
- Исходная спецификация

---

## Требования и их статус

Traceability from the master specification to implementation. Status vocabulary per spec §75: **NOT STARTED · IN PROGRESS · IMPLEMENTED · TESTED · AUDITED · BLOCKED**.

`TESTED` means automated tests exist and pass. `IMPLEMENTED` means the code exists but is not yet covered by tests. Nothing is marked on the strength of a UI existing.

---

### AUTH — Accounts and access

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

### LIST — Listings

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

### PRICE — Pricing and transparency

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

### BOOK — Booking

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

### FEE — Service fee and landlord debt

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

### COMPLETE — Two-sided completion

| ID | Requirement | Acceptance criteria | Status |
|---|---|---|---|
| COMPLETE-001 | Both parties confirm | Agreement completes or voids the rental | TESTED |
| COMPLETE-002 | Contradiction escalates | `DISPUTED`, no fee | TESTED |
| COMPLETE-003 | Landlord silence cannot avoid the fee | Tenant's confirmation completes after the deadline | TESTED |
| COMPLETE-004 | Landlord admission trusted immediately | Completes without waiting | TESTED |
| COMPLETE-005 | Lone landlord denial flagged | Honoured + `UNILATERAL_LANDLORD_DENIAL` signal | TESTED |
| COMPLETE-006 | No debt without evidence | Total silence + no check-in → no fee | TESTED |
| COMPLETE-007 | Answers are final | Changing a submitted answer rejected | TESTED |

### CHAT — Messaging and anti-off-platform

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

### REV — Reviews

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

### VERIFY / TRUST

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

### SEARCH / ADMIN / NOTIFY / LEGAL

| ID | Requirement | Acceptance criteria | Status |
|---|---|---|---|
| SEARCH-001 | Radius/geo search | lat/lng rectangle on a btree index, then haversine in plain SQL; correct inclusion/exclusion | TESTED (query level, and end to end on PostgreSQL 10.23) |
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
| LEGAL-001 | Legal risk register exists | Every topic with confidence and lawyer-review flag | IMPLEMENTED — see [docs/LEGAL.md](LEGAL.md) |
| LEGAL-002 | Rewards/lottery gated | Feature flag with `requires_legal_approval`; no prize logic | IMPLEMENTED (DEC-015) |
| LEGAL-003 | Belarus legal verification | **BLOCKED** — requires a Belarus-qualified lawyer | BLOCKED |

### UX

| ID | Requirement | Acceptance criteria | Status |
|---|---|---|---|
| UX-001 | Mobile-first critical flows | Search, map, listing, booking, chat, calendar, check-in, review | NOT STARTED |
| UX-002 | Accessibility baseline | Keyboard, labels, semantics, contrast, focus, touch targets | NOT STARTED |
| UX-003 | Loading / empty / error states | Every async surface | NOT STARTED |
| UX-004 | Original design language | Not an Airbnb clone; own identity | NOT STARTED |
| UX-005 | Errors never leak internals | Stable codes, safe messages, correlation id | IMPLEMENTED (`errors.ts`) |

---

### Reconciliation — tenant journey slice (2026-08-17)

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

### Status reconciliation — the completion and review slice

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

### Status reconciliation — the staff operations slice

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



### Notification delivery, staff 2FA and booking expiry

| ID | Requirement | Status |
|---|---|---|
| NOTIF-001 | A queued notification is actually delivered | TESTED — for IN_APP, the only channel with a transport |
| NOTIF-002 | The same notification is never delivered twice by two runs | TESTED — the claim moves the row to SENDING inside the claiming statement |
| NOTIF-003 | Two concurrent workers do the work once | TESTED — the job_run mutex turns the second away |
| NOTIF-004 | A transient failure retries later, not immediately | TESTED — `next_attempt_at`, and the row is not re-claimed before it |
| NOTIF-005 | The backoff escalates rather than repeating at a fixed interval | TESTED |
| NOTIF-006 | A permanent failure is never retried | TESTED |
| NOTIF-007 | SENT is unreachable except through a provider reporting DELIVERED | TESTED |
| NOTIF-008 | A channel with no transport is never claimed, so the backlog stays honest | TESTED |
| NOTIF-009 | The recipient address is resolved at send time from the user record | TESTED — and never from the payload |
| NOTIF-010 | A notification never reaches the wrong person | TESTED |
| NOTIF-011 | An account with no address for a channel is suppressed, not failed | TESTED — a phone-only account has no email |
| NOTIF-012 | A row a dead worker never settled is reclaimed | TESTED |
| NOTIF-013 | The backlog view carries no address and no message body | TESTED |
| NOTIF-014 | Real EMAIL delivery | LIVE — `smtpProvider()` (nodemailer) ships in `provider.ts`; `SMTP_URL`/`MAIL_FROM` confirmed set in production via the cPanel env panel (DEC-080) |
| NOTIF-015 | Real TELEGRAM delivery | LIVE — `telegramProvider()` plus the `/api/telegram/webhook` route and account-linking UI ship; `TELEGRAM_BOT_TOKEN` confirmed set in production (DEC-080) |
| 2FA-001 | Staff roles are unusable without a second factor | TESTED — at the route AND in the roles a console page reads |
| 2FA-002 | An ordinary account is unaffected | TESTED |
| 2FA-003 | A landlord who is also staff keeps the landlord half | TESTED |
| 2FA-004 | TOTP interoperates with real authenticator apps | TESTED — RFC 6238 vectors, plus a WebCrypto cross-check in a browser |
| 2FA-005 | A code cannot be replayed within its window | TESTED |
| 2FA-006 | Repeated failures lock out, escalating, cleared only by success | TESTED — including that the counter survives its own rejection |
| 2FA-007 | Recovery codes work once each | TESTED |
| 2FA-008 | Recovery codes are stored only as hashes | TESTED |
| 2FA-009 | A valid authenticator code never burns a recovery code | TESTED |
| 2FA-010 | Every failure says the same thing | TESTED |
| 2FA-011 | A submitted code never reaches the audit log | TESTED |
| 2FA-012 | A rotated session keeps its authentication level | TESTED |
| 2FA-013 | Disabling requires a current code | TESTED — a stolen session cannot remove the factor |
| 2FA-014 | SUPPORT cannot reset a colleague's 2FA; ADMIN can, with a reason | TESTED |
| 2FA-015 | Sensitive permissions require a recent confirmation | TESTED — and ordinary queue work does not |
| 2FA-016 | The enrolment page is reachable while roles are withheld | TESTED |
| 2FA-017 | The TOTP secret is protected at rest | **NOT MET** — plaintext; no encryption-at-rest layer exists (DEC-055) |
| EXPIRE-001 | An unanswered request expires | TESTED |
| EXPIRE-002 | A request within its window does not | TESTED |
| EXPIRE-003 | Expiry writes an event and an audit row attributed to the job | TESTED |
| EXPIRE-004 | Running twice expires once and notifies once | TESTED |
| EXPIRE-005 | A landlord accepting first makes expiry a no-op, not a failure | TESTED |
| EXPIRE-006 | Accepting an expired request is refused with a usable error | TESTED — 409 |

**Deliberately not built.** No SMS as a factor. No "remember this device" — it would need a threat-model analysis this slice did not do, and an unanalysed trusted-device cookie is a second factor that quietly stops being one. No 2FA for ordinary tenants and landlords. Noself-service recovery that bypasses the authenticator.

### Data lifecycle and retention

| ID | Requirement | Status |
|---|---|---|
| DATA-001 | Every table has a declared data class, subject, disposition on account closure and retention window | TESTED — `RETENTION_CATALOGUE`, compared against `information_schema` so a new table cannot be added without one |
| DATA-002 | No retention period is defined anywhere without a cited basis | TESTED — every window is technical, per-row, indefinite-with-reason, or UNKNOWN naming its LEGAL-xxx; a test forbids a fourth kind |
| DATA-003 | An absent retention window never permits destruction | TESTED — `purge_after IS NULL` yields RETAINED and blocks with `NO_RETENTION_POLICY` |
| DATA-004 | Retention state is derived, and the TypeScript and SQL rules agree | TESTED — all 36 combinations through both |
| DATA-005 | A legal hold blocks destruction, including one placed after the candidate list was built | TESTED — re-checked inside the purge transaction under a row lock |
| DATA-006 | Placing a hold is broader than lifting one; lifting requires ADMIN and a written reason | TESTED — SUPPORT places and is refused 403 on release; the database refuses a release with no reason |
| DATA-007 | VERIFIER can neither hold nor run retention | TESTED — 404 on the page, 403 on all four routes |
| DATA-008 | Purging destroys bytes before recording it, and never records an unconfirmed destruction | TESTED — a failing store leaves `purged_at` NULL and the row is retried |
| DATA-009 | The access log survives the document it describes | TESTED — and still refuses direct deletion afterwards |
| DATA-010 | No retention response carries a storage key at any permission level | TESTED — across ADMIN, SUPPORT, MODERATOR |
| DATA-011 | A scheduled job cannot run twice concurrently, and records what it did | TESTED — partial unique index; a stale run is reclaimed after a lease |
| DATA-012 | One failing item never abandons the batch | TESTED — 3 documents, the middle one fails, the others are destroyed |
| DATA-013 | Closing an account revokes all access and destroys nothing | TESTED — session dead, re-login refused, the row and display name intact |
| DATA-014 | Closure is refused during an active booking, an open dispute or a hold — and never for debt | TESTED |
| DATA-015 | The closure screen names every unbuilt erasure step with its legal blocker | TESTED — and no step that destroys personal data may be marked built |
| DATA-016 | Financial and audit records survive every retention operation | TESTED — counts and content unchanged; append-only tables still refuse mutation |
| DATA-017 | Erasure of personal data | **NOT BUILT** — LEGAL-003. Declared, surfaced, refused. |
| DATA-018 | Purge or anonymisation of dispute records | **NOT BUILT** — LEGAL-017 |
| DATA-019 | Data export | **NOT STARTED** — LEGAL-003 |
| DATA-020 | Real destruction of document bytes | **NOT POSSIBLE** — no private object storage exists; the store refuses rather than pretending |

**Deliberately not built, and not claimed.** No anonymisation routine of any
kind. No redaction of `message.body_original`. No purge of disputes, reviews,
listings or media. No automatic expiry of legal holds — a hold that released
itself would not be a hold. Each of these is listed in the risk register as a
consequence of an *unfavourable* answer, which makes it a contingency rather
than a default, and building a destruction path before knowing what may be kept
would be exactly backwards.

**The one number in the subsystem** is a ninety-day review cadence for legal
holds. It decides how often staff must look at a hold, never how long anybody's
data is kept, which is why it can be a number when no retention window can be.

### Status reconciliation — the verification slice

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
not exist, and both refuse independently. The purge job now exists
(the retention slice), and `purge_after` is deliberately left NULL, which the
retention domain treats as never eligible — so the job cannot act on a window
nobody chose. There is no
selfie-matching, liveness check or third-party KYC integration. Approving is
impossible today by design, and the console says so rather than looking broken.

---

## Исходная спецификация

> Исходный бриф проекта, сохранён дословно. Имена файлов в нём — те, что были на момент написания; где они теперь, сказано в README.md.

### 0. ROLE

You are the principal product architect, senior full-stack engineer, system designer, security architect, DevOps engineer, QA lead, UX/product strategist, and technical project manager for this product.

Your job is not to merely discuss the product or generate a superficial prototype.

Your job is to turn the product concept below into a production-grade, maintainable, secure, testable, scalable web platform.

You must:
- inspect the existing repository before changing anything;
- understand the current architecture and reuse what is good;
- identify missing pieces and weak decisions;
- choose the best practical implementation when requirements are ambiguous;
- never silently invent business rules;
- keep a traceable record of decisions;
- implement, test, audit, and document the result;
- continuously compare implementation against this specification;
- prefer simple, robust solutions over unnecessary complexity;
- never mark a feature complete merely because its UI exists;
- verify end-to-end behavior across frontend, backend, database, background jobs, notifications, permissions, and error handling.

The product is initially for BELARUS ONLY.

IMPORTANT:
This document is the product vision and baseline specification. It does not override applicable law, platform limitations, security requirements, or technical reality. Where legal/technical details are uncertain, verify them using authoritative current sources and document the result instead of guessing.

---

## 1. PRODUCT VISION

We are building a Belarusian rental marketplace inspired by the convenience of Airbnb, but NOT a clone.

Core idea:

> A trusted digital marketplace where property owners independently publish and manage rental listings, while tenants can find, compare, communicate, book, document, and review rentals with maximum transparency and minimum friction.

The platform should work for:
- short-term rentals;
- medium-term rentals;
- long-term rentals.

The same property can be offered for different rental durations.

The platform philosophy:

> “Everything needed for an honest rental in one place.”

We are not building a simple classified ads board.

We are building a rental operating system / trust infrastructure.

Core value:
1. Trust.
2. Transparency.
3. Flexibility.
4. Convenience.
5. Strong reputation/history.
6. Direct relationship between landlord and tenant.
7. Platform assistance without unnecessarily becoming a party to the lease.

---

## 2. INITIAL LEGAL / BUSINESS MODEL

The company behind the platform already has an LLC/ООО.

The intended MVP model is:

THE PLATFORM:
- provides the marketplace;
- provides listings;
- provides search;
- provides maps;
- provides profiles;
- provides internal messaging;
- provides booking/request workflows;
- provides calendars;
- provides reviews and reputation systems;
- provides verification;
- provides notifications;
- provides a digital record of platform events;
- charges landlords a 5% platform service fee/debt after a completed rental transaction is confirmed.

THE PLATFORM DOES NOT WANT, IN THE MVP:
- to receive rental money from the tenant;
- to hold tenant funds;
- to act as escrow;
- to transfer rental money from tenant to landlord;
- to be the landlord;
- to become the contractual counterparty to the lease;
- to manage the property;
- to guarantee the landlord's obligations;
- to guarantee the tenant's obligations.

Tenant and landlord settle with each other directly using a method they agree upon.

The platform's 5% fee is a SERVICE FEE owed by the landlord to the platform, not the tenant's rental payment.

Example:
- agreed rental price = 1,000 BYN
- tenant pays landlord directly = 1,000 BYN
- landlord owes platform = 50 BYN service fee
- platform balance becomes -50 BYN or equivalent payable debt.

The exact legal wording, invoicing, tax treatment, accounting treatment, consumer-law implications, and contract structure MUST be verified for Belarus before production launch.

IMPORTANT:
Do not assume that the above business model automatically eliminates all legal obligations.
Create a legal-risk matrix and identify exactly what must be verified by a Belarus-qualified lawyer/accountant before launch.

---

## 3. CORE DIFFERENTIATOR

The platform should make users feel:

> “I know who I am dealing with, what I am renting, how much it really costs, what the rules are, what other people experienced, and what happens at every stage of the rental.”

Major product principle:

### RENTAL WITHOUT SURPRISES

The platform should proactively eliminate:
- hidden fees;
- fake or stale listings;
- fake profiles;
- misleading photos;
- unclear house rules;
- unclear rental terms;
- unreliable calendars;
- missing history;
- weak reviews;
- off-platform communication pressure;
- disputes with no evidence trail.

---

## 4. TARGET USERS

### 4.1 Tenant / renter

Examples:
- tourist;
- business traveler;
- student;
- family;
- couple;
- person moving to another city;
- long-term tenant;
- person renting for several months;
- person renting for a year or more.

### 4.2 Landlord / property owner

Examples:
- individual with one apartment;
- individual with several apartments;
- professional landlord;
- property manager;
- company;
- agency/company that transparently identifies itself as a company.

Companies/agencies must NOT pretend to be ordinary private individuals.

### 4.3 Administrator / moderation staff

Responsible for:
- moderation;
- reports;
- fraud review;
- verification;
- disputes/cases;
- content moderation;
- account restrictions;
- platform operations;
- system configuration;
- audit logs.

Architect for role-based permissions and least privilege.

---

## 5. GEOGRAPHY AND LANGUAGE

Launch market:
- Belarus only.

Design architecture so that localization can later support:
- Russian;
- Belarusian;
- English;
without making the first version unnecessarily complex.

Do not hardcode Belarus-specific assumptions into every subsystem.
Centralize:
- currency;
- locale;
- address formats;
- time zone;
- tax/legal notices;
- notification templates;
- measurement units.

---

## 6. RENTAL DURATION MODEL

This is one of the defining product features.

A landlord chooses:
- minimum rental duration;
- maximum rental duration.

The range may cover:
- hours (if legally/product-wise appropriate);
- days;
- weeks;
- months;
- years.

Prefer a technically consistent internal representation of duration.
The UI may use human-friendly units.

Example:
- minimum = 3 days
- maximum = 12 months

Another:
- minimum = 14 days
- maximum = 6 months

Another:
- minimum = 1 day
- maximum = 3 years

Do NOT force all landlords into a single short-term or long-term category.

The same listing can have different pricing for different durations.

---

## 7. PRICING MODEL

The platform must support multiple pricing strategies.

### 7.1 Fixed pricing
Examples:
- 100 BYN/night
- 1,900 BYN/month
- 20,000 BYN/year

### 7.2 Tiered pricing
Example:
- 1–3 days: 120 BYN/day
- 4–7 days: 105 BYN/day
- 8–30 days: 90 BYN/day
- 1–6 months: 2,100 BYN/month
- 6+ months: 1,800 BYN/month

### 7.3 Seasonal pricing
Different prices by date periods.

### 7.4 Day-of-week pricing
Optional.

### 7.5 Demand/recommendation mode
System can recommend pricing but must NOT silently change it unless landlord explicitly enables an automation mode.

### 7.6 Custom price
Landlord manually sets prices.

### 7.7 Negotiation / “Make an offer”
Optional per listing.

Flow:
- tenant proposes price;
- landlord accepts/rejects/counteroffers;
- final agreed amount becomes part of booking record;
- service fee is calculated from final confirmed rental amount;
- all changes are auditable.

The platform must support a wide range of landlord styles rather than forcing one workflow.

---

## 8. TOTAL PRICE / TRANSPARENCY

The tenant must see the total expected rental cost before committing.

Avoid “cheap headline + hidden mandatory fees”.

Display:
- base rental amount;
- mandatory cleaning fee (if any);
- mandatory additional charges;
- utilities/communal charges where applicable;
- other mandatory charges;
- optional charges separately.

Example:

Rental: 560 BYN
Mandatory cleaning: 30 BYN
Mandatory other charges: 0 BYN
Expected total: 590 BYN

If some variable cost depends on a meter/actual consumption and cannot be known in advance, clearly label it as variable.

After a booking is confirmed:
- the confirmed financial terms become immutable historical data;
- any change requires an explicit booking amendment accepted according to the workflow;
- never allow silent price manipulation.

---

## 9. BOOKING MODES

Each listing can choose one or more supported modes, subject to rules.

### 9.1 Instant booking
Tenant confirms according to listing conditions.

### 9.2 Request-to-book
Tenant submits a request.
Landlord accepts/rejects.

### 9.3 Negotiation
Tenant and landlord agree on custom price/terms.

Do not build separate parallel systems if one booking state machine can support all modes cleanly.

---

## 10. BOOKING STATE MACHINE

Design an explicit finite state machine.

Suggested states (you may improve them):

DRAFT
PENDING_MODERATION
PUBLISHED
INQUIRY
OFFER_SENT
OFFER_COUNTERED
BOOKING_REQUESTED
BOOKING_ACCEPTED
BOOKING_DECLINED
BOOKING_CANCELLED_BY_TENANT
BOOKING_CANCELLED_BY_LANDLORD
CONFIRMED
CHECKIN_PENDING
CHECKED_IN
ACTIVE
CHECKOUT_PENDING
COMPLETED
DISPUTED
RESOLVED
EXPIRED

Do NOT blindly copy this list.
Design the final state machine based on:
- short-term;
- long-term;
- instant booking;
- request flow;
- cancellation;
- no-show;
- disputes;
- completed rental;
- platform fee.

Document every transition:
- who can trigger it;
- prerequisites;
- allowed transitions;
- side effects;
- notifications;
- audit events.

---

## 11. TWO-SIDED COMPLETION CONFIRMATION

This is critical.

At the end of a rental:
- tenant confirms whether the rental actually took place;
- landlord confirms whether the rental actually took place.

When both confirm:
- rental becomes completed;
- review process opens;
- service fee becomes payable debt for landlord;
- Rewards ticket can become eligible IF/WHEN the legal rewards system is activated.

Need careful timeout behavior:
- if only one side confirms;
- if the other side does nothing;
- if one side disputes;
- if one side reports fraud.

Design a robust event-driven workflow.

---

## 12. PLATFORM SERVICE FEE / LANDLORD DEBT

Default:
- 5% of the final agreed rental amount.

Example:
Rental = 1,000 BYN
Platform fee = 50 BYN

The fee creates a payable balance for the landlord.

Suggested account behavior:

Normal balance = 0
Debt = -50 BYN

Until debt is resolved:
- browsing listings: allowed;
- messaging existing contacts: allowed where appropriate;
- account/profile access: allowed;
- critical access to active rental: allowed;
- creating new active listings: potentially restricted;
- accepting new bookings: restricted;
- promotional boosts: restricted;
- new instant bookings: restricted.

Choose the most user-friendly restriction model that is still commercially effective.

Do NOT over-block users in a way that can harm an already active legitimate tenant/booking.

Create:
- debt ledger;
- fee calculation record;
- invoice/statement concept if appropriate;
- payment status;
- payment history;
- reminders;
- grace period strategy;
- admin override;
- audit trail.

Do not treat financial records as mutable fields.
Use immutable ledger-style records where appropriate.

---

## 13. REGISTRATION

Require accounts for meaningful platform actions.

Guest browsing can be possible.
Creating listings, booking, messaging, reviewing, and other transactional actions require authentication.

Support:
- email;
- phone;
- secure password or passwordless if architecturally sound;
- Telegram linking optionally for notifications;
- future identity verification mechanisms.

Avoid requiring excessive personal data at initial registration.

---

## 14. USER PROFILE VISIBILITY

### Tenant can see landlord:
- personal name OR company name;
- rating;
- number of active properties;
- verification status;
- completed rental count;
- useful public trust information.

### Landlord can see tenant:
- name;
- rating;
- completed rental count;
- verification status;
- useful public trust information.

Never expose:
- passport details;
- identity documents;
- private addresses;
- internal moderation notes;
- sensitive verification data;
- private case data.

Public profile must be privacy-safe.

---

## 15. VERIFICATION SYSTEM

Three main levels.

### Level 0 — “Newcomer”
Verified:
- phone;
- email.

Listing visible, but:
- “Documents not verified” warning;
- lower ranking;
- no verification badge;
- restricted advanced capabilities as defined by policy.

### Level 1 — “Identity verified”
Identity verified using:
- passport/photo documents + selfie;
OR
- supported national identity/identity provider mechanism if available and legally usable.

Moderator/system verifies:
- identity consistency.

Benefits may include:
- “Identity verified” badge;
- request-to-book;
- improved search ranking;
- other reasonable trust benefits.

### Level 2 — “Verified”
Verify:
- identity;
- right to rent the specific property;
- ownership OR valid authority/power of attorney;
- video verification and/or strong identity verification;
- property documents where appropriate;
- address consistency;
- optional property inspection.

Possible additional checks:
- geolocation evidence;
- complaints/reputation checks;
- inspection act.

IMPORTANT:
Do not assume technical access to government registries such as EGRNI.
Verify legal and technical availability first.
If not available, design manual/document verification.

---

## 16. PROPERTY VERIFICATION

Property verification is separate from identity verification.

Possible status:
- identity verified;
- property verified;
- fully verified account.

A fully verified person may have an unverified new property.

This distinction MUST be visible in the product.

Possible public badges:
- Identity verified
- Property verified
- Verified landlord
- Address verified
- Long-running landlord
- High trust

Do not make badges misleading.

---

## 17. DOCUMENT SECURITY

Identity documents and verification materials are highly sensitive.

Requirements:
- encrypt at rest;
- encrypt in transit;
- strict role-based access;
- access logging;
- retention/deletion policy;
- no public exposure;
- no URLs that allow unrestricted download;
- ideally integrate with specialized KYC/identity provider where legally and technically suitable;
- do not allow ordinary support staff to access full identity data by default;
- create an auditable verification trail.

Need a privacy/data-protection review before production.

---

## 18. PROPERTY CREATION FLOW

Make listing creation extremely easy.

Suggested steps:

1. Property type
2. Address / map
3. Approximate location policy
4. Photos
5. Property characteristics
6. Amenities
7. Rules
8. Guests capacity
9. Rental duration range
10. Pricing
11. Calendar
12. Booking mode
13. Negotiation settings
14. Description
15. Verification
16. Preview
17. Moderation
18. Publish

Minimum photo count for initial listing publication:
- 1 photo.

Do not force excessive requirements for legitimate landlords.

However, use:
- quality recommendations;
- nudges;
- optional photo completeness score.

---

## 19. MAP

Map is central.

Landlord:
- selects property location.

Tenant:
- searches by map;
- sees approximate/controlled location before booking where privacy requires it;
- sees exact address after the correct booking stage.

Need:
- geospatial storage;
- radius search;
- city/district search;
- map clustering;
- bounds search;
- distance-based filtering.

Design provider abstraction so map provider can be replaced later.

---

## 20. PHOTOS

Support:
- multiple photos;
- ordering;
- cover image;
- deletion;
- captions if useful;
- photo quality checks;
- optional duplicate/fraud detection;
- future image authenticity/metadata checks.

Do not make EXIF metadata a hard requirement.

Minimum = 1.

Encourage high-quality complete galleries.

---

## 21. PROPERTY “RENTAL PASSPORT”

Each listing should have a structured factual profile.

Example fields:
- city;
- district;
- approximate/exact address rules;
- type;
- area;
- rooms;
- beds;
- bathrooms;
- floor;
- total floors;
- elevator;
- parking;
- Wi-Fi;
- workspace;
- air conditioning;
- washing machine;
- dishwasher;
- balcony;
- accessibility;
- pets;
- smoking;
- children;
- parties;
- quiet hours;
- max guests;
- check-in/check-out;
- minimum rental;
- maximum rental.

Store structured data, not only free text.

---

## 22. PROPERTY TAGS / FILTERABLE RULES

Examples:
- smoking prohibited;
- smoking allowed;
- smoking on balcony only;
- pets allowed;
- small pets only;
- children allowed;
- baby crib;
- additional sleeping place;
- parties prohibited;
- events prohibited;
- quiet hours;
- parking;
- elevator;
- balcony;
- Wi-Fi;
- workspace;
- air conditioning;
- dishwasher;
- washing machine;
- accessibility;
- heating;
- underfloor heating.

Tags must be standardized for filtering.

Free text can complement tags but must not replace structured values for critical search criteria.

---

## 23. SMART / STANDARD LANDLORD MODES

Landlord can choose how much automation to use.

### Standard
Manual:
- pricing;
- calendar;
- booking acceptance;
- rules.

### Flexible
Adds:
- seasonal rules;
- discounts;
- tiered prices;
- minimum stay logic;
- negotiation.

### Smart
Adds:
- price suggestions;
- occupancy recommendations;
- gap-filling recommendations;
- stale-calendar reminders;
- demand insights;
- recommended minimum stay.

Automation must be opt-in.
Never silently change landlord-controlled business values.

---

## 24. CALENDAR

Calendar must be one of the best parts of the product.

Support:
- day;
- week;
- month;
- multi-month view;
- mobile-friendly interaction.

Statuses:
- free;
- booked;
- blocked;
- pending;
- unavailable.

Support:
- drag selection;
- multi-day changes;
- bulk operations;
- recurring rules where appropriate;
- different pricing by date range;
- minimum stay per range;
- maximum stay per range;
- availability rules.

Show:
- last calendar update timestamp;
- stale calendar warning.

Example:
GREEN — updated today
YELLOW — updated several days ago
RED — stale

Search ranking can consider listing freshness.

Potential future:
- iCal/ICS import/export.

---

## 25. INTERNAL CHAT

All meaningful communication should occur inside the platform.

Do NOT automatically move users to Telegram/WhatsApp/etc.

Chat must support:
- text;
- images;
- booking context;
- system messages;
- offer/counteroffer;
- booking updates;
- moderation reports;
- timestamps;
- unread state;
- message search where appropriate.

---

## 26. ANTI-OFF-PLATFORM / CONTACT BLOCKING

Before an appropriate booking stage, the chat should block or flag:
- phone numbers;
- email addresses;
- Telegram usernames;
- WhatsApp contact information;
- Viber identifiers;
- external URLs;
- social handles;
- attempts to obfuscate contact info.

Do not rely only on regex.

Use layered detection:
1. normalization;
2. regex;
3. token pattern detection;
4. URL detection;
5. username patterns;
6. language-aware obfuscation detection;
7. optional ML/classifier assistance if useful.

Examples of evasion:
- “+3 7 5 ...”
- words replacing digits;
- spaces/symbols;
- “telegram: username”
- “write me on [site]”
- encoded links.

BUT:
Avoid false positives for normal content such as:
- apartment number;
- floor;
- street number;
- Wi-Fi password;
- dates;
- booking codes.

Build test cases specifically for Russian and Belarusian-language chats.

After the booking reaches a legally/product-approved stage, contact exchange may become available.

The product should log when contact-sharing permissions change.

---

## 27. TELEGRAM NOTIFICATIONS

Telegram is an optional NOTIFICATION CHANNEL.

Do NOT move the platform's canonical chat history to Telegram.

Support optional notifications for:
- new booking request;
- booking accepted/rejected;
- new internal message;
- upcoming check-in;
- upcoming checkout;
- cancellation;
- review request;
- platform debt;
- important account/security events.

User chooses notification categories.

Use a Telegram bot and account-linking workflow.

Secure linking and unlinking.

---

## 28. REVIEWS

Reviews are core trust infrastructure.

Two-sided:
- tenant reviews landlord/property;
- landlord reviews tenant.

Prevent retaliation where practical.

Preferred publication model:
- publish after both submit;
OR
- publish after a reasonable timeout.

Do not allow one party to see the other's unpublished review in a way that can induce retaliation.

---

## 29. STRUCTURED REVIEWS

Do not allow only:
“5 stars, everything good.”

Collect structured fields.

Tenant reviews:
- overall;
- cleanliness;
- accuracy;
- check-in;
- communication;
- location;
- value;
- house rules clarity;
- actual length of stay;
- trip type (optional);
- public text;
- what was good;
- what could improve.

Landlord reviews:
- overall;
- communication;
- rule compliance;
- property condition at checkout;
- timeliness/behavior;
- actual length of stay;
- public text;
- notable strengths/issues.

The exact fields may differ by rental type.

Display rental duration in human-friendly form:
- “stayed 12 days”
- “rented for 6 months”

Avoid publishing exact private dates unless explicitly needed.

---

## 30. REVIEW QUALITY

Prevent empty meaningless reviews.

Use prompts:
- What was especially good?
- What could be improved?
- Did the property match the listing?
- Would you rent again?

Structured data should carry value even if public text is short.

Review integrity:
- only verified/completed rentals can generate reviews;
- one review per side per rental;
- edits tracked;
- moderation available;
- fraud/manipulation detection.

---

## 31. TRUST SCORE

Create a reputation system stronger than a simple star rating.

Possible inputs:
- verification level;
- successful rentals;
- review score;
- cancellation rate;
- response time;
- calendar freshness;
- dispute history;
- confirmed listing accuracy;
- account age;
- rule compliance.

Do NOT allow users to directly buy trust.

Paid promotion may affect ad placement but must not artificially inflate trust.

Trust Score formula must:
- be documented internally;
- be resistant to easy gaming;
- avoid over-weighting one factor;
- have cold-start handling;
- have anti-manipulation safeguards.

Public UX should remain understandable.

Example:
“High trust”
“97/100”
plus explanation.

---

## 32. RENTAL DNA / COMPATIBILITY

This is a differentiator.

Property has structured characteristics/preferences.
Tenant has preferences.

System can estimate compatibility based on objective criteria.

Example tenant:
- dog;
- remote work;
- 6 months;
- max 2,000 BYN;
- not first floor.

Property:
- pets allowed;
- workspace;
- minimum 3 months;
- 1,900 BYN;
- 7th floor.

System:
“96% match”

This is a recommendation layer, NOT psychological profiling.

Do not infer sensitive traits.

Explain why:
- ✅ pets allowed;
- ✅ workspace;
- ✅ duration fits;
- ✅ budget fits;
- ✅ not first floor.

---

## 33. AI / NATURAL-LANGUAGE SEARCH

Support natural-language intent.

Example:
“I need a 2-room apartment in Minsk for 3 months, remote work, good Wi-Fi, occasional small dog, budget up to 2,000 BYN, no first floor, near metro.”

System extracts:
- city;
- property type;
- duration;
- workspace;
- Wi-Fi;
- pets;
- budget;
- floor;
- transport proximity.

Then searches structured inventory.

Results should explain why each result matches.

AI must never invent a property feature.
Only use indexed/verified listing data.

---

## 34. “WHY THIS LISTING”

For each result, explain:
- what matched;
- what did not;
- which facts are landlord-provided;
- which are verified;
- which are tenant-confirmed.

Example:
✅ within budget
✅ pets allowed
✅ workspace
✅ 8 minutes to metro
✅ Wi-Fi confirmed by 16 renters
❌ no air conditioning

This is a major trust feature.

---

## 35. FACTUAL CONFIRMATION BY TENANTS

Distinguish:
“Landlord says”
vs
“Guests confirmed”.

Example:
“Wi-Fi available”
“94% of guests confirmed Wi-Fi”

This data must be earned from completed rentals.

Design a moderation/anti-gaming layer.

---

## 36. CHECK-IN / CHECK-OUT

Introduce a rental workflow.

Check-in:
- confirm presence;
- confirm access;
- confirm core property condition;
- report issue;
- attach photos.

Check-out:
- confirm departure;
- optionally upload photos;
- note issues.

Use timestamps and audit events.

Do not force users into unnecessary complexity.
Quick flow first, detailed evidence second.

---

## 37. PROPERTY CONDITION TIMELINE

Optional/encouraged:
- before check-in photos;
- after check-in photos;
- checkout photos.

Build a timeline:
- landlord upload;
- tenant upload;
- timestamp;
- booking association.

Useful for disputes.

The platform is not automatically the legal adjudicator.
It preserves evidence and offers a structured case workflow.

---

## 38. CASE / DISPUTE SYSTEM

Every important problem can create a case.

Categories:
- listing mismatch;
- access problem;
- cleanliness;
- damaged property;
- payment disagreement;
- communication issue;
- suspected fraud;
- cancellation;
- no-show;
- other.

Case includes:
- booking;
- participants;
- messages;
- photos;
- timestamps;
- system events;
- status;
- admin actions;
- resolution notes.

Statuses:
OPEN
UNDER_REVIEW
WAITING_FOR_PARTY
RESOLVED
CLOSED
ESCALATED

Need role-based admin tools.

Never let regular support staff silently alter evidence.

---

## 39. PROPERTY / LISTING FRESHNESS

Display:
- calendar updated;
- listing updated;
- photos updated;
- verification date.

Search can rank fresher listings higher where appropriate.

Prevent stale listings from dominating results.

Possible inactivity automation:
- remind landlord;
- reduce ranking;
- temporarily pause if sufficiently stale;
- NEVER delete without clear policy.

---

## 40. SEARCH

Search must support:
- city;
- district;
- map area;
- price;
- duration;
- date;
- property type;
- rooms;
- guests;
- pets;
- smoking;
- amenities;
- floor;
- accessibility;
- parking;
- verification;
- rating;
- short/medium/long term;
- instant booking;
- negotiation;
- company/private owner;
- exact/approximate location;
- natural language.

Mobile UX is first-class.

---

## 41. MAP SEARCH

Support:
- map/list split;
- clustering;
- bounds search;
- price markers where useful;
- filter persistence;
- fast loading;
- mobile gestures.

Do not overwhelm map with too much information.

---

## 42. LANDLORD DASHBOARD

Need:
- listings;
- listing status;
- calendar;
- bookings;
- conversations;
- offers;
- pricing;
- analytics;
- reviews;
- verification;
- balance/debt;
- payouts are NOT part of MVP rental flow;
- notifications;
- account settings;
- legal documents/forms;
- support/cases.

---

## 43. TENANT DASHBOARD

Need:
- saved listings;
- search history;
- bookings;
- requests;
- offers;
- conversations;
- reviews;
- profile;
- verification;
- trust;
- notifications;
- cases;
- preferences;
- Telegram settings.

---

## 44. ADMIN PANEL

Must exist in MVP.

Admin capabilities:
- users;
- listings;
- properties;
- verification queue;
- reports;
- chats requiring review;
- blocked content;
- cases/disputes;
- review moderation;
- account restrictions;
- debt status;
- system configuration;
- audit logs;
- feature flags;
- notification management.

Administrative actions MUST be auditable.

No “magic” direct DB edits for routine business operations.

---

## 45. MONETIZATION

Primary planned monetization:
- 5% landlord service fee after completed rental.

Possible future monetization:
- paid listing boost;
- subscriptions for professional landlords;
- sponsored placements;
- additional smart tools;
- inspection/verification services;
- B2B tools.

IMPORTANT:
Paid promotion must not corrupt objective trust ranking.

Separate:
- organic trust;
- sponsored placement.

---

## 46. REWARDS / LOTTERY IDEA

Original product idea:
- every completed honest transaction can generate a digital ticket;
- tickets could participate in promotions/lottery/rewards;
- aim is to make honest on-platform completion more attractive than bypassing the platform.

However:
DO NOT ship a real monetary lottery/reward mechanism merely because it sounds good.

First verify:
- Belarusian lottery/advertising/gambling rules;
- tax treatment;
- licensing/registration implications;
- eligible prizes;
- organizational requirements.

For MVP:
Use non-controversial gamification:
- reputation;
- achievements;
- trust levels;
- loyalty points only if legally reviewed.

Build a future-compatible Reward subsystem, but gate the actual prize/lottery mechanism behind a feature flag and legal approval.

---

## 47. ANTI-FRAUD

Need platform-wide anti-fraud.

Signals:
- repeated suspicious accounts;
- repeated device patterns;
- payment/contact abuse where applicable;
- fake listings;
- reused images;
- suspicious message patterns;
- unrealistic pricing;
- review rings;
- abnormal booking patterns;
- account links;
- repeated disputes;
- identity anomalies.

Do not rely on one score.
Create risk signals and case management.

Avoid discriminatory or opaque decisions.
Provide admin explanation.

---

## 48. SECURITY

Treat this as a production financial-adjacent marketplace even though rental payments are outside our platform in MVP.

Minimum:
- secure authentication;
- session management;
- rate limiting;
- CSRF/XSS protections;
- SQL injection protections;
- output encoding;
- secure headers;
- secrets management;
- encryption;
- audit logs;
- file upload protection;
- malware scanning where appropriate;
- access controls;
- admin 2FA;
- brute-force protection;
- account takeover detection;
- password hashing using modern secure algorithm;
- secure password reset;
- email verification;
- phone verification.

Identity/document access should be especially strict.

---

## 49. PRIVACY

Create a real privacy architecture.

Data categories:
- account data;
- profile data;
- property data;
- booking data;
- chat data;
- review data;
- verification documents;
- audit events;
- device/security metadata.

Need:
- data minimization;
- purpose limitation;
- access control;
- deletion/retention rules;
- export/deletion workflow where legally applicable;
- admin access logs;
- consent management where required.

Do not expose internal identifiers unnecessarily.

---

## 50. LEGAL RESEARCH REQUIREMENT

Before production launch, research current Belarusian requirements using authoritative sources.

At minimum investigate:
- online marketplace/intermediary model;
- consumer protection;
- personal data;
- processing identity documents;
- advertising;
- platform terms;
- rental/lease agreements;
- short-term accommodation;
- long-term rental;
- registration requirements;
- taxes for landlords;
- service fee taxation/accounting;
- electronic documents;
- digital communications evidence;
- reviews;
- moderation/liability for user-generated content;
- anti-fraud responsibilities;
- lottery/reward legality;
- map/geolocation privacy;
- Telegram integration;
- storage/processing location issues if applicable.

Use official/current sources wherever possible.

Produce:
`LEGAL_RISK_REGISTER.md`

For each topic:
- requirement;
- confidence;
- source;
- impact;
- product implication;
- open question;
- lawyer review required? yes/no.

Never state “legally safe” without evidence.

---

## 51. TECHNICAL ARCHITECTURE PRINCIPLES

You must choose the best stack based on the existing repository.

If a stack already exists:
- inspect it;
- keep stable architecture unless there is a compelling reason to change it.

Preferred principles:
- modular backend;
- clean domain boundaries;
- typed contracts;
- database migrations;
- event-driven side effects where useful;
- background workers for asynchronous tasks;
- object storage for media;
- Redis or equivalent for caching/rate limits/jobs where useful;
- search abstraction;
- map abstraction;
- messaging subsystem;
- notification subsystem;
- audit subsystem;
- verification subsystem.

Do not over-engineer MVP.

---

## 52. DATA MODEL

Design normalized relational entities for core concepts.

At minimum consider:
- User
- UserProfile
- Role
- Verification
- VerificationDocument
- Property
- PropertyAddress
- PropertyLocation
- PropertyPhoto
- Amenity
- PropertyAmenity
- PropertyRule
- PropertyPricingRule
- AvailabilityRule
- CalendarBlock
- Listing
- ListingVersion
- Booking
- BookingParticipant
- BookingOffer
- BookingAmendment
- BookingEvent
- CheckIn
- CheckOut
- Review
- ReviewDimension
- TrustScoreSnapshot
- Conversation
- ConversationParticipant
- Message
- MessageModerationEvent
- DisputeCase
- CaseEvent
- ServiceFee
- LandlordLedgerEntry
- Notification
- TelegramConnection
- AuditLog
- AdminAction
- FraudSignal
- SavedSearch
- Favorite
- Report

Do not blindly create every table.
Choose the right normalization and ownership model.

Use immutable/auditable records for:
- money/fees;
- booking history;
- verification history;
- admin actions;
- important status transitions.

---

## 53. SEARCH ARCHITECTURE

Search must eventually scale.

Start simple if needed.
Potential technologies:
- PostgreSQL full text;
- PostGIS;
- search index such as OpenSearch/Elasticsearch if justified.

Do not introduce a search cluster just because it sounds sophisticated.
Choose based on actual scale and complexity.

Need:
- typo tolerance;
- filtering;
- geo search;
- ranking;
- freshness;
- verification;
- trust;
- price;
- availability.

---

## 54. FILE STORAGE

Property photos and identity documents must not live in the same unrestricted bucket.

Separate:
- public-ish listing media;
- private identity documents;
- private evidence files.

Use signed URLs / controlled access where appropriate.

---

## 55. NOTIFICATION ARCHITECTURE

Support:
- in-app;
- email;
- Telegram.

Do not hardcode notifications inside every domain service.
Use a notification abstraction/event layer.

Need:
- preferences;
- templates;
- localization;
- retries;
- idempotency;
- delivery status;
- deduplication.

---

## 56. AUDIT LOGGING

Critical events require audit logs:
- login/security changes;
- verification decisions;
- listing publication;
- listing modifications;
- booking status changes;
- offer changes;
- fee creation;
- debt changes;
- dispute actions;
- moderation;
- admin changes;
- contact-blocking decisions where appropriate.

Logs must be tamper-resistant enough for operational use and include:
- actor;
- target;
- action;
- timestamp;
- source;
- before/after or relevant diff;
- correlation ID.

---

## 57. UX PRINCIPLES

The platform must be:
- mobile-first;
- fast;
- simple for one-property landlords;
- powerful for professional landlords;
- understandable for non-technical users;
- localized to Belarus;
- transparent about costs;
- transparent about verification;
- transparent about booking status.

Avoid clutter.

Use progressive disclosure.

Do not force professional-level controls on casual users.

---

## 58. DESIGN LANGUAGE

Aim for:
- trustworthy;
- modern;
- calm;
- clean;
- practical;
- locally appropriate.

Do not copy Airbnb branding/UI.

Create original information architecture and visual identity.

---

## 59. SEO

Plan for:
- city pages;
- district pages;
- property pages;
- long-tail queries;
- structured data;
- canonical URLs;
- sitemap;
- robots;
- metadata;
- Open Graph;
- indexability controls;
- server-side rendering where appropriate.

Do not expose private profile/booking content to search engines.

---

## 60. PERFORMANCE

Targets:
- fast first load;
- optimized images;
- lazy loading;
- caching;
- CDN;
- database indexes;
- pagination;
- efficient map queries;
- debounced search;
- background processing.

Do not render huge result sets on mobile.

---

## 61. OBSERVABILITY

Production must have:
- structured logs;
- metrics;
- traces where useful;
- health endpoints;
- error tracking;
- alerts;
- background job monitoring;
- database health monitoring.

Critical business metrics:
- listings created;
- verified listings;
- booking requests;
- completed rentals;
- cancellation rates;
- response time;
- review completion;
- debt;
- active users;
- conversion;
- fraud cases.

---

## 62. TESTING

This is mandatory.

Test layers:
- unit;
- integration;
- API;
- database;
- authorization;
- end-to-end;
- frontend critical flows;
- mobile viewport;
- messaging;
- booking state machine;
- fee ledger;
- verification;
- reviews;
- anti-off-platform;
- Telegram notifications;
- admin workflows.

Critical scenarios must have automated tests.

Create adversarial tests for:
- double booking;
- race conditions;
- duplicate completion;
- duplicate fee;
- repeated review;
- fake contact info;
- permission escalation;
- stale calendar;
- booking cancellation edge cases;
- debt manipulation;
- malicious uploads;
- account takeover;
- replay requests.

---

## 63. IDEMPOTENCY / CONCURRENCY

Any endpoint that can be retried must be safe where appropriate.

Especially:
- booking creation;
- offer creation;
- booking acceptance;
- completion confirmation;
- fee creation;
- notifications;
- Telegram events.

Prevent double-booking under concurrent requests.

Use transactions/constraints appropriately.

---

## 64. FEATURE FLAGS

Use feature flags for:
- rewards;
- AI features;
- smart pricing;
- advanced verification;
- contact release;
- experiments;
- new ranking logic.

Feature flags must not become a dumping ground.
Document each flag.

---

## 65. ADMIN SAFETY

Admin UI must distinguish:
- read;
- moderation;
- verification;
- financial/fee operations;
- account suspension;
- system configuration.

Sensitive admin actions require:
- strong authentication;
- audit;
- possibly confirmation;
- reason field.

---

## 66. ERROR HANDLING

Every user-facing failure should:
- be understandable;
- avoid leaking internals;
- preserve user input where possible;
- provide next action;
- generate useful logs.

Do not show raw stack traces to users.

---

## 67. ACCESSIBILITY

Target a strong baseline:
- keyboard navigation;
- labels;
- semantic HTML;
- screen-reader support;
- contrast;
- focus states;
- form errors;
- mobile touch targets.

---

## 68. MOBILE-FIRST

Do not build desktop first and “adapt later”.

Critical mobile flows:
- search;
- map;
- listing;
- booking;
- chat;
- calendar;
- check-in;
- review;
- owner dashboard.

---

## 69. MVP PRIORITY

MVP MUST focus on:
1. auth;
2. profiles;
3. listing creation;
4. listing moderation;
5. map;
6. search/filter;
7. availability;
8. booking/request flow;
9. internal chat;
10. reviews;
11. verification levels;
12. landlord fee/debt ledger;
13. admin;
14. notifications;
15. basic Telegram notifications;
16. audit;
17. security;
18. privacy baseline;
19. SEO baseline;
20. legal documentation placeholders.

Do not delay launch for sophisticated AI.

---

## 70. POST-MVP

Phase 2:
- AI natural-language search;
- Rental DNA;
- smarter pricing;
- iCal sync;
- advanced fraud scoring;
- enhanced verification;
- photo authenticity;
- richer analytics;
- rewards infrastructure;
- loyalty features.

Phase 3:
- legally approved rewards/lottery mechanics;
- professional landlord subscriptions;
- advanced pricing automation;
- B2B tools;
- additional countries/languages.

---

## 71. CORE PRODUCT PRINCIPLES

When requirements conflict, prefer:

1. Legal safety.
2. User trust.
3. Security/privacy.
4. Correctness.
5. Simplicity.
6. Performance.
7. Flexibility.
8. Revenue optimization.

Never sacrifice legal/privacy/security just to launch faster.

---

## 72. WHAT CODEX MUST DO FIRST

Before writing code:

### STEP 1 — REPOSITORY AUDIT

Inspect:
- all directories;
- package manifests;
- frontend;
- backend;
- database;
- Docker;
- CI/CD;
- environment files;
- infrastructure;
- existing tests;
- docs;
- previous audits;
- TODOs;
- known broken features.

Do not assume the repository is correct.

Create:
`REPO_AUDIT.md`

Include:
- architecture;
- strengths;
- weaknesses;
- broken areas;
- security concerns;
- technical debt;
- missing components;
- recommended architecture.

### STEP 2 — BUILD PRODUCT TRACEABILITY

Create:
`PRODUCT_REQUIREMENTS.md`

Convert this prompt into:
- requirements;
- acceptance criteria;
- dependencies;
- priorities;
- implementation status.

Every major requirement gets an ID.

Example:
AUTH-001
LIST-001
BOOK-001
CHAT-001
REV-001
VERIFY-001
FEE-001
TRUST-001
ADMIN-001
LEGAL-001

### STEP 3 — ARCHITECTURE

Create:
`ARCHITECTURE.md`

Include:
- system diagram;
- domain boundaries;
- data flows;
- state machines;
- security boundaries;
- integrations;
- queues/jobs;
- storage;
- deployment model.

### STEP 4 — PRODUCT FLOWS

Create:
`USER_FLOWS.md`

Document:
- tenant flow;
- landlord flow;
- admin flow;
- booking;
- cancellation;
- completion;
- review;
- verification;
- debt;
- dispute;
- Telegram linking.

### STEP 5 — DATABASE DESIGN

Create:
`DATABASE_DESIGN.md`

Include:
- entities;
- relations;
- constraints;
- indexes;
- status enums;
- audit data;
- immutability rules.

### STEP 6 — LEGAL RISK REGISTER

Create:
`LEGAL_RISK_REGISTER.md`

Research current authoritative Belarusian sources.

### STEP 7 — IMPLEMENTATION PLAN

Create:
`IMPLEMENTATION_PLAN.md`

Break into:
- Phase 0 foundation;
- Phase 1 MVP;
- Phase 2 post-MVP;
- Phase 3 advanced features.

Every task needs:
- requirement IDs;
- dependencies;
- expected files/modules;
- acceptance criteria;
- tests.

---

## 73. HOW CODEX MUST WORK AFTER PLANNING

Do not stop after producing documentation.

Proceed to implementation.

For each domain:
1. inspect;
2. design;
3. implement;
4. test;
5. audit;
6. fix;
7. document.

Do not move to the next major domain with known critical defects unresolved.

---

## 74. “BEST DECISION” PROTOCOL

When a decision is not explicitly defined:

1. Identify the ambiguity.
2. List 2–4 viable solutions internally.
3. Compare:
   - legal risk;
   - security;
   - UX;
   - maintainability;
   - performance;
   - cost;
   - extensibility.
4. Choose the best.
5. Record the decision in:
   `DECISIONS.md`

Use a stable format:
- Decision ID;
- Question;
- Options;
- Chosen solution;
- Why;
- Consequences;
- Revisit trigger.

Do not constantly ask for trivial clarification.
Make expert decisions and document them.

Only ask the user when:
- a decision has major irreversible business/legal consequences;
- multiple options are equally valid and materially different;
- missing information blocks implementation.

---

## 75. NO FAKE COMPLETION

Never claim:
- “implemented” if only mocked;
- “secure” if not tested;
- “legally compliant” without legal evidence;
- “production-ready” without audit;
- “verified” without actual verification.

Maintain explicit statuses:
- NOT STARTED
- IN PROGRESS
- IMPLEMENTED
- TESTED
- AUDITED
- BLOCKED

---

## 76. QUALITY GATE BEFORE CALLING MVP COMPLETE

MVP cannot be considered complete until:

- core user journeys work end-to-end;
- database migrations work from clean state;
- tests pass;
- critical security checks pass;
- authorization tests pass;
- no critical booking race condition known;
- no duplicate fee creation;
- no broken debt logic;
- reviews only available after completed rentals;
- contact blocking tested;
- admin flows tested;
- audit logs work;
- Telegram notification flow works;
- mobile UX reviewed;
- SEO baseline exists;
- error tracking exists;
- backup/recovery strategy documented;
- legal risk register exists;
- deployment reproducible;
- environment/configuration documented.

Create:
`MVP_RELEASE_CHECKLIST.md`

---

## 77. FINAL AUDIT

Before declaring success, perform an independent audit pass.

Review the product as:
1. tenant;
2. landlord;
3. administrator;
4. attacker;
5. fraudster;
6. mobile user;
7. first-time user;
8. professional landlord;
9. long-term tenant;
10. short-term tourist.

Then create:
`FINAL_PRODUCT_AUDIT.md`

Include:
- what works;
- what does not;
- risks;
- technical debt;
- legal open questions;
- user-experience problems;
- security findings;
- next priorities.

---

## 78. DELIVERABLES

At minimum maintain:
- README.md
- REPO_AUDIT.md
- PRODUCT_REQUIREMENTS.md
- ARCHITECTURE.md
- USER_FLOWS.md
- DATABASE_DESIGN.md
- LEGAL_RISK_REGISTER.md
- IMPLEMENTATION_PLAN.md
- DECISIONS.md
- SECURITY.md
- PRIVACY.md
- MVP_RELEASE_CHECKLIST.md
- FINAL_PRODUCT_AUDIT.md

Add other documents as needed.

---

## 79. COMMUNICATION STYLE

When reporting progress:
- be concise but factual;
- report actual completed work;
- mention blockers;
- mention important trade-offs;
- show what was tested.

Do not produce fake confidence.

At milestone completion provide:
- completed;
- tested;
- remaining;
- risk.

---

## 80. FINAL PRODUCT OUTCOME

The final platform should feel like:

> A modern Belarusian rental platform where finding housing, verifying the person/property, understanding the true price, communicating, booking, documenting the stay, reviewing the experience, and building reputation are all part of one coherent system.

The platform should support both:
- a person renting one apartment for one night;
- and a professional landlord managing dozens of apartments.

The platform should be flexible rather than forcing one rental model.

The core differentiator is TRUST + TRANSPARENCY + FLEXIBILITY.

Do not clone Airbnb.
Use the best ideas from the global market, learn from their user pain points, and build a better system for Belarus.

---

## 81. FIRST COMMAND / FIRST ACTION

Before modifying the repository, perform a complete repository inspection.

Then create:
1. REPO_AUDIT.md
2. PRODUCT_REQUIREMENTS.md
3. ARCHITECTURE.md
4. DECISIONS.md
5. IMPLEMENTATION_PLAN.md

Only then start implementation.

Do not delete working functionality without evidence that replacement is safer/better.

Do not rewrite the whole project merely because a different stack is fashionable.

Be an owner of the result, not a code generator.
