// ============================================================================
//  The image that represents an asset (services/media/assetImage.ts).
//
//    GET  /api/vod/:id/image            the image, where it came from, why, the
//                                       frames considered (scored, signed URLs)
//                                       and the last song lookup
//    PUT  /api/vod/:id/image  { ref }   choose: a candidate frame's key or an
//                                       Image Library ref. Locks it.
//    POST /api/vod/:id/image/auto       pick automatically again (unlocks);
//                                       { lookup: false } skips the song lookup
//
//    POST /api/vod/music-lookup { artist, title, durationMs?, providers? }
//                                       ask each provider for a song, fresh (no
//                                       cache), and show what each found: to test
//                                       the lookup, or before correcting an asset
//
//    POST /api/vod/:id/song/find { artist?, title?, url?, providers? }
//                                       a person asks: every source at once,
//                                       plus a page or image link they pasted
//    POST /api/vod/:id/song/use { ...details, imageUrl | imageRef }
//                                       use one: cover into the library, the
//                                       song's fields, remembered for the song
//    DELETE /api/vod/:id/song/details   forget the remembered details
//
//  Feature `vod`: reading needs view, choosing and lookups need manage (auth/roles.ts).
// ============================================================================
import { Router } from 'express';
import { z } from 'zod';
import { one, query } from '../db';
import { requireAuth, accountId } from '../auth/middleware';
import { asyncHandler, notFound, badRequest } from '../util/http';
import { actorLabel } from '../util/actor';
import { writeAudit, actor } from '../services/audit';
import { signedImageUrl } from './images';
import { pickAssetImage, setAssetImage, isAudioAsset, isSongAsset, prepareFileFrames } from '../services/media/assetImage';
import { songIdentity } from '../services/media/musicLookup';
import { parseIcyTitle } from '../services/radio/trackMeta';
import { assetImagesRouter } from './assetImages';
import { assetFilesRouter } from './assetFiles';

export const vodImageRouter = Router();
vodImageRouter.use(requireAuth);
// An asset's images by type: thumbnail, cover, poster, hero... (modules/assetImages.ts, ASSET_IMAGES.md section 13).
vodImageRouter.use(assetImagesRouter);
// Companion files: captions (subtitle tracks) and metadata sidecars (modules/assetFiles.ts, COMPANION_FILES.md).
vodImageRouter.use(assetFilesRouter);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function owned(id: string, acct: string) {
  if (!UUID.test(id)) return null;
  return one<any>(`
    SELECT v.*, c.kind AS channel_kind, s.standard_key AS schema_key
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

async function view(id: string, acct: string) {
  const a = await owned(id, acct);
  if (!a) throw notFound('VOD asset not found');
  const shape = a.poster_shape ?? 'wide';
  return {
    key: a.poster_key ?? null,
    // v= the moment it was picked: a new choice is a new URL even when the library file kept its path.
    url: sign(a.poster_key, `${shape === 'square' ? '600x600,contain' : '960x540,cover'}${a.poster_picked_at ? `,v=${new Date(a.poster_picked_at).getTime()}` : ''}`),
    source: a.poster_source ?? null,
    shape: a.poster_source ? shape : null,
    reason: a.poster_reason ?? (a.poster_source ? null : 'Not picked yet: it will be shortly.'),
    locked: !!a.poster_locked,
    pickedAt: a.poster_picked_at ?? null,
    audio: isAudioAsset(a),
    song: isSongAsset(a),
    songIdentity: isAudioAsset(a) ? songIdentity({ title: a.title, metadata: a.metadata, ingest: a.ingest }) : null,
    upload: ['upload', 'watchfolder'].includes(a.source_kind),
    sprite: a.sprite ? { sheets: a.sprite.sheets?.length ?? 0, intervalMs: a.sprite.intervalMs, tiles: (a.sprite.sheets ?? []).reduce((n: number, s: any) => n + (s.tiles ?? 0), 0) } : null,
    candidates: (Array.isArray(a.poster_candidates) ? a.poster_candidates : []).slice(0, 24).map((c: any) => ({
      key: c.key, atMs: c.atMs ?? null, origin: c.origin, score: c.score ?? null, notes: c.notes ?? [], rejected: c.rejected ?? null,
      url: sign(c.key, '320x180,cover'),
    })),
    music: a.music_lookup ?? null,
    folder: await (await import('../services/media/assetImage')).assetPlaceFolder(a.id),
    providersEnabled: (await import('../services/media/musicLookup')).enabledProviders(),
  };
}

const lookupSchema = z.object({
  artist: z.string().trim().min(1).max(200), title: z.string().trim().min(1).max(300),
  durationMs: z.number().int().positive().max(24 * 3600_000).optional(),
  providers: z.array(z.enum(['musicbrainz', 'deezer', 'apple'])).min(1).max(3).optional(),
});
vodImageRouter.post('/music-lookup', asyncHandler(async (req, res) => {
  const b = lookupSchema.parse(req.body ?? {});
  const { lookupSong, enabledProviders, coverUrl, queryVariants, PROVIDER_TERMS } = await import('../services/media/musicLookup');
  const { gateUsage } = await import('../services/rateGate');
  const enabled = enabledProviders();
  const providers = b.providers ?? enabled;
  // Each provider on its own (not the chain), so the answer shows what every one would give.
  const results = [];
  for (const p of providers) {
    const t0 = Date.now();
    const m = await lookupSong({ artist: b.artist, title: b.title, durationMs: b.durationMs ?? null }, [p]);
    results.push({
      provider: p, enabledForAssets: enabled.includes(p), ms: Date.now() - t0,
      state: m.state, reason: m.reason ?? null, confidence: m.confidence ?? null,
      artist: m.artist ?? null, title: m.title ?? null, album: m.album ?? null, released: m.released ?? null,
      isrc: m.isrc ?? null, label: m.label ?? null, genres: m.genres ?? [], lengthMs: m.lengthMs ?? null, link: m.link ?? null,
      coverUrl: m.state === 'hit' ? (m.coverUrl ?? (m.releaseGroupMbid ? coverUrl(m.releaseGroupMbid, 500) : null)) : null,
      terms: PROVIDER_TERMS[p] ?? null,
    });
  }
  res.json({
    query: { artist: b.artist, title: b.title, durationMs: b.durationMs ?? null, variants: queryVariants(b).map((v) => `${v.variant}: ${v.artist} – ${v.title}`) },
    providersEnabled: enabled,
    usage: { musicbrainz: await gateUsage('musicbrainz'), deezer: await gateUsage('deezer'), apple: await gateUsage('apple') },
    results,
  });
}));

vodImageRouter.get('/:id/image', asyncHandler(async (req, res) => {
  res.json(await view(String(req.params.id), accountId(req)));
}));

vodImageRouter.put('/:id/image', asyncHandler(async (req, res) => {
  const acct = accountId(req);
  const b = z.object({ ref: z.string().min(1).max(600) }).parse(req.body ?? {});
  const a = await owned(String(req.params.id), acct);
  if (!a) throw notFound('VOD asset not found');
  try { await setAssetImage(a.id, acct, b.ref, (await actorLabel(req)) ?? 'someone'); }
  catch (e: any) { throw badRequest(String(e?.message ?? e)); }
  const { userId, label } = actor(req);
  await writeAudit(null, { accountId: acct, userId, label, action: 'update', entityType: 'vod_asset', entityId: a.id, changes: { poster: { from: a.poster_key, to: b.ref } } });
  res.json(await view(a.id, acct));
}));

/**
 * Pick again. Waits up to 25 s for the answer (a song lookup takes a few
 * seconds through MusicBrainz's one-a-second gate); past that it carries on in
 * the background and answers 202, and the console polls GET.
 */
vodImageRouter.post('/:id/image/auto', asyncHandler(async (req, res) => {
  const acct = accountId(req);
  const a = await owned(String(req.params.id), acct);
  if (!a) throw notFound('VOD asset not found');
  const lookup = req.body?.lookup !== false;
  const by = (await actorLabel(req)) ?? undefined;
  // "Look up as": a person corrects who the song is; kept on the asset for later picks.
  const ov = z.object({ artist: z.string().trim().min(1).max(200), title: z.string().trim().min(1).max(300) }).safeParse(req.body ?? {});
  if (ov.success) await query(`UPDATE vod_assets SET music_lookup = COALESCE(music_lookup, '{}'::jsonb) || jsonb_build_object('query', $2::jsonb) WHERE id = $1`, [a.id, JSON.stringify(ov.data)]);
  // rebuild: an uploaded file's frames and sprite sheets made again from its source.
  // Pick again uses what is known; only "Look up as" asks the providers again (a person's check).
  const work = (req.body?.rebuild === true ? prepareFileFrames(a.id, { force: true }) : Promise.resolve(false)).then(() => pickAssetImage(a.id, { force: true, lookup, userCheck: ov.success, by }));
  const timeout = new Promise<'late'>((r) => setTimeout(() => r('late'), 25_000));
  const done = await Promise.race([work.then(() => 'done' as const), timeout]).catch((e) => { throw badRequest(String(e?.message ?? e)); });
  if (done === 'late') { work.catch((e) => console.error(`[vod.image] ${a.id}:`, e)); return res.status(202).json({ ...(await view(a.id, acct)), pending: true }); }
  res.json(await view(a.id, acct));
}));

// ---------------------------------------------------------------- Find song details

/** How the station (or the file) names the song: the key later plays are looked up by. */
function sentAs(a: any): { artist: string; title: string } | null {
  const m = a.metadata ?? {};
  if (m.source === 'icy' && typeof m.raw === 'string') { const p = parseIcyTitle(m.raw); if (p) return p; }
  const id3 = a.ingest?.id3 ?? {};
  if ((id3.artist ?? id3.TPE1) && (id3.title ?? id3.TIT2)) return { artist: String(id3.artist ?? id3.TPE1), title: String(id3.title ?? id3.TIT2) };
  return songIdentity({ title: a.title, metadata: a.metadata, ingest: a.ingest });
}

/** Where to look by hand, in the person's own browser (sites that do not answer programs, or have no API). */
export function searchLinks(artist: string, title: string) {
  const q = encodeURIComponent(`${artist} ${title}`);
  return [
    { site: 'Bandcamp', url: `https://bandcamp.com/search?q=${q}&item_type=t` },
    { site: 'Apple Music', url: `https://music.apple.com/search?term=${q}` },
    { site: 'Spotify', url: `https://open.spotify.com/search/${q}` },
    { site: 'YouTube Music', url: `https://music.youtube.com/search?q=${q}` },
    { site: 'Beatport', url: `https://www.beatport.com/search?q=${q}` },
    { site: 'Google Images', url: `https://www.google.com/search?tbm=isch&q=${encodeURIComponent(`${artist} ${title} cover`)}` },
  ];
}

const findSchema = z.object({
  artist: z.string().trim().min(1).max(200).optional(), title: z.string().trim().min(1).max(300).optional(),
  url: z.string().trim().url().max(2000).optional().or(z.literal('')),
  providers: z.array(z.enum(['musicbrainz', 'deezer', 'apple'])).max(3).optional(),
});

/**
 * A person presses "Find song details": every source at once (each on its own
 * rate gate), plus the page or image they pasted. Nothing is stored until
 * they choose one. Waits for all of them (MusicBrainz takes several seconds).
 */
vodImageRouter.post('/:id/song/find', asyncHandler(async (req, res) => {
  const acct = accountId(req);
  const a = await owned(String(req.params.id), acct);
  if (!a) throw notFound('VOD asset not found');
  const b = findSchema.parse(req.body ?? {});
  const ml = await import('../services/media/musicLookup');
  // Typed or pasted with the station's raw block in it ("StreamTitle='…';StreamUrl='…'"): just the song.
  if (b.artist && b.title && /Stream(Title|Url)\s*=/i.test(`${b.artist} ${b.title}`)) {
    const p = parseIcyTitle(`${b.artist} – ${b.title}`);
    if (p) { b.artist = p.artist; b.title = p.title; }
  }
  const who = b.artist && b.title ? { artist: b.artist, title: b.title }
    : ml.songIdentity({ title: a.title, metadata: a.metadata, ingest: a.ingest, override: a.music_lookup?.query });
  if (!who && !b.url) throw badRequest('Say who the song is (artist and title), or paste a link.');
  const providers = b.providers ?? ml.ALL_PROVIDERS();
  const durationMs = a.duration_ms ? Number(a.duration_ms) : null;
  const shape = (p: string, m: any, ms: number) => ({
    provider: p, state: m.state, reason: m.reason ?? null, confidence: m.confidence ?? null, ms,
    artist: m.artist ?? null, title: m.title ?? null, album: m.album ?? null, released: m.released ?? null, isrc: m.isrc ?? null,
    label: m.label ?? null, genres: m.genres ?? [], lengthMs: m.lengthMs ?? null, link: m.link ?? null,
    coverUrl: m.state === 'hit' ? (m.coverUrl ?? (m.releaseGroupMbid ? ml.coverUrl(m.releaseGroupMbid, 500) : null)) : null,
    terms: ml.PROVIDER_TERMS[p] ?? null,
  });
  const jobs: Promise<any>[] = who ? providers.map(async (p) => {
    const t0 = Date.now();
    const m = await ml.lookupSong({ artist: who.artist, title: who.title, durationMs }, [p]).catch((e: any) => ({ state: 'error', reason: String(e?.message ?? e) }));
    return shape(p, m, Date.now() - t0);
  }) : [];
  if (b.url) jobs.push((async () => {
    const t0 = Date.now();
    const { readSongPage, pageToMatch, PageBlocked, saysNothing } = await import('../services/media/pageMeta');
    try {
      const pg = await readSongPage(b.url!);
      if (saysNothing(pg)) return { ...shape('page', { state: 'miss', reason: `That page (${pg.site}) does not describe a song. Paste the link to the song's own page, or to its cover image.` }, Date.now() - t0), site: pg.site };
      const m = pageToMatch(pg);
      // A pasted image, or a page that does not name the song: the details are the ones asked for, to edit.
      if (!m.artist && who) m.artist = who.artist;
      if (!m.title && who) m.title = who.title;
      return { ...shape('page', m, Date.now() - t0), site: pg.site, imageOnly: pg.imageOnly, from: pg.from, reason: pg.imageOnly ? `An image from ${pg.site}` : `From ${pg.site}` };
    } catch (e: any) {
      return { ...shape('page', { state: e instanceof PageBlocked ? 'blocked' : 'error', reason: String(e?.message ?? e).slice(0, 300) }, Date.now() - t0), site: (() => { try { return new URL(b.url!).hostname; } catch { return null; } })() };
    }
  })());
  const results = await Promise.all(jobs);
  const asked = sentAs(a);
  // Each find as this asset's fields would hold it (dates, genre options), to compare with what it has.
  // Proposed as Song fields: a found song is a Song. The asset's own type when it already is one.
  const { songType } = await import('../services/media/assetImage');
  const song = await songType(acct);
  const own = a.schema_id ? await one<any>(`SELECT id, name, standard_key, fields FROM metadata_schemas WHERE id = $1`, [a.schema_id]) : null;
  const schemaFields = (own?.standard_key === 'song' ? own.fields : song?.fields) ?? own?.fields ?? [];
  const fdefs = schemaFields.map((f: any) => ({ key: f.key, type: f.type, options: f.options, multiple: f.multiple }));
  for (const r of results) if (r.state === 'hit') r.proposed = ml.fillsFor({ ...r, state: 'hit' }, {}, fdefs);
  const { getSongDetails } = await import('../services/media/songDetails');
  res.json({
    query: who, sentAs: asked,
    // What the asset has now, to show next to each find: a change needs the person's approval.
    // The content type: Song is proposed when it is not one already (ticked when it has none).
    contentType: { now: own ? { id: own.id, name: own.name, song: own.standard_key === 'song' } : null, song: song ? { id: song.id } : null },
    current: { metadata: a.metadata ?? {}, provenance: a.metadata_provenance ?? {}, imageUrl: sign(a.poster_key, '300x300,inside'), imageSource: a.poster_source ?? null,
      fields: schemaFields.map((f: any) => ({ key: f.key, label: f.label ?? f.key, type: f.type, options: f.options ?? null, multiple: !!f.multiple })) },
    chosen: who ? await getSongDetails(acct, who.artist, who.title) : null,
    results, searchLinks: who ? searchLinks(who.artist, who.title) : [],
  });
}));

const useSchema = z.object({
  provider: z.enum(['musicbrainz', 'deezer', 'apple', 'page', 'typed']),
  artist: z.string().trim().min(1).max(200), title: z.string().trim().min(1).max(300),
  album: z.string().trim().max(300).nullish(), released: z.string().trim().max(40).nullish(), label: z.string().trim().max(200).nullish(),
  isrc: z.string().trim().max(20).nullish(), genres: z.array(z.string().trim().max(60)).max(8).optional(),
  link: z.string().trim().max(2000).nullish(),
  imageUrl: z.string().trim().url().max(2000).nullish(), imageRef: z.string().trim().max(600).nullish(),
  /** The fields the person approved: only these are written. Values already there change only if listed. */
  fields: z.array(z.string().max(60)).max(30).default([]),
  /** The person approved the image as the asset's cover. */
  useImage: z.boolean().default(true),
  /** The person approved making the asset a Song (content type). */
  setSong: z.boolean().default(false),
});

/**
 * Use what was found (or typed), as the person approved it: the fields they
 * ticked are written (an existing value changes only when ticked), the cover
 * goes into the song's library folder and becomes the asset's image if they
 * ticked it, and the details are kept for the song so every later play uses
 * them without a lookup.
 */
/** The content type's image field: an `image` field, else one named like one. */
export function imageFieldOf(fields: { key: string; type?: string }[]): string | null {
  const byType = fields.find((f) => f.type === 'image');
  if (byType) return byType.key;
  const byName = fields.find((f) => ['artwork', 'image', 'cover', 'poster', 'thumbnail'].includes(f.key));
  return byName?.key ?? null;
}

vodImageRouter.post('/:id/song/use', asyncHandler(async (req, res) => {
  const acct = accountId(req);
  const a = await owned(String(req.params.id), acct);
  if (!a) throw notFound('VOD asset not found');
  const b = useSchema.parse(req.body ?? {});
  const by = (await actorLabel(req)) ?? 'someone';
  const { songFolder } = await import('../services/media/libraryPaths');
  const { importImageUrl, LIBRARY_REF } = await import('../services/media/libraryImages');
  const { saveSongDetails } = await import('../services/media/songDetails');
  const { fillsFor, PROVIDER_TERMS, songIdentity: ident } = await import('../services/media/musicLookup');

  let imageKey: string | null = null;
  if (!b.useImage) imageKey = a.poster_source === 'cover_art' || a.poster_source === 'metadata' ? a.poster_key ?? null : null;
  else if (b.imageRef) {
    const m = LIBRARY_REF.exec(b.imageRef);
    if (!m || m[1].toLowerCase() !== acct.toLowerCase()) throw badRequest('That image is not in this account\'s library.');
    imageKey = b.imageRef.replace(/^\//, '');
  } else if (b.imageUrl) {
    try { imageKey = await importImageUrl(acct, b.imageUrl, songFolder(b.artist, b.album ?? null, b.title), 'cover', 'cover'); }
    catch (e: any) { throw badRequest(`The cover could not be copied: ${String(e?.message ?? e).slice(0, 160)}`); }
    if (!imageKey) throw badRequest('That address did not return an image (JPEG, PNG, WebP or GIF, up to 8 MB).');
  }

  const details = { artist: b.artist, title: b.title, album: b.album || null, released: b.released || null, label: b.label || null,
    isrc: b.isrc || null, genres: b.genres ?? [], imageKey, provider: b.provider, link: b.link || null, terms: PROVIDER_TERMS[b.provider] ?? null, chosenBy: by };
  // Kept under the name the station sends AND the corrected one, so the next play and this asset both find it.
  const keys = [sentAs(a), ident({ title: a.title, metadata: a.metadata, ingest: a.ingest, override: a.music_lookup?.query }), { artist: b.artist, title: b.title }]
    .filter(Boolean) as { artist: string; title: string }[];
  const seen = new Set<string>();
  for (const k of keys) { const s = `${k.artist}|${k.title}`.toLowerCase(); if (seen.has(s)) continue; seen.add(s); await saveSongDetails(acct, k, details); }

  // The content type, if approved: Song (the metadata already there is kept).
  const { songType } = await import('../services/media/assetImage');
  let schemaId: string | null = a.schema_id ?? null;
  if (b.setSong) {
    const song = await songType(acct);
    if (song && song.id !== schemaId) {
      await query(`UPDATE vod_assets SET schema_id = $2, updated_at = now() WHERE id = $1`, [a.id, song.id]);
      schemaId = song.id;
    }
  }
  // The song's fields: exactly the ones approved, PLUS the image field.
  //
  // THE IMAGE FIELD FOLLOWS THE IMAGE. The cover is copied into the Image
  // Library first (importImageUrl above), and only then is the field set, to
  // the LIBRARY reference (/<key>), never the outside address, which can move
  // or vanish. It used to be set only when the browser had listed 'artwork' in
  // `fields`, and the browser decided that from the content type the asset had
  // BEFORE this call: a clip being made a Song here had no artwork field yet,
  // so the cover was saved and the Artwork field stayed empty. Now the server
  // decides from the type the asset has NOW. A chosen cover always fills it; a
  // cover kept from before fills it only when it is empty.
  if (schemaId && (b.fields.length || imageKey)) {
    const fields = (await one<any>(`SELECT fields FROM metadata_schemas WHERE id = $1`, [schemaId]))?.fields ?? [];
    const approved = new Set(b.fields);
    const all = fillsFor({ state: 'hit', ...details, provider: b.provider }, {}, fields.map((f: any) => ({ key: f.key, type: f.type, options: f.options, multiple: f.multiple })));
    const imgField = imageFieldOf(fields);
    if (imageKey && imgField && (b.useImage || !a.metadata?.[imgField])) {
      all[imgField] = `/${imageKey}`;
      approved.add(imgField);
    }
    const fill = Object.fromEntries(Object.entries(all).filter(([k]) => approved.has(k)));
    if (Object.keys(fill).length) {
      const pv = Object.fromEntries(Object.keys(fill).map((k) => [k, { source: b.provider, chosen: true, approvedBy: by, link: details.link, at: new Date().toISOString(), was: a.metadata?.[k] ?? null }]));
      await query(`UPDATE vod_assets SET metadata = COALESCE(metadata, '{}'::jsonb) || $2::jsonb, metadata_provenance = COALESCE(metadata_provenance, '{}'::jsonb) || $3::jsonb, updated_at = now() WHERE id = $1`,
        [a.id, JSON.stringify(fill), JSON.stringify(pv)]);
    }
  }
  if (b.useImage && imageKey) await pickAssetImage(a.id, { force: true, by });
  const { userId, label } = actor(req);
  await writeAudit(null, { accountId: acct, userId, label, action: 'update', entityType: 'vod_asset', entityId: a.id,
    changes: { song_details: { from: null, to: { provider: b.provider, album: details.album, link: details.link, image: b.useImage ? imageKey : 'kept', fields: b.fields, contentType: b.setSong ? 'song' : 'kept' } } } });
  res.json(await view(a.id, acct));
}));

vodImageRouter.delete('/:id/song/details', asyncHandler(async (req, res) => {
  const acct = accountId(req);
  const a = await owned(String(req.params.id), acct);
  if (!a) throw notFound('VOD asset not found');
  const { forgetSongDetails } = await import('../services/media/songDetails');
  let n = 0;
  for (const k of [sentAs(a), songIdentity({ title: a.title, metadata: a.metadata, ingest: a.ingest, override: a.music_lookup?.query })].filter(Boolean) as any[])
    if (await forgetSongDetails(acct, k.artist, k.title)) n++;
  res.json({ forgotten: n });
}));
