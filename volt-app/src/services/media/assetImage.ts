// ============================================================================
//  THE IMAGE THAT REPRESENTS AN ASSET (docs/ASSET_IMAGES.md).
//
//  One image per asset, in vod_assets.poster_key, which the library grid, the
//  player poster, app feeds and schema.org already read. pickAssetImage()
//  decides it, in this order, and says why (poster_source, poster_reason):
//
//    1. MANUAL       a person chose it (poster_locked): never replaced.
//    2. COVER ART    a song: MusicBrainz finds the recording, the Cover Art
//                    Archive the album cover, copied into the Image Library.
//                    Square. Empty song fields are filled on the way.
//    3. PROGRAMME    a radio programme from the guide with its own image. Square.
//    4. STATION      any other radio asset: the station's artwork, guide icon,
//                    feed icon or logo, else the account's logo. Square.
//    5. FRAME        video: the best of the frames we have (frameScore.ts):
//                    frames taken at upload, or the live stream's keyframes
//                    over the asset's span. The winner is copied into the
//                    Image Library, because live keyframes are swept after
//                    their retention and a poster must outlive them. Wide.
//    6. METADATA     an image the asset's metadata already names.
//    7. NONE         nothing yet; the grid shows the type's placeholder.
//
//  Run by the vod.image job: queued after an upload's encode, and by a leader
//  sweep for any asset nobody has picked an image for (so every way an asset
//  is created is covered without each one having to remember).
// ============================================================================
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { one, query } from '../../db';
import { imageStore } from '../imageStore';
import { upsertMediaRow } from '../mediaLibrary';
import { feedIconsFor, pickGuideIcon } from '../guideIcon';
import { frameStats, scoreFrame, pickFrame, clock, type Candidate } from './frameScore';
import { songIdentity, songMatch, fetchCoverFor, fillsFor, type MusicMatch } from './musicLookup';
import { getSongDetails, detailsToMatch } from './songDetails';
import { saveToLibrary, importImageUrl, LIBRARY_REF } from './libraryImages';
import { assetFolder, assetImageName, songFolder, stationFolder, programmeFolder, type AssetPlace } from './libraryPaths';

export { importImageUrl };

const run = promisify(execFile);

export type PosterSource = 'manual' | 'cover_art' | 'programme' | 'station' | 'frame' | 'live_frame' | 'metadata' | 'none';
export interface PickResult { source: PosterSource; key: string | null; shape: 'wide' | 'square' | null; reason: string; filled?: Record<string, any>; music?: MusicMatch | null; skipped?: string; lookedUp?: boolean; schemaId?: string }

const LIB = /^\/?library\/([0-9a-f-]{36})\/(.+)$/i;
void LIBRARY_REF;

/** Everything the decision needs about one asset. */
async function load(assetId: string) {
  return one<any>(`
    SELECT v.*, COALESCE(g.account_id, v.account_id) AS acct,
           c.kind AS channel_kind, c.name AS channel_name, c.brand_ref, c.guide_icon_ref, c.metadata AS channel_metadata,
           a.brand_logo_ref AS account_logo,
           s.standard_key AS schema_key, s.fields AS schema_fields,
           e.name AS event_name,
           (SELECT row_to_json(p) FROM (SELECT id, title, metadata, starts_at FROM programmes WHERE clip_asset_id = v.id ORDER BY starts_at DESC LIMIT 1) p) AS programme
      FROM vod_assets v
      LEFT JOIN channels c ON c.id = v.channel_id
      LEFT JOIN events e ON e.id = v.event_id
      LEFT JOIN groups g ON g.id = COALESCE(c.group_id, e.group_id)
      LEFT JOIN accounts a ON a.id = COALESCE(g.account_id, v.account_id)
      LEFT JOIN metadata_schemas s ON s.id = v.schema_id
     WHERE v.id = $1`, [assetId]);
}

/**
 * A frame's file name in the asset's library folder: poster-<content hash>.jpg.
 * It used to be poster.jpg every time, so choosing another frame overwrote the
 * file at the same key: the signed URL did not change and every cache (the
 * browser, the image service's source and derivative caches, the CDN) kept
 * showing the old picture. Named by content, a new frame is a new key and the
 * same frame chosen twice is still one file.
 */
export const framePosterName = (buf: Buffer, title?: string | null, type?: string | null) =>
  assetImageName(title, createHash('sha256').update(buf).digest('hex'), type);

/** Audio only: a radio station's asset, or an asset with audio exports and no video facts. */
export function isAudioAsset(a: any): boolean {
  if (a.channel_kind === 'radio') return true;
  if (a.ingest?.probe && a.ingest.probe.hasVideo === false) return true;
  return !!(a.export_mp3_key || a.export_m4a_key) && !a.top_height && !a.progressive_key;
}

/** A song: the song type, a song from a station's now-playing log, or audio whose tags name one. */
export function isSongAsset(a: any): boolean {
  if (a.schema_key === 'song') return true;
  if (a.metadata?.source === 'icy' && a.metadata?.class === 'song') return true;
  return isAudioAsset(a) && !!(a.ingest?.id3?.artist && a.ingest?.id3?.title);
}

/** The account's Song content type (the standard one), made if missing. */
export async function songType(acct: string): Promise<{ id: string; fields: any[] } | null> {
  const get = () => one<any>(`SELECT id, fields FROM metadata_schemas WHERE account_id = $1 AND standard_key = 'song' ORDER BY created_at LIMIT 1`, [acct]);
  let t = await get();
  if (!t) { await (await import('../contentTypes')).ensureStandardTypes(acct).catch(() => {}); t = await get(); }
  return t ? { id: t.id, fields: t.fields ?? [] } : null;
}

/** A library ref of THIS account as a store key, or null. */
export function libraryKey(ref: string | null | undefined, acct: string): string | null {
  const m = LIB.exec(String(ref ?? '').trim());
  return m && m[1].toLowerCase() === acct.toLowerCase() ? `library/${m[1]}/${m[2]}` : null;
}

/** The folder for an asset's images, by id (for routes that save images for it). */
export async function assetPlaceFolder(assetId: string): Promise<string | null> {
  const a = await load(assetId);
  return a ? assetFolder(placeOf(a)) : null;
}

/** Where this asset's images go (libraryPaths.ts). */
export function placeOf(a: any): AssetPlace {
  return { title: a.title, metadata: a.metadata, schemaKey: a.schema_key, channelName: a.channel_name, channelKind: a.channel_kind,
    // The date: the programme's start, else the recording's start, else when the asset was added
    // (an upload's start is stored as 0, which used to make the folder 1970-01-01).
    eventName: a.event_name, programmeTitle: a.programme?.title ?? null,
    when: a.programme?.starts_at ?? (Number(a.start_epoch_ms) > 86_400_000 * 366 ? Number(a.start_epoch_ms) : a.created_at) };
}

const PROVIDER_LABEL: Record<string, { name: string; image: string }> = {
  musicbrainz: { name: 'MusicBrainz', image: 'the Cover Art Archive' },
  deezer: { name: 'Deezer', image: 'Deezer' },
  apple: { name: 'Apple', image: 'Apple' },
  page: { name: 'a web page', image: 'that page' },
  typed: { name: 'typed details', image: 'an image chosen by hand' },
};

/**
 * A song's cover in the account's library at media/<artist>/<album>/<song>/cover.jpg.
 * Downloaded once per album per account: another song on the same album copies
 * the stored bytes rather than asking the provider again.
 */
export async function coverKey(acct: string, m: MusicMatch): Promise<string | null> {
  const coverOf = m.releaseGroupMbid ? `musicbrainz:${m.releaseGroupMbid}` : m.coverUrl ? `${m.provider}:${m.coverUrl}` : null;
  if (!coverOf) return null;
  const folder = songFolder(m.artist, m.album, m.title);
  const have = await one<any>(`SELECT store_key, path FROM media_files WHERE account_id = $1 AND metadata->>'coverOf' = $2 ORDER BY (path = $3) DESC, created_at LIMIT 1`,
    [acct, coverOf, `${folder}/cover.jpg`]);
  // One cover per album per account, used by every song on it (no copy per song folder).
  if (have && await imageStore().exists(have.store_key)) return have.store_key;
  let jpg: Buffer | null = null;
  if (!jpg) {
    const c = await fetchCoverFor(m);
    if (!c) return null;
    jpg = c.contentType === 'image/jpeg' ? c.data : await sharp(c.data).jpeg({ quality: 88 }).toBuffer();
  }
  // Kind 'cover': song artwork is its own type in the Image Library (filter: Cover).
  return saveToLibrary(acct, folder, 'cover.jpg', jpg, 'image/jpeg', 'cover',
    { coverOf, provider: m.provider ?? 'musicbrainz', releaseGroupMbid: m.releaseGroupMbid ?? null, album: m.album, artist: m.artist, song: m.title, link: m.link ?? null },
    `${m.artist ?? ''} - ${m.album ?? m.title ?? ''}`.replace(/^ - | - $/g, ''));
}

/** Square or wide, from the stored image's dimensions (square within 20%). */
async function shapeOf(acct: string, key: string, fallback: 'wide' | 'square'): Promise<'wide' | 'square'> {
  const r = await one<any>(`SELECT width, height FROM media_files WHERE account_id = $1 AND store_key = $2`, [acct, key]).catch(() => null);
  return r?.width && r?.height ? (Math.abs(r.width / r.height - 1) < 0.2 ? 'square' : 'wide') : fallback;
}

/** Sources that are Volt's own fills, not a person's choice. */
// Song details from a source (even one a person chose with "Find song details") can be replaced by a
// later choice; only values a person typed or picked in the form are theirs.
export const AUTO_SOURCES = new Set(['musicbrainz', 'deezer', 'apple', 'page', 'typed', 'station', 'auto', 'poster']);

/**
 * Fields of a radio asset's type that its station already answers: name,
 * description, logo (the station artwork), and any other field the station's
 * own metadata has under the same key (genre, language, frequency...). Only
 * empty fields. PURE; tested.
 */
export function stationFills(a: any): Record<string, any> {
  if (a.channel_kind !== 'radio') return {};
  const fields: any[] = Array.isArray(a.schema_fields) ? a.schema_fields : [];
  const cm = a.channel_metadata && typeof a.channel_metadata === 'object' ? a.channel_metadata : {};
  const name = (typeof cm.name === 'string' && cm.name.trim()) || a.channel_name || null;
  const logo = (typeof cm.logo === 'string' && cm.logo.trim()) || a.brand_ref || null;
  const src: Record<string, any> = { ...cm, name, station: name, stationName: name, logo, stationLogo: logo };
  const cur = a.metadata ?? {};
  const empty = (v: unknown) => v == null || (typeof v === 'string' && !v.trim()) || (Array.isArray(v) && !v.length);
  const out: Record<string, any> = {};
  for (const f of fields) {
    const v = src[f.key];
    if (empty(v) || !empty(cur[f.key])) continue;
    if (f.type === 'enum' && f.multiple && !Array.isArray(v)) continue;
    if ((f.type === 'string' || f.type === 'text' || f.type === 'image' || f.type === 'url') && typeof v !== 'string') continue;
    out[f.key] = v;
  }
  return out;
}

/** Score candidate frames (reading each from the store) and return them ranked. */
export async function scoreCandidates(cands: Candidate[], durationMs?: number | null): Promise<Candidate[]> {
  const out: Candidate[] = [];
  for (const c of cands) {
    try {
      const buf = await imageStore().get(c.key);
      if (!buf) { out.push({ ...c, score: 0, rejected: 'missing' }); continue; }
      const st = await frameStats(buf);
      const sc = scoreFrame(st, c.atMs != null && durationMs ? c.atMs / durationMs : null);
      out.push({ ...c, score: sc.score, notes: sc.notes, ...(sc.rejected ? { rejected: sc.rejected } : {}) });
    } catch { out.push({ ...c, score: 0, rejected: 'unreadable' }); }
  }
  return out.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
}

/** The live stream's stills over the asset's span, at most 24, evenly spread. */
async function liveCandidates(a: any): Promise<Candidate[]> {
  const stream = a.channel_id ?? a.event_id;
  if (!stream || !a.start_epoch_ms || !a.end_epoch_ms) return [];
  const rows = await query<any>(
    `SELECT store_key, captured_at FROM media_files
      WHERE channel_id = $1 AND source = 'encoder' AND kind = 'keyframe'
        AND captured_at BETWEEN to_timestamp($2 / 1000.0) AND to_timestamp($3 / 1000.0)
      ORDER BY captured_at`, [stream, Number(a.start_epoch_ms), Number(a.end_epoch_ms)]);
  const step = Math.max(1, Math.ceil(rows.length / 24));
  return rows.filter((_, i) => i % step === 0).map((r) => ({
    key: r.store_key, origin: 'live' as const, atMs: new Date(r.captured_at).getTime() - Number(a.start_epoch_ms),
  }));
}

/**
 * Frames from a video file: `n` stills spread over it (5% to 95%), written to
 * derived/<account>/asset-frames/<asset>/ and recorded as the asset's
 * candidates. Called by the encode job while the source file is on disk.
 */
export async function extractFrames(assetId: string, acct: string, input: string, durationMs: number | null, n = 12): Promise<Candidate[]> {
  const dur = durationMs && durationMs > 0 ? durationMs : null;
  const at = dur ? Array.from({ length: n }, (_, i) => Math.round(dur * (0.05 + 0.9 * i / (n - 1)))) : [0, 1000, 3000, 10_000];
  const dir = await mkdtemp(join(tmpdir(), 'volt-frames-'));
  const out: Candidate[] = [];
  try {
    for (const [i, ms] of at.entries()) {
      const file = join(dir, `f${i}.jpg`);
      try {
        await run('ffmpeg', ['-loglevel', 'error', '-y', '-ss', (ms / 1000).toFixed(3), '-i', input, '-frames:v', '1', '-vf', 'scale=1280:-2', '-q:v', '3', file], { timeout: 30_000 });
        const buf = await readFile(file);
        const key = `derived/${acct}/asset-frames/${assetId}/${String(i).padStart(2, '0')}.jpg`;
        await imageStore().put(key, buf, 'image/jpeg');
        out.push({ key, atMs: ms, origin: 'ingest' });
      } catch { /* past the end, or a bad seek: fewer candidates */ }
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
  const scored = await scoreCandidates(out, dur);
  await query(`UPDATE vod_assets SET poster_candidates = $2::jsonb WHERE id = $1`, [assetId, JSON.stringify(scored)]);
  return scored;
}

async function fromRef(acct: string, ref: string | null | undefined, folder: string, name?: string): Promise<string | null> {
  const r = String(ref ?? '').trim();
  if (!r) return null;
  const k = libraryKey(r, acct);
  if (k) return k;
  if (/^https?:\/\//i.test(r)) { try { return await importImageUrl(acct, r, folder, name); } catch { return null; } }
  return null;
}

/**
 * An uploaded file without frames or sprite sheets (uploaded before they
 * existed, or `force` to redo them): build both from the source file, if it is
 * still where the upload left it. True when it did.
 */
export async function prepareFileFrames(assetId: string, opts: { force?: boolean } = {}): Promise<boolean> {
  const a = await one<any>(`SELECT v.id, v.source_kind, v.source_key, v.duration_ms, v.sprite, v.poster_candidates, v.account_id FROM vod_assets v WHERE v.id = $1`, [assetId]);
  if (!a || !['upload', 'watchfolder'].includes(a.source_kind) || !a.account_id || !a.source_key) return false;
  if (!opts.force && a.sprite && Array.isArray(a.poster_candidates) && a.poster_candidates.length) return false;
  const { existsSync } = await import('node:fs');
  if (!existsSync(a.source_key)) return false;
  const dur = a.duration_ms ? Number(a.duration_ms) : null;
  if (opts.force || !(Array.isArray(a.poster_candidates) && a.poster_candidates.length)) await extractFrames(a.id, a.account_id, a.source_key, dur);
  if (opts.force || !a.sprite) await (await import('../thumbnails/fileSprites')).buildFileSprites(a.id, a.account_id, a.source_key, dur);
  return true;
}

/** Decide, without writing. Network for songs and imported icons; reads frames from the store. */
/** Song details an asset already has: no lookup needed for them. */
const hasSongDetails = (m: any) => ['artist', 'album'].every((k) => typeof m?.[k] === 'string' && m[k].trim());

/**
 * When an asset may ask the music providers (docs/ASSET_IMAGES.md section 5):
 * once, when it is created; again only when a person asks (userCheck). A
 * lookup that could not run (provider busy or down) is tried up to three times.
 */
export function mayLookUp(a: any, opts: { lookup?: boolean; userCheck?: boolean }): boolean {
  if (opts.lookup === false) return false;
  if (opts.userCheck) return true;
  const ml = a.music_lookup ?? {};
  if (!ml.at) return true;
  return ml.state === 'error' && (Number(ml.attempts) || 1) < 3;
}

export async function decide(a: any, opts: { lookup?: boolean; retryErrors?: boolean; userCheck?: boolean; trace?: { lookedUp: boolean }; prefer?: string } = {}): Promise<PickResult> {
  const acct: string = a.acct;
  const audio = isAudioAsset(a);
  let music: MusicMatch | null = null;
  const st = stationFills(a);
  let filled: Record<string, any> | undefined = Object.keys(st).length ? st : undefined;
  const m0 = a.metadata ?? {};
  const prov = a.metadata_provenance ?? {};

  // 2. An image a PERSON put in the asset's metadata (not one Volt filled).
  let personPick: PickResult | null = null;
  // `prefer`: the image field a person just changed goes first, so changing the
  // Thumbnail while an older Image is set still changes the asset's image.
  const order = ['image', 'thumbnail', 'artwork', 'poster', 'cover'];
  if (opts.prefer && !order.includes(opts.prefer)) order.unshift(opts.prefer);
  else if (opts.prefer) order.sort((x, y) => (x === opts.prefer ? -1 : y === opts.prefer ? 1 : 0));
  for (const k of order) {
    const v = m0[k];
    if (typeof v !== 'string' || !v.trim() || AUTO_SOURCES.has(prov[k]?.source)) continue;
    const key = await fromRef(acct, v, assetFolder(placeOf(a)), k);
    if (key) { personPick = { source: 'metadata', key, shape: await shapeOf(acct, key, audio ? 'square' : 'wide'), reason: `The ${k} set in the asset's metadata.` }; break; }
  }
  // An image AND the song's details already there: nothing to look up.
  if (personPick && !(audio && isSongAsset(a) && !hasSongDetails(m0))) {
    const skip: MusicMatch | null = audio && isSongAsset(a) && !a.music_lookup?.at ? { state: 'miss', reason: 'Not looked up: it already had an image and song details.' } : null;
    return { ...personPick, filled, music: skip };
  }
  const lookUp = mayLookUp(a, opts);
  let newSchema: string | undefined;

  if (audio && isSongAsset(a) && opts.lookup !== false) {
    const who = songIdentity({ title: a.title, metadata: a.metadata, ingest: a.ingest, override: a.music_lookup?.query });
    if (who) {
      // Details a person chose for this song ("Find song details") come before any lookup.
      const chosen = await getSongDetails(acct, who.artist, who.title);
      let key: string | null = null;
      if (chosen) {
        music = detailsToMatch(chosen);
        key = chosen.imageKey && (await one<any>(`SELECT 1 FROM media_files WHERE account_id = $1 AND store_key = $2`, [acct, chosen.imageKey])) ? chosen.imageKey : null;
      } else {
        music = await songMatch(who.artist, who.title, a.duration_ms ? Number(a.duration_ms) : null, { retryErrors: opts.retryErrors, cacheOnly: !lookUp });
        if (opts.trace) opts.trace.lookedUp = lookUp;
        if (music.state === 'hit') key = await coverKey(acct, music).catch(() => null);
      }
      if (music.state === 'hit') {
        // A song found for an asset with no content type makes it a Song (another type is left
        // as it is: changing it is a person's call, in Find song details).
        const target = a.schema_key === 'song' ? { id: a.schema_id, fields: a.schema_fields ?? [] } : !a.schema_id ? await songType(acct) : null;
        if (target && !a.schema_id) newSchema = target.id;
        if (target) {
          const sf = fillsFor(music, a.metadata ?? {}, target.fields.map((f: any) => ({ key: f.key, type: f.type, options: f.options, multiple: f.multiple })));
          const art = target.fields.find((f: any) => f.key === 'artwork');
          if (key && art && !(typeof m0.artwork === 'string' && m0.artwork.trim())) sf.artwork = `/${key}`;
          filled = { ...(filled ?? {}), ...sf };
        }
        // The person's own image stays; the lookup was only for the missing details.
        if (personPick) return { ...personPick, music, filled, schemaId: newSchema };
        if (key) {
          const year = /^(\d{4})/.exec(music.released ?? '')?.[1];
          const pl = PROVIDER_LABEL[music.provider ?? 'musicbrainz'] ?? { name: music.provider ?? 'the provider', image: music.provider ?? 'the provider' };
          if (chosen) return { source: 'cover_art', key, shape: await shapeOf(acct, key, 'square'), music, filled, schemaId: newSchema,
            reason: `Album cover: ${music.album ?? 'unknown album'}${year ? ` (${year})` : ''}, ${music.artist}. Chosen by ${chosen.chosenBy ?? 'someone'} from ${pl.name}${chosen.link ? ` (${chosen.link})` : ''}.` };
          return { source: 'cover_art', key, shape: 'square', music, filled, schemaId: newSchema,
            reason: `Album cover: ${music.album ?? 'unknown album'}${year ? ` (${year})` : ''}, ${music.artist}. ${pl.name} match ${music.confidence}/100, image from ${pl.image}.` };
        }
      }
    }
  }

  if (personPick) return { ...personPick, music, filled, schemaId: newSchema };

  if (audio) {
    const pm = a.programme?.metadata ?? {};
    const pk = await fromRef(acct, pm.image ?? pm.icon ?? pm.poster, programmeFolder(a.channel_name, a.programme?.title, a.programme?.starts_at), 'image');
    if (pk) return { source: 'programme', key: pk, shape: 'square', music, filled, schemaId: newSchema, reason: `The image of the guide programme "${a.programme.title}".` };
    const feed = a.channel_id ? (await feedIconsFor([a.channel_id])).get(a.channel_id) : null;
    const pick = pickGuideIcon({ guideIconRef: null, brandRef: a.brand_ref, feedIcon: null, metadataIcon: null })
      ?? pickGuideIcon({ guideIconRef: a.guide_icon_ref, brandRef: null, feedIcon: feed, metadataIcon: a.channel_metadata?.logo ?? null });
    const sk = pick ? await fromRef(acct, pick.ref, stationFolder(a.channel_name), 'logo') : null;
    const what = music?.state === 'hit' ? 'The song matched but the album has no cover, so the'
      : music?.state === 'miss' ? 'No confident match for the song, so the'
      : music?.state === 'error' ? 'The song lookup could not run just now (it is tried again later), so the' : 'The';
    if (sk) return { source: 'station', key: sk, shape: 'square', music, filled, schemaId: newSchema, reason: `${what} station ${pick!.from === 'brand' ? 'artwork' : pick!.from === 'guide' ? 'guide icon' : pick!.from === 'feed' ? 'icon from its guide feed' : 'logo'} of ${a.channel_name ?? 'the station'}.` };
    const ak = await fromRef(acct, a.account_logo, 'media/account', 'logo');
    if (ak) return { source: 'station', key: ak, shape: 'square', music, filled, schemaId: newSchema, reason: `${what} account logo: the station has no artwork.` };
    return { source: 'none', key: null, shape: null, music, filled, schemaId: newSchema, reason: 'No station artwork, guide icon or account logo to use. Set the station artwork in Radio.' };
  }

  // Video: frames we already scored at upload, else the live stream's stills.
  let cands: Candidate[] = Array.isArray(a.poster_candidates) ? a.poster_candidates : [];
  if (!cands.length) cands = await scoreCandidates(await liveCandidates(a), a.duration_ms ? Number(a.duration_ms) : null);
  else if (cands.some((c) => c.score == null)) cands = await scoreCandidates(cands, a.duration_ms ? Number(a.duration_ms) : null);
  const p = pickFrame(cands);
  if (p.best) {
    const buf = await imageStore().get(p.best.key);
    if (buf) {
      const key = await saveToLibrary(acct, assetFolder(placeOf(a)), framePosterName(buf, a.title), buf, 'image/jpeg', 'poster',
        { assetId: a.id, frameAtMs: p.best.atMs ?? null, score: p.best.score, from: p.best.origin }, a.title ?? undefined);
      return { source: p.best.origin === 'live' ? 'live_frame' : 'frame', key, shape: 'wide', reason: p.reason, ...({ candidates: p.ranked } as any) };
    }
  }
  if (a.poster_key) return { source: 'live_frame', key: a.poster_key, shape: 'wide', reason: 'The still nearest the start, taken when the clip was cut.' };
  return { source: 'none', key: null, shape: null, reason: p.reason };
}

/**
 * Pick and store the asset's image. A locked (manual) image is kept unless
 * `force`. Song fields found on the way are filled even when the image is locked.
 */
export async function pickAssetImage(assetId: string, opts: { force?: boolean; lookup?: boolean; userCheck?: boolean; by?: string; prefer?: string } = {}): Promise<PickResult & { locked?: boolean }> {
  const a = await load(assetId);
  if (!a) throw new Error('no such asset');
  if (a.poster_locked && !opts.force) {
    return { source: 'manual', key: a.poster_key, shape: a.poster_shape, reason: a.poster_reason ?? 'Chosen by hand.', locked: true, skipped: 'locked' };
  }
  // A person asking again (force) also retries a lookup that failed; the sweep waits six hours.
  const trace = { lookedUp: false };
  const r = await decide(a, { ...opts, retryErrors: !!opts.force, trace });
  r.lookedUp = trace.lookedUp;
  const prevMl = a.music_lookup ?? {};
  const cands = (r as any).candidates as Candidate[] | undefined;
  const provenance: Record<string, any> = {};
  if (r.filled && Object.keys(r.filled).length) {
    const fromStation = stationFills(a);
    for (const k of Object.keys(r.filled)) {
      provenance[k] = k in fromStation && r.filled[k] === fromStation[k]
        ? { source: 'station', channelId: a.channel_id, at: new Date().toISOString(), by: opts.by ?? 'auto' }
        : { source: r.music?.provider ?? 'musicbrainz', recordingMbid: r.music?.recordingMbid ?? null, link: r.music?.link ?? null, at: new Date().toISOString(), by: opts.by ?? 'auto' };
    }
  }
  await query(
    `UPDATE vod_assets SET
        poster_key = COALESCE($2::text, poster_key),
        poster_source = $3, poster_shape = $4, poster_reason = $5, poster_picked_at = now(), poster_locked = false,
        poster_candidates = COALESCE($6::jsonb, poster_candidates),
        music_lookup = COALESCE($7::jsonb, music_lookup),
        metadata = COALESCE(metadata, '{}'::jsonb) || $8::jsonb,
        schema_id = COALESCE(schema_id, $10::uuid),
        metadata_provenance = COALESCE(metadata_provenance, '{}'::jsonb) || $9::jsonb,
        updated_at = now()
      WHERE id = $1`,
    [assetId, r.key, r.source, r.shape, r.reason, cands ? JSON.stringify(cands) : null,
     r.music ? JSON.stringify({ ...r.music, ...(prevMl.query ? { query: prevMl.query } : {}), filled: Object.keys(r.filled ?? {}),
       // at: when it was looked up (the creation lookup, or a person's check); attempts: lookups that ran
       at: trace.lookedUp || !prevMl.at ? new Date().toISOString() : prevMl.at,
       attempts: (Number(prevMl.attempts) || 0) + (trace.lookedUp ? 1 : 0) }) : null,
     JSON.stringify(r.filled ?? {}), JSON.stringify(provenance), r.schemaId ?? null]);
  await syncImageField(assetId).catch((e) => console.warn(`[asset-image] ${assetId}: image field not filled:`, e?.message ?? e));
  return r;
}

/**
 * THE METADATA SHOWS THE ASSET'S IMAGE. The content type's main image field
 * (Image, Thumbnail on video, Cover on audio, Artwork) is filled with the
 * asset's current image when it is empty, and kept in step while it still
 * holds a value put there this way (provenance source 'poster'). A value a
 * person or an import set is left alone: that one decides the image instead
 * (decide(), step 2). Called whenever the image is picked or chosen.
 * Returns the field written, or null.
 */
const MAIN_IMAGE_FIELDS = ['image', 'artwork', 'picture', 'photo'];
export async function syncImageField(assetId: string): Promise<string | null> {
  const a = await load(assetId);
  if (!a || !Array.isArray(a.schema_fields)) return null;
  const primary = isAudioAsset(a) ? 'cover' : 'thumbnail';
  const field = (a.schema_fields as any[]).find((f) => f?.type === 'image' && (MAIN_IMAGE_FIELDS.includes(String(f.key)) || f.key === primary));
  if (!field) return null;
  const k = String(field.key);
  const cur = typeof a.metadata?.[k] === 'string' ? a.metadata[k].trim() : '';
  const ours = a.metadata_provenance?.[k]?.source === 'poster';
  if (cur && !ours) return null;
  const want = a.poster_key ? `/${a.poster_key}` : '';
  if (cur === want) return null;
  if (!want) {
    await query(`UPDATE vod_assets SET metadata = COALESCE(metadata, '{}'::jsonb) - $2::text, metadata_provenance = COALESCE(metadata_provenance, '{}'::jsonb) - $2::text WHERE id = $1`, [assetId, k]);
    return k;
  }
  await query(`UPDATE vod_assets SET metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object($2::text, $3::text),
                 metadata_provenance = COALESCE(metadata_provenance, '{}'::jsonb) || jsonb_build_object($2::text, jsonb_build_object('source', 'poster', 'at', now())) WHERE id = $1`,
    [assetId, k, want]);
  return k;
}

/** A person's choice: a candidate frame, or any image from the library. Locks it. */
export async function setAssetImage(assetId: string, acct: string, ref: string, by: string): Promise<PickResult> {
  const a = await load(assetId);
  if (!a || a.acct !== acct) throw new Error('no such asset');
  let key = libraryKey(ref, acct);
  const cand = (a.poster_candidates ?? []).find((c: Candidate) => c.key === ref.replace(/^\//, ''));
  if (!key && cand) {
    const buf = await imageStore().get(cand.key);
    if (!buf) throw new Error('that frame is no longer stored');
    key = await saveToLibrary(acct, assetFolder(placeOf(a)), framePosterName(buf, a.title), buf, 'image/jpeg', 'poster', { assetId: a.id, frameAtMs: cand.atMs ?? null, chosenBy: by }, a.title ?? undefined);
  }
  if (!key) throw new Error('choose an image from this account\'s Image Library or one of the frames');
  const at = cand?.atMs != null ? ` at ${clock(cand.atMs)}` : '';
  const meta = cand ? null : await one<any>(`SELECT width, height FROM media_files WHERE account_id = $1 AND store_key = $2`, [acct, key]);
  const shape = cand ? 'wide' : meta?.width && meta?.height && Math.abs(meta.width / meta.height - 1) < 0.2 ? 'square' : 'wide';
  const reason = cand ? `Frame${at}, chosen by ${by}.` : `Chosen from the Image Library by ${by}.`;
  await query(`UPDATE vod_assets SET poster_key = $2, poster_source = 'manual', poster_shape = $3, poster_reason = $4, poster_locked = true, poster_picked_at = now(), updated_at = now() WHERE id = $1`,
    [assetId, key, shape, reason]);
  await syncImageField(assetId).catch((e) => console.warn(`[asset-image] ${assetId}: image field not filled:`, e?.message ?? e));
  return { source: 'manual', key, shape, reason };
}
