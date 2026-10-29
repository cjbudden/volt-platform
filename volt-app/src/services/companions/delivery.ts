// ============================================================================
//  CAPTION TRACKS IN THE MANIFESTS (docs/COMPANION_FILES.md section 4).
//
//  An asset's caption files become subtitle tracks when a player asks for its
//  playlists, the same way skip markers are written in (server.ts /clips
//  playlist route): nothing is re-packaged, a new or corrected file reaches
//  viewers at once, and removing one takes it out.
//
//    HLS   the master gains #EXT-X-MEDIA:TYPE=SUBTITLES per track and every
//          variant SUBTITLES="volt-subs"; each track is a one-segment media
//          playlist (subs/<id>.m3u8) over one WebVTT (subs/<id>.vtt).
//    DASH  each Period gains an AdaptationSet contentType="text" with the
//          WebVTT as its BaseURL (subs/<id>.dash.vtt: the same cues without
//          the HLS timestamp map, which DASH players do not use).
//
//  THE ONE CLOCK (CAPTIONS.md). Cue times are asset media time. HLS places
//  WebVTT against the video by X-TIMESTAMP-MAP, so the map's MPEGTS is read
//  from the delivered media itself: the tfdt of the first segment of the first
//  variant, at its track's timescale. An encode starts near 0; a clip copied
//  from a live recording starts wherever the live timeline was, and without
//  the map its captions would be minutes or hours out.
// ============================================================================

export interface Track { id: string; language: string | null; label: string; isDefault: boolean; forced: boolean; sdh: boolean }

export const SUBS_GROUP = 'volt-subs';
const q = (s: string) => s.replace(/"/g, '\'').replace(/[\r\n]+/g, ' ');

/** The master with the asset's subtitle tracks. Media playlists and no tracks: unchanged. Idempotent. */
export function withHlsSubtitles(master: string, tracks: Track[]): string {
  if (!tracks.length || !/#EXT-X-STREAM-INF:/.test(master)) return master;
  const lines = master.split('\n').filter((l) => !(l.startsWith('#EXT-X-MEDIA:') && l.includes(`GROUP-ID="${SUBS_GROUP}"`)));
  const media = tracks.map((t) => [
    '#EXT-X-MEDIA:TYPE=SUBTITLES', `GROUP-ID="${SUBS_GROUP}"`, `NAME="${q(t.label)}"`,
    ...(t.language ? [`LANGUAGE="${q(t.language)}"`] : []),
    `DEFAULT=${t.isDefault ? 'YES' : 'NO'}`, `AUTOSELECT=${t.isDefault || !t.forced ? 'YES' : 'NO'}`, `FORCED=${t.forced ? 'YES' : 'NO'}`,
    ...(t.sdh ? ['CHARACTERISTICS="public.accessibility.transcribes-spoken-dialog,public.accessibility.describes-music-and-sound"'] : []),
    `URI="subs/${t.id}.m3u8"`,
  ].join(','));
  const first = lines.findIndex((l) => l.startsWith('#EXT-X-STREAM-INF:'));
  const out = [...lines.slice(0, first), ...media, ...lines.slice(first)].map((l) => {
    if (!l.startsWith('#EXT-X-STREAM-INF:')) return l;
    const clean = l.replace(/,SUBTITLES="[^"]*"/, '');
    return `${clean},SUBTITLES="${SUBS_GROUP}"`;
  });
  return out.join('\n');
}

/** One subtitle track as an HLS media playlist: the whole WebVTT as one segment. */
export function subtitlePlaylist(id: string, durationMs: number): string {
  const secs = Math.max(1, durationMs / 1000);
  return ['#EXTM3U', '#EXT-X-VERSION:3', `#EXT-X-TARGETDURATION:${Math.ceil(secs)}`, '#EXT-X-MEDIA-SEQUENCE:0', '#EXT-X-PLAYLIST-TYPE:VOD',
    `#EXTINF:${secs.toFixed(3)},`, `${id}.vtt`, '#EXT-X-ENDLIST', ''].join('\n');
}

/** X-TIMESTAMP-MAP for cue 00:00:00.000 = the first delivered segment's decode time. */
export function timestampMap(tfdt: bigint, timescale: number): string {
  const ts = (tfdt * 90_000n) / BigInt(Math.max(1, timescale));
  return `X-TIMESTAMP-MAP=MPEGTS:${(ts % (2n ** 33n)).toString()},LOCAL:00:00:00.000`;
}

const xmlAttr = (v: string) => String(v).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const MARK = 'volt-subs-';

/** Each Period with a text AdaptationSet per track (WebVTT side-loaded). Idempotent. */
export function withDashSubtitles(mpd: string, tracks: Track[], baseUrl: string): string {
  const clean = mpd.replace(new RegExp(`<AdaptationSet[^>]*id="${MARK}[^"]*"[\\s\\S]*?</AdaptationSet>`, 'g'), '');
  if (!tracks.length) return clean;
  const base = !baseUrl ? '' : baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
  const sets = tracks.map((t, i) => [
    `<AdaptationSet contentType="text" mimeType="text/vtt" id="${MARK}${i}"${t.language ? ` lang="${xmlAttr(t.language)}"` : ''}>`,
    `<Role schemeIdUri="urn:mpeg:dash:role:2011" value="${t.forced ? 'forced-subtitle' : t.sdh ? 'caption' : 'subtitle'}"/>`,
    ...(t.isDefault ? ['<Role schemeIdUri="urn:mpeg:dash:role:2011" value="main"/>'] : []),
    `<Label>${xmlAttr(t.label)}</Label>`,
    `<Representation id="${MARK}${t.id}" bandwidth="256"><BaseURL>${xmlAttr(`${base}subs/${t.id}.dash.vtt`)}</BaseURL></Representation>`,
    '</AdaptationSet>',
  ].join(''));
  return clean.replace(/<\/Period>/g, `${sets.join('')}</Period>`);
}

// ---------------------------------------------------------------- reading the segment clock

/** Walk ISO-BMFF boxes looking for `type`, descending into the containers that matter. */
function find(buf: Buffer, type: string, from = 0, to = buf.length): Buffer | null {
  let p = from;
  while (p + 8 <= to) {
    let size = buf.readUInt32BE(p);
    const t = buf.toString('ascii', p + 4, p + 8);
    let head = 8;
    if (size === 1 && p + 16 <= to) { size = Number(buf.readBigUInt64BE(p + 8)); head = 16; }
    if (size === 0) size = to - p;
    if (size < head || p + size > to) return null;
    if (t === type) return buf.subarray(p + head, p + size);
    if (['moof', 'traf', 'moov', 'trak', 'mdia'].includes(t)) { const r = find(buf, type, p + head, p + size); if (r) return r; }
    p += size;
  }
  return null;
}

/** baseMediaDecodeTime of a CMAF segment's first track fragment. */
export function readTfdt(seg: Buffer): bigint | null {
  const b = find(seg, 'tfdt');
  if (!b || b.length < 8) return null;
  return b[0] === 1 && b.length >= 12 ? b.readBigUInt64BE(4) : BigInt(b.readUInt32BE(4));
}

/** The first track's timescale from an init segment's mdhd. */
export function readTimescale(init: Buffer): number | null {
  const b = find(init, 'mdhd');
  if (!b || b.length < 24) return null;
  return b[0] === 1 ? (b.length >= 24 ? b.readUInt32BE(20) : null) : b.readUInt32BE(12);
}
