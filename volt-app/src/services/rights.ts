/**
 * Geo / rights evaluation for the play gate. For a live channel, the CURRENT
 * programme (EPG) governs blackout: geo_mode worldwide | allow | block against
 * the viewer's country. A blocked viewer is offered the programme's
 * replacement_asset (blackout slate / alternate) rather than nothing — the same
 * control doubles as last-minute content replacement. VOD/events default to
 * allowed until per-asset rights are modelled.
 */
import { one } from '../db';
import { onDemandAccess, viewerContext, type ViewerInput } from './availability';
import { resolveForAsset } from './publishingRules';
import { evaluateAccessRules } from './accessRules';

export interface AccessDecision {
  allowed: boolean;
  reason?: string;
  replacementAssetId?: string | null;
}

/**
 * assetId is treated as a channel id first (live blackout is the main case); if
 * it isn't a live channel with a current programme, access defaults to allowed.
 * geo = ISO-3166 alpha-2 (from the edge / client). No geo → treated as unknown,
 * which is allowed unless a rule requires an explicit allow-list match.
 */
/** `programmes.channel_id` is a uuid column. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function evaluateAccess(assetId: string, geo?: string, ctx: { appId?: string | null; entitled?: boolean; accountId?: string | null; viewer?: ViewerInput | null } = {}): Promise<AccessDecision & { rule?: any; products?: any[] }> {
  // The asset id arrives from an UNAUTHENTICATED caller on the public play
  // gate. Handing a non-uuid to a uuid column raised 22P02 and the gate
  // answered 500 — a bad answer, and a free oracle besides: a stranger could
  // separate malformed ids from real ones by status code alone. An id that
  // cannot name a channel has no programme governing it, which is the same
  // answer as a channel with no programme on air.
  if (!UUID_RE.test(assetId)) return { allowed: true };
  // ON DEMAND FIRST. An asset with an availability record answers from it:
  // state, window, per-app publication, geo, access. Only a live owner falls
  // through to the programme rules below.
  const vctx = ctx.accountId ? await viewerContext(ctx.accountId, geo, ctx.viewer ?? undefined) : null;
  const od = await onDemandAccess(assetId, geo, ctx.appId ?? null, ctx.entitled === true, vctx);
  if (od) return od.allowed ? { allowed: true, rule: od.rule } : { allowed: false, reason: od.reason, replacementAssetId: null, rule: od.rule, products: od.paywall ?? undefined };

  // A LIVE OWNER under the rules engine: the owner's own rung means 'this',
  // a rule from its type or the account means linked live content.
  if (ctx.accountId) {
    const owner = await one<any>(
      `SELECT c.id, c.schema_id, 'channel' AS kind FROM channels c WHERE c.id = $1
       UNION ALL SELECT e.id, e.schema_id, 'event' FROM events e WHERE e.id = $1`, [assetId]);
    if (owner) {
      const plan = await resolveForAsset(ctx.accountId, { schema_id: owner.schema_id, channel_id: owner.kind === 'channel' ? owner.id : null, event_id: owner.kind === 'event' ? owner.id : null });
      const rules = plan.settings.accessRules ?? [];
      if (rules.length) {
        const outcome = evaluateAccessRules(rules,
          { relation: plan.sources.accessRules === 'owner' ? 'this' : 'live', schemaId: owner.schema_id, ownerId: owner.id },
          vctx ?? { country: geo ?? null, viewerId: null, groups: [], entitlements: [] });
        if (!outcome.allowed) return { allowed: false, reason: outcome.message, replacementAssetId: null, rule: outcome, products: outcome.products };
        if (outcome.via !== 'no_rule') return { allowed: true, rule: outcome };
      }
    }
  }
  const prog = await one<any>(
    `SELECT geo_mode, geo_countries, replacement_asset_id
       FROM programmes WHERE channel_id=$1 AND span @> now()
       ORDER BY starts_at DESC LIMIT 1`,
    [assetId]
  );
  if (!prog || prog.geo_mode === 'worldwide') return { allowed: true };

  const country = (geo || '').toUpperCase();
  const list: string[] = (prog.geo_countries || []).map((c: string) => c.toUpperCase());
  let blocked = false;
  if (prog.geo_mode === 'block') {
    blocked = !!country && list.includes(country);
  } else if (prog.geo_mode === 'allow') {
    // allow-list: only listed countries may watch; unknown geo is blocked
    blocked = !country || !list.includes(country);
  }
  if (!blocked) return { allowed: true };
  return {
    allowed: false,
    reason: prog.geo_mode === 'block' ? `blacked out in ${country}` : `not licensed in ${country || 'your region'}`,
    replacementAssetId: prog.replacement_asset_id ?? null,
  };
}
