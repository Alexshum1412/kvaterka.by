# PRIVACY.md

**This is a privacy architecture, not a legal compliance statement.** The applicable Belarusian requirements are unverified — see LEGAL-003 and LEGAL-004 in [LEGAL_RISK_REGISTER.md](LEGAL_RISK_REGISTER.md). In particular, **where personal data may be stored, and whether it may leave Belarus, is an open question that blocks the hosting decision.**

## Data categories

| Category | Examples | Sensitivity | Exposure |
|---|---|---|---|
| Account | email, phone, display name, locale | Medium | Never public; name is public |
| Profile / trust | rating, completed rentals, verification badges, account age | Low | Public by design (§14) |
| Property | address, photos, rules | Mixed | Approximate location public; **exact address and apartment number only from `CONFIRMED`** |
| Booking | dates, guests, prices | Medium | Parties + staff with cause |
| Chat | messages, images, moderation originals | High | Parties + moderation with cause |
| Reviews | ratings, text | Low | Public once published |
| **Identity documents** | passport/ID images, selfies | **Highest** | `VERIFIER` role only; every read logged |
| Audit | actor, action, diff, correlation id | Medium | Staff with cause |
| Security metadata | hashed IP, user agent, session chain | Medium | Internal |

## Minimisation, applied concretely

- **IP addresses are never stored raw** — only a hash, in `user_session` and `audit_log`. Sufficient for abuse correlation, not a plaintext location history.
- **Audit rows carry diffs, not snapshots**, so a table with a long retention period does not accumulate duplicate copies of personal data.
- **Session tokens are stored as SHA-256**, never the token itself.
- **Registration asks for the minimum** — one contact channel, a display name. Identity documents are requested only when a user actively seeks verification, never at signup.
- **Guest browsing needs no account** (§13).
- **Telegram payloads should stay minimal** — this is a cross-border transfer question (LEGAL-015), so notifications should carry as little content as the feature allows.

## Exact location

The map shows a deterministic blurred point (`public_latitude`/`public_longitude`), not a live-computed offset. A pin that moved between requests would let anyone average repeated observations to recover the true location — a de-anonymisation oracle. Exact address and apartment number are released only when the booking reaches `CONFIRMED`, and the release is timestamped and audited.

## Identity documents

The strictest handling in the product:

1. Stored in a **separate private bucket**, never the listing-media bucket, and never served from a public URL.
2. Reachable only by the `VERIFIER` role. **`SUPPORT` has no grant at all** — the common case of a support agent browsing passport scans is structurally impossible rather than discouraged (§17).
3. **Every single read** writes a row to the append-only `document_access_log` — actor, role, purpose, timestamp, hashed IP.
4. Each document carries `purge_after`, making retention a stored, auditable value rather than an implicit convention. A purge job reads it (`POST /admin/retention/run`), and **it is left NULL on attachment**: no retention period has been chosen, because choosing one is LEGAL-004. A NULL window means the document is never eligible for purge, so the job cannot act on a number nobody authorised. This sentence previously claimed a scheduled job enforced the column; no such job existed, and the column was written as one year with no cited basis. Both have been corrected.
5. Encryption at rest is a storage-layer requirement; the retention window itself depends on LEGAL-004.

## Chat and moderation

The contact filter retains the untouched text in `message.body_original` when it redacts something. That is necessary for moderation and dispute evidence, and it is also a privacy cost that should be disclosed to users and given a retention limit — see LEGAL-010. `message_moderation_event` stores which detectors fired and where, so the filter can be tuned **without anyone re-reading private conversations**.

## Retention (proposed — requires legal confirmation)

| Data | Proposed | Depends on |
|---|---|---|
| Account | while active + defined period after deletion | LEGAL-003 |
| Bookings, fees, ledger | long — financial records | LEGAL-002, 005 |
| Chat | defined period after the booking closes | LEGAL-010 |
| Identity documents | shortest window the decision permits | **LEGAL-004** |
| Audit | long — accountability | LEGAL-011 |
| Security metadata | short | LEGAL-003 |

Financial and audit records are append-only and cannot be deleted piecemeal. If a deletion right applies to them, the answer is anonymisation of the linked person, not destruction of the record — that needs legal confirmation.

## Deletion and export

`app_user.status = 'DELETED'` plus `deleted_at` supports soft deletion; foreign keys are `RESTRICT` on financial and booking rows precisely so a deletion cannot silently orphan a debt. A full export/erasure workflow is **NOT STARTED** and its scope depends on LEGAL-003.

## What is public

Public profile shows: name or company name, rating, completed rental count, verification badges, account age, published reviews. It never shows passport details, identity documents, private addresses, internal moderation notes, verification internals, case data, contact details before release, or exact booking dates (reviews render duration as "stayed 12 days" rather than exposing when a home was empty).
