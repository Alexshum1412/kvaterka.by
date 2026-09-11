-- 0019_phone_verification_telegram_only.sql
--
-- VK and WhatsApp are dropped from phone verification (0018) — Telegram only
-- going forward. See DECISIONS.md DEC-069 for the product reasoning.
--
-- 0018 shipped and may already be applied in some environment, so this is a
-- forward migration rather than an edit to 0018_phone_verification.sql
-- itself, matching this project's own convention (0018 renamed a flag from
-- 0006 the same way rather than rewriting that earlier file).
--
-- Any account that verified its phone via VK/WhatsApp loses that signal —
-- there is no equivalent to fall back to, and the feature was live only
-- briefly with no real user base on either channel. phone_verified_at is
-- cleared alongside phone_verified_via so "phone verified, via nothing" is
-- never a representable state; verification_level is left untouched since it
-- only ever increases and a stray Level 1 on a handful of test accounts is
-- harmless (the phone gate itself reads phone_verified_at, not the level, so
-- clearing phone_verified_at is what actually re-locks the account).
UPDATE app_user
   SET phone_verified_via = NULL,
       phone_verified_at = NULL
 WHERE phone_verified_via IN ('VK', 'WHATSAPP');

DROP TABLE IF EXISTS vk_connection;

ALTER TABLE app_user DROP CONSTRAINT app_user_phone_verified_via_check;
ALTER TABLE app_user ADD CONSTRAINT app_user_phone_verified_via_check
  CHECK (phone_verified_via IN ('TELEGRAM') OR phone_verified_via IS NULL);
