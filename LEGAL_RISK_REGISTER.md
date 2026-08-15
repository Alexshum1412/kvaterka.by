# LEGAL_RISK_REGISTER.md

## Read this first

**No legal research was performed for this register, and it contains no citations to Belarusian law.** Every entry below is an *engineering-identified open question*, not a legal finding.

This is deliberate. The specification says "Never state 'legally safe' without evidence" (§50) and "Do not assume that the above business model automatically eliminates all legal obligations" (§2). A register full of confident paraphrases of statutes I have not verified would be worse than an empty one: it would look like due diligence and would be relied upon as such. Producing plausible-sounding legal claims about a jurisdiction without consulting authoritative sources is the single most dangerous thing this document could do.

**Confidence on every entry below is therefore `NONE — engineering assumption only`.** Each requires a Belarus-qualified lawyer, and several also require an accountant.

What this register *is* good for: it names the questions precisely, records the product decision currently riding on each one, and states what would have to change if the answer is unfavourable. That makes the lawyer's engagement cheap and specific instead of open-ended.

**Status of LEGAL-003 (Belarus legal verification): BLOCKED.**

---

## How to read an entry

| Field | Meaning |
|---|---|
| **Question** | The precise thing that must be answered |
| **Product decision riding on it** | What the code currently assumes |
| **If unfavourable** | What would have to change |
| **Confidence** | `NONE` throughout — see above |
| **Lawyer review required** | Yes for all; accountant flagged where relevant |

---

### LEGAL-001 — Intermediary vs. party to the lease

**Question.** Does operating this marketplace make the company a party to, or a legally responsible intermediary in, the rental relationship — and what consumer-protection duties follow?

**Product decision riding on it.** The platform is modelled strictly as an intermediary: it never receives rent, never holds tenant funds, never acts as escrow. `DECISIONS.md` and the data model contain no concept of a platform-held balance for rent.

**If unfavourable.** Terms of service, liability disclosures, and possibly the fee model would need restructuring. The architecture supports it — no rent ever flows through the system, so there is nothing to unwind.

**Lawyer:** yes.

---

### LEGAL-002 — The 5% service fee: legal character, invoicing, VAT, accounting

**Question.** Is a percentage-based service fee charged to a landlord after a completed rental correctly characterised as a service fee? What invoicing and VAT treatment applies? How must it be recognised in accounting? Does charging a private individual (not a business) change anything?

**Product decision riding on it.** `service_fee` + `ledger_entry` model the fee as a payable debt, with all inputs stored so any figure can be re-derived and audited. `bps` is per-booking, so a different rate or a rate that varies by counterparty type is a data change, not a schema change.

**If unfavourable.** Invoice generation, VAT lines and possibly a different fee structure. The immutable ledger is designed to survive this — corrections are new rows.

**Lawyer:** yes. **Accountant:** yes.

---

### LEGAL-003 — Personal data: legal basis, consent, storage location, cross-border transfer

**Question.** What legal basis is required to process account, booking, chat and device data? Are consent records required, and in what form? Must personal data of Belarusian users be stored in Belarus? What are the rules on transfer abroad — which directly constrains hosting choices?

**Product decision riding on it.** Data minimisation is built in (IP addresses hashed, not stored raw; audit rows carry diffs rather than full snapshots). No hosting region has been chosen precisely because this answer determines it.

**If unfavourable.** Hosting region, backup location and sub-processor list. **This must be answered before infrastructure is provisioned** — moving a production database across a border later is expensive and legally exposed.

**Lawyer:** yes. **Blocks:** production hosting decision.

---

### LEGAL-004 — Identity documents (passport data)

**Question.** What is required to collect and store passport/ID images and selfies for verification? Is explicit consent needed? Is there a mandatory retention limit or deletion duty? Are additional security measures legally required? Is a third-party KYC provider permissible?

**Product decision riding on it.** Documents are in a separate private bucket, reachable only by the `VERIFIER` role, with every read written to an append-only `document_access_log`, and a per-document `purge_after` making the retention policy a stored value rather than an implicit convention.

**If unfavourable.** Retention windows change (a data change), or verification moves to a licensed provider (the schema already isolates documents behind a request abstraction).

**Lawyer:** yes. Highest sensitivity item in the product.

---

### LEGAL-005 — Landlord tax obligations and platform reporting duties

**Question.** What are a landlord's tax/registration obligations for rental income in Belarus? Does the platform have any duty to inform, withhold or report? Does the answer differ for private individuals, sole traders and companies?

**Product decision riding on it.** None currently — the platform neither reports nor advises. `app_user.account_kind` distinguishes private from company accounts, so differential handling is possible.

**If unfavourable.** Reporting exports, landlord tax notices, possibly mandatory identification before publishing.

**Lawyer:** yes. **Accountant:** yes.

---

### LEGAL-006 — Short-term vs long-term rental: distinct regimes

**Question.** Does Belarusian law distinguish short-term/daily accommodation from long-term residential tenancy in ways that impose different duties — registration, permits, guest reporting, safety requirements? Does a platform facilitating both need to treat them differently?

**Product decision riding on it.** The product deliberately does *not* force listings into short- or long-term categories (spec §6); a single listing may span 1 night to 3 years.

**If unfavourable.** Duration bands may need distinct flows, disclosures or eligibility rules. `min_nights`/`max_nights` make the bands expressible without redesign.

**Lawyer:** yes.

---

### LEGAL-007 — Guest registration / residence-reporting duties

**Question.** Is there an obligation to register guests or report temporary residence, particularly for foreign nationals? Does it fall on the landlord, the platform, or both?

**Product decision riding on it.** None. The platform collects no data specifically for this purpose — a deliberate data-minimisation choice that would have to be revisited rather than assumed.

**If unfavourable.** Additional collection at booking, with its own legal basis under LEGAL-003.

**Lawyer:** yes.

---

### LEGAL-008 — Liability for user-generated content

**Question.** What liability does the platform bear for listings, reviews and chat messages? Are there notice-and-takedown duties, response deadlines, or record-keeping requirements?

**Product decision riding on it.** Pre-publication moderation for listings; a `report` queue; append-only moderation events preserving what was decided and why.

**If unfavourable.** Response-time SLAs and a formal takedown workflow. The audit trail already supports proving what was done and when.

**Lawyer:** yes.

---

### LEGAL-009 — Reviews and reputation

**Question.** Are there legal constraints on publishing reviews about named individuals — defamation exposure, a right of reply, correction or deletion duties? Does a computed "trust score" about a natural person create additional obligations (e.g. rules on automated evaluation of individuals)?

**Product decision riding on it.** Reviews are tied to completed bookings, one per side, with moderation states and tracked edits. The trust score is specified to be documented and explainable rather than an opaque number.

**If unfavourable.** Right-of-reply UI, stricter moderation, or a materially simpler public score.

**Lawyer:** yes.

---

### LEGAL-010 — Chat interception and contact filtering

**Question.** Does automatically scanning, flagging and redacting private messages between users require specific disclosure or consent? Are there restrictions on retaining the original unredacted text?

**Product decision riding on it.** `message.body_original` retains untouched text for moderation and evidence; `message_moderation_event` records detector output. The filter's user-facing message states plainly that contacts are hidden until confirmation.

**If unfavourable.** Consent at registration, clearer in-product disclosure, or shorter retention of originals.

**Lawyer:** yes.

---

### LEGAL-011 — Electronic records as evidence

**Question.** What weight do platform-held records — booking events, chat logs, check-in photos, audit entries — carry in a Belarusian dispute? Are there requirements (timestamping, signatures, integrity proofs) to make them admissible?

**Product decision riding on it.** Append-only tables, content hashes on snapshots and photos, correlation ids. This is deliberately more than "good logging" because the evidence trail is a core product promise.

**If unfavourable.** Cryptographic timestamping or third-party notarisation. The hash columns give a place to anchor it.

**Lawyer:** yes.

---

### LEGAL-012 — Rewards / lottery — **highest-risk item**

**Question.** Would issuing tickets for completed rentals that enter a prize draw constitute a lottery or gambling activity under Belarusian law? What licensing, registration, tax and advertising obligations follow? Which prize types, if any, avoid the regime?

**Product decision riding on it.** **Not shipped.** Per DEC-015 there is a `feature_flag` row with `requires_legal_approval = true` and **no prize-drawing logic exists in the codebase**. MVP gamification is limited to reputation, achievements and trust levels.

**If unfavourable.** Nothing to unwind — this is exactly why it was gated rather than built.

**Lawyer:** yes. **Do not enable under any circumstances without written legal approval.**

---

### LEGAL-013 — Advertising and paid promotion

**Question.** What rules govern advertising claims, and must sponsored placements be labelled as advertising?

**Product decision riding on it.** Monetisation beyond the service fee is out of scope for MVP. The architecture separates organic trust ranking from paid placement (spec §45), which makes labelling straightforward.

**Lawyer:** yes, before any paid placement ships.

---

### LEGAL-014 — Map data and geolocation privacy

**Question.** Are there restrictions on displaying property locations, on the mapping providers usable in Belarus, or on precision of location data for residential addresses?

**Product decision riding on it.** Approximate location by default, with a deterministic public offset; exact address released only from `CONFIRMED`. Map provider is abstracted so it can be swapped.

**Lawyer:** yes.

---

### LEGAL-015 — Telegram integration

**Question.** Any restriction on using Telegram as a notification channel, and does sending booking data through it constitute a cross-border transfer of personal data (see LEGAL-003)?

**Product decision riding on it.** Telegram is optional, opt-in per category, and carries notifications only — the canonical conversation never leaves the platform. Notification payloads should be kept minimal for this reason.

**If unfavourable.** Drop the channel, or reduce payloads to content-free "you have a new message" pings.

**Lawyer:** yes.

---

### LEGAL-016 — Terms of service and the contractual chain

**Question.** What must the platform's terms contain to establish the fee obligation, define the intermediary role, and set dispute-handling rules? Is a Belarusian-language version legally required?

**Product decision riding on it.** The fee is treated as a contractual debt arising on completion. **This is the assumption the entire revenue model rests on** and it is currently unverified.

**If unfavourable.** The fee may be unenforceable as modelled. The ledger design tolerates waiving or writing off historical fees without rewriting records.

**Lawyer:** yes — draft, not merely review.

---

## Summary

| Item | Blocks |
|---|---|
| LEGAL-003 | Choice of hosting region — answer before provisioning infrastructure |
| LEGAL-004 | Launching identity verification |
| LEGAL-012 | Any rewards feature — currently gated and safe |
| LEGAL-016 | Charging the service fee at all |
| LEGAL-002, 005 | Invoicing and accounting setup |

**Nothing in this product may be described as legally compliant on the basis of this document.**
