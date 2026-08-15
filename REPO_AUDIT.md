# REPO_AUDIT.md

**Audited:** 2026-08-15 · **Auditor:** principal engineer pass · **Commit at audit:** `ab67c9f`

---

## 1. Finding: the repository was empty

The audit required by the master prompt (§72 STEP 1) was performed first. Result:

```
D:\kvaterka.by\
└── CODEX_MASTER_PROMPT_BELARUS_RENTAL.md   (46 KB, the specification)
```

That is the entire prior contents. Specifically, there was:

| Checked | Found |
|---|---|
| Git repository | No — `git init` was run as part of this work |
| package.json / lockfiles | None |
| Frontend | None |
| Backend | None |
| Database, ORM, migrations | None |
| Docker / CI/CD | None |
| Environment / config | None |
| Tests | None |
| Public assets | None |
| Documentation | None beyond the spec |
| API contracts | None |
| Auth / authorization | None |
| Storage, queues, jobs, notifications | None |
| Existing admin panel | None |
| Previous audits, TODO/FIXME | None |

**Consequence for the brief.** The instruction "do not rewrite a working project just because you prefer another stack" (§10 of the user brief, §51 of the spec) has no bite here: there was no architecture to preserve, no working functionality to protect, and no technical debt to pay down. Every decision below is therefore a greenfield decision, and each is recorded in [DECISIONS.md](DECISIONS.md) with its alternatives.

**What this does not excuse.** A greenfield start is the easiest place to bake in the failure modes the spec warns about — float money, check-then-insert booking, mutable audit trails. Those were treated as the primary design risks and are addressed structurally rather than by convention (see §4).

---

## 2. Environment audit

Verified by execution, not assumption:

| Component | Status |
|---|---|
| Node.js | v24.11.0 ✅ |
| npm / pnpm | 11.6.1 / 9.12.0 ✅ |
| git | 2.36.0.windows.1 ✅ |
| Python | 3.12.7 ✅ |
| **Docker** | **absent** ❌ |
| **PostgreSQL server** | **absent** ❌ |
| Network (github.com) | reachable ✅ |
| `@node-rs/argon2` native module | installs and runs on win32-x64 ✅ (verified by hashing and verifying a password) |

### 2.1 The Docker gap and how it was resolved

No Docker and no local PostgreSQL means the usual "spin up a container for integration tests" path is unavailable. Three options were considered:

1. **Mock the database.** Rejected: the spec's hardest requirements (no double booking, no duplicate fee, immutable ledger) are *database* guarantees. A mock would test the mock.
2. **SQLite for tests, PostgreSQL for production.** Rejected: SQLite has no `EXCLUDE` constraint, no `daterange`, no partial indexes with the same semantics. The tests would pass while production behaved differently — the worst possible outcome.
3. **PGlite** — real PostgreSQL compiled to WebAssembly, in-process. **Chosen.**

PGlite was validated before committing to it. Verified working: **PostgreSQL 18.3**, `btree_gist`, `pg_trgm`, `citext`, `cube`, `earthdistance`, `EXCLUDE USING gist` over `(uuid =, daterange &&)`, constraint triggers, generated columns, Russian full-text search, and `BEFORE UPDATE OR DELETE` immutability triggers.

**Honest limitation:** PGlite serialises everything onto one connection, so it proves *constraint enforcement* but cannot exercise two genuinely simultaneous transactions. The same suite runs unchanged against a real server via `TEST_DATABASE_URL`; that mode is required in CI before release, and it is the mode that tests true concurrency. **This has not been run in this environment** — there is no server here to run it against. See [MVP_RELEASE_CHECKLIST.md](MVP_RELEASE_CHECKLIST.md).

---

## 3. Skills audit and installation

Installed skills before this work: **none** (`~/.claude/skills/` did not exist). Three plugins were present and are unrelated to this product: `claude-mem`, `ruflo-core`, `understand-anything`.

Installed into `.claude/skills/` from the repositories named in the brief:

| Skill | Source | Why this one |
|---|---|---|
| `ui-ux-pro-max` | nextlevelbuilder/ui-ux-pro-max-skill | Core design intelligence — palettes, type pairings, UX guidelines |
| `design-system` | same | Three-layer token architecture |
| `gpt-taste` | Leonxlnx/taste-skill | The GPT/Codex-oriented anti-slop variant the brief asked for |
| `design-taste-frontend` | same | Anti-generic visual direction |
| `redesign-existing-projects` | same | Redesign audit method |
| `brainstorming`, `writing-plans`, `executing-plans`, `test-driven-development`, `systematic-debugging`, `verification-before-completion`, `requesting-code-review`, `receiving-code-review`, `using-superpowers` | obra/superpowers | Engineering methodology only |

**Deliberately not installed:** `ui-styling` (5.9 MB), `banner-design`, `slides`, `brand`, `brutalist-skill`, `minimalist-skill`, `soft-skill`, `stitch-skill`, `image-to-code`, the imagegen skills, `writing-skills`, `dispatching-parallel-agents`, `subagent-driven-development`, `using-git-worktrees`. None of them serve a rental marketplace, and the brief explicitly asks for a minimal set of strong skills rather than bulk (§6, §7). Total installed footprint: 4.3 MB.

**Caveat, stated plainly:** skills are enumerated at session start, so these are on disk and available to future sessions but were not loadable through the skill mechanism during this one. They were therefore used the only honest way available — by reading their guidance directly. The design consequences are recorded as DEC-013 in [DECISIONS.md](DECISIONS.md), including where I deliberately diverged from `gpt-taste`.

---

## 4. Architectural risk register (the reason for the design)

These are the failure modes the spec calls out. Each is answered structurally — by a constraint the database enforces — rather than by application discipline, because application discipline is exactly what fails under concurrency and refactoring.

| Risk | Structural answer | Proven by |
|---|---|---|
| Double booking under concurrency (§63) | `EXCLUDE USING gist (property_id WITH =, stay_period WITH &&)` partial on the blocking states. There is no check-then-insert anywhere. | 10 tests in `tests/schema.integration.test.ts`, 5 in the lifecycle suite |
| Duplicate service fee (§12, §63) | `service_fee.booking_id UNIQUE` + a unique partial index for one `FEE_ACCRUED` ledger row per fee + the state machine refusing a second exit from `COMPLETION_PENDING` — three independent guards | `the service fee can never be charged twice` (4 tests) |
| Float money bugs (user brief §17) | `bigint` kopecks end to end; `money()` throws on a non-integer `number`; `pg` int8 parser left as string so no lossy conversion | 46 tests in `money.test.ts` |
| Mutable financial history (§52) | `BEFORE UPDATE OR DELETE` triggers on `ledger_entry`, `audit_log`, `booking_event`, `listing_snapshot`, `case_event`, `document_access_log`, `message_moderation_event` | `financial records are immutable` (4 tests) |
| Silent price manipulation after booking (§8) | Terms frozen on the booking row + an immutable `listing_snapshot` captured at request time | `freezes the terms so a later price change cannot rewrite them` |
| Landlord dodging the 5% by staying silent (§11) | Completion resolution built on incentive asymmetry — a landlord's admission is trusted instantly, a landlord's denial is honoured but flagged, a tenant's confirmation completes the booking after the deadline | 23 tests in `completion.test.ts` + 6 lifecycle tests |
| Reviews without a real rental (§30) | `review.booking_id` FK + `UNIQUE (booking_id, author_role)` + per-role dimension CHECKs | 5 tests |
| Contact filter breaking normal chat (§26) | Safe-span masking runs *before* any phone heuristic | 24 real Belarusian/Russian messages asserted to pass untouched |
| Authorization bypass (§62) | Actor permissions live in the transition table; the service resolves the actor from the row, never from the request | 13 authorization tests |

### 4.1 Defects found and fixed during this work

Recorded because they are the kind that survive review:

1. **`\b` does not work with Cyrillic in JavaScript.** `/\bвайбер\b/` never matches — `\b` is defined over ASCII word characters. This silently disabled every Russian-language pattern in the contact filter, including the safe-span masking meant to prevent false positives. Fixed by replacing all of them with explicit Unicode boundaries (`(?<![\p{L}\p{N}_])`) under the `u` flag. **This class of bug produces no error and no failing test unless you specifically assert the Russian cases** — which is why the corpus exists.
2. **Date pattern swallowing phone numbers.** A loose `\d{1,4}[./-]\d{1,2}[./-]\d{2,4}` matched `123-45-67` as a date and masked it, so `+375 29 123-45-67` passed the filter cleanly. Fixed with component-validated date patterns plus lookarounds preventing a match mid-number.
3. **`multiplyByCount` threw `RangeError` instead of a domain error**, because it called `BigInt(1.5)` before validating.
4. **NFKC normalisation rewrote user text.** `50 м²` was being delivered as `50 м2` because the normalised string was returned as the message body. Allowed messages now return the sender's original text verbatim.

---

## 5. Current state

**274 automated tests passing. `tsc --noEmit` clean.** Breakdown:

| Suite | Tests | What it covers |
|---|---|---|
| `money.test.ts` | 46 | Integer money, rounding policy, 5% fee determinism, parsing, formatting |
| `booking/states.test.ts` | 29 | Transition-table integrity, actor permissions, ambiguous targets |
| `booking/completion.test.ts` | 23 | All 36 completion input combinations + invariants |
| `pricing.test.ts` | 29 | Nightly/monthly/tiered/seasonal pricing, total transparency, fee base |
| `messaging/contact-filter.test.ts` | 71 | Evasion corpus + 24-message false-positive corpus |
| `tests/schema.integration.test.ts` | 44 | Database-enforced invariants against real PostgreSQL |
| `tests/booking-lifecycle.integration.test.ts` | 32 | End-to-end request → fee → ledger → audit |

**Status by component** (vocabulary per spec §75):

| Component | Status |
|---|---|
| Database schema + migrations | TESTED |
| Money / fee arithmetic | TESTED |
| Booking state machine | TESTED |
| Two-sided completion + fee accrual | TESTED |
| Pricing & total-price transparency | TESTED |
| Anti-off-platform filter | TESTED |
| Booking service (end-to-end) | TESTED |
| Audit logging | IMPLEMENTED (written in-transaction; no admin viewer yet) |
| Auth / sessions / RBAC | NOT STARTED |
| HTTP API layer | NOT STARTED |
| Web UI / design system | NOT STARTED |
| Search & map | NOT STARTED (schema and geo indexes exist and are tested) |
| Reviews service | NOT STARTED (schema TESTED) |
| Verification workflow | NOT STARTED (schema TESTED) |
| Notifications / Telegram | NOT STARTED (schema TESTED) |
| Admin panel | NOT STARTED |
| Legal review | BLOCKED — requires a Belarus-qualified lawyer |

**Nothing above is described as complete on the strength of a UI existing, and no component is marked TESTED without tests that run.**

---

## 6. Recommended next steps

In priority order, with rationale:

1. **Auth, sessions, RBAC** — every remaining feature needs an authenticated actor, and retrofitting authorization is how privilege-escalation bugs are born.
2. **HTTP API + Zod validation at the boundary** — makes the existing services reachable.
3. **Design system + the four core mobile screens** (search, listing, booking, chat).
4. **Search and map** over the geo indexes already in place.
5. **Reviews service** on the existing schema.
6. **Admin panel** — moderation queue, verification queue, audit viewer.
7. **Notifications** with the deduplication key the schema already carries.
8. **Real-server CI run** with `TEST_DATABASE_URL` to close the concurrency gap in §2.1.

See [IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md) for the phased breakdown.
