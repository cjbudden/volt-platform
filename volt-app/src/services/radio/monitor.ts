// ============================================================================
//  RADIO MONITOR — the QC + telemetry loop for a running station.
//
//  Channels get their health from the encoder's status reports; radio runs its
//  pipeline in-process, so this monitor produces the SAME ground truth from the
//  station's own OUTPUT (what we are actually broadcasting), on a tick:
//
//   1. LEVELS / CONTENT QC. Analyse the newest complete audio segment with
//      ffmpeg astats + silencedetect: peak dBFS, RMS dBFS, crest factor,
//      entropy, silence. From those we classify the signal:
//        audio   — normal programme audio
//        quiet   — very low but not dead
//        silent  — no signal (RMS <= -60 dBFS / silencedetect fired)
//        static  — noise-like: high entropy + low crest sustained (the "is it
//                  actually programme audio or just hiss" question)
//      The rolling window doubles as the VISUALISER feed, so the meter moves
//      from the RECEIVED stream whether or not anyone is listening locally.
//
//   2. PLAYLIST INVARIANTS. The same checks playcheck.py makes for TV: stale
//      playlist, media-sequence regression, duplicate URIs, PDT going backwards
//      or jumping. These catch packaging faults the ear cannot.
//
//   3. TELEMETRY. Upserts stream_status (output_available / packager_ok /
//      sources) and writes stream_events rows, so radio flows through the SAME
//      five-gate health model, event log and monitoring surfaces as channels.
// ============================================================================
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { query } from '../../db';
import { originBaseFor, currentRunId } from '../liveOrigin';
import { icyState } from './icyMeta';

export type SignalVerdict = 'audio' | 'quiet' | 'silent' | 'static' | 'unknown';

export interface LevelSample {
  t: number;            // epoch ms (segment end, measured)
  peakDb: number;       // dBFS (-100 = silence)
  rmsDb: number;        // dBFS
  crestDb: number;      // peak - rms: low on noise, high on speech/music
  entropy: number;      // 0..1: ~0.9+ is noise-like, ~0.7 tonal
  silence: boolean;     // silencedetect fired inside the segment
  verdict: SignalVerdict;
  /** ~100ms momentary-loudness frames (EBU R128 M, LUFS) across the segment.
   *  Kept for loudness reporting. NOT for the waveform: broadcast music is
   *  loudness-normalised and compressed, so M barely moves (a real Groove Salad
   *  segment measured -17.8 to -14.0 LUFS, under 4 LU of range). Drawn as bar
   *  heights that is a solid block near the top with no dynamics at all. */
  frames: number[];
  /** ~100ms TRUE PEAK frames (dBFS, loudest channel) across the segment.
   *  THIS is the waveform. Peak amplitude is what a waveform display shows,
   *  and it has the shape the loudness frames lack: the same segment ran -13.1
   *  to -4.1 dBFS, tracking the actual transients of the audio. */
  peaks: number[];
}

export interface QcIssue {
  code: 'stale' | 'seq-regress' | 'dup-uri' | 'pdt-backwards' | 'pdt-jump' | 'silence' | 'static' | 'icy-stall' | 'no-segments';
  message: string;
  at: number;
}

export interface RadioMonitorState {
  channelId: string;
  /** The run being measured. Null until a following monitor sees a run pointer. */
  runId: string | null;
  levels: LevelSample[];        // rolling window (newest last)
  verdict: SignalVerdict;
  lastSampleAt: number | null;
  segments: number;             // segments seen in the live playlist
  outputFreshMs: number | null; // ms since the playlist last advanced
  issues: QcIssue[];            // rolling QC issues (newest last)
  checks: { ok: number; failed: number };
  silenceSinceMs: number | null;
  staticSinceMs: number | null;
}

const WINDOW = 90;              // ~6 min of 4s samples
const ISSUES_MAX = 60;
const SILENT_DB = -60;
const QUIET_DB = -45;
const STATIC_ENTROPY = 0.88;
const STATIC_CREST_DB = 8;
/** Sustained-condition thresholds before an event is raised (ms). */
const SILENCE_ALERT_MS = 12_000;
const STATIC_ALERT_MS = 30_000;

const monitors = new Map<string, RadioMonitor>();

function num(s: string | undefined, dflt: number): number {
  if (!s) return dflt;
  const v = parseFloat(s);
  return Number.isFinite(v) ? v : dflt;
}

/** ffmpeg astats + silencedetect over one segment. Short-lived, audio-only: ms. */
export function analyseSegment(initPath: string, segPath: string): LevelSample | null {
  try {
    // fMP4 segments need their init header to decode: concat them on stdin.
    const init = readFileSync(initPath);
    const seg = readFileSync(segPath);
    const r = spawnSync('ffmpeg', [
      '-hide_banner', '-loglevel', 'info', '-i', 'pipe:0',
      // astats/silencedetect give the QC verdict; ebur128 gives ~100ms momentary
      // loudness frames for the meter, in one pass.
      '-af', 'astats=metadata=1:reset=0,silencedetect=n=-60dB:d=1.0,ebur128=peak=true',
      '-f', 'null', '-',
    ], { input: Buffer.concat([init, seg]), timeout: 15000, encoding: 'buffer', maxBuffer: 8 << 20 });
    const out = (r.stderr?.toString('utf8') || '');
    if (!out) return null;
    const grab = (label: string) => {
      const m = out.match(new RegExp(`^\\[Parsed_astats[^\\]]*\\]\\s*${label}:\\s*(-?[\\d.]+|-?inf)`, 'm'));
      return m ? m[1] : undefined;
    };
    const peakRaw = grab('Peak level dB');
    const rmsRaw = grab('RMS level dB');
    if (peakRaw === undefined && rmsRaw === undefined) return null;
    const peakDb = peakRaw === '-inf' ? -100 : num(peakRaw, -100);
    const rmsDb = rmsRaw === '-inf' ? -100 : num(rmsRaw, -100);
    const entropy = num(grab('Entropy'), 0);
    const silence = /silence_start:/.test(out) || rmsDb <= SILENT_DB;
    const crestDb = Math.max(0, peakDb - rmsDb);
    // Per-frame loudness (M) and TRUE PEAK (FTPK) from the same ebur128 pass.
    // FTPK prints one value per channel; the waveform takes the loudest.
    const frames: number[] = [];
    const peaks: number[] = [];
    // One pass per ebur128 line, two independent field reads. (Doing it as a
    // single regex with an optional trailing group silently matched nothing:
    // the lazy `.*?` before the optional FTPK group is happy to stop early.)
    for (const line of out.split('\n')) {
      if (!line.includes('[Parsed_ebur128')) continue;
      const m = /\sM:\s*(-?[\d.]+)/.exec(line);
      if (m) { const v = parseFloat(m[1]); if (Number.isFinite(v)) frames.push(v <= -70 ? -100 : v); }
      const fp = /\sFTPK:\s*((?:\s*-?(?:[\d.]+|inf))+?)\s*dBFS/.exec(line);
      if (fp) {
        const ch = fp[1].trim().split(/\s+/)
          .map(v => (v === '-inf' || v === 'inf' ? -100 : parseFloat(v)))
          .filter(v => Number.isFinite(v));
        if (ch.length) peaks.push(Math.max(-100, Math.max(...ch)));
      }
    }
    let verdict: SignalVerdict;
    if (rmsDb <= SILENT_DB) verdict = 'silent';
    else if (entropy >= STATIC_ENTROPY && crestDb <= STATIC_CREST_DB) verdict = 'static';
    else if (rmsDb <= QUIET_DB) verdict = 'quiet';
    else verdict = 'audio';
    return { t: Date.now(), peakDb, rmsDb, crestDb, entropy, silence, verdict, frames, peaks };
  } catch { return null; }
}

/** Live-playlist invariants — the audio equivalent of playcheck.py. */
export function playlistIssues(text: string, prev: { seq: number; uris: string[]; lastPdt: number } | null):
  { issues: Omit<QcIssue, 'at'>[]; seq: number; uris: string[]; lastPdt: number; segments: number } {
  const issues: Omit<QcIssue, 'at'>[] = [];
  const lines = text.split(/\r?\n/);
  const seq = (() => { const m = text.match(/#EXT-X-MEDIA-SEQUENCE:(\d+)/); return m ? parseInt(m[1], 10) : 0; })();
  const uris = lines.filter((l) => l && !l.startsWith('#'));
  const pdts = lines.filter((l) => l.startsWith('#EXT-X-PROGRAM-DATE-TIME:'))
    .map((l) => Date.parse(l.slice('#EXT-X-PROGRAM-DATE-TIME:'.length).trim()))
    .filter((n) => Number.isFinite(n));
  const lastPdt = pdts.length ? pdts[pdts.length - 1] : (prev?.lastPdt ?? 0);

  if (!uris.length) issues.push({ code: 'no-segments', message: 'live playlist has no segments' });
  const dup = uris.find((u, i) => uris.indexOf(u) !== i);
  if (dup) issues.push({ code: 'dup-uri', message: `duplicate segment URI in the playlist: ${dup}` });
  for (let i = 1; i < pdts.length; i++) {
    if (pdts[i] < pdts[i - 1]) { issues.push({ code: 'pdt-backwards', message: 'PROGRAM-DATE-TIME goes backwards inside the playlist' }); break; }
  }
  if (prev) {
    if (seq < prev.seq) issues.push({ code: 'seq-regress', message: `media sequence went backwards (${prev.seq} → ${seq})` });
    if (prev.lastPdt && lastPdt && lastPdt < prev.lastPdt) {
      issues.push({ code: 'pdt-backwards', message: 'PROGRAM-DATE-TIME went backwards between polls' });
    }
    if (prev.lastPdt && lastPdt && lastPdt - prev.lastPdt > 30_000) {
      issues.push({ code: 'pdt-jump', message: `PROGRAM-DATE-TIME jumped ${Math.round((lastPdt - prev.lastPdt) / 1000)}s` });
    }
  }
  return { issues, seq, uris, lastPdt, segments: uris.length };
}

class RadioMonitor {
  state: RadioMonitorState;
  private timer: NodeJS.Timeout | null = null;
  private prevPlaylist: { seq: number; uris: string[]; lastPdt: number } | null = null;
  private lastAnalysed = '';
  private lastPlaylistMtime = 0;
  private lastPlaylistChangeAt = Date.now();
  private stalledRaised = false;
  private busy = false;

  /**
   * FOLLOW THE RUN, DO NOT BE PINNED TO ONE.
   *
   * `runId` is null when the monitor is following whatever run is current,
   * which is the only thing it CAN do for a containerised station: the
   * container chooses its own run id and writes current_run.txt, so the
   * orchestrator that launched it never learns the id. Following also means a
   * run roll (the daily recording boundary) is picked up rather than leaving
   * the monitor watching a directory nothing writes to any more.
   *
   * The legacy in-process path still passes an explicit id, and gets exactly
   * the behaviour it had.
   */
  constructor(public channelId: string, public runId: string | null) {
    this.state = {
      channelId, runId: runId ?? null, levels: [], verdict: 'unknown', lastSampleAt: null,
      segments: 0, outputFreshMs: null, issues: [], checks: { ok: 0, failed: 0 },
      silenceSinceMs: null, staticSinceMs: null,
    };
  }

  start() {
    void this.tick();
    this.timer = setInterval(() => { void this.tick(); }, 4000);
    this.timer.unref?.();
  }
  stop() { if (this.timer) clearInterval(this.timer); this.timer = null; }

  /** The run this tick is about: the pinned one, or whatever is current now. */
  private resolveRun(): string | null {
    if (this.runId) return this.runId;
    const cur = currentRunId(this.channelId);
    if (cur && cur !== this.followed) {
      // A NEW RUN IS A NEW MEASUREMENT. Carrying the previous run's playlist
      // sequence and analysis marker across the boundary would report a
      // discontinuity as a fault, when a fresh run is exactly what a restart
      // is supposed to produce.
      this.followed = cur;
      this.prevPlaylist = null;
      this.lastAnalysed = '';
      this.lastPlaylistMtime = 0;
      this.lastPlaylistChangeAt = Date.now();
      this.state.runId = cur;
      this.state.levels = [];
      this.state.segments = 0;
    }
    return cur;
  }
  private followed: string | null = null;

  private audioDir() {
    const run = this.resolveRun();
    return run
      ? join(originBaseFor(this.channelId), 'runs', run, 'audio')
      // No run pointer yet: the container has not written one. Return a path
      // that cannot exist rather than the channel root, so a tick during the
      // gap measures nothing instead of measuring the wrong directory.
      : join(originBaseFor(this.channelId), 'runs', '__no_run__', 'audio');
  }

  private addIssue(code: QcIssue['code'], message: string) {
    const at = Date.now();
    const last = this.state.issues[this.state.issues.length - 1];
    // collapse repeats of the same code within 30s so the panel stays readable
    if (last && last.code === code && at - last.at < 30_000) { last.at = at; return; }
    this.state.issues.push({ code, message, at });
    if (this.state.issues.length > ISSUES_MAX) this.state.issues.shift();
    this.state.checks.failed++;
  }

  private async event(type: string, detail: Record<string, any>) {
    try {
      await query(
        `INSERT INTO stream_events(channel_id, type, detail, ts) VALUES ($1,$2,$3::jsonb, now())`,
        [this.channelId, type, JSON.stringify(detail)]
      );
    } catch { /* telemetry must never break the stream */ }
  }

  private async tick() {
    if (this.busy) return;
    this.busy = true;
    try {
      const dir = this.audioDir();
      const idx = join(dir, 'index.m3u8');
      const now = Date.now();

      // ---- playlist freshness + invariants -----------------------------------
      if (existsSync(idx)) {
        const mtime = statSync(idx).mtimeMs;
        if (mtime !== this.lastPlaylistMtime) { this.lastPlaylistMtime = mtime; this.lastPlaylistChangeAt = now; }
        this.state.outputFreshMs = now - this.lastPlaylistChangeAt;
        const text = readFileSync(idx, 'utf8');
        const r = playlistIssues(text, this.prevPlaylist);
        this.prevPlaylist = { seq: r.seq, uris: r.uris, lastPdt: r.lastPdt };
        this.state.segments = r.segments;
        if (r.issues.length) for (const i of r.issues) this.addIssue(i.code, i.message);
        else this.state.checks.ok++;

        const stalled = this.state.outputFreshMs > 15_000;
        if (stalled && !this.stalledRaised) {
          this.stalledRaised = true;
          this.addIssue('stale', `live playlist has not advanced for ${Math.round(this.state.outputFreshMs / 1000)}s`);
          await this.event('output.stalled', { message: `no new audio segments for ${Math.round(this.state.outputFreshMs / 1000)}s` });
        } else if (!stalled && this.stalledRaised) {
          this.stalledRaised = false;
          await this.event('output.resumed', { message: 'audio segments advancing again' });
        }
      } else {
        this.state.outputFreshMs = null;
      }

      // ---- level / content QC on the newest COMPLETE segment ------------------
      const init = join(dir, 'init.mp4');
      let segs: string[] = [];
      try { segs = readdirSync(dir).filter((f) => /^seg_\d+\.m4s$/.test(f)).sort(); } catch { /* not yet */ }
      // The last file is still being written; everything before it is complete.
      // ANALYSE EVERY COMPLETE SEGMENT WE HAVE NOT SEEN, not just the newest.
      // Segments and this 4s tick are not phase-locked, so two segments
      // regularly land in one tick; measuring only the newest dropped the
      // other, and the meter then showed a gap where the feed was in fact
      // loud. Bounded so a stall cannot turn into a burst of ffmpeg runs.
      const complete = segs.slice(0, -1);
      const startAt = this.lastAnalysed ? complete.indexOf(this.lastAnalysed) + 1 : Math.max(0, complete.length - 1);
      const pending = complete.slice(startAt).slice(-3);
      for (const target of pending) {
        if (!existsSync(init)) break;
        this.lastAnalysed = target;
        const s = analyseSegment(init, join(dir, target));
        if (s) {
          this.state.levels.push(s);
          if (this.state.levels.length > WINDOW) this.state.levels.shift();
          this.state.verdict = s.verdict;
          this.state.lastSampleAt = s.t;

          // sustained silence -> event + QC issue (the "are we broadcasting dead air" alarm)
          if (s.verdict === 'silent') {
            this.state.silenceSinceMs = this.state.silenceSinceMs ?? s.t;
            const held = s.t - this.state.silenceSinceMs;
            if (held >= SILENCE_ALERT_MS && !this.silenceRaised) {
              this.silenceRaised = true;
              this.addIssue('silence', `dead air: no audio for ${Math.round(held / 1000)}s`);
              await this.event('qc.silence', { message: `dead air for ${Math.round(held / 1000)}s`, rms_db: s.rmsDb });
            }
          } else {
            if (this.silenceRaised) await this.event('qc.recovered', { message: 'audio returned after dead air' });
            this.silenceRaised = false;
            this.state.silenceSinceMs = null;
          }

          // sustained noise-like signal -> "receiving something, but it looks like static"
          if (s.verdict === 'static') {
            this.state.staticSinceMs = this.state.staticSinceMs ?? s.t;
            const held = s.t - this.state.staticSinceMs;
            if (held >= STATIC_ALERT_MS && !this.staticRaised) {
              this.staticRaised = true;
              this.addIssue('static', `signal looks like noise/static for ${Math.round(held / 1000)}s (entropy ${s.entropy.toFixed(2)}, crest ${s.crestDb.toFixed(1)}dB)`);
              await this.event('qc.static', { message: 'output looks like static rather than programme audio', entropy: s.entropy, crest_db: s.crestDb });
            }
          } else {
            if (this.staticRaised) await this.event('qc.recovered', { message: 'programme audio detected again' });
            this.staticRaised = false;
            this.state.staticSinceMs = null;
          }
        }
      }

      // ---- ICY metadata stall (icecast sources only) --------------------------
      const icy = icyState(this.channelId);
      if (icy && icy.connected === false && icy.lastError) {
        this.addIssue('icy-stall', `metadata connection lost: ${icy.lastError}`);
      }

      // ---- telemetry: keep stream_status honest so the gates read it ----------
      const outputAvailable = (this.state.outputFreshMs ?? 1e9) < 15_000 && this.state.segments > 0;
      const srcState = outputAvailable
        ? { primary: { state: 'up', detail: icy?.station?.name ? `receiving · ${icy.station.name}` : 'receiving' } }
        : { primary: { state: 'starting', detail: 'waiting for audio' } };
      await query(
        `INSERT INTO stream_status(channel_id, output_available, active_source, packager_ok, sources, updated_at)
         VALUES ($1,$2,'primary',$2,$3::jsonb, now())
         ON CONFLICT (channel_id) DO UPDATE SET
           output_available=EXCLUDED.output_available, packager_ok=EXCLUDED.packager_ok,
           sources=EXCLUDED.sources, updated_at=now()`,
        [this.channelId, outputAvailable, JSON.stringify(srcState)]
      ).catch(() => {});
    } catch {
      /* monitoring is best-effort; never take the stream down */
    } finally {
      this.busy = false;
    }
  }

  private silenceRaised = false;
  private staticRaised = false;
}

/**
 * Start measuring a station's OUTPUT.
 *
 * `runId` omitted means "follow whatever run is current", which is what a
 * containerised station needs: the container picks its own run id, so the
 * caller launching it has nothing to pass.
 *
 * THIS EXISTS ON BOTH PATHS NOW. It used to be called only from the in-process
 * pipeline, so moving radio into containers silently took the level meter, the
 * QC verdict and silence detection with it: the console polled for levels and
 * got an empty array for ever, and the waveform never moved. The measurement
 * reads the packaged output off disk and does not care which process wrote it,
 * so there was never a reason for it to live on one path only.
 */
export function startRadioMonitor(channelId: string, runId?: string | null): void {
  stopRadioMonitor(channelId);
  const m = new RadioMonitor(channelId, runId ?? null);
  monitors.set(channelId, m);
  m.start();
}

export function stopRadioMonitor(channelId: string): void {
  const m = monitors.get(channelId);
  if (m) { m.stop(); monitors.delete(channelId); }
}

export function radioMonitorState(channelId: string): RadioMonitorState | null {
  return monitors.get(channelId)?.state ?? null;
}

/** Compact levels feed for the UI visualiser (newest last). */
export function radioLevels(channelId: string, limit = 60): {
  verdict: SignalVerdict; lastSampleAt: number | null; samples: LevelSample[];
} {
  const s = monitors.get(channelId)?.state;
  if (!s) return { verdict: 'unknown', lastSampleAt: null, samples: [] };
  return { verdict: s.verdict, lastSampleAt: s.lastSampleAt, samples: s.levels.slice(-limit) };
}
