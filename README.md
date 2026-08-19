# Kvaterka

A rental marketplace for Belarus — trust infrastructure for honest rentals, not a classifieds board.

Landlords publish and manage listings; tenants find, compare, communicate, book, document and review. The platform never touches rent: tenant and landlord settle directly, and the platform charges the landlord a 5% service fee once a completed rental is confirmed by both sides.

> **Status: substantially built, not yet launchable.** Authentication, sessions, RBAC and staff 2FA, a 125-route HTTP API, and the web interface — search, listing, booking, chat, dashboards, moderation and four staff consoles — all exist and are tested. What blocks a launch is not features: no email or Telegram message can currently leave the platform, no payment provider is connected so an accrued fee cannot be paid, no hosting decision has been made (LEGAL-003), and no lawyer has drafted the terms or the privacy policy. See [MVP_RELEASE_CHECKLIST.md](MVP_RELEASE_CHECKLIST.md) for the gates, and do not read "tested" as "production-ready".

## Quick start

```bash
npm install
```

```bash
npm test
```

Tests need no database server — they run a real PostgreSQL 18 engine in-process via PGlite.

```bash
npm run verify
```

Typecheck, lint and the full test suite.

To run the suite against a real PostgreSQL server (required before release, because it is the only mode that exercises genuine concurrency):

```bash
TEST_DATABASE_URL=postgres://user:pass@localhost:5432/kvaterka_test npm test
```

## What exists

| Area | State |
|---|---|
| Schema, migrations, constraints | Tested — 5 SQL migrations, builds from empty |
| Money and the 5% fee | Tested — integer kopecks, deterministic rounding |
| Pricing and price transparency | Tested — nightly, monthly, tiered, seasonal |
| Booking state machine | Tested — declarative transition table |
| Two-sided completion + fee accrual | Tested — end to end against the database |
| Anti-off-platform contact filter | Tested — RU/BE corpus, evasion and false-positive cases |
| Auth, sessions, RBAC, staff 2FA | Tested — argon2id, hashed rotating session tokens, TOTP enforced by withholding roles |
| HTTP API | Tested — 125 routes declared as data, driving dispatch, authorization, validation, rate limiting and idempotency |
| Web interface | Built — search, listing, booking, chat, trips, landlord dashboard, four staff consoles |
| Verification levels 0/1/2 | Tested — level 2 gated off pending LEGAL-004 |
| Disputes and moderation | Tested — queue, decisions, and the exit back into the booking FSM |
| Retention, legal hold, account closure | Built — closure ships; erasure is gated on LEGAL-003 |
| Notification delivery | Built — outbox, worker, retry ladder. **Only IN_APP reaches anybody**: no email or Telegram client exists |
| Scheduled jobs | Built — one job runner, a machine credential, and a scheduler script; needs a deployment to run against |
| Payments | **Not started** — an accrued fee cannot be paid through the platform |

**1034 tests passing.** `npm test` is the source of truth for that number.

## Layout

```
db/migrations/        SQL schema, applied verbatim and in order
scripts/              migrate, seed, and the job scheduler
src/
  app/                Next.js App Router: pages and the API adapter
  lib/                UUIDv7, references, browser API client
  server/
    api/              Route table, dispatcher, machine principal, rate limit, idempotency
    auth/             Argon2id credentials, sessions, RBAC
    db/               Db interface; PGlite and node-postgres adapters; migrator
    delivery/         Notification provider contract and the providers that ship
    domain/           Pure logic: money, pricing, booking FSM, completion, 2FA, retention
    services/         Transaction boundaries, audit, error mapping
  ui/                 Components; light theme, cornflower palette, mobile first
tests/                Integration suites against a real PostgreSQL engine
```

The dependency arrow points one way: `services → domain`. Domain modules do no I/O, read no clock inside decision functions, and import no framework — which is why they can be exhaustively tested.

## Design principles

**Invariants live in the database.** Application checks produce good error messages; the database constraint is the guarantee. Double booking is prevented by an `EXCLUDE USING gist` constraint, not a check-then-insert. The service fee cannot be charged twice because three independent constraints say so. Financial and audit records cannot be updated or deleted by anyone, including an administrator.

**Money is never a float.** All amounts are integer kopecks in `bigint`. The fee stores its base, rate and result so it can be re-derived and verified years later.

**No fake completion.** Nothing in the documentation is marked implemented because a UI for it exists. Statuses follow the specification's vocabulary: NOT STARTED / IN PROGRESS / IMPLEMENTED / TESTED / AUDITED / BLOCKED.

## Documentation

| Document | Contents |
|---|---|
| [REPO_AUDIT.md](REPO_AUDIT.md) | **Historical** — the day-one audit of an empty repository. Not current status |
| [DECISIONS.md](DECISIONS.md) | Architecture decision records with alternatives and trade-offs |
| [ARCHITECTURE.md](ARCHITECTURE.md) | System shape, layering, where correctness lives |
| [DATABASE_DESIGN.md](DATABASE_DESIGN.md) | Entities, constraints, indexes, immutability |
| [PRODUCT_REQUIREMENTS.md](PRODUCT_REQUIREMENTS.md) | Requirement IDs, acceptance criteria, implementation status |
| [USER_FLOWS.md](USER_FLOWS.md) | Transition table, tenant/landlord/admin journeys, completion decision matrix |
| [IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md) | Phased plan with requirement traceability |
| [SECURITY.md](SECURITY.md) | Threat model, controls implemented vs designed, known gaps |
| [PRIVACY.md](PRIVACY.md) | Data categories, minimisation, retention, document handling |
| [LEGAL_RISK_REGISTER.md](LEGAL_RISK_REGISTER.md) | 16 open legal questions — **all unverified, all require a Belarus-qualified lawyer** |
| [MVP_RELEASE_CHECKLIST.md](MVP_RELEASE_CHECKLIST.md) | Gates that must pass before MVP can be called complete |

## Legal position

Nothing in this repository has been reviewed by a lawyer. The legal register names the questions precisely and states what each product decision assumes; it deliberately contains no citations, because inventing plausible legal claims about a jurisdiction is more dangerous than admitting the gap. The rewards/lottery concept is built as a feature flag with `requires_legal_approval` and **no prize logic exists in the codebase**.
