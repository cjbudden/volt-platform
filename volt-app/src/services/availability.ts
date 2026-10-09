// ============================================================================
//  AVAILABILITY — applying a resolved publishing plan to an asset, and the
//  states it moves through afterwards.
//
//    draft      never published
//    scheduled  published, window not open yet
//    available  published, window open
//    expired    window closed (by the sweep)
//    withdrawn  access removed by a person; kept, with its history
//
//  publish() is the one door: the library's Publish button, the auto-publish
//  on build, and the old per-platform route all come through here, so the
//  gate, the window, the geo and the publication rows are decided once. The
//  publications it writes are the client's publishing points only (portal,
//  a registered app, a configured social account), as validated by the
//  rules service.
// ============================================================================
import { query, one } from '../db';
import { publishGate } from './review';
import { resolveForAsset, windowFor, type Target, type Resolved } from './publishingRules';
import { evaluateAccessRules, type ViewerCtx, type AccessOutcome } from './accessRules';
import { upsertViewer, viewerEntitlements } from './entitlements';

export interface PublishOutcome {
  asset: any;
  plan: Resolved;
  publications: any[];
  state: 'scheduled' | 'available';
}

export class NotPublishable extends Error {
  code: string;
  constructor(code: string, message: string) { super(message); this.code = code; }
}

/** Account id for an asset, through its owner's group. */
export async function assetAccount(assetId: string): Promise<{ asset: any; accountId: string } | null> {
  const row = await one<any>(
    `SELECT v.*, g.account_id AS _account
       FROM vod_assets v
       LEFT JOIN channels c ON c.id = v.channel_id
       LEFT JOIN events   e ON e.id = v.event_id
       JOIN groups g ON g.id = COALESCE(c.group_id, e.group_id)
      WHERE v.id = $1`, [assetId]);
  if (!row) return null;
  const { _account, ...asset } = row;
  return { asset, accountId: _account };
}

/**
 * Publish an asset according to its resolved plan (or the plan given).
 * `targets` overrides the plan's targets for this one publish (a manual
 * "just YouTube this time"); everything else comes from the ladder.
 */
export async function publish(assetId: string, by: string, opts: { targets?: Target[]; auto?: boolean; posts?: Record<string, any> } = {}): Promise<PublishOutcome> {
  const found = await assetAccount(assetId);
  if (!found) throw new NotPublishable('not_found', 'Asset not found');
  const { asset, accountId } = found;
  const plan = await resolveForAsset(accountId, asset);
  const s = plan.settings;

  // THE GATE, from the ladder and from the account's review settings both.
  const gate = await publishGate(assetId);
  if (!gate.allowed) throw new NotPublishable(gate.code, gate.message);
  // Publishing over a QC finding is allowed and is recorded on the review
  // trail: a check that blocks outright is a check people route around.
  if (gate.wouldOverride) {
    await query(
      `INSERT INTO asset_reviews(vod_asset_id, actor_id, actor_label, from_state, to_state, note, overrode_qc, qc_state_at_decision)
       VALUES ($1, NULL, $2, $3::review_state, $3::review_state, $4, true, $5)`,
      [assetId, by, asset.review_state ?? 'draft', `Published with QC ${gate.qcState}.`, gate.qcState]).catch(() => {});
  }
  if (s.gate.requireReview && (asset.review_state ?? 'draft') !== 'approved')
    throw new NotPublishable('not_approved', `The publishing rule requires review, and this asset is ${String(asset.review_state ?? 'draft').replace('_', ' ')}.`);
  if (s.gate.blockOnQcFail && asset.qc_state === 'failed')
    throw new NotPublishable('qc_failed', 'The publishing rule blocks publishing while QC has failed.');
  if (opts.auto && !s.autoPublish) throw new NotPublishable('manual_only', 'This asset is published by hand under its rules.');

  const { from, until } = windowFor(s);
  const now = new Date();
  const state: 'scheduled' | 'available' = from > now ? 'scheduled' : 'available';
  const targets = opts.targets ?? s.targets;

  const stamp = {
    buildAt: asset.built_at ?? null, review: asset.review_state ?? 'draft', qc: asset.qc_state ?? null,
    durationMs: asset.duration_ms ?? null, by,
  };
  const pubs: any[] = [];
  for (const t of targets) {
    if (t.kind === 'portal') {
      pubs.push(await one(
        `INSERT INTO publications(vod_asset_id, platform, status, external_url, published_at,
            published_build_at, published_review_state, published_qc_state, published_duration_ms, published_by)
         VALUES ($1,'portal','published',$2, now(), $3,$4,$5,$6,$7) RETURNING *`,
        [assetId, `/portal/watch/${assetId}`, stamp.buildAt, stamp.review, stamp.qc, stamp.durationMs, by]));
    } else if (t.kind === 'app') {
      const app = await one<any>(`SELECT id, name FROM apps WHERE id = $1 AND account_id = $2`, [t.appId, accountId]);
      if (!app) continue;
      pubs.push(await one(
        `INSERT INTO publications(vod_asset_id, platform, app_id, status, external_url, published_at,
            published_build_at, published_review_state, published_qc_state, published_duration_ms, published_by)
         VALUES ($1,'app',$2,'published',$3, now(), $4,$5,$6,$7,$8) RETURNING *`,
        [assetId, app.id, `app://${app.id}/${assetId}`, stamp.buildAt, stamp.review, stamp.qc, stamp.durationMs, by]));
    } else if (t.kind === 'social') {
      const target = await one<any>(
        `SELECT * FROM publish_targets WHERE id = $1 AND account_id = $2 AND enabled = true`, [t.targetId, accountId]);
      if (!target) continue;
      // THE REAL UPLOAD, as a job (services/social): the row starts pending
      // with the post the person wrote (or the asset's own title, description
      // and tags), and the job moves it to published or failed with progress.
      const social = await import('./social');
      const given = opts.posts?.[target.id];
      const { post } = social.fitPost(target.platform, given ?? social.defaultPost(asset, target.platform));
      const pub = await one<any>(
        `INSERT INTO publications(vod_asset_id, platform, target_id, status, post, progress, stage,
            published_build_at, published_review_state, published_qc_state, published_duration_ms, published_by)
         VALUES ($1,$2::publish_platform,$3,'pending',$4::jsonb,0,'queued',$5,$6,$7,$8,$9) RETURNING *`,
        [assetId, target.platform, target.id, JSON.stringify(post), stamp.buildAt, stamp.review, stamp.qc, stamp.durationMs, by]);
      await social.queueSocialPublication(pub.id, null);
      pubs.push(await one(`SELECT * FROM publications WHERE id = $1`, [pub.id]));
    }
  }

  const portal = targets.some((t) => t.kind === 'portal');
  const updated = await one<any>(
    `UPDATE vod_assets SET
       availability = $2::jsonb, availability_sources = $3::jsonb,
       availability_state = $4, available_from = $5, available_until = $6,
       withdrawn_at = NULL, withdrawn_by = NULL,
       published = true, portal_visible = $7, updated_at = now()
     WHERE id = $1 RETURNING *`,
    [assetId, JSON.stringify({ ...s, targets }), JSON.stringify(plan.sources), state, from, until, portal]);
  return { asset: updated, plan, publications: pubs, state };
}

/** Remove access now. The asset stays, with its history; nothing serves it. */
export async function withdraw(assetId: string, by: string, reason?: string): Promise<any> {
  const row = await one<any>(
    `UPDATE vod_assets SET availability_state = 'withdrawn', withdrawn_at = now(), withdrawn_by = $2,
            published = false, portal_visible = false, updated_at = now()
      WHERE id = $1 RETURNING *`, [assetId, `${by}${reason ? `: ${reason}` : ''}`.slice(0, 300)]);
  if (!row) return null;
  await query(`UPDATE publications SET status = 'withdrawn' WHERE vod_asset_id = $1 AND status IN ('published', 'pending')`, [assetId]);
  return row;
}

/** Put a withdrawn or expired asset back through its rules. */
export async function republish(assetId: string, by: string): Promise<PublishOutcome> {
  await query(`UPDATE publications SET status = 'removed' WHERE vod_asset_id = $1 AND status = 'withdrawn'`, [assetId]);
  return publish(assetId, by);
}

/**
 * The clock: open scheduled windows, close expired ones. Run on the scheduler
 * tick; cheap because of the partial index on the two moving states.
 */
export async function sweepAvailability(): Promise<{ opened: number; expired: number }> {
  const opened = await query(
    `UPDATE vod_assets SET availability_state = 'available', updated_at = now()
      WHERE availability_state = 'scheduled' AND available_from <= now() RETURNING id`);
  const expired = await query(
    `UPDATE vod_assets SET availability_state = 'expired', published = false, portal_visible = false, updated_at = now()
      WHERE availability_state IN ('available', 'scheduled') AND available_until IS NOT NULL AND available_until <= now() RETURNING id`);
  for (const r of expired) {
    await query(`UPDATE publications SET status = 'removed' WHERE vod_asset_id = $1 AND status = 'published'`, [r.id]).catch(() => {});
  }
  return { opened: opened.length, expired: expired.length };
}

/**
 * What the play gate asks: may this asset be served, to this viewer, now?
 * Returns null when the id is not an on-demand asset (the caller then falls
 * through to the live rules).
 */
export interface ViewerInput { externalId?: string | null; groups?: string[]; email?: string | null }

/** Build the evaluator's view of the viewer: identity, groups, live entitlements. */
export async function viewerContext(accountId: string, geo: string | undefined, viewer: ViewerInput | undefined): Promise<ViewerCtx> {
  if (!viewer?.externalId) return { country: geo ?? null, viewerId: null, groups: [], entitlements: [] };
  const v = await upsertViewer(accountId, viewer.externalId, { email: viewer.email ?? null, groups: viewer.groups });
  return { country: geo ?? null, viewerId: v.id, groups: v.groups ?? [], entitlements: await viewerEntitlements(v.id) };
}

export async function onDemandAccess(assetId: string, geo?: string, appId?: string | null, entitled = false, viewer?: ViewerCtx | null):
  Promise<{ allowed: boolean; reason?: string; paywall?: any; rule?: AccessOutcome } | null> {
  const a = await one<any>(
    `SELECT availability_state, availability, availability_sources, available_from, available_until, published, schema_id, channel_id, event_id
       FROM vod_assets WHERE id = $1`, [assetId]);
  if (!a) return null;
  const st = a.availability_state ?? 'draft';
  if (st === 'withdrawn') return { allowed: false, reason: 'this content is no longer available' };
  if (st === 'expired') return { allowed: false, reason: 'this content is no longer available' };
  if (st === 'scheduled') return { allowed: false, reason: `available from ${new Date(a.available_from).toISOString()}` };
  if (st === 'draft') {
    // Assets from before availability existed: `published` still decides.
    if (!a.published) return { allowed: false, reason: 'not published' };
    return { allowed: true };
  }
  const s = a.availability ?? {};
  // PER-APP PUBLISHING. When the plan names apps, only those apps may play it.
  const targets: Target[] = Array.isArray(s.targets) ? s.targets : [];
  const appTargets = targets.filter((t): t is Extract<Target, { kind: 'app' }> => t.kind === 'app');
  if (appTargets.length && appId && !appTargets.some((t) => t.appId === appId)) {
    return { allowed: false, reason: 'not published to this app' };
  }
  // THE RULES ENGINE FIRST. FOR / IF / THEN decides for the content it
  // governs; the simple fields below are the fallback for content no rule
  // matches (and for assets published before the rules existed).
  const rules = Array.isArray(s.accessRules) ? s.accessRules : [];
  if (rules.length) {
    const fromAsset = a.availability_sources?.accessRules === 'asset';
    const outcome = evaluateAccessRules(rules,
      { relation: fromAsset ? 'this' : 'ondemand', schemaId: a.schema_id, assetId, ownerId: a.channel_id ?? a.event_id },
      viewer ?? { country: geo ?? null, viewerId: null, groups: [], entitlements: [] });
    if (outcome.allowed) { if (outcome.via !== 'no_rule') return { allowed: true, rule: outcome }; }
    else return { allowed: false, reason: outcome.message, paywall: outcome.products ?? null, rule: outcome };
  }
  const g = s.geo ?? { mode: 'worldwide', countries: [] };
  const country = (geo || '').toUpperCase();
  const list: string[] = (g.countries || []).map((c: string) => String(c).toUpperCase());
  if (g.mode === 'block' && country && list.includes(country)) return { allowed: false, reason: `not available in ${country}` };
  if (g.mode === 'allow' && (!country || !list.includes(country))) return { allowed: false, reason: `not available in ${country || 'your region'}` };
  const hasEntitlement = entitled || !!(viewer?.entitlements?.length);
  if ((s.access === 'entitled' || s.access === 'paid') && !hasEntitlement) {
    return { allowed: false, reason: s.access === 'paid' ? 'payment required' : 'entitlement required', paywall: s.paywall ?? null };
  }
  return { allowed: true };
}

/**
 * A freshly built asset publishes itself when its rules say so. Called by the
 * clip extract handler once the files exist. A refusal (the gate, a rule that
 * says manual) is not an error: it is logged and the asset waits for a person.
 */
export async function autoPublishOnBuild(assetId: string): Promise<'published' | 'scheduled' | 'skipped'> {
  const found = await assetAccount(assetId);
  if (!found) return 'skipped';
  if (['available', 'scheduled', 'withdrawn'].includes(found.asset.availability_state)) return 'skipped';
  const plan = await resolveForAsset(found.accountId, found.asset);
  if (!plan.settings.autoPublish) return 'skipped';
  try {
    const out = await publish(assetId, 'system: auto-publish rule', { auto: true });
    console.log(`[availability] auto-published ${assetId} (${out.state}) to ${out.publications.length} point(s)`);
    return out.state === 'scheduled' ? 'scheduled' : 'published';
  } catch (e: any) {
    if (e instanceof NotPublishable) { console.log(`[availability] ${assetId} not auto-published: ${e.message}`); return 'skipped'; }
    throw e;
  }
}
