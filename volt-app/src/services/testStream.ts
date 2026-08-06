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
import { existsSync, rmSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { config } from '../config';
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
}

const running = new Map<string, Running>();

function originFor(channelId: string) {
  return resolve(config.testStream.originDir, channelId);
}

export function testStreamStatus(channelId: string) {
  const r = running.get(channelId);
  const base = `/origin/${channelId}`;
  const langs = r?.opts.langs ?? ['en'];
  return {
    running: !!r,
    startedAt: r?.startedAt ?? null,
    hls: `${base}/master.m3u8`,
    dash: r?.opts.dash ? `${base}/stream.mpd` : null,
    subtitles: Object.fromEntries(langs.map((l) => [l, `${base}/subs/${l}.vtt`])),
    options: r?.opts ?? null,
    sourceKind: r?.sourceKind ?? null,
    sourceUrl: r?.sourceUrl ?? null,
  };
}

export function isTestStreamAvailable(): boolean {
  // ffmpeg presence is checked lazily on start; the generator script also guards.
  return existsSync(join(config.testStream.encoderBin, 'test-stream.sh'));
}

export async function startTestStream(channelId: string, name: string, opts: TestStreamOptions = {}) {
  if (running.has(channelId)) return testStreamStatus(channelId);

  // Resolve the source: an explicit inputUrl wins; otherwise use the channel's
  // configured primary HLS ingest input if it has one; else the synthetic test card.
  let inputUrl: string | null = opts.inputUrl ?? null;
  if (inputUrl === null) {
    const primary = await one<any>(
      `SELECT ingest_url, protocol FROM stream_inputs
        WHERE channel_id = $1 AND ingest_url IS NOT NULL
        ORDER BY (role = 'primary') DESC, created_at ASC LIMIT 1`,
      [channelId]
    ).catch(() => null);
    if (primary?.ingest_url) inputUrl = primary.ingest_url;
  }

  const o: Required<TestStreamOptions> = {
    name: opts.name ?? name,
    dvrSec: opts.dvrSec ?? 60,
    langs: opts.langs?.length ? opts.langs : ['en'],
    dash: opts.dash ?? false,
    captionInterval: opts.captionInterval ?? 4,
    inputUrl,
  };

  const out = originFor(channelId);
  // clean any stale output so the player doesn't pick up an old timeline
  try { rmSync(out, { recursive: true, force: true }); } catch { /* ignore */ }
  mkdirSync(out, { recursive: true });

  const bin = config.testStream.encoderBin;
  const genArgs = ['--out', out, '--name', o.name, '--dvr-sec', String(o.dvrSec), '--seg', '4'];
  if (o.dash) genArgs.push('--dash');
  if (inputUrl) genArgs.push('--input-url', inputUrl);

  const ff = spawn('bash', [join(bin, 'test-stream.sh'), ...genArgs], { stdio: 'ignore', detached: false });
  const cap = spawn('node', [join(bin, 'test-captions.mjs'), '--out', out, '--langs', o.langs.join(','), '--interval', String(o.captionInterval)], { stdio: 'ignore', detached: false });

  const rec: Running = {
    channelId, ff, cap, startedAt: Date.now(), opts: o,
    sourceKind: inputUrl ? 'ingest' : 'testcard', sourceUrl: inputUrl,
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
