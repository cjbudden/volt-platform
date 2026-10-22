// ============================================================================
//  SONG DETAILS A PERSON CHOSE, kept for the account (migration 0074).
//
//  "Find song details" in the asset panel lets a person pick what a source
//  found (or a page they pasted, or what they typed) for a song. It is kept
//  per account by normalised artist|title, so every later play of that song
//  (the cover on the guide entry as it airs, any clip cut from it, any other
//  asset of it) uses it at once, before and instead of the automatic lookup.
// ============================================================================
import { one, query } from '../../db';
import { normKey } from '../radio/trackMeta';
import type { MusicMatch } from './musicLookup';

export interface SongDetails {
  artist: string; title: string; album: string | null; released: string | null; label: string | null; isrc: string | null;
  genres: string[]; imageKey: string | null; provider: string; link: string | null; terms: string | null; chosenBy: string | null; chosenAt: string;
}

const row = (r: any): SongDetails => ({
  artist: r.artist, title: r.title, album: r.album, released: r.released, label: r.label, isrc: r.isrc, genres: r.genres ?? [],
  imageKey: r.image_key, provider: r.provider, link: r.link, terms: r.terms, chosenBy: r.chosen_by, chosenAt: r.chosen_at,
});

export async function getSongDetails(acct: string, artist: string, title: string): Promise<SongDetails | null> {
  const r = await one<any>(`SELECT * FROM song_details WHERE account_id = $1 AND norm_key = $2`, [acct, normKey(artist, title)]).catch(() => null);
  return r ? row(r) : null;
}

/** Keyed by the name the asset goes by (what the station sends), not the corrected one, so the next play finds it. */
export async function saveSongDetails(acct: string, asked: { artist: string; title: string }, d: Omit<SongDetails, 'chosenAt'>): Promise<void> {
  await query(
    `INSERT INTO song_details(account_id, norm_key, artist, title, album, released, label, isrc, genres, image_key, provider, link, terms, chosen_by, chosen_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14, now())
     ON CONFLICT (account_id, norm_key) DO UPDATE SET artist=EXCLUDED.artist, title=EXCLUDED.title, album=EXCLUDED.album, released=EXCLUDED.released,
       label=EXCLUDED.label, isrc=EXCLUDED.isrc, genres=EXCLUDED.genres, image_key=EXCLUDED.image_key, provider=EXCLUDED.provider, link=EXCLUDED.link,
       terms=EXCLUDED.terms, chosen_by=EXCLUDED.chosen_by, chosen_at=now()`,
    [acct, normKey(asked.artist, asked.title), d.artist, d.title, d.album, d.released, d.label, d.isrc, d.genres, d.imageKey, d.provider, d.link, d.terms, d.chosenBy]);
}

export async function forgetSongDetails(acct: string, artist: string, title: string): Promise<boolean> {
  const r = await query(`DELETE FROM song_details WHERE account_id = $1 AND norm_key = $2 RETURNING 1`, [acct, normKey(artist, title)]);
  return r.length > 0;
}

/** As a match, so the same field filling applies. */
export const detailsToMatch = (d: SongDetails): MusicMatch => ({
  state: 'hit', provider: d.provider, artist: d.artist, title: d.title, album: d.album, released: d.released, label: d.label, isrc: d.isrc,
  genres: d.genres, link: d.link, confidence: 100, reason: `Chosen by ${d.chosenBy ?? 'someone'}`,
});
