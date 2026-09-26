# SECURITY.md — безопасность и приватность

Вторая часть файла, «Приватность», — бывший PRIVACY.md.

Status is stated honestly: much of this is designed and schema-supported but not yet implemented, because the auth layer is the next phase. Nothing below is claimed as verified unless a test proves it.

## Threat model

The platform is financial-adjacent even though rent never flows through it. The assets worth attacking:

| Asset | Threat | Impact |
|---|---|---|
| Identity documents | Data theft | Severe — passport data, irreversible |
| Landlord debt ledger | Tampering to erase a fee | Direct revenue loss |
| Booking calendar | Double booking, sabotage | Two tenants at one door |
| Chat history | Disclosure | Privacy harm, dispute evidence destroyed |
| Accounts | Takeover | Fraud under a trusted identity |
| Reviews | Manipulation | Destroys the product's core value |
| Audit log | Rewriting history | Accountability lost |

## Implemented and tested

| Control | Mechanism | Evidence |
|---|---|---|
| Financial history cannot be altered | `forbid_mutation()` on `ledger_entry`, `service_fee` accrual guards | tests assert `UPDATE`/`DELETE` are rejected |
| Audit log cannot be rewritten | same trigger on `audit_log` | tested |
| Booking events cannot be back-dated | same trigger on `booking_event` | tested |
| Double booking impossible | `PRIMARY KEY (property_id, night)` on `property_occupancy` | 10+ tests |
| Duplicate fee impossible | 3 independent guards | tested |
| Privilege boundaries in the booking lifecycle | actor permissions in the transition table; actor resolved from the DB row, never from request input | 13 authorization tests |
| SQL injection | every query parameterised; no string interpolation of user input anywhere | reviewed; enforced by convention and review |
| Partial writes on failure | every service method is one transaction | test asserts a failed authorization leaves no events behind |
| Contact-exchange leakage before confirmation | layered filter + `contact_release_state` | 71 tests |

## Implemented since the auth layer landed

The table below was written before authentication existed and said NOT STARTED for five controls
that have since been built and tested. Corrected here rather than left to mislead — a security
document that understates what exists is the same kind of defect as one that overstates it.

| Control | Mechanism | Status |
|---|---|---|
| Password hashing | argon2id via `@node-rs/argon2` | IMPLEMENTED — `auth/credentials.ts`, exercised throughout `tests/auth.integration.test.ts` |
| Session tokens | SHA-256 stored, never the token; rotation chain detects replay of a rotated token; expiry + revocation | IMPLEMENTED — `auth/auth-service.ts` |
| CSRF | `SameSite=Lax`, `HttpOnly`, `Secure` session cookie; no state change on GET | IMPLEMENTED |
| Rate limiting | per-IP and per-account, declared per route in the route table | IMPLEMENTED — `api/rate-limit.ts`; login, registration, reset, messaging and Telegram linking all carry limits |
| Registration confirm | The account is created only when the mailed code AND the password chosen at registration are both presented; a wrong password spends the same attempt counter as a wrong code. The mailed link never submits anything on load, and the page shows only an address and code of the shape a real link carries | IMPLEMENTED and TESTED — `confirmRegistration` in `auth/auth-service.ts`, `lib/verify-link.ts`, `e2e/registration.spec.ts`, DEC-088. Closes the takeover where the first submitter of an address chose the password the mailbox owner then confirmed |
| Document access control | `document.read` held by VERIFIER alone; every read written to an append-only log before the key is returned | IMPLEMENTED and TESTED — `tests/authorization.integration.test.ts` |
| Brute force | attempt counters, escalating lockout cleared only by success | IMPLEMENTED for 2FA (see below). Login: a per-account lock after 8 failures in 15 minutes, read before the password is checked and again after it, so a locked account answers every attempt alike (DEC-089); plus a per-IP limit that trusts `X-Real-IP` (unverified on the host, DEC-087) |
| Staff 2FA | TOTP, required for every staff role | **ENFORCED** — see below |
| Machine credential | A scheduler principal holding three job permissions and nothing else | IMPLEMENTED and TESTED — `api/machine.ts`, DEC-058 |

### How staff 2FA is enforced, and what it does not protect

The control is not a check. A session that has not satisfied its second factor is handed a role array with the staff grants **removed**, so every `can()` in the product — in the router, in a console page, in a service — answers false without knowing 2FA exists. This is deliberate: `dispatch()` is reached from one place, and the staff console does not go through it (`src/app/staff/**` resolve the session themselves; `moderation/page.tsx` runs its own SQL), so a check in the router would have protected one endpoint and left four consoles open. DEC-054.

- **TOTP** per RFC 6238, implemented on `node:crypto`, verified against the published test vectors and cross-checked against a WebCrypto implementation in a browser.
- **Codes are single-use.** The matched step is recorded and anything at or below it is refused, so a code read over a shoulder cannot be replayed within its window.
- **Lockout escalates** and its counter is cleared only by a success, never by waiting. A fixed 15-minute lockout would allow ~175 000 guesses a year against a 10⁶ keyspace; this allows ~1850.
- **Step-up**: `document.read`, `verification.decide`, `ledger.adjust`, `fee.waive`, `user.suspend`, `role.grant`, `feature_flag.write` and `retention.hold` additionally require a confirmation within the last 15 minutes.
- **Resetting somebody else's authenticator** requires `role.grant`, which only ADMIN holds — so SUPPORT cannot strip a colleague's second factor.

**What it does not protect against, stated plainly.** The TOTP secret is stored in **plaintext**. It cannot be hashed, because verification needs it, and this project has no encryption-at-rest layer — nothing encrypts any column today. So the second factor defends against a stolen or guessed **password**; it does **not** defend against an attacker who already has the database. That is a smaller guarantee than "2FA" usually implies, and it is recorded in DEC-055 rather than left to be assumed.
## Designed, not yet implemented

| Control | Design | Status |
|---|---|---|
| Upload safety | magic-byte sniffing, server-generated keys, metadata stripping, dimension cap | IMPLEMENTED — `domain/image.ts`, `api/uploads`; **not** re-encoded, so a malformed image still reaches the browser's decoder |
| Secure headers | HSTS, `X-Content-Type-Options`, frame denial, Referrer-Policy, Permissions-Policy | IMPLEMENTED — `next.config.ts` |
| CSP | per-request nonce, `strict-dynamic` | IMPLEMENTED — `src/middleware.ts`. `style-src` keeps `'unsafe-inline'`: 55 components carry inline `<style>` blocks and React does not nonce them. Stated rather than hidden — inline STYLE cannot exfiltrate a session the way inline SCRIPT can |
| Health and readiness | `/api/health` touches the database and reports job status and queue depth | IMPLEMENTED |
| Encryption at rest | no column is encrypted; the TOTP secret is the first that should be | NOT STARTED — DEC-055 |
| Secrets management | env vars validated at startup; never in the repository | partially |
| SSRF | no user-supplied URL is ever fetched server-side; if that changes, allowlist only | policy |
| XSS | React escapes by default; no `dangerouslySetInnerHTML` on user content | policy |

## Specific decisions

**Session tokens are stored hashed.** A database leak must not hand the attacker live sessions. The `previous_id` chain means presenting a rotated token is a detectable signal of theft, not just an expired login.

**IP addresses are stored hashed** in `user_session` and `audit_log`. Enough for abuse correlation, not a plaintext location history.

**`SUPPORT` cannot reach identity documents.** Not "should not" — the role has no grant, and the access log would record any attempt made through a legitimate path. This follows spec §17's requirement that ordinary support staff not access full identity data by default.

**Financial corrections are new rows.** There is no mechanism to edit a ledger entry, for anyone, including an administrator. A mistake is corrected by an `ADJUSTMENT` that requires both a reason and an author.

**Errors never leak internals.** `DomainError` carries a stable code, a safe message and an HTTP status. Anything else becomes a generic 500 with a correlation id that ties the user's report to the server log.

## Known gaps

1. **Concurrency is now verified by race, not only by constraint.** `tests/concurrency.postgres.test.ts` runs against a real PostgreSQL 10.23 — the production version — and asserts what PGlite cannot: eight simultaneous acceptances of one week leave exactly one CONFIRMED; both sides confirming completion at the same instant accrue one fee and one ledger row; four delivery workers never claim the same notification; four schedulers leave one RUNNING job. The suite skips loudly under PGlite rather than passing.

   Getting there required fixing the harness: every test file shared one database and each `truncateAll()` took an ACCESS EXCLUSIVE lock on every table, so the first real run produced 503 failures against 1034 PGlite passes — none of them a product defect. Each file now gets its own schema.
2. **The TOTP secret is stored in plaintext.** The second factor defends against a stolen password, not against an attacker holding the database. DEC-055.
3. **No secure headers or CSP.**
4. **Uploads are not re-encoded**, so EXIF and any embedded payload survive.
5. **No penetration test.**
6. **No SAST.** `npm audit` now runs in CI, advisory only.
7. **Rewards subsystem gated** behind a flag that refuses to enable without a recorded legal approval reference.

## Reporting

Security contact and disclosure policy to be established before public launch.

---

## Приватность

**This is a privacy architecture, not a legal compliance statement.** The applicable Belarusian requirements are unverified — see LEGAL-003 and LEGAL-004 in [docs/LEGAL.md](docs/LEGAL.md). In particular, **where personal data may be stored, and whether it may leave Belarus, is an open question that blocks the hosting decision.**

### Data categories

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

### Minimisation, applied concretely

- **IP addresses are never stored raw** — only a hash, in `user_session` and `audit_log`. Sufficient for abuse correlation, not a plaintext location history.
- **Audit rows carry diffs, not snapshots**, so a table with a long retention period does not accumulate duplicate copies of personal data.
- **Session tokens are stored as SHA-256**, never the token itself.
- **Registration asks for the minimum** — one contact channel, a display name. Identity documents are requested only when a user actively seeks verification, never at signup.
- **Guest browsing needs no account** (§13).
- **Telegram payloads should stay minimal** — this is a cross-border transfer question (LEGAL-015), so notifications should carry as little content as the feature allows.

### Exact location

The map shows a deterministic blurred point (`public_latitude`/`public_longitude`), not a live-computed offset. A pin that moved between requests would let anyone average repeated observations to recover the true location — a de-anonymisation oracle. Exact address and apartment number are released only when the booking reaches `CONFIRMED`, and the release is timestamped and audited.

### Identity documents

The strictest handling in the product:

1. Stored in a **separate private bucket**, never the listing-media bucket, and never served from a public URL.
2. Reachable only by the `VERIFIER` role. **`SUPPORT` has no grant at all** — the common case of a support agent browsing passport scans is structurally impossible rather than discouraged (§17).
3. **Every single read** writes a row to the append-only `document_access_log` — actor, role, purpose, timestamp, hashed IP.
4. Each document carries `purge_after`, making retention a stored, auditable value rather than an implicit convention. A purge job reads it (`POST /admin/retention/run`), and **it is left NULL on attachment**: no retention period has been chosen, because choosing one is LEGAL-004. A NULL window means the document is never eligible for purge, so the job cannot act on a number nobody authorised. This sentence previously claimed a scheduled job enforced the column; no such job existed, and the column was written as one year with no cited basis. Both have been corrected.
5. Encryption at rest is a storage-layer requirement; the retention window itself depends on LEGAL-004.

### Chat and moderation

The contact filter retains the untouched text in `message.body_original` when it redacts something. That is necessary for moderation and dispute evidence, and it is also a privacy cost that should be disclosed to users and given a retention limit — see LEGAL-010. `message_moderation_event` stores which detectors fired and where, so the filter can be tuned **without anyone re-reading private conversations**.

### Retention (proposed — requires legal confirmation)

| Data | Proposed | Depends on |
|---|---|---|
| Account | while active + defined period after deletion | LEGAL-003 |
| Bookings, fees, ledger | long — financial records | LEGAL-002, 005 |
| Chat | defined period after the booking closes | LEGAL-010 |
| Identity documents | shortest window the decision permits | **LEGAL-004** |
| Audit | long — accountability | LEGAL-011 |
| Security metadata | short | LEGAL-003 |

Financial and audit records are append-only and cannot be deleted piecemeal. If a deletion right applies to them, the answer is anonymisation of the linked person, not destruction of the record — that needs legal confirmation.

### Deletion and export

`app_user.status = 'DELETED'` plus `deleted_at` supports soft deletion; foreign keys are `RESTRICT` on financial and booking rows precisely so a deletion cannot silently orphan a debt. Until the retention slice **nothing in the product ever wrote either column**.

**Closing an account is now built. Erasing one is not, and the two are kept apart deliberately.**

Closure (`POST /me/account/close`, and a staff equivalent) revokes every session, destroys unconsumed one-time tokens, sets `status='DELETED'` and `deleted_at`, and pauses the person's published listings. It removes *access* and destroys *no data at all*. It is refused while an active booking, an open dispute or a legal hold exists — the first because closing mid-stay would strand a counterparty. An outstanding debt does **not** block closure: refusing would use a data-protection mechanism as leverage over money, and the ledger is unaffected by closure either way.

Erasure — anonymising the profile, redacting messages and `body_original`, purging media and identity documents — is **NOT BUILT**. Each step is declared in `domain/retention.ts` with the legal question that gates it (LEGAL-003, LEGAL-010, LEGAL-004), the account screen prints every one of them beside its blocker, and a test asserts that no step which destroys personal data is marked as built. A half-finished erasure is worse than none, because it looks finished to the person who asked for it.

**Legal hold.** Any user, listing, booking, case, verification request, document or conversation can be frozen against destruction, with a reason code, free-text reason, and the person who placed it. Placing is available to support and moderation because it only ever prevents destruction; lifting requires an administrator and a written reason. Both write append-only audit rows. Holds do not expire — one that released itself would not be a hold — but they carry a review cadence and the console shows an unreviewed hold as overdue, because "we hold what we must" otherwise becomes "we keep everything for ever".

### What is public

Public profile shows: name or company name, rating, completed rental count, verification badges, account age, published reviews. It never shows passport details, identity documents, private addresses, internal moderation notes, verification internals, case data, contact details before release, or exact booking dates (reviews render duration as "stayed 12 days" rather than exposing when a home was empty).
