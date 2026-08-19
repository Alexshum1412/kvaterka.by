# MVP_RELEASE_CHECKLIST.md

Gates from master spec §76. **MVP cannot be called complete while any box is unchecked.** Current state is recorded honestly, including the items that are nowhere near done.

## Core journeys

- [ ] Tenant: search → listing → request → confirmed → check-in → completion → review
- [ ] Landlord: create → moderated → published → accept → completion → fee → debt visible
- [ ] Admin: moderate, verify, resolve a dispute, view audit
- [x] Booking lifecycle works end to end **at the service layer** (32 integration tests)

## Database

- [x] Migrations build the full schema from empty
- [x] Migrations refuse to run if an applied file was edited
- [ ] Backup and restore procedure documented and rehearsed
- [ ] Indexes reviewed against real query plans on representative data

## Tests

- [x] Test suite passes — 1034 tests (`npm test` is the source of truth for the number)
- [x] Typecheck clean
- [ ] **Suite run against a real PostgreSQL server** via `TEST_DATABASE_URL` — the CI job that stands one up now exists (`.github/workflows/verify.yml`) and has never run, because this environment has no Docker and no server. Still the gate that covers true concurrency
- [ ] Authorization test suite for every API endpoint
- [ ] End-to-end browser tests for critical flows
- [ ] Mobile viewport tests

## Correctness invariants

- [x] No known booking race — `EXCLUDE` constraint, tested for overlap, containment, adjacency, cancellation, competing acceptance
- [ ] Same, verified under genuine simultaneous transactions
- [x] No duplicate fee — three independent guards, tested including retries
- [x] Debt logic correct — signed immutable ledger, balance is `SUM`, no mutable balance column
- [x] Reviews only from a completed rental, one per side
- [x] Contact blocking tested — evasion corpus and a 24-message false-positive corpus
- [x] Financial and audit records immutable

## Security

- [x] Authentication implemented (argon2id, hashed session tokens, rotation)
- [x] Rate limiting on auth, messaging, booking
- [x] CSRF protection (`SameSite=Lax` + `HttpOnly` + `Secure`; no state change on GET)
- [x] Admin 2FA — enforced by withholding staff roles until a second factor is satisfied
- [~] Upload validation — type and size are checked; **no re-encoding**, so EXIF and embedded payloads survive
- [ ] Secure headers and CSP
- [x] Secrets managed outside the repository — validated at startup, only `.env.example` is tracked
- [~] Dependency vulnerability scan in CI — `npm audit` runs, advisory only; no SAST
- [x] Identity documents structurally unreachable by `SUPPORT`
- [x] Every document read logged (append-only)

## Privacy

- [x] Data minimisation applied (hashed IPs, diff-only audit, hashed session tokens)
- [x] Exact location withheld until confirmation
- [x] Staff two-factor authentication — TOTP, enforced by withholding roles, with recovery codes, escalating lockout and step-up on the sensitive permissions. Limitation: the secret is stored in plaintext (DEC-055).
- [~] Notification delivery — the worker, the retry ladder and the console exist and run. **Only IN_APP reaches anybody**: EMAIL needs `SMTP_URL` plus a client, TELEGRAM needs a bot token plus the webhook that makes account linking reachable. Both refuse rather than reporting false success.
- [x] Booking request expiry — on the existing FSM, in the hourly lifecycle sweep, idempotent and race-safe against a landlord accepting.
- [~] Retention job implemented — the job, the holds and the console exist and run. It destroys expired credentials and **no personal data**: no retention window has been chosen (LEGAL-004) and no private object storage exists. Both refuse independently, so this is not "done" and is not a stub either.
- [~] Export/erasure workflow — **closure** ships (access ends, sessions revoked, listings paused, nothing destroyed). **Erasure** is not built and is gated on LEGAL-003; `ERASURE_STEPS` in `domain/retention.ts` is the work list and each entry names its blocker. Export is not started.
- [ ] Legal hold reviewed on a cadence — the mechanism and the overdue surface exist; the operational habit does not
- [ ] Consent management — depends on LEGAL-003

## Product

- [x] Admin panel exists — operations overview, dispute queue, verification console, retention console, security
- [ ] Telegram notification flow works end to end — needs a bot token **and** the webhook that makes account linking reachable; there are zero linked chats
- [~] Notification outbox with deduplication running — the outbox, the worker, the retry ladder, the inbox and the preferences screen all exist and run. **Only IN_APP reaches anybody**
- [~] Verification levels 0/1/2 operating — 0 and 1 operate; 2 requires identity documents and is gated off pending LEGAL-004
- [ ] Mobile UX reviewed at 375 px, 430 px and desktop
- [ ] Accessibility baseline: keyboard, labels, contrast, focus, touch targets
- [ ] Loading, empty and error states on every async surface
- [ ] SEO baseline: structured data, sitemap, canonicals, private routes excluded

## Operations

- [ ] Reproducible deployment — no Dockerfile, no hosting target (blocked on LEGAL-003)
- [x] Environment/configuration documented — every variable the code reads is in `.env.example`
- [~] Structured logs and health endpoints — API errors log as JSON with a correlation id; the scheduler prints one JSON line per job; **no health endpoint**
- [ ] Error tracking
- [~] Background job monitoring — `job_run` records every run and `/admin/notifications/backlog` reports the queue; nothing watches either
- [ ] Alerts on failed fee accrual, stuck completions, notification backlog

## Legal — **blocking**

- [x] Legal risk register exists with 16 identified questions
- [ ] **LEGAL-003** answered — determines hosting region; **answer before provisioning infrastructure**
- [ ] **LEGAL-016** answered — determines whether the service fee is enforceable as modelled
- [ ] **LEGAL-004** answered — required before identity verification launches
- [ ] LEGAL-002 / LEGAL-005 answered — invoicing, VAT, accounting
- [x] LEGAL-012 (rewards) neutralised — gated behind a flag, no prize logic in the codebase
- [ ] Terms of service drafted by a Belarus-qualified lawyer — `/terms` exists and deliberately is **not** one: it describes actual platform behaviour and says the document is missing
- [ ] Privacy policy drafted — same posture at `/privacy`

---

## Honest summary

Most of the MVP surface is now built: the data model, the money handling, the state machine, the
abuse-resistant pieces, and since then authentication, the API, the interface, the staff consoles,
verification, disputes, retention and staff 2FA.

What remains is not mostly feature work. It is four things the codebase cannot do to itself:

1. **Nothing the platform says can leave it.** No email or Telegram client exists, so only the
   in-app inbox reaches anybody. Needs credentials and a client.
2. **An accrued fee cannot be paid.** No payment provider is connected. The 5% is calculated,
   recorded and enforced as a restriction — and there is no way to settle it through the platform.
3. **The real-server concurrency run** (no Docker, no PostgreSQL server available here).
4. **Every legal question**, which needs a Belarus-qualified lawyer — hosting region above all,
   because it decides where the database may physically live.
