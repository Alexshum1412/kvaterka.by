# LEGAL_DEPENDENCIES.md

How unresolved legal questions map onto engineering work: what is safe to build **now**, what is deliberately gated, and what cannot ship until a Belarus-qualified lawyer answers.

This is the operational companion to [LEGAL_RISK_REGISTER.md](LEGAL_RISK_REGISTER.md), which states the questions. Nothing here is a legal conclusion. Every "current assumption" is an engineering placeholder chosen so that being wrong costs a configuration change rather than a rewrite.

**Principle applied throughout:** where the law is unknown, the *architecture* stays neutral and the *behaviour* is a flag. No disputed position is hardcoded.

---

## LEGAL-003 — Personal data: legal basis, residency, cross-border transfer

**Why it matters.** Determines where the database may physically live. Moving a production database across a border afterwards is expensive and legally exposed.

**Current assumption.** Data minimisation applied unconditionally, since it is defensible under any regime: IP addresses stored only as SHA-256 (`user_session.ip_hash`, `audit_log.ip_hash`), audit rows carry diffs rather than snapshots, session tokens stored hashed.

**Built now.** Everything except the hosting decision. `DATABASE_URL` is configuration, so the region is a deployment choice, not a code change.

**Requires a lawyer.** Storage location, consent records, retention periods, sub-processor list.

**Blocks:** provisioning production infrastructure. Do not sign a hosting contract before this is answered.

---

## LEGAL-004 — Identity documents

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

## LEGAL-012 — Rewards / lottery — **highest risk**

**Why it matters.** A prize draw for completed rentals may be a lottery, carrying licensing, registration, tax and advertising consequences.

**Current assumption.** Not shipped. **No prize-drawing logic exists in the codebase.**

**Built now.** Two flags — `rewards.lottery`, `rewards.points` — both `false`, both `requires_legal_approval = true`. `PUT /admin/feature-flags/:key` **refuses** to enable any such flag unless a `legalApprovalReference` is supplied, and stores that reference in the audit log.

**Verified by tests.** Enabling without a reference returns 422 and the flag stays off; enabling with one records the reference in `audit_log.reason`.

**Requires a lawyer.** Everything. Do not enable under any circumstances without written approval.

---

## LEGAL-016 — Is the service fee enforceable as modelled?

**Why it matters.** The entire revenue model rests on the 5% fee being a collectable debt.

**Current assumption.** It is treated as a contractual debt arising on completion — an assumption, not a finding.

**Built now.** Flag `fee.enforcement` (default `true`). The fee is always *calculated and recorded* — that part is a factual record of a transaction and is safe regardless. What the flag controls is *consequence*: with it off, `FinanceService.restrictionsFor()` returns no restrictions, so the fee becomes informational rather than something that limits an account.

Ledger entries are append-only, so if the answer is unfavourable, historical fees are waived or written off with new compensating rows. **Nothing has to be deleted or rewritten.**

**Requires a lawyer.** Terms of service (drafting, not merely review), invoicing, VAT, and whether charging a private individual differs from charging a business.

---

## LEGAL-015 — Telegram as a notification channel

**Why it matters.** Sending booking data through Telegram may be a cross-border transfer of personal data (see LEGAL-003).

**Current assumption.** Permissible with explicit opt-in and minimal payloads.

**Built now.** Telegram is **off by default** for every category — `channelAllowed()` returns false unless a `telegram_connection` exists *and* the per-category preference is on. Linking requires a single-use token the user pastes into the bot themselves. Unlinking sets `unlinked_at` **and** disables every Telegram preference, so withdrawing consent stops future sends rather than merely breaking the link.

**Verified by tests.** Notifications are recorded as `SUPPRESSED` rather than sent when consent is absent.

**Requires a lawyer.** Whether payload contents constitute a transfer; if so, reduce notifications to content-free "you have a new message" pings — a payload change, not an architecture change.

---

## LEGAL-009 / LEGAL-010 — Reviews, trust scores, chat scanning

**Why it matters.** Publishing evaluations of named individuals, computing a score about a person, and scanning private messages each carry their own exposure.

**Current assumption.** Permissible with transparency.

**Built now.**
- The trust score is **explainable by construction**: `/profiles/:id` returns the components, their weights and a plain-language detail for each. An opaque automated judgement about a person is both a product failure and a legal risk.
- Reviews are anchored to completed bookings, one per side, and publish only when both sides submit or the window closes.
- Reviews show duration (`"останавливался(ась) на 7 ночей"`) and never exact dates — publishing when a home stood empty is a security problem.
- Chat filtering happens server-side and tells the sender plainly why text was hidden. `body_original` is retained for moderation and dispute evidence.

**Requires a lawyer.** Right of reply, correction/deletion duties, disclosure needed for message scanning, retention limit on `body_original`.

---

## LEGAL-006 / LEGAL-007 — Rental regimes and guest registration

**Current assumption.** No regime-specific duties are implemented, and no data is collected for guest registration — a deliberate minimisation choice rather than an oversight.

**Built now.** Duration is a per-listing range in nights, so short/medium/long bands are expressible as data if different rules turn out to apply. `DEC-017` records that hourly rental is deferred partly because its regulatory character is unassessed.

**Requires a lawyer.** Whether daily accommodation carries permits or reporting duties, and on whom they fall.

---

## Summary

| Question | Flag / mechanism | Default | Blocks |
|---|---|---|---|
| LEGAL-003 | `DATABASE_URL` configuration | — | **Production hosting** |
| LEGAL-004 | `verification.identity_documents` | off | Identity verification launch |
| LEGAL-012 | `rewards.lottery`, `rewards.points` | off, approval-gated | Any rewards feature |
| LEGAL-016 | `fee.enforcement` | on (assumption) | Enforcing debt |
| LEGAL-015 | per-user Telegram opt-in | off | Nothing — already conservative |
| LEGAL-017 | none yet — dispute records are append-only and never purged | retained | Nothing today; a retention answer may require a purge path |

**Development is not blocked.** Everything above is either built and gated, or is a configuration value. The two genuine blockers are the hosting decision (LEGAL-003) and enabling identity verification (LEGAL-004) — and both fail closed today rather than open.
