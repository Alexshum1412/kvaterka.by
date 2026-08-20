-- Say what the flag does, not what it was imagined to do.
--
-- `fee.enforcement` has described itself, since migration 0006, as deciding
-- "whether the 5% service fee accrues as a payable debt", with "disabling
-- records the fee as informational only".
--
-- That is not what it gates. `accrueServiceFee()` reads no feature flag: it
-- always inserts a `service_fee` row with the default status 'PAYABLE' and a
-- negative FEE_ACCRUED ledger entry. The flag is read in exactly one place,
-- `FinanceService.restrictionsFor()`, where it decides whether an unpaid fee
-- RESTRICTS the landlord's account.
--
-- The narrower behaviour is the correct one and LEGAL_RISK_REGISTER.md already
-- describes it accurately: recording a fee is a factual record of a completed
-- transaction and is defensible whatever a lawyer concludes about LEGAL-016;
-- acting on it is the part that depends on the answer. What was wrong was the
-- description — which is not a comment. It is served verbatim by
-- `GET /admin/feature-flags` to the administrator deciding whether to switch it
-- off, most plausibly in response to legal advice. Somebody could read it,
-- disable the flag believing the platform had stopped creating debts, and be
-- wrong about the one thing they were trying to change.
--
-- Migration 0006 cannot be edited: it is applied, and the migrator refuses a
-- file whose checksum has moved (which is the behaviour that makes this a new
-- migration rather than a correction in place).

UPDATE feature_flag
   SET description =
       'Whether an unpaid service fee RESTRICTS the landlord''s account '
       || '(new listings, accepting bookings, promotion). The fee is recorded '
       || 'either way: accrual is a factual record of a completed rental and '
       || 'does not depend on this flag. Fee enforceability is unverified '
       || '(LEGAL-016); disabling removes the consequences, not the record.'
 WHERE key = 'fee.enforcement';
