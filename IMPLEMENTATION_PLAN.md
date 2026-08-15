# IMPLEMENTATION_PLAN.md

Phases are ordered by dependency and by risk-reduction value, not by visibility. Requirement IDs refer to [PRODUCT_REQUIREMENTS.md](PRODUCT_REQUIREMENTS.md).

---

## Phase 0 — Foundation · **DONE**

| Task | Requirements | Files | Status |
|---|---|---|---|
| Stack selection and scaffold | — | `package.json`, `tsconfig.json`, `vitest.config.ts` | DONE |
| Schema + migrations | LIST-001..009, BOOK-*, FEE-*, REV-* | `db/migrations/0001…0005` | TESTED |
| Migrator with checksums | — | `src/server/db/migrator.ts` | TESTED |
| Dual database adapters | — | `src/server/db/{pglite,postgres}.ts` | TESTED |
| Money arithmetic | FEE-001..003, 008 | `src/server/domain/money.ts` | TESTED |
| Pricing and total transparency | PRICE-001..007 | `src/server/domain/pricing.ts` | TESTED |
| Booking state machine | BOOK-001 | `src/server/domain/booking/states.ts` | TESTED |
| Completion resolution | COMPLETE-001..007 | `src/server/domain/booking/completion.ts` | TESTED |
| Contact filter | CHAT-002..008 | `src/server/domain/messaging/` | TESTED |
| Booking service end-to-end | BOOK-002..009, FEE-004..007 | `src/server/services/booking-service.ts` | TESTED |
| Audit mechanism | ADMIN-002 | `src/server/services/audit.ts` | IMPLEMENTED |

**Exit criteria met:** 274 tests passing, `tsc --noEmit` clean, schema builds from empty.

---

## Phase 1 — MVP

Ordered so that nothing is built on an unauthenticated foundation.

### 1.1 Authentication and authorization — *next*

| Task | Requirements | Acceptance | Tests |
|---|---|---|---|
| argon2id password hashing | AUTH-002 | Configured cost; verify rejects wrong password | unit |
| Session issue/rotate/revoke | AUTH-003 | Token stored hashed; rotation chain; expiry honoured | integration |
| Registration + email/phone verification | AUTH-001, 004 | Single-use expiring tokens with attempt limits | integration |
| Password reset | AUTH-005 | Single-use; invalidates existing sessions | integration |
| Rate limiting | AUTH-006 | Per-account and per-IP on auth endpoints | integration |
| RBAC policy layer | AUTH-008 | `SUPPORT` provably cannot reach documents | authorization tests |
| Admin 2FA | AUTH-007 | Staff roles require a second factor | integration |

**Exit:** an authorization test suite that asserts each role's boundary, including negative cases.

### 1.2 HTTP API

Zod schemas at every boundary; `DomainError` → status mapping; correlation id per request; no stack traces to clients (UX-005). Route handlers for listings, bookings, messages, reviews.

**Exit:** every service method reachable, every input validated, malformed input returns 422 with field detail.

### 1.3 Design system and core screens

Per DEC-013: tokens and palette from `ui-ux-pro-max`/`design-system`, anti-slop discipline from the taste skills, **no scroll-jacking or decorative motion in product flows**.

Screens, mobile-first: search + map, listing page, booking flow, chat, landlord calendar, dashboards.

**Exit:** each screen has loading, empty and error states; keyboard navigable; contrast checked; verified at 375 px, 430 px and desktop.

### 1.4 Listing lifecycle

Creation wizard (1 photo minimum), photo upload with validation and hashing, moderation queue with reasons, publication, freshness signals. (LIST-002, 003, 008)

### 1.5 Search and map

Radius, bounds and district search over the existing geo indexes; structured filters; Russian full-text with typo tolerance; clustering; result ranking that mixes relevance, freshness, verification and trust — with paid placement kept structurally separate. (SEARCH-001..004, TRUST-002)

### 1.6 Messaging

Conversations wired to the filter; moderation events recorded; contact release on confirmation; unread state. (CHAT-001, 009)

### 1.7 Reviews

Two-sided submission after completion; publish-when-both-or-timeout to prevent retaliation; structured dimensions; guest-confirmed facts. (REV-001..007)

### 1.8 Verification

Level 0/1/2 flows; private document upload; verifier queue; access logging; retention purge job. (VERIFY-001..005)

### 1.9 Debt handling

Landlord balance UI; restriction policy that limits *new* commercial activity but never harms an active booking; reminders; grace period; audited admin override. (FEE-009, 010)

### 1.10 Admin panel

Moderation, verification, cases, users, restrictions, feature flags, audit viewer. Every action audited with a reason. (ADMIN-001..003)

### 1.11 Notifications

Outbox worker with the dedupe key; preferences; email; Telegram linking. (NOTIFY-001..003)

### 1.12 Background workers

Request expiry, completion windows, elapsed-completion resolution, staleness, retention. All idempotent. (BOOK-011)

### 1.13 SEO, observability, deployment

City/district/property pages with structured data, sitemap, canonicals, and private routes excluded from indexing. Structured logs, health endpoints, error tracking, job monitoring. Reproducible deployment, documented configuration, backup/restore procedure.

---

## Phase 2 — Post-MVP

Natural-language search (extract structured filters from a sentence; **never invent a property feature**), Rental DNA compatibility with explicit reasons, "why this listing" explanations, smart pricing suggestions (opt-in, never silently changing a landlord's price), iCal import/export, richer fraud scoring, photo authenticity, analytics.

---

## Phase 3 — Advanced

Legally-approved rewards **only after LEGAL-012 is answered in writing**, professional landlord subscriptions, pricing automation, B2B tools, additional locales and markets.

---

## Cross-cutting gates

Applied at every phase, not deferred to the end:

1. Automated tests for the critical path before a feature is called done.
2. Authorization tests for every new endpoint, including negative cases.
3. Audit coverage for every state-changing operation.
4. Mobile verification at 375 px before desktop polish.
5. Adversarial tests for anything touching money, dates or permissions.
6. A decision record for every non-obvious choice.
