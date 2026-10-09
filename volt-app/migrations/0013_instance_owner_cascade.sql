-- ============================================================================
--  DELETING A CHANNEL THAT EVER RAN.
--
--  `instances` records what compute was provisioned for a channel or an event.
--  Two rules on the table contradicted each other:
--
--    CHECK (event_id IS NOT NULL OR channel_id IS NOT NULL)   -- must have an owner
--    FOREIGN KEY (channel_id) ... ON DELETE SET NULL          -- lose the owner
--
--  Delete a channel with any instance row and Postgres tries to NULL the
--  column the CHECK requires, the CHECK refuses, and the whole DELETE aborts:
--
--    new row for relation "instances" violates check constraint "instances_check"
--
--  So DELETE /api/channels/:id returned a 500 for every channel that had ever
--  been started. It only looked fine because the demo data was seeded and never
--  run. The events router had already hit this and worked around it in
--  application code by deleting the event's instances first — a fix that leaves
--  the trap armed for the next caller, which is exactly what happened.
--
--  WHY CASCADE RATHER THAN RELAXING THE CHECK. An instance with no owner is
--  unreachable: every read path in the service scopes instances through
--  channels or events to a group to an account, so a row with both owner
--  columns NULL can never be listed, billed, or audited again. Keeping
--  unreachable rows is not preserving history, it is accumulating garbage that
--  no query will ever surface. The billing record that matters is written
--  against the recording and the audit log, both of which outlive this table.
--
--  The CHECK stays. With CASCADE it is now an invariant that actually holds
--  rather than one the delete path had to be steered around.
-- ============================================================================

ALTER TABLE instances DROP CONSTRAINT IF EXISTS instances_channel_id_fkey;
ALTER TABLE instances
  ADD CONSTRAINT instances_channel_id_fkey
  FOREIGN KEY (channel_id) REFERENCES channels(id) ON DELETE CASCADE;

ALTER TABLE instances DROP CONSTRAINT IF EXISTS instances_event_id_fkey;
ALTER TABLE instances
  ADD CONSTRAINT instances_event_id_fkey
  FOREIGN KEY (event_id) REFERENCES events(id) ON DELETE CASCADE;

-- Any row already orphaned by the events router's workaround (owner gone,
-- both columns NULL) cannot exist, because the CHECK forbade it. But a row
-- whose owner was removed by some other path would be unreachable, so sweep
-- defensively rather than leave rows nothing can read.
DELETE FROM instances
 WHERE (channel_id IS NULL OR NOT EXISTS (SELECT 1 FROM channels c WHERE c.id = instances.channel_id))
   AND (event_id   IS NULL OR NOT EXISTS (SELECT 1 FROM events   e WHERE e.id = instances.event_id));
