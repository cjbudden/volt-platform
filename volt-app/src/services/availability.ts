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
import { touchViewer, cachedEntitlements, vodAvailabilityRow } from './viewerPath';
import { collectionGate, kindsFor } from './collectionAccess';
import { rightsForAsset, rightsForAssetId, evaluateRights, accessAllowed, accessKindsFor, appAllowed, appTypeOf, type RightsAppType } from './rightsProfiles';

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
    // An uploaded or watch-folder asset has no channel or event, so it
    // belongs to its account directly (as in the library, vod.ts
    // OWNER_ACCOUNT). Resolving through the group only made Publish and
    // Remove access answer "Asset not found" for every upload (found
    // walking the From upload to published guide, build queue 1.14-G5).
    `SELECT v.*, COALESCE(g.account_id, v.account_id) AS _account
       FROM vod_assets v
       LEFT JOIN channels c ON c.id = v.channel_id
       LEFT JOIN events   e ON e.id = v.event_id
       LEFT JOIN groups g ON g.id = COALESCE(c.group_id, e.group_id)
      WHERE v.id = $1`, [assetId]);
  if (!row || !row._account) return null;
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

  // THE RIGHTS CAP (build queue R1). Nothing is published that the rights do
  // not allow on demand, and the window is always inside the rights window.
  const rights = (await rightsForAssetId(assetId))!;
  if (!rights.uses.includes('on_demand')) {
    throw new NotPublishable('rights', `The rights (${rights.profileName}) do not allow this asset on demand.`);
  }
  // "Now" is taken after the window, as before: a window that opens at
  // publish must not read as a millisecond in the future (scheduled).
  // The moment of publishing is kept on the stamp (publishedAt): when a rule
  // changes later, a window "for 30 days from publish" still counts from
  // here, not from the change (restampPublished, build queue P3-4).
  const publishedAt = new Date();
  let { from, until } = windowFor(s, publishedAt);
  const now = new Date();
  if (rights.until && rights.until <= now) throw new NotPublishable('rights', `The rights window (${rights.profileName}) has ended.`);
  if (rights.from && from < rights.from) from = rights.from;
  if (rights.until && (!until || until > rights.until)) until = rights.until;
  const state: 'scheduled' | 'available' = from > now ? 'scheduled' : 'available';
  // Asked for by name (Publish to social), a point the rights rule out is refused with the reason.
  if (opts.targets?.some((t) => t.kind === 'social') && !rights.uses.includes('social')) {
    throw new NotPublishable('rights', `The rights (${rights.profileName}) do not allow social posting.`);
  }
  // Publishing points the rights rule out are left out: social when the rights
  // do not allow social, an app the rights do not allow.
  const appTypes = new Map<string, RightsAppType>((await query<any>(`SELECT id, type, surface FROM apps WHERE account_id = $1`, [accountId])).map((r) => [String(r.id), appTypeOf(r.type, r.surface)]));
  const targets = (opts.targets ?? s.targets).filter((t) =>
    t.kind === 'social' ? rights.uses.includes('social')
      : t.kind === 'app' ? appAllowed(rights, appTypes.get(t.appId) ?? null, t.appId)
      : true);

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
      // An X account is skipped while X is off for the account (build queue 1.14h), as a disabled one is.
      if (target.platform === 'x' && !(await (await import('./social')).xAccess(accountId)).allowed) continue;
      // THE REAL UPLOAD, as a job (services/social): the row starts pending
      // with the post the person wrote (or the asset's own title, description
      // and tags), and the job moves it to published or failed with progress.
      const social = await import('./social');
      const given = opts.posts?.[target.id];
      const { post } = social.fitPost(target.platform, given ?? social.defaultPost(asset, target.platform));
      const pub = await one<any>(
        `INSERT INTO publications(vod_asset_id, platform, target_id, status, post, progress, stage,
            published_build_at, published_review_state, published_qc_state, published_duration_ms, published_by)
         VALUES ($1,$2::text,$3,'pending',$4::jsonb,0,'queued',$5,$6,$7,$8,$9) RETURNING *`,
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
    [assetId, JSON.stringify({ ...s, targets, publishedAt: publishedAt.toISOString() }), JSON.stringify(plan.sources), state, from, until, portal]);
  // The public status follows at once (build queue P1), not at the next sweep.
  await (await import('./publicStatus')).refreshPublicStatus(assetId);
  // COPY RULES for publish (Mirror and Archive, H3-3). Never fails the publish.
  await (await import('./archive/archive')).copyOnRule(accountId, assetId, 'publish');
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
  await (await import('./publicStatus')).refreshPublicStatus(assetId);
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
export async function sweepAvailability(): Promise<{ opened: number; expired: number; statuses?: number; restamped?: number }> {
  const opened = await query(
    `UPDATE vod_assets SET availability_state = 'available', updated_at = now()
      WHERE availability_state = 'scheduled' AND available_from <= now() RETURNING id`);
  const expired = await query(
    `UPDATE vod_assets SET availability_state = 'expired', published = false, portal_visible = false, updated_at = now()
      WHERE availability_state IN ('available', 'scheduled') AND available_until IS NOT NULL AND available_until <= now() RETURNING id`);
  for (const r of expired) {
    await query(`UPDATE publications SET status = 'removed' WHERE vod_asset_id = $1 AND status = 'published'`, [r.id]).catch(() => {});
  }
  // Published titles whose rules changed take up the new rules (build queue
  // P3-4), before the public status pass below so it sees what they became.
  const restamp = await restampFor(20_000)
    .catch((e: any) => { console.warn('[availability] restamp after a rule change failed:', e?.message ?? e); return null; });
  // The public status (build queue P1): the rows just opened or closed, and
  // any row whose next moment has come or that changed since it was computed.
  const statuses = await (await import('./publicStatus')).sweepPublicStatus()
    .catch((e: any) => { console.warn('[availability] public status sweep failed:', e?.message ?? e); return 0; });
  return { opened: opened.length, expired: expired.length, statuses, restamped: restamp?.changed ?? 0 };
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
  // Written at most once per CACHE_VIEWER_TOUCH_SEC per viewer (a changed
  // email or group list writes at once), entitlements cached and dropped on
  // any purchase or grant. See services/viewerPath.ts.
  const opts = { email: viewer.email ?? null, groups: viewer.groups };
  const externalId = viewer.externalId;
  const v = await touchViewer(accountId, externalId, opts, () => upsertViewer(accountId, externalId, opts));
  return { country: geo ?? null, viewerId: v.id, groups: v.groups ?? [], entitlements: await cachedEntitlements(v.id, () => viewerEntitlements(v.id)) };
}

export async function onDemandAccess(assetId: string, geo?: string, appId?: string | null, entitled = false, viewer?: ViewerCtx | null, appType?: RightsAppType | null, at?: Date):
  Promise<{ allowed: boolean; reason?: string; paywall?: any; rule?: AccessOutcome; rights?: boolean } | null> {
  const a = await vodAvailabilityRow(assetId);   // cached; edits and the availability clock invalidate it
  if (!a) return null;
  const st = a.availability_state ?? 'draft';
  // `at`: the who-can-watch tester asking about another moment (build queue
  // P1-2). Its caller has already found the title public at that moment from
  // the public status (services/whoCanWatch.ts), which is what the stored
  // state says only for now, so the state checks are skipped and the rights
  // are read at that moment. The play gate never passes it.
  if (!at) {
    if (st === 'withdrawn') return { allowed: false, reason: 'this content is no longer available' };
    if (st === 'expired') return { allowed: false, reason: 'this content is no longer available' };
    if (st === 'scheduled') return { allowed: false, reason: `available from ${new Date(a.available_from).toISOString()}` };
    if (st === 'draft' && !a.published) return { allowed: false, reason: 'not published' };
  }
  // THE RIGHTS CAP (build queue R1), before collection access and the policy:
  // outside the rights nothing below can let the viewer in. The profile is
  // cached by id, so a warm gate still makes no database reads.
  const rights = await rightsForAsset(a);
  const capped = evaluateRights(rights, { country: geo ?? null, appType: appType ?? null, appId: appId ?? null, use: 'on_demand', at });
  if (!capped.allowed) return { allowed: false, reason: capped.reason, rights: true };
  // COLLECTION ACCESS (build queue C2, services/collectionAccess.ts): the
  // collections the title is in, compiled onto the cached row, most
  // restrictive per app and region. It can only add a requirement: a title
  // that a collection makes premium here needs one of its packages, and the
  // rules below must still let the viewer in too. Rights cap it like the rest.
  const cg = collectionGate(a.collection_access, { appId: appId ?? null, country: geo ?? null, viewer, entitled });
  if (cg) {
    if (!accessAllowed(rights, kindsFor(cg.cell))) return { allowed: false, reason: 'The rights do not allow this kind of access.', rights: true };
    if (!cg.allowed) {
      // Only what the rights allow to be sold is offered.
      const sellable = cg.products.filter((t) => accessAllowed(rights, accessKindsFor('entitlement', undefined, [t])));
      const rule = { allowed: false, reason: cg.reason, message: cg.message, products: sellable, packages: cg.cell.packages, layer: 'collection' } as any;
      return { allowed: false, reason: cg.message, paywall: cg.reason === 'payment_required' ? sellable : null, rule };
    }
  }
  const viaCollection = cg?.allowed ? cg.via : null;
  // Assets from before availability existed: `published` still decides.
  if (st === 'draft') return cg?.allowed || accessAllowed(rights, ['free']) ? { allowed: true } : { allowed: false, reason: 'The rights do not allow free access.', rights: true };
  // Whatever lets the viewer in must be an access type the rights allow.
  const outsideRights = (kinds: ReturnType<typeof accessKindsFor>) => !accessAllowed(rights, kinds);
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
    if (outcome.allowed) {
      if (outcome.via !== 'no_rule') {
        const terms = rules.find((r: any) => r.id === outcome.ruleId)?.then.terms ?? null;
        if (outsideRights(accessKindsFor(outcome.via, undefined, terms))) return { allowed: false, reason: 'The rights do not allow this kind of access.', rights: true };
        // Let in by a collection package as well: a paying viewer (ad-free).
        return { allowed: true, rule: viaCollection === 'entitlement' ? { ...outcome, via: 'entitlement' } as AccessOutcome : outcome };
      }
    } else {
      // A paywall offers only what the rights allow to be sold.
      if (outcome.reason === 'payment_required' && outcome.products?.length) {
        const sellable = outcome.products.filter((t) => accessAllowed(rights, accessKindsFor('entitlement', undefined, [t])));
        if (!sellable.length) return { allowed: false, reason: 'The rights do not allow this kind of access.', rights: true };
        return { allowed: false, reason: outcome.message, paywall: sellable, rule: { ...outcome, products: sellable } };
      }
      return { allowed: false, reason: outcome.message, paywall: outcome.products ?? null, rule: outcome };
    }
  }
  const g = s.geo ?? { mode: 'worldwide', countries: [] };
  const country = (geo || '').toUpperCase();
  const list: string[] = (g.countries || []).map((c: string) => String(c).toUpperCase());
  if (g.mode === 'block' && country && list.includes(country)) return { allowed: false, reason: `not available in ${country}` };
  if (g.mode === 'allow' && (!country || !list.includes(country))) return { allowed: false, reason: `not available in ${country || 'your region'}` };
  if (outsideRights(accessKindsFor(undefined, s.access ?? 'free'))) return { allowed: false, reason: 'The rights do not allow this kind of access.', rights: true };
  const hasEntitlement = entitled || !!(viewer?.entitlements?.length);
  if ((s.access === 'entitled' || s.access === 'paid') && !hasEntitlement) {
    return { allowed: false, reason: s.access === 'paid' ? 'payment required' : 'entitlement required', paywall: s.paywall ?? null };
  }
  // A viewer let in by what they paid for: on-demand ads (services/vodAds) make them ad-free.
  // A package from a collection makes the viewer a paying one too (ad-free).
  return (s.access === 'entitled' || s.access === 'paid' || viaCollection === 'entitlement') ? { allowed: true, rule: { allowed: true, via: 'entitlement' } as AccessOutcome } : { allowed: true };
}

/**
 * THE OTHER TWO MOMENTS A RULE CAN PUBLISH (build queue 1.14-G5a). Auto-publish
 * used to run only when a clip finished building, so two things its rules said
 * should publish never did:
 *   - an asset held for review: the build ran, the gate said "not approved",
 *     and approving it later published nothing;
 *   - a full-event replay (Automatic VOD on end, Publish full VOD): it is made
 *     straight from the finished recording, with no build, so nothing asked.
 *
 * Only assets cut from a recording (clips and full-event replays), as before:
 * whether finished uploads and watch folder files should publish themselves is
 * Christian's call and is asked in the build queue. A clip that is still
 * building is left to its build, which asks itself when the files exist.
 * Never throws: a refusal or a failure leaves the asset for a person.
 */
export async function autoPublishWhenReady(assetId: string, why: 'approved' | 'full_event'): Promise<'published' | 'scheduled' | 'skipped'> {
  try {
    const a = await one<any>(`SELECT id, recording_id FROM vod_assets WHERE id = $1`, [assetId]);
    if (!a?.recording_id) return 'skipped';
    const building = await one<any>(
      `SELECT 1 FROM jobs WHERE type = 'clip.extract' AND state IN ('queued', 'running')
          AND payload->>'vodAssetId' = $1 LIMIT 1`, [assetId]);
    if (building) return 'skipped';
    return await autoPublishOnBuild(assetId);
  } catch (e: any) {
    console.warn(`[availability] auto-publish (${why}) failed for ${assetId}:`, e?.message ?? e);
    return 'skipped';
  }
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

// ============================================================================
//  A RULE CHANGE REACHES PUBLISHED TITLES (build queue P3-4,
//  PUBLISHING_POLICIES.md "Encode-time vs delivery-time fields").
//
//  publish() stamps the resolved settings on the title, and the play gate
//  reads that stamp, so before this a changed rule reached a published title
//  only when someone published it again. Now a save marks the published
//  titles the rule governs (markPolicyStale, one UPDATE) and the availability
//  sweep, once a minute, stamps them again from the rules as they now stand,
//  500 at a time (restampStale). The save also starts the first batch at
//  once, so on most accounts the change is live before the editor closes.
//
//  What a restamp changes is the delivery-time part only: windows, access,
//  geo, the access rules, the protection fields other than DRM, distribution
//  and retention. It keeps:
//    - where the title was published (targets): that was an act with its own
//      publication rows, and posting to social accounts again is never done
//      by a rule change;
//    - DRM: it changes the files, so the title keeps the protection its files
//      have until it is packaged again (P4), never a weaker one;
//    - the moment it was published, which relative windows count from.
// ============================================================================

/** When the title was published, for windows that count from publishing. */
export function publishedAnchor(row: { availability?: any; available_from?: any }, now = new Date()): Date {
  const at = row.availability?.publishedAt;
  if (at && !Number.isNaN(Date.parse(at))) return new Date(at);
  // Stamped before publishedAt was kept: the window opened when it was
  // published unless the rule named a date, so available_from is the closest.
  return row.available_from ? new Date(row.available_from) : now;
}

/**
 * PURE. The stamp, window and state a published title gets from `plan` (the
 * rules as they now stand), given what it was published with (`was`), when
 * it was published, its rights window and the time. The same cap as
 * publish(): the window always stays inside the rights window.
 */
export function restampPublished(was: any, plan: Resolved['settings'],
  o: { anchor: Date; rights: { from: Date | null; until: Date | null }; now: Date }):
  { availability: any; from: Date; until: Date | null; state: 'scheduled' | 'available' | 'expired' } {
  let { from, until } = windowFor(plan, o.anchor);
  if (o.rights.from && from < o.rights.from) from = o.rights.from;
  if (o.rights.until && (!until || until > o.rights.until)) until = o.rights.until;
  const state = until && until <= o.now ? 'expired' : from > o.now ? 'scheduled' : 'available';
  const prev = was && typeof was === 'object' ? was : {};
  const availability = {
    ...plan,
    targets: Array.isArray(prev.targets) ? prev.targets : plan.targets,
    // Encodes are packaged in the clear today (vodEncode records drm 'clear'),
    // so a stamp from before the protection section had none.
    protection: { ...plan.protection, drm: typeof prev.protection?.drm === 'boolean' ? prev.protection.drm : false },
    publishedAt: o.anchor.toISOString(),
  };
  return { availability, from, until, state };
}

/**
 * Mark the published titles a rung governs, for the sweep to stamp again.
 * One statement whatever the number of titles. Returns how many were marked.
 */
export async function markPolicyStale(accountId: string,
  scope: { kind: 'account' | 'schema' | 'owner' | 'metadata'; id: string | null } | { kind: 'assets'; id: null; ids: string[] }): Promise<number> {
  // 'assets' (build queue P3-2c): a bulk save of the titles' own overrides in
  // the Media Library marks just those titles, and the sweep stamps them as it
  // stamps a rule change (a single title's save re-applies at once instead).
  if (scope.kind === 'assets' && !scope.ids.length) return 0;
  // A metadata rule can move any title of the account (its conditions or its
  // place in the order changed), so its change marks them all; the restamp
  // writes only the titles whose stamp really changes.
  const where = scope.kind === 'account' || scope.kind === 'metadata' ? '' : scope.kind === 'schema' ? 'AND x.schema_id = $2'
    : scope.kind === 'assets' ? 'AND x.id = ANY($2::uuid[])' : 'AND (x.channel_id = $2 OR x.event_id = $2)';
  // A title recorded from a channel or event belongs to the account through
  // its group (as in assetAccount); an upload directly.
  const rows = await query<any>(
    `UPDATE vod_assets v SET policy_stale_at = now()
       FROM vod_assets x
       LEFT JOIN channels c ON c.id = x.channel_id
       LEFT JOIN events   e ON e.id = x.event_id
       LEFT JOIN groups   g ON g.id = COALESCE(c.group_id, e.group_id)
      WHERE x.id = v.id AND COALESCE(g.account_id, x.account_id) = $1
        AND x.availability_state IN ('scheduled', 'available') AND x.archived_at IS NULL ${where}
      RETURNING v.id`, where ? [accountId, scope.kind === 'assets' ? scope.ids : scope.id] : [accountId]);
  return rows.length;
}

export interface RestampResult { checked: number; changed: number; unavailable: number }

/**
 * Stamp up to `limit` marked titles again from the rules as they stand. The
 * claim clears the mark in one statement with SKIP LOCKED, so two API tasks
 * (the sweep on one, a save on another) never take the same title; a title
 * that fails is marked again for the next sweep. Writes only what changed.
 */
export async function restampStale(limit = 500, now: Date = new Date()): Promise<RestampResult> {
  const claimed = await query<{ id: string }>(
    `UPDATE vod_assets SET policy_stale_at = NULL
      WHERE id IN (SELECT id FROM vod_assets WHERE policy_stale_at IS NOT NULL
                    ORDER BY policy_stale_at LIMIT $1 FOR UPDATE SKIP LOCKED)
      RETURNING id`, [limit]);
  const out: RestampResult = { checked: 0, changed: 0, unavailable: 0 };
  if (!claimed.length) return out;
  const rows = await query<any>(
    `SELECT v.id, v.schema_id, v.channel_id, v.event_id, v.availability_override, v.availability, v.availability_state,
            v.available_from, v.available_until, v.rights_profile_id, v.rights_narrow, v.created_at, v.first_aired_at,
            COALESCE(g.account_id, v.account_id) AS _account
       FROM vod_assets v
       LEFT JOIN channels c ON c.id = v.channel_id
       LEFT JOIN events   e ON e.id = v.event_id
       LEFT JOIN groups   g ON g.id = COALESCE(c.group_id, e.group_id)
      WHERE v.id = ANY($1::uuid[]) AND v.availability_state IN ('scheduled', 'available') AND v.archived_at IS NULL`,
    [claimed.map((r) => r.id)]);
  const { resolveWith, stableJson } = await import('./publishingPolicies');
  const { fastEligibleOf } = await import('./deliveryPolicy');
  // Titles whose new stamp takes FAST eligibility away, by account: they leave
  // the FAST lineups they are in once the batch is stamped (build queue P3-4c).
  const fastOff = new Map<string, string[]>();
  const { invalidateTag } = await import('../scale/cache');
  const { refreshPublicStatus } = await import('./publicStatus');
  // The account's rules are read once per batch, not once per title, and the
  // metadata rule each title meets first (P3-3) is one query per account.
  const rules = new Map<string, any[]>();
  const matched = new Map<string, Map<string, any>>();
  const { loadRules, firstMatches } = await import('./publishingMetadataRules');
  for (const a of rows) {
    out.checked++;
    try {
      if (!rules.has(a._account)) rules.set(a._account, await query<any>(
        `SELECT id, scope_kind, scope_id, settings, locked_fields, preset_key FROM publishing_rules WHERE account_id = $1`, [a._account]));
      if (!matched.has(a._account)) matched.set(a._account, await firstMatches(a._account,
        rows.filter((r) => r._account === a._account).map((r) => r.id), await loadRules(a._account, { enabledOnly: true })));
      const plan = resolveWith(rules.get(a._account)!, a, matched.get(a._account)!.get(a.id) ?? null);
      const rights = await rightsForAsset(a);
      const next = restampPublished(a.availability, plan.settings, { anchor: publishedAnchor(a, now), rights, now });
      const t = (x: any) => (x ? new Date(x).getTime() : null);
      const same = stableJson(a.availability ?? null) === stableJson(next.availability)
        && t(a.available_from) === next.from.getTime() && t(a.available_until) === t(next.until) && a.availability_state === next.state;
      if (same) continue;
      const ended = next.state === 'expired';
      const w = await one<any>(
        `UPDATE vod_assets SET availability = $2::jsonb, availability_sources = $3::jsonb, availability_state = $4,
                available_from = $5, available_until = $6,
                published = CASE WHEN $4 = 'expired' THEN false ELSE published END,
                portal_visible = CASE WHEN $4 = 'expired' THEN false ELSE portal_visible END,
                updated_at = now()
          WHERE id = $1 AND availability_state IN ('scheduled', 'available') RETURNING id`,
        [a.id, JSON.stringify(next.availability), JSON.stringify(plan.sources), next.state, next.from, next.until]);
      if (!w) continue;   // withdrawn or archived by a person meanwhile: theirs wins
      if (fastEligibleOf(a.availability) && !fastEligibleOf(next.availability)) fastOff.set(a._account, [...(fastOff.get(a._account) ?? []), a.id]);
      // The window now ends in the past: closed as the sweep closes one.
      if (ended) await query(`UPDATE publications SET status = 'removed' WHERE vod_asset_id = $1 AND status = 'published'`, [a.id]);
      out.changed++;
      if (next.state !== 'available' && a.availability_state === 'available') out.unavailable++;
      // The play gate's cached row goes now; the public status follows, and
      // revokes play tokens at the edge when the title stops being playable.
      invalidateTag(`asset:${a.id}`);
      await refreshPublicStatus(a.id, now);
    } catch (e: any) {
      console.warn(`[availability] restamp ${a.id} failed, left for the next sweep:`, e?.message ?? e);
      await query(`UPDATE vod_assets SET policy_stale_at = now() WHERE id = $1`, [a.id]).catch(() => {});
    }
  }
  if (fastOff.size) {
    const { dropFastIneligible } = await import('./fast/store');
    for (const [acct, ids] of fastOff)
      await dropFastIneligible(acct, ids).catch((e) => console.warn('[availability] FAST lineups not planned again, the next top-up skips the titles:', e?.message ?? e));
  }
  return out;
}

/**
 * Batches of 500 until nothing is marked or `budgetMs` has passed, so one
 * sweep tick takes up a large change (about 5,000 titles in 20 s on the Mac)
 * and still leaves the rest of the minute to the other sweeps.
 */
export async function restampFor(budgetMs: number): Promise<RestampResult> {
  const t0 = Date.now();
  const out: RestampResult = { checked: 0, changed: 0, unavailable: 0 };
  for (;;) {
    const b = await restampStale(500);
    out.checked += b.checked; out.changed += b.changed; out.unavailable += b.unavailable;
    if (!b.checked || Date.now() - t0 >= budgetMs) return out;
  }
}
