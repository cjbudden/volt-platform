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

/**
 * Where a variant's I-frame playlist lives: beside its media playlist, named
 * after it (v720/index.m3u8 -> v720/index.iframes.m3u8). Named after the
 * variant, not a fixed iframes.m3u8 in its folder: Shaka Packager writes every
 * media playlist beside the master (stream_0.m3u8, stream_1.m3u8), so a fixed
 * name gave every rendition the same address and players got the first one
 * for all of them (found by 3.2b-2 on a real encode).
 */
export function iframeUriFor(variantUri: string): string {
  return /\.m3u8$/i.test(variantUri) ? variantUri.replace(/\.m3u8$/i, '.iframes.m3u8') : `${variantUri}.iframes.m3u8`;
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

// ============================================================================
//  DASH TRICK-MODE (build queue 3.2b-2).
//
//  DASH has no byte-range I-frame playlist: a trick-mode track is an
//  AdaptationSet marked with EssentialProperty
//  http://dashif.org/guidelines/trickmode whose segments a player appends to
//  its decoder like any other. The HLS range (moof + mdat header + keyframe)
//  is not such a segment: its moof still lists every sample of the fragment
//  and its mdat says it is longer than it is, so a DASH player waits for the
//  rest. So each trick segment is made when asked for, from that same range:
//  a new moof that lists the keyframe alone, timed to last until the next one,
//  and an mdat holding exactly its bytes. A few dozen bytes of header are
//  rewritten; the picture is the stored one, nothing is decoded, re-encoded or
//  stored (the cost rule: no new media for a switch most viewers never use).
//
//  Encrypted (CENC) renditions keep their encryption: the keyframe's entry in
//  senc is carried, with saiz and saio pointing at it, and the moof's pssh
//  boxes copied, so the same keys decrypt it. A track that uses sample groups
//  (sbgp, key rotation) gets no DASH trick-mode set (its HLS I-frames are
//  unaffected): carrying the group mapping is not built.
// ============================================================================

/**
 * default_Per_Sample_IV_Size from the init's tenc box, 0 for a constant IV
 * (cbcs), or null when the track is not encrypted. Throws nothing.
 */
export function initIvSize(init: Buffer): number | null {
  let at = init.indexOf('tenc', 0, 'latin1');
  while (at >= 4) {
    const start = at - 4;
    const size = init.readUInt32BE(start);
    if (size >= 32 && start + size <= init.length) return init[start + 8 + 7];
    at = init.indexOf('tenc', at + 4, 'latin1');
  }
  return /encv|enca/.test(init.toString('latin1')) ? -1 : null;
}

function box(type: string, ...parts: Buffer[]): Buffer {
  const body = Buffer.concat(parts);
  const h = Buffer.alloc(8);
  h.writeUInt32BE(8 + body.length, 0);
  h.write(type, 4, 'latin1');
  return Buffer.concat([h, body]);
}
const u32 = (n: number) => { const b = Buffer.alloc(4); b.writeUInt32BE(n >>> 0, 0); return b; };
const i32 = (n: number) => { const b = Buffer.alloc(4); b.writeInt32BE(n | 0, 0); return b; };
const u64 = (n: number) => { const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(Math.max(0, Math.round(n))), 0); return b; };
const full = (version: number, flags: number) => u32(((version & 0xff) << 24) | (flags & 0xffffff));

/**
 * One trick segment: the keyframe that opens the fragment at the start of
 * `range` (an HLS I-frame byte range: moof, mdat header, keyframe sample) as a
 * fragment of its own, lasting `durTicks`. Null when the range is not that
 * (no moof first, the track missing, sample groups, an encrypted track whose
 * IV size is unknown).
 */
export function keyframeFragment(range: Buffer, trackId: number, durTicks: number, ivSize: number | null): Buffer | null {
  const moof = boxes(range, 0, range.length).next().value as Box | undefined;
  if (!moof || moof.type !== 'moof') return null;
  let mfhd: Buffer | null = null;
  const pssh: Buffer[] = [];
  let traf: Box | null = null;
  for (const x of boxes(range, moof.body, moof.end)) {
    if (x.type === 'mfhd') mfhd = range.subarray(x.start, x.end);
    else if (x.type === 'pssh') pssh.push(range.subarray(x.start, x.end));
    else if (x.type === 'traf') {
      const tfhd = child(range, x, 'tfhd');
      if (tfhd && range.readUInt32BE(tfhd.body + 4) === trackId) traf = x;
    }
  }
  if (!traf) return null;
  if (child(range, traf, 'sbgp')) return null;
  const tfhd = child(range, traf, 'tfhd')!;
  const tf = range.readUInt32BE(tfhd.body) & 0xffffff;
  let q = tfhd.body + 8;
  if (tf & 0x01) q += 8;
  if (tf & 0x02) q += 4;
  if (tf & 0x08) q += 4;
  let defSize = 0;
  if (tf & 0x10) defSize = range.readUInt32BE(q);
  const tfdt = child(range, traf, 'tfdt');
  const decode = !tfdt ? 0 : range[tfdt.body] === 1 ? Number(range.readBigUInt64BE(tfdt.body + 4)) : range.readUInt32BE(tfdt.body + 4);
  const trun = child(range, traf, 'trun');
  if (!trun) return null;
  const ver = range[trun.body];
  const fl = range.readUInt32BE(trun.body) & 0xffffff;
  if (range.readUInt32BE(trun.body + 4) < 1) return null;
  let p = trun.body + 8;
  if (fl & 0x01) p += 4;
  if (fl & 0x04) p += 4;
  let size = defSize, cto = 0;
  if (fl & 0x100) p += 4;
  if (fl & 0x200) { size = range.readUInt32BE(p); p += 4; }
  if (fl & 0x400) p += 4;
  if (fl & 0x800) cto = ver === 1 ? range.readInt32BE(p) : range.readUInt32BE(p);
  if (!(size > 0) || size > range.length) return null;
  const sample = range.subarray(range.length - size);

  // The keyframe's encryption entry, when the track is encrypted.
  let enc: { flags: number; entry: Buffer } | null = null;
  const senc = child(range, traf, 'senc');
  if (senc) {
    if (ivSize == null || ivSize < 0) return null;
    const sflags = range.readUInt32BE(senc.body) & 0xffffff;
    if (range.readUInt32BE(senc.body + 4) < 1) return null;
    let e = senc.body + 8 + ivSize;
    if (sflags & 0x2) e += 2 + range.readUInt16BE(e) * 6;
    if (e > senc.end) return null;
    enc = { flags: sflags, entry: range.subarray(senc.body + 8, e) };
  } else if (ivSize != null) return null;        // encrypted track, no senc in the moof: not a layout we know

  const build = (dataOffset: number, saioOffset: number) => {
    const tfhdN = box('tfhd', full(0, 0x020000), u32(trackId));
    const tfdtN = box('tfdt', full(1, 0), u64(decode));
    const trunN = box('trun', full(1, 0x000f01), u32(1), i32(dataOffset), u32(Math.max(1, Math.round(durTicks))), u32(size), u32(0x02000000), i32(cto));
    const encBoxes = enc ? [
      box('saiz', full(0, 0), Buffer.from([enc.entry.length]), u32(1)),
      box('saio', full(0, 0), u32(1), u32(saioOffset)),
      box('senc', full(0, enc.flags & 0x2), u32(1), enc.entry),
    ] : [];
    const trafN = box('traf', tfhdN, tfdtN, trunN, ...encBoxes);
    return box('moof', mfhd ?? box('mfhd', full(0, 0), u32(1)), ...pssh, trafN);
  };
  // Sizes do not depend on the offsets, so build once to measure, then again.
  const probe = build(0, 0);
  const sencEntryAt = enc ? probe.length - (enc.entry.length) : 0;
  const moofN = build(probe.length + 8, sencEntryAt);
  return Buffer.concat([moofN, box('mdat', sample)]);
}

/** One trick segment of a rendition: its source range and its time. */
export interface DashTrickEntry {
  /** The media segment, relative to the master's folder. */
  uri: string;
  start: number;
  end: number;
  /** Presentation time and duration, in the track's timescale. */
  pts: number;
  dur: number;
}

export interface DashTrick {
  /** The rendition's init segment, relative to the master's folder: how its MPD Representation is found. */
  init: string;
  timescale: number;
  trackId: number;
  ivSize: number | null;
  /** Short and stable: the trick segments' folder, trick/<key>/<n>.m4s. */
  key: string;
  entries: DashTrickEntry[];
}

/** Each keyframe's time and length, the last one lasting to the end of the media. */
export function dashEntries(segments: { uri: string; durSec: number; keyframes: Keyframe[] }[], timescale: number): DashTrickEntry[] {
  const all: { uri: string; k: Keyframe }[] = [];
  for (const s of segments) for (const k of s.keyframes) all.push({ uri: s.uri, k });
  if (!all.length) return [];
  const endTicks = all[0].k.pts + Math.round(segments.reduce((a, s) => a + s.durSec, 0) * timescale);
  return all.map((x, i) => ({
    uri: x.uri, start: x.k.start, end: x.k.end, pts: x.k.pts,
    dur: Math.max(1, (i + 1 < all.length ? all[i + 1].k.pts : endTicks) - x.k.pts),
  }));
}

const attr = (tag: string, name: string) => new RegExp(`\\s${name}="([^"]*)"`).exec(tag)?.[1] ?? null;
const esc = (v: string) => v.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

function segmentTimeline(entries: DashTrickEntry[], scale: number): string {
  const out: string[] = [];
  let i = 0;
  while (i < entries.length) {
    const t = Math.round(entries[i].pts * scale), d = Math.round(entries[i].dur * scale);
    let r = 0;
    while (i + r + 1 < entries.length && Math.round(entries[i + r + 1].dur * scale) === d
      && Math.round(entries[i + r + 1].pts * scale) === t + (r + 1) * d) r++;
    out.push(`<S t="${t}" d="${d}"${r ? ` r="${r}"` : ''}/>`);
    i += r + 1;
  }
  return out.join('');
}

const PROTECTION = /<ContentProtection\b[^>]*\/>|<ContentProtection\b[^>]*>[\s\S]*?<\/ContentProtection>/g;

/**
 * The MPD with a trick-mode AdaptationSet after each video AdaptationSet that
 * has a rendition in `tricks` (matched by the init segment its
 * SegmentTemplate names, relative to the MPD's folder, which is the master's).
 * Left as it is when it already has trick-mode sets, has more than one Period
 * (a stitched ad MPD) or names a BaseURL (paths would not resolve the same way).
 */
export function withDashTrickMode(mpd: string, tricks: DashTrick[], bandwidthOf: (t: DashTrick) => number): string {
  if (!tricks.length || /dashif\.org\/guidelines\/trickmode/.test(mpd)) return mpd;
  if ((mpd.match(/<Period\b/g) ?? []).length !== 1 || /<BaseURL\b/.test(mpd)) return mpd;
  const byInit = new Map(tricks.map((t) => [t.init.replace(/^\.\//, ''), t]));
  const ids = [...mpd.matchAll(/<AdaptationSet\b[^>]*\sid="(\d+)"/g)].map((m) => Number(m[1]));
  let nextId = (ids.length ? Math.max(...ids) : 0) + 1;
  let added = 0;
  const out = mpd.replace(/<AdaptationSet\b[^>]*>[\s\S]*?<\/AdaptationSet>/g, (as) => {
    const open = /^<AdaptationSet\b[^>]*>/.exec(as)![0];
    const isVideo = attr(open, 'contentType') === 'video' || /^video\//.test(attr(open, 'mimeType') ?? '')
      || /<Representation\b[^>]*mimeType="video\//.test(as);
    if (!isVideo) return as;
    const mainId = attr(open, 'id');
    if (mainId == null) return as;
    const head = as.slice(0, as.search(/<Representation\b/) >= 0 ? as.search(/<Representation\b/) : as.length);
    const asTemplate = /<SegmentTemplate\b[^>]*>/.exec(head)?.[0] ?? null;
    const reps: string[] = [];
    for (const m of as.matchAll(/<Representation\b[^>]*?(?:\/>|>[\s\S]*?<\/Representation>)/g)) {
      const rep = m[0];
      const ropen = /^<Representation\b[^>]*>/.exec(rep)![0];
      const tpl = /<SegmentTemplate\b[^>]*>/.exec(rep)?.[0] ?? asTemplate;
      // $RepresentationID$ and $Bandwidth$ resolved for the main
      // Representation (ffmpeg's DASH muxer writes them); the trick one names
      // the resolved file, since its own id is different.
      const init = tpl ? (attr(tpl, 'initialization') ?? '')
        .replace(/\$RepresentationID\$/g, attr(ropen, 'id') ?? '').replace(/\$Bandwidth\$/g, attr(ropen, 'bandwidth') ?? '') : null;
      if (!tpl || !init || /\$/.test(init)) continue;
      const t = byInit.get(init.replace(/^\.\//, ''));
      if (!t || !t.entries.length) continue;
      const tplScale = Number(attr(tpl, 'timescale') ?? '1') || 1;
      const pto = Number(attr(tpl, 'presentationTimeOffset') ?? '0') || 0;
      // The trick timeline is in the track's own timescale; the main one's
      // offset is carried over into it.
      const ptoT = Math.round((pto * t.timescale) / tplScale);
      const fr = attr(ropen, 'frameRate') ?? attr(open, 'frameRate');
      const fps = fr ? (fr.includes('/') ? Number(fr.split('/')[0]) / Number(fr.split('/')[1]) : Number(fr)) : 25;
      const avgDur = t.entries.reduce((a, e) => a + e.dur, 0) / t.entries.length / t.timescale;
      // One picture shown per keyframe interval: played at the normal picture
      // rate, the track runs this many times faster than real time.
      const maxRate = Math.max(1, Math.round(avgDur * (fps > 0 ? fps : 25)));
      const keep = ['codecs', 'width', 'height', 'sar', 'mimeType'].map((n) => [n, attr(ropen, n) ?? attr(open, n)] as const).filter(([, v]) => v != null);
      if (!keep.some(([n]) => n === 'mimeType')) keep.push(['mimeType', 'video/mp4']);
      const repProt = (rep.match(PROTECTION) ?? []).join('');
      reps.push(`<Representation id="trick-${esc(attr(ropen, 'id') ?? t.key)}" bandwidth="${Math.max(1, bandwidthOf(t))}" ${keep.map(([n, v]) => `${n}="${esc(v!)}"`).join(' ')} maxPlayoutRate="${maxRate}" codingDependency="false">`
        + repProt
        + `<SegmentTemplate timescale="${t.timescale}" presentationTimeOffset="${ptoT}" initialization="${esc(init)}" media="trick/${t.key}/$Number$.m4s" startNumber="1">`
        + `<SegmentTimeline>${segmentTimeline(t.entries, 1)}</SegmentTimeline></SegmentTemplate></Representation>`);
    }
    if (!reps.length) return as;
    added++;
    const asProt = (head.match(PROTECTION) ?? []).join('');
    const trick = `\n    <AdaptationSet id="${nextId++}" contentType="video" segmentAlignment="true" startWithSAP="1">`
      + `<EssentialProperty schemeIdUri="http://dashif.org/guidelines/trickmode" value="${esc(mainId)}"/>`
      + asProt + reps.join('') + '</AdaptationSet>';
    return as + trick;
  });
  return added ? out : mpd;
}
