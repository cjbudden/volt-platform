// ============================================================================
//  FROM AN ICY STRING TO AN ALBUM COVER.
//
//  A station gives us one line of text — "Fleetwood Mac - Dreams" — and the
//  player wants an artist, a title, an album and a picture.
//
//  ------------------------------------------------------------------------
//  WHY MUSICBRAINZ AND THE COVER ART ARCHIVE, AND NOT THE OBVIOUS ONES.
//
//  MusicBrainz is open data with no key, no account and no display terms, and
//  the Cover Art Archive that backs it states outright that it applies no rate
//  limiting. Nothing here can be revoked, re-priced, or made conditional on
//  showing a store badge.
//
//  The iTunes Search API is easier and better-covered, and was rejected on
//  purpose: Apple's terms require the artwork to sit beside an iTunes badge
//  linking to the store and to serve a promotional purpose, which is not what
//  a radio station's skin is. Building on it would put every customer's player
//  in breach by default. Spotify and Last.fm need credentials, which turns a
//  platform feature into a per-deployment signup.
//
//  The cost of that choice is honest and worth stating: coverage is strong for
//  released albums and weaker for brand-new singles, station idents and local
//  repertoire. That is exactly why the fallback path below is not an
//  afterthought.
//
//  ------------------------------------------------------------------------
//  ONE REQUEST PER SECOND, ENFORCED HERE, ONCE, FOR THE WHOLE PROCESS.
//
//  MusicBrainz permits one call per second per application and enforces it by
//  blocking the IP. That is a shared fate: exceed it for one tenant and every
//  tenant's artwork stops. So the limiter is a single process-wide queue, not
//  a per-request delay, and every caller goes through it.
//
//  It also means the lookup CANNOT be in the request path of a player asking
//  what is playing. A hundred players polling a station would each want a
//  turn in a one-per-second queue. The player reads the cache; the cache is
//  filled in the background by the station's own metadata log.
//
//  ------------------------------------------------------------------------
//  A MISS IS A RESULT AND IS REMEMBERED.
//
//  The failure that would quietly eat the entire rate-limit budget: a track
//  MusicBrainz has never heard of, retried on every poll for the twenty
//  minutes it is on air, never succeeding and never stopping. `miss` is cached
//  as firmly as a hit. Only a transient `error` is retried, and then slowly.
// ============================================================================
import { query, one } from '../../db';
import { config } from '../../config';

export interface TrackMeta {
  artist: string | null;
  title: string | null;
  album: string | null;
  artworkUrl: string | null;
  year: number | null;
  provider: string | null;
  /** hit | miss | error | unparsed — the player decides its fallback from this. */
  state: 'hit' | 'miss' | 'error' | 'unparsed';
}

export const NO_META: TrackMeta = {
  artist: null, title: null, album: null, artworkUrl: null,
  year: null, provider: null, state: 'unparsed',
};

// ---------------------------------------------------------------------------
//  Parsing
// ---------------------------------------------------------------------------

/**
 * Split an ICY StreamTitle into artist and title.
 *
 * Stations are not consistent and never will be, so this handles the shapes
 * that actually occur rather than a spec:
 *
 *   "Artist - Title"                the overwhelming majority
 *   "Artist -- Title"               some automation systems
 *   "Title by Artist"               WFMU and others
 *   "Artist - Title (Radio Edit)"   suffix stripped for the lookup key only
 *
 * Returns null when the string is not a track at all — a station ident, a
 * programme name, an empty break. Guessing an artist out of "NPO Radio 1 - De
 * Ochtend" would spend a rate-limit slot on a lookup that cannot succeed, and
 * would put a wrong album cover on screen if it accidentally did.
 */
export function parseIcyTitle(raw: string | null | undefined): { artist: string; title: string } | null {
  const s = String(raw ?? '').trim();
  if (!s) return null;
  // A bare title with no separator is not enough to search on.
  const dash = s.match(/^(.{1,120}?)\s+-{1,2}\s+(.{1,160})$/);
  if (dash) {
    const artist = dash[1].trim();
    const title = dash[2].trim();
    if (artist && title) return { artist, title };
  }
  const by = s.match(/^["“](.{1,160}?)["”]\s+by\s+(.{1,120}?)(?:\s+on\s+.+)?$/i);
  if (by) return { artist: by[2].trim(), title: by[1].trim() };
  return null;
}

/**
 * The cache key.
 *
 * Normalisation is what makes the cache actually hit. The same song reaches us
 * as "Fleetwood Mac - Dreams", "FLEETWOOD MAC - DREAMS (2004 Remaster)" and
 * "Fleetwood Mac  -  Dreams" from three stations, and three misses for one
 * track is three times the rate-limit budget spent to learn the same fact.
 *
 * Bracketed suffixes go because they are the noisiest difference and almost
 * never change which recording is meant; "feat." is kept on the title but
 * dropped from the artist, matching how MusicBrainz credits collaborations.
 */
export function normKey(artist: string, title: string): string {
  const clean = (s: string) => s
    .toLowerCase()
    .replace(/\([^)]*\)|\[[^\]]*\]/g, ' ')      // (Radio Edit), [Live]
    .replace(/\s*-\s*(remaster(ed)?|single|radio edit|live)\b.*$/i, ' ')
    .replace(/[’']/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
  const a = clean(artist).replace(/\s+(feat|ft|featuring|with)\s.*$/, '').trim();
  return `${a}|${clean(title)}`;
}

// ---------------------------------------------------------------------------
//  The rate limiter
// ---------------------------------------------------------------------------

/**
 * A single serial queue with a minimum gap between calls.
 *
 * Process-wide and deliberately not per-tenant: the limit MusicBrainz enforces
 * is per IP, so tenants share one budget whether the code acknowledges it or
 * not. Pretending otherwise would mean the first busy tenant gets everybody
 * else blocked.
 */
class Gate {
  private chain: Promise<unknown> = Promise.resolve();
  private last = 0;
  constructor(private minGapMs: number) {}
  run<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.chain.then(async () => {
      const wait = this.minGapMs - (Date.now() - this.last);
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      this.last = Date.now();
      return fn();
    });
    // The chain must not break on a rejection, or one failed lookup stalls
    // every lookup after it for the life of the process.
    this.chain = next.catch(() => undefined);
    return next;
  }
}

const gate = new Gate(config.trackMeta.minGapMs);

/** Test seam: how many calls the gate has actually let through. */
let calls = 0;
export const __testing = {
  callCount: () => calls,
  resetCalls: () => { calls = 0; },
};

// ---------------------------------------------------------------------------
//  The provider
// ---------------------------------------------------------------------------

async function getJson(url: string, timeoutMs: number): Promise<any> {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: ac.signal,
      headers: {
        // REQUIRED by MusicBrainz, and required to be meaningful. A generic or
        // absent User-Agent is grounds for blocking, and the block lands on
        // the IP rather than the request.
        'User-Agent': config.trackMeta.userAgent,
        'Accept': 'application/json',
      },
    });
    if (res.status === 503 || res.status === 429) {
      throw Object.assign(new Error(`musicbrainz throttled (${res.status})`), { transient: true });
    }
    if (!res.ok) throw new Error(`musicbrainz ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(t);
  }
}

/**
 * Ask MusicBrainz for a recording, and take its release group.
 *
 * The RELEASE GROUP rather than the release is the right handle for artwork:
 * a release is one specific pressing in one country, and picking arbitrarily
 * among forty of them gives a different cover each time the same song plays.
 * The release group is the album as a person means it, and the Cover Art
 * Archive serves a front image for it directly.
 *
 * The query is fielded (`artist:` / `recording:`) rather than a bare string so
 * a title containing the word "and" does not match on the artist field and
 * return something unrelated with a confident-looking score.
 */
async function lookupMusicBrainz(artist: string, title: string): Promise<Partial<TrackMeta> & { state: 'hit' | 'miss' }> {
  const q = `artist:"${artist.replace(/"/g, '')}" AND recording:"${title.replace(/"/g, '')}"`;
  const url = `${config.trackMeta.musicbrainzBase}/recording?query=${encodeURIComponent(q)}&fmt=json&limit=5`;
  calls++;
  const json = await getJson(url, config.trackMeta.timeoutMs);
  const recs: any[] = json?.recordings ?? [];
  if (!recs.length) return { state: 'miss' };

  // A LOW SCORE IS A MISS, NOT A RESULT. MusicBrainz always returns its best
  // effort, so without a floor an unknown track silently acquires the cover of
  // whatever it half-matched, and a station shows the wrong album art with
  // complete confidence. Wrong art is worse than none.
  const best = recs.find((r) => Number(r.score ?? 0) >= config.trackMeta.minScore);
  if (!best) return { state: 'miss' };

  // Prefer an album over a single or compilation: it is what a listener
  // recognises, and compilations are where the covers get strange.
  const releases: any[] = best.releases ?? [];
  const pick = releases.find((r) => r['release-group']?.['primary-type'] === 'Album') ?? releases[0];
  const rgMbid: string | null = pick?.['release-group']?.id ?? null;
  const year = (() => {
    const d = pick?.date ?? best['first-release-date'];
    const m = /^(\d{4})/.exec(String(d ?? ''));
    return m ? Number(m[1]) : null;
  })();

  return {
    state: 'hit',
    artist: best['artist-credit']?.[0]?.name ?? artist,
    title: best.title ?? title,
    album: pick?.['release-group']?.title ?? pick?.title ?? null,
    year,
    provider: 'musicbrainz',
    // The Cover Art Archive redirects to the image; 500px is the size the
    // layouts actually render, so asking for it saves the client resizing a
    // 1200px file for a 96px slot on a phone.
    artworkUrl: rgMbid ? `${config.trackMeta.coverArtBase}/release-group/${rgMbid}/front-500` : null,
    ...(rgMbid ? { releaseGroupMbid: rgMbid } : {}),
    recordingMbid: best.id ?? null,
  } as any;
}

// ---------------------------------------------------------------------------
//  The cache
// ---------------------------------------------------------------------------

function rowToMeta(r: any): TrackMeta {
  return {
    artist: r.artist ?? null,
    title: r.title ?? null,
    album: r.album ?? null,
    artworkUrl: r.artwork_url ?? null,
    year: r.year ?? null,
    provider: r.provider ?? null,
    state: r.state,
  };
}

/** Cached answer only. Never makes a network call — safe in a request path. */
export async function cachedTrackMeta(raw: string | null | undefined): Promise<TrackMeta> {
  const parsed = parseIcyTitle(raw);
  if (!parsed) return NO_META;
  const row = await one<any>(`SELECT * FROM track_metadata WHERE norm_key=$1`, [normKey(parsed.artist, parsed.title)]);
  // Not looked up yet: report what we DID parse, so the player shows
  // "Artist — Title" immediately rather than the station fallback while the
  // background lookup runs. Text now beats artwork in a moment.
  if (!row) return { ...NO_META, artist: parsed.artist, title: parsed.title, state: 'miss' };
  return rowToMeta(row);
}

/** Should this key be looked up, or is the answer already settled? */
async function needsLookup(key: string): Promise<boolean> {
  const row = await one<any>(`SELECT state, looked_up_at, attempts FROM track_metadata WHERE norm_key=$1`, [key]);
  if (!row) return true;
  // A hit is permanent: the album a recording belongs to does not change.
  if (row.state === 'hit') return false;
  // A miss is permanent enough. Retrying it is the failure mode that eats the
  // whole rate-limit budget on tracks that will never resolve.
  if (row.state === 'miss') return false;
  // Only a transient error is retried, with a backoff, and only so many times.
  if (row.attempts >= config.trackMeta.maxErrorAttempts) return false;
  const age = Date.now() - new Date(row.looked_up_at).getTime();
  return age > config.trackMeta.errorRetryMs;
}

/**
 * Look a track up and cache the answer. Background use only.
 *
 * Returns the metadata, but the caller is expected to ignore it: the value of
 * this function is the row it leaves behind. Every failure is swallowed into
 * an `error` row rather than thrown, because nothing about a missing album
 * cover should be able to disturb a station that is on air.
 */
export async function ensureTrackMeta(raw: string | null | undefined): Promise<TrackMeta> {
  const parsed = parseIcyTitle(raw);
  if (!parsed) return NO_META;
  const key = normKey(parsed.artist, parsed.title);
  if (!(await needsLookup(key))) return cachedTrackMeta(raw);

  let result: any;
  try {
    result = await gate.run(() => lookupMusicBrainz(parsed.artist, parsed.title));
  } catch (e) {
    const transient = (e as any)?.transient === true || /abort|timeout|fetch/i.test(String(e));
    result = { state: transient ? 'error' : 'miss', provider: 'musicbrainz' };
    console.warn('[trackmeta] lookup failed for', key, String((e as any)?.message ?? e));
  }

  await query(
    `INSERT INTO track_metadata
       (norm_key, artist, title, album, release_group_mbid, recording_mbid,
        artwork_url, year, provider, state, attempts, looked_up_at, raw_sample)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,1, now(), $11)
     ON CONFLICT (norm_key) DO UPDATE SET
       artist = COALESCE(EXCLUDED.artist, track_metadata.artist),
       title  = COALESCE(EXCLUDED.title,  track_metadata.title),
       album  = COALESCE(EXCLUDED.album,  track_metadata.album),
       release_group_mbid = COALESCE(EXCLUDED.release_group_mbid, track_metadata.release_group_mbid),
       recording_mbid     = COALESCE(EXCLUDED.recording_mbid, track_metadata.recording_mbid),
       artwork_url = COALESCE(EXCLUDED.artwork_url, track_metadata.artwork_url),
       year        = COALESCE(EXCLUDED.year, track_metadata.year),
       provider    = EXCLUDED.provider,
       state       = EXCLUDED.state,
       -- Counts ATTEMPTS, not rows. A track that errors four times must reach
       -- the give-up threshold; resetting to 1 would retry it forever.
       attempts    = track_metadata.attempts + 1,
       looked_up_at = now(),
       raw_sample  = EXCLUDED.raw_sample`,
    [key, result.artist ?? parsed.artist, result.title ?? parsed.title, result.album ?? null,
     result.releaseGroupMbid ?? null, result.recordingMbid ?? null,
     result.artworkUrl ?? null, result.year ?? null, result.provider ?? 'musicbrainz',
     result.state, String(raw ?? '').slice(0, 300)]
  );
  return cachedTrackMeta(raw);
}

/**
 * What the player shows, with the fallback already applied.
 *
 * The fallback is the normal case, not the error case, and the ordering says
 * so: an unparsed title (a station ident, a news bulletin, a break) is not a
 * failure and must not render as an empty player. Station name and description
 * are always available, so the player always has something to say.
 */
export interface NowPlayingCard {
  /** The line the layout shows large. */
  primary: string;
  /** The line under it. */
  secondary: string | null;
  artworkUrl: string | null;
  /** Where each field came from, so the console can explain a blank cover. */
  source: 'track' | 'station';
  album: string | null;
  year: number | null;
}

export function buildCard(
  meta: TrackMeta,
  station: { name: string; description?: string | null; artworkUrl?: string | null },
): NowPlayingCard {
  const haveTrack = !!(meta.title && meta.artist);
  if (!haveTrack) {
    return {
      primary: station.name,
      secondary: station.description ?? null,
      artworkUrl: station.artworkUrl ?? null,
      source: 'station',
      album: null, year: null,
    };
  }
  return {
    primary: meta.title!,
    secondary: meta.artist!,
    // A track we know with no cover uploaded falls back to the station's own
    // image rather than an empty square. This is common: the Cover Art Archive
    // is contributed, so a real release can simply have no picture yet.
    artworkUrl: meta.artworkUrl ?? station.artworkUrl ?? null,
    source: 'track',
    album: meta.album ?? null,
    year: meta.year ?? null,
  };
}
