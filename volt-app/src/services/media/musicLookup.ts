// ============================================================================
//  SONG ASSETS: who it is, which album, and the album cover.
//
//  MusicBrainz (open data, CC0 core) finds the recording; the Cover Art
//  Archive serves the album's front cover. Same providers, User-Agent and
//  one-request-a-second gate as the live now-playing card (radio/trackMeta.ts,
//  which explains why not iTunes, Spotify or Last.fm).
//
//  THE HARD PART IS PICKING THE RIGHT RECORDING. A search for a famous song
//  returns dozens of recordings that all score 100: live sets, bootlegs,
//  karaoke, remasters, cast albums. The first hit for "Queen, Bohemian
//  Rhapsody" is a two-minute live cut from 2003. So:
//
//    1. a STRICT query first: official release, studio album, not live, not a
//       compilation or soundtrack, not a video;
//    2. if that finds nothing, a LOOSE query, and every candidate is scored
//       (scoreRecording): artist match, versions named in the disambiguation
//       (live, karaoke, remix, demo, instrumental, cover...), release status
//       and type, and how close its length is to the asset's;
//    3. below a confidence floor it is a MISS. Wrong cover art on air is
//       worse than the station logo.
//
//  A hit is then enriched (ISRC, genres, label, the album's first release
//  date) with three more gated calls, and cached in music_lookups for every
//  account. The cover is copied into the account's Image Library once per
//  album, so it is served and resized like any other image and never depends
//  on archive.org being up.
//
//  Filling metadata never overwrites: only empty fields of the song type are
//  filled (album, released, isrc, genre if it is one of the type's options,
//  label), recorded in metadata_provenance as source "musicbrainz".
// ============================================================================
import { one, query } from '../../db';
import { config } from '../../config';
import { musicbrainzGet, normKey, parseIcyTitle } from '../radio/trackMeta';

export interface MusicMatch {
  state: 'hit' | 'miss' | 'error';
  artist?: string | null;
  title?: string | null;
  album?: string | null;
  released?: string | null;
  isrc?: string | null;
  genres?: string[];
  label?: string | null;
  lengthMs?: number | null;
  recordingMbid?: string | null;
  releaseMbid?: string | null;
  releaseGroupMbid?: string | null;
  confidence?: number;
  reason?: string;
  /** Which provider answered (musicbrainz, deezer, apple, page), its page, and a direct cover URL when it is not the Cover Art Archive. */
  provider?: string;
  link?: string | null;
  coverUrl?: string | null;
}

/** Versions that are not the record a listener means. */
const VERSION_WORDS = /\b(live|karaoke|remix|mix|demo|instrumental|acoustic|cover|tribute|edit|rehearsal|session|a cappella|acapella|cast|orchestral|reprise|outtake|alternate|take \d+|rough|early|dolby|atmos|5\.1|mono)\b/i;
const MIN_CONFIDENCE = 70;

const clean = (s: string) => s.toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/&/g, 'and').replace(/[^a-z0-9]+/g, ' ').trim();

/**
 * How much a search result looks like THE recording of this song: 0..100.
 * Pure, so the rules are tested without the network (test/asset-images.check.ts).
 */
export function scoreRecording(r: any, want: { artist: string; title: string; durationMs?: number | null }): { score: number; notes: string[]; release: any | null } {
  const notes: string[] = [];
  let s = Math.min(100, Number(r?.score ?? 0)) * 0.5;                    // the search engine's own view, half weight
  const artists = (r?.['artist-credit'] ?? []).map((a: any) => clean(String(a?.name ?? a?.artist?.name ?? '')));
  const wantArtist = clean(want.artist).replace(/\s+(feat|ft|featuring|with)\s.*$/, '');
  if (artists.some((a: string) => a === wantArtist)) s += 20;
  else if (artists.some((a: string) => a && (a.includes(wantArtist) || wantArtist.includes(a)))) { s += 10; notes.push('artist credit differs'); }
  else { s -= 25; notes.push('different artist'); }
  if (clean(String(r?.title ?? '')) === clean(want.title)) s += 10; else { s -= 10; notes.push('title differs'); }
  const dis = String(r?.disambiguation ?? '');
  if (dis && VERSION_WORDS.test(dis)) { s -= 30; notes.push(`a ${dis.split(/[,:]/)[0].trim()} version`); }
  if (VERSION_WORDS.test(String(r?.title ?? '').replace(clean(want.title), '')) && !VERSION_WORDS.test(want.title)) { s -= 15; notes.push('a version named in the title'); }
  if (r?.video === true) { s -= 20; notes.push('a video recording'); }

  const isCompilationBy = (x: any) => {
    const rel = (x?.['artist-credit'] ?? []).map((a: any) => clean(String(a?.name ?? '')));
    return rel.length > 0 && (rel.includes('various artists') || !rel.some((a: string) => a === wantArtist || a.includes(wantArtist)));
  };
  const releases: any[] = r?.releases ?? [];
  const rank = (x: any) => {
    const rg = x?.['release-group'] ?? {};
    const sec: string[] = rg['secondary-types'] ?? [];
    let v = 0;
    // A release credited to Various Artists, or not to this artist, is a
    // compilation whatever its type says ("Traumhaft 2" for Fleetwood Mac).
    if (isCompilationBy(x)) v -= 5;
    if (x?.status === 'Official') v += 3; else if (x?.status === 'Bootleg') v -= 4;
    if (rg['primary-type'] === 'Album') v += 3; else if (rg['primary-type'] === 'Single' || rg['primary-type'] === 'EP') v += 2;
    if (sec.length === 0) v += 3;
    if (sec.some((t) => /live|compilation|soundtrack|remix|dj-mix|mixtape|demo/i.test(t))) v -= 4;
    return v;
  };
  const best = releases.length ? [...releases].sort((a, b) => rank(b) - rank(a) || String(a?.date ?? '9999').localeCompare(String(b?.date ?? '9999')))[0] : null;
  // No release means no album and no cover: almost never what a listener means.
  if (!best) { s -= 30; notes.push('on no release'); }
  else {
    const rr = rank(best);
    s += rr * 2;                                                          // -16 .. +18
    // Its BEST release is what counts: a recording found only on bootlegs or
    // only on live albums is not the record, whatever the search engine says.
    if (best.status === 'Bootleg') { s -= 20; notes.push('only on bootlegs'); }
    if (isCompilationBy(best)) { s -= 20; notes.push('only on other artists\' compilations'); }
    const sec: string[] = best['release-group']?.['secondary-types'] ?? [];
    if (sec.length) notes.push(`on a ${sec.join('/').toLowerCase()} release`);
    if (sec.some((t) => /live|compilation|soundtrack|remix|dj-mix|mixtape|demo/i.test(t))) s -= 10;
  }
  if (want.durationMs && r?.length) {
    const d = Math.abs(Number(r.length) - want.durationMs) / 1000;
    if (d <= 4) s += 10; else if (d <= 15) s += 4; else if (d > 45) { s -= 15; notes.push(`length differs by ${Math.round(d)} s`); }
  }
  return { score: Math.max(0, Math.min(100, Math.round(s))), notes, release: best };
}

/**
 * The best candidate, or null when nothing reaches the floor.
 *
 * CONSENSUS: the album a song belongs to turns up on many of its recordings
 * (remasters, deluxe editions, regional pressings all say "Rumours"), while a
 * compilation is usually one. So an album title shared by several candidates
 * earns a bonus, and ties go to the earliest release.
 */
export function pickRecording(recs: any[], want: { artist: string; title: string; durationMs?: number | null }) {
  const base = (recs ?? []).map((r) => ({ r, ...scoreRecording(r, want) }));
  const votes = new Map<string, number>();
  for (const b of base) { const t = clean(String(b.release?.['release-group']?.title ?? '')); if (t) votes.set(t, (votes.get(t) ?? 0) + 1); }
  const scored = base.map((b) => {
    const n = votes.get(clean(String(b.release?.['release-group']?.title ?? ''))) ?? 0;
    return n > 1 ? { ...b, score: Math.min(100, b.score + Math.min(10, 3 * (n - 1))), notes: b.notes } : b;
  }).sort((a, b) => b.score - a.score || String(a.release?.date ?? '9999').localeCompare(String(b.release?.date ?? '9999')));
  const top = scored[0];
  return top && top.score >= MIN_CONFIDENCE ? top : null;
}

const q = (s: string) => s.replace(/["\\]/g, ' ').trim();
type Want = { artist: string; title: string; durationMs?: number | null };

/**
 * The ways to ask for one song, most likely first. Stations and files write
 * the same song many ways: "(feat. ...)", "- Radio Edit", "(Remastered 2011)",
 * "[Live]", and some streams send "Title - Artist". Pure; tested.
 */
export function queryVariants(want: Want): (Want & { variant: string })[] {
  const out: (Want & { variant: string })[] = [{ ...want, variant: 'as given' }];
  const strip = (t: string) => t
    .replace(/\s*[([](feat\.?|ft\.?|featuring|with)\s[^)\]]*[)\]]/gi, '')
    .replace(/\s*[([][^)\]]*\b(remaster(ed)?|radio edit|edit|single version|album version|explicit|clean|mono|stereo|bonus track|original( mix| version)?)\b[^)\]]*[)\]]/gi, '')
    .replace(/\s+-\s+(\d{4}\s+)?(remaster(ed)?|radio edit|single version|album version|edit)(\s+\d{4})?\s*$/i, '')
    .replace(/\s{2,}/g, ' ').trim();
  const a2 = want.artist.replace(/\s+(feat\.?|ft\.?|featuring|with|&|x|and)\s.*$/i, '').trim() || want.artist;
  const t2 = strip(want.title) || want.title;
  if (a2 !== want.artist || t2 !== want.title) out.push({ ...want, artist: a2, title: t2, variant: 'cleaned' });
  // Last resorts: the title with every bracket removed, then artist and title swapped.
  const bare = t2.replace(/\s*[([][^)\]]*[)\]]/g, '').trim();
  if (bare && bare !== t2) out.push({ ...want, artist: a2, title: bare, variant: 'without brackets' });
  out.push({ ...want, artist: t2, title: a2, variant: 'artist and title swapped' });
  return out;
}

async function searchRecordings(want: Want) {
  const base = `artist:"${q(want.artist)}" AND recording:"${q(want.title)}"`;
  const strict = `${base} AND status:official AND primarytype:album AND -secondarytype:live AND -secondarytype:compilation AND -secondarytype:soundtrack AND video:false`;
  // Both, always: the strict query hides the plain original when its releases
  // are indexed oddly ("Dreams" on Rumours), the loose one buries it under live
  // sets. Scored together, with consensus across both, the album wins.
  const a = await musicbrainzGet(`/recording?query=${encodeURIComponent(strict)}&fmt=json&limit=15`);
  const b = await musicbrainzGet(`/recording?query=${encodeURIComponent(base)}&fmt=json&limit=40`);
  const seen = new Set<string>(); const all: any[] = [];
  for (const r of [...(a?.recordings ?? []), ...(b?.recordings ?? [])]) if (r?.id && !seen.has(r.id)) { seen.add(r.id); all.push(r); }
  const p = pickRecording(all, want);
  return p ? { ...p, how: `best of ${all.length} recordings` } : null;
}

/**
 * A single named after the song: some releases are catalogued as a release
 * group with no recording entered yet. Enough for the cover, album and date.
 */
async function searchSingle(want: Want): Promise<MusicMatch | null> {
  const qq = `releasegroup:"${q(want.title)}" AND artist:"${q(want.artist)}"`;
  const r = await musicbrainzGet(`/release-group?query=${encodeURIComponent(qq)}&fmt=json&limit=5`);
  const wantA = clean(want.artist), wantT = clean(want.title);
  const rg = (r?.['release-groups'] ?? []).find((g: any) => clean(String(g.title ?? '')) === wantT
    && (g['artist-credit'] ?? []).some((c: any) => clean(String(c.name ?? '')) === wantA));
  if (!rg) return null;
  return { state: 'hit', artist: want.artist, title: want.title, album: rg.title, released: rg['first-release-date'] ?? null, recordingMbid: null,
    releaseMbid: rg.releases?.[0]?.id ?? null, releaseGroupMbid: rg.id, genres: [], isrc: null, label: null, confidence: 75,
    reason: `a ${String(rg['primary-type'] ?? 'release').toLowerCase()} of the same name (no recording catalogued)` };
}

/** MusicBrainz for one song: the variants in order, then enrich the match. */
export async function lookupMusicBrainz(want: Want): Promise<MusicMatch> {
  let hit: Awaited<ReturnType<typeof searchRecordings>> = null; let used = want; let variant = 'as given';
  for (const v of queryVariants(want)) {
    hit = await searchRecordings(v);
    if (hit) { used = v; variant = v.variant; break; }
  }
  if (!hit) {
    const single = await searchSingle(want);
    if (single) return { ...single, provider: 'musicbrainz', link: `https://musicbrainz.org/release-group/${single.releaseGroupMbid}` };
    return { state: 'miss', provider: 'musicbrainz', reason: `MusicBrainz has no confident match (tried ${queryVariants(want).map((v) => v.variant).join(', ')}, and a single of the same name).` };
  }
  const r = hit.r; const rel = hit.release;
  const out: MusicMatch = {
    state: 'hit', provider: 'musicbrainz',
    artist: (r['artist-credit'] ?? []).map((a: any) => `${a.name ?? a.artist?.name ?? ''}${a.joinphrase ?? ''}`).join('').trim() || used.artist,
    title: r.title ?? used.title,
    album: rel?.['release-group']?.title ?? rel?.title ?? null,
    released: rel?.date ?? r['first-release-date'] ?? null,
    lengthMs: Number.isFinite(Number(r.length)) ? Number(r.length) : null,
    recordingMbid: r.id ?? null,
    releaseMbid: rel?.id ?? null,
    releaseGroupMbid: rel?.['release-group']?.id ?? null,
    genres: [], isrc: null, label: null,
    confidence: hit.score,
    link: r.id ? `https://musicbrainz.org/recording/${r.id}` : null,
    reason: `${hit.how}${variant !== 'as given' ? ` (${variant})` : ''}, confidence ${hit.score}${hit.notes.length ? ` (${hit.notes.join('; ')})` : ''}`,
  };
  // Enrichment is best effort: a hit without an ISRC is still a hit.
  try {
    const rec = await musicbrainzGet(`/recording/${encodeURIComponent(out.recordingMbid!)}?inc=isrcs+genres&fmt=json`);
    out.isrc = Array.isArray(rec?.isrcs) && rec.isrcs.length ? String(rec.isrcs[0]) : null;
    out.genres = (rec?.genres ?? []).sort((a: any, b: any) => (b.count ?? 0) - (a.count ?? 0)).map((g: any) => String(g.name)).slice(0, 5);
  } catch { /* keep the match */ }
  if (out.releaseGroupMbid) {
    try {
      const rg = await musicbrainzGet(`/release-group/${encodeURIComponent(out.releaseGroupMbid)}?inc=genres&fmt=json`);
      if (rg?.['first-release-date']) out.released = String(rg['first-release-date']);
      if (!out.genres?.length) out.genres = (rg?.genres ?? []).map((g: any) => String(g.name)).slice(0, 5);
    } catch { /* keep */ }
  }
  if (out.releaseMbid) {
    try {
      const rl = await musicbrainzGet(`/release/${encodeURIComponent(out.releaseMbid)}?inc=labels&fmt=json`);
      out.label = rl?.['label-info']?.find((l: any) => l?.label?.name)?.label?.name ?? null;
    } catch { /* keep */ }
  }
  return out;
}

// ---------------------------------------------------------------- Deezer (opt-in)

/** Deezer allows 50 calls per 5 s per IP; one every 150 ms across the platform keeps under it. */
async function deezerGet(path: string): Promise<any> {
  await (await import('../rateGate')).takeTurn('deezer', 150);
  const ac = new AbortController(); const t = setTimeout(() => ac.abort(), config.trackMeta.timeoutMs);
  try {
    const res = await fetch(`${config.trackMeta.deezerBase}${path}`, { signal: ac.signal, headers: { Accept: 'application/json' } });
    if (!res.ok) throw Object.assign(new Error(`deezer ${res.status}`), { transient: res.status >= 500 || res.status === 429 });
    const j: any = await res.json();
    if (j?.error) throw Object.assign(new Error(`deezer: ${j.error.message ?? j.error.type ?? 'error'}`), { transient: j.error.code === 4 });
    return j;
  } finally { clearTimeout(t); }
}

/** How much a Deezer track looks like this song: 0..100. Pure; tested. */
export function scoreDeezerTrack(t: any, want: Want): { score: number; notes: string[] } {
  const notes: string[] = [];
  let s = 40;
  const a = clean(String(t?.artist?.name ?? '')), wa = clean(want.artist);
  if (a === wa) s += 30; else if (a && (a.includes(wa) || wa.includes(a))) { s += 12; notes.push('artist credit differs'); } else { s -= 30; notes.push('different artist'); }
  const ti = clean(String(t?.title ?? '')), tshort = clean(String(t?.title_short ?? t?.title ?? '')), wt = clean(want.title);
  if (ti === wt || tshort === wt) s += 20; else if (ti.startsWith(wt) || wt.startsWith(tshort)) { s += 8; notes.push('title differs'); } else { s -= 20; notes.push('title differs'); }
  const version = String(t?.title_version ?? '');
  if (version && VERSION_WORDS.test(version) && !VERSION_WORDS.test(want.title)) { s -= 20; notes.push(`a ${version.replace(/[()]/g, '').trim()} version`); }
  if (want.durationMs && t?.duration) {
    const d = Math.abs(Number(t.duration) * 1000 - want.durationMs) / 1000;
    if (d <= 4) s += 10; else if (d > 45) { s -= 15; notes.push(`length differs by ${Math.round(d)} s`); }
  }
  return { score: Math.max(0, Math.min(100, Math.round(s))), notes };
}

export async function lookupDeezer(want: Want): Promise<MusicMatch> {
  // The same variants as MusicBrainz (cleaned of "(with ...)", "- Radio Edit";
  // artist and title swapped), each fielded then free text, until confident.
  let best: { t: any; score: number; notes: string[]; variant: string } | null = null;
  outer: for (const v of queryVariants(want)) {
    for (const qq of [`artist:"${q(v.artist)}" track:"${q(v.title)}"`, `${q(v.artist)} ${q(v.title)}`]) {
      const r = await deezerGet(`/search?q=${encodeURIComponent(qq)}&limit=15`);
      for (const t of r?.data ?? []) { const sc = scoreDeezerTrack(t, v); if (!best || sc.score > best.score) best = { t, ...sc, variant: v.variant }; }
      if (best && best.score >= MIN_CONFIDENCE) break outer;
    }
  }
  if (!best || best.score < MIN_CONFIDENCE) return { state: 'miss', provider: 'deezer', reason: 'Deezer has no confident match.' };
  const t = best.t;
  const out: MusicMatch = {
    state: 'hit', provider: 'deezer', artist: t.artist?.name ?? want.artist, title: t.title ?? want.title, album: t.album?.title ?? null,
    isrc: t.isrc ?? null, lengthMs: t.duration ? Number(t.duration) * 1000 : null, genres: [], label: null, released: null,
    coverUrl: t.album?.cover_xl ?? t.album?.cover_big ?? null, link: t.link ?? null, confidence: best.score,
    reason: `Deezer${best.variant !== 'as given' ? ` (${best.variant})` : ''}, confidence ${best.score}${best.notes.length ? ` (${best.notes.join('; ')})` : ''}`,
  };
  try {
    const al = await deezerGet(`/album/${encodeURIComponent(String(t.album?.id))}`);
    out.released = al?.release_date ?? null;
    out.label = al?.label ?? null;
    out.genres = (al?.genres?.data ?? []).map((g: any) => String(g.name)).slice(0, 5);
    if (al?.record_type === 'compile') out.reason += ' (on a compilation)';
    out.coverUrl = al?.cover_xl ?? out.coverUrl;
  } catch { /* keep the match */ }
  return out;
}

// ---------------------------------------------------------------- Apple (opt-in)
//  The iTunes Search API: about 20 calls a minute per IP, no key. Its terms
//  allow artwork and track details only to PROMOTE the item, shown next to a
//  link to it on Apple Music. Off for automatic lookups unless listed in
//  MUSIC_PROVIDERS; offered in "Find song details" with that condition shown.

async function appleGet(path: string): Promise<any> {
  await (await import('../rateGate')).takeTurn('apple', 3100);
  const ac = new AbortController(); const t = setTimeout(() => ac.abort(), config.trackMeta.timeoutMs);
  try {
    const res = await fetch(`${config.trackMeta.appleBase}${path}`, { signal: ac.signal, headers: { Accept: 'application/json' } });
    if (!res.ok) throw Object.assign(new Error(`apple ${res.status}`), { transient: res.status >= 500 || res.status === 403 || res.status === 429 });
    return JSON.parse((await res.text()).trim() || '{}');
  } finally { clearTimeout(t); }
}

/** "Infinite Lights - Single" is the single Infinite Lights. */
export const appleAlbum = (s: unknown) => String(s ?? '').replace(/\s+-\s+(Single|EP)$/i, '').trim() || null;

/** How much an iTunes result looks like this song: 0..100. Pure; tested. */
export function scoreAppleTrack(t: any, want: Want): { score: number; notes: string[] } {
  return scoreDeezerTrack({ artist: { name: t?.artistName }, title: t?.trackName, title_short: t?.trackCensoredName ?? t?.trackName,
    title_version: (/\(([^)]*)\)/.exec(String(t?.trackName ?? '')) ?? [])[0] ?? '', duration: t?.trackTimeMillis ? t.trackTimeMillis / 1000 : null }, want);
}

/** Equal scores: the earliest release wins (the original album, not a playlist or compilation reusing it). */
const appleBetter = (x: { score: number; t: any }, y: { score: number; t: any } | null) =>
  !y || x.score > y.score || (x.score === y.score && String(x.t?.releaseDate ?? '9') < String(y.t?.releaseDate ?? '9'));

export async function lookupApple(want: Want): Promise<MusicMatch> {
  let best: { t: any; score: number; notes: string[]; variant: string } | null = null;
  for (const v of queryVariants(want)) {
    const r = await appleGet(`/search?entity=song&limit=25&term=${encodeURIComponent(`${v.artist} ${v.title}`)}`);
    for (const t of r?.results ?? []) { const sc = scoreAppleTrack(t, v); const c = { t, ...sc, variant: v.variant }; if (appleBetter(c, best)) best = c; }
    if (best && best.score >= MIN_CONFIDENCE) break;
  }
  // Apple's song search ranks covers and remixes above some originals (Tame Impala's
  // "The Less I Know the Better" is not in the first 50). Then: the artist, and their songs.
  if (!best || best.score < MIN_CONFIDENCE) {
    const ar = await appleGet(`/search?entity=musicArtist&limit=5&term=${encodeURIComponent(want.artist)}`);
    const artist = (ar?.results ?? []).find((x: any) => clean(String(x.artistName ?? '')) === clean(want.artist));
    if (artist?.artistId) {
      const songs = await appleGet(`/lookup?id=${encodeURIComponent(String(artist.artistId))}&entity=song&limit=200`);
      for (const t of (songs?.results ?? []).filter((x: any) => x.wrapperType === 'track')) {
        for (const v of queryVariants(want).filter((x) => x.variant !== 'artist and title swapped')) {
          const sc = scoreAppleTrack(t, v); const c = { t, ...sc, variant: `${v.variant}, from the artist's songs` }; if (appleBetter(c, best)) best = c;
        }
      }
    }
  }
  if (!best || best.score < MIN_CONFIDENCE) return { state: 'miss', provider: 'apple', reason: 'Apple has no confident match.' };
  const t = best.t;
  const art = typeof t.artworkUrl100 === 'string' ? t.artworkUrl100.replace(/\/\d+x\d+(bb)?\.(jpg|png)$/i, '/1200x1200bb.jpg') : null;
  return {
    state: 'hit', provider: 'apple', artist: t.artistName ?? want.artist, title: t.trackName ?? want.title, album: appleAlbum(t.collectionName),
    released: typeof t.releaseDate === 'string' ? t.releaseDate.slice(0, 10) : null, genres: t.primaryGenreName ? [String(t.primaryGenreName)] : [],
    label: null, isrc: null, lengthMs: t.trackTimeMillis ?? null, coverUrl: art, link: t.trackViewUrl ?? null, confidence: best.score,
    reason: `Apple${best.variant !== 'as given' ? ` (${best.variant})` : ''}, confidence ${best.score}${best.notes.length ? ` (${best.notes.join('; ')})` : ''}`,
  };
}

/** What each provider's terms allow, shown wherever a person chooses one. */
export const PROVIDER_TERMS: Record<string, string> = {
  musicbrainz: 'Open data (CC0). Covers belong to their rights holders.',
  deezer: 'Deezer API: non-commercial use unless agreed with Deezer.',
  apple: 'Apple: to promote the song only, shown with a link to it on Apple Music.',
  page: 'From a web page: check that you may use it.',
};

const PROVIDERS: Record<string, (w: Want) => Promise<MusicMatch>> = { musicbrainz: lookupMusicBrainz, deezer: lookupDeezer, apple: lookupApple };
export const ALL_PROVIDERS = () => Object.keys(PROVIDERS);
export const enabledProviders = () => config.trackMeta.providers.filter((p) => PROVIDERS[p]);

/**
 * Every enabled provider in order until one finds the song. A provider that
 * fails (busy, down) does not stop the next; the answer is an ERROR only when
 * none found it and at least one could not be asked, so it is retried later.
 */
export async function lookupSong(want: Want, providers = enabledProviders()): Promise<MusicMatch & { tried: { provider: string; state: string; reason?: string }[] }> {
  const tried: { provider: string; state: string; reason?: string }[] = [];
  for (const p of providers) {
    let m: MusicMatch;
    try { m = await PROVIDERS[p](want); } catch (e: any) { m = { state: 'error', provider: p, reason: String(e?.message ?? e).slice(0, 200) }; }
    tried.push({ provider: p, state: m.state, reason: m.reason });
    if (m.state === 'hit') return { ...m, tried };
  }
  const errored = tried.filter((t) => t.state === 'error');
  return { state: errored.length ? 'error' : 'miss', tried,
    reason: tried.map((t) => `${t.provider}: ${t.state === 'miss' ? 'no match' : t.reason ?? t.state}`).join('; ') || 'No music provider is enabled.' };
}

const ERROR_RETRY_MS = 6 * 3600_000;

/** A song's match, from the shared cache or the providers. Misses are remembered (until the providers change); errors retried after six hours. */
export async function songMatch(artist: string, title: string, durationMs?: number | null, opts: { force?: boolean; retryErrors?: boolean; cacheOnly?: boolean } = {}): Promise<MusicMatch> {
  const key = normKey(artist, title);
  const providers = enabledProviders();
  const row = await one<any>(`SELECT * FROM music_lookups WHERE norm_key = $1`, [key]);
  // Rows from before providers were recorded were MusicBrainz only.
  const sameProviders = row?.state === 'hit' || (row?.providers_tried || 'musicbrainz') === providers.join(',');
  if (row && !opts.force && sameProviders && (row.state !== 'error' || (!opts.retryErrors && Date.now() - new Date(row.looked_up_at).getTime() < ERROR_RETRY_MS))) return rowToMatch(row);
  // Not this asset's turn to look up (it was looked up when created): what the cache already knows, or nothing.
  if (opts.cacheOnly) return row && row.state === 'hit' ? rowToMatch(row) : { state: 'miss', reason: 'Not looked up again: songs are looked up when the asset is created, or when someone checks.' };
  let m: MusicMatch;
  try { m = await lookupSong({ artist, title, durationMs }, providers); }
  catch (e: any) { m = { state: 'error', reason: String(e?.message ?? e).slice(0, 200) }; }
  await query(
    `INSERT INTO music_lookups(norm_key, state, artist, title, album, released, isrc, genres, label, length_ms, recording_mbid, release_mbid, release_group_mbid, confidence, reason, provider, cover_url, link, providers_tried, attempts, looked_up_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,1,now())
     ON CONFLICT (norm_key) DO UPDATE SET state=EXCLUDED.state, artist=EXCLUDED.artist, title=EXCLUDED.title, album=EXCLUDED.album, released=EXCLUDED.released,
       isrc=EXCLUDED.isrc, genres=EXCLUDED.genres, label=EXCLUDED.label, length_ms=EXCLUDED.length_ms, recording_mbid=EXCLUDED.recording_mbid,
       release_mbid=EXCLUDED.release_mbid, release_group_mbid=EXCLUDED.release_group_mbid, confidence=EXCLUDED.confidence, reason=EXCLUDED.reason,
       provider=EXCLUDED.provider, cover_url=EXCLUDED.cover_url, link=EXCLUDED.link, providers_tried=EXCLUDED.providers_tried,
       attempts=music_lookups.attempts + 1, looked_up_at=now()`,
    [key, m.state, m.artist ?? null, m.title ?? null, m.album ?? null, m.released ?? null, m.isrc ?? null, m.genres ?? [], m.label ?? null,
     m.lengthMs ?? null, m.recordingMbid ?? null, m.releaseMbid ?? null, m.releaseGroupMbid ?? null, m.confidence ?? null, m.reason ?? null,
     m.provider ?? null, m.coverUrl ?? null, m.link ?? null, providers.join(',')]);
  return m;
}

function rowToMatch(r: any): MusicMatch {
  return { state: r.state, artist: r.artist, title: r.title, album: r.album, released: r.released, isrc: r.isrc, genres: r.genres ?? [], label: r.label,
    lengthMs: r.length_ms, recordingMbid: r.recording_mbid, releaseMbid: r.release_mbid, releaseGroupMbid: r.release_group_mbid,
    confidence: r.confidence ?? undefined, reason: r.reason ?? undefined, provider: r.provider ?? undefined, coverUrl: r.cover_url ?? null, link: r.link ?? null };
}

/** The album cover's URL at the Cover Art Archive (it redirects to the file). */
export const coverUrl = (releaseGroupMbid: string, size: 250 | 500 | 1200 = 1200) =>
  `${config.trackMeta.coverArtBase}/release-group/${encodeURIComponent(releaseGroupMbid)}/front-${size}`;

/** The cover for a match, from whichever provider found it. Null when there is none. */
export async function fetchCoverFor(m: MusicMatch): Promise<{ data: Buffer; contentType: string } | null> {
  if (m.coverUrl && m.provider !== 'musicbrainz') return fetchImage(m.coverUrl);
  return m.releaseGroupMbid ? fetchCover(m.releaseGroupMbid, m.releaseMbid) : null;
}

/** Download a cover: an image, at most 8 MB, or null (no cover is a normal answer). */
export async function fetchCover(releaseGroupMbid: string, releaseMbid?: string | null): Promise<{ data: Buffer; contentType: string } | null> {
  const a = await fetchImage(coverUrl(releaseGroupMbid));
  // The album's chosen front is missing, but the release we matched may have one.
  if (a || !releaseMbid) return a;
  return fetchImage(`${config.trackMeta.coverArtBase}/release/${encodeURIComponent(releaseMbid)}/front-1200`);
}

async function fetchImage(url: string): Promise<{ data: Buffer; contentType: string } | null> {
  const ac = new AbortController(); const t = setTimeout(() => ac.abort(), 15_000);
  try {
    const res = await fetch(url, { signal: ac.signal, redirect: 'follow', headers: { 'User-Agent': config.trackMeta.userAgent } });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`cover art ${res.status}`);
    const ct = String(res.headers.get('content-type') ?? '').split(';')[0].trim();
    if (!/^image\/(jpeg|png|webp|gif)$/.test(ct)) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > 8 * 1024 * 1024 || buf.length < 100) return null;
    return { data: buf, contentType: ct };
  } finally { clearTimeout(t); }
}

/**
 * Who and what a song asset is, from what we have: the song type's fields,
 * an ICY title the asset was cut from, the file's ID3 tags, or a title
 * written "Artist - Title". Null when it cannot be told.
 */
export function songIdentity(a: { title?: string | null; metadata?: any; ingest?: any; override?: { artist?: string; title?: string } | null }): { artist: string; title: string; from: string } | null {
  const m = a.metadata ?? {};
  const s = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : '');
  // A person said who it is ("look up as"): that wins.
  if (s(a.override?.artist) && s(a.override?.title)) return { artist: s(a.override!.artist), title: s(a.override!.title), from: 'override' };
  if (s(m.artist) && s(m.title)) return { artist: s(m.artist), title: s(m.title), from: 'metadata' };
  const raw = s(m.raw);
  if (m.source === 'icy' && raw) { const p = parseIcyTitle(raw); if (p) return { ...p, from: 'icy' }; }
  if (s(m.artist) && s(a.title)) {
    // An asset titled "Artist - Song" (as cut from the stream): the song is the part after the artist.
    const p = parseIcyTitle(s(a.title));
    const same = p && p.artist.toLowerCase() === s(m.artist).toLowerCase();
    return { artist: s(m.artist), title: same ? p!.title : s(a.title), from: 'metadata' };
  }
  const id3 = a.ingest?.id3 ?? {};
  const ia = s(id3.artist ?? id3.TPE1), it = s(id3.title ?? id3.TIT2);
  if (ia && it) return { artist: ia, title: it, from: 'id3' };
  const p = parseIcyTitle(s(a.title));
  return p ? { ...p, from: 'title' } : null;
}

/** Song-type fields this match can fill, given what is already there. Only empty fields. */
export function fillsFor(match: MusicMatch, current: Record<string, any>, fields: { key: string; type: string; options?: string[]; multiple?: boolean }[]): Record<string, any> {
  if (match.state !== 'hit') return {};
  const has = (k: string) => current[k] != null && String(current[k]).trim() !== '' && !(Array.isArray(current[k]) && !current[k].length);
  const byKey = new Map(fields.map((f) => [f.key, f]));
  const out: Record<string, any> = {};
  const put = (k: string, v: any) => { if (v == null || v === '' || has(k) || !byKey.has(k)) return; out[k] = v; };
  put('title', match.title);
  put('artist', match.artist);
  put('album', match.album);
  put('isrc', match.isrc);
  put('label', match.label);
  const rel = byKey.get('released');
  if (rel && match.released) {
    const d = /^\d{4}-\d{2}-\d{2}$/.test(match.released) ? match.released : /^\d{4}-\d{2}$/.test(match.released) ? `${match.released}-01` : /^\d{4}$/.test(match.released) ? `${match.released}-01-01` : null;
    put('released', rel.type === 'date' ? d : match.released);
  }
  const g = byKey.get('genre');
  if (g && match.genres?.length) {
    if (g.type === 'enum' && g.options?.length) {
      const opt = match.genres.map((x) => g.options!.find((o) => clean(o) === clean(x) || clean(x).includes(clean(o)))).find(Boolean);
      if (opt) put('genre', g.multiple ? [opt] : opt);
    } else put('genre', match.genres[0]);
  }
  return out;
}
