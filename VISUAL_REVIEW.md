# VISUAL_REVIEW.md — light redesign, ready for inspection

Second pass. The brief was: light, airy, minimal, photography-first, trustworthy — and *not* a palette swap.

## Start

```bash
npm run dev
```

**http://localhost:3000**, in-process PostgreSQL (`DATABASE_URL=pglite`), seeded with 6 listings across Минск, Гродно, Брест and Витебск.

| # | Page | URL |
|---|---|---|
| 1 | Homepage | http://localhost:3000/ |
| 2 | Search + filters + map | http://localhost:3000/search?city=Минск |
| 3 | Listing detail | http://localhost:3000/listing/01a00810-57f8-74dc-aafe-16cec15bdf54 |
| 4 | Landlord dashboard | http://localhost:3000/dashboard |
| 5 | Избранное | http://localhost:3000/favorites |
| 6 | Sign in | http://localhost:3000/login |

Dashboard and Избранное need a session: `landlord1@demo.kvaterka.by` / `sonca-nad-nemanam-2026`. Two other landlords (`landlord2@`, `landlord3@` — a company) and a tenant (`tenant@demo.kvaterka.by`) share the password.

## Read this first — why the site looked dark

**Your browser is in dark mode, and the old CSS followed the OS.** `@media (prefers-color-scheme: dark)` swapped the entire palette to navy automatically, so the light design was never on your screen. Measured on the running page before the fix: `background-color: rgb(12, 20, 36)`.

Dark is now **opt-in only** (`data-theme="dark"`). Light is what everybody gets. See DEC-027.

That single line explains most of "the site is dark navy and feels like an admin panel".

## Second thing that was broken, and invisible

The search module, the filter bar and **the sign-in form** were rendering as permanent grey skeletons. React's Suspense boundary around each `useSearchParams()` component resolved to its fallback and never resumed — the real `<form>` was in the DOM, inside a `<div hidden>`, with React's postponed marker `<!--$~-->` beside it.

Every route returned 200 the whole time. Typecheck and 472 tests passed. It was only visible by measuring the rendered DOM. Fixed by passing the query string down as props (DEC-026).

## What changed

**Palette.** Cornflower kept, hue moved from indigo (225°) toward sky (214°). `--accent` is your `#4da3ff`; buttons and links use `#216aca`, because white on `#4da3ff` measures **2.63:1** and fails. Every value was *solved*, not picked — `node scripts/contrast.mjs` asserts 24 pairs and exits non-zero on failure. Three first-choice colours were rejected by it. The binding constraint turned out not to be white text at all, but `--primary` reading on `--primary-soft` inside a selected chip.

**Rules, not values.** A surface gets space *or* a border *or* elevation — never two. Cards are white on `#f7f9fc` with no border and no resting shadow. Borders survive only on controls, where `--border-control` is deliberately visible at 3.3:1 (WCAG 1.4.11).

**Type.** H1 40 / H2 28 / H3 20 / body 16 / small 14. One heavy weight per group.

**Icons.** One family, 24px, 1.6 stroke, driven by a single path map so geometry cannot drift. The previous mix of emoji, `→`, `★` and ad-hoc SVG is gone.

### Measured, on the running page

| | Before | After |
|---|---|---|
| Page background | `#0c1424` (navy) | `#f7f9fc` |
| Hero → first listing (desktop) | 540px | **428px** |
| Hero → first listing (375px) | 866px | **716px** |
| Photo share of card | 44% | **60%** |
| Search module on a phone | 491px | **266px** |
| Permanently-suspended controls | 3 | **0** |
| Horizontal overflow, 375–1440 | — | **none** |
| Cross-file CSS collisions | 1 (`.sf`) | **0** |

The `.sf` collision was real: `site-footer.tsx` and `search-form.tsx` both claimed that prefix, and these `<style>` blocks are global, so the footer's `margin-top: 4rem` and `border-top` were landing on the search box.

## New in this pass

- **Flexible-duration search.** Сутки / 3 ночи / Неделя / Месяц / 3 месяца / Полгода / Год / Свои даты. A length plus a start date computes the end date; a length alone sends `durationMode`. "Квартира в Минске на 3 месяца" is now directly expressible. On a phone it is three questions — where, how long, go.
- **Filters** — price, rooms, duration, guests, amenities grouped by category, rules, verification, instant booking, sort. Every control maps to a parameter the server actually reads; nothing is rendered that does nothing.
- **Favourites, for real** — table, `PUT`/`DELETE` (idempotent by definition), heart on every card, `/favorites` page. Signed-out visitors are sent to sign-in rather than shown a heart that lies. 9 integration tests, including one asserting a draft and a non-existent id return byte-identical responses so the endpoint cannot be used to enumerate private listings.
- **Grouped amenities** on the listing page, with the "подтвердили N из M" guest evidence preserved.
- **Structured reviews** — the sub-ratings were always collected and never shown; they are now averaged into a dimension bar.
- **Sticky booking dock** on phones; the panel was otherwise 2,700px down the page.

## Verified

- 472 tests, typecheck clean, production build succeeds
- All routes 200; `/dashboard` and `/favorites` 307 → `/login` when signed out
- **Zero console output** on a production build
- No horizontal overflow at 375 / 390 / 430 / 768 / 1024 / 1440
- Favourites round-trip exercised in the browser: click → `aria-pressed` → server persists → `/favorites` renders it → removed again

## Two things still not judgeable

1. **The photographs are placeholders.** No object storage, so `/media/*` serves a deterministic tinted panel per listing. Judge layout, proportion and photo *weight* — not the imagery.
2. **The map has no tile layer.** No provider chosen (it interacts with LEGAL-014). Markers sit in true relative positions. Judge marker legibility and panel proportion, not cartography.

## Known gaps

- **Dark mode is functional but undesigned**, on purpose (DEC-023). Do not review it yet.
- **The production runtime cannot serve data** — `next start` sets `NODE_ENV=production` and the runtime correctly refuses `DATABASE_URL=pglite`. The build is verified; the production *runtime* needs real PostgreSQL, which is still an external blocker.
- **`npm run lint` is broken** — ESLint 9 needs a flat `eslint.config.js` and the repo has none. Pre-existing; `npm run verify` fails on it. Not fixed here because a first lint run mid-review would bury the visual changes.
- No active-page indication in the header nav — the header is a server component and has no pathname.
- No gallery lightbox; the extra-photo count is shown as text rather than a button that opens nothing.
