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

- [x] Test suite passes — 274 tests
- [x] Typecheck clean
- [ ] **Suite run against a real PostgreSQL server** via `TEST_DATABASE_URL` — not possible in the current environment (no Docker, no server); this is the gate that covers true concurrency
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

- [ ] Authentication implemented (argon2id, hashed session tokens, rotation)
- [ ] Rate limiting on auth, messaging, booking
- [ ] CSRF protection
- [ ] Admin 2FA
- [ ] Upload validation, re-encoding, malware handling
- [ ] Secure headers and CSP
- [ ] Secrets managed outside the repository
- [ ] Dependency vulnerability scan in CI
- [x] Identity documents structurally unreachable by `SUPPORT`
- [x] Every document read logged (append-only)

## Privacy

- [x] Data minimisation applied (hashed IPs, diff-only audit, hashed session tokens)
- [x] Exact location withheld until confirmation
- [ ] Retention job implemented
- [ ] Export/erasure workflow
- [ ] Consent management — depends on LEGAL-003

## Product

- [ ] Admin panel exists
- [ ] Telegram notification flow works end to end
- [ ] Notification outbox with deduplication running
- [ ] Verification levels 0/1/2 operating
- [ ] Mobile UX reviewed at 375 px, 430 px and desktop
- [ ] Accessibility baseline: keyboard, labels, contrast, focus, touch targets
- [ ] Loading, empty and error states on every async surface
- [ ] SEO baseline: structured data, sitemap, canonicals, private routes excluded

## Operations

- [ ] Reproducible deployment
- [ ] Environment/configuration documented
- [ ] Structured logs and health endpoints
- [ ] Error tracking
- [ ] Background job monitoring
- [ ] Alerts on failed fee accrual, stuck completions, notification backlog

## Legal — **blocking**

- [x] Legal risk register exists with 16 identified questions
- [ ] **LEGAL-003** answered — determines hosting region; **answer before provisioning infrastructure**
- [ ] **LEGAL-016** answered — determines whether the service fee is enforceable as modelled
- [ ] **LEGAL-004** answered — required before identity verification launches
- [ ] LEGAL-002 / LEGAL-005 answered — invoicing, VAT, accounting
- [x] LEGAL-012 (rewards) neutralised — gated behind a flag, no prize logic in the codebase
- [ ] Terms of service drafted by a Belarus-qualified lawyer
- [ ] Privacy policy drafted

---

## Honest summary

Roughly one third of the MVP surface is built, and the part that is built is the part that is hardest to retrofit: the data model, the money handling, the state machine and the abuse-resistant pieces. The remaining two thirds — auth, API, UI, search, admin, notifications — is more work in volume but less risk per line, because the invariants it must respect are already enforced beneath it.

Two gates cannot be closed from within this environment and must be closed elsewhere:

1. The real-server concurrency run (no Docker, no PostgreSQL server available here).
2. Every legal question, which needs a Belarus-qualified lawyer.
