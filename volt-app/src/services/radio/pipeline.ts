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
import {
  buildRadioArgs, resolveOutputs, isMp3Copy, masterPlaylist,
  DEFAULT_BITRATE_KBPS, type RadioJobConfig, type IcecastTarget,
} from './args';

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

export interface StartRadioOpts {
  channelId: string;
  protocol: string;
  url: string;
  cfg: RadioConfig;
  /** Push MP3 to a relay instead of piping it to us. Null keeps the dev pipe. */
  icecast?: IcecastTarget | null;
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

  const cfg = { bitrateKbps: DEFAULT_BITRATE_KBPS, ...opts.cfg };
  const outs = resolveOutputs(opts.cfg.outputs);
  const sourceCodec = probeAudioCodec(opts.url);

  // ONE description of the pipeline, shared with the container. Everything that
  // decides what ffmpeg does now lives in args.ts, so the in-process path here
  // and volt-radio's entrypoint cannot drift into two different stations.
  //
  // `icecast: opts.icecast ?? null` is what selects the topology. Null keeps
  // MP3 on `pipe:1` for the in-process preview, which is the old behaviour and
  // the reason this path still exists at all.
  const jobConfig: RadioJobConfig = {
    channelId: opts.channelId,
    protocol: opts.protocol,
    url: opts.url,
    outputs: outs,
    bitrateKbps: cfg.bitrateKbps ?? DEFAULT_BITRATE_KBPS,
    transcode: cfg.transcode,
    sourceCodec,
    icecast: opts.icecast ?? null,
  };
  const mp3Copy = isMp3Copy(jobConfig);
  const wantsPipe = outs.mp3 && !jobConfig.icecast;

  if (outs.dash) mkdirSync(dashDir, { recursive: true });
  const args = buildRadioArgs(jobConfig, { runDir, audioDir, dashDir });
  // The audio-only master at the run root: written by us rather than ffmpeg,
  // because the /live rewrite serves this exact path.
  if (outs.hls) {
    writeFileSync(join(runDir, 'master.m3u8'), masterPlaylist(jobConfig.bitrateKbps));
  }

  const logFd = openSync(join(runDir, 'radio.log'), 'a');
  const child = spawn('ffmpeg', args, { stdio: ['ignore', wantsPipe ? 'pipe' : 'ignore', logFd], detached: true });
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
  if (wantsPipe && child.stdout) {
    child.stdout.on('data', (chunk: Buffer) => broadcastMp3(proc, chunk));
    child.stdout.on('error', () => { /* listeners handle their own teardown */ });
  }
  child.on('exit', (code, signal) => {
    // `ours` means this pipeline is STILL REGISTERED as the channel's, which
    // can only be true for an exit nobody asked for: stopRadio() removes the
    // registration before it signals. Reaching here with `ours` set is always
    // a surprise, whatever the exit code turns out to say.
    const ours = running.get(opts.channelId)?.child === child;
    if (!ours) return;

    for (const res of proc.mp3Clients) { try { res.end(); } catch { /* */ } }
    proc.mp3Clients.clear();

    // TEARDOWN IS UNCONDITIONAL NOW. All of this used to be gated on
    // `code && code !== 0`, which skipped the two most common ways a process
    // actually ends: a clean rc=0 (the source closed, the stream finished) and
    // a signal kill, where `code` is null and `signal` carries the truth. In
    // both cases the station stayed in the `running` map for the life of the
    // process — isRadioRunning() kept answering true, the boot reconciler
    // believed it, the monitor kept polling a pipeline that was gone, and
    // pressing Start was refused as "already running" with no way to clear it
    // short of restarting the control plane.
    running.delete(opts.channelId);
    stopRadioMonitor(opts.channelId);

    if (code === 0) {
      // A clean end is not a fault. The source went away or the stream simply
      // finished; say that plainly rather than dressing it up as an error.
      console.log(`[radio] ffmpeg finished cleanly for ${opts.channelId}`);
      radioEvent(opts.channelId, 'channel.stop', { reason: 'source ended (rc=0)' });
      return;
    }
    // A non-zero exit, or a signal we did not send, is a real failure: pull the
    // reason out of this run's ffmpeg log so the event feed says WHY, exactly
    // the way channels do.
    const how = code != null ? `rc=${code}` : `signal ${signal}`;
    console.error(`[radio] ffmpeg exited unexpectedly (${how}) for ${opts.channelId}`);
    radioEvent(opts.channelId, 'input.error', {
      message: `${errorTail(runDir) || `encoder exited ${how}`}`, rc: code, signal,
    });
    radioEvent(opts.channelId, 'channel.stop', { reason: `exited ${how}` });
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
