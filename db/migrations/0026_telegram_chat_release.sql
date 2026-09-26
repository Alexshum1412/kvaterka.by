-- A Telegram chat id was UNIQUE for ever (0005), but unlinking only stamps `unlinked_at`
-- and keeps the row. So a chat that had once been linked - or that somebody else's deep
-- link had bound to *their* account - could never again be linked to its own person's
-- account: the INSERT hit the constraint, the bot's webhook swallowed the error, and the
-- person was told their code had expired. There was no way out: /unlink released nothing.
--
-- A chat is now held only while it is linked. The same person can be linked again after
-- an unlink, another account can take a chat that was let go, and a chat that is live on
-- one account still cannot be live on two (the partial unique index).

ALTER TABLE telegram_connection DROP CONSTRAINT telegram_connection_telegram_chat_id_key;

CREATE UNIQUE INDEX telegram_connection_live_chat_idx
  ON telegram_connection (telegram_chat_id)
  WHERE unlinked_at IS NULL;
