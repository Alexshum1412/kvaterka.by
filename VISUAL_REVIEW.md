# VISUAL_REVIEW.md — pages ready for inspection

Feature development is frozen pending your review. Nothing below is a speculative visual change.

## Start the app

The dev server should already be running. If not:

```bash
npm run dev
```

Runs on **http://localhost:3000** against an in-process PostgreSQL (`DATABASE_URL=pglite`), seeded with 6 real listings across Минск, Гродно, Брест and Витебск.

## Pages to review

| # | Page | URL |
|---|---|---|
| 1 | Homepage | http://localhost:3000/ |
| 2 | Search results + map | http://localhost:3000/search?city=Минск |
| 3 | Listing detail | http://localhost:3000/listing/01a00810-57f8-74dc-aafe-16cec15bdf54 |
| 4 | Landlord dashboard | http://localhost:3000/dashboard |
| 5 | Sign in | http://localhost:3000/login |

Listing ids are stable across restarts (the dev database persists to `.pgdata`). If you reset it, get a current id from `http://localhost:3000/api/search`.

### Signing in for the dashboard

`/dashboard` requires a session and redirects to `/login` otherwise.

| | |
|---|---|
| Email | `landlord1@demo.kvaterka.by` |
| Password | `sonca-nad-nemanam-2026` |

Two other seeded landlords (`landlord2@`, `landlord3@` — the last is a company account) and a tenant (`tenant@demo.kvaterka.by`) share the same password.

To see the dashboard's «Требует внимания» section populated, sign in as the tenant, request a booking on any listing, then sign back in as `landlord1`.

## Mobile

Use the browser's device toolbar. The breakpoints that actually change layout:

| Width | What changes |
|---|---|
| **≤ 560px** | Listing grid becomes one full-width column |
| **≤ 640px** | Listing gallery goes edge-to-edge |
| **≤ 600px** | Header drops the secondary nav item |
| **≥ 720px** | Dashboard stats go 2×2 → 1×4 |
| **≥ 1024px** | Search becomes listings + sticky map |

Verified at 375px: **0 horizontal overflow**, 343px cards at 63% photo, no control under 40px.

## Two things to know before judging

**1. Photographs are placeholders, not real photos.** No object storage is configured, so `/media/*` serves a deterministic tinted panel with the cornflower mark. Each listing gets a distinct stable tint. It is obviously a placeholder by design — pretending a photo exists would be worse. **Judge the layout, proportion and photo *weight*; do not judge the imagery itself.** Real photography will change the character of every card and the listing gallery substantially.

**2. The map has no tile layer.** No provider is chosen yet (it interacts with LEGAL-014). Markers sit in their true relative geographic positions on a plain projection, and the panel says so. Judge marker legibility and panel proportion, not cartography.

## What changed in this pass

Measured from the live DOM, before → after:

| | Before | After |
|---|---|---|
| Photo share of listing card | 44% | **62%** |
| Listing card width | 249px | **380px** |
| Results columns | 3 × 249 | 2 × 380 |
| Elements with border **+** shadow **+** background | 23 | **0** |
| Distinct border radii | 10 / 14 / full | 8 / 12 / 20 / full |
| Listings visible in first screenful (home) | 0 | **6** |

The cornflower palette did not change — it was not the problem.

## Current state

- 463 tests passing, typecheck clean, production build succeeds
- No server errors; no console errors caused by application code
- All 5 routes return 200 (dashboard 307 → `/login` when anonymous, as intended)

## Known gaps, deliberately not fixed without your input

- Real photography and a map provider (above).
- The homepage hero still reserves roughly 540px before the first listing on a 720px-tall viewport. Reducible, but that is a judgement call about how much the search box should dominate — I want your read before changing it.
- Dark mode is implemented and token-complete but has had far less visual scrutiny than light mode. Worth a look if you use a dark OS theme.
