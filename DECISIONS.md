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

---

## DEC-023 — Light is the product; dark is kept, not designed

**Question.** After the owner rejected the rendered interface as dark, heavy and dated, is the fix a palette swap or a system change — and what happens to dark mode?

**Options.** (a) Lighten the existing tokens and keep both themes as first-class. (b) Rebuild the system light-first and delete dark mode. (c) Rebuild light-first, keep dark tokens working but stop designing for them.

**Chosen.** (c).

**Why.** The owner was explicit that the problem was not the palette, and they were right: the previous system's defaults produced a bordered, shadowed, tinted box around every group, and that recipe looks equally dated in any hue. So the rules changed, not just the values — a surface now gets space *or* a border *or* elevation, never two; borders are reserved for controls, where a visible edge is a usability requirement; and cards carry no resting shadow at all, because white on the #f7f9fc ground is already a boundary.

Deleting dark mode (b) was tempting and wrong. The tokens already existed, they cost nothing to keep, and a user on a dark OS would otherwise get an unreadable page. But maintaining two designed themes doubles every judgement call, and the light one is not finished. So dark remains *functional and unpolished*, and that is stated rather than implied.

**Trade-offs.** Dark mode will look competent, not considered, until light is approved. Anyone tuning it before then is working on the wrong thing.

**Revisit when.** The light system is signed off and dark-mode usage justifies the second pass.

---

## DEC-024 — The brand blue that carries text is not the brand blue

**Question.** The supplied palette names `#4da3ff` as primary. Buttons drawn in it fail contrast. What gives?

**Options.** (a) Use `#4da3ff` for buttons and accept 2.6:1. (b) Use it with dark text instead of white. (c) Keep it as a decorative accent and derive a deeper sibling for anything that carries text.

**Chosen.** (c). `--accent` is `#4da3ff`; `--primary` is `#216aca`.

**Why.** White on `#4da3ff` measures 2.63:1 — below even the 3:1 floor for large text — so (a) fails the brief's own accessibility requirement. (b) works numerically (navy on `#4da3ff` is 5.86:1) but makes the primary call to action read as a soft chip rather than the strongest thing on the page.

(c) keeps the sky-cornflower visible where it is doing colour work and no contrast work — the mark, focus accents, selected grounds under navy text, active map pins — while buttons and links use the same hue pushed down until it is legible.

The values were *solved*, not guessed. `scripts/contrast.mjs` encodes every pair as an assertion and exits non-zero on failure; three first-choice colours were rejected by it, and the binding constraint turned out not to be white at all but `--primary` reading as text on `--primary-soft` inside a selected chip.

**Trade-offs.** The button blue is not literally the brand blue. Both appear together constantly, so the family reads as one; and the palette cannot drift, because CI-able arithmetic now guards it.

**Revisit when.** A brand refresh changes the hue — in which case rerun the script before shipping, not after.

---

## DEC-025 — Favourites are a table, and PUT/DELETE rather than POST

**Question.** The heart on a listing card has to persist something. Where, and over what verbs?

**Options.** (a) localStorage. (b) A table, saved with `POST /favorites` and removed with `POST /favorites/:id/remove`. (c) The existing table, with `PUT`/`DELETE`.

**Chosen.** (c).

**Why.** (a) was rejected on product grounds: people search on a phone at lunch and decide on a laptop at night, and a shortlist that does not survive that is not a shortlist. It also cannot be honest — a heart that fills in without saving anywhere is exactly the fake state this project refuses.

The `favorite` table has existed since `0005_trust_and_money.sql` and had never been wired to anything; a second one was written by mistake during this pass and deleted once that was noticed. Between (b) and (c): saving a listing is a statement about desired state, not an event, and `PUT`/`DELETE` are idempotent by definition. That removes the need for an idempotency key, a replay record, and any possibility that a double tap on a bad connection produces the wrong result. The composite primary key `(user_id, property_id)` performs the deduplication in the database, so `ON CONFLICT DO NOTHING` is the whole write path.

One rule is load-bearing and lives in the service, not the router: only a `PUBLISHED` listing may be saved, and an unpublished one answers exactly as a non-existent one does. Without that, the endpoint is an existence oracle for private drafts. There is a test asserting the two responses are byte-identical.

**Trade-offs.** A saved listing that is later unpublished silently drops out of the shortlist; the favourites page counts the gap and says so rather than leaving the user to wonder.

**Revisit when.** Landlords want "N people saved this" — which needs an index on `property_id`, deliberately not added until something reads it.

---

## DEC-026 — The query string is a prop, not a hook

**Question.** Three client components read the URL with `useSearchParams()`. Next.js requires each to sit inside a `<Suspense>` boundary. Is that boundary acceptable?

**Options.** (a) Keep `useSearchParams()` and the boundaries. (b) Keep the hook but hand-tune the fallbacks so they resemble the real control. (c) Pass the query down from the server as props and delete the boundaries.

**Chosen.** (c).

**Why.** Not for elegance — because (a) was actively broken. In the running app the boundary around the search module resolved to its grey skeleton and never resumed: the DOM carried React's postponed marker `<!--$~-->`, the real `<form>` sat in a sibling `<div hidden>`, and the visitor saw an empty rectangle where the product's single most important control should be. The same defect applied to the filter bar and, worse, to the sign-in form — the login screen could never have been used.

Nothing about that is visible in a typecheck, a unit test or an HTTP status code. All five routes returned 200 the entire time. It was found by measuring the rendered DOM, which is the argument for doing that at all.

The fix is also the better design independently of the bug. The server already parsed `searchParams` in order to run the query; handing the same values to the component removes a client-side round trip, puts the real search markup in the server-rendered HTML instead of a skeleton, and deletes the loading flash. `useRouter()` stays — navigation does not suspend.

**Trade-offs.** Each page must now pass the parameters it cares about, so adding a filter means touching the page as well as the control. That is a small, visible cost in exchange for a whole class of invisible failure.

**Revisit when.** A component genuinely needs the query string somewhere no server component can reach it.

---

## DEC-027 — The colour scheme no longer follows the operating system

**Question.** `@media (prefers-color-scheme: dark)` switched the whole product to the navy palette automatically. Keep it?

**Options.** (a) Keep automatic switching. (b) Delete dark mode. (c) Keep the tokens, make dark strictly opt-in via `data-theme`.

**Chosen.** (c).

**Why.** The reviewer reported the site as "dark navy" and asked for a light product. The light design already existed — they had simply never been shown it, because their OS is in dark mode and the media query overrode everything. A design nobody can see is not a design, and the first measurement of the running page confirmed it: `background-color: rgb(12, 20, 36)`.

Automatic switching is normally the courteous default. It stops being courteous when only one of the two themes has been designed: it hands half the audience the unfinished one, silently, with no way to ask for the other. Making dark explicit means every visitor sees the theme that has actually had the work.

`themeColor` in the viewport metadata moved to a single light value for the same reason — advertising a navy browser chrome above a white page is worse than not advertising one.

**Trade-offs.** A user who prefers dark now gets light until a theme switch exists. That is the intended trade while light is the only designed surface, and re-attaching the media query is a one-line change once dark has had its own pass.

**Revisit when.** Dark mode gets a real design pass; then restore the media query and ship a preference control at the same time.

---

## DEC-028 — A draft is allowed to be incomplete, and the database says when it stops being one

**Question.** The wizard asks for a property type on screen one and a price on screen eight. `title`, `city`, `latitude`, `longitude` and `base_price_minor` were all `NOT NULL`, so no row could exist until the end and there was nowhere to autosave to. Where does wizard state live?

**Options.** (a) Hold the first screens in the browser and create the row at the end. (b) A `listing_draft` table holding wizard state as JSON, materialised into a `property` when complete. (c) Make those columns nullable and require completeness only when leaving `DRAFT`.

**Chosen.** (c), as migration 0008.

**Why.** (a) fails the actual requirement: work that only exists in a tab is lost when the tab closes, which is precisely what "draft persistence is mandatory" rules out.

(b) was the obvious engineering answer and is worse than it looks. It means two representations of one listing, a dual write on every keystroke, an inevitable divergence between them, and — the detail that decided it — a draft that cannot appear in the landlord's dashboard until it is finished, because the dashboard reads `property`.

(c) has one source of truth throughout. The columns become nullable and a `CHECK` asserts that anything whose status is not `DRAFT` has a title, a city, a coordinate pair and a price. The guarantee a tenant depends on is unchanged: nothing reachable from search or a listing page can be missing those. What changed is that the schema stopped pretending a half-filled form is a listing.

`property_type` stays `NOT NULL` — it is the first question, so a row never exists without it.

**Trade-offs.** The constraint is now a status-conditional expression rather than a column property, which is less obvious to someone reading the table definition; the migration comment carries the reasoning. `submitForModeration` re-checks the same conditions first so the landlord gets a sentence rather than a constraint violation, and a test asserts the raw `UPDATE` is refused when the service is bypassed.

**Revisit when.** Another status needs its own completeness rules — then this becomes a table of requirements per status rather than one expression.

---

## DEC-029 — Uploads are sniffed, server-named, and never optimistic

**Question.** `addPhoto` took a storage key that nothing in the system produced. How do bytes actually get in?

**Options.** (a) Accept a client-supplied key and trust it. (b) Presigned URLs straight to object storage. (c) A server endpoint that receives the file, identifies it, names it, stores it, then records it.

**Chosen.** (c), at `/api/uploads`, outside the JSON route table because that dispatcher validates JSON bodies and this receives multipart.

**Why.** (a) hands an attacker both path traversal and the ability to overwrite another listing's photo; the key is generated server-side as `listings/<propertyId>/<uuid>.<ext>` and the client never influences it.

(b) is where this ends up in production, but no provider is chosen yet, and building the presigning half against a bucket that does not exist would be scaffolding around a hole.

The content type is decided by the first bytes, not the declared header — `image/png` on a shell script costs an attacker nothing, and the same sniff yields the real dimensions for free from the PNG and JPEG headers.

The rule that matters most: success is reported only after the bytes are on disk *and* the row is written, and `addPhoto` checks ownership, so a landlord cannot attach a file to somebody else's listing even though it is already written. When `MEDIA_BUCKET_URL` is set the endpoint returns 501 rather than a cheerful lie — a landlord must never be told a photo uploaded when it did not.

**Trade-offs.** Development bytes live in `.media/`, which is gitignored and is not production storage. The media route serves them with `X-Content-Type-Options: nosniff` and re-checks the resolved path against the root, so a key still cannot escape.

**Revisit when.** An object-storage provider is chosen — then this endpoint issues presigned URLs and keeps the ownership check.

---

## DEC-030 — Rejection reasons are codes, and every decision is kept

**Question.** `property.rejection_reason` is one text column that the next decision overwrites. Is that enough for a moderation workflow?

**Options.** (a) Keep the single column and a free-text reject button. (b) Add reason codes to the column. (c) A row per decision, with structured codes, alongside the existing column.

**Chosen.** (c), as `listing_moderation_review` in migration 0009.

**Why.** Free text fails three separate jobs at once. It cannot be counted, so nobody can ever learn why listings actually get rejected. It cannot be translated. And it cannot be linked to anything — which matters most, because the useful thing to do with a rejection is send the landlord back to the *step* that needs fixing, and only a code can carry that mapping. `MODERATION_REASON_STEP` is what turns "слишком мало фотографий" into opening screen three of the wizard.

Overwriting was the other half of the problem. A listing rejected twice for the same reason looked exactly like one rejected once; a moderator picking up a resubmission could not see what a colleague had already asked for. So each decision is now a row, and the column keeps the *current* reason because the dashboard and the wizard already read it.

This is not a second audit log. `audit_log` records that an actor did something, generically, as a diff, across the whole system. This records the moderation decision as a domain object with the reasons that drive user-facing behaviour. Both are written in the same transaction.

Backwards compatibility was deliberate: a caller that supplies only free text still works and is recorded as `OTHER` with the text as the comment. Silently dropping an explanation would have been worse than accepting an unstructured one.

**Trade-offs.** The vocabulary is duplicated between TypeScript and a SQL `CHECK`. That is intentional — the codes are branch conditions in the UI, so adding one is a code change anyway, and the constraint stops a typo reaching the database. Both sites carry a comment pointing at the other.

**Revisit when.** Reason counts start driving product decisions, at which point the codes want their own table with descriptions and an `active` flag.

---

## DEC-031 — Immutable history, except when the listing itself goes

**Question.** The review history is append-only. Its `property_id` has `ON DELETE CASCADE`. Those contradict: deleting a property tried to cascade, the trigger refused, and a listing that had ever been moderated could no longer be deleted at all.

**Options.** (a) Drop the append-only trigger. (b) Change the foreign key to `RESTRICT`. (c) Allow the delete only when it is a cascade.

**Chosen.** (c), in migration 0010.

**Why.** (a) gives up the property the table exists for — history that can be edited is not history. (b) is defensible, since the project soft-deletes with `deleted_at` and hard deletes are not a normal operation, but it turns a legitimate cleanup into a foreign-key error and leaves orphaned moderation notes as the only alternative.

(c) draws the distinction that actually matters: a row deleted on its own is somebody editing history, while a row deleted because its listing is gone is the listing taking its history with it — which is also the data-minimising outcome, since moderation notes about a property that no longer exists serve nobody. During a cascade the parent row is already gone when the row trigger fires, and during a direct delete it is still there, so the trigger can tell them apart reliably.

The tamper-evident trail is unaffected either way: `audit_log` records every `listing.moderate` action independently, keyed by target id, and is cascaded from nothing. A test asserts exactly that — the history disappears with the listing, the audit row does not.

**Trade-offs.** The trigger now contains a condition rather than an unconditional refusal, so it must be read carefully. Two tests pin both halves.

**Revisit when.** Another append-only table acquires a cascading parent — then this becomes a shared helper rather than a one-off function.

---

## DEC-032 — A moderator does not get the exact address

**Question.** A moderator checks that a listing is real and correctly described. Does that require the street and apartment number?

**Options.** (a) Yes — show the full address for verification. (b) No — show the same blurred point a tenant sees.

**Chosen.** (b).

**Why.** DEC-020 gave the exact address exactly one accessor, `revealExactLocation`, which checks entitlement first, and the reason was that a stable blurred point is only privacy-preserving if nothing else leaks the real one. "A moderator is looking at it" is not an entitlement; it is a new access path, and adding one would quietly undo that decision for every listing on the platform.

What a moderator actually needs is to judge whether the *approximate* location is plausible — which is the location a tenant will act on anyway. If a listing's real address matters (a fraud investigation), that is a separate, logged, entitlement-checked act, not a side effect of routine review.

The same reasoning already governs identity documents: `document.read` is held by VERIFIER alone, not by MODERATOR, SUPPORT, FINANCE or even ADMIN, and every read is written to `document_access_log`. The moderation screen says so in plain words, so a moderator is not left wondering whether they are missing a tool.

**Trade-offs.** A moderator cannot personally confirm a building exists at a given address. That check belongs to property verification, which is a different role with a different audit trail.

**Revisit when.** Property verification is built out — and then it gets its own entitlement, not this one.

---

## DEC-033 — The booking note is a chat message, not a booking field

**Question.** A tenant may attach a note to a booking request. The API accepted `message`, validated it, passed it into `requestBooking` — and the service dropped it on the floor. Where should it live?

**Options.** (a) A `message` column on `booking`. (b) Discard it (the status quo, unintentionally). (c) Post it as the first message of the property's conversation.

**Chosen.** (c).

**Why.** (b) was a bug, not a decision: the field was in the zod schema and the input interface, so every layer advertised a feature that did nothing. Worse, it was the kind of bug that looks like a feature in a demo.

(a) is the obvious fix and the wrong one, because it creates a second place where tenant-authored prose reaches a landlord — and only one of the two would be behind the contact filter. A phone number in a booking note would then be a documented way around the rules that govern chat. The filter is the reason this project has a messaging service at all.

(c) routes the note through `MessagingService.sendMessage`, so it is filtered, stored with its original preserved for dispute evidence, and logged as a moderation event exactly like any other message. It also means the conversation a landlord opens from the request already contains the tenant's opening line, which is what both sides expect.

A filtered or blocked note does not fail the booking. The dates matter more than the note, and the filter has already done its job by the time the decision is made.

**Trade-offs.** The message is not visible on the booking row itself; it is one click away in the thread. A failure to open the conversation is swallowed rather than surfaced, deliberately — the reason a message was refused is not something a sender should be able to probe.

**Revisit when.** Bookings need structured, non-prose metadata from the tenant (arrival time, number of pets), which is a form, not a message.

---

## DEC-034 — One live request per tenant, per property, per dates

**Question.** `POST /bookings` is idempotent when the caller sends an `Idempotency-Key`. The route's comment claimed the domain guarded it too, without one. It did not — a double click created two REQUESTED rows.

**Options.** (a) Correct the comment and rely on the client sending a key. (b) Derive a fallback idempotency key server-side from tenant + property + dates. (c) A domain rule: refuse a second *active* request for overlapping dates from the same tenant on the same property.

**Chosen.** (c).

**Why.** (a) is honest but leaves the API depending on client good behaviour, which §22 explicitly rules out.

(b) looked right and is subtly wrong. A derived key is permanent, so a tenant who withdrew a request, or was declined, could never request those dates again — the endpoint would keep replaying the dead booking forever.

(c) states the actual rule. Two *different* tenants competing for the same nights is legitimate and stays legitimate, which is the behaviour a marketplace needs; re-requesting after a withdrawal or a decline is also legitimate. What is never anything but an accident is one person holding two open requests for the same nights, and that is what is now refused — by returning the existing booking, so a double click is indistinguishable from a single one.

Scoped to `REQUESTED`, `OFFER_PENDING`, `CONFIRMED` and `CHECKED_IN`, using the same `daterange` overlap operator as the exclusion constraint that prevents double-booking, so the two rules cannot disagree about what "overlapping" means.

**Trade-offs.** A tenant who genuinely wants two overlapping bookings on one property — which has no legitimate meaning — cannot have them. The HTTP idempotency layer stays in place; this is a second, independent guard rather than a replacement.

**Revisit when.** Multi-unit properties exist, where one tenant booking two overlapping stays on the same listing could be real.

---

## DEC-035 — The review window is opened by the transition, not by the review service

**Question.** `OPEN_REVIEW_WINDOW` has been declared as a side effect of the transition into `COMPLETED` since the state machine was written. Nothing executed it: `booking.review_deadline_at` stayed NULL on every completed rental. Where should the deadline be stamped?

**Options.** (a) Lazily, the first time somebody asks whether they may review. (b) In `ReviewService`, when the first review arrives. (c) In `BookingService.applyResolution`, in the same transaction as the status change.

**Chosen.** (c).

**Why.** This was a bug with two silent consequences, and both are worth recording because neither was visible from a passing test suite.

The landlord's «можно оставить отзыв» prompt counts completed bookings with a live `review_deadline_at`, so it was permanently zero — a feature that existed, was tested at the service layer, and could never appear on screen.

The more serious one: `publishExpiredWindows()` only publishes reviews whose booking has a deadline that has passed. With the column NULL, a one-sided review could never publish. The entire point of the deadline is that a party cannot suppress criticism forever simply by never writing their own review, and that protection was inert.

Options (a) and (b) both make the deadline depend on somebody showing up, which is exactly the dependency the deadline exists to remove. (c) puts it where the state machine already says it belongs: the transition into `COMPLETED` is the event that opens the window, so the same transaction that writes `status = 'COMPLETED'` writes the clock. `NOT_TAKEN_PLACE` and `DISPUTED` get no deadline, because there is nothing to review.

`REVIEW_WINDOW_DAYS` moved to `domain/booking/completion.ts` beside `COMPLETION_WINDOW_DAYS` so the booking service can reach it without importing a service, and `ReviewService` re-exports it. One definition, two readers.

**Trade-offs.** A booking completed before this change still has a NULL deadline. `eligibility()` treats NULL as "open", so those remain reviewable rather than being retroactively closed — the safer direction — but they will not auto-publish one-sided. A backfill is a data migration, not a code change, and is not attempted here.

**Revisit when.** The window needs to differ by stay length; a one-night stay and a one-year tenancy plausibly deserve different review deadlines.

---

## DEC-036 — Reporting a problem opens a case; nothing resolves it automatically

**Question.** `OPEN_DISPUTE` exists in the FSM from `CONFIRMED`, `CHECKED_IN` and `COMPLETION_PENDING`, with no service method, no endpoint and no UI. The completion screen therefore offered two answers — it happened, or it did not — and nothing else. What happens to a tenant whose stay happened but went badly?

**Options.** (a) Leave it out; let them answer `TOOK_PLACE` and complain in chat. (b) Build a full case-management system with staff resolution screens. (c) Wire `OPEN_DISPUTE` to the existing `dispute_case` / `case_event` tables and stop there.

**Chosen.** (c).

**Why.** (a) makes the product ask people to misreport. The completion answer decides money; a screen whose only exits are two factual claims will get a false one from anybody whose situation is neither.

(b) is a different product. Nothing in this slice justifies building a queue, an SLA, an assignment model and a resolution workflow, and a half-built one would be worse than none.

(c) is the smallest honest mechanism. `dispute_case` and `case_event` were already designed and already carried the right categories; the booking moves to `DISPUTED`, which the FSM already defines as the state where completion side effects are frozen — so no fee accrues while a case is open, and none can be avoided by opening one either, because `DISPUTED` is not `NOT_TAKEN_PLACE`.

Resolution stays exactly where the state machine put it: `RESOLVE_DISPUTE_AS_*`, actor `ADMIN`. There is no automatic timeout, no "if nobody responds it becomes X", and the screen says so — «Автоматических решений по обращениям нет — решение принимает человек». A placeholder that admits it is a placeholder is safe; one that quietly closes cases is not.

A second report on the same booking joins the open case as another `case_event` rather than opening a second one, and does not attempt a state transition, because `DISPUTED` has no outgoing `OPEN_DISPUTE`.

**Trade-offs.** Staff currently have no screen for these cases — they are rows plus an in-app notification to holders of `case.view`. Until a queue is built, a case that nobody looks at stays open and the fee stays unaccrued, which is the correct direction to fail in.

**Revisit when.** There are enough cases to need a queue; that is the point at which the moderation-queue pattern from DEC-031 should be reused rather than reinvented.

---

## DEC-037 — Check-out is a tenant statement that opens the window, not a completion

**Question.** `REACH_STAY_END` is SYSTEM-only, and nothing scheduled ran it. A confirmed stay therefore sat in `CONFIRMED` or `CHECKED_IN` forever: the completion window never opened, so no fee could ever accrue and no review could ever be written. How does a stay end?

**Options.** (a) Let the planned end date complete the booking automatically. (b) Let either party fire `REACH_STAY_END`. (c) Add `CHECK_OUT` for the tenant, plus a scheduled sweep that fires the existing `REACH_STAY_END`.

**Chosen.** (c).

**Why.** (a) is explicitly ruled out by the brief and by the evidence model: a date passing is not evidence that a rental happened, and completing on it would charge a fee with no evidence at all.

(b) muddies the actor. `SYSTEM` means "the platform observed a clock"; a landlord pressing it means something else entirely, and would let a landlord push a checked-in tenant out of `CHECKED_IN` from the outside.

(c) keeps the two meanings apart. `CHECK_OUT` is tenant-only and does exactly one thing: move `CHECKED_IN → COMPLETION_PENDING` and start the confirmation clock. It decides nothing — `resolveCompletion()` still weighs both answers and the platform's own check-in record. A tenant pressing it is offering evidence, not a verdict.

The sweep (`POST /admin/lifecycle/run`, permission `lifecycle.run`) finds stays whose last night has passed and hands each to the existing `openCompletionWindow`, then hands expired windows to the existing `resolveExpiredCompletion`, then publishes expired review windows. It contains no completion rules of its own; a sweep that decided outcomes would be a second completion system with its own bugs.

It is an endpoint rather than an in-process timer because a Next.js deployment may be several short-lived instances, where a timer either never runs or runs N times. A cron with a credential is honest about who is doing the work, and `lifecycle.run` is a permission ADMIN alone holds, so the action is authorised and audited.

Both `CHECK_IN` and `CHECK_OUT` now also write a `stay_event` row — a table that existed, was designed for exactly this, and was unused. It is `UNIQUE (booking_id, kind, reported_by)`, so a retry is a no-op rather than a second piece of "evidence". The authoritative flag the completion rules read is still `booking.checked_in_at`; the table is the audit trail behind it, not a second source of truth.

**Trade-offs.** Nothing runs the sweep in development unless somebody calls it, and no ADMIN account is seeded, so the scheduled paths are exercised by the test suite rather than by clicking. Early departure remains `CANCEL_BY_TENANT`, not `CHECK_OUT`, which is the pre-existing behaviour and unchanged here.

**Revisit when.** A hosted scheduler exists; the endpoint is the thing it should call.

---

## DEC-038 — A stranger gets 404 from booking mutations, not 403

**Question.** `GET /bookings/:id` answers 404 to anyone who is not a participant, deliberately. The mutation endpoints — accept, cancel, check-in, completion — answered 403. Should they agree?

**Options.** (a) Leave it; 403 is the technically accurate code. (b) Answer 404 whenever the caller is not a party to the booking.

**Chosen.** (b).

**Why.** 403 confirms that a booking with that id exists. Anyone who can guess or harvest ids can then enumerate real bookings by the difference between the two codes, which is precisely the leak the read path was written to avoid. Two routes over the same resource disagreeing about it is worse than either choice made consistently.

The distinction that matters is not "authorised" versus "unauthorised" but "party" versus "stranger". A stranger gets 404. A caller who *is* a party but the wrong one — a landlord trying to check in, a tenant trying to accept their own request — still gets 403, because they already know the booking exists and answering "not found" to somebody looking at their own booking is a lie that reads as a broken product.

One helper, `participantRole()`, now makes that call in every path, so they cannot drift apart again.

**Trade-offs.** Three existing tests asserted the old 403 and were updated to assert 404 — strengthening, not weakening: they now pin the anti-enumeration property rather than the leak.

**Revisit when.** Never, for this resource. The same rule should be applied to any other resource whose existence is private.

---

## DEC-039 — Review text goes through the contact filter; redaction is recorded, not punished

**Question.** Chat is filtered for phone numbers, emails and off-platform handles. Reviews were not. A review is public and permanent. What should happen to a review containing contact details?

**Options.** (a) Nothing; reviews are between adults. (b) Reject the review and make the author rewrite it. (c) Filter the text, store the filtered version, publish normally, and record that it happened.

**Chosen.** (c).

**Why.** (a) makes reviews the documented way around the filter, which would make the filter pointless — a listing page is a far better place to publish a phone number than a private thread.

(b) punishes the author for the platform's rule, and loses work they may have spent several minutes on. It also creates a probing oracle: submit, see what is rejected, learn the detector's boundaries.

(c) treats it the way chat already does. `filterMessage` runs over `body`, `whatWasGood` and `whatToImprove`. `contactReleased` is deliberately NOT set, even though these two people have completed a rental together and are entitled to each other's details — that entitlement does not extend to publishing them to everyone who reads the listing.

Redacted reviews still publish. What is recorded instead is a `moderation_note` naming the detectors that fired, so a holder of `review.moderate` can see a pattern of it without the removed text being stored anywhere public.

**Trade-offs.** Filtering is not free of false positives; a review mentioning a bus route number could lose it. The note makes that recoverable by a moderator rather than invisible.

**Revisit when.** The filter gains a confidence threshold that would let a high-confidence match be handled differently from a marginal one.

---

## DEC-040 — Reviews are immutable once written, and reporting one does not hide it

**Question.** Can an author edit a published review? Can the person it is about get it taken down?

**Options.** (a) Editable within a window. (b) Immutable, with reporting for moderation.

**Chosen.** (b), which is what the schema already implied — `review_one_per_side` plus a publication timestamp, with no update path anywhere in the service.

**Why.** A review is a trust-critical record about somebody else. If it can be edited after publication, then what a reader saw yesterday and what they see today are different claims with the same timestamp, and the rating that fed a trust profile is no longer the rating that was written.

More practically: an editable review is a lever. "Change your review or I will change mine" only works if changing is possible. The simultaneous-publication rule (both sides in, or the window closes) exists to remove exactly that pressure, and editability would put it back.

Reporting is therefore the only route, and it deliberately does not hide the review. A report files a row in the existing `report` queue with `target_type = 'REVIEW'` and changes nothing about the review's status; a moderator with `review.moderate` decides. If reporting hid a review even temporarily, the first thing anybody would do with a bad rating is report it.

Reporting an unpublished review answers 404 rather than 403, because whether an unpublished review exists is exactly what the publication delay conceals. Reporting your own is refused outright.

**Trade-offs.** A typo is permanent. That is the cost of the record being a record.

**Revisit when.** Never for content. An author deleting their own review — a different act from editing it — is a separate question tied to account deletion and data-protection obligations.

---

## DEC-041 — Dispute priority is derived, never stored

**Question.** The queue has to put a case from somebody currently locked out of a flat above a month-old complaint about a slow reply. Where does that ordering come from?

**Options.** (a) A `priority` column staff set by hand. (b) A `priority` column a trigger or a job maintains. (c) No column: derive it from facts the platform already holds, every time it is asked.

**Chosen.** (c).

**Why.** A stored priority is a second copy of a conclusion whose inputs keep changing. The stay ends, the case ages past its target, a fraud signal lands against one of the parties — each of those should change the answer, and with a column each of them needs somebody or something to remember to write it. What actually happens is that the column goes stale and the queue quietly sorts by yesterday's facts.

Deriving it also settles §14's "do not allow users to manipulate priority directly" by construction rather than by a rule: there is nothing to manipulate. Category is chosen from a fixed vocabulary, booking state comes from the FSM, the fraud signal is written by the platform, and age is arithmetic. A user can pick a category — and `SAFETY_CONCERN` deliberately raises priority, because that is what it is for — but they cannot set the priority itself, and a false category is visible to the person reading the case.

The rule is written twice, in `priorityOf()` and in `PRIORITY_SQL`, and that is the real cost of this decision. It has to be: the queue orders and paginates in the database, so it cannot sort on a value computed after the rows arrive without fetching every case first, which §4 rules out. Two implementations of one rule drift, so a test runs the whole matrix of category × booking state through both and asserts they agree. Without that test this would be the wrong choice.

**Trade-offs.** No manual override. A handler who thinks a case deserves more attention than the rule gives it can escalate, which is a state change with a written reason — a better record than a silently bumped number would be. If overrides turn out to be needed, they should be an explicit, audited column that shadows the derived value rather than replacing it.

**Revisit when.** Somebody needs to deprioritise a known-vexatious case, or the rule needs an input the platform does not already record.

---

## DEC-042 — Case status is workflow; the booking is decided separately

**Question.** A dispute freezes a booking: no fee accrues while a case is open. When staff resolve the case, should the booking resolve with it?

**Options.** (a) Resolving a case applies an outcome to the booking automatically. (b) Two separate acts, with separate permissions.

**Chosen.** (b).

**Why.** They are different decisions with different consequences and, deliberately, different costs.

Closing a case says "we have finished looking at this". Deciding the booking says "the rental did happen, so a fee is owed" — or that it did not. The second moves money. Fusing them means every case closure is also a financial decision, including the ones closed as duplicates or withdrawn, and it means a handler cannot tidy the queue without touching somebody's balance.

So `RESOLVE` needs `case.resolve` and writes a resolution to `dispute_case`. `POST /admin/disputes/:id/booking-outcome` also needs `case.resolve` and goes through `BookingService.resolveDispute`, which runs `RESOLVE_DISPUTE_AS_*` from the booking state machine — a transition that has existed since the FSM was written and had no caller, which is why a DISPUTED booking was previously frozen for good.

The financial safety property falls out of that split. There is no amount anywhere in the request: an administrator chooses an outcome, and the fee is derived from the booking's own frozen terms by the same `accrueServiceFee` the ordinary completion path uses. A staff member cannot type a number that becomes a ledger row, and a test posts `feeMinor: '999999'` to prove the field is not part of the contract. Waiving an accrued fee stays where it was — `fee.waive`, in FinanceService, writing a compensating entry rather than deleting one.

**Trade-offs.** Two clicks where a product manager would want one, and a case can sit RESOLVED while its booking is still DISPUTED. That combination is visible in the queue and in the case file, and it is a truthful state: we finished looking, and the booking outcome is a separate call that somebody has to make.

**Revisit when.** Resolution templates exist — "confirmed, rental happened" as one action — at which point it should be one button that performs both acts explicitly, not one act that silently does two things.

---

## DEC-043 — Case events carry a visibility, and it defaults to internal

**Question.** `case_event` is one append-only stream holding both what a party did and what staff wrote to each other. How does a reader know which is which?

**Options.** (a) By `event_type`: every read remembers which types are safe to show. (b) An explicit `visibility` column.

**Chosen.** (b), defaulting to `INTERNAL`.

**Why.** (a) is a rule that lives in the head of whoever writes the next query. There will be a next query — a party-facing case timeline, an export, a support email — and the failure mode is an internal note about a suspected duplicate account arriving in a tenant's inbox. That is not a bug you get to fix quietly.

The default matters as much as the column. `INTERNAL` means a new event type added next year is invisible to users until somebody deliberately marks it otherwise. Fail closed: the mistake it prevents is disclosure, and the mistake it causes is a party not seeing something they could have.

Exactly one event type is currently `PARTIES`: `OPENED_BY_PARTY`, whose note is the party's own words about their own case. `REQUEST_INFORMATION` is also visible, because the text of that one IS the message to the party — but the party receives it through the notification service, not by reading the case file. Nothing in the product shows a tenant the case stream directly.

**Trade-offs.** The migration backfills the existing `OPENED_BY_PARTY` rows, which meant disabling the append-only trigger for the length of one statement. That is spelled out in the migration rather than done quietly, because "the append-only table was briefly not append-only" is something a future reader deserves to find in the history rather than discover.

**Revisit when.** Parties get a case timeline of their own, at which point this column is the thing that makes it safe to build.

---

## DEC-044 — Evidence is assembled per caller, and an absence is named

**Question.** A case file draws on bookings, messages, reviews, fraud signals, moderation history and the ledger. Who sees which parts?

**Options.** (a) Anyone with `case.view` sees the whole file. (b) Each section gated on its own existing permission.

**Chosen.** (b).

**Why.** (a) turns `case.view` into the most powerful permission in the system by accident. A support agent needs to know what happened to a booking; that is not the same as needing to read two people's private conversation, and the platform already says so — `message.review` exists, and SUPPORT does not hold it.

So the file is assembled from the caller's entitlements: message bodies need `message.review`, the financial picture needs `debt.view`, and identity documents are reachable from here by nobody at all — including ADMIN. That last one is not a new rule, it is the existing one held to: `document.read` is VERIFIER's alone, the only route to a document is in the verification routes, every read is logged, and the whole path is additionally behind a legal flag that is off. A dispute is not an entitlement, and adding one here would have quietly undone that.

A section the caller cannot have is ABSENT from the payload and NAMED on the screen — «нет доступа с вашими правами, требуется message.review» — rather than returned empty. `messages: []` and "no access to messages" are different facts, and a case file that renders them identically will eventually have somebody conclude there was no conversation.

**Trade-offs.** A support agent working a case that hinges on what was said in chat has to hand it to a moderator. That is the intended shape: the escalation is visible and recorded, where a blanket read would not be.

**Revisit when.** Support genuinely cannot resolve common cases without message access — and then the answer is a scoped, per-case, logged grant, not adding `message.review` to the role.

---

## DEC-045 — A verification level is never granted on nothing

**Question.** The decision endpoint could move a request to APPROVED and raise `app_user.verification_level`. What has to be true before it does?

**Options.** (a) Whatever the verifier judges — they are the human in the loop. (b) A domain rule that refuses approval unless specific evidence exists.

**Chosen.** (b), in `evidenceSufficiency()`.

**Why.** The badge is not a note-to-self. «Личность подтверждена» is a claim the platform makes to a tenant deciding whether to trust a stranger with a deposit, and to a landlord deciding whether to hand over keys. If there is nothing behind it, it is worse than absent, because absent is honest and a badge is an assurance.

What made this urgent rather than theoretical: before this slice there was no submission path anywhere in the product — `verification_request` rows existed only inside tests — and identity-document collection is switched off pending LEGAL-004. So the one thing the endpoint could actually do was grant a trust badge to somebody who had submitted nothing at all, and nothing in the code prevented it.

The rule has two gates and both fail closed. The platform must be permitted to hold identity documents at all, and the specific evidence for the kind must be present: a document and a selfie for identity, and additionally a property document plus a declared basis for a right to let. Today the first gate is shut, so every approval is refused and the console says why — in the same words in the queue, on the case page and on the disabled button.

The declared ownership basis is deliberately not evidence. It tells a verifier what to look for before they open anything, and it tells the applicant which document is expected; it can never satisfy the rule on its own.

**Trade-offs.** Nobody can be verified today. That is the correct state of the product, not a gap in it — the alternative is issuing assurances backed by nothing while a legal question about collecting the backing data is open.

**Revisit when.** LEGAL-004 is answered AND private storage exists. Both, not either: the flag alone would mean collecting passports with nowhere lawful to put them.

---

## DEC-046 — Approving requires having been able to look

**Question.** ADMIN holds `verification.decide`. ADMIN deliberately does not hold `document.read` (DEC on rbac: reading somebody's passport is a different act from administering the platform). Can an administrator approve an identity verification?

**Options.** (a) Yes — `verification.decide` is the decision permission. (b) No — approving requires `document.read` as well. (c) Give ADMIN `document.read`.

**Chosen.** (b).

**Why.** (a) is the state I found, and it is incoherent. An approval asserts that somebody examined the evidence and was satisfied. A role that is structurally forbidden from opening the evidence cannot honestly make that assertion, so the permission split was declaring one thing and the endpoint permitting another.

(c) is the tempting fix and the wrong one: it would dissolve the narrowest and most carefully drawn permission in the system to resolve a contradiction that can be resolved the other way.

So APPROVE — and only APPROVE — additionally requires `document.read`. Rejecting does not: an application can be refused for being incomplete, inconsistent, or stale without opening anything, which is exactly the work an administrator can legitimately do to keep a queue moving. The console reflects it rather than hiding it: an administrator is shown no approve button and told, in the queue, that they lack the permission and what that means.

**Trade-offs.** An organisation with one administrator and no verifier cannot verify anybody. That is the intended reading: it means "appoint a verifier", not "let the administrator do it".

**Revisit when.** Never for the direction of the rule. If approvals need to scale, the answer is more VERIFIER grants — each of which is itself an audited event.

---

## DEC-047 — The applicant and the verifier read different text

**Question.** A refusal has three audiences: a machine that routes it, a person who must fix it, and a colleague who may pick the case up next. `decision_note` was one free-text column serving all three, and nothing in the product displayed it.

**Options.** (a) One note, shown to the applicant. (b) One note, internal, plus a separate structured refusal. (c) Reason codes, an applicant message, and an internal note as three separate things.

**Chosen.** (c).

**Why.** They genuinely are three different things and collapsing them loses something each time.

The codes are what a machine can act on: each maps to a plain explanation and to the place that fixes it, so «Данные не совпадают» links to the profile name field and «Селфи не совпадает» links to the selfie step. That is the listing-moderation lesson (DEC-030) applied again — a refusal that does not say where to go is a dead end, and re-entering an application from the top is how people give up.

The applicant message is what a person is told in the verifier's own words. The internal note is what a verifier writes to colleagues, and it needs to be able to say "third attempt from this device, photo looks edited" — a sentence that must have no path to the applicant, because telling somebody which signal fired is telling them what to avoid next time.

`SUSPICIOUS_ACTIVITY` is the sharp edge of this and is handled deliberately: its applicant-facing text says only that the request could not be confirmed automatically and points at support. The fraud signals behind it appear on the case page for staff and nowhere else.

`verification_event.visibility` carries the same split through the history, defaulting to INTERNAL so an event type added later is invisible to applicants until somebody deliberately says otherwise — the same shape and the same default as `case_event` (DEC-043).

**Trade-offs.** Three fields where there was one, and a verifier has to think about which is which. The form labels each one with who reads it, which is the cheapest place to spend that attention.

---

## DEC-048 — A refused request is superseded, never edited

**Question.** Somebody was refused because a photo was unreadable. How do they try again?

**Options.** (a) Reopen the request and let them replace the document. (b) A new request that points at the old one.

**Chosen.** (b).

**Why.** (a) destroys the record. What was refused and why is the most useful thing a verifier has when the same person applies for the third time, and editing the row in place erases exactly that. A pattern of attempts is evidence; a single mutable row cannot express one.

So resubmission writes a new request carrying `supersedes_id`, and the refused one keeps its status, its codes and its decision author permanently. The case page shows a verifier the applicant's earlier decisions for that reason, with a note that repeated refusals for one reason are a signal and a single refusal usually is not.

The applicant does not pay for this. Their declared answers are carried onto the new request, so nobody retypes an application because one photo was blurred, and a partial unique index keeps exactly one live request per person per kind per property so the queue never shows a verifier the same case twice.

**Trade-offs.** More rows, and a NEEDS_INFO request has to be closed as the applicant answers it so the uniqueness rule sees only the new one. That transition is explicit in the service rather than implied.

---

## DEC-049 — Verification levels are described as platform checks, never as legal conclusions

**Question.** What exactly does the platform claim when it shows «Verified» next to somebody's name?

**Options.** (a) Strong, marketable wording — "документы юридически подтверждены". (b) Wording that describes precisely what was done.

**Chosen.** (b), with the exact strings in the domain so the badge a verifier grants and the badge a tenant reads cannot diverge.

**Why.** Кватэрка.by looks at documents a person supplied and forms a view. It does not perform a title search, it has no access to the property register, it does not confirm that a document is genuine beyond what a person can see, and it cannot promise anybody's safety. «Юридически подтверждено» would claim all four.

So Level 1 reads «Личность подтверждена платформой» and Level 2 «Личность и право сдавать жильё проверены платформой», with a longer form that says in plain words that this is not a legal expertise and not a guarantee. The applicant-facing page repeats it under the ladder and again at the foot of the page.

A test asserts that the forbidden phrasings appear nowhere in any of the level labels, claims, explanations or refusal texts. Wording drifts as marketing copy gets edited; a test does not.

**Trade-offs.** Weaker-sounding than a competitor willing to say more. That is the correct trade for the one number a tenant uses to decide whether to trust a stranger.

**Revisit when.** A licensed provider or a state identity mechanism is integrated, at which point a stronger claim may be *true* — and would need its own legal sign-off before being written down.

---

## DEC-050 — Retention state is derived; nothing stores permission to destroy

**Question.** A retention subsystem needs to know whether a row may be purged. Where does that answer live?

**Options.** (a) A `lifecycle_state` column per table, maintained by the job. (b) The sketch in the brief — `ACTIVE → SOFT_DELETED → RETENTION → ELIGIBLE_FOR_PURGE → PURGED` — stored. (c) Derived on read from the timestamps that already exist, plus holds.

**Chosen.** (c). The vocabulary from (b) is kept; its storage is rejected.

**Why.** Two of the four inputs change with nobody writing anything. A `purge_after` date passes because time passes. A legal hold lands on an entirely different table. A stored `ELIGIBLE_FOR_PURGE` would go stale on both, and staleness here is not a cosmetic problem: **the column would be a cached permission to destroy data**, written before the hold arrived and still saying yes afterwards. A job reading it would destroy held data and be correct according to its own state machine.

DEC-041 made this call for dispute priority, where a stale value costs a badly sorted queue. Here it costs a destroyed passport scan somebody had ordered kept, so the same answer applies with more force.

There is a redundancy argument too. The schema already stores `deleted_at`, `purge_after`, `purged_at` and now `purge_started_at`. A state enum is a fifth copy of what four timestamps already say, and it can disagree with them. Timestamps compose; an enum does not.

The cost is real and named: the rule is written twice, in TypeScript and in SQL, because the console orders and paginates in the database. DEC-041 accepted that cost only on the condition of a parity test, and the verification slice then shipped a SQL twin with no such test. Not repeated: `retention.integration.test.ts` runs all thirty-six combinations of `deleted_at` × `purge_after` × `purged_at` × hold through both and asserts they agree.

**One ordering decision inside the rule.** A row that is both soft-deleted and on a retention clock reports the clock, not the deletion. That leaves `SOFT_DELETED` meaning something precise and worth seeing — marked for deletion and governed by no window at all, which is a row stuck in limbo rather than one in progress. A unit test caught this the other way round and was right.

**Trade-offs.** Two implementations of one rule, held together by one test. If that test is ever deleted, this decision becomes the wrong one.

---

## DEC-051 — Purging destroys bytes and keeps the row

**Question.** `verification_document.purge_after` has existed since 0005 and nothing ever enforced it. What does enforcing it actually do — delete the row?

**Options.** (a) `DELETE FROM verification_document`. (b) Destroy the object in storage and keep the row as a tombstone. (c) Apply the DEC-031 cascade-aware trigger pattern to `document_access_log` so the row can be deleted with its log.

**Chosen.** (b).

**Why.** (a) does not work, and the reason it does not work is instructive. `document_access_log` carries a `forbid_mutation()` trigger and an `ON DELETE CASCADE` from the document. A row trigger fires during a cascade exactly as it does on a direct delete, so deleting a document that anybody had ever opened raised `restrict_violation` and aborted. The purge was structurally impossible on precisely the documents that mattered most. This was proven against a real database before anything was written; the same shape exists on four other append-only children, and `0010_review_cascade.sql` records the identical problem being discovered and fixed for a fifth.

(c) is the tempting generalisation and it is wrong here. DEC-031's discriminator suits `listing_moderation_review` because a moderation note about a property that no longer exists serves nobody. Neither premise transfers. Under erasure the parent going away is the *normal* case, and the log is the one table whose entire purpose is being tamper-evident about who opened somebody's passport. Applying DEC-031 would mean **the record of who read your passport is destroyed by the same request that destroys the passport**. That converts a deliberate accountability guarantee into an erasable one.

So the row survives and the bytes do not. `storage_key` stays populated: it is the only evidence of which object was destroyed, the read route already refuses on `purged_at`, and the public media route refuses every `private/` key unconditionally. The schema had already chosen this without saying so — a row carrying `purged_at` cannot be a row that was removed.

**The ordering is forced.** Destroying an object and committing a row cannot be one transaction, and the two failures are not symmetric:

| Failure | Result | Recoverable |
|---|---|---|
| Row gone, bytes remain | nothing remembers the key; nothing retries | **No. Unrecoverable leak.** |
| Row remains, bytes gone | the read route already refuses | Yes, cosmetic |

So: claim (`purge_started_at`), destroy, confirm (`purged_at`). **`purged_at` is not a request to purge — it is an assertion that the bytes are gone**, and writing it first produces a row swearing a passport was destroyed while it sits in the bucket, which nothing will ever retry because the scan filters on `purged_at IS NULL`.

**Explicitly not decided.** `booking_event`, `case_event` and `message_moderation_event` keep their cascades untouched. Nothing hard-deletes their parents under this design, so the dormant landmines stay dormant and defused by construction. Three new conditional triggers to defend a path being closed anyway would be cost without benefit. This is recorded so the next person does not re-derive it.

**Revisit when.** A second table needs byte-level purge, at which point the claim/destroy/confirm shape should be extracted rather than copied.

---

## DEC-052 — A hold prevents; only an administrator may stop preventing

**Question.** Retention needs something that stops destruction for a dispute, an investigation, an official request. Who may set it, who may clear it, and does it expire?

**Options.** (a) Derive holds from facts already in the database — an open dispute, an unresolved fee. (b) An explicit `legal_hold` row. (c) Both.

**Chosen.** (b), with the asymmetry below.

**Why not (a) alone.** Not everything worth freezing has a row that says so. "Somebody phoned about this account and we are looking into it" is real, common, and has no schema representation — and inventing one for each case is how a hold mechanism becomes six half-mechanisms.

**The asymmetry is the design.** Placing a hold is granted to SUPPORT and MODERATOR as well as ADMIN, because placing only ever *prevents* destruction: no legal answer can make keeping data more wrong than destroying it by mistake, so the people who first hear "there is a problem with this account" must be able to stop the clock without escalating. Releasing is ADMIN's alone and always carries a written reason, because release is the direction that re-enables destruction. The console reflects it rather than hiding it: a support agent sees no release control at all, not a disabled one.

**VERIFIER holds neither permission.** The role that can open a passport must not also decide whether it is kept. That separation is worth more than the convenience of one role doing both.

**Reason codes describe us, not the law.** `LEGAL_QUESTION_UNRESOLVED` is how an open question is named without pretending to know its answer, with the number itself in free text. A test asserts no reason label claims a legal requirement.

**No expiry, but a review date.** A hold that released itself would not be a hold. But an indefinite hold nobody revisits is how "we hold what we must" quietly becomes "we keep everything for ever". So a hold has a review cadence, passing it changes nothing about the hold, and the console shows it as overdue until a person deals with it. Ninety days is a cadence for staff attention, never a retention period for anybody's data — which is why it may be a number here when no retention window may be.

**The race, and why the guard is the answer.** A hold and a purge write different tables, so a row lock on the document says nothing about a hold row that does not exist yet, and a `NOT EXISTS` subquery under READ COMMITTED sees a snapshot from statement start. Both paths therefore lock the same target row first, and the purge locks every row a covering hold could name, parent first — which is also a fixed order, so two purges cannot deadlock. The candidate query is advisory; the transaction re-reads every condition. PGlite is a single connection and cannot run the race, so the test asserts the guard and the genuine concurrency test is skipped rather than faked unless `TEST_DATABASE_URL` points at a real server.

**Trade-offs.** Holds accumulate if nobody releases them, and the equilibrium of "easy to place, harder to lift" is everything held for ever. The overdue-review surface is the only thing pushing back, and it is deliberately not automatic.

---

## DEC-053 — Closing an account is not erasing it, and the product says so

**Question.** `app_user.deleted_at` and `status='DELETED'` have existed since the first migration and nothing ever wrote either. What should "delete my account" do while LEGAL-003 is unanswered?

**Options.** (a) Nothing — wait for the legal answer. (b) Build erasure now and gate it behind a flag. (c) Build closure now, name erasure as unbuilt, refuse to conflate them.

**Chosen.** (c).

**Why.** Closure removes *access*: sessions end everywhere, one-time tokens are destroyed, the profile leaves the site, listings come down. None of that needs a legal answer, and all of it is a superset of the suspension the product already performs. Erasure destroys *data*, and what may be destroyed — and what must be kept, and for how long — is exactly LEGAL-003.

(b) is the dangerous one. **A half-finished erasure is worse than none, because it looks finished to the person who asked for it.** Removing a display name while the chat history, the check-in photographs and the original unfiltered message texts remain is not partial compliance; it is a false assurance given to somebody who trusted it.

So the screen never says «удалить» for what it does. It says «закрыть», lists what survives *before* the button rather than after it, and prints every unbuilt step beside the legal question it waits on. The domain declares those steps as data with a `built` flag, and a test asserts that nothing which destroys personal data is marked built — so the day somebody implements one, the claim and the code move together.

**Debt does not block closure.** It is the obvious candidate and the wrong call: refusing to let somebody close their account until they have paid uses a data-protection mechanism as leverage over money. It is also unnecessary — every financial foreign key is RESTRICT precisely so closure cannot take a fee with it, so the ledger is exactly as correct afterwards. The person is told the debt survives; they are not held hostage to it.

**What does block it:** an active booking, an open dispute, a hold. The first is not a privacy judgement at all — closing mid-stay strands a counterparty in a booking with somebody who no longer exists.

**Confirmation is a typed word, not a checkbox.** `true` is what a mis-sent request contains by accident; ЗАКРЫТЬ is not. And the typing is the moment a person actually reads what they are agreeing to.

**Revisit when.** LEGAL-003 is answered. `ERASURE_STEPS` is the work list, and each entry already names its blocker.

---

## DEC-054 — Two-factor is enforced by withholding roles, not by adding a check

**Question.** `requiresTwoFactor()` had existed in `rbac.ts` since the auth slice and was called from nowhere. Where does the check belong?

**Options.** (a) In the router's authorize block, beside `can()`. (b) In each service method that does something sensitive. (c) Nowhere — remove the roles instead.

**Chosen.** (c).

**Why.** (a) is the obvious answer and it is theatre in this codebase. `dispatch()` is called from exactly one place, and the staff console does not go through it: `src/app/staff/**` resolve the session themselves, call `can()` inline, and hand a hand-built capability object to a service. `moderation/page.tsx` bypasses the service layer entirely and runs its own SQL. A check in the router would have protected `GET /admin/verification/documents/:id` and left the moderation queue, the dispute case files, the verification console and the retention console reachable on a password alone.

(b) protects everything only if every method remembers, which is the property that fails the first time somebody adds a method in a hurry.

Both paths do share one thing: they build their caller from `AuthService.resolveSession`, and they authorise with `can(roles, permission)`. So the roles are withheld there. A session that has not satisfied its second factor is handed a role array with the staff grants removed, and every `can()` in the product answers false without knowing 2FA exists. **There is no call site that can forget the check, because no call site performs one.**

This is the same shape as ADMIN not holding `document.read`: a capability that is absent rather than guarded. The ordinary-user half is untouched — a moderator who is also a landlord still manages their own flats — because only the staff roles are filtered.

**The flag-day cost is real and deliberate.** `auth_level` defaults to `PASSWORD`, so the migration drops every existing staff session to consumer access immediately. `/staff/security` is therefore the one staff page with no permission on it; gating it would lock a staff member out of the only page that resolves the state they are in.

**Trade-offs.** `SessionContext.roles` now means "may exercise" rather than "was granted", and code that needed the latter has to ask for it — `grantedRoles()` exists for that. It is a subtle rename of a widely-read field, and the test suite's 21 immediate failures were the proof that it is load-bearing.

---

## DEC-055 — TOTP is written here, and the secret is stored in plaintext

**Question.** How is the second factor implemented, and how is its secret protected?

**Options.** (a) A library. (b) node:crypto. And for storage: (c) plaintext, (d) encrypted at rest, (e) hashed.

**Chosen.** (b) and (c), with the limitation of (c) written down rather than implied.

**Why (b).** TOTP is HMAC-SHA1, a counter, and dynamic truncation — about forty lines against RFC 6238. This project's dependency list is five packages long on purpose, and a dependency that sits on the authentication path is one whose every future version is a supply-chain decision. `node:crypto` supplies the only primitive needed.

The risk of hand-rolling is interoperability, so the test asserts all six RFC 6238 vectors and all seven RFC 4648 base32 vectors rather than round-tripping against itself. It was then cross-checked in the browser: a code computed by WebCrypto — an implementation with nothing in common with this one — was accepted by the server.

**Why (c), and what it does not buy.** (e) is impossible: verification needs the secret, so it cannot be hashed. (d) is right and this project has no encryption-at-rest layer — nothing encrypts any column today, and a key held in the same database is decoration. Inventing one for this alone would be the largest piece of the slice and the least examined.

So: **the second factor defends against a stolen or guessed password. It does not defend against an attacker who already has the database.** That is a genuine limitation, and it is the difference between what 2FA usually means and what this one currently means. It belongs in the security documentation as a fact, not in a comment as an aspiration.

**Revisit when.** An encryption-at-rest layer exists for any reason — this column should be its first customer.

---

## DEC-056 — A code is spent, a lockout escalates, and a failure survives its own rejection

**Question.** Three details of the challenge that each looked settled and were not.

**Replay.** A TOTP code is valid for its whole 30-second step. Verifying only correctness lets the same code be used twice, so anyone reading it over a shoulder — or capturing it on a phishing page — has up to a minute. `verifyTotp` therefore returns *which step* matched, the service records it, and anything at or below it is refused. Every code is single-use.

**Lockout.** The first parameters were five attempts per fixed fifteen-minute window, which sounds strict. It allows about 175 000 guesses a year against a 10⁶ keyspace — roughly a one-in-six chance of success per year of patient attacking, for an account that can open somebody's passport. A test computed it and failed. The lockout now doubles per block of failures and the counter is cleared only by a success, never by waiting, which brings it to about 1850 a year. It is capped at a day, because refusing a colleague for a week because somebody attacked them is itself a denial of service — so the residual is ~0.2% a year against an attacker who must also hold the password, and that residual is stated rather than rounded to "hopeless".

**The rollback.** The failure counter was incremented inside the transaction that then threw, so the rollback erased it. The lockout never engaged, every individual response looked correctly rejected, and an attacker could guess for ever. Nothing about the code read as wrong. The transaction now decides, and the rejection is recorded by a statement of its own afterwards.

**What is never distinguished.** Not enrolled, wrong code, replayed code, spent recovery code — all produce one message. Telling somebody which half of their attack was working is the whole value of a generic error.

---

## DEC-057 — Delivery claims, sends, then records; and refuses to record what it did not send

**Question.** `claimPending`, `markSent` and `markFailed` had existed since the notification slice and were called from nowhere. Twenty-five places enqueue; nothing drained. What does the worker look like?

**Two defects in what was there.** `claimPending` claimed nothing — a bare SELECT with no lock and no status change, so two workers would read the same rows and both send them. And `markFailed` returned rows straight to PENDING, so the next run re-sent immediately: against a provider outage that is a retry storm by construction, hammering a dead endpoint as fast as cron allows.

**The ordering is claim → send → settle**, the same shape as the retention purge and for the same reason: an external effect and a database write cannot be one transaction, so the order is decided by which failure is recoverable. A crash between send and settle leaves the row claimed; the lease reclaims it and it goes again.

That is **at-least-once, said plainly**. No provider this will ever talk to can confirm receipt atomically with our commit, so exactly-once would be a claim about somebody else's infrastructure. Delivering twice is a nuisance; never delivering a security notice is not.

**Three outcomes, not two.** DELIVERED, TRANSIENT, PERMANENT. Collapsing them into a boolean means either retrying what can never succeed — which at scale is an accidental attack on a provider that has already said no — or discarding what a five-second outage would have delivered. Transient retries with exponential backoff and jitter; without the jitter, an outage synchronises every failed row onto one instant and the recovery is a stampede.

**An unconfigured provider returns PERMANENT rather than pretending.** There is no path to SENT except a provider reporting DELIVERED, and a test asserts it. A channel with no transport is never claimed at all, so the backlog stays the honest measure of what is undelivered and goes out when a provider is finally configured.

**The address is resolved at send time**, from the user's current record, never from the payload. A payload written last week would carry an address the person has since corrected and would keep sending to a Telegram chat they have unlinked. Late resolution is also what makes withdrawal of consent take effect on everything still queued.

**Today IN_APP is the only real channel**, and it is genuinely real — the row *is* the message. EMAIL and TELEGRAM refuse, differently depending on whether the address is missing or the client is unimplemented, because an operator who has set `SMTP_URL` and still sees failures needs to know the configuration arrived and the code did not.

---

## DEC-058 — Background jobs get a machine principal, not an exempt admin

**Question.** DEC-054 made every staff role conditional on a second factor. The three job permissions — `lifecycle.run`, `retention.run`, `notifications.run` — are held by ADMIN. A cron cannot answer a TOTP challenge. So who runs the jobs?

**Options.** (a) Exempt a designated service account from 2FA. (b) Drop the job permissions to a role that is not withheld. (c) A principal that is not a user at all.

**Chosen.** (c).

**Why this was urgent rather than tidy.** The regression was invisible. `rbac.ts` had described these three as machine credentials since they were written — "a cron calls it" is in the comment beside `lifecycle.run` — but nothing enforced that they were reachable by a machine, because until DEC-054 an ADMIN session was a machine's only option and worked fine. Afterwards it did not, and all 1001 tests still passed, because every one of them logs in as a person. The background half of the product stopped working and nothing said so.

**Why not (a).** A service account exempt from 2FA is an ADMIN account exempt from 2FA. It holds `document.read`'s neighbours, `role.grant`, `ledger.adjust` — everything the second factor was introduced to protect — and it is the one credential that must live in a CI secret store and be readable by a deployment pipeline. It reintroduces the exact hole while looking like a fix.

**Why not (b).** Any role low enough to be exempt is a role ordinary people hold. The retention purge reads document storage keys.

**What (c) buys.** A machine has no row in `app_user`, no session, and no roles — so it cannot be granted anything, and widening ADMIN can never widen it. Its permissions are a hand-written list of three. A leaked scheduler token lets an attacker run an idempotent job early, which the `job_run` mutex already makes close to harmless; it does not let them read one byte, and a test asserts the document route answers 403 to it.

**Details that are load-bearing.** The header is `x-job-token`, never `authorization`, because `readSessionToken` already consumes that and a credential which could be mistaken for a session token eventually will be. Comparison is constant-time against a padded copy, because `timingSafeEqual` throws on unequal lengths and the naive repair leaks the real length. A session always wins over the token, so an operator debugging with both stays themselves in the audit trail. `triggered_by` stays NULL for a machine — the column references `app_user`, and a human always has an id, so NULL is unambiguous rather than merely absent.

**Fails closed.** With `JOB_RUNNER_TOKEN` unset there is no machine principal and the routes behave exactly as before: a deployment that forgets it gets a queue that does not drain, not an open door.

---

## DEC-059 — `/terms` and `/privacy` describe the software rather than pretending to be documents

**Question.** Both were linked from the footer of every page and both answered 404. A marketplace that collects identity documents and 404s on its privacy link has a real problem. What goes there?

**Options.** (a) Adapt a template terms-of-service and privacy policy. (b) Leave the 404 until a lawyer writes them. (c) Publish pages that state what the platform verifiably does, and say plainly that the formal documents do not exist.

**Chosen.** (c).

**Why not (a).** It is the obvious move and it is the dangerous one. A templated policy asserts a legal basis for processing, a retention period and a data-transfer position — three things LEGAL-003 exists precisely because nobody has answered. Publishing confident language about them would create a document users rely on, that binds nobody, and that contradicts what the code actually does. This project has refused invented legal claims everywhere else; a page is not the place to start.

**Why not (b).** The 404 is itself a claim, and a worse one: it says nothing has been considered. What the platform does with data has been considered carefully — hashed IP addresses, hashed session tokens, diff-only audit rows, exact addresses withheld until confirmation, `document.read` held by one role, every document read logged. All of that is true, checkable and useful to a reader, and none of it needs a lawyer to state.

**So the pages describe behaviour and mark the gap.** Each opens with a panel saying the formal document is in preparation and why we are not publishing a substitute. Everything below is a factual account of the software, including the uncomfortable parts — that erasure is not built, that the platform cannot return money it never held, that moderation checks the listing and not the flat.

**Revisit when.** A Belarus-qualified lawyer drafts either document. These pages then become the plain-language companion to it, not a replacement.
