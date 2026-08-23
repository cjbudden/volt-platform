// ============================================================================
//  Radio pipeline — one ffmpeg per running station, three outputs, no video.
//
//  Input: the channel's primary source (Icecast/HTTP audio, HLS audio, SRT).
//  Outputs (all SINGLE bitrate, per radio_config.outputs):
//    - HLS : audio-only fMP4 into the standard per-run origin namespace
//            (<origin>/<id>/runs/<runId>/audio/…) with a hand-written
//            master.m3u8 at the run root. Using the same layout as TV runs is
//            what makes the recording index, range playback and clipping work
//            for radio without a single change.
//    - DASH: manifest.mpd under <run>/dash/.
//    - MP3 : continuous MP3 on ffmpeg stdout, fanned out by the control plane
//            at /radio/:id/stream.mp3 to any number of listeners, with ICY
//            now-playing titles injected per client (icy-metaint) so hardware
//            receivers and old players show what's on air.
//
//  Packaging vs transcode: we probe the source first. If it is already MP3 and
//  transcode is off, the MP3 output is a pure copy (true packaging); HLS/DASH
//  always carry AAC (the only universally supported HLS audio codec), encoded
//  at the configured bitrate. Transcode=on re-encodes MP3 at the configured
//  bitrate too (that is its purpose: change bitrate or format).
//
//  ICY metadata capture runs alongside (icyMeta.ts) for icecast sources.
// ============================================================================
import { spawn, spawnSync, ChildProcess } from 'node:child_process';
import { mkdirSync, writeFileSync, openSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { config } from '../../config';
import { originBaseFor } from '../liveOrigin';
import { startIcyCapture, stopIcyCapture, icyState } from './icyMeta';
import { startRadioMonitor, stopRadioMonitor } from './monitor';
import { query } from '../../db';
import type { Response } from 'express';

/** Lifecycle/error telemetry — the same stream_events table channels use, so the
 *  radio detail page's event log and the five-gate health read one source. */
function radioEvent(channelId: string, type: string, detail: Record<string, any>): void {
  query(`INSERT INTO stream_events(channel_id, type, detail, ts) VALUES ($1,$2,$3::jsonb, now())`,
    [channelId, type, JSON.stringify(detail)]).catch(() => {});
}

export interface RadioConfig {
  outputs?: { mp3?: boolean; hls?: boolean; dash?: boolean };
  bitrateKbps?: number;          // single output bitrate (64..320)
  metadataCapture?: boolean;     // icecast: capture the ICY now-playing log
  transcode?: boolean;           // re-encode instead of packaging/copy
  transcription?: boolean;       // icecast only: transcribe 'content' segments
}

interface RadioProc {
  channelId: string;
  child: ChildProcess;
  runId: string;
  cfg: Required<Pick<RadioConfig, 'bitrateKbps'>> & RadioConfig;
  sourceCodec: string | null;
  mp3Clients: Set<Response & { _icy?: { wants: boolean; countdown: number } }>;
  mp3Title: string;              // last title sent to ICY listeners
  startedAt: number;
}

const running = new Map<string, RadioProc>();
const ICY_METAINT = 16000;

/** ffprobe the source's first audio stream codec (mp3/aac/…), best effort. */
function probeAudioCodec(url: string): string | null {
  try {
    const r = spawnSync('ffprobe', [
      '-v', 'quiet', '-select_streams', 'a:0', '-show_entries', 'stream=codec_name',
      '-of', 'csv=p=0', '-analyzeduration', '2000000', '-i', url,
    ], { timeout: 8000, encoding: 'utf8' });
    const c = (r.stdout || '').trim().split('\n')[0];
    return c || null;
  } catch { return null; }
}

function inputArgs(protocol: string, url: string): string[] {
  if (protocol === 'icecast' || /^https?:/.test(url)) {
    return ['-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '5', '-i', url];
  }
  return ['-i', url]; // srt://, etc. — ffmpeg handles natively
}

export interface StartRadioOpts {
  channelId: string;
  protocol: string;
  url: string;
  cfg: RadioConfig;
}

/** Start the station's pipeline. Returns the run id (also the recording run). */
export function startRadio(opts: StartRadioOpts): { runId: string; pid: number } {
  stopRadio(opts.channelId); // idempotent

  const runId = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, 'Z');
  const base = originBaseFor(opts.channelId);
  const runDir = join(base, 'runs', runId);
  const audioDir = join(runDir, 'audio');
  const dashDir = join(runDir, 'dash');
  mkdirSync(audioDir, { recursive: true });

  const cfg = { bitrateKbps: 128, ...opts.cfg };
  const outs = { mp3: true, hls: true, dash: true, ...(opts.cfg.outputs || {}) };
  const br = `${Math.min(320, Math.max(32, cfg.bitrateKbps))}k`;
  const sourceCodec = probeAudioCodec(opts.url);
  const mp3Copy = !cfg.transcode && sourceCodec === 'mp3';

  const args: string[] = ['-hide_banner', '-loglevel', 'warning', '-nostdin',
    ...inputArgs(opts.protocol, opts.url)];

  if (outs.hls) {
    args.push(
      '-map', '0:a:0', '-c:a', 'aac', '-b:a', br, '-ac', '2',
      '-f', 'hls', '-hls_time', '4', '-hls_list_size', '0',
      '-hls_flags', 'program_date_time+independent_segments',
      '-hls_segment_type', 'fmp4', '-hls_fmp4_init_filename', 'init.mp4',
      '-hls_segment_filename', join(audioDir, 'seg_%05d.m4s'),
      join(audioDir, 'index.m3u8'),
    );
    // audio-only master at the run root (the /live rewrite serves this path)
    const bw = (cfg.bitrateKbps + 8) * 1000;
    writeFileSync(join(runDir, 'master.m3u8'),
      `#EXTM3U\n#EXT-X-VERSION:7\n#EXT-X-INDEPENDENT-SEGMENTS\n` +
      `#EXT-X-STREAM-INF:BANDWIDTH=${bw},CODECS="mp4a.40.2"\naudio/index.m3u8\n`);
  }
  if (outs.dash) {
    mkdirSync(dashDir, { recursive: true });
    args.push(
      '-map', '0:a:0', '-c:a', 'aac', '-b:a', br, '-ac', '2',
      '-f', 'dash', '-seg_duration', '4', '-streaming', '1',
      '-window_size', '20', '-extra_window_size', '10', '-remove_at_exit', '0',
      join(dashDir, 'manifest.mpd'),
    );
  }
  if (outs.mp3) {
    if (mp3Copy) args.push('-map', '0:a:0', '-c:a', 'copy', '-f', 'mp3', 'pipe:1');
    else args.push('-map', '0:a:0', '-c:a', 'libmp3lame', '-b:a', br, '-ac', '2', '-f', 'mp3', 'pipe:1');
  }

  const logFd = openSync(join(runDir, 'radio.log'), 'a');
  const child = spawn('ffmpeg', args, { stdio: ['ignore', outs.mp3 ? 'pipe' : 'ignore', logFd], detached: true });
  child.unref();

  const proc: RadioProc = {
    channelId: opts.channelId, child, runId,
    cfg, sourceCodec, mp3Clients: new Set(), mp3Title: '', startedAt: Date.now(),
  };
  running.set(opts.channelId, proc);

  // live pointer: /origin/<id>/live/... resolves to this run from now on
  writeFileSync(join(base, 'current_run.txt'), runId);

  // MP3 fan-out: broadcast every stdout chunk to connected listeners, injecting
  // ICY metadata every ICY_METAINT bytes for clients that asked for it.
  if (outs.mp3 && child.stdout) {
    child.stdout.on('data', (chunk: Buffer) => broadcastMp3(proc, chunk));
    child.stdout.on('error', () => { /* listeners handle their own teardown */ });
  }
  child.on('exit', (code, signal) => {
    const ours = running.get(opts.channelId)?.child === child;
    if (ours) {
      for (const res of proc.mp3Clients) { try { res.end(); } catch { /* */ } }
      proc.mp3Clients.clear();
    }
    // A non-zero exit we did NOT ask for is a real failure: log the reason from
    // the run's ffmpeg log so the event feed says WHY, exactly like channels.
    if (ours && code && code !== 0) {
      console.error(`[radio] ffmpeg exited ${code} for ${opts.channelId}`);
      radioEvent(opts.channelId, 'input.error', { message: `${errorTail(runDir) || `encoder exited rc=${code}`}`, rc: code, signal });
      radioEvent(opts.channelId, 'channel.stop', { reason: `exited rc=${code}` });
      running.delete(opts.channelId);
      stopRadioMonitor(opts.channelId);
    }
  });

  // ICY now-playing capture (icecast/http sources only)
  if (opts.protocol === 'icecast' && cfg.metadataCapture !== false) {
    startIcyCapture(opts.channelId, opts.url, true);
  }
  // QC + telemetry loop (levels, playlist invariants, stream_status, events)
  startRadioMonitor(opts.channelId, runId);
  radioEvent(opts.channelId, 'channel.start', {
    run_id: runId, protocol: opts.protocol, source: opts.url,
    outputs: Object.entries(outs).filter(([, v]) => v).map(([k]) => k).join('+'),
    bitrate_kbps: cfg.bitrateKbps, workflow: mp3Copy ? 'package' : 'transcode',
  });
  return { runId, pid: child.pid ?? 0 };
}

/** Last real error line from this run's ffmpeg log (for the event detail). */
function errorTail(runDir: string): string {
  try {
    const lines = readFileSync(join(runDir, 'radio.log'), 'utf8').split(/\r?\n/).filter(Boolean);
    const rx = /error|failed|Invalid|No such|Could not|Connection|refused|timed out|denied|404|403|Server returned/i;
    const noise = /invalid concatenated file|Error submitting packet to decoder|Audio packet of size|Header missing|skipping \d+ bytes/i;
    const hit = lines.filter((l) => rx.test(l) && !noise.test(l)).slice(-1)[0];
    return hit ? hit.slice(0, 300) : '';
  } catch { return ''; }
}

export function stopRadio(channelId: string, reason = 'operator'): void {
  const proc = running.get(channelId);
  stopIcyCapture(channelId);
  stopRadioMonitor(channelId);
  if (!proc) return;
  running.delete(channelId);
  radioEvent(channelId, 'channel.stop', { reason });
  for (const res of proc.mp3Clients) { try { res.end(); } catch { /* */ } }
  proc.mp3Clients.clear();
  try { if (proc.child.pid) process.kill(-proc.child.pid, 'SIGTERM'); } catch { try { proc.child.kill('SIGTERM'); } catch { /* */ } }
  setTimeout(() => { try { if (proc.child.pid) process.kill(-proc.child.pid, 'SIGKILL'); } catch { /* */ } }, 3000).unref();
}

export function radioStatus(channelId: string) {
  const p = running.get(channelId);
  if (!p) return { running: false as const };
  return {
    running: true as const,
    runId: p.runId,
    startedAt: p.startedAt,
    sourceCodec: p.sourceCodec,
    listeners: p.mp3Clients.size,
    icy: icyState(channelId),
  };
}

export function isRadioRunning(channelId: string): boolean { return running.has(channelId); }

// ---- MP3 fan-out ------------------------------------------------------------
function broadcastMp3(proc: RadioProc, chunk: Buffer) {
  // Always carry the CURRENT title in each metadata block (players dedupe), so a
  // client can never miss a change regardless of when its countdown crosses zero.
  const title = icyState(proc.channelId)?.title ?? '';
  proc.mp3Title = title;
  for (const res of proc.mp3Clients) {
    const st = res._icy!;
    try {
      if (!st.wants) { res.write(chunk); continue; }
      // write audio, inserting a metadata block whenever the countdown crosses 0
      let off = 0;
      while (off < chunk.length) {
        const take = Math.min(st.countdown, chunk.length - off);
        if (take > 0) { res.write(chunk.subarray(off, off + take)); st.countdown -= take; off += take; }
        if (st.countdown === 0) {
          res.write(icyBlock(title));
          st.countdown = ICY_METAINT;
        }
      }
    } catch { proc.mp3Clients.delete(res); }
  }
}

function icyBlock(title: string): Buffer {
  if (!title) return Buffer.from([0]);
  const text = `StreamTitle='${title.replace(/'/g, ' ')}';`;
  const pad = Math.ceil(text.length / 16);
  const buf = Buffer.alloc(1 + pad * 16);
  buf[0] = pad;
  buf.write(text, 1, 'utf8');
  return buf;
}

/** Attach an HTTP listener to the station's live MP3 (public delivery). */
export function attachMp3Listener(channelId: string, req: { headers: Record<string, any> }, res: Response, stationName?: string): boolean {
  const proc = running.get(channelId);
  if (!proc || !proc.child.stdout) return false;
  const wantsMeta = String(req.headers['icy-metadata'] ?? '') === '1';
  const icy = icyState(channelId);
  res.status(200);
  res.setHeader('Content-Type', 'audio/mpeg');
  res.setHeader('Cache-Control', 'no-cache, no-store');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('icy-name', stationName || icy?.station?.name || 'VOLT Radio');
  if (icy?.station?.genre) res.setHeader('icy-genre', icy.station.genre);
  res.setHeader('icy-br', String(proc.cfg.bitrateKbps ?? 128));
  if (wantsMeta) res.setHeader('icy-metaint', String(ICY_METAINT));
  res.flushHeaders?.();
  const r = res as RadioProc['mp3Clients'] extends Set<infer T> ? T : never;
  r._icy = { wants: wantsMeta, countdown: ICY_METAINT };
  proc.mp3Clients.add(r);
  (res as any).on?.('close', () => proc.mp3Clients.delete(r));
  return true;
}

/** Stop everything (boot cleanup / shutdown). */
export function stopAllRadio(): void {
  for (const id of Array.from(running.keys())) stopRadio(id);
}
