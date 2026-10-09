// ============================================================================
//  TIMED IN-STREAM METADATA — VIDEO DELIVERY. Not the radio metadata path.
//
//  SCOPE, because these two were being read as one thing. This carries programme
//  boundaries and ad windows in the DELIVERY stream, for a player to act on:
//  `EXT-X-DATERANGE` in HLS, `EventStream`/`emsg` in DASH, SCTE-35 for
//  signalling. A radio station's now-playing is a different concern on the other
//  side of the pipeline — it arrives as ICY on INGEST and is already handled by
//  `services/radio/icyMeta.ts` and `services/radio/nowPlaying.ts`. The one real
//  overlap is ID3-in-`emsg` on an HLS audio rendition, which is what would carry
//  an Icecast title to an HLS listener; that is its own build with its own
//  acceptance test, so this one is never judged by it.
//
//  THE PLAYLIST IS WRITTEN ON READ, not by the encoder. The schedule lives in
//  Postgres and changes after the segment was written: a programme gets renamed,
//  an override lands, an ad break moves. Baking tags into the file at encode time
//  would freeze a decision that is still being made, and would put the EPG on the
//  encoder's side of a boundary it has no business crossing. The encoder keeps
//  writing plain playlists; the control plane, which already serves and rewrites
//  them, adds what the schedule says at the moment of the request.
//
//  ONLY WHAT THE WINDOW COVERS. A live playlist holds a rolling handful of
//  segments; a 24/7 channel has thousands of programmes. Tags are emitted for the
//  programmes that overlap THIS playlist's time span, so the response stays a few
//  hundred bytes rather than growing all day.
//
//  SPEC (RFC 8216 §4.3.2.7, and the 8216bis drafts): ID and START-DATE are
//  required; CLASS is a client-defined string and SHOULD use reverse-DNS to avoid
//  collisions; client attributes MUST carry an `X-` prefix and be a
//  quoted-string, hexadecimal-sequence or decimal-floating-point. Everything
//  here is one of those three, and quotes inside a title are stripped rather than
//  escaped, because the grammar has no escape sequence for them.
// ============================================================================

/** A scheduled programme, as the EPG holds it. */
export interface ProgrammeWindow {
  id: string;
  title: string;
  startsAt: Date;
  /** Null for an open-ended strand: emitted without an END-DATE. */
  endsAt: Date | null;
  /** 'content' | 'ad' | anything the EPG uses. Drives CLASS. */
  kind?: string | null;
}

/** Reverse-DNS, per the spec's advice, so a CLASS cannot collide with anyone. */
export const CLASS_PROGRAMME = 'com.boomlabs.volt.programme';
export const CLASS_AD = 'com.boomlabs.volt.ad';

/**
 * A quoted-string the HLS grammar will accept.
 *
 * The attribute grammar has NO escape for a double quote inside a quoted-string,
 * so a title containing one cannot be represented and must not be emitted as-is:
 * doing that terminates the attribute early and produces a playlist that some
 * players reject outright and others silently mis-parse. Stripped, along with the
 * line breaks that would end the tag.
 */
export function quoted(v: string): string {
  return '"' + String(v ?? '').replace(/["\r\n]/g, '').trim() + '"';
}

/** ISO-8601 with milliseconds, which is what START-DATE expects. */
const iso = (d: Date) => d.toISOString();

/**
 * One `EXT-X-DATERANGE` for one programme.
 *
 * DURATION is emitted rather than END-DATE for a closed programme because a
 * player that is mid-window can act on a duration without re-deriving it, and
 * both are permitted. An open-ended strand gets neither: inventing a duration
 * for a programme nobody has ended would be asserting an end time the schedule
 * does not know.
 */
export function dateRangeTag(p: ProgrammeWindow): string {
  const isAd = String(p.kind ?? '').toLowerCase() === 'ad';
  const attrs: string[] = [
    `ID=${quoted(p.id)}`,
    `CLASS=${quoted(isAd ? CLASS_AD : CLASS_PROGRAMME)}`,
    `START-DATE=${quoted(iso(p.startsAt))}`,
  ];
  if (p.endsAt) {
    const secs = (p.endsAt.getTime() - p.startsAt.getTime()) / 1000;
    // A negative or zero span is a data fault upstream, not something to encode.
    if (secs > 0) attrs.push(`DURATION=${secs.toFixed(3)}`);
  }
  // CLIENT ATTRIBUTES MUST CARRY THE X- PREFIX. A bare TITLE= would be a
  // reserved-namespace collision waiting for the spec to define one.
  attrs.push(`X-TITLE=${quoted(p.title)}`);
  if (p.kind) attrs.push(`X-KIND=${quoted(p.kind)}`);
  return `#EXT-X-DATERANGE:${attrs.join(',')}`;
}

/**
 * The time span a media playlist actually covers.
 *
 * Read from the first `EXT-X-PROGRAM-DATE-TIME` plus the sum of the `EXTINF`
 * durations, because that is the only wall-clock anchor a media playlist carries.
 * Returns null when there is no PDT, and the caller then emits nothing: guessing
 * a window from `now()` would attach tags to segments that are not in it.
 */
export function playlistWindow(playlist: string): { from: Date; to: Date } | null {
  const lines = playlist.split(/\r?\n/);
  const pdtLine = lines.find((l) => l.startsWith('#EXT-X-PROGRAM-DATE-TIME:'));
  if (!pdtLine) return null;
  const from = new Date(pdtLine.slice('#EXT-X-PROGRAM-DATE-TIME:'.length).trim());
  if (Number.isNaN(from.getTime())) return null;
  let secs = 0;
  for (const l of lines) {
    const m = /^#EXTINF:([\d.]+)/.exec(l);
    if (m) secs += parseFloat(m[1]) || 0;
  }
  return { from, to: new Date(from.getTime() + secs * 1000) };
}

/** The programmes that overlap a window, in start order. */
export function overlapping(programmes: ProgrammeWindow[], from: Date, to: Date): ProgrammeWindow[] {
  return programmes
    .filter((p) => {
      const end = p.endsAt ? p.endsAt.getTime() : Number.POSITIVE_INFINITY;
      // Half-open on both sides: a programme that ends exactly when the window
      // opens is not in it, and neither is one that starts exactly as it closes.
      return end > from.getTime() && p.startsAt.getTime() < to.getTime();
    })
    .sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime());
}

/**
 * Insert tags into a media playlist, before the first segment.
 *
 * DATERANGE is a Media Playlist tag and its position is not load-bearing, but it
 * has to land in the HEADER: a tag written after an `#EXTINF` is inside a segment
 * declaration, which is a parse error rather than a stylistic preference.
 *
 * IDEMPOTENT. The same playlist passed twice does not accumulate tags, because
 * the control plane may serve the same file repeatedly and a player refetches a
 * live playlist every few seconds. Existing DATERANGE lines are dropped and
 * replaced, so a renamed programme corrects itself on the next fetch rather than
 * appearing twice under one ID.
 */
export function injectDateRanges(playlist: string, tags: string[]): string {
  const lines = playlist.split(/\r?\n/).filter((l) => !l.startsWith('#EXT-X-DATERANGE:'));
  if (!tags.length) return lines.join('\n');
  // The first segment declaration is the boundary; everything before it is header.
  let at = lines.findIndex((l) => l.startsWith('#EXTINF:'));
  if (at < 0) at = lines.length;
  // A PROGRAM-DATE-TIME immediately preceding the first EXTINF belongs to that
  // segment, so tags go above it rather than between it and its segment.
  while (at > 0 && lines[at - 1].startsWith('#EXT-X-PROGRAM-DATE-TIME:')) at--;
  return [...lines.slice(0, at), ...tags, ...lines.slice(at)].join('\n');
}

/** The whole job: given a playlist and the schedule, return the playlist to serve. */
export function annotatePlaylist(playlist: string, programmes: ProgrammeWindow[]): string {
  const win = playlistWindow(playlist);
  if (!win) return playlist;
  const tags = overlapping(programmes, win.from, win.to).map(dateRangeTag);
  return injectDateRanges(playlist, tags);
}

/**
 * The schedule covering a window, for one channel.
 *
 * The database import is LAZY on purpose: everything above this line is pure and
 * is tested without a database or a connection string, and a top-level import of
 * `../db` would drag one in for a module whose whole job is string manipulation.
 * Same pattern `audit.ts` uses to reach the status hub.
 *
 * ICY-SOURCED ROWS ARE EXCLUDED. `programmes` holds two different things: a
 * schedule somebody entered, and a LOG of now-playing titles the radio capture
 * wrote. Emitting the second as delivery metadata would put a per-track history
 * into a video manifest, which is both wrong and unbounded.
 */
export async function scheduleFor(channelId: string, from: Date, to: Date): Promise<ProgrammeWindow[]> {
  try {
    const { query } = await import('../db');
    const rows = await query<any>(
      `SELECT id, title, starts_at, ends_at, metadata
         FROM programmes
        WHERE channel_id = $1
          AND COALESCE(metadata->>'source','') <> 'icy'
          AND starts_at < $3::timestamptz
          AND (ends_at IS NULL OR ends_at > $2::timestamptz)
        ORDER BY starts_at
        LIMIT 50`,
      [channelId, from.toISOString(), to.toISOString()]
    );
    return rows.map((r) => ({
      id: String(r.id),
      title: String(r.title ?? ''),
      startsAt: new Date(r.starts_at),
      endsAt: r.ends_at ? new Date(r.ends_at) : null,
      kind: r.metadata?.kind ?? r.metadata?.class ?? 'content',
    }));
  } catch {
    // A schedule we cannot read is a playlist served WITHOUT tags, never a
    // playlist not served. Metadata is an enhancement; playback is the product.
    return [];
  }
}
