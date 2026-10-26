// ============================================================================
//  ON-DEMAND AD PLAYLISTS: stitched and guided, from the asset's own HLS.
//
//  STITCHED (SSAI). One playlist per viewer session and rendition: the asset's
//  segments with each break's pod in between, a DISCONTINUITY on either side
//  (the ad has its own init segment and timestamps). Every URL is absolute, so
//  the session playlist served by the API plays segments straight from the CDN.
//  Ad segments go through the session's segment route instead
//  (/vod-ads/s/<session>/seg/...), which redirects to the CDN and is how the
//  server knows how far into each ad the viewer got (the beacons): the API
//  sees a few requests per ad, never the content's.
//
//  GUIDED (SGAI, HLS Interstitials). One playlist per asset, shared and
//  cacheable: the asset's own segments plus an EXT-X-DATERANGE per break of
//  CLASS "com.apple.hls.interstitial" whose X-ASSET-LIST the player asks when
//  it gets there (Safari, AVPlayer on Apple TV, iOS). Interstitials hang on
//  PROGRAM-DATE-TIME, which an on-demand asset does not have, so the playlist
//  carries one from a fixed epoch: only differences of it mean anything.
//  X-RESTRICT="SKIP,JUMP" asks the player not to skip an ad or seek inside it.
//
//  I-frame playlists are dropped from a stitched master: they would show the
//  content's frames where the session plays ads.
//
//  ENCRYPTED CONTENT, CLEAR ADS. An EXT-X-KEY applies to every segment after
//  it until the next one, so a pod written after encrypted content would be
//  read as encrypted. The stitch closes the key (METHOD=NONE) before a pod and
//  states the content's key again where the content resumes: the key changes
//  at the discontinuity, never inside a part.
//
//  PURE: text in, text out. test/vod-ads.check.ts.
// ============================================================================

export const INTERSTITIAL_CLASS = 'com.apple.hls.interstitial';
/** The fixed PROGRAM-DATE-TIME origin of a guided on-demand playlist. */
export const GUIDED_EPOCH_MS = Date.UTC(2000, 0, 1);

/** Resolve a playlist URI against the playlist's own URL. Path-only stays path-only. */
export function absUrl(base: string, rel: string): string {
  if (/^https?:\/\//i.test(rel)) return rel;
  if (/^https?:\/\//i.test(base)) return new URL(rel, base).toString();
  const u = new URL(rel, `http://p.invalid${base.startsWith('/') ? '' : '/'}${base}`);
  return u.pathname + u.search;
}

export interface MasterEntry {
  /** 'video' for a variant (STREAM-INF), 'audio' / 'subtitles' for an EXT-X-MEDIA rendition. */
  kind: 'video' | 'audio' | 'subtitles';
  /** Absolute URL of the media playlist. */
  url: string;
  /** Video height, for matching an ad's rendition. */
  height: number;
  /** A short stable name per rendition: v<height>, audio, audio2..., subs... */
  track: string;
  /** What a DASH writer needs (dash.ts): the rendition's codec, bandwidth, width, language. */
  codecs?: string;
  bandwidth?: number;
  width?: number;
  lang?: string;
}

/** The audio codecs in a CODECS list; everything else in it is video. */
const AUDIO_CODEC = /^(mp4a|ac-3|ec-3|opus|flac|alac|mp3)/i;
export const splitCodecs = (list: string) => {
  const parts = list.split(',').map((x) => x.trim()).filter(Boolean);
  return { video: parts.filter((x) => !AUDIO_CODEC.test(x)).join(','), audio: parts.filter((x) => AUDIO_CODEC.test(x)).join(',') };
};

/** The media playlists a master names, in order, with a track name each. */
export function masterEntries(text: string, masterUrl: string): MasterEntry[] {
  const lines = text.split(/\r?\n/).map((l) => l.trim());
  const out: MasterEntry[] = [];
  const used = new Set<string>();
  const name = (base: string) => { let n = base, i = 2; while (used.has(n)) n = `${base}-${i++}`; used.add(n); return n; };
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (l.startsWith('#EXT-X-MEDIA:')) {
      const uri = l.match(/URI="([^"]+)"/)?.[1];
      const type = l.match(/TYPE=([A-Z-]+)/)?.[1];
      if (!uri || (type !== 'AUDIO' && type !== 'SUBTITLES')) continue;
      const lang = l.match(/LANGUAGE="([^"]+)"/)?.[1];
      const group = l.match(/GROUP-ID="([^"]+)"/)?.[1];
      // An audio rendition's codec is in the CODECS of the variants that use its group.
      const variant = type === 'AUDIO' && group ? lines.find((x) => x.startsWith('#EXT-X-STREAM-INF:') && x.includes(`AUDIO="${group}"`)) : undefined;
      const codecs = variant ? splitCodecs(variant.match(/CODECS="([^"]+)"/)?.[1] ?? '').audio : '';
      out.push({ kind: type === 'AUDIO' ? 'audio' : 'subtitles', url: absUrl(masterUrl, uri), height: 0, track: name(type === 'AUDIO' ? 'audio' : 'subs'),
        ...(codecs ? { codecs } : {}), ...(lang ? { lang } : {}) });
    } else if (l.startsWith('#EXT-X-STREAM-INF:')) {
      const uri = lines.slice(i + 1).find((x) => x && !x.startsWith('#'));
      if (!uri) continue;
      const res = l.match(/RESOLUTION=(\d+)x(\d+)/);
      const h = Number(res?.[2] ?? 0);
      const codecs = splitCodecs(l.match(/CODECS="([^"]+)"/)?.[1] ?? '').video;
      const bw = Number(l.match(/[:,]BANDWIDTH=(\d+)/)?.[1] ?? 0);
      out.push({ kind: 'video', url: absUrl(masterUrl, uri), height: h, track: name(`v${h}`),
        ...(codecs ? { codecs } : {}), ...(bw ? { bandwidth: bw } : {}), ...(res ? { width: Number(res[1]) } : {}) });
    }
  }
  return out;
}

/**
 * The master with each media playlist pointed at `urlFor(entry)` (a session
 * or guided playlist) and I-frame playlists left out.
 */
export function rewriteMaster(text: string, masterUrl: string, urlFor: (e: MasterEntry) => string): string {
  const entries = masterEntries(text, masterUrl);
  const byUrl = new Map(entries.map((e) => [e.url, e]));
  const lines = text.split(/\r?\n/);
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i].trim();
    if (l.startsWith('#EXT-X-I-FRAME-STREAM-INF')) continue;
    if (l.startsWith('#EXT-X-MEDIA:') && /URI="/.test(l)) {
      out.push(l.replace(/URI="([^"]+)"/, (w, u) => { const e = byUrl.get(absUrl(masterUrl, u)); return e ? `URI="${urlFor(e)}"` : `URI="${absUrl(masterUrl, u)}"`; }));
      continue;
    }
    if (l && !l.startsWith('#')) {
      const e = byUrl.get(absUrl(masterUrl, l));
      out.push(e ? urlFor(e) : absUrl(masterUrl, l));
      continue;
    }
    if (l) out.push(l);
  }
  return out.join('\n') + '\n';
}

export interface Segment {
  dur: number;
  url: string;
  /** Init segment (EXT-X-MAP) URL, '' for a TS stream. */
  init: string;
  /** Tags that must stay with the segment (BYTERANGE, KEY). */
  tags: string[];
}

export interface Media { version: number; segments: Segment[] }

/** A VOD media playlist, every URL absolute. Null when it is not one. */
export function parseMedia(text: string, url: string): Media | null {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (lines[0] !== '#EXTM3U') return null;
  let version = 3, init = '', dur: number | null = null;
  let tags: string[] = [];
  const segments: Segment[] = [];
  for (const l of lines.slice(1)) {
    if (l.startsWith('#EXT-X-VERSION:')) { version = Number(l.split(':')[1]) || 3; continue; }
    if (l.startsWith('#EXT-X-MAP:')) {
      const u = l.match(/URI="([^"]+)"/)?.[1];
      init = u ? absUrl(url, u) : '';
      continue;
    }
    if (l.startsWith('#EXTINF:')) { dur = Number(l.slice(8).split(',')[0]); continue; }
    if (l.startsWith('#EXT-X-BYTERANGE') || l.startsWith('#EXT-X-KEY')) {
      tags.push(l.replace(/URI="([^"]+)"/, (w, u) => `URI="${absUrl(url, u)}"`));
      continue;
    }
    if (l.startsWith('#')) continue;
    if (dur == null) return null;
    segments.push({ dur, url: absUrl(url, l), init, tags });
    dur = null; tags = [];
  }
  return { version, segments };
}

/** Segment start times (content time), 0 first. */
export function boundariesOf(m: Media): number[] {
  const out: number[] = [];
  let t = 0;
  for (const s of m.segments) { out.push(Math.round(t * 1000) / 1000); t += s.dur; }
  return out;
}

export const durationOf = (m: Media) => m.segments.reduce((n, s) => n + s.dur, 0);

export interface StitchBreak { index: number; atSec: number; segments: Segment[] }

interface WriteState { map: string; /** the EXT-X-KEY lines in force as written */ keys: string[] }

const isKey = (t: string) => t.startsWith('#EXT-X-KEY');
/** The keys a segment's own KEY lines put in force (METHOD=NONE clears them). */
const keysAfter = (prev: string[], tags: string[]) => {
  const k = tags.filter(isKey);
  if (!k.length) return prev;
  return k.every((x) => /METHOD=NONE/.test(x)) ? [] : k.filter((x) => !/METHOD=NONE/.test(x));
};

function writeSeg(lines: string[], s: Segment, state: WriteState, disc: boolean, want?: string[]) {
  if (disc) lines.push('#EXT-X-DISCONTINUITY');
  // `want`: the keys this segment must play under when it states none of its own
  // (the content's after a pod, none for an ad after encrypted content). Before
  // the MAP: an init segment is read under the key in force.
  if (want && !s.tags.some(isKey) && want.join('\n') !== state.keys.join('\n')) {
    if (want.length) lines.push(...want); else lines.push('#EXT-X-KEY:METHOD=NONE');
    state.keys = want;
  }
  const own = s.tags.filter(isKey);
  if (own.length) { lines.push(...own); state.keys = keysAfter(state.keys, s.tags); }
  if (s.init && (s.init !== state.map || disc)) { lines.push(`#EXT-X-MAP:URI="${s.init}"`); state.map = s.init; }
  for (const t of s.tags) if (!isKey(t)) lines.push(t);
  lines.push(`#EXTINF:${s.dur.toFixed(3)},`);
  lines.push(s.url);
}

/**
 * The stitched playlist for one rendition: content with each break's pod
 * before the first content segment at or after the break's moment.
 */
export function stitchMedia(content: Media, breaks: StitchBreak[]): string {
  const all = [...content.segments, ...breaks.flatMap((b) => b.segments)];
  const target = Math.max(1, ...all.map((s) => Math.ceil(s.dur)));
  const lines = ['#EXTM3U', `#EXT-X-VERSION:${Math.max(6, content.version)}`, `#EXT-X-TARGETDURATION:${target}`, '#EXT-X-MEDIA-SEQUENCE:0', '#EXT-X-PLAYLIST-TYPE:VOD'];
  const state: WriteState = { map: '', keys: [] };
  const pending = [...breaks].sort((a, b) => a.atSec - b.atSec || a.index - b.index);
  let t = 0, afterPod = false, first = true;
  // The content's own keys, as its playlist has them in force at each segment.
  let contentKeys: string[] = [];
  // An ad keeps the keys its own playlist gives it (none for a clear ad).
  let adKeys: string[] = [];
  const pod = (b: StitchBreak) => {
    b.segments.forEach((s, k) => {
      const disc = !first && (k === 0 || s.init !== b.segments[k - 1].init);
      if (k === 0 || disc) adKeys = [];
      adKeys = keysAfter(adKeys, s.tags);
      writeSeg(lines, s, state, disc, adKeys);
      first = false;
    });
    afterPod = b.segments.length > 0;
  };
  for (const s of content.segments) {
    while (pending.length && pending[0].atSec <= t + 0.01) pod(pending.shift()!);
    contentKeys = keysAfter(contentKeys, s.tags);
    writeSeg(lines, s, state, afterPod, contentKeys);
    afterPod = false; first = false;
    t += s.dur;
  }
  while (pending.length) pod(pending.shift()!);
  lines.push('#EXT-X-ENDLIST');
  return lines.join('\n') + '\n';
}

export interface GuidedBreak { index: number; atSec: number; durationSec: number; position: 'pre' | 'mid' | 'post' }

const iso = (ms: number) => new Date(ms).toISOString();

/** The guided (interstitial) playlist for one rendition: content plus a DATERANGE per break. */
export function guidedMedia(content: Media, breaks: GuidedBreak[], listUrl: (b: GuidedBreak) => string): string {
  const target = Math.max(1, ...content.segments.map((s) => Math.ceil(s.dur)));
  const lines = ['#EXTM3U', `#EXT-X-VERSION:${Math.max(6, content.version)}`, `#EXT-X-TARGETDURATION:${target}`, '#EXT-X-MEDIA-SEQUENCE:0', '#EXT-X-PLAYLIST-TYPE:VOD'];
  const total = durationOf(content);
  for (const b of breaks) {
    const at = b.position === 'post' ? total : b.atSec;
    const attrs = [`ID="ad-${b.index}"`, `CLASS="${INTERSTITIAL_CLASS}"`, `START-DATE="${iso(GUIDED_EPOCH_MS + Math.round(at * 1000))}"`,
      `DURATION=${b.durationSec.toFixed(3)}`, `X-ASSET-LIST="${listUrl(b)}"`, 'X-RESUME-OFFSET=0', 'X-RESTRICT="SKIP,JUMP"'];
    // CUE is the playlist attribute (RFC 8216bis DATERANGE), not a client X- one:
    // Shaka and hls.js read CUE, so a post-roll named X-CUE played at the end only by luck.
    // A mid-roll is ONCE: a break already watched is not played again on a seek
    // back (SSAI.md 5.4), and a player that resumes the content exactly at the
    // break's moment (Shaka in one video element) does not start it over.
    attrs.push(b.position === 'pre' ? 'CUE="PRE"' : b.position === 'post' ? 'CUE="POST"' : 'CUE="ONCE"');
    lines.push(`#EXT-X-DATERANGE:${attrs.join(',')}`);
  }
  const state: WriteState = { map: '', keys: [] };
  content.segments.forEach((s, i) => {
    if (i === 0) lines.push(`#EXT-X-PROGRAM-DATE-TIME:${iso(GUIDED_EPOCH_MS)}`);
    writeSeg(lines, s, state, false);
  });
  lines.push('#EXT-X-ENDLIST');
  return lines.join('\n') + '\n';
}

/** The rendition of an ad that matches a content track: same kind, nearest height. */
export function matchEntry(adEntries: MasterEntry[], want: MasterEntry): MasterEntry | null {
  const same = adEntries.filter((e) => e.kind === want.kind);
  if (!same.length) return null;
  if (want.kind !== 'video') return same[0];
  return [...same].sort((a, b) => Math.abs(a.height - want.height) - Math.abs(b.height - want.height))[0];
}
