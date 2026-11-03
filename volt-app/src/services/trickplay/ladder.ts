// ============================================================================
//  DASH TRICK-MODE FOR FAST CHANNELS (build queue 3.2b-6 (a)).
//
//  A FAST channel's DASH is written by the playout (fast_playout.py) from the
//  library's packaged assets, and reaches viewers from the origin bucket and
//  the CDN without the API: so, as for live (3.2b-4), the trick track is made
//  of real files, not re-wrapped per request. Made ONCE PER PACKAGED ASSET,
//  not per airing: every channel and every airing of the asset shares them.
//
//  WHAT IS WRITTEN, beside the asset's (or its FAST ladder's) manifest.mpd:
//    trick/<rep>/seg_<n>.m4s  for one video rendition (the smallest at 360p or
//                             above, as for live: all a player shows while
//                             fast-forwarding), segment n's opening keyframe
//                             as a fragment of its own lasting the whole
//                             segment (iframes.ts keyframeFragment): the same
//                             numbers and timeline as the rendition, the same
//                             init segment. Nothing is decoded or re-encoded.
//    trick.json               what the playout needs to list it, written last,
//                             so its presence means every segment is there.
//  Cost: one small rendition's keyframes, stored once per asset.
//
//  Queued by the timeline (services/fast/store.ts timelineFor) for the assets
//  a channel with trick-play on is about to air; the playout picks trick.json
//  up within a minute and lists the track from then on.
// ============================================================================
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, posix, resolve, sep } from 'node:path';
import { config } from '../../config';
import { clipsPathOfMaster, readClipsFile } from '../companions/serve';
import { readInit } from '../frames/fmp4';
import { initIvSize, keyframeFragment, keyframeRanges } from './iframes';

export interface LadderTrickRep { id: string; height: number; width: number | null; codecs: string | null; timescale: number; init: string; media: string; startNumber: number; bandwidth: number; times: [number, number][] }

const attr = (tag: string, name: string) => new RegExp(`\\s${name}="([^"]*)"`).exec(tag)?.[1] ?? null;

/** The video Representations of a single-Period on-demand MPD, with their segment lists. Pure. */
export function videoReps(mpd: string): LadderTrickRep[] {
  const out: LadderTrickRep[] = [];
  for (const m of mpd.matchAll(/<AdaptationSet\b[^>]*>[\s\S]*?<\/AdaptationSet>/g)) {
    const as = m[0];
    const open = /^<AdaptationSet\b[^>]*>/.exec(as)![0];
    const repAt = as.search(/<Representation\b/);
    const head = repAt >= 0 ? as.slice(0, repAt) : as;
    const isVideo = attr(open, 'contentType') === 'video' || /^video\//.test(attr(open, 'mimeType') ?? '') || /<Representation\b[^>]*mimeType="video\//.test(as);
    if (!isVideo || /dashif\.org\/guidelines\/trickmode/.test(head)) continue;
    const asTpl = /<SegmentTemplate\b[^>]*?(?:\/>|>[\s\S]*?<\/SegmentTemplate>)/.exec(head)?.[0] ?? null;
    for (const r of as.matchAll(/<Representation\b[^>]*?(?:\/>|>[\s\S]*?<\/Representation>)/g)) {
      const ropen = /^<Representation\b[^>]*>/.exec(r[0])![0];
      const tpl = /<SegmentTemplate\b[^>]*?(?:\/>|>[\s\S]*?<\/SegmentTemplate>)/.exec(r[0])?.[0] ?? asTpl;
      if (!tpl) continue;
      const topen = /^<SegmentTemplate\b[^>]*>/.exec(tpl)![0];
      const id = attr(ropen, 'id') ?? '';
      const bw = attr(ropen, 'bandwidth') ?? '';
      const sub = (s: string) => s.replace(/\$RepresentationID\$/g, id).replace(/\$Bandwidth\$/g, bw);
      const init = attr(topen, 'initialization'), media = attr(topen, 'media');
      if (!init || !media || /\$Time\$/.test(media)) continue;
      const times: [number, number][] = [];
      let t = 0;
      for (const s of tpl.matchAll(/<S\b[^>]*\/>/g)) {
        const st = attr(s[0], 't');
        if (st != null) t = Number(st);
        const d = Number(attr(s[0], 'd'));
        for (let k = 0; k <= Number(attr(s[0], 'r') ?? '0'); k++) { times.push([t, d]); t += d; }
      }
      if (!times.length) continue;
      out.push({
        id, height: Number(attr(ropen, 'height') ?? attr(open, 'height') ?? 0), width: Number(attr(ropen, 'width') ?? attr(open, 'width') ?? 0) || null,
        codecs: attr(ropen, 'codecs') ?? attr(open, 'codecs'), timescale: Number(attr(topen, 'timescale') ?? '1') || 1,
        init: sub(init), media: sub(media), startNumber: Number(attr(topen, 'startNumber') ?? '1'), bandwidth: Number(bw) || 0, times,
      });
    }
  }
  return out;
}

/** The rendition the trick track is cut from: the smallest at 360p or above, else the largest there is. */
export function trickRep(reps: LadderTrickRep[]): LadderTrickRep | null {
  const up = reps.filter((r) => r.height >= 360).sort((a, b) => a.height - b.height);
  return up[0] ?? [...reps].sort((a, b) => b.height - a.height)[0] ?? null;
}

/** A segment's file name from a $Number$ template ($Number%05d$ too). */
export function segmentName(media: string, n: number): string {
  return media.replace(/\$Number(?:%0(\d+)d)?\$/g, (_m, w) => (w ? String(n).padStart(Number(w), '0') : String(n)));
}

export interface LadderTrick { version: 1; rep: string; height: number; media: string; bandwidth: number; segments: number; builtAt: string }

/** Where files of a library folder are written: this task's disk, and the bucket when the library lives there. */
export type Put = (rel: string, body: Buffer, contentType: string) => Promise<void>;

async function defaultPut(rel: string, body: Buffer, type: string): Promise<void> {
  const n = posix.normalize(`/${rel.replace(/^\/+/, '')}`);
  const root = resolve(config.clips.dir);
  const file = resolve(join(root, n));
  if (!file.startsWith(root + sep)) throw new Error(`refusing to write outside the clips folder: ${rel}`);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, body);
  const { vodStore } = await import('../fast/vodStore');
  if (vodStore() !== 's3' || !config.aws?.s3Bucket) return;
  const { S3Client, PutObjectCommand } = await import('@aws-sdk/client-s3');
  const c = new S3Client({ region: config.aws.region, endpoint: process.env.AWS_ENDPOINT_URL || undefined, forcePathStyle: process.env.S3_FORCE_PATH_STYLE === '1' });
  await c.send(new PutObjectCommand({
    Bucket: config.aws.s3Bucket, Key: n.slice(1), Body: body, ContentType: type,
    CacheControl: type === 'application/json' ? 'public, max-age=60' : 'public, max-age=31536000, immutable',
  }));
}

/**
 * Build the trick track of the packaged asset whose HLS master is `masterKey`
 * ('/clips/vod/<id>/...' or the bucket key 'vod/<id>/...'), unless trick.json
 * is already there. Throws with a reason when it cannot (no MPD, a segment that
 * does not open on a keyframe): the playout then simply lists no trick track.
 */
export async function buildLadderTrick(masterKey: string, opts: { force?: boolean; put?: Put } = {}): Promise<{ state: 'ready' | 'exists'; trick: LadderTrick }> {
  const masterRel = clipsPathOfMaster(masterKey);
  if (!masterRel) throw new Error(`not a library master: ${masterKey}`);
  const dir = posix.dirname(masterRel);
  const existing = opts.force ? null : await readClipsFile(posix.join(dir, 'trick.json'));
  if (existing) return { state: 'exists', trick: JSON.parse(existing.toString('utf8')) };
  const mpd = await readClipsFile(posix.join(dir, 'manifest.mpd'));
  if (!mpd) throw new Error('the asset has no DASH manifest');
  const rep = trickRep(videoReps(mpd.toString('utf8')));
  if (!rep) throw new Error('no video rendition in the DASH manifest');
  const initBuf = await readClipsFile(posix.join(dir, rep.init));
  const init = initBuf ? readInit(initBuf) : null;
  if (!init || !init.isVideo) throw new Error(`no video init segment at ${rep.init}`);
  const ivSize = initIvSize(initBuf!);
  if (ivSize === -1) throw new Error('encrypted, IV size not readable');
  const put = opts.put ?? defaultPut;
  const safe = rep.id.replace(/[^A-Za-z0-9_-]/g, '_') || 'video';
  const media = `trick/${safe}/seg_$Number$.m4s`;
  let peak = 0;
  for (let i = 0; i < rep.times.length; i++) {
    const n = rep.startNumber + i;
    const src = posix.join(dir, segmentName(rep.media, n));
    const seg = await readClipsFile(src);
    if (!seg) throw new Error(`missing segment ${src}`);
    const k = keyframeRanges(seg, init)[0];
    if (!k || k.start !== seg.indexOf(Buffer.from('moof')) - 4) throw new Error(`segment ${n} does not open on a keyframe`);
    const durTicks = Math.round((rep.times[i][1] * init.timescale) / rep.timescale);
    const frag = keyframeFragment(seg.subarray(k.start, k.end), init.trackId, durTicks, ivSize);
    if (!frag) throw new Error(`segment ${n}: its fragment layout is not supported`);
    await put(posix.join(dir, segmentName(media, n)), frag, 'video/iso.segment');
    peak = Math.max(peak, (frag.length * 8) / Math.max(0.001, rep.times[i][1] / rep.timescale));
  }
  const trick: LadderTrick = { version: 1, rep: rep.id, height: rep.height, media, bandwidth: Math.ceil(peak), segments: rep.times.length, builtAt: new Date().toISOString() };
  // Last: its presence tells the playout every segment is in place.
  await put(posix.join(dir, 'trick.json'), Buffer.from(JSON.stringify(trick)), 'application/json');
  return { state: 'ready', trick };
}

const asked = new Map<string, number>();

/**
 * Queue the trick tracks of the assets a channel with trick-play on is about
 * to air. Once an hour per asset per task at most: the job itself returns at
 * once when trick.json is there. Never throws.
 */
export async function queueLadderTricks(masterKeys: string[]): Promise<void> {
  const now = Date.now();
  const due = [...new Set(masterKeys.filter(Boolean))].filter((k) => (asked.get(k) ?? 0) < now);
  if (!due.length) return;
  try {
    const { enqueue } = await import('../jobs/queue');
    for (const k of due) {
      asked.set(k, now + 3600_000);
      await enqueue({ type: 'trickplay.ladder', payload: { masterKey: k }, dedupeKey: `trickplay.ladder:${k}`, priority: 80, maxAttempts: 2 });
    }
    if (asked.size > 20000) for (const [k, v] of asked) if (v < now) asked.delete(k);
  } catch (e) {
    console.error('[trickplay] FAST trick tracks not queued:', e);
  }
}
