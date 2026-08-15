# MASTER PROMPT FOR CODEX — BELARUS RENTAL PLATFORM

## 0. ROLE

You are the principal product architect, senior full-stack engineer, system designer, security architect, DevOps engineer, QA lead, UX/product strategist, and technical project manager for this product.

Your job is not to merely discuss the product or generate a superficial prototype.

Your job is to turn the product concept below into a production-grade, maintainable, secure, testable, scalable web platform.

You must:
- inspect the existing repository before changing anything;
- understand the current architecture and reuse what is good;
- identify missing pieces and weak decisions;
- choose the best practical implementation when requirements are ambiguous;
- never silently invent business rules;
- keep a traceable record of decisions;
- implement, test, audit, and document the result;
- continuously compare implementation against this specification;
- prefer simple, robust solutions over unnecessary complexity;
- never mark a feature complete merely because its UI exists;
- verify end-to-end behavior across frontend, backend, database, background jobs, notifications, permissions, and error handling.

The product is initially for BELARUS ONLY.

IMPORTANT:
This document is the product vision and baseline specification. It does not override applicable law, platform limitations, security requirements, or technical reality. Where legal/technical details are uncertain, verify them using authoritative current sources and document the result instead of guessing.

---

# 1. PRODUCT VISION

We are building a Belarusian rental marketplace inspired by the convenience of Airbnb, but NOT a clone.

Core idea:

> A trusted digital marketplace where property owners independently publish and manage rental listings, while tenants can find, compare, communicate, book, document, and review rentals with maximum transparency and minimum friction.

The platform should work for:
- short-term rentals;
- medium-term rentals;
- long-term rentals.

The same property can be offered for different rental durations.

The platform philosophy:

> “Everything needed for an honest rental in one place.”

We are not building a simple classified ads board.

We are building a rental operating system / trust infrastructure.

Core value:
1. Trust.
2. Transparency.
3. Flexibility.
4. Convenience.
5. Strong reputation/history.
6. Direct relationship between landlord and tenant.
7. Platform assistance without unnecessarily becoming a party to the lease.

---

# 2. INITIAL LEGAL / BUSINESS MODEL

The company behind the platform already has an LLC/ООО.

The intended MVP model is:

THE PLATFORM:
- provides the marketplace;
- provides listings;
- provides search;
- provides maps;
- provides profiles;
- provides internal messaging;
- provides booking/request workflows;
- provides calendars;
- provides reviews and reputation systems;
- provides verification;
- provides notifications;
- provides a digital record of platform events;
- charges landlords a 5% platform service fee/debt after a completed rental transaction is confirmed.

THE PLATFORM DOES NOT WANT, IN THE MVP:
- to receive rental money from the tenant;
- to hold tenant funds;
- to act as escrow;
- to transfer rental money from tenant to landlord;
- to be the landlord;
- to become the contractual counterparty to the lease;
- to manage the property;
- to guarantee the landlord's obligations;
- to guarantee the tenant's obligations.

Tenant and landlord settle with each other directly using a method they agree upon.

The platform's 5% fee is a SERVICE FEE owed by the landlord to the platform, not the tenant's rental payment.

Example:
- agreed rental price = 1,000 BYN
- tenant pays landlord directly = 1,000 BYN
- landlord owes platform = 50 BYN service fee
- platform balance becomes -50 BYN or equivalent payable debt.

The exact legal wording, invoicing, tax treatment, accounting treatment, consumer-law implications, and contract structure MUST be verified for Belarus before production launch.

IMPORTANT:
Do not assume that the above business model automatically eliminates all legal obligations.
Create a legal-risk matrix and identify exactly what must be verified by a Belarus-qualified lawyer/accountant before launch.

---

# 3. CORE DIFFERENTIATOR

The platform should make users feel:

> “I know who I am dealing with, what I am renting, how much it really costs, what the rules are, what other people experienced, and what happens at every stage of the rental.”

Major product principle:

## RENTAL WITHOUT SURPRISES

The platform should proactively eliminate:
- hidden fees;
- fake or stale listings;
- fake profiles;
- misleading photos;
- unclear house rules;
- unclear rental terms;
- unreliable calendars;
- missing history;
- weak reviews;
- off-platform communication pressure;
- disputes with no evidence trail.

---

# 4. TARGET USERS

## 4.1 Tenant / renter

Examples:
- tourist;
- business traveler;
- student;
- family;
- couple;
- person moving to another city;
- long-term tenant;
- person renting for several months;
- person renting for a year or more.

## 4.2 Landlord / property owner

Examples:
- individual with one apartment;
- individual with several apartments;
- professional landlord;
- property manager;
- company;
- agency/company that transparently identifies itself as a company.

Companies/agencies must NOT pretend to be ordinary private individuals.

## 4.3 Administrator / moderation staff

Responsible for:
- moderation;
- reports;
- fraud review;
- verification;
- disputes/cases;
- content moderation;
- account restrictions;
- platform operations;
- system configuration;
- audit logs.

Architect for role-based permissions and least privilege.

---

# 5. GEOGRAPHY AND LANGUAGE

Launch market:
- Belarus only.

Design architecture so that localization can later support:
- Russian;
- Belarusian;
- English;
without making the first version unnecessarily complex.

Do not hardcode Belarus-specific assumptions into every subsystem.
Centralize:
- currency;
- locale;
- address formats;
- time zone;
- tax/legal notices;
- notification templates;
- measurement units.

---

# 6. RENTAL DURATION MODEL

This is one of the defining product features.

A landlord chooses:
- minimum rental duration;
- maximum rental duration.

The range may cover:
- hours (if legally/product-wise appropriate);
- days;
- weeks;
- months;
- years.

Prefer a technically consistent internal representation of duration.
The UI may use human-friendly units.

Example:
- minimum = 3 days
- maximum = 12 months

Another:
- minimum = 14 days
- maximum = 6 months

Another:
- minimum = 1 day
- maximum = 3 years

Do NOT force all landlords into a single short-term or long-term category.

The same listing can have different pricing for different durations.

---

# 7. PRICING MODEL

The platform must support multiple pricing strategies.

## 7.1 Fixed pricing
Examples:
- 100 BYN/night
- 1,900 BYN/month
- 20,000 BYN/year

## 7.2 Tiered pricing
Example:
- 1–3 days: 120 BYN/day
- 4–7 days: 105 BYN/day
- 8–30 days: 90 BYN/day
- 1–6 months: 2,100 BYN/month
- 6+ months: 1,800 BYN/month

## 7.3 Seasonal pricing
Different prices by date periods.

## 7.4 Day-of-week pricing
Optional.

## 7.5 Demand/recommendation mode
System can recommend pricing but must NOT silently change it unless landlord explicitly enables an automation mode.

## 7.6 Custom price
Landlord manually sets prices.

## 7.7 Negotiation / “Make an offer”
Optional per listing.

Flow:
- tenant proposes price;
- landlord accepts/rejects/counteroffers;
- final agreed amount becomes part of booking record;
- service fee is calculated from final confirmed rental amount;
- all changes are auditable.

The platform must support a wide range of landlord styles rather than forcing one workflow.

---

# 8. TOTAL PRICE / TRANSPARENCY

The tenant must see the total expected rental cost before committing.

Avoid “cheap headline + hidden mandatory fees”.

Display:
- base rental amount;
- mandatory cleaning fee (if any);
- mandatory additional charges;
- utilities/communal charges where applicable;
- other mandatory charges;
- optional charges separately.

Example:

Rental: 560 BYN
Mandatory cleaning: 30 BYN
Mandatory other charges: 0 BYN
Expected total: 590 BYN

If some variable cost depends on a meter/actual consumption and cannot be known in advance, clearly label it as variable.

After a booking is confirmed:
- the confirmed financial terms become immutable historical data;
- any change requires an explicit booking amendment accepted according to the workflow;
- never allow silent price manipulation.

---

# 9. BOOKING MODES

Each listing can choose one or more supported modes, subject to rules.

## 9.1 Instant booking
Tenant confirms according to listing conditions.

## 9.2 Request-to-book
Tenant submits a request.
Landlord accepts/rejects.

## 9.3 Negotiation
Tenant and landlord agree on custom price/terms.

Do not build separate parallel systems if one booking state machine can support all modes cleanly.

---

# 10. BOOKING STATE MACHINE

Design an explicit finite state machine.

Suggested states (you may improve them):

DRAFT
PENDING_MODERATION
PUBLISHED
INQUIRY
OFFER_SENT
OFFER_COUNTERED
BOOKING_REQUESTED
BOOKING_ACCEPTED
BOOKING_DECLINED
BOOKING_CANCELLED_BY_TENANT
BOOKING_CANCELLED_BY_LANDLORD
CONFIRMED
CHECKIN_PENDING
CHECKED_IN
ACTIVE
CHECKOUT_PENDING
COMPLETED
DISPUTED
RESOLVED
EXPIRED

Do NOT blindly copy this list.
Design the final state machine based on:
- short-term;
- long-term;
- instant booking;
- request flow;
- cancellation;
- no-show;
- disputes;
- completed rental;
- platform fee.

Document every transition:
- who can trigger it;
- prerequisites;
- allowed transitions;
- side effects;
- notifications;
- audit events.

---

# 11. TWO-SIDED COMPLETION CONFIRMATION

This is critical.

At the end of a rental:
- tenant confirms whether the rental actually took place;
- landlord confirms whether the rental actually took place.

When both confirm:
- rental becomes completed;
- review process opens;
- service fee becomes payable debt for landlord;
- Rewards ticket can become eligible IF/WHEN the legal rewards system is activated.

Need careful timeout behavior:
- if only one side confirms;
- if the other side does nothing;
- if one side disputes;
- if one side reports fraud.

Design a robust event-driven workflow.

---

# 12. PLATFORM SERVICE FEE / LANDLORD DEBT

Default:
- 5% of the final agreed rental amount.

Example:
Rental = 1,000 BYN
Platform fee = 50 BYN

The fee creates a payable balance for the landlord.

Suggested account behavior:

Normal balance = 0
Debt = -50 BYN

Until debt is resolved:
- browsing listings: allowed;
- messaging existing contacts: allowed where appropriate;
- account/profile access: allowed;
- critical access to active rental: allowed;
- creating new active listings: potentially restricted;
- accepting new bookings: restricted;
- promotional boosts: restricted;
- new instant bookings: restricted.

Choose the most user-friendly restriction model that is still commercially effective.

Do NOT over-block users in a way that can harm an already active legitimate tenant/booking.

Create:
- debt ledger;
- fee calculation record;
- invoice/statement concept if appropriate;
- payment status;
- payment history;
- reminders;
- grace period strategy;
- admin override;
- audit trail.

Do not treat financial records as mutable fields.
Use immutable ledger-style records where appropriate.

---

# 13. REGISTRATION

Require accounts for meaningful platform actions.

Guest browsing can be possible.
Creating listings, booking, messaging, reviewing, and other transactional actions require authentication.

Support:
- email;
- phone;
- secure password or passwordless if architecturally sound;
- Telegram linking optionally for notifications;
- future identity verification mechanisms.

Avoid requiring excessive personal data at initial registration.

---

# 14. USER PROFILE VISIBILITY

## Tenant can see landlord:
- personal name OR company name;
- rating;
- number of active properties;
- verification status;
- completed rental count;
- useful public trust information.

## Landlord can see tenant:
- name;
- rating;
- completed rental count;
- verification status;
- useful public trust information.

Never expose:
- passport details;
- identity documents;
- private addresses;
- internal moderation notes;
- sensitive verification data;
- private case data.

Public profile must be privacy-safe.

---

# 15. VERIFICATION SYSTEM

Three main levels.

## Level 0 — “Newcomer”
Verified:
- phone;
- email.

Listing visible, but:
- “Documents not verified” warning;
- lower ranking;
- no verification badge;
- restricted advanced capabilities as defined by policy.

## Level 1 — “Identity verified”
Identity verified using:
- passport/photo documents + selfie;
OR
- supported national identity/identity provider mechanism if available and legally usable.

Moderator/system verifies:
- identity consistency.

Benefits may include:
- “Identity verified” badge;
- request-to-book;
- improved search ranking;
- other reasonable trust benefits.

## Level 2 — “Verified”
Verify:
- identity;
- right to rent the specific property;
- ownership OR valid authority/power of attorney;
- video verification and/or strong identity verification;
- property documents where appropriate;
- address consistency;
- optional property inspection.

Possible additional checks:
- geolocation evidence;
- complaints/reputation checks;
- inspection act.

IMPORTANT:
Do not assume technical access to government registries such as EGRNI.
Verify legal and technical availability first.
If not available, design manual/document verification.

---

# 16. PROPERTY VERIFICATION

Property verification is separate from identity verification.

Possible status:
- identity verified;
- property verified;
- fully verified account.

A fully verified person may have an unverified new property.

This distinction MUST be visible in the product.

Possible public badges:
- Identity verified
- Property verified
- Verified landlord
- Address verified
- Long-running landlord
- High trust

Do not make badges misleading.

---

# 17. DOCUMENT SECURITY

Identity documents and verification materials are highly sensitive.

Requirements:
- encrypt at rest;
- encrypt in transit;
- strict role-based access;
- access logging;
- retention/deletion policy;
- no public exposure;
- no URLs that allow unrestricted download;
- ideally integrate with specialized KYC/identity provider where legally and technically suitable;
- do not allow ordinary support staff to access full identity data by default;
- create an auditable verification trail.

Need a privacy/data-protection review before production.

---

# 18. PROPERTY CREATION FLOW

Make listing creation extremely easy.

Suggested steps:

1. Property type
2. Address / map
3. Approximate location policy
4. Photos
5. Property characteristics
6. Amenities
7. Rules
8. Guests capacity
9. Rental duration range
10. Pricing
11. Calendar
12. Booking mode
13. Negotiation settings
14. Description
15. Verification
16. Preview
17. Moderation
18. Publish

Minimum photo count for initial listing publication:
- 1 photo.

Do not force excessive requirements for legitimate landlords.

However, use:
- quality recommendations;
- nudges;
- optional photo completeness score.

---

# 19. MAP

Map is central.

Landlord:
- selects property location.

Tenant:
- searches by map;
- sees approximate/controlled location before booking where privacy requires it;
- sees exact address after the correct booking stage.

Need:
- geospatial storage;
- radius search;
- city/district search;
- map clustering;
- bounds search;
- distance-based filtering.

Design provider abstraction so map provider can be replaced later.

---

# 20. PHOTOS

Support:
- multiple photos;
- ordering;
- cover image;
- deletion;
- captions if useful;
- photo quality checks;
- optional duplicate/fraud detection;
- future image authenticity/metadata checks.

Do not make EXIF metadata a hard requirement.

Minimum = 1.

Encourage high-quality complete galleries.

---

# 21. PROPERTY “RENTAL PASSPORT”

Each listing should have a structured factual profile.

Example fields:
- city;
- district;
- approximate/exact address rules;
- type;
- area;
- rooms;
- beds;
- bathrooms;
- floor;
- total floors;
- elevator;
- parking;
- Wi-Fi;
- workspace;
- air conditioning;
- washing machine;
- dishwasher;
- balcony;
- accessibility;
- pets;
- smoking;
- children;
- parties;
- quiet hours;
- max guests;
- check-in/check-out;
- minimum rental;
- maximum rental.

Store structured data, not only free text.

---

# 22. PROPERTY TAGS / FILTERABLE RULES

Examples:
- smoking prohibited;
- smoking allowed;
- smoking on balcony only;
- pets allowed;
- small pets only;
- children allowed;
- baby crib;
- additional sleeping place;
- parties prohibited;
- events prohibited;
- quiet hours;
- parking;
- elevator;
- balcony;
- Wi-Fi;
- workspace;
- air conditioning;
- dishwasher;
- washing machine;
- accessibility;
- heating;
- underfloor heating.

Tags must be standardized for filtering.

Free text can complement tags but must not replace structured values for critical search criteria.

---

# 23. SMART / STANDARD LANDLORD MODES

Landlord can choose how much automation to use.

## Standard
Manual:
- pricing;
- calendar;
- booking acceptance;
- rules.

## Flexible
Adds:
- seasonal rules;
- discounts;
- tiered prices;
- minimum stay logic;
- negotiation.

## Smart
Adds:
- price suggestions;
- occupancy recommendations;
- gap-filling recommendations;
- stale-calendar reminders;
- demand insights;
- recommended minimum stay.

Automation must be opt-in.
Never silently change landlord-controlled business values.

---

# 24. CALENDAR

Calendar must be one of the best parts of the product.

Support:
- day;
- week;
- month;
- multi-month view;
- mobile-friendly interaction.

Statuses:
- free;
- booked;
- blocked;
- pending;
- unavailable.

Support:
- drag selection;
- multi-day changes;
- bulk operations;
- recurring rules where appropriate;
- different pricing by date range;
- minimum stay per range;
- maximum stay per range;
- availability rules.

Show:
- last calendar update timestamp;
- stale calendar warning.

Example:
GREEN — updated today
YELLOW — updated several days ago
RED — stale

Search ranking can consider listing freshness.

Potential future:
- iCal/ICS import/export.

---

# 25. INTERNAL CHAT

All meaningful communication should occur inside the platform.

Do NOT automatically move users to Telegram/WhatsApp/etc.

Chat must support:
- text;
- images;
- booking context;
- system messages;
- offer/counteroffer;
- booking updates;
- moderation reports;
- timestamps;
- unread state;
- message search where appropriate.

---

# 26. ANTI-OFF-PLATFORM / CONTACT BLOCKING

Before an appropriate booking stage, the chat should block or flag:
- phone numbers;
- email addresses;
- Telegram usernames;
- WhatsApp contact information;
- Viber identifiers;
- external URLs;
- social handles;
- attempts to obfuscate contact info.

Do not rely only on regex.

Use layered detection:
1. normalization;
2. regex;
3. token pattern detection;
4. URL detection;
5. username patterns;
6. language-aware obfuscation detection;
7. optional ML/classifier assistance if useful.

Examples of evasion:
- “+3 7 5 ...”
- words replacing digits;
- spaces/symbols;
- “telegram: username”
- “write me on [site]”
- encoded links.

BUT:
Avoid false positives for normal content such as:
- apartment number;
- floor;
- street number;
- Wi-Fi password;
- dates;
- booking codes.

Build test cases specifically for Russian and Belarusian-language chats.

After the booking reaches a legally/product-approved stage, contact exchange may become available.

The product should log when contact-sharing permissions change.

---

# 27. TELEGRAM NOTIFICATIONS

Telegram is an optional NOTIFICATION CHANNEL.

Do NOT move the platform's canonical chat history to Telegram.

Support optional notifications for:
- new booking request;
- booking accepted/rejected;
- new internal message;
- upcoming check-in;
- upcoming checkout;
- cancellation;
- review request;
- platform debt;
- important account/security events.

User chooses notification categories.

Use a Telegram bot and account-linking workflow.

Secure linking and unlinking.

---

# 28. REVIEWS

Reviews are core trust infrastructure.

Two-sided:
- tenant reviews landlord/property;
- landlord reviews tenant.

Prevent retaliation where practical.

Preferred publication model:
- publish after both submit;
OR
- publish after a reasonable timeout.

Do not allow one party to see the other's unpublished review in a way that can induce retaliation.

---

# 29. STRUCTURED REVIEWS

Do not allow only:
“5 stars, everything good.”

Collect structured fields.

Tenant reviews:
- overall;
- cleanliness;
- accuracy;
- check-in;
- communication;
- location;
- value;
- house rules clarity;
- actual length of stay;
- trip type (optional);
- public text;
- what was good;
- what could improve.

Landlord reviews:
- overall;
- communication;
- rule compliance;
- property condition at checkout;
- timeliness/behavior;
- actual length of stay;
- public text;
- notable strengths/issues.

The exact fields may differ by rental type.

Display rental duration in human-friendly form:
- “stayed 12 days”
- “rented for 6 months”

Avoid publishing exact private dates unless explicitly needed.

---

# 30. REVIEW QUALITY

Prevent empty meaningless reviews.

Use prompts:
- What was especially good?
- What could be improved?
- Did the property match the listing?
- Would you rent again?

Structured data should carry value even if public text is short.

Review integrity:
- only verified/completed rentals can generate reviews;
- one review per side per rental;
- edits tracked;
- moderation available;
- fraud/manipulation detection.

---

# 31. TRUST SCORE

Create a reputation system stronger than a simple star rating.

Possible inputs:
- verification level;
- successful rentals;
- review score;
- cancellation rate;
- response time;
- calendar freshness;
- dispute history;
- confirmed listing accuracy;
- account age;
- rule compliance.

Do NOT allow users to directly buy trust.

Paid promotion may affect ad placement but must not artificially inflate trust.

Trust Score formula must:
- be documented internally;
- be resistant to easy gaming;
- avoid over-weighting one factor;
- have cold-start handling;
- have anti-manipulation safeguards.

Public UX should remain understandable.

Example:
“High trust”
“97/100”
plus explanation.

---

# 32. RENTAL DNA / COMPATIBILITY

This is a differentiator.

Property has structured characteristics/preferences.
Tenant has preferences.

System can estimate compatibility based on objective criteria.

Example tenant:
- dog;
- remote work;
- 6 months;
- max 2,000 BYN;
- not first floor.

Property:
- pets allowed;
- workspace;
- minimum 3 months;
- 1,900 BYN;
- 7th floor.

System:
“96% match”

This is a recommendation layer, NOT psychological profiling.

Do not infer sensitive traits.

Explain why:
- ✅ pets allowed;
- ✅ workspace;
- ✅ duration fits;
- ✅ budget fits;
- ✅ not first floor.

---

# 33. AI / NATURAL-LANGUAGE SEARCH

Support natural-language intent.

Example:
“I need a 2-room apartment in Minsk for 3 months, remote work, good Wi-Fi, occasional small dog, budget up to 2,000 BYN, no first floor, near metro.”

System extracts:
- city;
- property type;
- duration;
- workspace;
- Wi-Fi;
- pets;
- budget;
- floor;
- transport proximity.

Then searches structured inventory.

Results should explain why each result matches.

AI must never invent a property feature.
Only use indexed/verified listing data.

---

# 34. “WHY THIS LISTING”

For each result, explain:
- what matched;
- what did not;
- which facts are landlord-provided;
- which are verified;
- which are tenant-confirmed.

Example:
✅ within budget
✅ pets allowed
✅ workspace
✅ 8 minutes to metro
✅ Wi-Fi confirmed by 16 renters
❌ no air conditioning

This is a major trust feature.

---

# 35. FACTUAL CONFIRMATION BY TENANTS

Distinguish:
“Landlord says”
vs
“Guests confirmed”.

Example:
“Wi-Fi available”
“94% of guests confirmed Wi-Fi”

This data must be earned from completed rentals.

Design a moderation/anti-gaming layer.

---

# 36. CHECK-IN / CHECK-OUT

Introduce a rental workflow.

Check-in:
- confirm presence;
- confirm access;
- confirm core property condition;
- report issue;
- attach photos.

Check-out:
- confirm departure;
- optionally upload photos;
- note issues.

Use timestamps and audit events.

Do not force users into unnecessary complexity.
Quick flow first, detailed evidence second.

---

# 37. PROPERTY CONDITION TIMELINE

Optional/encouraged:
- before check-in photos;
- after check-in photos;
- checkout photos.

Build a timeline:
- landlord upload;
- tenant upload;
- timestamp;
- booking association.

Useful for disputes.

The platform is not automatically the legal adjudicator.
It preserves evidence and offers a structured case workflow.

---

# 38. CASE / DISPUTE SYSTEM

Every important problem can create a case.

Categories:
- listing mismatch;
- access problem;
- cleanliness;
- damaged property;
- payment disagreement;
- communication issue;
- suspected fraud;
- cancellation;
- no-show;
- other.

Case includes:
- booking;
- participants;
- messages;
- photos;
- timestamps;
- system events;
- status;
- admin actions;
- resolution notes.

Statuses:
OPEN
UNDER_REVIEW
WAITING_FOR_PARTY
RESOLVED
CLOSED
ESCALATED

Need role-based admin tools.

Never let regular support staff silently alter evidence.

---

# 39. PROPERTY / LISTING FRESHNESS

Display:
- calendar updated;
- listing updated;
- photos updated;
- verification date.

Search can rank fresher listings higher where appropriate.

Prevent stale listings from dominating results.

Possible inactivity automation:
- remind landlord;
- reduce ranking;
- temporarily pause if sufficiently stale;
- NEVER delete without clear policy.

---

# 40. SEARCH

Search must support:
- city;
- district;
- map area;
- price;
- duration;
- date;
- property type;
- rooms;
- guests;
- pets;
- smoking;
- amenities;
- floor;
- accessibility;
- parking;
- verification;
- rating;
- short/medium/long term;
- instant booking;
- negotiation;
- company/private owner;
- exact/approximate location;
- natural language.

Mobile UX is first-class.

---

# 41. MAP SEARCH

Support:
- map/list split;
- clustering;
- bounds search;
- price markers where useful;
- filter persistence;
- fast loading;
- mobile gestures.

Do not overwhelm map with too much information.

---

# 42. LANDLORD DASHBOARD

Need:
- listings;
- listing status;
- calendar;
- bookings;
- conversations;
- offers;
- pricing;
- analytics;
- reviews;
- verification;
- balance/debt;
- payouts are NOT part of MVP rental flow;
- notifications;
- account settings;
- legal documents/forms;
- support/cases.

---

# 43. TENANT DASHBOARD

Need:
- saved listings;
- search history;
- bookings;
- requests;
- offers;
- conversations;
- reviews;
- profile;
- verification;
- trust;
- notifications;
- cases;
- preferences;
- Telegram settings.

---

# 44. ADMIN PANEL

Must exist in MVP.

Admin capabilities:
- users;
- listings;
- properties;
- verification queue;
- reports;
- chats requiring review;
- blocked content;
- cases/disputes;
- review moderation;
- account restrictions;
- debt status;
- system configuration;
- audit logs;
- feature flags;
- notification management.

Administrative actions MUST be auditable.

No “magic” direct DB edits for routine business operations.

---

# 45. MONETIZATION

Primary planned monetization:
- 5% landlord service fee after completed rental.

Possible future monetization:
- paid listing boost;
- subscriptions for professional landlords;
- sponsored placements;
- additional smart tools;
- inspection/verification services;
- B2B tools.

IMPORTANT:
Paid promotion must not corrupt objective trust ranking.

Separate:
- organic trust;
- sponsored placement.

---

# 46. REWARDS / LOTTERY IDEA

Original product idea:
- every completed honest transaction can generate a digital ticket;
- tickets could participate in promotions/lottery/rewards;
- aim is to make honest on-platform completion more attractive than bypassing the platform.

However:
DO NOT ship a real monetary lottery/reward mechanism merely because it sounds good.

First verify:
- Belarusian lottery/advertising/gambling rules;
- tax treatment;
- licensing/registration implications;
- eligible prizes;
- organizational requirements.

For MVP:
Use non-controversial gamification:
- reputation;
- achievements;
- trust levels;
- loyalty points only if legally reviewed.

Build a future-compatible Reward subsystem, but gate the actual prize/lottery mechanism behind a feature flag and legal approval.

---

# 47. ANTI-FRAUD

Need platform-wide anti-fraud.

Signals:
- repeated suspicious accounts;
- repeated device patterns;
- payment/contact abuse where applicable;
- fake listings;
- reused images;
- suspicious message patterns;
- unrealistic pricing;
- review rings;
- abnormal booking patterns;
- account links;
- repeated disputes;
- identity anomalies.

Do not rely on one score.
Create risk signals and case management.

Avoid discriminatory or opaque decisions.
Provide admin explanation.

---

# 48. SECURITY

Treat this as a production financial-adjacent marketplace even though rental payments are outside our platform in MVP.

Minimum:
- secure authentication;
- session management;
- rate limiting;
- CSRF/XSS protections;
- SQL injection protections;
- output encoding;
- secure headers;
- secrets management;
- encryption;
- audit logs;
- file upload protection;
- malware scanning where appropriate;
- access controls;
- admin 2FA;
- brute-force protection;
- account takeover detection;
- password hashing using modern secure algorithm;
- secure password reset;
- email verification;
- phone verification.

Identity/document access should be especially strict.

---

# 49. PRIVACY

Create a real privacy architecture.

Data categories:
- account data;
- profile data;
- property data;
- booking data;
- chat data;
- review data;
- verification documents;
- audit events;
- device/security metadata.

Need:
- data minimization;
- purpose limitation;
- access control;
- deletion/retention rules;
- export/deletion workflow where legally applicable;
- admin access logs;
- consent management where required.

Do not expose internal identifiers unnecessarily.

---

# 50. LEGAL RESEARCH REQUIREMENT

Before production launch, research current Belarusian requirements using authoritative sources.

At minimum investigate:
- online marketplace/intermediary model;
- consumer protection;
- personal data;
- processing identity documents;
- advertising;
- platform terms;
- rental/lease agreements;
- short-term accommodation;
- long-term rental;
- registration requirements;
- taxes for landlords;
- service fee taxation/accounting;
- electronic documents;
- digital communications evidence;
- reviews;
- moderation/liability for user-generated content;
- anti-fraud responsibilities;
- lottery/reward legality;
- map/geolocation privacy;
- Telegram integration;
- storage/processing location issues if applicable.

Use official/current sources wherever possible.

Produce:
`LEGAL_RISK_REGISTER.md`

For each topic:
- requirement;
- confidence;
- source;
- impact;
- product implication;
- open question;
- lawyer review required? yes/no.

Never state “legally safe” without evidence.

---

# 51. TECHNICAL ARCHITECTURE PRINCIPLES

You must choose the best stack based on the existing repository.

If a stack already exists:
- inspect it;
- keep stable architecture unless there is a compelling reason to change it.

Preferred principles:
- modular backend;
- clean domain boundaries;
- typed contracts;
- database migrations;
- event-driven side effects where useful;
- background workers for asynchronous tasks;
- object storage for media;
- Redis or equivalent for caching/rate limits/jobs where useful;
- search abstraction;
- map abstraction;
- messaging subsystem;
- notification subsystem;
- audit subsystem;
- verification subsystem.

Do not over-engineer MVP.

---

# 52. DATA MODEL

Design normalized relational entities for core concepts.

At minimum consider:
- User
- UserProfile
- Role
- Verification
- VerificationDocument
- Property
- PropertyAddress
- PropertyLocation
- PropertyPhoto
- Amenity
- PropertyAmenity
- PropertyRule
- PropertyPricingRule
- AvailabilityRule
- CalendarBlock
- Listing
- ListingVersion
- Booking
- BookingParticipant
- BookingOffer
- BookingAmendment
- BookingEvent
- CheckIn
- CheckOut
- Review
- ReviewDimension
- TrustScoreSnapshot
- Conversation
- ConversationParticipant
- Message
- MessageModerationEvent
- DisputeCase
- CaseEvent
- ServiceFee
- LandlordLedgerEntry
- Notification
- TelegramConnection
- AuditLog
- AdminAction
- FraudSignal
- SavedSearch
- Favorite
- Report

Do not blindly create every table.
Choose the right normalization and ownership model.

Use immutable/auditable records for:
- money/fees;
- booking history;
- verification history;
- admin actions;
- important status transitions.

---

# 53. SEARCH ARCHITECTURE

Search must eventually scale.

Start simple if needed.
Potential technologies:
- PostgreSQL full text;
- PostGIS;
- search index such as OpenSearch/Elasticsearch if justified.

Do not introduce a search cluster just because it sounds sophisticated.
Choose based on actual scale and complexity.

Need:
- typo tolerance;
- filtering;
- geo search;
- ranking;
- freshness;
- verification;
- trust;
- price;
- availability.

---

# 54. FILE STORAGE

Property photos and identity documents must not live in the same unrestricted bucket.

Separate:
- public-ish listing media;
- private identity documents;
- private evidence files.

Use signed URLs / controlled access where appropriate.

---

# 55. NOTIFICATION ARCHITECTURE

Support:
- in-app;
- email;
- Telegram.

Do not hardcode notifications inside every domain service.
Use a notification abstraction/event layer.

Need:
- preferences;
- templates;
- localization;
- retries;
- idempotency;
- delivery status;
- deduplication.

---

# 56. AUDIT LOGGING

Critical events require audit logs:
- login/security changes;
- verification decisions;
- listing publication;
- listing modifications;
- booking status changes;
- offer changes;
- fee creation;
- debt changes;
- dispute actions;
- moderation;
- admin changes;
- contact-blocking decisions where appropriate.

Logs must be tamper-resistant enough for operational use and include:
- actor;
- target;
- action;
- timestamp;
- source;
- before/after or relevant diff;
- correlation ID.

---

# 57. UX PRINCIPLES

The platform must be:
- mobile-first;
- fast;
- simple for one-property landlords;
- powerful for professional landlords;
- understandable for non-technical users;
- localized to Belarus;
- transparent about costs;
- transparent about verification;
- transparent about booking status.

Avoid clutter.

Use progressive disclosure.

Do not force professional-level controls on casual users.

---

# 58. DESIGN LANGUAGE

Aim for:
- trustworthy;
- modern;
- calm;
- clean;
- practical;
- locally appropriate.

Do not copy Airbnb branding/UI.

Create original information architecture and visual identity.

---

# 59. SEO

Plan for:
- city pages;
- district pages;
- property pages;
- long-tail queries;
- structured data;
- canonical URLs;
- sitemap;
- robots;
- metadata;
- Open Graph;
- indexability controls;
- server-side rendering where appropriate.

Do not expose private profile/booking content to search engines.

---

# 60. PERFORMANCE

Targets:
- fast first load;
- optimized images;
- lazy loading;
- caching;
- CDN;
- database indexes;
- pagination;
- efficient map queries;
- debounced search;
- background processing.

Do not render huge result sets on mobile.

---

# 61. OBSERVABILITY

Production must have:
- structured logs;
- metrics;
- traces where useful;
- health endpoints;
- error tracking;
- alerts;
- background job monitoring;
- database health monitoring.

Critical business metrics:
- listings created;
- verified listings;
- booking requests;
- completed rentals;
- cancellation rates;
- response time;
- review completion;
- debt;
- active users;
- conversion;
- fraud cases.

---

# 62. TESTING

This is mandatory.

Test layers:
- unit;
- integration;
- API;
- database;
- authorization;
- end-to-end;
- frontend critical flows;
- mobile viewport;
- messaging;
- booking state machine;
- fee ledger;
- verification;
- reviews;
- anti-off-platform;
- Telegram notifications;
- admin workflows.

Critical scenarios must have automated tests.

Create adversarial tests for:
- double booking;
- race conditions;
- duplicate completion;
- duplicate fee;
- repeated review;
- fake contact info;
- permission escalation;
- stale calendar;
- booking cancellation edge cases;
- debt manipulation;
- malicious uploads;
- account takeover;
- replay requests.

---

# 63. IDEMPOTENCY / CONCURRENCY

Any endpoint that can be retried must be safe where appropriate.

Especially:
- booking creation;
- offer creation;
- booking acceptance;
- completion confirmation;
- fee creation;
- notifications;
- Telegram events.

Prevent double-booking under concurrent requests.

Use transactions/constraints appropriately.

---

# 64. FEATURE FLAGS

Use feature flags for:
- rewards;
- AI features;
- smart pricing;
- advanced verification;
- contact release;
- experiments;
- new ranking logic.

Feature flags must not become a dumping ground.
Document each flag.

---

# 65. ADMIN SAFETY

Admin UI must distinguish:
- read;
- moderation;
- verification;
- financial/fee operations;
- account suspension;
- system configuration.

Sensitive admin actions require:
- strong authentication;
- audit;
- possibly confirmation;
- reason field.

---

# 66. ERROR HANDLING

Every user-facing failure should:
- be understandable;
- avoid leaking internals;
- preserve user input where possible;
- provide next action;
- generate useful logs.

Do not show raw stack traces to users.

---

# 67. ACCESSIBILITY

Target a strong baseline:
- keyboard navigation;
- labels;
- semantic HTML;
- screen-reader support;
- contrast;
- focus states;
- form errors;
- mobile touch targets.

---

# 68. MOBILE-FIRST

Do not build desktop first and “adapt later”.

Critical mobile flows:
- search;
- map;
- listing;
- booking;
- chat;
- calendar;
- check-in;
- review;
- owner dashboard.

---

# 69. MVP PRIORITY

MVP MUST focus on:
1. auth;
2. profiles;
3. listing creation;
4. listing moderation;
5. map;
6. search/filter;
7. availability;
8. booking/request flow;
9. internal chat;
10. reviews;
11. verification levels;
12. landlord fee/debt ledger;
13. admin;
14. notifications;
15. basic Telegram notifications;
16. audit;
17. security;
18. privacy baseline;
19. SEO baseline;
20. legal documentation placeholders.

Do not delay launch for sophisticated AI.

---

# 70. POST-MVP

Phase 2:
- AI natural-language search;
- Rental DNA;
- smarter pricing;
- iCal sync;
- advanced fraud scoring;
- enhanced verification;
- photo authenticity;
- richer analytics;
- rewards infrastructure;
- loyalty features.

Phase 3:
- legally approved rewards/lottery mechanics;
- professional landlord subscriptions;
- advanced pricing automation;
- B2B tools;
- additional countries/languages.

---

# 71. CORE PRODUCT PRINCIPLES

When requirements conflict, prefer:

1. Legal safety.
2. User trust.
3. Security/privacy.
4. Correctness.
5. Simplicity.
6. Performance.
7. Flexibility.
8. Revenue optimization.

Never sacrifice legal/privacy/security just to launch faster.

---

# 72. WHAT CODEX MUST DO FIRST

Before writing code:

## STEP 1 — REPOSITORY AUDIT

Inspect:
- all directories;
- package manifests;
- frontend;
- backend;
- database;
- Docker;
- CI/CD;
- environment files;
- infrastructure;
- existing tests;
- docs;
- previous audits;
- TODOs;
- known broken features.

Do not assume the repository is correct.

Create:
`REPO_AUDIT.md`

Include:
- architecture;
- strengths;
- weaknesses;
- broken areas;
- security concerns;
- technical debt;
- missing components;
- recommended architecture.

## STEP 2 — BUILD PRODUCT TRACEABILITY

Create:
`PRODUCT_REQUIREMENTS.md`

Convert this prompt into:
- requirements;
- acceptance criteria;
- dependencies;
- priorities;
- implementation status.

Every major requirement gets an ID.

Example:
AUTH-001
LIST-001
BOOK-001
CHAT-001
REV-001
VERIFY-001
FEE-001
TRUST-001
ADMIN-001
LEGAL-001

## STEP 3 — ARCHITECTURE

Create:
`ARCHITECTURE.md`

Include:
- system diagram;
- domain boundaries;
- data flows;
- state machines;
- security boundaries;
- integrations;
- queues/jobs;
- storage;
- deployment model.

## STEP 4 — PRODUCT FLOWS

Create:
`USER_FLOWS.md`

Document:
- tenant flow;
- landlord flow;
- admin flow;
- booking;
- cancellation;
- completion;
- review;
- verification;
- debt;
- dispute;
- Telegram linking.

## STEP 5 — DATABASE DESIGN

Create:
`DATABASE_DESIGN.md`

Include:
- entities;
- relations;
- constraints;
- indexes;
- status enums;
- audit data;
- immutability rules.

## STEP 6 — LEGAL RISK REGISTER

Create:
`LEGAL_RISK_REGISTER.md`

Research current authoritative Belarusian sources.

## STEP 7 — IMPLEMENTATION PLAN

Create:
`IMPLEMENTATION_PLAN.md`

Break into:
- Phase 0 foundation;
- Phase 1 MVP;
- Phase 2 post-MVP;
- Phase 3 advanced features.

Every task needs:
- requirement IDs;
- dependencies;
- expected files/modules;
- acceptance criteria;
- tests.

---

# 73. HOW CODEX MUST WORK AFTER PLANNING

Do not stop after producing documentation.

Proceed to implementation.

For each domain:
1. inspect;
2. design;
3. implement;
4. test;
5. audit;
6. fix;
7. document.

Do not move to the next major domain with known critical defects unresolved.

---

# 74. “BEST DECISION” PROTOCOL

When a decision is not explicitly defined:

1. Identify the ambiguity.
2. List 2–4 viable solutions internally.
3. Compare:
   - legal risk;
   - security;
   - UX;
   - maintainability;
   - performance;
   - cost;
   - extensibility.
4. Choose the best.
5. Record the decision in:
   `DECISIONS.md`

Use a stable format:
- Decision ID;
- Question;
- Options;
- Chosen solution;
- Why;
- Consequences;
- Revisit trigger.

Do not constantly ask for trivial clarification.
Make expert decisions and document them.

Only ask the user when:
- a decision has major irreversible business/legal consequences;
- multiple options are equally valid and materially different;
- missing information blocks implementation.

---

# 75. NO FAKE COMPLETION

Never claim:
- “implemented” if only mocked;
- “secure” if not tested;
- “legally compliant” without legal evidence;
- “production-ready” without audit;
- “verified” without actual verification.

Maintain explicit statuses:
- NOT STARTED
- IN PROGRESS
- IMPLEMENTED
- TESTED
- AUDITED
- BLOCKED

---

# 76. QUALITY GATE BEFORE CALLING MVP COMPLETE

MVP cannot be considered complete until:

- core user journeys work end-to-end;
- database migrations work from clean state;
- tests pass;
- critical security checks pass;
- authorization tests pass;
- no critical booking race condition known;
- no duplicate fee creation;
- no broken debt logic;
- reviews only available after completed rentals;
- contact blocking tested;
- admin flows tested;
- audit logs work;
- Telegram notification flow works;
- mobile UX reviewed;
- SEO baseline exists;
- error tracking exists;
- backup/recovery strategy documented;
- legal risk register exists;
- deployment reproducible;
- environment/configuration documented.

Create:
`MVP_RELEASE_CHECKLIST.md`

---

# 77. FINAL AUDIT

Before declaring success, perform an independent audit pass.

Review the product as:
1. tenant;
2. landlord;
3. administrator;
4. attacker;
5. fraudster;
6. mobile user;
7. first-time user;
8. professional landlord;
9. long-term tenant;
10. short-term tourist.

Then create:
`FINAL_PRODUCT_AUDIT.md`

Include:
- what works;
- what does not;
- risks;
- technical debt;
- legal open questions;
- user-experience problems;
- security findings;
- next priorities.

---

# 78. DELIVERABLES

At minimum maintain:
- README.md
- REPO_AUDIT.md
- PRODUCT_REQUIREMENTS.md
- ARCHITECTURE.md
- USER_FLOWS.md
- DATABASE_DESIGN.md
- LEGAL_RISK_REGISTER.md
- IMPLEMENTATION_PLAN.md
- DECISIONS.md
- SECURITY.md
- PRIVACY.md
- MVP_RELEASE_CHECKLIST.md
- FINAL_PRODUCT_AUDIT.md

Add other documents as needed.

---

# 79. COMMUNICATION STYLE

When reporting progress:
- be concise but factual;
- report actual completed work;
- mention blockers;
- mention important trade-offs;
- show what was tested.

Do not produce fake confidence.

At milestone completion provide:
- completed;
- tested;
- remaining;
- risk.

---

# 80. FINAL PRODUCT OUTCOME

The final platform should feel like:

> A modern Belarusian rental platform where finding housing, verifying the person/property, understanding the true price, communicating, booking, documenting the stay, reviewing the experience, and building reputation are all part of one coherent system.

The platform should support both:
- a person renting one apartment for one night;
- and a professional landlord managing dozens of apartments.

The platform should be flexible rather than forcing one rental model.

The core differentiator is TRUST + TRANSPARENCY + FLEXIBILITY.

Do not clone Airbnb.
Use the best ideas from the global market, learn from their user pain points, and build a better system for Belarus.

---

# 81. FIRST COMMAND / FIRST ACTION

Before modifying the repository, perform a complete repository inspection.

Then create:
1. REPO_AUDIT.md
2. PRODUCT_REQUIREMENTS.md
3. ARCHITECTURE.md
4. DECISIONS.md
5. IMPLEMENTATION_PLAN.md

Only then start implementation.

Do not delete working functionality without evidence that replacement is safer/better.

Do not rewrite the whole project merely because a different stack is fashionable.

Be an owner of the result, not a code generator.
