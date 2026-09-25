# Правовые вопросы

Открытые правовые вопросы (LEGAL-001…018) и то, как каждый из них ограничивает код. Раньше LEGAL_RISK_REGISTER.md и LEGAL_DEPENDENCIES.md. Ничто здесь не является юридическим заключением.

## Содержание

- Реестр правовых вопросов
- Что из этого следует для кода

---

## Реестр правовых вопросов

### Read this first

**No legal research was performed for this register, and it contains no citations to Belarusian law.** Every entry below is an *engineering-identified open question*, not a legal finding.

This is deliberate. The specification says "Never state 'legally safe' without evidence" (§50) and "Do not assume that the above business model automatically eliminates all legal obligations" (§2). A register full of confident paraphrases of statutes I have not verified would be worse than an empty one: it would look like due diligence and would be relied upon as such. Producing plausible-sounding legal claims about a jurisdiction without consulting authoritative sources is the single most dangerous thing this document could do.

**Confidence on every entry below is therefore `NONE — engineering assumption only`.** Each requires a Belarus-qualified lawyer, and several also require an accountant.

What this register *is* good for: it names the questions precisely, records the product decision currently riding on each one, and states what would have to change if the answer is unfavourable. That makes the lawyer's engagement cheap and specific instead of open-ended.

**Status of LEGAL-003 (Belarus legal verification): BLOCKED.**

---

### How to read an entry

| Field | Meaning |
|---|---|
| **Question** | The precise thing that must be answered |
| **Product decision riding on it** | What the code currently assumes |
| **If unfavourable** | What would have to change |
| **Confidence** | `NONE` throughout — see above |
| **Lawyer review required** | Yes for all; accountant flagged where relevant |

---

#### LEGAL-001 — Intermediary vs. party to the lease

**Question.** Does operating this marketplace make the company a party to, or a legally responsible intermediary in, the rental relationship — and what consumer-protection duties follow?

**Product decision riding on it.** The platform is modelled strictly as an intermediary: it never receives rent, never holds tenant funds, never acts as escrow. `DECISIONS.md` and the data model contain no concept of a platform-held balance for rent.

**If unfavourable.** Terms of service, liability disclosures, and possibly the fee model would need restructuring. The architecture supports it — no rent ever flows through the system, so there is nothing to unwind.

**Lawyer:** yes.

---

#### LEGAL-002 — The 5% service fee: legal character, invoicing, VAT, accounting

**Question.** Is a percentage-based service fee charged to a landlord after a completed rental correctly characterised as a service fee? What invoicing and VAT treatment applies? How must it be recognised in accounting? Does charging a private individual (not a business) change anything?

**Product decision riding on it.** `service_fee` + `ledger_entry` model the fee as a payable debt, with all inputs stored so any figure can be re-derived and audited. `bps` is per-booking, so a different rate or a rate that varies by counterparty type is a data change, not a schema change.

**If unfavourable.** Invoice generation, VAT lines and possibly a different fee structure. The immutable ledger is designed to survive this — corrections are new rows.

**Lawyer:** yes. **Accountant:** yes.

---

#### LEGAL-003 — Personal data: legal basis, consent, storage location, cross-border transfer

**Question.** What legal basis is required to process account, booking, chat and device data? Are consent records required, and in what form? Must personal data of Belarusian users be stored in Belarus? What are the rules on transfer abroad — which directly constrains hosting choices?

**Product decision riding on it.** Data minimisation is built in (IP addresses hashed, not stored raw; audit rows carry diffs rather than full snapshots). No hosting region has been chosen precisely because this answer determines it.

**If unfavourable.** Hosting region, backup location and sub-processor list. **This must be answered before infrastructure is provisioned** — moving a production database across a border later is expensive and legally exposed.

**Lawyer:** yes. **Blocks:** production hosting decision.

---

#### LEGAL-004 — Identity documents (passport data) and property-ownership documents

**Status as of 0018: the identity-document half is retired, not merely gated.** The user made an explicit product call: passport/ID collection is removed from this product outright, on the reasoning that in Belarus a mobile phone number is already tied to its owner at the point of sale by the operator, so proving control of a real, phone-backed messenger account (Telegram, VK or WhatsApp) is treated as the equivalent identity signal — without this platform ever asking for, receiving or storing a passport image. This is **the user's own product decision, stated to me directly, not a legal finding** — everything else in this register's epistemic posture (see "Read this first" above) still applies: no legal research was performed, and this paragraph is not a substitute for one.

**Question, narrowed to what is now actually live.** Two separable things used to share one flag; they no longer do, and the open legal question is now only about the second:

1. ~~Passport/ID images and selfies for identity verification~~ — **removed from the product.** `VerificationService.submit()` refuses every new `targetLevel: 1` (IDENTITY) request outright (`FEATURE_DISABLED`), `evidenceSufficiency()` in `domain/verification.ts` can never find an IDENTITY-kind request sufficient regardless of what evidence it carries, and the document-type enum on `POST /me/verification/:id/documents` no longer accepts `PASSPORT`/`ID_CARD`/`SELFIE`. Level 1 is now granted automatically and without staff review the moment a phone is verified — see the phone-verification sub-entry below.
2. **Property-ownership documents (ownership certificate, power of attorney, utility bill) for a Level 2 request — still live, and this is what remains open.** Same question as before: is explicit consent needed, is there a mandatory retention limit, are additional security measures required. The user's stated view is that this category carries no legal issue ("с этим никаких юр проблем нету") — again, the user's own assessment, not a legal opinion this register can vouch for. The flag that gates it, `feature_flag.verification.property_documents` (renamed from `verification.identity_documents` in migration `0018_phone_verification.sql`, which also flips it to `enabled = true`), is ON in this codebase on the strength of that instruction alone.

**Product decision riding on it (documents, still applicable to property documents).** Documents are in a separate private bucket, reachable only by the `VERIFIER` role, with every read written to an append-only `document_access_log`, and a per-document `purge_after` making the retention policy a stored value rather than an implicit convention. None of this infrastructure changed in 0018 — only which category of document it is allowed to hold.

**If unfavourable (property documents).** Retention windows change (a data change), or verification moves to a licensed provider (the schema already isolates documents behind a request abstraction), or the flag is switched back off — a one-row change, not a rewrite.

**Where this now lives in code.**

| Place | What it does today |
|---|---|
| `feature_flag.verification.property_documents` | **On**, per the user's explicit instruction. Renamed + flipped by migration 0018 (was `verification.identity_documents`, off). |
| `VerificationService.submit()` | Refuses `targetLevel: 1` unconditionally, before any other check. |
| `VerificationService.attachDocument` | Only ever reached for PROPERTY_OWNERSHIP requests now. Refuses with `FEATURE_DISABLED` while the flag is off, and with `NOT_IMPLEMENTED` when no private bucket is configured — that second gate is UNCHANGED and still refuses everything, because `DOCUMENTS_BUCKET_URL` remains unconfigured (see below). |
| `evidenceSufficiency()` in `domain/verification.ts` | IDENTITY: always insufficient, no matter the inputs. PROPERTY_OWNERSHIP: sufficient once a property document and a declared ownership basis exist and the flag above is on. |
| `NotificationService.beginPhoneVerification` / `completePhoneVerification{Telegram,Vk,Whatsapp}` | The new Level-1 path — see the phone-verification sub-entry below. |
| `GET /admin/verification/documents/:id` | Unchanged. `document.read` (VERIFIER alone), a stated purpose, and an append-only `document_access_log` row written before the key is returned. |
| `verification_document_is_private` CHECK (0012) | Unchanged. A document row cannot exist outside the `private/` namespace, which the public media route refuses to serve. |
| `verification_document.purge_after` | Unchanged: left NULL on attachment, since no retention window has been chosen by anyone with authority to choose it. |
| `POST /admin/retention/run` | Unchanged. Refuses every document twice over: `purge_after` is NULL, and no object store is configured either. |
| `legal_hold` | Unchanged. |

**What turning the flag on did NOT do.** There is still no private object storage configured anywhere (`DOCUMENTS_BUCKET_URL` is unset in every environment this product runs in). `attachDocument` therefore still refuses every real attempt with `NOT_IMPLEMENTED`, flag or no flag — the two gates fail closed independently, exactly as before 0018. Enabling the flag reflects the user's product decision about the legal *question*; it does not, by itself, make document collection actually work, because nowhere lawful exists to put a document yet.

---

##### Phone verification as the identity signal (0018; Telegram-only since 0021) — its own, separate open questions

**Question.** Verifying "controls a Telegram account" as a proxy for identity is a product decision, not a settled legal one. What actually needs asking: does relying on a third-party messenger's own phone-verification as this platform's identity signal carry any disclosure obligation, and does routing a Belarusian user's verification through Telegram raise the same cross-border personal-data question LEGAL-003 and LEGAL-015 already ask about Telegram notifications.

**Telegram hands this platform the account's real phone number** (via `request_contact`), already verified by Telegram itself. Strong proof — the whole reason it is now the sole channel (see below).

**Product decision riding on it.** `app_user.phone_verified_at` + `phone_verified_via` record when the phone was verified; `phone_verified_via` now accepts only `'TELEGRAM'`.

**VK and WhatsApp were dropped (0021), not merely deprioritised.** VK's community-bot Callback API never proved a phone number in the first place — only "controls this VK account" — so removing it loses a comparatively weak signal, not capability. WhatsApp's official Cloud API did prove a real number, at the cost of requiring the operator to complete Meta Business/WhatsApp Business Platform verification (a real KYC process) before it worked at all; dropping it removes that setup burden and a second webhook surface, leaving Telegram — which already supplied the strongest proof of the three — as the one channel. `vk_connection` (the table LEGAL-004's earlier version of this section referenced) no longer exists; migration 0019 dropped it and narrowed the `phone_verified_via` CHECK constraint accordingly. The earlier note about `whatsapp-web.js`/Baileys being deliberately rejected in favour of the official Cloud API is now moot along with the feature itself — there is no WhatsApp integration of any kind to weigh an unofficial-vs-official choice for.

**If unfavourable.** `TELEGRAM_BOT_TOKEN` unset ⇒ phone verification is not offered at all — see `router.ts`'s phone gate, which stops applying to anyone when it is unconfigured, so a misconfigured deployment fails open rather than locking every user out.

**Lawyer:** yes, on both halves above — the property-document question (item 2), and whether phone-verification-via-Telegram needs its own disclosure or carries LEGAL-003/LEGAL-015's cross-border question. Passport collection itself is no longer a live question for this product; it was removed, not merely deferred.

---

#### LEGAL-005 — Landlord tax obligations and platform reporting duties

**Question.** What are a landlord's tax/registration obligations for rental income in Belarus? Does the platform have any duty to inform, withhold or report? Does the answer differ for private individuals, sole traders and companies?

**Product decision riding on it.** None currently — the platform neither reports nor advises. `app_user.account_kind` distinguishes private from company accounts, so differential handling is possible.

**If unfavourable.** Reporting exports, landlord tax notices, possibly mandatory identification before publishing.

**Lawyer:** yes. **Accountant:** yes.

---

#### LEGAL-006 — Short-term vs long-term rental: distinct regimes

**Question.** Does Belarusian law distinguish short-term/daily accommodation from long-term residential tenancy in ways that impose different duties — registration, permits, guest reporting, safety requirements? Does a platform facilitating both need to treat them differently?

**Product decision riding on it.** The product deliberately does *not* force listings into short- or long-term categories (spec §6); a single listing may span 1 night to 3 years.

**If unfavourable.** Duration bands may need distinct flows, disclosures or eligibility rules. `min_nights`/`max_nights` make the bands expressible without redesign.

**Lawyer:** yes.

---

#### LEGAL-007 — Guest registration / residence-reporting duties

**Question.** Is there an obligation to register guests or report temporary residence, particularly for foreign nationals? Does it fall on the landlord, the platform, or both?

**Product decision riding on it.** None. The platform collects no data specifically for this purpose — a deliberate data-minimisation choice that would have to be revisited rather than assumed.

**If unfavourable.** Additional collection at booking, with its own legal basis under LEGAL-003.

**Lawyer:** yes.

---

#### LEGAL-008 — Liability for user-generated content

**Question.** What liability does the platform bear for listings, reviews and chat messages? Are there notice-and-takedown duties, response deadlines, or record-keeping requirements?

**Product decision riding on it.** Pre-publication moderation for listings; a `report` queue; append-only moderation events preserving what was decided and why.

**If unfavourable.** Response-time SLAs and a formal takedown workflow. The audit trail already supports proving what was done and when.

**Lawyer:** yes.

---

#### LEGAL-009 — Reviews and reputation

**Question.** Are there legal constraints on publishing reviews about named individuals — defamation exposure, a right of reply, correction or deletion duties? Does a computed "trust score" about a natural person create additional obligations (e.g. rules on automated evaluation of individuals)?

**Product decision riding on it.** Reviews are tied to completed bookings, one per side, with moderation states and tracked edits. The trust score is specified to be documented and explainable rather than an opaque number.

**If unfavourable.** Right-of-reply UI, stricter moderation, or a materially simpler public score.

**Lawyer:** yes.

---

#### LEGAL-010 — Chat interception and contact filtering

**Question.** Does automatically scanning, flagging and redacting private messages between users require specific disclosure or consent? Are there restrictions on retaining the original unredacted text?

**Product decision riding on it.** `message.body_original` retains untouched text for moderation and evidence; `message_moderation_event` records detector output. The filter's user-facing message states plainly that contacts are hidden until confirmation.

**If unfavourable.** Consent at registration, clearer in-product disclosure, or shorter retention of originals.

**Lawyer:** yes.

---

#### LEGAL-011 — Electronic records as evidence

**Question.** What weight do platform-held records — booking events, chat logs, check-in photos, audit entries — carry in a Belarusian dispute? Are there requirements (timestamping, signatures, integrity proofs) to make them admissible?

**Product decision riding on it.** Append-only tables, content hashes on snapshots and photos, correlation ids. This is deliberately more than "good logging" because the evidence trail is a core product promise.

**If unfavourable.** Cryptographic timestamping or third-party notarisation. The hash columns give a place to anchor it.

**Lawyer:** yes.

---

#### LEGAL-012 — Rewards / lottery — **highest-risk item**

**Question.** Would issuing tickets for completed rentals that enter a prize draw constitute a lottery or gambling activity under Belarusian law? What licensing, registration, tax and advertising obligations follow? Which prize types, if any, avoid the regime?

**Product decision riding on it.** **Not shipped.** Per DEC-015 there is a `feature_flag` row with `requires_legal_approval = true` and **no prize-drawing logic exists in the codebase**. MVP gamification is limited to reputation, achievements and trust levels.

**If unfavourable.** Nothing to unwind — this is exactly why it was gated rather than built.

**Lawyer:** yes. **Do not enable under any circumstances without written legal approval.**

---

#### LEGAL-013 — Advertising and paid promotion

**Question.** What rules govern advertising claims, and must sponsored placements be labelled as advertising?

**Product decision riding on it.** Monetisation beyond the service fee is out of scope for MVP. The architecture separates organic trust ranking from paid placement (spec §45), which makes labelling straightforward.

**Lawyer:** yes, before any paid placement ships.

---

#### LEGAL-014 — Map data and geolocation privacy

**Question.** Are there restrictions on displaying property locations, on the mapping providers usable in Belarus, or on precision of location data for residential addresses?

**Product decision riding on it.** Approximate location by default, with a deterministic public offset; exact address released only from `CONFIRMED`.

**Now user-facing.** The map panel (`src/ui/map-panel.tsx`) renders real OpenStreetMap tiles via Leaflet — the user's own explicit, direct choice of provider, not one made silently. Concretely: every visitor's browser fetches tiles straight from `*.tile.openstreetmap.org`, so OSM's own servers see that visitor's IP address for each map view, the same way any third-party `<img>` host would. No personal data beyond the already-blurred public coordinate is sent — the exact address still never reaches the client before `CONFIRMED` — but the tile requests themselves are a new third party in the request path that was not there while the panel was a static placeholder. This is the concrete provider choice the question above is actually about now, rather than an abstract "provider TBD".

**Extended for geocoding (DEC-077).** `src/app/api/geocode/route.ts` sends a HOST'S TYPED ADDRESS TEXT — not just a coordinate — to OpenStreetMap's Nominatim search API (`nominatim.openstreetmap.org`), so the listing wizard can pre-fill the location pin instead of a host always dragging one from scratch. This is a different, and larger, data flow than the tile fetches above: a street and house number is more identifying than a blurred public coordinate, even though it never reaches this route from anywhere but an already-authenticated host describing their OWN listing (the route requires a session), and is discarded rather than stored — the coordinate the host confirms on the map is what gets saved, not the address string. The call is server-to-server (this Next.js route calls Nominatim, the visitor's browser never does), so no visitor IP is exposed to OSM the way tile requests expose it above; the address text itself is the thing newly leaving this system. Flagged explicitly, the same way the tile-provider choice above was, rather than treated as already covered by that earlier decision just because both are OSM services.

**Lawyer:** yes — specifically, whether routing every visitor's IP to OpenStreetMap's tile infrastructure needs disclosure in the privacy policy, whether OSM's tile usage policy is compatible with expected production traffic (their standard tile servers are meant for light use; a self-hosted or paid tile provider may be the right call before this scales), and now also whether sending a host's typed street address to Nominatim needs its own privacy-policy disclosure alongside the tile one.

---

#### LEGAL-015 — Telegram integration

**Question.** Any restriction on using Telegram as a notification channel, and does sending booking data through it constitute a cross-border transfer of personal data (see LEGAL-003)?

**Product decision riding on it.** Telegram is optional, opt-in per category, and carries notifications only — the canonical conversation never leaves the platform. Notification payloads should be kept minimal for this reason.

**If unfavourable.** Drop the channel, or reduce payloads to content-free "you have a new message" pings.

**Lawyer:** yes.

---

#### LEGAL-016 — Terms of service and the contractual chain

**Question.** What must the platform's terms contain to establish the fee obligation, define the intermediary role, and set dispute-handling rules? Is a Belarusian-language version legally required?

**Product decision riding on it.** The fee is treated as a contractual debt arising on completion. **This is the assumption the entire revenue model rests on** and it is currently unverified.

**If unfavourable.** The fee may be unenforceable as modelled. The ledger design tolerates waiving or writing off historical fees without rewriting records.

**Now user-facing.** `/dashboard/finance` shows a landlord the accrual, the arithmetic and the word «задолженность». That does not change the legal position, and no new dependency arises from it, but it does mean the assumption is now visible to users rather than only present in the schema. The page is worded as a record of what the platform has charged, never as a completed transaction, and states plainly that no payment method is connected. Restrictions are still gated behind the `fee.enforcement` flag, so with the flag off a landlord sees the number and loses nothing.

**Lawyer:** yes — draft, not merely review. The wording on `/dashboard/finance` should be reviewed together with the terms, since it is the text a landlord actually reads when a debt appears.

---

#### LEGAL-017 — Handling complaints between users, and what to keep

**Question.** Кватэрка.by now records complaints between users, staff notes about them, and decisions that change whether a fee is owed. Three things follow that a Belarusian lawyer has to answer. First: does running this process create any obligation the platform does not intend — a consumer-complaint duty, a mediation role, a reporting duty for what users allege about each other? Second: what may be retained, and for how long? Dispute cases, case events and audit rows are append-only and currently never deleted, which is right for accountability and is exactly the shape a data-protection regime tends to have opinions about. Third: a case necessarily contains one user's allegations about another, held indefinitely, which is a category of record that usually has rules of its own.

**Product decision riding on it.** The console exists and is used internally. Nothing in it is described to users as arbitration: the wording is «рассмотрение обращения», «решение по обращению» and «внутренняя проверка» throughout, and the screen says in plain words that there is no automated resolution. The platform states an outcome for its own fee, not a determination of the parties' rights against each other.

**If unfavourable.** Retention limits would mean purging or anonymising closed cases on a schedule. The append-only design makes that a deliberate, auditable operation rather than a silent one. A finding that the process itself creates obligations would be a wording and workflow question, not a schema one.

**What the retention slice changed here.** A `legal_hold` can now be placed on a case, so a case under investigation is protected from any future purge by an explicit, audited record rather than by nothing existing yet. **No dispute purge or anonymisation was built**, deliberately: this entry is unanswered, and building a destruction path for allegations one user made about another before knowing what may be kept would be exactly backwards. `dispute_case` and `case_event` are in the retention catalogue as KEEP_AS_AUDIT with the window marked UNKNOWN and pointing here.

**Confidence.** Low. Not researched.

**Lawyer:** yes — together with LEGAL-016, since the fee decision and the complaint process are the same act seen from two sides.

---

#### LEGAL-018 — Retention for data no other entry covers

**Question.** Building the retention catalogue forced a per-table answer for all forty tables, and four turned out to be covered by no existing entry. First: **check-in and check-out photographs** (`stay_photo`) — images of somebody's home, sometimes with possessions and occasionally people in them, kept as dispute evidence with no stated limit. Second: **listing data after delisting** (`property`, `property_photo`) — an address, coordinates and photographs of a home that is no longer offered. Third: **reviews** — LEGAL-009 asks whether they may be published and whether there is a correction duty, but not how long they are kept, nor what happens to one written by somebody who has closed their account. Fourth, and the broadest: **does a deletion right reach append-only records at all** — `ledger_entry`, `audit_log`, `booking_event`, `listing_snapshot`? SECURITY.md has proposed since the first commit that the answer is anonymisation of the linked person rather than destruction of the record, and that proposal has never had a register entry or a lawyer.

**Product decision riding on it.** The catalogue in `domain/retention.ts` declares each of these with an UNKNOWN window naming this entry, and the purge job acts on none of them. `listing_snapshot` is the sharpest: it is a frozen JSON blob holding a description, exact coordinates and an apartment number, with no separable columns — so if erasure ever reaches it, there is nothing to anonymise and the only options are destroying dispute evidence or a bespoke migration.

**If unfavourable.** Windows would need to be set for the first three, which is configuration. The fourth could require redesigning how evidence snapshots are stored, which is not.

**Confidence.** None. Not researched. Raised because writing the catalogue made the gaps visible, not because anything is known about them.

**Lawyer:** yes — naturally alongside LEGAL-003 and LEGAL-011.

---

### Summary

| Item | Blocks |
|---|---|
| LEGAL-003 | Choice of hosting region — answer before provisioning infrastructure |
| LEGAL-004 | Launching property-document verification (identity verification via passport is retired, not blocked); whether phone-verification-via-messenger needs its own disclosure |
| LEGAL-012 | Any rewards feature — currently gated and safe |
| LEGAL-016 | Charging the service fee at all |
| LEGAL-002, 005 | Invoicing and accounting setup |
| LEGAL-003 | Erasure of personal data — closure ships, erasure does not |
| LEGAL-017 | Any purge or anonymisation of dispute records |
| LEGAL-018 | Retention for stay photos, delisted listings, reviews, and whether erasure reaches append-only records |

**Nothing in this product may be described as legally compliant on the basis of this document.**

---

## Что из этого следует для кода

How unresolved legal questions map onto engineering work: what is safe to build **now**, what is deliberately gated, and what cannot ship until a Belarus-qualified lawyer answers.

This is the operational companion to [docs/LEGAL.md](LEGAL.md), which states the questions. Nothing here is a legal conclusion. Every "current assumption" is an engineering placeholder chosen so that being wrong costs a configuration change rather than a rewrite.

**Principle applied throughout:** where the law is unknown, the *architecture* stays neutral and the *behaviour* is a flag. No disputed position is hardcoded.

---

### LEGAL-003 — Personal data: legal basis, residency, cross-border transfer

**Why it matters.** Determines where the database may physically live. Moving a production database across a border afterwards is expensive and legally exposed.

**Current assumption.** Data minimisation applied unconditionally, since it is defensible under any regime: IP addresses stored only as SHA-256 (`user_session.ip_hash`, `audit_log.ip_hash`), audit rows carry diffs rather than snapshots, session tokens stored hashed.

**Built now.** Everything except the hosting decision. `DATABASE_URL` is configuration, so the region is a deployment choice, not a code change.

**Requires a lawyer.** Storage location, consent records, retention periods, sub-processor list.

**Blocks:** provisioning production infrastructure. Do not sign a hosting contract before this is answered.

---

### LEGAL-004 — Identity documents

**Why it matters.** Passport images are the most sensitive data in the product.

**Current assumption.** Collection is **off**. Feature flag `verification.identity_documents` defaults to `false`.

**Built now and enforced:**
- separate private bucket (`DOCUMENTS_BUCKET_URL`, and the process refuses to start if it equals `MEDIA_BUCKET_URL`);
- `document.read` permission held by **VERIFIER only** — not SUPPORT, not MODERATOR, not FINANCE, and **not ADMIN**;
- every read writes to the append-only `document_access_log` before the key is returned;
- per-document `purge_after`, so retention is a stored, auditable value.

**Verified by tests.** `tests/authorization.integration.test.ts` asserts all four other staff roles get 403, that VERIFIER passes the guard, and that a read is logged.

**Currently:** VERIFIER passes the permission check and then receives 422 — "disabled pending legal review". That is the intended state.

**Requires a lawyer.** Consent form, retention window, whether a third-party KYC provider is permissible.

---

### LEGAL-012 — Rewards / lottery — **highest risk**

**Why it matters.** A prize draw for completed rentals may be a lottery, carrying licensing, registration, tax and advertising consequences.

**Current assumption.** Not shipped. **No prize-drawing logic exists in the codebase.**

**Built now.** Two flags — `rewards.lottery`, `rewards.points` — both `false`, both `requires_legal_approval = true`. `PUT /admin/feature-flags/:key` **refuses** to enable any such flag unless a `legalApprovalReference` is supplied, and stores that reference in the audit log.

**Verified by tests.** Enabling without a reference returns 422 and the flag stays off; enabling with one records the reference in `audit_log.reason`.

**Requires a lawyer.** Everything. Do not enable under any circumstances without written approval.

---

### LEGAL-016 — Is the service fee enforceable as modelled?

**Why it matters.** The entire revenue model rests on the 5% fee being a collectable debt.

**Current assumption.** It is treated as a contractual debt arising on completion — an assumption, not a finding.

**Built now.** Flag `fee.enforcement` (default `true`). The fee is always *calculated and recorded* — that part is a factual record of a transaction and is safe regardless. What the flag controls is *consequence*: with it off, `FinanceService.restrictionsFor()` returns no restrictions, so an unpaid fee stops limiting the account.

> This register was right and the flag's own `description` column was not: it said disabling would record the fee "as informational only", which `accrueServiceFee()` never did — it reads no flag and always writes a PAYABLE row. That text is served verbatim by `GET /admin/feature-flags` to the administrator most likely to switch the flag off after legal advice, so somebody could have disabled it believing the platform had stopped creating debts. Migration 0015 corrects it where they read it.

Ledger entries are append-only, so if the answer is unfavourable, historical fees are waived or written off with new compensating rows. **Nothing has to be deleted or rewritten.**

**Requires a lawyer.** Terms of service (drafting, not merely review), invoicing, VAT, and whether charging a private individual differs from charging a business.

---

### LEGAL-015 — Telegram as a notification channel

**Why it matters.** Sending booking data through Telegram may be a cross-border transfer of personal data (see LEGAL-003).

**Current assumption.** Permissible with explicit opt-in and minimal payloads.

**Built now.** Telegram is **off by default** for every category — `channelAllowed()` returns false unless a `telegram_connection` exists *and* the per-category preference is on. Linking requires a single-use token the user pastes into the bot themselves. Unlinking sets `unlinked_at` **and** disables every Telegram preference, so withdrawing consent stops future sends rather than merely breaking the link.

**Verified by tests.** Notifications are recorded as `SUPPRESSED` rather than sent when consent is absent.

**Requires a lawyer.** Whether payload contents constitute a transfer; if so, reduce notifications to content-free "you have a new message" pings — a payload change, not an architecture change.

---

### LEGAL-009 / LEGAL-010 — Reviews, trust scores, chat scanning

**Why it matters.** Publishing evaluations of named individuals, computing a score about a person, and scanning private messages each carry their own exposure.

**Current assumption.** Permissible with transparency.

**Built now.**
- The trust score is **explainable by construction**: `/profiles/:id` returns the components, their weights and a plain-language detail for each. An opaque automated judgement about a person is both a product failure and a legal risk.
- Reviews are anchored to completed bookings, one per side, and publish only when both sides submit or the window closes.
- Reviews show duration (`"останавливался(ась) на 7 ночей"`) and never exact dates — publishing when a home stood empty is a security problem.
- Chat filtering happens server-side and tells the sender plainly why text was hidden. `body_original` is retained for moderation and dispute evidence.

**Requires a lawyer.** Right of reply, correction/deletion duties, disclosure needed for message scanning, retention limit on `body_original`.

---

### LEGAL-006 / LEGAL-007 — Rental regimes and guest registration

**Current assumption.** No regime-specific duties are implemented, and no data is collected for guest registration — a deliberate minimisation choice rather than an oversight.

**Built now.** Duration is a per-listing range in nights, so short/medium/long bands are expressible as data if different rules turn out to apply. `DEC-017` records that hourly rental is deferred partly because its regulatory character is unassessed.

**Requires a lawyer.** Whether daily accommodation carries permits or reporting duties, and on whom they fall.

---

### Summary

| Question | Flag / mechanism | Default | Blocks |
|---|---|---|---|
| LEGAL-003 | `DATABASE_URL` configuration | — | **Production hosting** |
| LEGAL-004 | `verification.identity_documents` | off | Identity verification launch |
| LEGAL-012 | `rewards.lottery`, `rewards.points` | off, approval-gated | Any rewards feature |
| LEGAL-016 | `fee.enforcement` | on (assumption) | Enforcing debt |
| LEGAL-015 | per-user Telegram opt-in | off | Nothing — already conservative |
| LEGAL-017 | none yet — dispute records are append-only and never purged | retained | Nothing today; a retention answer may require a purge path |

**Development is not blocked.** Everything above is either built and gated, or is a configuration value. The two genuine blockers are the hosting decision (LEGAL-003) and enabling identity verification (LEGAL-004) — and both fail closed today rather than open.
