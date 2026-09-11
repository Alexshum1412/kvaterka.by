-- 0018_phone_verification.sql
--
-- Identity verification stops being a passport-upload pipeline and becomes
-- phone verification via a messenger account (Telegram, VK or WhatsApp).
-- The product reasoning: in Belarus a phone number is already tied to its
-- owner's passport by the mobile operator at the point of sale, so proving
-- control of a real phone-backed messenger account is treated as the
-- equivalent identity signal, without this platform ever collecting or
-- storing a passport image. See LEGAL_RISK_REGISTER.md LEGAL-004 for the
-- reasoning and its open legal question.
--
-- Property-ownership document collection is a SEPARATE, still-unblocked
-- question — nothing about that pipeline changes here except the feature
-- flag that gated it alongside identity documents, which is renamed and
-- switched on.
--
-- vk_connection mirrors telegram_connection's shape exactly (0005): one row
-- per linked VK account, revocable, never deleted so a support agent can see
-- history.
CREATE TABLE vk_connection (
  user_id      uuid PRIMARY KEY REFERENCES app_user(id) ON DELETE CASCADE,
  vk_user_id   bigint NOT NULL UNIQUE,
  linked_at    timestamptz NOT NULL DEFAULT now(),
  unlinked_at  timestamptz
);

-- Which channel actually verified the phone, kept for support visibility —
-- "why does this account show as phone-verified" should never require a
-- database archaeology session.
ALTER TABLE app_user ADD COLUMN phone_verified_via text
  CHECK (phone_verified_via IN ('TELEGRAM', 'VK', 'WHATSAPP') OR phone_verified_via IS NULL);

-- The flag that gated `VerificationService.attachDocument` gated BOTH
-- identity and property documents together. Identity documents are retired
-- outright (not just switched off) — there is no code path left that can
-- ever set this flag's old meaning back to relevant — so the row is
-- repurposed for the question that is actually still live, and switched on:
-- the user's own call, made with the stated reasoning above, not a change
-- LEGAL-004 itself resolved.
UPDATE feature_flag
   SET key = 'verification.property_documents',
       enabled = true,
       description = 'Collection of property-ownership documents (ownership certificate, power of attorney, utility bill) for a Level 2 request. Identity (Level 1) no longer depends on this — see LEGAL-004.'
 WHERE key = 'verification.identity_documents';
