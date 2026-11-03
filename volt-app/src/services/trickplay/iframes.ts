// ============================================================================
//  I-FRAME PLAYLISTS FROM THE SEGMENTS WE ALREADY HAVE (build queue 3.2b).
//
//  Apple's players (AVPlayer on iOS, iPadOS, tvOS, Safari) and many smart-TV
//  players scrub and fast-forward with an I-frame playlist: one entry per
//  keyframe, each a byte range of a media segment. Volt's segments are CMAF,
//  and the moof of each fragment already lists every sample with its size and
//  flags, so the byte range of each keyframe can be read from the box headers.
//  Nothing is re-encoded and no new media is written: the playlist points into
//  the segments players already get.
//
//  A range runs from the start of the fragment's moof to the end of the
//  keyframe's sample in the mdat (Apple's rule for fMP4 I-frame playlists: the
//  player needs the moof to find the sample). Keys (EXT-X-KEY) and the init
//  segment (EXT-X-MAP) are carried over from the media playlist in order, so
//  an encrypted asset's I-frames decrypt the same way its segments do.
//
//  PURE: buffers and text in, text out. test/trickplay.check.ts.
// ============================================================================
import type { InitFacts } from '../frames/fmp4';

export interface Keyframe {
  /** Presentation time, in the track's timescale ticks. */
  pts: number;
  /** Byte offset of the fragment's moof in the segment. */
  start: number;
  /** One past the last byte of the keyframe's sample. */
  end: number;
}

interface Box { type: string; start: number; body: number; end: number }

function* boxes(b: Buffer, from: number, to: number): Generator<Box> {
  let p = from;
  while (p + 8 <= to) {
    let size = b.readUInt32BE(p);
    const type = b.toString('latin1', p + 4, p + 8);
    let body = p + 8;
    if (size === 1) {
      if (p + 16 > to) return;
      size = Number(b.readBigUInt64BE(p + 8));
      body = p + 16;
    } else if (size === 0) size = to - p;
    if (size < 8 || p + size > to) return;
    yield { type, start: p, body, end: p + size };
    p += size;
  }
}

const child = (b: Buffer, parent: Box, type: string) => {
  for (const x of boxes(b, parent.body, parent.end)) if (x.type === type) return x;
  return null;
};

/**
 * Every keyframe of the video track in one CMAF media segment that opens a
 * fragment, with the byte range an I-frame playlist entry needs. Empty when the segment holds no
 * fragment of the track.
 */
export function keyframeRanges(b: Buffer, init: InitFacts): Keyframe[] {
  const out: Keyframe[] = [];
  let nextDecode = 0;
  for (const moof of boxes(b, 0, b.length)) {
    if (moof.type !== 'moof') continue;
    for (const traf of boxes(b, moof.body, moof.end)) {
      if (traf.type !== 'traf') continue;
      const tfhd = child(b, traf, 'tfhd');
      if (!tfhd || b.readUInt32BE(tfhd.body + 4) !== init.trackId) continue;
      const tf = b.readUInt32BE(tfhd.body) & 0xffffff;
      let q = tfhd.body + 8;
      // Where sample data offsets count from: an explicit base, else the moof
      // (default-base-is-moof, which CMAF requires, and the ISO rule for the
      // first traf when neither flag is set).
      let base = moof.start;
      if (tf & 0x01) { base = Number(b.readBigUInt64BE(q)); q += 8; }
      if (tf & 0x02) q += 4;
      let defDur = init.defaultDuration;
      if (tf & 0x08) { defDur = b.readUInt32BE(q); q += 4; }
      let defSize = 0;
      if (tf & 0x10) { defSize = b.readUInt32BE(q); q += 4; }
      let defFlags: number | null = null;
      if (tf & 0x20) defFlags = b.readUInt32BE(q);
      const tfdt = child(b, traf, 'tfdt');
      let decode = nextDecode;
      if (tfdt) decode = b[tfdt.body] === 1 ? Number(b.readBigUInt64BE(tfdt.body + 4)) : b.readUInt32BE(tfdt.body + 4);
      let dataPos = base;
      let first = true;
      for (const trun of boxes(b, traf.body, traf.end)) {
        if (trun.type !== 'trun') continue;
        const ver = b[trun.body];
        const fl = b.readUInt32BE(trun.body) & 0xffffff;
        const count = b.readUInt32BE(trun.body + 4);
        let p = trun.body + 8;
        if (fl & 0x01) { dataPos = base + b.readInt32BE(p); p += 4; }
        let firstFlags: number | null = null;
        if (fl & 0x04) { firstFlags = b.readUInt32BE(p); p += 4; }
        for (let i = 0; i < count; i++) {
          let dur = defDur, size = defSize, flags = defFlags, cto = 0;
          if (fl & 0x100) { dur = b.readUInt32BE(p); p += 4; }
          if (fl & 0x200) { size = b.readUInt32BE(p); p += 4; }
          if (fl & 0x400) { flags = b.readUInt32BE(p); p += 4; }
          if (fl & 0x800) { cto = ver === 1 ? b.readInt32BE(p) : b.readUInt32BE(p); p += 4; }
          if (i === 0 && firstFlags != null) flags = firstFlags;
          // sample_is_non_sync_sample is bit 16 of the flags; no flags at all
          // means every sample is a sync sample (an intra-only track).
          const sync = flags == null ? true : ((flags >>> 16) & 0x1) === 0;
          // ONLY A KEYFRAME THAT OPENS ITS FRAGMENT. A range always starts at
          // the moof, so for a keyframe later in the same fragment it would
          // hold the fragment's earlier pictures too, and which one a player
          // shows is not defined. A segment with a 2 s GOP in one 4 s fragment
          // therefore lists one I-frame, not two: coarser, never wrong.
          if (sync && first && size > 0 && dataPos + size <= b.length) out.push({ pts: decode + cto, start: moof.start, end: dataPos + size });
          first = false;
          dataPos += size;
          decode += dur;
        }
      }
      nextDecode = decode;
    }
  }
  return out;
}

/**
 * The segments of a media playlist, each with the EXT-X-KEY and EXT-X-MAP
 * lines in force for it (they apply from where they are written on).
 */
export function mediaSegments(text: string): { uri: string; durSec: number; key: string | null; map: string | null }[] {
  const out: { uri: string; durSec: number; key: string | null; map: string | null }[] = [];
  let key: string | null = null, map: string | null = null, dur: number | null = null;
  for (const raw of text.split(/\r?\n/)) {
    const l = raw.trim();
    if (!l) continue;
    if (l.startsWith('#EXT-X-KEY:')) { key = /METHOD=NONE/.test(l) ? null : l; continue; }
    if (l.startsWith('#EXT-X-MAP:')) { map = l; continue; }
    if (l.startsWith('#EXTINF:')) { dur = parseFloat(l.slice(8)); continue; }
    if (l.startsWith('#')) continue;
    if (dur != null) { out.push({ uri: l, durSec: dur, key, map }); dur = null; }
  }
  return out;
}

export interface IframePlaylist {
  text: string;
  /** Peak bits per second over one entry, for BANDWIDTH. */
  bandwidth: number;
  /** Bits per second over the whole playlist, for AVERAGE-BANDWIDTH. */
  averageBandwidth: number;
  entries: number;
}

/**
 * The I-frame playlist for one rendition. `segments` are the media playlist's
 * segments in order, each with its keyframes; times come from the keyframes'
 * own presentation times, so an entry lasts until the next keyframe (the last
 * one until the end of the media).
 */
export function buildIframePlaylist(segments: { uri: string; durSec: number; key: string | null; map: string | null; keyframes: Keyframe[] }[], timescale: number): IframePlaylist | null {
  const all: { uri: string; key: string | null; map: string | null; k: Keyframe }[] = [];
  for (const s of segments) for (const k of s.keyframes) all.push({ uri: s.uri, key: s.key, map: s.map, k });
  if (!all.length || !(timescale > 0)) return null;
  const firstPts = all[0].k.pts;
  const totalSec = segments.reduce((a, s) => a + s.durSec, 0);
  const durs = all.map((x, i) => {
    const endSec = i + 1 < all.length ? (all[i + 1].k.pts - firstPts) / timescale : totalSec;
    return Math.max(0.001, endSec - (x.k.pts - firstPts) / timescale);
  });
  const target = Math.max(1, Math.ceil(Math.max(...durs) - 1e-9));
  const lines = ['#EXTM3U', '#EXT-X-VERSION:7', `#EXT-X-TARGETDURATION:${target}`, '#EXT-X-MEDIA-SEQUENCE:0', '#EXT-X-PLAYLIST-TYPE:VOD', '#EXT-X-I-FRAMES-ONLY'];
  let key: string | null = null, map: string | null = null;
  let peak = 0, bytes = 0;
  all.forEach((x, i) => {
    if (x.map !== map && x.map) { lines.push(x.map); map = x.map; }
    if (x.key !== key) { lines.push(x.key ?? '#EXT-X-KEY:METHOD=NONE'); key = x.key; }
    const len = x.k.end - x.k.start;
    lines.push(`#EXTINF:${durs[i].toFixed(5)},`, `#EXT-X-BYTERANGE:${len}@${x.k.start}`, x.uri);
    peak = Math.max(peak, (len * 8) / durs[i]);
    bytes += len;
  });
  lines.push('#EXT-X-ENDLIST', '');
  return { text: lines.join('\n'), bandwidth: Math.ceil(peak), averageBandwidth: Math.ceil((bytes * 8) / Math.max(0.001, totalSec)), entries: all.length };
}

export interface VideoVariant { uri: string; resolution: string | null; codecs: string | null }

/** The video variants of a master: every STREAM-INF that is not audio only. */
export function videoVariants(master: string): VideoVariant[] {
  const out: VideoVariant[] = [];
  const lines = master.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i].trim();
    if (!l.startsWith('#EXT-X-STREAM-INF:')) continue;
    const uri = (lines.slice(i + 1).find((x) => x.trim() && !x.trim().startsWith('#')) ?? '').trim();
    if (!uri) continue;
    const res = /RESOLUTION=(\d+x\d+)/.exec(l)?.[1] ?? null;
    const codecs = /CODECS="([^"]*)"/.exec(l)?.[1] ?? null;
    const audioOnly = !res && !!codecs && codecs.split(',').every((c) => /^(mp4a|ac-3|ec-3|opus|flac)/i.test(c.trim()));
    if (audioOnly) continue;
    out.push({ uri, resolution: res, codecs });
  }
  return out;
}

/** Where a variant's I-frame playlist lives, beside its media playlist. */
export function iframeUriFor(variantUri: string): string {
  const i = variantUri.lastIndexOf('/');
  return (i >= 0 ? variantUri.slice(0, i + 1) : '') + 'iframes.m3u8';
}

export interface IframeStream { variantUri: string; bandwidth: number; averageBandwidth: number; resolution: string | null; codecs: string | null }

/**
 * The master with an EXT-X-I-FRAME-STREAM-INF per built rendition, written
 * after the last STREAM-INF's URI. Any I-frame lines already there are left
 * alone (a master that came with its own).
 */
export function withIframeStreams(master: string, streams: IframeStream[]): string {
  if (!streams.length || /#EXT-X-I-FRAME-STREAM-INF/.test(master)) return master;
  const add = streams.map((s) => {
    const attrs = [`BANDWIDTH=${s.bandwidth}`, `AVERAGE-BANDWIDTH=${s.averageBandwidth}`];
    // Video codecs only: an I-frame playlist carries no audio.
    const video = (s.codecs ?? '').split(',').map((c) => c.trim()).filter((c) => c && !/^(mp4a|ac-3|ec-3|opus|flac)/i.test(c));
    if (video.length) attrs.push(`CODECS="${video.join(',')}"`);
    if (s.resolution) attrs.push(`RESOLUTION=${s.resolution}`);
    attrs.push(`URI="${iframeUriFor(s.variantUri)}"`);
    return `#EXT-X-I-FRAME-STREAM-INF:${attrs.join(',')}`;
  });
  const body = master.replace(/\s+$/, '');
  return `${body}\n${add.join('\n')}\n`;
}
