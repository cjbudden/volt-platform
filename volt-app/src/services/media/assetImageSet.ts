// ============================================================================
//  AN ASSET'S IMAGES, BY TYPE (docs/ASSET_IMAGES.md section 13).
//
//  The primary image (vod_assets.poster_key, assetImage.ts) answers for the
//  Thumbnail on video and the Cover on audio. Every other type an asset offers
//  is a vod_asset_images row, or, when it has none, its fallback cropped to the
//  type's shape (marked derived). Types are per account (asset_image_types),
//  seeded from STANDARD_IMAGE_TYPES the first time an account asks.
// ============================================================================
import { one, query } from '../../db';
import { signedImageUrl } from '../../modules/images';
import { imageStore } from '../imageStore';
import {
  STANDARD_IMAGE_TYPES, cleanType, typesFor, primaryTypeKey, resolveFallback, specFor, fitWarnings, aspectLabel,
  type ImageType, type Media, type Focus, type Slot,
} from './assetImageRules';
import { isAudioAsset, libraryKey, placeOf, setAssetImage, pickAssetImage, framePosterName } from './assetImage';
import { saveToLibrary, IMAGE_KEYS } from './libraryImages';
import { assetFolder } from './libraryPaths';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ---------------------------------------------------------------- types

const row2type = (r: any): ImageType => ({
  key: r.key, label: r.label, description: r.description ?? '', purpose: r.purpose,
  aspectW: r.aspect_w ?? null, aspectH: r.aspect_h ?? null, minWidth: Number(r.min_width) || 0, minHeight: Number(r.min_height) || 0,
  appliesTo: r.applies_to ?? [], primaryFor: r.primary_for ?? [], fallback: r.fallback ?? [], transparent: !!r.transparent,
  isStandard: !!r.is_standard, enabled: !!r.enabled, sort: Number(r.sort) || 0,
});

const seeded = new Set<string>();

/** Seed the standard types for an account (once per process; ON CONFLICT keeps an account's edits). */
export async function ensureStandardImageTypes(acct: string): Promise<void> {
  if (seeded.has(acct)) return;
  for (const t of STANDARD_IMAGE_TYPES) {
    await query(`INSERT INTO asset_image_types (account_id, key, label, description, purpose, aspect_w, aspect_h, min_width, min_height, applies_to, primary_for, fallback, transparent, is_standard, enabled, sort)
                 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,true,true,$14) ON CONFLICT (account_id, key) DO NOTHING`,
      [acct, t.key, t.label, t.description, t.purpose, t.aspectW, t.aspectH, t.minWidth, t.minHeight, t.appliesTo, t.primaryFor, t.fallback, t.transparent, t.sort]);
  }
  seeded.add(acct);
}

export async function listImageTypes(acct: string): Promise<ImageType[]> {
  await ensureStandardImageTypes(acct);
  const rows = await query<any>(`SELECT * FROM asset_image_types WHERE account_id = $1 ORDER BY sort, key`, [acct]);
  return rows.map(row2type);
}

export async function saveImageType(acct: string, key: string | null, input: any): Promise<ImageType> {
  const all = await listImageTypes(acct);
  const existing = key ? all.find((t) => t.key === key) ?? null : null;
  if (key && !existing) throw Object.assign(new Error('no such image type'), { status: 404 });
  const t = cleanType(input ?? {}, existing, new Set(all.map((x) => x.key)));
  await query(`INSERT INTO asset_image_types (account_id, key, label, description, purpose, aspect_w, aspect_h, min_width, min_height, applies_to, primary_for, fallback, transparent, is_standard, enabled, sort)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
               ON CONFLICT (account_id, key) DO UPDATE SET label = EXCLUDED.label, description = EXCLUDED.description, purpose = EXCLUDED.purpose,
                 aspect_w = EXCLUDED.aspect_w, aspect_h = EXCLUDED.aspect_h, min_width = EXCLUDED.min_width, min_height = EXCLUDED.min_height,
                 applies_to = EXCLUDED.applies_to, fallback = EXCLUDED.fallback, transparent = EXCLUDED.transparent, enabled = EXCLUDED.enabled,
                 sort = EXCLUDED.sort, updated_at = now()`,
    [acct, t.key, t.label, t.description, t.purpose, t.aspectW, t.aspectH, t.minWidth, t.minHeight, t.appliesTo, t.primaryFor, t.fallback, t.transparent, t.isStandard, t.enabled, t.sort]);
  return t;
}

/**
 * Remove an account's own type. Standard types are switched off instead.
 * Refused while assets still hold images of it, unless `force` (then those go too).
 */
export async function deleteImageType(acct: string, key: string, force = false): Promise<{ removed: boolean; images: number }> {
  const t = (await listImageTypes(acct)).find((x) => x.key === key);
  if (!t) throw Object.assign(new Error('no such image type'), { status: 404 });
  if (t.isStandard) throw Object.assign(new Error(`${t.label} is a standard type: switch it off instead`), { status: 400 });
  const n = Number((await one<any>(`SELECT count(*)::int AS n FROM vod_asset_images WHERE account_id = $1 AND type_key = $2`, [acct, key]))?.n ?? 0);
  if (n && !force) throw Object.assign(new Error(`${n} asset${n === 1 ? ' has' : 's have'} a ${t.label} image. Remove ${n === 1 ? 'it' : 'them'} first, or delete with force.`), { status: 409 });
  await query(`DELETE FROM vod_asset_images WHERE account_id = $1 AND type_key = $2`, [acct, key]);
  await query(`DELETE FROM asset_image_types WHERE account_id = $1 AND key = $2`, [acct, key]);
  // Other types that fell back to it no longer do.
  await query(`UPDATE asset_image_types SET fallback = array_remove(fallback, $2), updated_at = now() WHERE account_id = $1 AND $2 = ANY(fallback)`, [acct, key]);
  return { removed: true, images: n };
}

// ---------------------------------------------------------------- an asset's images

async function ownedAsset(id: string, acct: string) {
  if (!UUID.test(id)) return null;
  return one<any>(`
    SELECT v.*, c.kind AS channel_kind, c.name AS channel_name, e.name AS event_name, s.standard_key AS schema_key,
           COALESCE(g.account_id, v.account_id) AS acct
      FROM vod_assets v
      LEFT JOIN channels c ON c.id = v.channel_id
      LEFT JOIN events e ON e.id = v.event_id
      LEFT JOIN groups g ON g.id = COALESCE(c.group_id, e.group_id)
      LEFT JOIN metadata_schemas s ON s.id = v.schema_id
     WHERE v.id = $1 AND COALESCE(g.account_id, v.account_id) = $2`, [id, acct]);
}

const sign = (key: string | null | undefined, spec: string) => {
  if (!key) return null;
  try { return signedImageUrl(key, spec); } catch { return null; }
};

export interface ImageSlotView {
  type: ImageType & { aspect: string; primary: boolean };
  /** The image of this type. For the primary type, the asset's primary image. */
  image: null | {
    key: string; url: string | null; previewUrl: string | null; sourceUrl?: string | null; width: number | null; height: number | null;
    focus: Focus | null; source: string | null; locked?: boolean; reason?: string | null; chosenBy?: string | null; updatedAt?: string | null; missing?: boolean;
  };
  /** No image of its own: what portals get instead, cropped to this shape. */
  fallback: null | { from: string; key: string; url: string | null; previewUrl: string | null; derived: true };
  warnings: string[];
}

export interface AssetImagesView {
  assetId: string; media: Media; primaryType: string; title: string | null;
  slots: ImageSlotView[];
  /** type key → the URL a portal should use (own image, else the derived fallback). Null when nothing at all. */
  urls: Record<string, string | null>;
}

/** Display width for a type's main URL: its minimum, kept within what the image service renders. */
const displayWidth = (t: ImageType) => Math.min(Math.max(t.minWidth || 1280, 320), 2560);

export async function assetImages(assetId: string, acct: string, opts: { fallback?: boolean } = {}): Promise<AssetImagesView | null> {
  const a = await ownedAsset(assetId, acct);
  if (!a) return null;
  const media: Media = isAudioAsset(a) ? 'audio' : 'video';
  const pk = primaryTypeKey(media);
  const types = typesFor(await listImageTypes(acct), media);
  const rows = await query<any>(`SELECT * FROM vod_asset_images WHERE asset_id = $1`, [a.id]);
  // Sizes of every image involved, from the library rows, in one query.
  const keys = [...new Set([a.poster_key, ...rows.map((r) => r.image_key)].filter(Boolean))];
  const dims = new Map<string, { w: number | null; h: number | null }>();
  if (keys.length) for (const r of await query<any>(`SELECT store_key, width, height FROM media_files WHERE account_id = $1 AND store_key = ANY($2)`, [acct, keys]))
    dims.set(r.store_key, { w: r.width ?? null, h: r.height ?? null });
  const own: Record<string, Slot> = {};
  for (const r of rows) own[r.type_key] = { key: r.image_key, width: r.width ?? dims.get(r.image_key)?.w ?? null, height: r.height ?? dims.get(r.image_key)?.h ?? null };
  const primary: string | null = a.poster_key ?? null;
  const v = primaryVersion(a);

  const slots: ImageSlotView[] = types.map((t) => {
    const isPrimary = t.key === pk;
    const typeView = { ...t, aspect: aspectLabel(t), primary: isPrimary };
    if (isPrimary) {
      const d = primary ? dims.get(primary) : undefined;
      return {
        type: typeView,
        image: primary ? { key: primary, url: sign(primary, specFor(t, displayWidth(t), null, { version: v })), previewUrl: sign(primary, specFor(t, 480, null, { version: v })),
          width: d?.w ?? null, height: d?.h ?? null, focus: null, source: a.poster_source ?? null, locked: !!a.poster_locked, reason: a.poster_reason ?? null,
          updatedAt: a.poster_picked_at ?? null } : null,
        fallback: null,
        warnings: primary && a.poster_source === 'manual' ? fitWarnings(t, d?.w, d?.h) : [],
      };
    }
    const r = rows.find((x) => x.type_key === t.key);
    if (r) {
      const focus = r.focus_x != null && r.focus_y != null ? { x: r.focus_x, y: r.focus_y } : null;
      const ver = String(new Date(r.updated_at).getTime());
      const w = own[t.key].width, h = own[t.key].height;
      return {
        type: typeView,
        image: { key: r.image_key, url: sign(r.image_key, specFor(t, displayWidth(t), focus, { version: ver })), previewUrl: sign(r.image_key, specFor(t, 480, focus, { version: ver })),
          sourceUrl: sign(r.image_key, t.transparent ? '960x0,inside,fmt=png' : '960x0,inside'),
          width: w ?? null, height: h ?? null, focus, source: r.source, chosenBy: r.chosen_by ?? null, updatedAt: r.updated_at, missing: !dims.has(r.image_key) },
        fallback: null,
        warnings: [...fitWarnings(t, w, h), ...(!dims.has(r.image_key) ? ['This image is no longer in the Image Library.'] : [])],
      };
    }
    const fb = opts.fallback === false ? null : resolveFallback(t, own, primary, pk);
    const fbFocus = fb && fb.from !== pk && rows.find((x) => x.type_key === fb.from);
    const ff = fbFocus && fbFocus.focus_x != null ? { x: fbFocus.focus_x, y: fbFocus.focus_y } : null;
    return {
      type: typeView, image: null,
      fallback: fb ? { from: fb.from, key: fb.key, url: sign(fb.key, specFor(t, displayWidth(t), ff, { version: v })), previewUrl: sign(fb.key, specFor(t, 480, ff, { version: v })), derived: true } : null,
      warnings: [],
    };
  });
  const urls: Record<string, string | null> = {};
  for (const s of slots) urls[s.type.key] = s.image?.url ?? s.fallback?.url ?? null;
  return { assetId: a.id, media, primaryType: pk, title: a.title ?? null, slots, urls };
}

const primaryVersion = (a: any) => a.poster_picked_at ? String(new Date(a.poster_picked_at).getTime()) : '';

/**
 * Choose an image for a type. `ref` is an Image Library reference of this
 * account (/library/<acct>/<path>) or one of the asset's candidate frames
 * (copied into the asset's library folder). For the primary type this is the
 * same as choosing the asset's image (it locks it).
 */
export async function setTypeImage(assetId: string, acct: string, typeKey: string, ref: string, by: string, focus?: Focus | null): Promise<void> {
  const a = await ownedAsset(assetId, acct);
  if (!a) throw Object.assign(new Error('VOD asset not found'), { status: 404 });
  const media: Media = isAudioAsset(a) ? 'audio' : 'video';
  const t = typesFor(await listImageTypes(acct), media).find((x) => x.key === typeKey);
  if (!t) throw Object.assign(new Error(`"${typeKey}" is not an image type for ${media} assets in this account`), { status: 400 });
  if (t.key === primaryTypeKey(media)) { await setAssetImage(a.id, acct, ref, by); return; }

  let key = libraryKey(ref, acct) ?? (ref.startsWith(`library/${acct}/`) ? ref : null);
  let source = 'manual';
  const cand = !key && (a.poster_candidates ?? []).find((c: any) => c.key === ref.replace(/^\//, ''));
  if (cand) {
    const buf = await imageStore().get(cand.key);
    if (!buf) throw Object.assign(new Error('that frame is no longer stored'), { status: 400 });
    key = await saveToLibrary(acct, assetFolder(placeOf(a)), framePosterName(buf, a.title, t.key), buf, 'image/jpeg', 'poster', { assetId: a.id, imageType: t.key, frameAtMs: cand.atMs ?? null, chosenBy: by }, a.title ?? undefined);
    source = 'frame';
  }
  if (!key) throw Object.assign(new Error('choose an image from this account\'s Image Library or one of the asset\'s frames'), { status: 400 });
  const d = await one<any>(`SELECT width, height FROM media_files WHERE account_id = $1 AND store_key = $2`, [acct, key]);
  if (!d && !cand) throw Object.assign(new Error('that image is not in this account\'s Image Library'), { status: 400 });
  await query(`INSERT INTO vod_asset_images (asset_id, account_id, type_key, image_key, focus_x, focus_y, width, height, source, chosen_by)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
               ON CONFLICT (asset_id, type_key) DO UPDATE SET image_key = EXCLUDED.image_key, focus_x = EXCLUDED.focus_x, focus_y = EXCLUDED.focus_y,
                 width = EXCLUDED.width, height = EXCLUDED.height, source = EXCLUDED.source, chosen_by = EXCLUDED.chosen_by, updated_at = now()`,
    [a.id, acct, t.key, key, focus ? Math.round(focus.x) : null, focus ? Math.round(focus.y) : null, d?.width ?? null, d?.height ?? null, source, by]);
  await query(`UPDATE vod_assets SET updated_at = now() WHERE id = $1`, [a.id]);
}

/** Move the focus point of a type's image (where portals crop it). */
export async function setTypeFocus(assetId: string, acct: string, typeKey: string, focus: Focus | null): Promise<boolean> {
  const r = await query(`UPDATE vod_asset_images SET focus_x = $4, focus_y = $5, updated_at = now()
                          WHERE asset_id = $1 AND account_id = $2 AND type_key = $3 RETURNING type_key`,
    [assetId, acct, typeKey, focus ? Math.round(focus.x) : null, focus ? Math.round(focus.y) : null]);
  return r.length > 0;
}

/**
 * Remove a type's image: it falls back again. For the primary type, Volt
 * picks the asset's image automatically again (unlocks a person's choice).
 */
export async function clearTypeImage(assetId: string, acct: string, typeKey: string, by?: string): Promise<{ was: string | null }> {
  const a = await ownedAsset(assetId, acct);
  if (!a) throw Object.assign(new Error('VOD asset not found'), { status: 404 });
  const media: Media = isAudioAsset(a) ? 'audio' : 'video';
  if (typeKey === primaryTypeKey(media)) {
    const was = a.poster_key ?? null;
    await pickAssetImage(a.id, { force: true, lookup: false, by });
    return { was };
  }
  const r = await one<any>(`DELETE FROM vod_asset_images WHERE asset_id = $1 AND account_id = $2 AND type_key = $3 RETURNING image_key`, [a.id, acct, typeKey]);
  if (r) await query(`UPDATE vod_assets SET updated_at = now() WHERE id = $1`, [a.id]);
  return { was: r?.image_key ?? null };
}

/** Assets that use a library image as one of their typed images (for the library's delete warning). */
export async function assetsUsingImage(acct: string, key: string): Promise<{ assetId: string; title: string | null; typeKey: string }[]> {
  const rows = await query<any>(`SELECT i.asset_id, i.type_key, v.title FROM vod_asset_images i JOIN vod_assets v ON v.id = i.asset_id
                                  WHERE i.account_id = $1 AND i.image_key = $2 ORDER BY v.title LIMIT 200`, [acct, key]);
  return rows.map((r) => ({ assetId: r.asset_id, title: r.title ?? null, typeKey: r.type_key }));
}

/**
 * Image fields a person changed in the metadata form, applied during the save.
 *
 * Before this, saving a new image in a field only queued a background pick,
 * and nothing at all when someone had once chosen the image by hand (locked),
 * so the old image stayed on screen. Now a changed field is the person's choice:
 *  - a field named after one of the asset's other image types (poster, hero,
 *    banner, social, title, an account's own type, cover on video) fills or
 *    clears that type's slot;
 *  - any other image field (image, thumbnail, artwork, cover on audio, or an
 *    image-typed field of the content type) becomes the main image at once,
 *    that field first, over a lock; cleared, Volt picks automatically again.
 * `primary` says the main image was handled here (so no background pick is queued).
 */
export async function applyImageFieldChanges(assetId: string, acct: string, before: Record<string, any>, after: Record<string, any>, by: string): Promise<{ primary: boolean; primaryField: string | null; slots: string[] }> {
  const out = { primary: false, primaryField: null as string | null, slots: [] as string[] };
  const a = await ownedAsset(assetId, acct);
  if (!a) return out;
  const media: Media = isAudioAsset(a) ? 'audio' : 'video';
  const pk = primaryTypeKey(media);
  const types = typesFor(await listImageTypes(acct), media);
  const schemaFields: any[] = a.schema_id ? ((await one<any>(`SELECT fields FROM metadata_schemas WHERE id = $1`, [a.schema_id]))?.fields ?? []) : [];
  const imageish = (k: string) => schemaFields.some((f) => f.key === k && f.type === 'image') || IMAGE_KEYS.test(k) || types.some((t) => t.key === k);
  const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
  const changed = [...new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})])].filter((k) => imageish(k) && str(before?.[k]) !== str(after?.[k]));
  for (const k of changed) {
    const slot = types.find((t) => t.key === k && t.key !== pk);
    if (slot) {
      const v = str(after?.[k]);
      const key = libraryKey(v, acct);
      if (!v) await clearTypeImage(a.id, acct, k, by);
      else if (key) await setTypeImage(a.id, acct, k, `/${key}`, by);
      out.slots.push(k);
      continue;
    }
    out.primaryField ??= k;
  }
  if (out.primaryField) {
    await pickAssetImage(a.id, { force: true, lookup: false, by, prefer: out.primaryField });
    out.primary = true;
  }
  return out;
}

/**
 * WHAT A PICKER OPENS ON for an asset: its own images before the whole library,
 * so a video is not given someone else's album cover by mistake.
 *   inUse    the images it uses now (main image, typed images)
 *   own      made or uploaded for it: frames Volt saved for it, anything in its folder
 *   cover    a song's cover (audio that is a song)
 *   stills   encoder stills taken while it was on air (up to 48, spread evenly)
 */
export async function relatedImages(assetId: string, acct: string): Promise<null | { folder: string; media: Media; groups: { key: string; label: string; files: any[] }[] }> {
  const a = await ownedAsset(assetId, acct);
  if (!a) return null;
  const media: Media = isAudioAsset(a) ? 'audio' : 'video';
  const folder = assetFolder(placeOf(a));
  const shape = (r: any) => { const { search, ...row } = r; return { ...row, url: `/${r.store_key}` }; };
  const like = (p: string) => `${p.replace(/[\\%_]/g, '\\$&')}/%`;
  const usedKeys = [a.poster_key, ...(await query<any>(`SELECT image_key FROM vod_asset_images WHERE asset_id = $1`, [a.id])).map((r) => r.image_key)].filter(Boolean);
  const inUse = usedKeys.length ? await query<any>(`SELECT * FROM media_files WHERE account_id = $1 AND store_key = ANY($2::text[])`, [acct, usedKeys]) : [];
  const own = await query<any>(`
    SELECT * FROM media_files WHERE account_id = $1 AND kind <> 'storyboard' AND COALESCE(source, '') <> 'encoder'
       AND (metadata->>'assetId' = $2 OR folder = $3 OR folder LIKE $4) ORDER BY created_at DESC LIMIT 60`, [acct, a.id, folder, like(folder)]);
  let cover: any[] = [];
  if (media === 'audio') {
    const { songIdentity } = await import('./musicLookup');
    const who = songIdentity({ title: a.title, metadata: a.metadata, ingest: a.ingest, override: a.music_lookup?.query });
    if (who) cover = await query<any>(`SELECT * FROM media_files WHERE account_id = $1 AND kind = 'cover'
                                         AND lower(metadata->>'artist') = lower($2) AND (lower(metadata->>'song') = lower($3) OR lower(metadata->>'album') = lower($4))
                                       ORDER BY created_at LIMIT 6`, [acct, who.artist, who.title, a.metadata?.album ?? '']);
  }
  let stills: any[] = [];
  const from = Number(a.start_epoch_ms), to = Number(a.end_epoch_ms);
  if (a.channel_id && from > 0 && to > from) {
    stills = await query<any>(`
      SELECT * FROM (SELECT f.*, ntile(48) OVER (ORDER BY captured_at) AS slot FROM media_files f
                      WHERE account_id = $1 AND source = 'encoder' AND kind = 'keyframe' AND channel_id = $2 AND captured_at >= $3 AND captured_at <= $4) x
       WHERE x.slot IS NOT NULL ORDER BY captured_at`, [acct, a.channel_id, new Date(from), new Date(to)]);
    const bySlot = new Map<number, any>(); for (const s of stills) if (!bySlot.has(s.slot)) bySlot.set(s.slot, s);
    stills = [...bySlot.values()].map(({ slot, ...r }) => r);
  }
  const seen = new Set<string>();
  const uniq = (rows: any[]) => rows.filter((r) => !seen.has(r.id) && seen.add(r.id)).map(shape);
  const groups = [
    { key: 'inUse', label: 'Used by this asset now', files: uniq(inUse) },
    { key: 'own', label: 'Made or uploaded for this asset', files: uniq(own) },
    { key: 'cover', label: 'The song\'s cover', files: uniq(cover) },
    { key: 'stills', label: 'Stills from the stream while it aired', files: uniq(stills) },
  ].filter((g) => g.files.length);
  return { folder, media, groups };
}
