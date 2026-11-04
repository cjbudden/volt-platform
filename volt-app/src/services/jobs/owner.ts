// ============================================================================
//  WHICH ACCOUNT A JOB BELONGS TO. Shared by the jobs API (modules/jobs.ts) and
//  the workflow report's rollup (services/workflows/rollup.ts), so both apply
//  one rule. Moved here unchanged from modules/jobs.ts (build queue W1).
// ============================================================================

/**
 * Tenant scoping. A job carries a denormalised channel_id / event_id, and both
 * lead to an account through groups. A job about a library asset that has no
 * stream (an upload or a watch folder file being encoded) carries neither: it
 * names the asset in its payload, and the asset belongs to its account
 * directly (the same rule as the library, vod.ts OWNER_ACCOUNT). Without that
 * second route `GET /api/jobs/{id}` answered 404 for the very job id the
 * upload had just returned. A job with none of these is platform-internal and
 * is not exposed here at all.
 *
 * The payload is only used to FIND the asset; the account comes from the
 * asset row, never from the payload. The CASE guard keeps a payload that is
 * not a uuid from failing the cast for the whole query (AND does not
 * promise an order of evaluation; CASE does).
 */
export const OWNED = `
  FROM jobs j
  LEFT JOIN channels c ON c.id = j.channel_id
  LEFT JOIN events   e ON e.id = j.event_id
  LEFT JOIN groups   g ON g.id = COALESCE(c.group_id, e.group_id)
  LEFT JOIN vod_assets va ON j.channel_id IS NULL AND j.event_id IS NULL
        AND va.id = CASE WHEN j.payload->>'vodAssetId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                         THEN (j.payload->>'vodAssetId')::uuid END
`;
/** The job's account, through its stream or through its library asset. */
export const ACCOUNT = `COALESCE(g.account_id, va.account_id)`;
