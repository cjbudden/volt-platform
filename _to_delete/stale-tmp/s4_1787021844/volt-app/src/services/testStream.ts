// ============================================================================
//  TEST BUILD — local test-stream orchestration.
//  Spawns the FFmpeg test-stream generator + the live caption sidecar on the API
//  host, writing a real live HLS/DASH ladder + WebVTT into ORIGIN_DIR/<channelId>.
//  The control plane serves that directory at /origin/<channelId>/... so the app's
//  player can actually play it back with live subtitles. Start/stop is per channel.
//
//  This is a developer/test convenience — NOT the production encoder (that runs as
//  ECS tasks via the orchestrator). Enabled when ffmpeg is present locally.
// ============================================================================
import { spawn, ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, openSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { config } from '../config';
import { liveDirFor, liveUrlBase } from './liveOrigin';
import { query, one } from '../db';

export interface TestStreamOptions {
  name?: string;
  dvrSec?: number;         // 0 = event (keep all); else sliding window seconds
  langs?: string[];        // subtitle languages
  dash?: boolean;
  captionInterval?: number;
  inputUrl?: string | null; // ingest this external HLS/URL instead of the test card
}

interface Running {
  channelId: string;
  ff: ChildProcess;
  cap: ChildProcess;
  startedAt: number;
  opts: Required<TestStreamOptions>;
  sourceKind: 'ingest' | 'testcard';
  sourceUrl: string | null;
  sourceNote: string | null;
}

// Protocols the generator can PULL (it reads the URL). Push protocols (srt/rtmp/…)
// need a live publisher + a listener the test generator doesn't run, so we can't
// ingest them here — we fall back to the synthetic test card instead of hanging.
const PULL_PROTOCOLS = new Set(['hls', 'dash']);

const running = new Map<string, Running>();

function originFor(channelId: string) {
  return resolve(config.testStream.originDir, channelId);
}

// A live origin (master.m3u8 written/refreshed within this window) counts as
// "playing" even if this process didn't spawn the test stub — the REAL local
// encoder (orchestrator local launcher) writes to the same origin dir, so the
// player can pick up either producer transparently.
const ORIGIN_FRESH_MS = 45_000;

function probeOrigin(channelId: string): { live: boolean; mtime: number | null; dash: boolean; poster: boolean } {
  // manifests live in the CURRENT RUN dir (per-run namespace); thumbs stay at the
  // channel root (the thumbnailer writes them there, they span runs).
  const dir = liveDirFor(channelId);
  const master = join(dir, 'master.m3u8');
  try {
    const st = statSync(master);
    const age = Date.now() - st.mtimeMs;
    return {
      live: age <= ORIGIN_FRESH_MS,
      mtime: st.mtimeMs,
      dash: existsSync(join(dir, 'manifest.mpd')) || existsSync(join(dir, 'stream.mpd')),
      poster: existsSync(join(originFor(channelId), 'thumbs', 'poster.jpg')),
    };
  } catch {
    return { live: false, mtime: null, dash: false, poster: false };
  }
}

export function testStreamStatus(channelId: string) {
  const r = running.get(channelId);
  // stable live URL: the /origin router resolves /live/ to the current run dir, so
  // player and share URLs survive channel restarts (per-run output namespace).
  const base = liveUrlBase(channelId);
  const langs = r?.opts.langs ?? ['en'];
  // Shaka (real encoder) emits manifest.mpd; the test stub emits stream.mpd.
  const origin = probeOrigin(channelId);
  const dashName = existsSync(join(liveDirFor(channelId), 'manifest.mpd')) ? 'manifest.mpd' : 'stream.mpd';
  // producer: this process's test stub, else a live origin from the real encoder
  const producer: 'test' | 'encoder' | null = r ? 'test' : origin.live ? 'encoder' : null;
  const isRunning = !!r || origin.live;
  return {
    running: isRunning,
    producer,
    startedAt: r?.startedAt ?? origin.mtime ?? null,
    hls: `${base}/master.m3u8`,
    dash: r ? (r.opts.dash ? `${base}/stream.mpd` : null) : origin.dash ? `${base}/${dashName}` : null,
    subtitles: Object.fromEntries(langs.map((l) => [l, `${base}/subs/${l}.vtt`])),
    poster: origin.poster ? `/origin/${channelId}/thumbs/poster.jpg` : null,
    thumbsVtt: existsSync(join(originFor(channelId), 'thumbs', 'thumbs.vtt')) ? `/origin/${channelId}/thumbs/thumbs.vtt` : null,
    options: r?.opts ?? null,
    sourceKind: r?.sourceKind ?? (origin.live ? 'ingest' : null),
    sourceUrl: r?.sourceUrl ?? null,
    sourceNote: r?.sourceNote ?? null,
  };
}

export function isTestStreamAvailable(): boolean {
  // ffmpeg presence is checked lazily on start; the generator script also guards.
  return existsSync(join(config.testStream.encoderBin, 'test-stream.sh'));
}

export async function startTestStream(channelId: string, name: string, opts: TestStreamOptions = {}) {
  if (running.has(channelId)) return testStreamStatus(channelId);

  // Resolve the source: an explicit inputUrl wins; otherwise use the channel's
  // configured primary PULL (HLS/DASH) ingest input; else the synthetic test card.
  let inputUrl: string | null = opts.inputUrl ?? null;
  let sourceNote: string | null = null;
  if (inputUrl === null) {
    const primary = await one<any>(
      `SELECT ingest_url, protocol FROM stream_inputs
        WHERE channel_id = $1 AND ingest_url IS NOT NULL
        ORDER BY (role = 'primary') DESC, created_at ASC LIMIT 1`,
      [channelId]
    ).catch(() => null);
    if (primary?.ingest_url) {
      const proto = String(primary.protocol || '').toLowerCase();
      if (PULL_PROTOCOLS.has(proto)) {
        inputUrl = primary.ingest_url;
      } else {
        // push endpoint (srt/rtmp/rtmps/ndi/st2110) — no live publisher/listener here
        sourceNote = `Source is a ${proto.toUpperCase()} push endpoint; the test generator can't listen for a push, so it's running the synthetic test card. Push a feed to that endpoint, or set an HLS/DASH pull URL, to transcode the real source.`;
      }
    }
  }

  const o: Required<TestStreamOptions> = {
    name: opts.name ?? name,
    dvrSec: opts.dvrSec ?? 60,
    langs: opts.langs?.length ? opts.langs : ['en'],
    dash: opts.dash ?? false,
    captionInterval: opts.captionInterval ?? 4,
    inputUrl,
  };

  // PER-RUN NAMESPACE: the test stub writes to its own run dir too (suffixed -test),
  // and repoints current_run.txt at it. Nothing is deleted: previous runs are the
  // channel's recordings and are pruned only by the retention policy at encoder start.
  const runId = `${new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')}-test`;
  const out = join(originFor(channelId), 'runs', runId);
  mkdirSync(out, { recursive: true });
  writeFileSync(join(originFor(channelId), 'current_run.txt'), runId);

  const bin = config.testStream.encoderBin;
  const genArgs = ['--out', out, '--name', o.name, '--dvr-sec', String(o.dvrSec), '--seg', '4'];
  if (o.dash) genArgs.push('--dash');
  if (inputUrl) genArgs.push('--input-url', inputUrl);

  // Watermark burn-in: the logo is baked into the picture by the encoder, NOT
  // painted as a player overlay. It only applies on the TRANSCODE path (the test
  // stream re-encodes, so it can burn in); package_only would be a copy relay.
  // Resolve the channel's watermark settings and pass them to the generator; the
  // ref is turned into an absolute URL the generator can fetch on the same host.
  const wm = await one<any>(
    `SELECT c.watermark_enabled, c.watermark_ref, c.watermark_position,
            c.watermark_offset_x, c.watermark_offset_y, c.watermark_opacity, c.watermark_scale,
            p.workflow_type
       FROM channels c
       JOIN groups g ON g.id = c.group_id
       LEFT JOIN output_profiles p ON p.id = g.output_profile_id
      WHERE c.id = $1`,
    [channelId]
  ).catch(() => null);
  if (wm && wm.workflow_type === 'transcode' && wm.watermark_enabled && wm.watermark_ref) {
    const ref = String(wm.watermark_ref);
    const url = /^https?:\/\//i.test(ref)
      ? ref
      : `${config.internalApiBaseUrl.replace(/\/$/, '')}${ref.startsWith('/') ? '' : '/'}${ref}`;
    genArgs.push(
      '--watermark', url,
      '--wm-pos', String(wm.watermark_position || 'br'),
      '--wm-scale', String(wm.watermark_scale ?? 12),
      '--wm-opacity', String(wm.watermark_opacity ?? 100),
      '--wm-x', String(wm.watermark_offset_x ?? 24),
      '--wm-y', String(wm.watermark_offset_y ?? 24),
    );
  }

  // capture the encoder's stdout/stderr to a per-channel log for diagnosis
  const logFd = openSync(join(out, 'encoder.log'), 'a');
  const ff = spawn('bash', [join(bin, 'test-stream.sh'), ...genArgs], { stdio: ['ignore', logFd, logFd], detached: false });
  const cap = spawn('node', [join(bin, 'test-captions.mjs'), '--out', out, '--langs', o.langs.join(','), '--interval', String(o.captionInterval)], { stdio: 'ignore', detached: false });

  const rec: Running = {
    channelId, ff, cap, startedAt: Date.now(), opts: o,
    sourceKind: inputUrl ? 'ingest' : 'testcard', sourceUrl: inputUrl, sourceNote,
  };
  running.set(channelId, rec);

  // if ffmpeg dies on its own, clear the record so status reflects reality
  ff.on('exit', () => { if (running.get(channelId) === rec) { try { cap.kill('SIGTERM'); } catch {} running.delete(channelId); } });

  await query('UPDATE channels SET status = $1 WHERE id = $2', ['live', channelId]).catch(() => {});
  return testStreamStatus(channelId);
}

export async function stopTestStream(channelId: string) {
  const r = running.get(channelId);
  if (r) {
    try { r.ff.kill('SIGTERM'); } catch { /* ignore */ }
    try { r.cap.kill('SIGTERM'); } catch { /* ignore */ }
    running.delete(channelId);
  }
  await query('UPDATE channels SET status = $1 WHERE id = $2', ['scheduled', channelId]).catch(() => {});
  return { running: false };
}

// best-effort cleanup on process exit
for (const sig of ['SIGINT', 'SIGTERM', 'exit'] as const) {
  process.on(sig, () => { for (const r of running.values()) { try { r.ff.kill('SIGKILL'); r.cap.kill('SIGKILL'); } catch {} } });
}
