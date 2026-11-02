// ============================================================================
//  FRAMES FROM THE FRAGMENT BOXES (build queue 3.2 (a)).
//
//  Every segment Volt writes is CMAF: an init.mp4 with the track's timescale
//  and one or more moof+mdat fragments. The moof already lists every sample
//  (frame) in the fragment, its duration and its composition offset, so the
//  frame count and the presentation time of each frame can be read from a few
//  kilobytes of box headers, without starting ffprobe or decoding anything.
//  That is what keeps a frame index cheap enough to make for every asset (a
//  ffprobe per segment is about 40 ms; this is well under 1 ms).
//
//  Only the boxes needed are read: moov/trak (tkhd, mdia/mdhd, mdia/hdlr),
//  moov/mvex/trex for defaults, and moof/traf (tfhd, tfdt, trun). Pure: takes
//  buffers, returns numbers.
// ============================================================================

export interface InitFacts {
  /** Track id of the video track (the first track when none says 'vide'). */
  trackId: number;
  timescale: number;
  /** trex default sample duration, used when neither tfhd nor trun gives one. */
  defaultDuration: number;
  isVideo: boolean;
}

export interface FragmentFacts {
  /** tfdt of the first fragment of the track, in timescale ticks. */
  baseDecodeTime: number;
  /** Presentation times of every sample, in ticks, in presentation order. */
  pts: number[];
  /** Duration of each sample in decode order, in ticks. */
  durations: number[];
  /** True when the first sample in decode order is a sync sample (keyframe). */
  startsWithSync: boolean;
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

function child(b: Buffer, parent: Box, type: string): Box | null {
  for (const x of boxes(b, parent.body, parent.end)) if (x.type === type) return x;
  return null;
}

/** Facts of the video track from an init segment, or null when it holds no moov. */
export function readInit(b: Buffer): InitFacts | null {
  const moov = [...boxes(b, 0, b.length)].find((x) => x.type === 'moov');
  if (!moov) return null;
  const tracks: { id: number; timescale: number; video: boolean }[] = [];
  for (const trak of boxes(b, moov.body, moov.end)) {
    if (trak.type !== 'trak') continue;
    const tkhd = child(b, trak, 'tkhd');
    const mdia = child(b, trak, 'mdia');
    if (!tkhd || !mdia) continue;
    const v = b[tkhd.body];
    const id = b.readUInt32BE(tkhd.body + (v === 1 ? 20 : 12));
    const mdhd = child(b, mdia, 'mdhd');
    const hdlr = child(b, mdia, 'hdlr');
    if (!mdhd) continue;
    const mv = b[mdhd.body];
    const timescale = b.readUInt32BE(mdhd.body + (mv === 1 ? 20 : 12));
    const handler = hdlr ? b.toString('latin1', hdlr.body + 8, hdlr.body + 12) : '';
    tracks.push({ id, timescale, video: handler === 'vide' });
  }
  const t = tracks.find((x) => x.video) ?? tracks[0];
  if (!t) return null;
  let defaultDuration = 0;
  const mvex = child(b, moov, 'mvex');
  if (mvex) {
    for (const trex of boxes(b, mvex.body, mvex.end)) {
      if (trex.type === 'trex' && b.readUInt32BE(trex.body + 4) === t.id) defaultDuration = b.readUInt32BE(trex.body + 12);
    }
  }
  return { trackId: t.id, timescale: t.timescale, defaultDuration, isVideo: t.video };
}

/**
 * Samples of one track across every fragment in a media segment. Returns null
 * when the segment has no fragment for the track (not CMAF, or another track).
 */
export function readFragments(b: Buffer, init: InitFacts): FragmentFacts | null {
  let base: number | null = null;
  const pts: number[] = [];
  const durations: number[] = [];
  let startsWithSync: boolean | null = null;
  let nextDecode: number | null = null;
  for (const moof of boxes(b, 0, b.length)) {
    if (moof.type !== 'moof') continue;
    for (const traf of boxes(b, moof.body, moof.end)) {
      if (traf.type !== 'traf') continue;
      const tfhd = child(b, traf, 'tfhd');
      if (!tfhd) continue;
      const tf = b.readUInt32BE(tfhd.body) & 0xffffff;
      if (b.readUInt32BE(tfhd.body + 4) !== init.trackId) continue;
      let q = tfhd.body + 8;
      if (tf & 0x01) q += 8;                         // base data offset
      if (tf & 0x02) q += 4;                         // sample description index
      let defDur = init.defaultDuration;
      if (tf & 0x08) { defDur = b.readUInt32BE(q); q += 4; }
      if (tf & 0x10) q += 4;                         // default sample size
      let defFlags: number | null = null;
      if (tf & 0x20) defFlags = b.readUInt32BE(q);
      const tfdt = child(b, traf, 'tfdt');
      let decode: number;
      if (tfdt) {
        const v = b[tfdt.body];
        decode = v === 1 ? Number(b.readBigUInt64BE(tfdt.body + 4)) : b.readUInt32BE(tfdt.body + 4);
      } else decode = nextDecode ?? 0;
      if (base == null) base = decode;
      for (const trun of boxes(b, traf.body, traf.end)) {
        if (trun.type !== 'trun') continue;
        const ver = b[trun.body];
        const fl = b.readUInt32BE(trun.body) & 0xffffff;
        const count = b.readUInt32BE(trun.body + 4);
        let p = trun.body + 8;
        if (fl & 0x01) p += 4;                       // data offset
        let firstFlags: number | null = null;
        if (fl & 0x04) { firstFlags = b.readUInt32BE(p); p += 4; }
        for (let i = 0; i < count; i++) {
          let dur = defDur, flags = defFlags, cto = 0;
          if (fl & 0x100) { dur = b.readUInt32BE(p); p += 4; }
          if (fl & 0x200) p += 4;
          if (fl & 0x400) { flags = b.readUInt32BE(p); p += 4; }
          if (fl & 0x800) { cto = ver === 1 ? b.readInt32BE(p) : b.readUInt32BE(p); p += 4; }
          if (i === 0 && firstFlags != null) flags = firstFlags;
          if (startsWithSync == null) startsWithSync = flags == null ? true : ((flags >>> 16) & 0x1) === 0;
          pts.push(decode + cto);
          durations.push(dur);
          decode += dur;
        }
      }
      nextDecode = decode;
    }
  }
  if (base == null || !pts.length) return null;
  pts.sort((x, y) => x - y);
  return { baseDecodeTime: base, pts, durations, startsWithSync: startsWithSync ?? true };
}
