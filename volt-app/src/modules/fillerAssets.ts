import { Router } from 'express';
import { z } from 'zod';
import { query, one } from '../db';
import { config } from '../config';
import { requireAuth, accountId } from '../auth/middleware';
import { asyncHandler, notFound, conflict } from '../util/http';
import { actor, writeAudit } from '../services/audit';
import { imageStore } from '../services/imageStore';
import { safeExt } from '../services/uploads';
import { putFiller } from '../services/media/fillerStore';
import { defineList, parseList, whereSql, countWhereSql, countParams, pageSql, finishPage, onlyIdParam } from '../util/listQuery';

/**
 * Slates & Loops — uploaded filler assets, managed separately from VOD. A slate
 * is a still image; a loop is a short video. These are what a channel/event's
 * redundancy filler points at (channels/events.filler_asset_id) and what the
 * encoder encodes into the ladder on total input loss.
 *
 * Upload flow: POST / to register an asset and get a presigned S3 PUT URL, the
 * client uploads the bytes directly to S3, then PATCH status -> ready (in prod a
 * post-processing step probes dimensions/duration and produces a poster).
 */
export const fillerAssetsRouter = Router();
fillerAssetsRouter.use(requireAuth);

const FILLER_LIST = defineList({
  path: '/api/filler-assets',
  fields: {
    id: { sql: 'id', type: 'uuid' },
    name: { sql: 'name', type: 'string' },
    kind: { sql: 'kind', type: 'enum', values: ['slate', 'loop'] },
    status: { sql: 'status', type: 'enum', values: ['uploading', 'processing', 'ready', 'error'] },
    // migration 0161: the review, whether it may be used, and its preview and QC
    review_state: { sql: 'review_state', type: 'enum', values: ['pending', 'approved', 'rejected'] },
    availability: { sql: 'availability', type: 'enum', values: ['available', 'archived'] },
    preview_status: { sql: 'preview_status', type: 'string' },
    qc_state: { sql: 'qc_state', type: 'string' },
    filename: { sql: 'filename', type: 'string' },
    content_type: { sql: 'content_type', type: 'string' },
    width: { sql: 'width', type: 'number' },
    height: { sql: 'height', type: 'number' },
    duration_ms: { sql: 'duration_ms', type: 'number' },
    bytes: { sql: 'bytes', type: 'number' },
    uploaded_at: { sql: 'uploaded_at', type: 'timestamp' },
    created_at: { sql: 'created_at', type: 'timestamp', notNull: true },
    updated_at: { sql: 'updated_at', type: 'timestamp' },
  },
  search: ['name', 'filename'],
  // tag=a,b: every one of those tags (tags is an array, so it is read by the
  // route itself rather than as a list-standard filter)
  extraParams: ['tag'],
  // the console's Loops & Fillers pages jump to a page (Christian, 11 Nov)
  allowOffset: true,
  defaultSort: '-created_at',
  unpagedLimit: 1000,
});

// ---------------------------------------------------------------------------
//  WHO USES WHAT (22 Oct 2026)
//
//  Loops & Fillers is the one home for what a channel or event shows when its
//  source goes away, so each asset says which streams point at it. Before this
//  the page could not answer its own question ("is the thing this channel
//  points at actually there?"): channel forms picked slates from the Image
//  Library into `filler_slate_ref`, a different field from the
//  `filler_asset_id` this page manages, and deleting an asset that WAS linked
//  quietly nulled the link (ON DELETE SET NULL) and left the channel on black.
// ---------------------------------------------------------------------------
/**
 * A filler asset id offered by a channel or event form must belong to the same
 * account and be ready. Without this a uuid from another tenant would be
 * accepted and the orchestrator would hand that tenant's file to the encoder.
 */
export async function assertFillerAsset(acc: string, id: string | null | undefined, current?: string | null): Promise<void> {
  if (!id) return;
  const fa = await one<any>(`SELECT name, status, review_state, availability FROM filler_assets WHERE id = $1 AND account_id = $2`, [id, acc]);
  if (!fa) throw notFound('That slate or loop is not in this account\'s Loops & Fillers');
  if (fa.status !== 'ready') throw conflict(`That slate or loop is still ${fa.status}; choose it once it is ready`);
  // ONLY AVAILABLE AND APPROVED (Christian, 11 Nov; migration 0161). Checked
  // when the choice CHANGES: a stream keeps what it already has when the form
  // is saved again, so archiving or rejecting never takes a fallback off air.
  if (current && current === id) return;
  if (fa.availability === 'archived') throw conflict(`"${fa.name}" is archived. Make it available again in Loops & Fillers to use it.`);
  if (fa.review_state !== 'approved') {
    throw conflict(fa.review_state === 'rejected'
      ? `"${fa.name}" was rejected in Loops & Fillers and cannot be used.`
      : `"${fa.name}" is waiting for approval. Check its house preview and approve it in Loops & Fillers first.`);
  }
}

export interface FillerUser { kind: 'channel' | 'radio' | 'event' | 'fast'; id: string; name: string; href: string }

const userOf = (r: any): FillerUser => r.owner === 'event'
  ? { kind: 'event', id: r.id, name: r.name, href: `/events/${r.id}` }
  : r.ckind === 'radio'
    ? { kind: 'radio', id: r.id, name: r.name, href: `/radio/${r.id}` }
    : { kind: 'channel', id: r.id, name: r.name, href: `/channels/${r.id}` };

/** Streams that point at each of these filler assets, account-scoped. */
export async function usageFor(acc: string, ids: string[]): Promise<Map<string, FillerUser[]>> {
  const out = new Map<string, FillerUser[]>();
  if (!ids.length) return out;
  const rows = await query<any>(
    `SELECT 'channel' AS owner, c.id, c.name, c.kind AS ckind, c.filler_asset_id AS asset
       FROM channels c JOIN groups g ON g.id = c.group_id
      WHERE g.account_id = $1 AND c.filler_asset_id = ANY($2::uuid[])
     UNION ALL
     SELECT 'event' AS owner, e.id, e.name, NULL AS ckind, e.filler_asset_id AS asset
       FROM events e JOIN groups g ON g.id = e.group_id
      WHERE g.account_id = $1 AND e.filler_asset_id = ANY($2::uuid[])
      ORDER BY name`,
    [acc, ids]
  );
  for (const r of rows) {
    const list = out.get(r.asset) ?? [];
    list.push(userOf(r));
    out.set(r.asset, list);
  }
  return out;
}

/**
 * FAST CHANNELS THAT PLAY THIS. A FAST channel does not point at a filler
 * asset: choosing one (Build > Brand & filler) makes a hidden library copy
 * (services/fast/fillerBridge.ts, metadata.fillerAssetId) and the channel's ad
 * policy names THAT copy as its brand loop, slate or an ident. So the
 * channel-and-event usage above never saw it, and a loop playing on a FAST
 * channel read "Not used" here. Found through the copy, so a pick made from the
 * Media Library list of the same copy counts too.
 */
export interface FastUse { channelId: string; name: string; status: string; copyId: string; roles: string[] }
export async function fastUseFor(acc: string, ids: string[]): Promise<Map<string, FastUse[]>> {
  const out = new Map<string, FastUse[]>();
  if (!ids.length) return out;
  const rows = await query<any>(
    `SELECT v.metadata->>'fillerAssetId' AS filler, v.id AS copy, c.id, c.name, c.status::text AS status,
            ca.policy->'brand'->>'loopAssetId' = v.id::text AS is_loop,
            ca.policy->>'slateAssetId' = v.id::text AS is_slate,
            COALESCE(ca.policy->'brand'->'identIds' ? v.id::text, false) AS is_ident,
            ca.policy->>'geoAssetId' = v.id::text AS is_geo,
            COALESCE((ca.policy->>'breaksUseLoop')::boolean, false) AS breaks_use_loop
       FROM vod_assets v
       JOIN channel_ads ca ON ca.policy->'brand'->>'loopAssetId' = v.id::text
                           OR ca.policy->>'slateAssetId' = v.id::text
                           OR COALESCE(ca.policy->'brand'->'identIds' ? v.id::text, false)
                           OR ca.policy->>'geoAssetId' = v.id::text
       JOIN channels c ON c.id = ca.channel_id
       JOIN groups g ON g.id = c.group_id AND g.account_id = $1
      WHERE v.account_id = $1 AND v.metadata->>'fillerAssetId' = ANY($2::text[])
      ORDER BY c.name`, [acc, ids]);
  for (const r of rows) {
    const roles: string[] = [];
    if (r.is_loop) roles.push('Brand loop', ...(r.breaks_use_loop ? ['Unsold ad breaks'] : []));
    if (r.is_slate) roles.push('Slate');
    if (r.is_ident) roles.push('Ident');
    if (r.is_geo) roles.push('Geo replacement');
    const list = out.get(r.filler) ?? [];
    list.push({ channelId: r.id, name: r.name, status: r.status, copyId: r.copy, roles });
    out.set(r.filler, list);
  }
  return out;
}

/** For the list's Used by column: FAST channels beside the streams. Not used for delete (see there). */
async function withFast(acc: string, ids: string[], usage: Map<string, FillerUser[]>): Promise<Map<string, FillerUser[]>> {
  const fast = await fastUseFor(acc, ids).catch(() => new Map<string, FastUse[]>());
  for (const [id, list] of fast) {
    usage.set(id, [...(usage.get(id) ?? []), ...list.map((f): FillerUser => ({ kind: 'fast', id: f.channelId, name: f.name, href: `/fast/${f.channelId}` }))]);
  }
  return usage;
}

/**
 * Fallbacks that are NOT in Loops & Fillers yet: streams whose slate or loop
 * is still a pasted address (an Image Library image, almost always), grouped
 * by that address. Only where the loss behaviour actually uses it.
 */
fillerAssetsRouter.get(
  '/elsewhere',
  asyncHandler(async (req, res) => {
    const acc = accountId(req);
    const rows = await query<any>(
      `SELECT 'channel' AS owner, c.id, c.name, c.kind AS ckind, c.filler_slate_ref AS ref, c.input_loss_behavior AS loss
         FROM channels c JOIN groups g ON g.id = c.group_id
        WHERE g.account_id = $1 AND c.filler_asset_id IS NULL AND c.filler_slate_ref IS NOT NULL
          AND c.input_loss_behavior IN ('slate','vod_loop')
       UNION ALL
       SELECT 'event' AS owner, e.id, e.name, NULL AS ckind, e.filler_slate_ref AS ref, e.input_loss_behavior AS loss
         FROM events e JOIN groups g ON g.id = e.group_id
        WHERE g.account_id = $1 AND e.filler_asset_id IS NULL AND e.filler_slate_ref IS NOT NULL
          AND e.input_loss_behavior IN ('slate','vod_loop')
        ORDER BY ref, name`,
      [acc]
    );
    type Group = { ref: string; usedBy: FillerUser[]; libraryFile: any | null };
    const byRef = new Map<string, Group>();
    for (const r of rows) {
      const g: Group = byRef.get(r.ref) ?? { ref: r.ref, usedBy: [], libraryFile: null };
      g.usedBy.push(userOf(r));
      byRef.set(r.ref, g);
    }
    for (const g of byRef.values()) {
      const f = await libraryFileFor(acc, g.ref);
      g.libraryFile = f ? { id: f.id, name: f.name, path: f.path, contentType: f.content_type, width: f.width, height: f.height } : null;
    }
    res.json({ items: [...byRef.values()].map(g => ({ ...g, canCopy: !!g.libraryFile })) });
  })
);

/** The Image Library row a slate address points at, if it is one. */
async function libraryFileFor(acc: string, ref: string): Promise<any | null> {
  const clean = ref.split('?')[0];
  return one<any>(
    `SELECT * FROM media_files
      WHERE account_id = $1 AND ('/' || store_key = $2 OR store_key = $2 OR path = $2)
      ORDER BY version DESC LIMIT 1`,
    [acc, clean]
  );
}

const copySchema = z.object({ ref: z.string().min(1), name: z.string().min(1).optional() });

/**
 * COPY AN IMAGE LIBRARY SLATE INTO LOOPS & FILLERS, and move every stream that
 * used the address onto the new asset. The bytes are copied, not moved: the
 * library image may be used elsewhere (a poster, a watermark) and is left as
 * it was.
 *
 * Relinking is safe on a RUNNING stream and needs no loop rebuild: the picture
 * is byte-for-byte the one the encoder already has. So this deliberately does
 * not go through the channel PATCH (whose settings lock would refuse a running
 * channel) and does not queue a filler build.
 */
fillerAssetsRouter.post(
  '/copy-from-library',
  asyncHandler(async (req, res) => {
    const acc = accountId(req);
    const b = copySchema.parse(req.body);
    const file = await libraryFileFor(acc, b.ref);
    if (!file) throw notFound('That address is not an Image Library file in this account');
    const bytes = await imageStore().get(file.store_key);
    if (!bytes) throw conflict(`The Image Library file "${file.path}" has no bytes in storage`);
    const ct: string = file.content_type || 'application/octet-stream';
    const kind = ct.startsWith('video/') ? 'loop' : 'slate';
    const filename = String(file.path).split('/').pop() || file.name;
    const row = await one<any>(
      `INSERT INTO filler_assets(account_id, kind, name, status, width, height, content_type, filename)
       VALUES ($1,$2,$3,'processing',$4,$5,$6,$7) RETURNING *`,
      [acc, kind, b.name?.trim() || file.name, file.width ?? null, file.height ?? null, ct, filename]
    );
    const sourceKey = `filler/${acc}/${row.id}${safeExt(filename)}`;
    // Into the filler store: FILLER_DIR on the Mac, the bucket on AWS (2.1a).
    await putFiller(sourceKey, bytes);
    const ready = await one<any>(
      `UPDATE filler_assets SET status='ready', source_key=$2, bytes=$3, uploaded_at=now(), updated_at=now()
        WHERE id=$1 RETURNING *`,
      [row.id, sourceKey, bytes.length]
    );
    const variants = [b.ref, b.ref.split('?')[0], '/' + file.store_key, file.store_key, file.path];
    const relinked = await query<any>(
      `WITH c AS (
         UPDATE channels ch SET filler_asset_id = $2, filler_slate_ref = NULL, updated_at = now()
           FROM groups g
          WHERE g.id = ch.group_id AND g.account_id = $1 AND ch.filler_asset_id IS NULL
            AND ch.filler_slate_ref = ANY($3::text[])
         RETURNING 'channel' AS owner, ch.id, ch.name, ch.kind AS ckind),
       e AS (
         UPDATE events ev SET filler_asset_id = $2, filler_slate_ref = NULL, updated_at = now()
           FROM groups g
          WHERE g.id = ev.group_id AND g.account_id = $1 AND ev.filler_asset_id IS NULL
            AND ev.filler_slate_ref = ANY($3::text[])
         RETURNING 'event' AS owner, ev.id, ev.name, NULL AS ckind)
       SELECT * FROM c UNION ALL SELECT * FROM e`,
      [acc, row.id, variants]
    );
    const who = actor(req);
    // ALREADY ON AIR, SO ALREADY APPROVED (migration 0161): the picture was these
    // streams' fallback before it was copied in, byte for byte. Holding it for
    // approval would leave them pointing at something marked "waiting".
    if (relinked.length) {
      await query(`UPDATE filler_assets SET review_state = 'approved', reviewed_at = now(), reviewed_by = $2, reviewed_by_label = $3, review_note = $4 WHERE id = $1`,
        [row.id, who.userId ?? null, await personLabel(req), `Copied in from the Image Library while it was the fallback of ${relinked.length} stream${relinked.length === 1 ? '' : 's'}`]);
      ready.review_state = 'approved';
    }
    await writeAudit(null, { accountId: acc, userId: who.userId, label: who.label,
      action: 'create', entityType: 'filler_asset', entityId: row.id,
      snapshot: { copiedFrom: file.path, mediaFileId: file.id, relinked: relinked.map((r: any) => ({ owner: r.owner, id: r.id, name: r.name })) } });
    await (await import('../services/jobs/handlers/fillerThumbs')).queueFillerThumbs(row.id);
    const usedBy = relinked.map(userOf);
    res.status(201).json({ asset: { ...ready, used_by: usedBy }, relinked: usedBy });
  })
);

fillerAssetsRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const params: unknown[] = [accountId(req)];
    // tags first, so the list standard's own parameters (and the count's) follow them
    const tags = normaliseTags(String(req.query.tag ?? '').split(','));
    const tagSql = tags.length ? ` AND tags @> $${params.push(tags)}::text[]` : '';
    const pl = parseList(FILLER_LIST, req.query, params);
    const where = `FROM filler_assets WHERE account_id = $1${tagSql}${whereSql(pl)}`;
    const whereCount = `FROM filler_assets WHERE account_id = $1${tagSql}${countWhereSql(pl)}`;  // totals ignore the cursor
    const rows = await query<any>(`SELECT * ${where} ${pageSql(pl)}`, params);
    const total = pl.count ? Number((await one<any>(`SELECT count(*)::int AS n ${whereCount}`, countParams(pl, params)))?.n ?? 0) : undefined;
    const usage = await withFast(accountId(req), rows.map((r: any) => r.id), await usageFor(accountId(req), rows.map((r: any) => r.id)));
    for (const r of rows) r.used_by = usage.get(r.id) ?? [];
    res.json(finishPage(req, res, pl, rows, total));
  })
);

/** Tags: trimmed, at most 40 characters, no duplicates whatever their case, at most 20. */
export function normaliseTags(raw: unknown[]): string[] {
  const out: string[] = [];
  for (const t of raw) {
    const v = String(t ?? '').trim().replace(/\s+/g, ' ').slice(0, 40);
    if (v && !out.some((x) => x.toLowerCase() === v.toLowerCase())) out.push(v);
  }
  return out.slice(0, 20);
}

/** Every tag in use in this account, with how many slates and loops carry it (the filter chips). */
fillerAssetsRouter.get(
  '/tags',
  asyncHandler(async (req, res) => {
    const rows = await query<any>(
      `SELECT t AS tag, count(*)::int AS count FROM filler_assets, unnest(tags) t
        WHERE account_id = $1 GROUP BY t ORDER BY lower(t)`, [accountId(req)]);
    res.json(rows);
  })
);

/** Replace a slate or loop's tags. */
fillerAssetsRouter.put(
  '/:id/tags',
  asyncHandler(async (req, res) => {
    const b = z.object({ tags: z.array(z.string()).max(50) }).parse(req.body ?? {});
    const acc = accountId(req);
    const before = await one<any>(`SELECT tags FROM filler_assets WHERE id = $1 AND account_id = $2`, [req.params.id, acc]);
    if (!before) throw notFound('Filler asset not found');
    const tags = normaliseTags(b.tags);
    const row = await one<any>(`UPDATE filler_assets SET tags = $2::text[], updated_at = now() WHERE id = $1 RETURNING *`, [req.params.id, tags]);
    const who = actor(req);
    await writeAudit(null, { accountId: acc, userId: who.userId, label: who.label, action: 'update', entityType: 'filler_asset',
      entityId: String(req.params.id), changes: { tags: { from: before.tags ?? [], to: tags } } }).catch(() => {});
    res.json(row);
  })
);

/**
 * One item by id: the canonical "self" link that the JSON-LD + Hydra layer
 * (services/hypermedia.ts) gives every member, so a deep link resolves.
 * Same tenant scoping as the list. (20 Oct 2026)
 */
fillerAssetsRouter.get(
  '/:id',
  onlyIdParam,
  asyncHandler(async (req, res) => {
    const row = await one<any>(`SELECT * FROM filler_assets WHERE id=$1 AND account_id=$2`, [req.params.id, accountId(req)]);
    if (!row) throw notFound('Filler asset not found');
    row.used_by = (await withFast(accountId(req), [row.id], await usageFor(accountId(req), [row.id]))).get(row.id) ?? [];
    res.json(row);
  })
);

// ---------------------------------------------------------------------------
//  DETAILS (25 Oct 2026): one slate or loop, what was built from it, and where.
//
//  A loop is not played as uploaded. Each stream that falls back to it gets its
//  OWN copy, encoded to that stream's ladder and packaged to its segment length
//  (services/fillerPrep.ts), kept under origin/<stream>/filler/prebuilt. So the
//  renditions "made to date" are per stream, and the page lists them per stream:
//  the build's state, its renditions, whether it came from THIS file (a stream
//  that switched assets keeps its old copy until rebuilt), and a playable
//  preview of exactly what viewers would see on a loss.
// ---------------------------------------------------------------------------
async function streamUse(acc: string, assetId: string, sourceKey: string | null): Promise<any[]> {
  const rows = await query<any>(
    `SELECT 'channel' AS owner, c.id, c.name, c.kind AS ckind, c.status::text AS status,
            c.input_failover_enabled AS failover, c.input_loss_behavior::text AS loss, c.filler_build AS build,
            g.name AS group_name
       FROM channels c JOIN groups g ON g.id = c.group_id
      WHERE g.account_id = $1 AND c.filler_asset_id = $2
     UNION ALL
     SELECT 'event' AS owner, e.id, e.name, NULL AS ckind, e.status::text AS status,
            e.input_failover_enabled AS failover, e.input_loss_behavior::text AS loss, e.filler_build AS build,
            g.name AS group_name
       FROM events e JOIN groups g ON g.id = e.group_id
      WHERE g.account_id = $1 AND e.filler_asset_id = $2
      ORDER BY name`, [acc, assetId]);
  const { readFile, stat } = await import('node:fs/promises');
  const { resolve } = await import('node:path');
  const out: any[] = [];
  for (const r of rows) {
    const b = r.build ?? null;
    const dir = resolve(config.testStream.originDir, r.id, 'filler', 'prebuilt');
    // What the copy on disk was made FROM: the spec beside it names the source.
    let builtFrom: string | null = null;
    try { builtFrom = JSON.parse(await readFile(`${dir}.spec.json`, 'utf8'))?.source?.path ?? null; } catch { /* never built */ }
    const fromThis = builtFrom && sourceKey ? builtFrom.split('?')[0].endsWith(sourceKey.replace(/^\//, '')) : null;
    let playable = false;
    try { playable = (await stat(resolve(dir, 'master.m3u8'))).isFile(); } catch { /* not built */ }
    // Why a stream that points at this asset might never play it.
    const active = !!r.failover && (r.loss === 'slate' || r.loss === 'vod_loop');
    out.push({
      ...userOf(r),
      status: r.status, group: r.group_name,
      fallback: { active, failover: !!r.failover, onLoss: r.loss,
        note: !r.failover ? 'Input failover is off, so this stream never switches to its fallback'
          : !active ? `On a loss this stream shows ${r.loss === 'last_frame' ? 'the last frame' : r.loss === 'black' ? 'black' : 'nothing'}, not this ${r.loss}` : null },
      build: b ? {
        status: b.status, reason: b.reason ?? null, error: b.error ?? null, at: b.at ?? null,
        loopSeconds: b.loop_seconds ?? null, buildSeconds: b.build_seconds ?? null, watermark: !!b.watermark,
        renditions: b.renditions ?? [], audio: b.audio ?? null, sourceKind: b.source_kind ?? null,
        fromThisAsset: fromThis,
        preview: playable ? `/origin/${r.id}/filler/prebuilt/master.m3u8` : null,
      } : null,
    });
  }
  return out;
}

fillerAssetsRouter.get(
  '/:id/details',
  asyncHandler(async (req, res) => {
    const acc = accountId(req);
    const row = await one<any>(`SELECT * FROM filler_assets WHERE id=$1 AND account_id=$2`, [req.params.id, acc]);
    if (!row) throw notFound('Filler asset not found');
    const streams = await streamUse(acc, row.id, row.source_key);
    // FAST channels play their own copy, encoded for the channel's ladder by its
    // prepare step: report that copy's readiness as the FAST page does.
    const fastUse = (await fastUseFor(acc, [row.id])).get(row.id) ?? [];
    const { readiness } = await import('../services/fast/prepare');
    const fast = [];
    for (const f of fastUse) {
      const r = (await readiness(f.channelId).catch(() => [] as any[])).find((x: any) => x.assetId === f.copyId) ?? null;
      fast.push({ ...f, href: `/fast/${f.channelId}`,
        copy: r ? { state: r.state, why: r.why ?? null, progress: r.progress ?? null, note: r.note ?? null, failed: !!r.failed } : null });
    }
    res.json({
      fast,
      house: houseOf(row),
      asset: row,
      media: row.source_key ? `/${String(row.source_key).replace(/^\//, '')}` : null,
      streams,
      summary: {
        streams: streams.length,
        ready: streams.filter((s) => s.build?.status === 'ready' && s.build?.fromThisAsset !== false).length,
        outOfDate: streams.filter((s) => s.build?.fromThisAsset === false).length,
        failed: streams.filter((s) => s.build?.status === 'failed').length,
        // only copies made from THIS file count as its renditions
        renditions: streams.reduce((n, s) => n + (s.build?.status === 'ready' && s.build?.fromThisAsset !== false ? (s.build.renditions?.length ?? 0) : 0), 0),
      },
    });
  })
);

/** Rebuild one stream's copy of this asset (it changed, or a build failed). */
fillerAssetsRouter.post(
  '/:id/rebuild',
  asyncHandler(async (req, res) => {
    const acc = accountId(req);
    const b = z.object({ kind: z.enum(['channel', 'event']), id: z.string().uuid() }).parse(req.body ?? {});
    const row = await one<any>(`SELECT id, name FROM filler_assets WHERE id=$1 AND account_id=$2`, [req.params.id, acc]);
    if (!row) throw notFound('Filler asset not found');
    const tbl = b.kind === 'channel' ? 'channels' : 'events';
    const owner = await one<any>(
      `SELECT x.id, x.name FROM ${tbl} x JOIN groups g ON g.id = x.group_id
        WHERE x.id = $1 AND g.account_id = $2 AND x.filler_asset_id = $3`, [b.id, acc, row.id]);
    if (!owner) throw notFound('That stream does not use this slate or loop');
    const { scheduleFillerPrep } = await import('../services/fillerPrep');
    await scheduleFillerPrep(b.kind, owner.id, `rebuilt from Loops & Fillers (${row.name})`);
    await query(`UPDATE ${tbl} SET filler_build = jsonb_build_object('status','queued','at',now()) WHERE id = $1`, [owner.id]);
    const who = actor(req);
    await writeAudit(null, { accountId: acc, userId: who.userId, label: who.label, action: 'update', entityType: 'filler_asset',
      entityId: row.id, changes: { rebuild: { from: null, to: `${b.kind} ${owner.name}` } } }).catch(() => {});
    res.status(202).json({ queued: true });
  })
);

// ---------------------------------------------------------------------------
//  THUMBNAILS (migration 0120, services/media/fillerThumbs.ts): the thumbnail,
//  the frames to choose it from, and the sprite sheets' WebVTT for previews.
// ---------------------------------------------------------------------------

/** The loop's hover and scrub previews: one cue per tile, into its signed sheets. */
fillerAssetsRouter.get(
  '/:id/thumbnails.vtt',
  asyncHandler(async (req, res) => {
    const { fillerVtt } = await import('../services/media/fillerThumbs');
    const vtt = await fillerVtt(String(req.params.id), accountId(req));
    if (!vtt) throw notFound('No preview thumbnails for this slate or loop');
    res.type('text/vtt').set('Cache-Control', 'private, max-age=60').send(vtt);
  })
);

/** Make the thumbnail, frames and sprites again (a person asked, or the first try failed). */
fillerAssetsRouter.post(
  '/:id/thumbnails',
  asyncHandler(async (req, res) => {
    const acc = accountId(req);
    const row = await one<any>(`SELECT id, status FROM filler_assets WHERE id=$1 AND account_id=$2`, [req.params.id, acc]);
    if (!row) throw notFound('Filler asset not found');
    if (row.status !== 'ready') throw conflict(`It is still ${row.status}; thumbnails are made once the file is in`);
    await query(`UPDATE filler_assets SET thumb_status = NULL, thumb_error = NULL WHERE id = $1`, [row.id]);
    await (await import('../services/jobs/handlers/fillerThumbs')).queueFillerThumbs(row.id);
    res.status(202).json({ queued: true });
  })
);

/** Choose one of the loop's frames as its thumbnail, or `auto` for the best-scoring one. */
fillerAssetsRouter.put(
  '/:id/poster',
  asyncHandler(async (req, res) => {
    const acc = accountId(req);
    const b = z.object({ key: z.string().min(1).optional(), auto: z.boolean().optional() }).parse(req.body ?? {});
    const ft = await import('../services/media/fillerThumbs');
    const ok = b.auto ? await ft.autoFillerPoster(String(req.params.id), acc) : b.key ? await ft.setFillerPoster(String(req.params.id), acc, b.key) : false;
    if (!ok) throw notFound(b.auto ? 'No frames to choose from yet' : 'That frame is not one of this loop\'s');
    const who = actor(req);
    await writeAudit(null, { accountId: acc, userId: who.userId, label: who.label, action: 'update', entityType: 'filler_asset',
      entityId: String(req.params.id), changes: { thumbnail: { from: null, to: b.auto ? 'automatic' : b.key } } }).catch(() => {});
    res.json(await one(`SELECT * FROM filler_assets WHERE id = $1`, [req.params.id]));
  })
);

// ---------------------------------------------------------------------------
//  HOUSE PREVIEW, QC, REVIEW AND ARCHIVE (migration 0161,
//  services/media/fillerPreview.ts). Christian, 11 Nov: see a slate or loop
//  as viewers will, read what QC found, approve it before anything can use it,
//  and archive what is no longer wanted without deleting it.
// ---------------------------------------------------------------------------
/**
 * The person's name as the page shows it (who approved, accepted or archived):
 * their display name or email. actor() gives the user id, which is right for
 * the audit log but means nothing to someone reading the page (12 Nov 2026).
 */
async function personLabel(req: any): Promise<string | null> {
  const who = actor(req);
  if (!who.userId) return who.label ?? null;
  const u = await one<any>(`SELECT COALESCE(NULLIF(display_name, ''), email::text) AS label FROM users WHERE id = $1`, [who.userId]).catch(() => null);
  return u?.label ?? who.label ?? null;
}

async function ownFiller(req: any): Promise<any> {
  const row = await one<any>(`SELECT * FROM filler_assets WHERE id = $1 AND account_id = $2`, [req.params.id, accountId(req)]);
  if (!row) throw notFound('Filler asset not found');
  return row;
}

/** The house preview, QC and review of one slate or loop. */
export function houseOf(row: any) {
  return {
    status: row.preview_status ?? null, error: row.preview_error ?? null, preview: row.preview ?? null, at: row.preview_at ?? null,
    qc: { state: row.qc_state ?? null, findings: row.qc_findings ?? [], skipped: row.qc_skipped ?? [], at: row.qc_at ?? null,
      // which findings a person has accepted, by key (migration 0175)
      accepted: row.qc_accepted ?? {} },
    review: { state: row.review_state, note: row.review_note ?? null, by: row.reviewed_by_label ?? null, at: row.reviewed_at ?? null },
    availability: { state: row.availability, at: row.archived_at ?? null, by: row.archived_by_label ?? null },
  };
}

fillerAssetsRouter.get(
  '/:id/house',
  asyncHandler(async (req, res) => { res.json(houseOf(await ownFiller(req))); })
);

/** Build the house preview again (and QC it). */
fillerAssetsRouter.post(
  '/:id/house',
  asyncHandler(async (req, res) => {
    const row = await ownFiller(req);
    if (row.status !== 'ready') throw conflict(`It is ${row.status}; a preview is made once its file has landed`);
    const { queueFillerPreview } = await import('../services/jobs/handlers/fillerPreview');
    await queueFillerPreview(row.id);
    res.status(202).json({ queued: true });
  })
);

/** Run QC again over the existing preview (thresholds changed, or a finding was disputed). */
fillerAssetsRouter.post(
  '/:id/qc',
  asyncHandler(async (req, res) => {
    const row = await ownFiller(req);
    const { runFillerQc } = await import('../services/media/fillerPreview');
    await runFillerQc(row.id);
    res.json(houseOf(await ownFiller(req)));
  })
);

/** Accept one QC finding, having looked at it (or take that back). */
fillerAssetsRouter.post(
  '/:id/qc/accept',
  asyncHandler(async (req, res) => {
    const b = z.object({ key: z.string().min(1).max(200), accepted: z.boolean().default(true), note: z.string().max(2000).optional().nullable() }).parse(req.body ?? {});
    const acc = accountId(req);
    const who = actor(req);
    const { acceptFinding, ReviewError } = await import('../services/media/fillerPreview');
    let row: any;
    try {
      row = await acceptFinding({ id: String(req.params.id), accountId: acc, key: b.key, accepted: b.accepted, note: b.note ?? null, label: await personLabel(req) });
    } catch (e: any) {
      if (e instanceof ReviewError) return res.status(e.status).json({ error: e.message, message: e.message });
      throw e;
    }
    await writeAudit(null, { accountId: acc, userId: who.userId, label: who.label, action: 'update', entityType: 'filler_asset',
      entityId: String(req.params.id), changes: { qc_accepted: { from: b.accepted ? null : b.key, to: b.accepted ? b.key : null }, ...(b.note ? { qc_note: { from: null, to: b.note } } : {}) } }).catch(() => {});
    res.json(houseOf(row));
  })
);

/** Approve, reject, or send back to waiting. */
fillerAssetsRouter.post(
  '/:id/review',
  asyncHandler(async (req, res) => {
    const b = z.object({ decision: z.enum(['approve', 'reject', 'reset']), note: z.string().max(2000).optional().nullable() }).parse(req.body ?? {});
    const acc = accountId(req);
    const who = actor(req);
    const { reviewFiller, ReviewError } = await import('../services/media/fillerPreview');
    let r: any;
    try {
      r = await reviewFiller({ id: String(req.params.id), accountId: acc, decision: b.decision, note: b.note ?? null, userId: who.userId ?? null, label: await personLabel(req) });
    } catch (e: any) {
      if (e instanceof ReviewError) return res.status(e.status).json({ error: e.message, message: e.message });
      throw e;
    }
    await writeAudit(null, { accountId: acc, userId: who.userId, label: who.label, action: 'update', entityType: 'filler_asset',
      entityId: String(req.params.id), changes: { review: { from: r.from, to: r.to }, ...(b.note ? { review_note: { from: null, to: b.note } } : {}) } }).catch(() => {});
    // Rejecting never takes it off streams that use it (they would fall back to
    // black mid-outage): say who still uses it so the page can.
    const users = (await withFast(acc, [r.asset.id], await usageFor(acc, [r.asset.id]))).get(r.asset.id) ?? [];
    res.json({ ...houseOf(r.asset), usedBy: users });
  })
);

/**
 * Archive or make available again. An archived slate or loop is kept but out
 * of use: off every picker and refused for anything new. IN USE CANNOT BE
 * ARCHIVED (Christian, 11 Nov), with no override: change the streams first.
 */
fillerAssetsRouter.post(
  '/:id/availability',
  asyncHandler(async (req, res) => {
    const b = z.object({ state: z.enum(['available', 'archived']) }).parse(req.body ?? {});
    const acc = accountId(req);
    const row = await ownFiller(req);
    if (b.state === 'archived') {
      const users = (await withFast(acc, [row.id], await usageFor(acc, [row.id]))).get(row.id) ?? [];
      if (users.length) {
        return res.status(409).json({ error: 'In use', inUseBy: users,
          message: `"${row.name}" is used by ${users.map((u) => u.name).join(', ')}. Choose another slate or loop for ${users.length === 1 ? 'it' : 'them'} first, then archive it.` });
      }
    }
    const who = actor(req);
    const upd = await one<any>(
      `UPDATE filler_assets SET availability = $2,
              archived_at = CASE WHEN $2 = 'archived' THEN now() ELSE NULL END,
              archived_by_label = CASE WHEN $2 = 'archived' THEN $3 ELSE NULL END, updated_at = now()
        WHERE id = $1 RETURNING *`, [row.id, b.state, await personLabel(req)]);
    if (row.availability !== b.state) {
      await writeAudit(null, { accountId: acc, userId: who.userId, label: who.label, action: 'update', entityType: 'filler_asset',
        entityId: row.id, changes: { availability: { from: row.availability, to: b.state } } }).catch(() => {});
    }
    res.json(upd);
  })
);

const createSchema = z.object({
  kind: z.enum(['slate', 'loop']),
  name: z.string().min(1),
  contentType: z.string().default('application/octet-stream'),
});

/** Register a filler asset and return where to upload the bytes. */
fillerAssetsRouter.post(
  '/',
  asyncHandler(async (req, res) => {
    const body = createSchema.parse(req.body);
    const row = await one<any>(
      `INSERT INTO filler_assets(account_id, kind, name, status) VALUES ($1,$2,$3,'uploading')
       RETURNING *`,
      [accountId(req), body.kind, body.name]
    );
    const sourceKey = `filler/${accountId(req)}/${row.id}`;
    await query('UPDATE filler_assets SET source_key = $2 WHERE id = $1', [row.id, sourceKey]);
    // presign is stubbed here; wire to S3 in the orchestrator layer.
    const uploadUrl = `https://${config.aws.s3Bucket}.s3.${config.aws.region}.amazonaws.com/${sourceKey}`;
    res.status(201).json({ ...row, source_key: sourceKey, upload: { method: 'PUT', url: uploadUrl } });
  })
);

const patchSchema = z.object({
  name: z.string().min(1).optional(),
  status: z.enum(['uploading', 'processing', 'ready', 'error']).optional(),
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
  durationMs: z.number().int().positive().optional(),
});

fillerAssetsRouter.patch(
  '/:id',
  asyncHandler(async (req, res) => {
    const b = patchSchema.parse(req.body);
    const row = await one(
      `UPDATE filler_assets SET
         name = COALESCE($3, name),
         status = COALESCE($4, status),
         width = COALESCE($5, width),
         height = COALESCE($6, height),
         duration_ms = COALESCE($7, duration_ms),
         updated_at = now()
       WHERE id = $1 AND account_id = $2 RETURNING *`,
      [req.params.id, accountId(req), b.name ?? null, b.status ?? null, b.width ?? null, b.height ?? null, b.durationMs ?? null]
    );
    if (!row) throw notFound('Filler asset not found');
    res.json(row);
  })
);

fillerAssetsRouter.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    // IN USE IS A REFUSAL, not a warning in a browser dialog. The foreign key
    // nulls the link on delete, which left a channel with nothing to fall back
    // to and nothing on screen saying so. Name the streams; force to override.
    const force = req.query.force === 'true';
    const users = (await usageFor(accountId(req), [String(req.params.id)])).get(String(req.params.id)) ?? [];
    if (users.length && !force) {
      return res.status(409).json({
        error: 'Filler asset is in use', inUseBy: users,
        message: `Used as the fallback by ${users.map(u => u.name).join(', ')}. Choose another fallback for ${users.length === 1 ? 'it' : 'them'} first, or delete with force=true.`,
      });
    }
    const row = await one(
      `DELETE FROM filler_assets WHERE id = $1 AND account_id = $2 RETURNING id`,
      [req.params.id, accountId(req)]
    );
    if (!row) throw notFound('Filler asset not found');
    // Its thumbnail, frames and sprite sheets go with it (sprite_sheets rows cascade).
    await (await import('../services/media/fillerThumbs')).deleteFillerThumbs(accountId(req), String(req.params.id)).catch(() => {});
    // and its house preview (migration 0161)
    await (await import('../services/media/fillerPreview')).removeFillerPreview(String(req.params.id)).catch(() => {});
    res.status(204).end();
  })
);
