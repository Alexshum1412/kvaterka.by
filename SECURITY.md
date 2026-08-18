# SECURITY.md

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
| Double booking impossible | `EXCLUDE USING gist` | 10+ tests |
| Duplicate fee impossible | 3 independent guards | tested |
| Privilege boundaries in the booking lifecycle | actor permissions in the transition table; actor resolved from the DB row, never from request input | 13 authorization tests |
| SQL injection | every query parameterised; no string interpolation of user input anywhere | reviewed; enforced by convention and review |
| Partial writes on failure | every service method is one transaction | test asserts a failed authorization leaves no events behind |
| Contact-exchange leakage before confirmation | layered filter + `contact_release_state` | 71 tests |

## Designed, not yet implemented

| Control | Design | Status |
|---|---|---|
| Password hashing | argon2id, verified to run on the target platform | NOT STARTED |
| Session tokens | SHA-256 stored, never the token; rotation chain detects replay of a rotated token; expiry + revocation | schema TESTED, logic NOT STARTED |
| CSRF | `SameSite=Lax` cookies + token on state-changing requests | NOT STARTED |
| Rate limiting | per-account and per-IP on auth, messaging, booking | NOT STARTED |
| Brute force | attempt counters on `auth_token`, progressive delay, lockout | schema present |
| Staff 2FA | TOTP, required for every staff role | **ENFORCED** — see below |

### How staff 2FA is enforced, and what it does not protect

The control is not a check. A session that has not satisfied its second factor is handed a role array with the staff grants **removed**, so every `can()` in the product — in the router, in a console page, in a service — answers false without knowing 2FA exists. This is deliberate: `dispatch()` is reached from one place, and the staff console does not go through it (`src/app/staff/**` resolve the session themselves; `moderation/page.tsx` runs its own SQL), so a check in the router would have protected one endpoint and left four consoles open. DEC-054.

- **TOTP** per RFC 6238, implemented on `node:crypto`, verified against the published test vectors and cross-checked against a WebCrypto implementation in a browser.
- **Codes are single-use.** The matched step is recorded and anything at or below it is refused, so a code read over a shoulder cannot be replayed within its window.
- **Lockout escalates** and its counter is cleared only by a success, never by waiting. A fixed 15-minute lockout would allow ~175 000 guesses a year against a 10⁶ keyspace; this allows ~1850.
- **Step-up**: `document.read`, `verification.decide`, `ledger.adjust`, `fee.waive`, `user.suspend`, `role.grant`, `feature_flag.write` and `retention.hold` additionally require a confirmation within the last 15 minutes.
- **Resetting somebody else's authenticator** requires `role.grant`, which only ADMIN holds — so SUPPORT cannot strip a colleague's second factor.

**What it does not protect against, stated plainly.** The TOTP secret is stored in **plaintext**. It cannot be hashed, because verification needs it, and this project has no encryption-at-rest layer — nothing encrypts any column today. So the second factor defends against a stolen or guessed **password**; it does **not** defend against an attacker who already has the database. That is a smaller guarantee than "2FA" usually implies, and it is recorded in DEC-055 rather than left to be assumed.
| Document access control | `VERIFIER` role only; `SUPPORT` has no path at all; every read logged | schema TESTED, enforcement NOT STARTED |
| Upload safety | type/size validation, image re-encoding to strip payloads and EXIF, content hashing, no execution from the media bucket | NOT STARTED |
| Secure headers / CSP | strict CSP, HSTS, `X-Content-Type-Options`, frame denial | NOT STARTED |
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

1. **Concurrency verified by constraint, not yet by race.** PGlite serialises connections. The `EXCLUDE` constraint is a PostgreSQL guarantee and the tests prove it rejects overlaps, but a genuine simultaneous-transaction test requires a real server (`TEST_DATABASE_URL`) and **has not been run here**.
2. **No auth layer yet** — everything in the second table above.
3. **No dependency scanning or SAST in CI** — CI does not exist yet.
4. **No penetration test.**
5. **Rewards subsystem gated** but the flag mechanism itself needs authorization once admin exists.

## Reporting

Security contact and disclosure policy to be established before public launch.
