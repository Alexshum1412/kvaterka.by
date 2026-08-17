/* ==================================================================== *
 * Moderation history vs. deleting a listing
 *
 * 0009 made `listing_moderation_review` append-only with the shared
 * `forbid_mutation()` trigger, which blocks UPDATE and DELETE. That is
 * right for edits and wrong for one case it did not anticipate: the
 * table's own `ON DELETE CASCADE`. Removing a property tried to cascade
 * into the history, the trigger refused, and the delete failed — so a
 * listing that had ever been moderated could no longer be removed at all.
 *
 * The distinction that matters is WHY the row is being deleted. A row
 * deleted on its own is somebody editing history. A row deleted because
 * its listing is gone is the listing taking its history with it, which is
 * also the data-minimising outcome: keeping moderation notes about a
 * property that no longer exists serves nobody.
 *
 * During a cascade the parent row is already gone by the time the row
 * trigger runs, and during a direct delete it is still there. That is a
 * reliable discriminator, so the trigger uses it.
 *
 * The tamper-proof trail is unaffected either way: `audit_log` records
 * every `listing.moderate` action independently, keyed by target id, and
 * is not cascaded from anything.
 * ==================================================================== */

CREATE OR REPLACE FUNCTION forbid_review_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE'
     AND NOT EXISTS (SELECT 1 FROM property WHERE id = OLD.property_id) THEN
    -- The listing is being deleted; its history goes with it.
    RETURN OLD;
  END IF;

  RAISE EXCEPTION 'Table % is append-only; % is not permitted', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'restrict_violation';
END $$;

DROP TRIGGER IF EXISTS listing_moderation_review_append_only ON listing_moderation_review;

CREATE TRIGGER listing_moderation_review_append_only
  BEFORE UPDATE OR DELETE ON listing_moderation_review
  FOR EACH ROW EXECUTE FUNCTION forbid_review_mutation();
