// ============================================================================
//  song.artwork: a cover for a song the moment it is on air (docs/ASSET_IMAGES.md section 8).
//
//  Queued by the station's now-playing reader (radio/icyMeta.ts) for every
//  song it writes to the guide's as-run log. Puts the image ON THE GUIDE
//  ENTRY (programmes.metadata.image, an Image Library reference), so it is
//  there as early as it can be: the player's now-playing card and history, the
//  recording's timeline and log, and any clip cut from the song later (the
//  asset image resolver takes the programme's image).
//
//  In order:
//    1. the entry already has an image (the feed sent one): nothing to do;
//    2. the station's feed carries artwork (ICY StreamUrl pointing at an
//       image): that, copied into the library;
//    3. details a person chose for this song in the console, else
//       the song lookup (MusicBrainz, then any provider switched on), through
//       the platform-wide cache and rate gate. A song that has played before
//       costs no external call at all.
//
//  Never touches the stream: a failure is a note on the entry, nothing more.
// ============================================================================
import { registerHandler, type JobContext } from '../worker';
import { enqueue } from '../queue';
import { one, query } from '../../../db';
import { parseIcyTitle } from '../../radio/trackMeta';
import { songMatch } from '../../media/musicLookup';
import { coverKey } from '../../media/assetImage';
import { importImageUrl } from '../../media/libraryImages';
import { songFolder } from '../../media/libraryPaths';
import { getSongDetails } from '../../media/songDetails';

export const SONG_ARTWORK = 'song.artwork';

export async function queueSongArtwork(programmeId: string): Promise<void> {
  try { await enqueue({ type: SONG_ARTWORK, payload: { programmeId }, dedupeKey: `song.artwork:${programmeId}`, priority: 30, maxAttempts: 2 }); }
  catch (e) { console.error(`[song.artwork] ${programmeId}: not queued:`, e); }
}

const looksLikeImage = (u: unknown) => typeof u === 'string' && /^https?:\/\/\S+\.(jpe?g|png|webp|gif)(\?\S*)?$/i.test(u.trim());

/**
 * Many stations send their LOGO as the StreamUrl with every song (SomaFM does).
 * That is not the song's cover: a feed image counts only when it changes from
 * one song to the next and does not look like a logo.
 */
async function sameEverySong(p: any, url: string): Promise<boolean> {
  if (/logo|brand|station/i.test(url)) return true;
  const prev = await one<any>(`SELECT metadata->>'stream_url' AS u FROM programmes
    WHERE channel_id = $1 AND id <> $2 AND source_ref LIKE 'icy:%' AND starts_at < $3 ORDER BY starts_at DESC LIMIT 1`, [p.channel_id, p.id, p.starts_at]);
  return !!prev && prev.u === url;
}

/** The work, separate from the job wrapper so tests can call it. Returns what it did. */
export async function attachSongArtwork(programmeId: string): Promise<{ result: string; image?: string }> {
  const p = await one<any>(`
    SELECT p.id, p.channel_id, p.title, p.metadata, p.starts_at, p.ends_at, g.account_id AS acct, c.brand_ref
      FROM programmes p JOIN channels c ON c.id = p.channel_id JOIN groups g ON g.id = c.group_id
     WHERE p.id = $1`, [programmeId]);
  if (!p) return { result: 'gone' };
  const md = p.metadata ?? {};
  if (typeof md.image === 'string' && md.image) return { result: 'already has an image', image: md.image };
  const who = (md.artist && md.title) ? { artist: String(md.artist), title: String(md.title) } : parseIcyTitle(md.raw ?? p.title);
  if (!who) return { result: 'not a song title' };

  // 2. Artwork the station's feed sent with the song.
  if (looksLikeImage(md.stream_url) && !(await sameEverySong(p, String(md.stream_url)))) {
    const key = await importImageUrl(p.acct, md.stream_url, songFolder(who.artist, null, who.title), 'cover', 'cover').catch(() => null);
    if (key) {
      await query(`UPDATE programmes SET metadata = metadata || $2::jsonb WHERE id = $1`, [p.id, JSON.stringify({ image: `/${key}`, artist: who.artist, image_source: 'feed' })]);
      return { result: 'artwork from the station feed', image: `/${key}` };
    }
  }

  // 3. Details a person chose for this song (Find song details), then the
  //    song lookup (cached for every account; gated for the platform).
  const chosen = await getSongDetails(p.acct, who.artist, who.title);
  if (chosen) {
    const extra: Record<string, unknown> = { artist: chosen.artist, album: chosen.album, released: chosen.released, isrc: chosen.isrc,
      music: { state: 'hit', provider: chosen.provider, chosen: true, link: chosen.link } };
    if (chosen.imageKey) { extra.image = `/${chosen.imageKey}`; extra.image_source = 'chosen'; }
    await query(`UPDATE programmes SET metadata = metadata || $2::jsonb WHERE id = $1`, [p.id, JSON.stringify(extra)]);
    return chosen.imageKey ? { result: 'cover chosen for this song', image: `/${chosen.imageKey}` } : { result: 'details chosen for this song (no cover)' };
  }
  const m = await songMatch(who.artist, who.title, null);
  if (m.state !== 'hit') {
    await query(`UPDATE programmes SET metadata = metadata || $2::jsonb WHERE id = $1`, [p.id, JSON.stringify({ artist: who.artist, music: { state: m.state, reason: m.reason ?? null } })]);
    return { result: `no cover (${m.state})` };
  }
  const key = await coverKey(p.acct, m).catch(() => null);
  const extra: Record<string, unknown> = {
    artist: m.artist ?? who.artist, album: m.album ?? null, released: m.released ?? null, isrc: m.isrc ?? null,
    music: { state: 'hit', provider: m.provider ?? 'musicbrainz', confidence: m.confidence ?? null, link: m.link ?? null },
  };
  if (key) { extra.image = `/${key}`; extra.image_source = m.provider ?? 'musicbrainz'; }
  await query(`UPDATE programmes SET metadata = metadata || $2::jsonb WHERE id = $1`, [p.id, JSON.stringify(extra)]);
  return key ? { result: `cover from ${m.provider ?? 'musicbrainz'}`, image: `/${key}` } : { result: 'matched, but the album has no cover' };
}

async function handle(ctx: JobContext): Promise<void> {
  const id = String((ctx.job.payload as any)?.programmeId ?? '');
  if (!id) return;
  try { const r = await attachSongArtwork(id); await ctx.progress(100, r.result); }
  catch (e: any) { await ctx.progress(100, `failed: ${String(e?.message ?? e)}`.slice(0, 300)); }
}

export function registerSongArtworkHandlers(): void {
  registerHandler(SONG_ARTWORK, handle);
}
