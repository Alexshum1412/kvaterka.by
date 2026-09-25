# CLAUDE.md — kvaterka.by

Memory file for coding agents. Caveman-compressed on purpose (JuliusBrussee/caveman `caveman-compress` rules): terse, every fact kept. Full reasoning lives in `DECISIONS.md` (DEC-001…DEC-086) — read the matching DEC before changing a decided behavior.

## Product

Belarus rental marketplace. Landlord publishes, tenant books. Platform never touches rent; 5% fee to landlord after both sides confirm completed rental. Locales `ru` (default, no URL prefix), `be`, `en` via next-intl. Owner writes Russian; reply in Russian unless told otherwise.

## Stack

Next.js 15 App Router + React 19, TypeScript, Tailwind v4 (mostly raw CSS in per-component `<style>` blocks), Zod, PostgreSQL. Prod DB = PostgreSQL 10.23, no extensions, non-superuser role. Prod host = HostFly cPanel + Passenger; build locally, upload `.next` zip (`HOW_TO_UPDATE_THE_SITE.md`). Never run exploit tooling against prod.

## Commands

- `npm ci` — lockfile must match (CI uses npm 10 / Node 22).
- `npm run dev` — `DATABASE_URL=pglite` in `.env.local`: in-process Postgres, seeds demo data on boot. Dev server grows past 13 GB RAM after many compiles; restart it if pages hang on "Compiling".
- `npm run verify` — typecheck + lint + `contrast` + tests. Gate before commit.
- `npm test` — vitest on PGlite. `TEST_DATABASE_URL=postgres://kvaterka:kvaterka@localhost:55432/kvaterka_test npm test` for real PG 10 (`docker compose up -d postgres`, image `postgres:10.23-bullseye` — bare `10.23` tag gone from Docker Hub).
- `npm run contrast` — reads `--gradient-brand` stops from `globals.css`, fails below AA.
- `npm run telegram:webhook` — registers webhook WITH secret. Required after DEC-085 or bot stops working.
- `npm run e2e` — Playwright vs running prod build (`E2E_BASE_URL`, default :3100; `E2E_DATABASE_URL` for DB asserts; `PW_CHROMIUM_PATH` for preinstalled chrome). Needs migrated+seeded PG + `next start`. CI job `e2e` does it all.

Demo logins (local PGlite only): `landlord1@demo.kvaterka.by`, `tenant@demo.kvaterka.by`, `admin@demo.kvaterka.by` / password in `src/server/db/seed.ts`. Staff roles withheld until TOTP.

## Layout

- `src/server/api/routes/*.ts` — route table (auth, permission, rateLimit, zod body). Dispatcher `router.ts`.
- `src/app/api/*/route.ts` — 7 Next handlers OUTSIDE route table (uploads, avatar, geocode, google oauth, telegram webhook, ical, media). No table rate limiter/auth there: add by hand (`checkRateLimit`, `currentUser`).
- `src/server/domain` pure logic, no I/O. `src/server/services` transactions. Arrow: services → domain.
- `src/ui` components. `src/app/globals.css` tokens + primitives.
- `messages/{ru,be,en}/*.json` — every key in all three locales.
- `e2e/` — browser specs + `support.ts` (signIn, signInStaff w/ real TOTP, freeStay, fillStay, axe).
- Docs: root = README, CLAUDE, DECISIONS, MVP_RELEASE_CHECKLIST, HOW_TO_UPDATE_THE_SITE (owner, ru), SECURITY (+privacy). `docs/` = ARCHITECTURE (+schema, flows), PRODUCT (reqs + original spec §N), LEGAL, OPERATIONS. Don't add new .md files; extend these.

## Invariants — do not break

- DB constraints are the guarantee, app checks are messages. Money = integer kopecks.
- 404 not 403 for things caller may not see (anti-enumeration).
- Idempotency keys never contain raw user text (headers are ISO-8859-1; Cyrillic crashes fetch). Use `asciiDigest`.
- Machine (job token) principal only on routes with `permission`; elsewhere = anonymous.
- Telegram webhook: require `X-Telegram-Bot-Api-Secret-Token` (`telegramWebhookSecret`), contact must be sender's own.
- Upload handlers: sniff bytes (`sniffImage`), strip metadata, delete file if DB row not written.
- Mail-sending public routes: per-IP AND per-recipient limits (`bucketForRecipient`). IP from `X-Real-IP` is spoofable unless proxy overwrites it. Ask the budget BEFORE mutating the row the mail is about (rotated code + skipped mail = dead code). Over budget: register → 429, resend/reset → same `{ok:true}` as unknown address. Never 201 without changing state (DEC-087).
- Lockfile: regenerate only with npm 10 (`npx npm@10 …`), then prove with `npx npm@10 ci`. npm 11 drops the `next-intl/node_modules/@swc/helpers` entry and CI + host break. Next security fixes live in server `node_modules/next` → deploy needs `npm install --include=dev` on the host, not only the `.next` zip.
- Applied migrations are checksummed: never edit one, not even a comment. New change = next `NNNN_*.sql`.
- New table → entry in `domain/retention.ts` catalogue or the catalogue test fails.
- Watchdog (`services/watchdog.ts`) runs at end of lifecycle sweep; new invariant worth alerting = new check there. Errors → `error_event` via `recordError` (never throws, no user data).

## UI rules (learned the hard way)

- Every `:hover` inside `@media (hover: hover) and (pointer: fine)`. Split mixed selectors (`:hover, :focus-within`).
- `.card` = surface, NO padding. Padded section = `.panel`. Card text flush to edge = wrong primitive.
- Font: Onest via `next/font` (`--font-brand`), body `text-rendering: geometricPrecision` (optimizeLegibility opened gap after Cyrillic т on Linux). Form controls inherit it explicitly.
- White text only on `--primary`/`--primary-hover`/gradient; `--accent` never text.
- Header text nav breakpoint depends on link count: `data-nav` = anon 900px / member 1024px / staff 1180px. Adding a nav link → remeasure overlap in ru/be/en.
- Motion: `--ease-out` token, press `scale(0.97)`, entrances via `@starting-style`, UI < 300ms, add every new animated selector to `prefers-reduced-motion` block.
- No side-stripe `border-left` callouts, no icon-in-circle feature grids, no glassmorphism, parallax/scroll-jacking, grain overlays, external stock images (impeccable/taste bans + CSP).
- Touch targets ≥ 44px on coarse pointers (`e2e/mobile.spec.ts` checks).
- Unknown routes → `[locale]/[...rest]` → localized 404. Keep it.
- No `loading.tsx` at `[locale]` (or any segment with in-place actions): it made `router.refresh()` after an action get lost — POST committed, old panel stayed (DEC-086). Search keeps its own.
- Verify UI in a real browser at 390 and 1440 wide before claiming done; static review missed every layout bug in DEC-085.

## Skills in `.claude/skills`

impeccable (engine binary: `sh .claude/skills/impeccable/scripts/impeccable detect --json src/ui src/app`; URL mode needs `PUPPETEER_EXECUTABLE_PATH` to a `--no-sandbox` chrome wrapper), redesign-existing-projects / design-taste-frontend / gpt-taste, emil-design-eng / review-animations / animate / mobile-native, ponytail, caveman, strix-security (docs only; CLI needs own LLM key).

## Workflow

- Log each batch as next DEC-NNN in `DECISIONS.md`: Question / what found / why / verification with real numbers.
- Commits: long explanatory prose body (why + evidence), not caveman. Prove a fix by reverting it and watching its test fail.
- New endpoint = authorization tests incl. negative cases (DEC-083/084 audited all).
- E2E flake is never "flake": so far it was hydration (wait `networkidle`), reload mid-`router.refresh()`, date collision in reused DB, or a real bug (root loading.tsx).
- Checklist of launch gates: `MVP_RELEASE_CHECKLIST.md`.
