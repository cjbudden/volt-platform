-- ============================================================================
--  0168: MIRROR MODE FOR COPY RULES (build queue H3-10, decided by Christian
--  on 11 Nov 2026).
--
--  A copy rule entry may say `mode: 'mirror'`: the target is kept in step
--  with Volt, deletes included. A copy made under such a rule remembers it
--  (`archive_copies.mode`), because once its asset is gone there is no rule
--  left to resolve for it.
--
--  The grace period is the TARGET's (`mirror_grace_days`, 7 by default, 0 to
--  90), not the rule's. It starts only when the asset (or the sidecar) has
--  left Volt for good: out of the restore bin, never while it can still be
--  restored. `delete_after` is when the agent may remove the copy; a restore
--  clears it. `removed_at` and the state `removed` say the agent did.
--
--  Add only (RELEASING.md "Schema: add only"): columns with a default or
--  nullable. Copies made before this keep `archive`: Volt never deletes them.
-- ============================================================================
ALTER TABLE archive_targets ADD COLUMN IF NOT EXISTS mirror_grace_days integer NOT NULL DEFAULT 7;
ALTER TABLE archive_copies  ADD COLUMN IF NOT EXISTS mode          text NOT NULL DEFAULT 'archive';
ALTER TABLE archive_copies  ADD COLUMN IF NOT EXISTS delete_after  timestamptz;
ALTER TABLE archive_copies  ADD COLUMN IF NOT EXISTS delete_job_id uuid;
ALTER TABLE archive_copies  ADD COLUMN IF NOT EXISTS removed_at    timestamptz;
