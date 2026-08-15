# USER_FLOWS.md

Transition semantics are defined by the table in `src/server/domain/booking/states.ts`; this document is its readable form. Where they disagree, the code is authoritative — and the tests will say so.

---

## 1. Booking transitions

| From | Event | Actor | To | Effects |
|---|---|---|---|---|
| INQUIRY | REQUEST | Tenant | REQUESTED | notify landlord |
| INQUIRY | INSTANT_BOOK | Tenant | CONFIRMED | freeze terms, hold calendar, auto-decline competitors, release contacts, notify both |
| INQUIRY | MAKE_OFFER | Tenant/Landlord | OFFER_PENDING | notify both |
| INQUIRY | WITHDRAW / EXPIRE | Tenant / System | WITHDRAWN / EXPIRED | — |
| REQUESTED | ACCEPT_REQUEST | Landlord | CONFIRMED | freeze terms, hold calendar, auto-decline competitors, release contacts, notify tenant |
| REQUESTED | DECLINE_REQUEST | Landlord | DECLINED | notify tenant |
| REQUESTED | COUNTER_OFFER | Landlord | OFFER_PENDING | notify tenant |
| REQUESTED | WITHDRAW | Tenant | WITHDRAWN | notify landlord |
| REQUESTED | EXPIRE | System | EXPIRED | notify both |
| OFFER_PENDING | COUNTER_OFFER | Tenant/Landlord | OFFER_PENDING | notify both |
| OFFER_PENDING | ACCEPT_OFFER | Tenant/Landlord | CONFIRMED | freeze terms, hold calendar, auto-decline competitors, release contacts |
| OFFER_PENDING | DECLINE_REQUEST | Landlord | DECLINED | notify tenant |
| CONFIRMED | CHECK_IN | Tenant | CHECKED_IN | notify landlord |
| CONFIRMED | CANCEL_BY_TENANT | Tenant | CANCELLED_BY_TENANT | release calendar |
| CONFIRMED | CANCEL_BY_LANDLORD | Landlord | CANCELLED_BY_LANDLORD | release calendar, **fraud signal** |
| CONFIRMED / CHECKED_IN | REACH_STAY_END | System | COMPLETION_PENDING | notify both |
| CONFIRMED / CHECKED_IN / COMPLETION_PENDING | OPEN_DISPUTE | Tenant/Landlord | DISPUTED | notify admin |
| COMPLETION_PENDING | CONFIRM_COMPLETION | Tenant/Landlord | COMPLETION_PENDING | records one answer |
| COMPLETION_PENDING | RESOLVE_COMPLETION | System | COMPLETED | **accrue fee**, open reviews |
| COMPLETION_PENDING | RESOLVE_COMPLETION | System | NOT_TAKEN_PLACE | release calendar, no fee |
| COMPLETION_PENDING | RESOLVE_COMPLETION | System | DISPUTED | notify admin, no fee |
| DISPUTED | RESOLVE_DISPUTE_AS_* | **Admin only** | COMPLETED / NOT_TAKEN_PLACE / CANCELLED_BY_LANDLORD | per outcome |

A landlord cancellation always emits a fraud signal — it is the failure mode that damages tenants most, and it must feed trust scoring even when a single instance is innocent.

---

## 2. Tenant: search → stay → review

1. **Search** — city, dates, filters, or a map area. Sees approximate pins, total prices, verification badges. No account needed.
2. **Listing** — full rental passport, honest price breakdown (mandatory charges summed; metered utilities shown separately as variable), house rules, reviews, landlord trust profile. Exact address **not** shown.
3. **Contact or book** — messaging requires an account. Contact details are filtered until confirmation, with the reason stated in plain language.
4. **Request or instant book** — request does not hold the calendar; instant booking confirms immediately or fails with "these dates are taken".
5. **Confirmed** — terms frozen. Exact address and contact details released; the release is timestamped and audited.
6. **Check-in** — confirm arrival, optionally attach condition photos.
7. **Stay ends** — completion window opens; both parties asked whether the rental took place.
8. **Completion** — confirming completes the rental; the tenant's answer is decisive after the deadline because the tenant has no fee exposure.
9. **Review** — structured, one per side, published when both submit or on timeout.

## 3. Landlord: listing → income

1. **Create listing** — type, address, precision, photos (1 minimum), passport fields, amenities, rules, duration range, pricing, calendar, booking mode.
2. **Moderation** — approved or rejected with a reason.
3. **Published** — appears in search; freshness affects ranking.
4. **Requests** — accept, decline or counter. Accepting auto-declines overlapping competitors, each told why.
5. **Stay** — calendar held; chat available with contacts released.
6. **Completion** — confirm whether the rental happened. Confirming "yes" is an admission of the fee and is trusted immediately; silence does not avoid the fee if the tenant confirms.
7. **Fee** — 5% of the frozen base becomes a payable debt; balance goes negative.
8. **Debt** — restricts *new* commercial activity (new listings, accepting new bookings, promotion). It never interferes with an active booking, because punishing a landlord mid-stay punishes their tenant.

## 4. Completion decision table

| Tenant | Landlord | Deadline | Outcome | Fee | Signal |
|---|---|---|---|---|---|
| took place | took place | any | COMPLETED | yes | — |
| did not | did not | any | NOT_TAKEN_PLACE | no | — |
| took place | did not | any | DISPUTED | no | contradiction |
| did not | took place | any | DISPUTED | no | contradiction |
| — | took place | any | COMPLETED | yes | — (admission against interest) |
| took place | — | passed | COMPLETED | yes | — |
| did not | — | passed | NOT_TAKEN_PLACE | no | — |
| — | did not | passed | NOT_TAKEN_PLACE | no | **unilateral landlord denial** |
| — | — | passed, check-in exists | COMPLETED | yes | — |
| — | — | passed, no evidence | NOT_TAKEN_PLACE | no | silent, no evidence |
| any single answer | — | not passed | still pending | no | — |

## 5. Admin

Moderation queue → decision with reason → audited. Verification queue → `VERIFIER` opens documents (every read logged) → decision → level updated. Disputes → evidence review → resolution, which is the only path that can move a booking out of `DISPUTED`. Every administrative action writes an audit row with actor, target, diff and reason.

## 6. Telegram linking

User requests linking → single-use token in `auth_token` → user confirms in the bot → `telegram_connection` created → per-category preferences apply. Unlinking is immediate. Telegram carries notifications only; the conversation itself never leaves the platform.
