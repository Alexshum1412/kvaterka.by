# UI_UX_AUDIT.md

Audit of the rendered application, 2026-08-16. Measurements taken from the live dev server via the DOM, not from reading source.

---

## 0. Runtime first (resolved before auditing)

`Cannot find module './873.js'` / `'./vendor-chunks/zod.js'` was **generated-build corruption**, confirmed not a code defect:

| Step | Result |
|---|---|
| Running Next processes | none (server had already died) |
| `package.json` vs installed | `^15.1.3` → 15.5.23, consistent |
| Full `.next` removal + clean start | **errors gone**, 0 server errors |
| Production build | succeeds |
| Test suite | 463 passing |
| Typecheck | clean |

Cause: `.next/cache` was deleted while the dev server held the webpack chunk graph in memory, desynchronising the runtime manifest from the emitted chunks. **No dependency, version, or configuration change was needed or made.**

---

## 1. Current problem

The interface is *correct* and *legible* but reads as a 2014 listings site, not a 2026 marketplace. It is not a colour problem — the cornflower palette is fine and stays. It is a problem of **shape, weight and density**.

Measured on the live pages:

| Measurement | Found | Should be | Why it matters |
|---|---|---|---|
| Photo share of listing card height | **44%** | 58–64% | The photo is the product. At 44% the card reads as a text record with a thumbnail — the defining look of classifieds. |
| Card treatment | border **+** shadow **+** background | one of the three | Border + shadow + white is the single most generic card recipe there is. |
| Bordered elements on home | **23 of 147** | ~5 | Everything is in a box. Boxes inside boxes create the "administrative form" feel. |
| Results columns | 3 × 249px | 2–3 × 320px+ | 249px forces tiny type and cropped photos. |
| First listing offset | **235px** | ~120px | A marketplace must show inventory in the first screenful. |
| Type scale gap | 22px → 48px | intermediate step | Nothing between subhead and display; hierarchy collapses into weight-only. |
| Distinct radii | 10px, 14px, 9999px | 3, clearly separated | 10 and 14 are close enough to read as sloppy rather than systematic. |

## 2. Why it looks dated

1. **Container obsession.** Every group is a `.panel` with a 1px border. Modern product UI separates with *space and type*, and reserves borders for genuine boundaries (inputs, table rows).
2. **Uniform surface elevation.** One shadow value applied to everything means nothing reads as elevated. Elevation stops being information.
3. **Timid photography.** 4:3 crops at 44% of card height, inside a bordered box, with a radius that clips them awkwardly.
4. **Weight-only hierarchy.** Six text sizes but five font weights doing the real work. Headings do not command; labels and values look alike.
5. **Even, symmetrical rhythm.** Identical vertical padding everywhere; no optical adjustment; no deliberate density change between "browse" and "read" zones.
6. **Chrome before content.** The search form is a heavy bordered card sitting above the results, pushing inventory below the fold.

## 3. What should be removed

- The 1px border on `.card` and `.panel` (keep it only on inputs and genuine dividers).
- The border-*and*-shadow combination anywhere.
- `.panel` wrappers around sections that are just a heading plus content.
- The 10px radius (collapse to a 3-step scale).
- Badge pile-up on listing cards (two maximum, and only when they change a decision).
- The heavy bordered search-form card on the results page.

## 4. What should be redesigned

- **Listing card** — photo to 3:2 at ~60% of height, borderless, elevation on hover only, price as the strongest non-photo element.
- **Search results** — wider cards, fewer columns, larger gaps; filters as a light bar, not a card.
- **Homepage** — search dominant, then real listings immediately; trust content below inventory, not above it.
- **Listing page** — gallery gains height and edge-to-edge presence on mobile; booking panel loses its heavy frame.
- **Dashboard** — workspace, not admin console: attention items as a clean list, stats as plain figures rather than four bordered tiles.
- **Type scale** — add a step between 22 and 48; tighten display tracking; reserve 700 for display only.
- **Shadows** — three tinted levels (none / subtle / raised) carrying the navy hue rather than pure black.

## 5. What should remain

Everything that already works and is expensive to re-derive:

- The cornflower brand, mark and palette (**required, and not the problem**).
- All measured contrast ratios — no change may drop a pair below AA.
- The system font stack (verified Cyrillic + Belarusian coverage; a webfont would cost a round trip for no legibility gain).
- Tabular numerals on money.
- 44px touch targets, focus rings, reduced-motion handling, skip link.
- Every API, service, domain rule, authorization check and test.

## 6. New visual direction

**"Quiet surface, loud content."**

The interface recedes; photographs, prices and place names carry the page. Structure comes from a strict spacing scale and typographic contrast, not from drawn boxes. The cornflower appears in the mark, in the primary action, and in verification — nowhere else. Nothing moves unless it is reporting state.

## 7. Component-level changes

| Component | Change |
|---|---|
| `.card` | Border removed; `--shadow-subtle` at rest, `--shadow-raised` + 2px lift on hover; radius 12px |
| `.panel` | Becomes a *layout* primitive: padding + optional soft background, no border by default |
| `.listing-card` | 3:2 photo, ~60% height, borderless, price at `--text-lg`/600, max 2 badges, meta on one line |
| `.btn` | Press state (`translateY(1px)`), 150ms transitions, primary gains weight |
| `.badge` | Lower-contrast neutral variant so verified/instant actually stand out |
| `.input` | Keeps its border (a field must look like a field); focus ring unchanged |
| Section headings | New `--text-2xl` step, tighter tracking, more space above than below |

## 8. Mobile changes (360–430px)

- Listing cards go single-column full-bleed with a 3:2 photo — the phone becomes a photo feed, which is what browsing housing actually is.
- Results filter bar becomes a horizontally scrolling chip row, not a stacked form.
- Listing gallery goes edge-to-edge (negative margin out of the container).
- Dashboard stats become a 2×2 of plain figures, no tiles.
- Section padding drops from 2rem to 1.25rem; card padding from 1.25rem to 1rem.

## 9. Desktop changes (1024px+)

- Results: 2 columns beside a sticky map at ≥1024px, 3 columns only at ≥1440px, minimum card width 320px.
- Container stays 1200px, but the results grid may use the wider 1440px container.
- Listing page: gallery height increases; booking panel sticky, borderless, resting on a soft surface.
- Dashboard: attention list full width, listings two-up, no sidebar.

---

## Explicitly rejected from the redesign skill

The loaded `redesign-existing-projects` skill recommends several techniques that conflict with this product's stated constraints, and are **not** applied:

| Recommended | Rejected because |
|---|---|
| Glassmorphism, spotlight borders | Named in the brief as forbidden; costs paint performance on mid-range Android |
| Parallax stacks, split-screen scroll, smooth-scroll inertia | Scroll-jacking; the brief forbids it and it breaks a booking flow |
| Variable-font animation, outline-to-fill text | Requires a webfont; loses guaranteed Belarusian glyph coverage |
| Grain/noise overlays | A full-viewport fixed overlay for decoration only |
| Swap to Geist/Satoshi | Cyrillic + `ў`/`і` coverage is not guaranteed; round trip on mobile |
| `picsum.photos` background imagery | External network dependency, and this app's CSP/offline posture forbids it |

Taken from the skill and applied: remove the generic card recipe, fix the equal-three-column row, add press/hover states, tint shadows, widen the type scale, sentence case, and bottom-align actions in card groups.
