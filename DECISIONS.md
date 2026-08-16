# DECISIONS.md

Architecture decision record. Format per master spec §74. Newest decisions are appended; existing entries are amended rather than rewritten, with a revision note.

---

## DEC-001 — Greenfield build rather than adapting an existing codebase

**Question.** The brief says not to rewrite a working project. Does anything here need preserving?

**Options.** (a) Preserve and extend existing code. (b) Build from scratch.

**Chosen.** (b), because the repository contained only the specification — no code, no schema, no git history. See [REPO_AUDIT.md](REPO_AUDIT.md) §1.

**Consequences.** No migration risk, no legacy constraints; equally, no validated foundation to lean on, so every invariant must be established deliberately.

**Revisit when.** Never — this is a historical record.

---

## DEC-002 — Next.js (App Router) + TypeScript for the web tier

**Question.** What serves the product?

**Options.** (a) Next.js App Router. (b) Separate SPA + standalone API (NestJS/Fastify). (c) Server-rendered templates.

**Chosen.** (a).

**Why.** The spec requires server-side rendering for SEO on city, district and property pages (§59) *and* private, non-indexable dashboards in the same product. App Router gives per-route rendering control, so a property page can be static-ish and a booking page strictly dynamic without two deployments. (b) doubles the deployment surface and forces CORS/session plumbing for a team that does not need it yet — the spec explicitly warns against premature microservices (§24 of the brief). (c) cannot deliver the calendar and map interactions the product is built around.

**Trade-offs.** Ties the frontend to a React/Vercel-shaped ecosystem. Mitigated by keeping all business logic in `src/server/domain` and `src/server/services`, which import nothing from Next — they are plain TypeScript and are tested without any framework.

**Revisit when.** The API needs non-web consumers (mobile app, partner integrations) at meaningful volume.

---

## DEC-003 — PostgreSQL with hand-written SQL migrations, no ORM migration tool

**Question.** How is the schema defined and evolved?

**Options.** (a) Prisma. (b) Drizzle with generated migrations. (c) Hand-written SQL applied by a small migrator.

**Chosen.** (c).

**Why.** The correctness of this product rests on constructs that schema-diffing tools do not model faithfully: `EXCLUDE USING gist` constraints, partial unique indexes with predicates, constraint triggers, generated columns, and `BEFORE UPDATE OR DELETE` immutability triggers. Prisma cannot express an EXCLUDE constraint at all. A generator that silently drops the one constraint preventing double booking is not a productivity tool, it is a liability. The SQL files *are* the schema, applied verbatim, in order, exactly once, with checksums that refuse a migration edited after it was applied.

**Trade-offs.** No automatic TypeScript types from the schema; repositories declare their own row types. Accepted — the row types are small, explicit and reviewed. Query building is manual, which is why every query is parameterised and reviewed for injection.

**Revisit when.** The schema exceeds roughly 60 tables and hand-maintained types start drifting from reality.

---

## DEC-004 — Money as integer minor units in `bigint`

**Question.** How is money represented?

**Options.** (a) `number` (float). (b) `numeric` in the database, `string`/decimal library in code. (c) integer minor units (kopecks) in `bigint`.

**Chosen.** (c).

**Why.** The 5% fee is a debt claim against a real person; it must be recomputable byte-for-byte years later. Floats cannot represent 0.1 exactly, so (a) is disqualified outright. (b) is defensible but drags in a decimal library and still requires a rounding policy; integers make the rounding policy explicit and the arithmetic exact with no dependency. `pg`'s int8 parser is deliberately left returning strings so nothing is silently downcast to a lossy JS number.

**Trade-offs.** `bigint` does not survive `JSON.stringify`, so amounts cross API boundaries as decimal strings. `money()` throws rather than accepting a fractional `number`, which is a deliberate tripwire.

**Revisit when.** A second currency with different minor units is introduced (the `MINOR_UNITS` map already anticipates this).

---

## DEC-005 — Rounding half away from zero

**Question.** Which rounding policy for the fee?

**Options.** (a) Banker's rounding (half to even). (b) Half away from zero. (c) Always floor.

**Chosen.** (b).

**Why.** It is what a Belarusian accountant and a landlord reading an invoice both expect: 50.5 kopecks becomes 51, never 50. Banker's rounding is statistically fairer across large populations but produces results people read as arbitrary, and this fee is shown to individuals one invoice at a time. (c) systematically favours the landlord and quietly loses platform revenue.

**Trade-offs.** A negligible upward bias across many transactions. Implemented as exact integer arithmetic — `(|n|·2 + |d|) / (|d|·2)` — so it is not subject to floating-point behaviour.

**Revisit when.** An accountant requires a different statutory convention.

---

## DEC-006 — Listing status and booking status are separate state machines

**Question.** The spec's suggested state list (§10) mixes `DRAFT`/`PENDING_MODERATION`/`PUBLISHED` with booking states. Follow it literally?

**Options.** (a) One enum as listed. (b) Two independent lifecycles.

**Chosen.** (b) — and this is a deliberate divergence from the specification.

**Why.** `DRAFT` and `PUBLISHED` describe a *listing*; `CONFIRMED` and `COMPLETED` describe a *booking*. They have different owners, different permissions, different transitions and different lifespans — a listing outlives every booking made against it. A single enum would make "which of the twenty states may a landlord set?" unanswerable and would force every query to filter on states that cannot apply. The spec anticipates this: "Do NOT blindly copy this list."

**Trade-offs.** Two vocabularies to learn. Mitigated by the transition table being the single documented source of truth for bookings.

**Revisit when.** Never expected to.

---

## DEC-007 — Booking requests do not hold the calendar

**Question.** Should a pending request block the dates?

**Options.** (a) Block on request. (b) Block only on confirmation.

**Chosen.** (b).

**Why.** Blocking on request lets any tenant freeze a landlord's calendar at no cost — a trivial denial-of-service against the landlord's income, and an obvious sabotage vector between competing landlords. With (b) several tenants may request the same nights, the landlord chooses, and the `EXCLUDE` constraint makes the first acceptance win atomically. The losers are auto-declined *with a stated reason* in the same transaction, so nobody is left waiting on a request that can no longer succeed.

**Trade-offs.** A landlord can accept a request whose dates were taken moments earlier; they get `DATES_UNAVAILABLE` rather than a double booking. That is the correct failure.

**Revisit when.** Landlords report confusion; the fix is better UI signalling of contested dates, not calendar locking.

---

## DEC-008 — Completion resolution follows the incentive asymmetry

**Question.** What happens when only one side confirms whether the rental happened?

**Options.** (a) Require both, else no fee. (b) Auto-complete on any single confirmation. (c) Treat each answer according to whether it runs against the answerer's own interest.

**Chosen.** (c).

**Why.** (a) hands landlords a free opt-out: stay silent, owe nothing. (b) charges people with no evidence. (c) reasons about who benefits from lying:

- Landlord says *it happened* → admission against interest, trusted immediately, no waiting.
- Tenant says *it happened*, landlord silent past the deadline → completes and the fee accrues; silence must not be cheaper than honesty.
- Tenant says *it did not happen* → believed; the tenant has no fee exposure either way.
- Landlord alone says *it did not happen* → honoured, but a `UNILATERAL_LANDLORD_DENIAL` fraud signal is recorded so a pattern surfaces even though a single instance is unprovable.
- Both silent → charge **only** if the platform holds a check-in record. With no evidence at all, no debt is created.
- They contradict each other → `DISPUTED`, no fee, human review.

The last rule matters legally as much as commercially: the platform is asserting a monetary claim, so the burden of evidence sits with the platform.

**Trade-offs.** A dishonest landlord can evade one fee by denying a rental the tenant never confirms. Deliberate. The alternative — charging without evidence — is worse commercially and legally. Detection is a pattern problem, handled by fraud signals.

**Revisit when.** Fraud-signal data shows the denial route being used at scale; response should be graduated (verification requirements, restrictions), not automatic charging.

---

## DEC-009 — Property and Listing are one aggregate; snapshots carry history

**Question.** Separate `property` and `listing` tables, as §52 suggests?

**Options.** (a) Two tables. (b) One `property` table plus immutable `listing_snapshot` rows.

**Chosen.** (b).

**Why.** In this product a property has exactly one public offer, and the duration/price matrix is expressed by pricing rules rather than parallel listings. Two tables would buy a join and no capability. The genuinely valuable thing a separate listing table would provide — knowing what the offer said at the moment someone booked it — is provided better by `listing_snapshot`, which is append-only, hash-stamped and referenced by every booking. That is what makes a dispute winnable after the landlord edits the property.

**Trade-offs.** If one property ever needs two simultaneously live offers, this needs revisiting. Nothing in the spec requires it.

**Revisit when.** A landlord needs genuinely distinct concurrent offers on one property.

---

## DEC-010 — Double booking prevented by a database constraint, not application logic

**Question.** How is overlap prevented?

**Options.** (a) Check availability then insert. (b) Application-level lock (Redis/advisory). (c) `EXCLUDE USING gist`.

**Chosen.** (c).

**Why.** (a) is a race by construction — the gap between check and insert is exactly where the second request slips through, and it will only ever manifest under load. (b) works but adds infrastructure and fails open if the lock service is unavailable. (c) is enforced by the database itself, holds against any number of concurrent transactions, and keeps holding when someone later writes a new code path, an admin tool, or a manual `INSERT`. The constraint is partial — restricted to the states that actually occupy the calendar — so pending requests can legitimately overlap (DEC-007).

The bounds are `[)`: the checkout day belongs to the next tenant. Getting that wrong costs the landlord one bookable night on every single stay, so there is an explicit test for back-to-back bookings.

**Trade-offs.** Requires `btree_gist`, and callers must translate SQLSTATE `23P01` into a human message — done once, in `translateBookingWriteError`.

**Revisit when.** Never. If anything, more invariants should move down to this level.

---

## DEC-011 — UUIDv7 primary keys

**Question.** What identifier type?

**Options.** (a) bigserial. (b) UUIDv4. (c) UUIDv7.

**Chosen.** (c), generated in the application.

**Why.** (a) leaks business volume in URLs — a competitor can read how many bookings exist, and an attacker can enumerate them. (b) fixes that but scatters inserts across the whole index, fragmenting B-trees on tables that grow forever. (c) keeps identifiers opaque while remaining time-ordered, so inserts stay at the right edge of the index and "newest first" queries read sequential pages.

**Trade-offs.** A v7 id reveals its creation time. Acceptable for these entities. **A sharp edge worth recording:** ids minted in the same millisecond share their leading hex digits, so a truncated prefix is not unique — this bit the test fixtures before it could bite production.

**Revisit when.** An entity needs a genuinely unguessable, timing-free id (use v4 there specifically).

---

## DEC-012 — Monthly prices bill in 30-night months

**Question.** A landlord advertises 1900 BYN/month. What does a 30-night stay cost?

**Options.** (a) Convert to nightly via 365/12 and multiply. (b) Whole 30-night months at the monthly price, remainder per night. (c) Calendar months.

**Chosen.** (b).

**Why.** (a) quotes 1874 BYN for a month against an advertised 1900 — the platform looks like it is shaving money off landlords, and the arithmetic is unexplainable to a non-technical user. (c) makes an identical stay cost different amounts depending on whether it starts in February or March, which is impossible to display honestly in a search result. (b) gives exactly 1900 for 30 nights, which is what both parties expect.

**Trade-offs.** A 31-night stay costs one nightly rate more than a 30-night one. Explainable and visible in the price breakdown.

**Revisit when.** Long-term landlords ask for calendar-month billing tied to a lease start date.

---

## DEC-013 — How the installed design skills are applied (and where they are not)

**Question.** The brief mandates `ui-ux-pro-max`, `gpt-taste` and `design-taste-frontend`. Apply them wholesale?

**Options.** (a) Follow all three literally. (b) Apply selectively, documenting divergence.

**Chosen.** (b).

**Why.** The skills are installed and are the design reference, but two of them state scope that does not match this product:

- `design-taste-frontend` says explicitly: *"Landing pages, portfolios, and redesigns. Not dashboards, not data tables, not multi-step product UI."* A rental marketplace is precisely multi-step product UI with data tables and a calendar.
- `gpt-taste` targets awards-style pages: heavy GSAP scroll pinning, stacking and scrubbing, "massive section spacing". Applied to a booking flow on a mid-range Android phone that is a slow, distracting interface, and it directly contradicts the brief's own instruction not to make the UI experimental for its own sake, and the spec's demands for fast, calm, trustworthy and mobile-first (§57, §58).

What is taken from them: the anti-slop discipline — no generic AI-SaaS gradient-card look, real typographic hierarchy, deliberate spacing scale, distinctive but restrained visual identity, no meaningless meta-labels. `ui-ux-pro-max` and `design-system` are used as intended for tokens, palette, type pairing and accessibility.

What is rejected: scroll-jacking, pinned/stacked sections and decorative motion anywhere in the booking, search, calendar or chat flows. Motion is limited to state feedback and respects `prefers-reduced-motion`.

**Trade-offs.** The result will not look like an awards submission. It is intended to look like infrastructure people trust with their housing.

**Revisit when.** Marketing landing pages are built — that *is* `gpt-taste`'s stated scope, and it should be applied there.

---

## DEC-014 — PGlite for tests, real PostgreSQL for CI and production

**Question.** How are database-dependent tests run with no Docker available?

**Options.** (a) Mock. (b) SQLite. (c) PGlite. (d) Require a server, skip tests locally.

**Chosen.** (c), with (d) as a required additional CI mode.

**Why.** Detailed in [REPO_AUDIT.md](REPO_AUDIT.md) §2.1. Briefly: the invariants under test are PostgreSQL features, so only a real PostgreSQL engine can test them. SQLite lacks every relevant construct and would produce green tests over a broken production schema.

**Trade-offs.** PGlite serialises connections and cannot exercise simultaneous transactions. Stated in the code, in the audit and in the release checklist rather than glossed over. `TEST_DATABASE_URL` runs the identical suite against a server, and that run is a release gate.

**Revisit when.** Docker becomes available in the development environment; PGlite remains valuable for its speed.

---

## DEC-015 — Rewards/lottery ships disabled behind a flag

**Question.** Build the reward-ticket mechanic described in §46?

**Options.** (a) Build and enable. (b) Build and gate. (c) Omit entirely.

**Chosen.** (b) — schema and flag only, `requires_legal_approval = true`, no prize logic implemented.

**Why.** A ticket-based prize draw is plausibly a lottery under Belarusian law, which carries licensing, registration, tax and advertising consequences that this project has not verified. The spec is unambiguous that it must not ship without legal confirmation. (c) would be safe but would force a schema migration later. (b) keeps the door open at near-zero cost while making it structurally impossible to enable by accident: the `feature_flag` row carries `requires_legal_approval`, and no prize-drawing code exists to enable.

**Trade-offs.** An unused table. Trivial cost against a licensing risk.

**Revisit when.** A Belarus-qualified lawyer has answered LEGAL-012 in [LEGAL_RISK_REGISTER.md](LEGAL_RISK_REGISTER.md).

---

## DEC-016 — Contact filter redacts; it does not silently swallow messages

**Question.** What happens to a message containing a phone number before booking confirmation?

**Options.** (a) Block the whole message. (b) Deliver unchanged and flag for review. (c) Redact the contact fragment, deliver the rest, tell the sender why.

**Chosen.** (c), escalating to (a) only when three or more independent detectors fire at high confidence.

**Why.** (a) destroys legitimate content and gives the sender no idea what went wrong, which teaches people to distrust the chat — the very thing that drives them off-platform. (b) does not protect anything. (c) keeps the conversation usable, states the rule, and preserves the original text in `body_original` for moderation and evidence. A bare messenger mention with no actual contact detail ("а вайбер у вас есть?") is only flagged, never altered — it may be an ordinary question, and pattern analysis is the right response, not censorship.

**Trade-offs.** A determined pair will eventually succeed. The goal is not perfect prevention; it is making off-platform migration the inconvenient path while keeping honest users unaffected.

**Revisit when.** False-positive reports appear, or the detectors' recorded match data shows an evasion pattern the layers miss.

---

## DEC-017 — Day-granularity stays for MVP; hourly deferred

**Question.** §6 mentions hours as a possible duration unit.

**Options.** (a) Support hourly now via `tstzrange`. (b) Day granularity via `daterange`, defer hourly.

**Chosen.** (b).

**Why.** Hourly rental changes the calendar UI, the pricing model, the overlap semantics and the check-in flow all at once, and in Belarus it also carries a distinct regulatory character that has not been assessed. `daterange` with `[)` bounds is the correct model for nightly, weekly, monthly and yearly stays, which is every case the spec's own examples describe. The schema was verified to support an `EXCLUDE` over `tstzrange` as well, so the path is open.

**Trade-offs.** Hourly landlords are unserved at launch.

**Revisit when.** There is demand plus a legal assessment of short-hourly accommodation.

---

## DEC-018 — The API is a route table, not framework callbacks

**Question.** How should HTTP endpoints be declared?

**Options.** (a) Next.js route handlers, one file per endpoint. (b) A separate HTTP framework (Fastify/Hono) inside Next. (c) Routes declared as data, dispatched by a small router, with a thin Next adapter.

**Chosen.** (c).

**Why.** The same declaration then drives dispatch, authentication, authorization, validation, rate limiting, idempotency **and** the generated OpenAPI document. Those six concerns cannot drift apart, because there is only one place to change. With (a) each concern is re-implemented per file and the OpenAPI document becomes a hand-maintained lie within a month; a missing `requireAuth()` in one file is invisible until someone exploits it.

It also makes the entire API testable without starting a server: `tests/api.integration.test.ts` drives the real dispatcher in-process. And it made the authorization matrix test possible — it *enumerates* `allRoutes.filter(r => r.permission)` and asserts each one refuses an ordinary user, so a newly added privileged endpoint cannot ship unguarded.

(b) was rejected as a second framework inside a framework for no capability gain.

**Trade-offs.** A small amount of routing machinery is ours to maintain (~200 lines). Next's per-route conventions (segment config, caching hints) are not used; the API is uniformly dynamic and `no-store`, which is correct for an API where almost every response is scoped to one user.

**Revisit when.** The API needs per-route caching or streaming that the adapter cannot express.

---

## DEC-019 — Rate limiting in PostgreSQL, not in process memory

**Question.** Where does the rate-limit counter live?

**Options.** (a) In-process map. (b) Redis. (c) PostgreSQL fixed-window counters.

**Chosen.** (c).

**Why.** (a) is wrong the moment there is more than one instance — and the limit that matters most is on login, where being wrong means an attacker simply spreads attempts across instances. (b) is the textbook answer and would be faster, but it adds infrastructure, another failure mode, and a decision about what happens when it is unavailable (fail open, and the limit is theatre; fail closed, and Redis becomes a hard dependency for logging in). (c) costs one upsert per limited request, is correct across instances, and shares the availability of the database the request needs anyway.

**Trade-offs.** A write per limited request, and a fixed window permits a burst at a boundary — acceptable for login attempts and message sending, where the goal is bounding sustained abuse rather than perfectly smoothing traffic. `pruneRateLimitCounters()` handles housekeeping.

**Revisit when.** Request volume makes the write measurable, or a sliding window is genuinely needed.

---

## DEC-020 — The blurred map pin is deterministic

**Question.** How is a property's public location computed?

**Options.** (a) Round the coordinates. (b) Random offset per request. (c) Deterministic offset derived from the property id, stored on the row.

**Chosen.** (c).

**Why.** (b) is the intuitive choice and is actively dangerous: an observer who reloads the page a few hundred times can average the samples and recover the true coordinates to within a few metres. Blurring is only privacy-preserving if it is *stable*. (a) leaks a grid that reveals which properties share a cell and snaps pins to visibly artificial positions.

(c) derives a bearing and a 120–350 m radius from a hash of the property id, so the pin is identical on every request forever, sits somewhere plausible on a nearby street, and cannot be averaged away. The displaced point is stored (`public_latitude`/`public_longitude`) and is what search, the map endpoint and the public listing page read — the exact coordinate has a single accessor, `revealExactLocation`, which checks entitlement first.

**Trade-offs.** A pin can land across a street from the real building. That is the intended cost. Changing the offset algorithm moves every existing pin, so it is effectively permanent once listings exist.

**Revisit when.** Never, without a migration plan.

---

## DEC-021 — Idempotency at two layers

**Question.** How are retried POSTs made safe?

**Options.** (a) Database constraints only. (b) An `Idempotency-Key` record only. (c) Both.

**Chosen.** (c).

**Why.** They fail differently. (a) alone is correct but rude: a client that retries after a timeout gets a 409 where it expected its booking, and cannot tell "already created by me" from "someone took the dates". (b) alone is defeated by any client that forgets the header — including our own future code.

Together: `idempotency_record` replays the original response for a repeated key, and underneath it `service_fee.booking_id UNIQUE`, the booking idempotency index and the state machine make duplicates unreachable even with no key at all.

The stored `request_hash` matters: reusing a key with a different payload is refused rather than replayed, since silently returning the wrong response would be worse than an error. A failed request releases its key so an honest retry can proceed.

**Trade-offs.** One extra table and an insert per idempotent request. `pruneIdempotencyRecords()` expires them after 24 hours.

**Revisit when.** Never expected to; if anything, more endpoints should opt in.

---

## DEC-022 — Debt restricts new commercial activity only

**Question.** What should an unpaid service fee prevent?

**Options.** (a) Suspend the account. (b) Block everything commercial immediately. (c) Graduated: promotion first, then new listings and new bookings once overdue, never touching active rentals.

**Chosen.** (c), above a 50.00 BYN threshold.

**Why.** A landlord mid-stay has a tenant living in their property. Suspending them punishes the tenant — who did nothing wrong — and turns a billing dispute into a housing emergency, which is precisely the "rental with surprises" the product exists to prevent. It is also commercially self-defeating: the fee is likelier to be paid by someone still earning through the platform.

Inside the grace period only discretionary extras (promotion) stop. Once a fee is genuinely overdue, new listings, new bookings and instant booking stop. Existing conversations, active bookings and completion flows are never touched.

The threshold means a single small fee does not disable an account over an amount not worth chasing.

**Trade-offs.** A landlord can complete an in-flight booking while owing money. Intended.

**Revisit when.** Collection data shows the graduated model is ineffective; the response should be better reminders before harsher restrictions.
