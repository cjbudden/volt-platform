-- Deterministic seed for the e2e harness: a fixed account / group / channel so
-- the encoder job config and the assertions can reference known IDs. No user row
-- is needed — run-e2e.sh mints a JWT with the same JWT_ACCESS_SECRET the API uses.
INSERT INTO accounts(id, name, plan_tier)
  VALUES ('00000000-0000-0000-0000-0000000000a1', 'E2E Tenant', 'enterprise');

INSERT INTO groups(id, account_id, name, max_channels, max_concurrent)
  VALUES ('00000000-0000-0000-0000-0000000000b1',
          '00000000-0000-0000-0000-0000000000a1', 'E2E Group', 10, 5);

INSERT INTO channels(id, group_id, name, status, recording_retention_days)
  VALUES ('00000000-0000-0000-0000-0000000000c1',
          '00000000-0000-0000-0000-0000000000b1', 'e2e-news', 'live', 7);
