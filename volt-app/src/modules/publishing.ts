import { Router } from 'express';
import { z } from 'zod';
import { query, one } from '../db';
import { requireAuth, accountId } from '../auth/middleware';
import { asyncHandler, notFound, badRequest } from '../util/http';
import { publishGate } from '../services/review';
import { actorLabel } from '../util/actor';

/**
 * Publishing & social distribution.
 *
 * publish_targets = the tenant's configured destinations (a linked social
 * account per platform). publications = a record per (asset, destination) we
 * pushed to, tracking the external id/url, status, and synced view count.
 *
 * The actual platform push is an ADAPTER (see socialAdapter) — the data model,
 * config, publish record and view tracking are real; the live upload to
 * YouTube/Facebook/X/TikTok/Dailymotion needs each platform's OAuth app + token
 * (from Secrets Manager) and is stubbed until those are wired.
 */
const PLATFORMS = ['portal', 'youtube', 'facebook', 'x', 'tiktok', 'dailymotion'] as const;

// ---- publish targets (config) -------------------------------------------
export const publishTargetsRouter = Router();
publishTargetsRouter.use(requireAuth);

publishTargetsRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const rows = await query(
      `SELECT id, platform, name, external_account, enabled, created_at
         FROM publish_targets WHERE account_id=$1 ORDER BY platform, name`,
      [accountId(req)]
    );
    res.json(rows);
  })
);

const targetSchema = z.object({
  platform: z.enum(PLATFORMS),
  name: z.string().min(1),
  externalAccount: z.string().optional(),
  credentialsRef: z.string().optional(), // Secrets Manager ARN of the OAuth token
  enabled: z.boolean().default(true),
});

publishTargetsRouter.post(
  '/',
  asyncHandler(async (req, res) => {
    const b = targetSchema.parse(req.body);
    const row = await one(
      `INSERT INTO publish_targets(account_id, platform, name, external_account, credentials_ref, enabled)
       VALUES ($1,$2::publish_platform,$3,$4,$5,$6) RETURNING id, platform, name, external_account, enabled`,
      [accountId(req), b.platform, b.name, b.externalAccount ?? null, b.credentialsRef ?? null, b.enabled]
    );
    res.status(201).json(row);
  })
);

publishTargetsRouter.patch(
  '/:id',
  asyncHandler(async (req, res) => {
    const b = z.object({ name: z.string().optional(), externalAccount: z.string().optional(), enabled: z.boolean().optional() }).parse(req.body);
    const row = await one(
      `UPDATE publish_targets SET
         name=COALESCE($3,name), external_account=COALESCE($4,external_account),
         enabled=COALESCE($5,enabled), updated_at=now()
       WHERE id=$1 AND account_id=$2 RETURNING id, platform, name, external_account, enabled`,
      [req.params.id, accountId(req), b.name ?? null, b.externalAccount ?? null, b.enabled ?? null]
    );
    if (!row) throw notFound('Target not found');
    res.json(row);
  })
);

publishTargetsRouter.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    const row = await one(`DELETE FROM publish_targets WHERE id=$1 AND account_id=$2 RETURNING id`, [req.params.id, accountId(req)]);
    if (!row) throw notFound('Target not found');
    res.status(204).end();
  })
);

// ---- publications (publish an asset + track views) ----------------------
export const publicationsRouter = Router();
publicationsRouter.use(requireAuth);

async function ownedAsset(assetId: string, acct: string) {
  return one<any>(
    `SELECT v.* FROM vod_assets v
       LEFT JOIN channels c ON c.id=v.channel_id
       LEFT JOIN events e ON e.id=v.event_id
       JOIN groups g ON g.id=COALESCE(c.group_id,e.group_id)
      WHERE v.id=$1 AND g.account_id=$2`,
    [assetId, acct]
  );
}

/** List publications for an asset (with live-ish view counts). */
publicationsRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const assetId = typeof req.query.assetId === 'string' ? req.query.assetId : null;
    if (!assetId) throw badRequest('assetId required');
    if (!(await ownedAsset(assetId, accountId(req)))) throw notFound('Asset not found');
    const rows = await query(
      `SELECT p.*, t.name AS target_name FROM publications p
         LEFT JOIN publish_targets t ON t.id=p.target_id
        WHERE p.vod_asset_id=$1 ORDER BY p.created_at DESC`,
      [assetId]
    );
    res.json(rows);
  })
);

const publishSchema = z.object({
  platform: z.enum(PLATFORMS),
  targetId: z.string().uuid().optional(), // required for social platforms
});

/** Publish an asset to the portal or a social platform. */
publicationsRouter.post(
  '/vod/:id/publish',
  asyncHandler(async (req, res) => {
    const b = publishSchema.parse(req.body);
    const asset = await ownedAsset(req.params.id, accountId(req));
    if (!asset) throw notFound('Asset not found');

    // THE SAME GATE the library's publish flag uses, applied here too. Two doors
    // into publishing with a check on only one of them is not a gate.
    const gate = await publishGate(asset.id);
    if (!gate.allowed) throw badRequest(gate.message);
    const who = await actorLabel(req);

    // What a publication is a record OF. Without this the row says which
    // platform and which asset, and goes on saying it after the asset has been
    // re-cut into something else — so "the thing that went out was approved"
    // stops being a claim about the thing that actually went out.
    const stamp = {
      buildAt: asset.built_at ?? null,
      review: asset.review_state ?? 'draft',
      qc: asset.qc_state ?? null,
      durationMs: asset.duration_ms ?? null,
      by: who,
    };

    if (b.platform === 'portal') {
      await query(`UPDATE vod_assets SET portal_visible=true, published=true, updated_at=now() WHERE id=$1`, [req.params.id]);
      const row = await one(
        `INSERT INTO publications
           (vod_asset_id, platform, status, external_url, published_at,
            published_build_at, published_review_state, published_qc_state,
            published_duration_ms, published_by)
         VALUES ($1,'portal','published',$2, now(), $3, $4, $5, $6, $7) RETURNING *`,
        [req.params.id, `/portal/watch/${req.params.id}`,
         stamp.buildAt, stamp.review, stamp.qc, stamp.durationMs, stamp.by]
      );
      return res.status(201).json(row);
    }

    // social platform: needs a configured, enabled target
    if (!b.targetId) throw badRequest('targetId (a configured account) is required for social platforms');
    const target = await one<any>(
      `SELECT * FROM publish_targets WHERE id=$1 AND account_id=$2 AND platform=$3::publish_platform AND enabled=true`,
      [b.targetId, accountId(req), b.platform]
    );
    if (!target) throw badRequest('No enabled target for that platform');

    // Create the publication in 'pending'; the adapter (stub) performs the push
    // asynchronously and fills external_id/url + status. Here we simulate the
    // accepted-for-upload state so the record + tracking exist end-to-end.
    const pub = await one<any>(
      `INSERT INTO publications
         (vod_asset_id, platform, target_id, status,
          published_build_at, published_review_state, published_qc_state,
          published_duration_ms, published_by)
       VALUES ($1,$2::publish_platform,$3,'pending',$4,$5,$6,$7,$8) RETURNING *`,
      [req.params.id, b.platform, b.targetId,
       stamp.buildAt, stamp.review, stamp.qc, stamp.durationMs, stamp.by]
    );
    // TODO(adapter): real OAuth upload. For now mark published with a placeholder URL.
    const done = await one(
      `UPDATE publications SET status='published',
         external_id=$2, external_url=$3, published_at=now()
       WHERE id=$1 RETURNING *`,
      [pub.id, `stub-${pub.id.slice(0, 8)}`, `https://${b.platform}.example/watch/${pub.id.slice(0, 8)}`]
    );
    res.status(201).json(done);
  })
);

/** Sync view counts from platforms (stub: adapter would call each platform's API). */
publicationsRouter.post(
  '/sync-views',
  asyncHandler(async (req, res) => {
    // scope to this tenant's publications
    const updated = await query(
      `UPDATE publications p SET views = views + 0, last_synced_at = now()
         FROM vod_assets v
         LEFT JOIN channels c ON c.id=v.channel_id
         LEFT JOIN events e ON e.id=v.event_id
         JOIN groups g ON g.id=COALESCE(c.group_id,e.group_id)
        WHERE p.vod_asset_id=v.id AND g.account_id=$1 AND p.status='published'
        RETURNING p.id`,
      [accountId(req)]
    );
    // TODO(adapter): fetch real counts per platform and set views.
    res.json({ synced: updated.length });
  })
);
