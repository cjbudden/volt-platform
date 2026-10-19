-- PLAN AT THE ACCOUNT, ALLOCATION AT THE GROUP (docs/PLAN_AND_GROUPS.md).
--
-- accounts.max_channels is the plan: how many channels and stations the
-- account may have in all. groups.max_channels is the share of it a group is
-- given; allocations add up to no more than the plan. Until now only the group
-- figure was enforced, so the plan figure (default 5) may be lower than what
-- an account already has: it is raised here to cover the groups' allocations
-- and the channels that exist, so nothing in use is blocked by this change.
UPDATE accounts a SET
  max_channels = GREATEST(
    a.max_channels,
    COALESCE((SELECT sum(g.max_channels) FROM groups g WHERE g.account_id = a.id), 0),
    (SELECT count(*) FROM channels c JOIN groups g ON g.id = c.group_id WHERE g.account_id = a.id)),
  max_concurrent_sources = GREATEST(
    a.max_concurrent_sources,
    COALESCE((SELECT max(g.max_concurrent) FROM groups g WHERE g.account_id = a.id), 0));

-- ONE DEFAULT GROUP per account: new channels, stations and events start in it,
-- and it cannot be removed. The oldest group of each account becomes it.
ALTER TABLE groups ADD COLUMN IF NOT EXISTS is_default BOOLEAN NOT NULL DEFAULT false;
UPDATE groups g SET is_default = true
 WHERE g.id IN (SELECT DISTINCT ON (account_id) id FROM groups ORDER BY account_id, created_at, id)
   AND NOT EXISTS (SELECT 1 FROM groups x WHERE x.account_id = g.account_id AND x.is_default);
CREATE UNIQUE INDEX IF NOT EXISTS uq_groups_one_default ON groups(account_id) WHERE is_default;
