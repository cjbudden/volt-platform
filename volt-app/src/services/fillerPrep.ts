// ============================================================================
//  SOURCE PROBE + PRE-BUILT FALLBACK LOOP
//
//  When a channel's (or event's) sources, ladder or fallback asset change, this
//  probes what each source actually is, stores it on the input row, and then
//  pre-renders the fallback loop (or slate) to the channel's ladder and packages
//  it once. The encoder splices that package into the delivered playlists on a
//  loss (volt-encoder/bin/playout.py), so nothing is encoded at failover time.
//
//  WHY MATCH THE SOURCE. On a package_only channel the delivered renditions ARE
//  the source's renditions, so the loop has to be the same width, height, frame
//  rate, H.264 profile and level and roughly the same bitrate, or a player meets
//  a different stream mid-variant. The old runtime filler was encoded with
//  fixed settings and pushed through the packager, which stopped dead on the
//  codec change and took the channel down.
//
//  ONE DEFINITION. The probe and the build are the encoder's own Python
//  (source_probe.py, filler_build.py); this file only decides WHAT to build. The
//  encoder re-checks the build against its live output at start and rebuilds
//  from that output when it does not match, so a push source (SRT/RTMP), which
//  cannot be probed until it is received, still ends up with an exact loop.
// ============================================================================
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { one, query } from '../db';
import { config } from '../config';
import { buildEncoderJobConfig } from './jobConfig';

export const FILLER_BUILD = 'filler.build';
type Kind = 'channel' | 'event';
const PULL = new Set(['hls', 'http', 'https', 'dash']);

function py(script: string, args: string[], timeoutMs = 180000): Promise<{ code: number; out: string; err: string }> {
  return new Promise((done) => {
    const p = spawn(config.testStream.pythonBin, [join(config.testStream.encoderBin, script), ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, PACKAGER_BIN: process.env.PACKAGER_BIN ?? 'packager' },
    });
    let out = '', err = '';
    const t = setTimeout(() => { try { p.kill('SIGKILL'); } catch { /* gone */ } }, timeoutMs);
    p.stdout.on('data', (b) => { out += String(b); });
    p.stderr.on('data', (b) => { err += String(b); });
    p.on('close', (code) => { clearTimeout(t); done({ code: code ?? 1, out, err }); });
    p.on('error', (e) => { clearTimeout(t); done({ code: 1, out, err: String(e?.message ?? e) }); });
  });
}

function lastJson(s: string): any | null {
  for (const l of s.trim().split('\n').reverse()) {
    try { return JSON.parse(l.trim()); } catch { /* not this line */ }
  }
  return null;
}

/** Probe every input of an owner and store the result on its row. */
export async function probeInputs(kind: Kind, id: string): Promise<any[]> {
  const col = kind === 'channel' ? 'channel_id' : 'event_id';
  const rows = await query<any>(`SELECT * FROM stream_inputs WHERE ${col} = $1 ORDER BY role, rendition_bitrate_kbps DESC NULLS LAST`, [id]);
  const out: any[] = [];
  for (const r of rows) {
    let probe: any;
    const proto = String(r.protocol || '').toLowerCase();
    if (!r.ingest_url) {
      probe = { error: 'no source URL' };
    } else if (!PULL.has(proto)) {
      probe = { pending: true, note: `${proto.toUpperCase()} is a push source: it is probed by the encoder once it is received` };
    } else {
      const res = await py('source_probe.py', [r.ingest_url], 60000);
      probe = lastJson(res.out) ?? { error: (res.err || 'probe failed').trim().split('\n').pop() };
    }
    await query(`UPDATE stream_inputs SET probe = $2::jsonb, probed_at = now() WHERE id = $1`, [r.id, JSON.stringify(probe)]);
    out.push({ ...r, probe });
  }
  return out;
}

const even = (n: number) => { const v = Math.round(n); return v - (v % 2); };

/** What to build, from the encoder's own job config plus the stored probes. */
export function fillerSpec(cfg: Record<string, any>, inputs: any[]): { spec: any | null; reason?: string } {
  const red = cfg.redundancy;
  if (!red?.input_failover) return { spec: null, reason: 'input failover is off' };
  const loss = red.input_loss_behavior ?? 'slate';
  if (loss !== 'slate' && loss !== 'vod_loop') return { spec: null, reason: `loss behaviour '${loss}' has no loop` };
  const f = red.filler ?? {};
  const source = loss === 'vod_loop' && f.vod_loop_url ? { kind: 'video', path: f.vod_loop_url }
    : f.slate_ref ? { kind: 'image', path: f.slate_ref } : null;
  if (!source) return { spec: null, reason: 'no slate image or loop video has been added' };

  const primaries = inputs.filter((i) => i.role === 'primary');
  const prim = primaries.find((i) => i.probe?.video) ?? primaries[0];
  const pv = prim?.probe?.video ?? null;
  const pa = prim?.probe?.audio ?? null;
  let video: any[] = [];
  let audio: any = null;
  if (cfg.workflow === 'package_only') {
    for (const inp of primaries) {
      const v = inp.probe?.video;
      if (!v?.width || !v?.height) return { spec: null, reason: `source ${inp.rendition_label ?? inp.ingest_url} has not been probed yet` };
      video.push({
        label: inp.rendition_label ?? `${v.height}p`, width: v.width, height: v.height, fps: v.fps ?? cfg.fps ?? 25,
        bitrate_kbps: Math.max(200, v.bitrate_kbps ?? inp.rendition_bitrate_kbps ?? 1500),
        x264_profile: v.x264_profile ?? 'high', x264_level: v.x264_level ?? null, pix_fmt: v.pix_fmt ?? 'yuv420p',
      });
    }
    if (pa?.sample_rate) audio = { sample_rate: pa.sample_rate, channels: pa.channels ?? 2, bitrate_kbps: pa.bitrate_kbps ?? 128 };
  } else {
    // transcode: the ladder as the live encoder will produce it. Width follows the
    // source's aspect exactly as `scale=-2:<h>` does; the encoder corrects it from
    // its real output if the source turns out different.
    const aspect = pv?.width && pv?.height ? pv.width / pv.height : 16 / 9;
    video = (cfg.ladder ?? []).map((r: any) => ({
      label: `${r.height}p`, width: even(r.height * aspect), height: r.height, fps: cfg.fps ?? 25,
      bitrate_kbps: r.bitrate_kbps, x264_profile: 'high', x264_level: null, pix_fmt: 'yuv420p',
    }));
    audio = { sample_rate: pa?.sample_rate ?? 48000, channels: 2, bitrate_kbps: 128 };
  }
  if (!video.length) return { spec: null, reason: 'no renditions to match' };
  const spec: any = { segment_seconds: cfg.segment_seconds, source, video, audio };
  if (cfg.workflow !== 'package_only' && cfg.watermark?.url) {
    const w = cfg.watermark;
    spec.watermark = { path: w.url, position: w.position, offset_x: w.offset_x, offset_y: w.offset_y, opacity: w.opacity, scale: w.scale };
  }
  return { spec };
}

async function setBuild(kind: Kind, id: string, v: any) {
  await query(`UPDATE ${kind === 'channel' ? 'channels' : 'events'} SET filler_build = $2::jsonb WHERE id = $1`, [id, JSON.stringify(v)]);
}

/** The job: probe, decide, build. Safe to run any number of times. */
export async function runFillerPrep(kind: Kind, id: string): Promise<any> {
  const { orchestrator } = await import('./orchestrator');
  const inputs = await probeInputs(kind, id);
  const ctx = await orchestrator.loadContext(kind, id);
  if (!ctx) return { status: 'none', reason: `${kind} not found` };
  const cfg = buildEncoderJobConfig(ctx);
  const { spec, reason } = fillerSpec(cfg, inputs);
  if (!spec) {
    const v = { status: 'none', reason, at: new Date().toISOString() };
    await setBuild(kind, id, v);
    return v;
  }
  await setBuild(kind, id, { status: 'building', at: new Date().toISOString() });
  const dir = resolve(config.testStream.originDir, id, 'filler', 'prebuilt');
  await mkdir(resolve(config.testStream.originDir, id, 'filler'), { recursive: true });
  const specPath = `${dir}.spec.json`;
  await writeFile(specPath, JSON.stringify(spec, null, 1));
  const res = await py('filler_build.py', [specPath, dir]);
  const meta = lastJson(res.out);
  if (res.code !== 0 || !meta || meta.error) {
    const v = { status: 'failed', error: meta?.error ?? (res.err || 'build failed').trim().split('\n').pop(), at: new Date().toISOString() };
    await setBuild(kind, id, v);
    return v;
  }
  const v = {
    status: 'ready', dir, hash: meta.hash, loop_seconds: meta.loop_seconds, source_kind: spec.source.kind,
    renditions: spec.video.map((x: any) => ({ label: x.label, width: x.width, height: x.height, fps: x.fps, bitrate_kbps: x.bitrate_kbps, profile: x.x264_profile })),
    audio: spec.audio, watermark: !!spec.watermark, build_seconds: meta.build_seconds, at: new Date().toISOString(),
  };
  await setBuild(kind, id, v);
  return v;
}

/** Queue a (re)build. Called when sources, ladder or fallback settings change. */
export async function scheduleFillerPrep(kind: Kind, id: string, why: string): Promise<void> {
  try {
    const { enqueue } = await import('./jobs/queue');
    await enqueue({
      type: FILLER_BUILD, payload: { kind, id, why },
      channelId: kind === 'channel' ? id : null, eventId: kind === 'event' ? id : null,
      dedupeKey: `filler:${kind}:${id}`, maxAttempts: 2,
    } as any);
  } catch (e) {
    console.warn(`[filler] could not queue a loop build for ${kind} ${id}:`, (e as any)?.message ?? e);
  }
}

export async function registerFillerHandlers(): Promise<void> {
  const { registerHandler } = await import('./jobs/worker');
  registerHandler(FILLER_BUILD, async (ctx: any) => {
    const p = ctx.job?.payload ?? {};
    await ctx.progress?.(10, 'probing sources');
    return await runFillerPrep(p.kind, p.id);
  });
}

/** Fields whose change means the pre-built loop no longer matches. */
export const FILLER_FIELDS = ['sources', 'outputLadder', 'inputFailoverEnabled', 'inputLossBehavior',
  'fillerSlateRef', 'fillerAssetId', 'watermark'];

/**
 * What the stream's loop would be built from, without building it: the slate
 * image or loop video its filler settings name, or why there is none, plus the
 * last build's state. The rights preview uses it to tell "set a slate or loop"
 * apart from "it is set, the loop is just not built yet" (build queue 1.14-G5a:
 * it said "Set a loop" to a stream that had a slate set).
 */
export async function fillerSource(kind: Kind, id: string): Promise<{
  kind: 'image' | 'video' | null; reason: string | null; build: string | null; error: string | null;
}> {
  // Read from the stream's own settings, the same ones the orchestrator turns
  // into the encoder's filler (loadContext): a filler asset (a loop is video,
  // anything else an image), else the slate reference. Not through loadContext
  // itself, which needs an output profile this answer does not.
  const row = await one<any>(
    `SELECT o.input_failover_enabled, o.input_loss_behavior, o.filler_slate_ref, o.filler_build, fa.kind AS asset_kind
       FROM ${kind === 'channel' ? 'channels' : 'events'} o LEFT JOIN filler_assets fa ON fa.id = o.filler_asset_id
      WHERE o.id = $1`, [id]);
  const build = row?.filler_build ?? null;
  const st = { build: build?.status ?? null, error: build?.status === 'failed' ? (build.error ?? null) : null };
  if (!row) return { kind: null, reason: `${kind} not found`, ...st };
  if (!row.input_failover_enabled) return { kind: null, reason: 'input failover is off', ...st };
  // As jobConfig.ts and fillerSpec above.
  const loss = row.input_loss_behavior ?? 'slate';
  if (loss !== 'slate' && loss !== 'vod_loop') return { kind: null, reason: `loss behaviour '${loss}' has no loop`, ...st };
  const loop = row.asset_kind === 'loop';
  const slate = (!!row.asset_kind && !loop) || !!row.filler_slate_ref;
  if (loss === 'vod_loop' && loop) return { kind: 'video', reason: null, ...st };
  if (slate) return { kind: 'image', reason: null, ...st };
  return { kind: null, reason: 'no slate image or loop video has been added', ...st };
}

export async function fillerStatus(kind: Kind, id: string): Promise<any> {
  const row = await one<any>(`SELECT filler_build FROM ${kind === 'channel' ? 'channels' : 'events'} WHERE id = $1`, [id]);
  return row?.filler_build ?? null;
}
