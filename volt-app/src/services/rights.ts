/**
 * Geo / rights evaluation for the play gate. For a live channel, the CURRENT
 * programme (EPG) governs blackout: geo_mode worldwide | allow | block against
 * the viewer's country. A blocked viewer is offered the programme's
 * replacement_asset (blackout slate / alternate) rather than nothing — the same
 * control doubles as last-minute content replacement. VOD/events default to
 * allowed until per-asset rights are modelled.
 */
import { liveOwner, cachedPlan, currentProgramme } from './viewerPath';
import { onDemandAccess, viewerContext, type ViewerInput } from './availability';
import { resolveForAsset } from './publishingRules';
import { evaluateAccessRules, type ViewerCtx } from './accessRules';
import { accountGeo, channelGeo, geoBlocks } from './geoAccess';

export interface AccessDecision {
  allowed: boolean;
  reason?: string;
  replacementAssetId?: string | null;
  /** Which layer decided: the account's geo, the on-demand availability, the
   *  channel's own geo, the access rules, the programme on air, or none. */
  layer?: 'account' | 'on_demand' | 'channel' | 'rules' | 'programme' | 'none';
}

/**
 * assetId is treated as a channel id first (live blackout is the main case); if
 * it isn't a live channel with a current programme, access defaults to allowed.
 * geo = ISO-3166 alpha-2 (from the edge / client). No geo → treated as unknown,
 * which is allowed unless a rule requires an explicit allow-list match.
 */
/** `programmes.channel_id` is a uuid column. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function evaluateAccess(assetId: string, geo?: string, ctx: { appId?: string | null; entitled?: boolean; accountId?: string | null; viewer?: ViewerInput | null; viewerCtx?: ViewerCtx | null } = {}): Promise<AccessDecision & { rule?: any; products?: any[] }> {
  // The asset id arrives from an UNAUTHENTICATED caller on the public play
  // gate. Handing a non-uuid to a uuid column raised 22P02 and the gate
  // answered 500 — a bad answer, and a free oracle besides: a stranger could
  // separate malformed ids from real ones by status code alone. An id that
  // cannot name a channel has no programme governing it, which is the same
  // answer as a channel with no programme on air.
  if (!UUID_RE.test(assetId)) return { allowed: true, layer: 'none' };
  // ACCOUNT-WIDE GEO first: above every rule, for everything the account has
  // (services/geoAccess.ts). "Nothing from Israel" cannot be undone lower down.
  if (ctx.accountId) {
    const why = geoBlocks(await accountGeo(ctx.accountId), geo, 'This content');
    if (why) return { allowed: false, reason: why, replacementAssetId: null, layer: 'account' };
  }
  // ON DEMAND FIRST. An asset with an availability record answers from it:
  // state, window, per-app publication, geo, access. Only a live owner falls
  // through to the programme rules below.
  // A verified viewer session (auth/viewerTokens.ts) arrives as a ready
  // context: no database work. Otherwise the asserted viewer is resolved.
  const vctx = ctx.viewerCtx ?? (ctx.accountId ? await viewerContext(ctx.accountId, geo, ctx.viewer ?? undefined) : null);
  const od = await onDemandAccess(assetId, geo, ctx.appId ?? null, ctx.entitled === true, vctx);
  if (od) return od.allowed ? { allowed: true, rule: od.rule, layer: 'on_demand' } : { allowed: false, reason: od.reason, replacementAssetId: null, rule: od.rule, products: od.paywall ?? undefined, layer: 'on_demand' };

  // A LIVE OWNER under the rules engine. Christian: "this" means the current
  // channel, event or station itself, whichever rung the rule sits on; the
  // linked items are the VOD / AOD assets made from its recordings.
  if (ctx.accountId) {
    // Cached (services/viewerPath.ts): the owner and its rules ladder are the
    // same for every viewer, and rule edits invalidate them through triggers.
    const owner = await liveOwner(assetId);
    // THE CHANNEL'S OWN GEO (Channel settings > Geo), a hard limit on its live stream.
    const chWhy = owner ? geoBlocks(channelGeo(owner), geo, 'This channel') : null;
    if (chWhy) return { allowed: false, reason: chWhy, replacementAssetId: null, layer: 'channel' };
    if (owner) {
      const acct = ctx.accountId;
      const plan = await cachedPlan(acct, owner, () => resolveForAsset(acct, { schema_id: owner.schema_id, channel_id: owner.kind === 'channel' ? owner.id : null, event_id: owner.kind === 'event' ? owner.id : null }));
      const rules = plan.settings.accessRules ?? [];
      if (rules.length) {
        const outcome = evaluateAccessRules(rules,
          { relation: 'this', schemaId: owner.schema_id, ownerId: owner.id },
          vctx ?? { country: geo ?? null, viewerId: null, groups: [], entitlements: [] });
        if (!outcome.allowed) return { allowed: false, reason: outcome.message, replacementAssetId: null, rule: outcome, products: outcome.products, layer: 'rules' };
        if (outcome.via !== 'no_rule') return { allowed: true, rule: outcome, layer: 'rules' };
      }
    }
  }
  // The programme on air now, cached until it ends or the next one starts
  // (services/viewerPath.ts). An EPG edit invalidates it immediately.
  const prog = await currentProgramme(assetId);
  if (!prog || prog.geo_mode === 'worldwide') return { allowed: true, layer: 'none' };

  const country = (geo || '').toUpperCase();
  const list: string[] = (prog.geo_countries || []).map((c: string) => c.toUpperCase());
  let blocked = false;
  if (prog.geo_mode === 'block') {
    blocked = !!country && list.includes(country);
  } else if (prog.geo_mode === 'allow') {
    // allow-list: only listed countries may watch; unknown geo is blocked
    blocked = !country || !list.includes(country);
  }
  if (!blocked) return { allowed: true, layer: 'programme' };
  return {
    allowed: false, layer: 'programme',
    reason: prog.geo_mode === 'block' ? `blacked out in ${country}` : `not licensed in ${country || 'your region'}`,
    replacementAssetId: prog.replacement_asset_id ?? null,
  };
}
