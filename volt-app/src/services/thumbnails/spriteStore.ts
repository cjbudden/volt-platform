// ============================================================================
//  SPRITE STORE: where sprite sheets and their WebVTTs live, and the table that
//  manages them (docs/THUMBNAILS.md "Where sprites live").
//
//  Sprite sheets are system files. The player's hover previews, the recording
//  and clip timelines and the asset actions use them; nobody picks one as an
//  image. So they are kept out of the Image Library: no media_files row, no
//  library folder. They live in the store's machine-generated area, which the
//  signed image service already serves for the account:
//
//    derived/{account}/sprites/streams/{stream}/{YYYY-MM-DD}/{HH}/
//        {stream}-{YYYYMMDD}-{HH}-m{MM}.jpg     one sheet per 10 minutes of a live stream
//        {stream}-{YYYYMMDD}-{HH}.vtt           the hour's WebVTT
//    derived/{account}/sprites/assets/{asset}/
//        sheet-000.jpg ...                      an uploaded file's sheets (after its encode)
//        thumbs.vtt                             a clip's WebVTT, re-timed from its stream's hours
//
//  Every object there has a sprite_sheets row (migration 0112): owner (stream
//  hour or asset), layout, tiles, bytes. That row is how sprites are counted,
//  listed and removed; the layout the readers use stays where it was
//  (storyboards.sheets for streams, vod_assets.sprite for uploaded files).
//
//  Sheets made before this lived in the library (library/{account}/thumbnails/
//  .../storyboard/ and thumbnails/files/{asset}/) with a library row each.
//  relocateLegacySprites() moves them here once, rewrites the keys that point
//  at them and drops their library rows. It is safe to run again and again: it
//  only touches what still uses an old key.
// ============================================================================
import { one, query } from '../../db';
import { imageStore } from '../imageStore';

export const spriteRoot = (accountId: string) => `derived/${accountId}/sprites`;

/** A live stream's sheet or VTT: the hour's folder (thumbnails/{stream}/{date}/{HH}) under streams/. */
export function streamSpriteKey(accountId: string, unitFolder: string, name: string): string {
  return `${spriteRoot(accountId)}/streams/${unitFolder.replace(/^thumbnails\//, '')}/${name}`;
}

/** An asset's own sheet or VTT. */
export const assetSpriteKey = (accountId: string, assetId: string, name: string) => `${spriteRoot(accountId)}/assets/${assetId}/${name}`;

export const isSpriteKey = (key: string | null | undefined) => !!key && /^derived\/[^/]+\/sprites\//.test(key);

export interface SpriteRow {
  accountId: string;
  ownerKind: 'stream' | 'asset';
  kind?: 'sheet' | 'vtt';
  storeKey: string;
  streamKind?: 'channel' | 'event' | null;
  streamId?: string | null;
  storyboardId?: string | null;
  vodAssetId?: string | null;
  startMs?: number | null;
  intervalMs?: number | null;
  tileW?: number | null;
  tileH?: number | null;
  cols?: number | null;
  rows?: number | null;
  tiles?: number;
  width?: number | null;
  height?: number | null;
  sizeBytes: number;
}

/** Record (or refresh) the row for a sprite object. */
export async function recordSprite(r: SpriteRow): Promise<void> {
  await query(
    `INSERT INTO sprite_sheets (account_id, owner_kind, kind, store_key, stream_kind, stream_id, storyboard_id, vod_asset_id,
       start_ms, interval_ms, tile_w, tile_h, cols, rows, tiles, width, height, size_bytes)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
     ON CONFLICT (store_key) DO UPDATE SET
       storyboard_id = COALESCE(EXCLUDED.storyboard_id, sprite_sheets.storyboard_id),
       vod_asset_id = COALESCE(EXCLUDED.vod_asset_id, sprite_sheets.vod_asset_id),
       start_ms = EXCLUDED.start_ms, interval_ms = EXCLUDED.interval_ms, tile_w = EXCLUDED.tile_w, tile_h = EXCLUDED.tile_h,
       cols = EXCLUDED.cols, rows = EXCLUDED.rows, tiles = EXCLUDED.tiles, width = EXCLUDED.width, height = EXCLUDED.height,
       size_bytes = EXCLUDED.size_bytes, updated_at = now()`,
    [r.accountId, r.ownerKind, r.kind ?? 'sheet', r.storeKey, r.streamKind ?? null, r.streamId ?? null, r.storyboardId ?? null,
     r.vodAssetId ?? null, r.startMs ?? null, r.intervalMs ?? null, r.tileW ?? null, r.tileH ?? null, r.cols ?? null, r.rows ?? null,
     r.tiles ?? 0, r.width ?? null, r.height ?? null, r.sizeBytes]);
}

/** Delete sprite objects and their rows (best effort on the objects). */
export async function deleteSprites(keys: string[]): Promise<number> {
  if (!keys.length) return 0;
  for (const k of keys) await imageStore().delete(k).catch(() => { /* already gone */ });
  await query(`DELETE FROM sprite_sheets WHERE store_key = ANY($1::text[])`, [keys]);
  return keys.length;
}

/** An asset's sprite objects other than `keep` (sheets left over from a longer earlier build, an old VTT). */
export async function staleAssetSprites(assetId: string, keep: string[], kind: 'sheet' | 'vtt' = 'sheet'): Promise<string[]> {
  const rows = await query<{ store_key: string }>(
    `SELECT store_key FROM sprite_sheets WHERE vod_asset_id = $1 AND kind = $2 AND NOT (store_key = ANY($3::text[]))`, [assetId, kind, keep]);
  return rows.map((r) => r.store_key);
}

/** What an account holds, by owner kind (Account > Storage, capacity planning). */
export async function spriteUsage(accountId: string): Promise<{ ownerKind: string; kind: string; files: number; bytes: number }[]> {
  const rows = await query<any>(
    `SELECT owner_kind, kind, count(*)::int AS files, COALESCE(sum(size_bytes), 0)::bigint AS bytes
       FROM sprite_sheets WHERE account_id = $1 GROUP BY owner_kind, kind ORDER BY owner_kind, kind`, [accountId]);
  return rows.map((r) => ({ ownerKind: r.owner_kind, kind: r.kind, files: r.files, bytes: Number(r.bytes) }));
}

// ---------------------------------------------------------------- relocation of the old layout
async function moveObject(from: string, to: string): Promise<number | null> {
  const s = imageStore();
  if (from === to) return (await s.stat(to))?.size ?? null;
  if (await s.exists(from)) {
    await s.move(from, to);
  } else if (!(await s.exists(to))) {
    return null;   // gone at both ends: the key is dropped by the caller
  }
  return (await s.stat(to))?.size ?? null;
}

export interface RelocationReport { hours: number; assets: number; clipVtts: number; objects: number; missing: number; libraryRows: number; done: boolean }

/** True while anything still uses an old (library) sprite key or the library still lists a sheet. */
export async function legacySpritesRemain(): Promise<boolean> {
  const r = await one<{ n: number }>(
    `SELECT ((SELECT count(*) FROM (SELECT 1 FROM storyboards WHERE sheets::text LIKE '%"library/%' OR vtt_key LIKE 'library/%' LIMIT 1) a)
           + (SELECT count(*) FROM (SELECT 1 FROM vod_assets WHERE sprite::text LIKE '%"library/%'
                                     OR (thumbs_vtt_key LIKE 'library/%/thumbnails/%/clips/%.vtt') LIMIT 1) b)
           + (SELECT count(*) FROM (SELECT 1 FROM media_files WHERE kind = 'storyboard' LIMIT 1) c))::int AS n`);
  return (r?.n ?? 0) > 0;
}

/**
 * Move sprite sheets and VTTs out of the Image Library into the sprite store.
 * `skipStreams`: streams being built right now (their hours are moved on a later run).
 * A batch at a time; call again until `done`.
 */
export async function relocateLegacySprites(opts: { batch?: number; skipStreams?: Set<string> } = {}): Promise<RelocationReport> {
  const batch = opts.batch ?? 200;
  const rep: RelocationReport = { hours: 0, assets: 0, clipVtts: 0, objects: 0, missing: 0, libraryRows: 0, done: false };
  const dropRows = async (acct: string, keys: string[]) => {
    if (!keys.length) return;
    const r = await query<any>(`DELETE FROM media_files WHERE account_id = $1 AND store_key = ANY($2::text[]) RETURNING folder`, [acct, keys]);
    rep.libraryRows += r.length;
    if (r.length) await (await import('../media/libraryMoves')).pruneEmptyFolders(acct, [...new Set(r.map((x: any) => x.folder as string))]).catch(() => 0);
  };

  // 1. Live streams: every hour whose sheets or VTT still have a library key.
  const hours = await query<any>(
    `SELECT * FROM storyboards WHERE sheets::text LIKE '%"library/%' OR vtt_key LIKE 'library/%' ORDER BY unit_start DESC LIMIT $1`, [batch]);
  for (const sb of hours) {
    if (opts.skipStreams?.has(sb.stream_id)) continue;
    const acct: string = sb.account_id;
    const old: string[] = [];
    const sheets: any[] = [];
    for (const sh of sb.sheets ?? []) {
      if (isSpriteKey(sh.key)) { sheets.push(sh); continue; }
      const to = streamSpriteKey(acct, sb.folder, String(sh.key).split('/').pop()!);
      const size = await moveObject(sh.key, to);
      old.push(sh.key);
      if (size == null) { rep.missing++; continue; }   // the picture is gone: drop the sheet, its tiles show nothing anyway
      rep.objects++;
      sheets.push({ ...sh, key: to });
      await recordSprite({ accountId: acct, ownerKind: 'stream', storeKey: to, streamKind: sb.stream_kind, streamId: sb.stream_id, storyboardId: sb.id,
        startMs: Number(sh.start_ms), intervalMs: sb.interval_ms, tileW: sb.tile_w, tileH: sb.tile_h, cols: sb.cols, rows: sb.rows,
        tiles: (sh.filled ?? []).length, width: sb.cols * sb.tile_w, height: sb.rows * sb.tile_h, sizeBytes: size });
    }
    let vttKey: string | null = sb.vtt_key;
    if (vttKey && !isSpriteKey(vttKey)) {
      const to = streamSpriteKey(acct, sb.folder, vttKey.split('/').pop()!);
      const size = await moveObject(vttKey, to);
      vttKey = size == null ? null : to;
      if (size != null) {
        rep.objects++;
        await recordSprite({ accountId: acct, ownerKind: 'stream', kind: 'vtt', storeKey: to, streamKind: sb.stream_kind, streamId: sb.stream_id,
          storyboardId: sb.id, startMs: new Date(sb.unit_start).getTime(), sizeBytes: size });
      }
    }
    await query(`UPDATE storyboards SET sheets = $2::jsonb, vtt_key = $3, updated_at = now() WHERE id = $1`, [sb.id, JSON.stringify(sheets), vttKey]);
    await dropRows(acct, old);
    rep.hours++;
  }

  // 2. Uploaded files: vod_assets.sprite sheets under thumbnails/files/{asset}/.
  const assets = await query<any>(
    `SELECT v.id, v.sprite, v.storyboard_key, COALESCE(gc.account_id, ge.account_id, v.account_id) AS account_id
       FROM vod_assets v LEFT JOIN channels c ON c.id = v.channel_id LEFT JOIN groups gc ON gc.id = c.group_id
       LEFT JOIN events e ON e.id = v.event_id LEFT JOIN groups ge ON ge.id = e.group_id
      WHERE v.sprite::text LIKE '%"library/%' LIMIT $1`, [batch]);
  for (const a of assets) {
    const acct: string = a.account_id;
    const sp = a.sprite;
    const old: string[] = [];
    const sheets: any[] = [];
    let first: string | null = null;
    for (const sh of sp.sheets ?? []) {
      if (isSpriteKey(sh.key)) { sheets.push(sh); continue; }
      const to = assetSpriteKey(acct, a.id, String(sh.key).split('/').pop()!);
      const size = await moveObject(sh.key, to);
      old.push(sh.key);
      if (size == null) { rep.missing++; continue; }
      rep.objects++;
      sheets.push({ ...sh, key: to });
      if (a.storyboard_key === sh.key) first = to;
      await recordSprite({ accountId: acct, ownerKind: 'asset', storeKey: to, vodAssetId: a.id, startMs: Number(sh.from), intervalMs: sp.intervalMs,
        tileW: sp.tileW, tileH: sp.tileH, cols: sp.cols, rows: sp.rows, tiles: sh.tiles, width: sp.cols * sp.tileW, height: sp.rows * sp.tileH, sizeBytes: size });
    }
    const next = sheets.length ? { ...sp, folder: `sprites/assets/${a.id}`, sheets } : null;
    await query(
      `UPDATE vod_assets SET sprite = $2::jsonb, storyboard_key = CASE WHEN storyboard_key = ANY($4::text[]) THEN $3 ELSE storyboard_key END WHERE id = $1`,
      [a.id, next ? JSON.stringify(next) : null, first ?? sheets[0]?.key ?? null, old]);
    await dropRows(acct, old);
    rep.assets++;
  }

  // 3. Clip VTTs written beside a stream's thumbnails (thumbnails/{stream}/clips/).
  const clips = await query<any>(
    `SELECT v.id, v.thumbs_vtt_key, COALESCE(gc.account_id, ge.account_id, v.account_id) AS account_id
       FROM vod_assets v LEFT JOIN channels c ON c.id = v.channel_id LEFT JOIN groups gc ON gc.id = c.group_id
       LEFT JOIN events e ON e.id = v.event_id LEFT JOIN groups ge ON ge.id = e.group_id
      WHERE v.thumbs_vtt_key LIKE 'library/%/thumbnails/%/clips/%.vtt' LIMIT $1`, [batch]);
  for (const a of clips) {
    // The old VTT's sheet URLs point at the old sheet keys: it is written again, not moved.
    await imageStore().delete(a.thumbs_vtt_key).catch(() => {});
    await query(`UPDATE vod_assets SET thumbs_vtt_key = NULL WHERE id = $1`, [a.id]);
    const { writeClipThumbnails } = await import('./clips');
    await writeClipThumbnails(a.id).catch((e) => console.warn(`[sprites] clip VTT ${a.id} not rewritten`, e));
    rep.clipVtts++;
  }

  // 4. Library rows for sheets nothing points at any more (an hour swept, an asset rebuilt):
  //    their pictures cannot be shown by anything, so the files go with the rows.
  if (!hours.length && !assets.length && !clips.length) {
    const orphans = await query<any>(`SELECT id, account_id, store_key, folder FROM media_files WHERE kind = 'storyboard' LIMIT $1`, [batch]);
    for (const o of orphans) await imageStore().delete(o.store_key).catch(() => {});
    if (orphans.length) {
      await query(`DELETE FROM media_files WHERE id = ANY($1::uuid[])`, [orphans.map((o) => o.id)]);
      rep.libraryRows += orphans.length;
      const { pruneEmptyFolders } = await import('../media/libraryMoves');
      for (const acct of new Set(orphans.map((o) => o.account_id as string)))
        await pruneEmptyFolders(acct, [...new Set(orphans.filter((o) => o.account_id === acct).map((o) => o.folder as string))]).catch(() => 0);
    }
  }
  rep.done = !(await legacySpritesRemain());
  return rep;
}
