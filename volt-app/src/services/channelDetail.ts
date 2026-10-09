// Builds the detail payload for a channel's control page from REAL state only:
// effective DVR window, sources, rendition ladder, captions, plus telemetry read
// from the actual tables — stream_status (encoder health/signal), stream_events
// (event log) and programmes (EPG). No fabricated data: when nothing is reporting
// yet, the fields are empty/idle so the UI shows honest "no signal / no EPG /
// no data" states rather than invented numbers.
import { encoderRunning, LOCKED_WHILE_RUNNING } from './settingsLock';
import { one, query } from '../db';
import { config } from '../config';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { liveDirFor } from './liveOrigin';
import { computePipelineHealth, recoveryOf, type PipelineHealth } from './pipelineHealth';
import { recommendInstance, buildBilling, type Billing } from './billing';

const DVR_MAX_SEC = 14400; // 4h cap for 24x7 channels

export interface ChannelDetail {
  kind: 'channel';
  group: { id: string; name: string } | null;
  profile: any | null;
  dvr: { effective_sec: number; max_sec: number; mode: string; source: 'channel' | 'profile'; capped: boolean };
  captions: { enabled: boolean; targets: string[]; source_lang: string };
  epgEnabled: boolean;
  /** Put this channel back on air after a control-plane restart. */
  autoConnect: boolean;
  /** Content type + its metadata: the base entry when no programme is on. */
  schemaId: string | null;
  metadata: Record<string, any>;
  /** Whether it is MEANT to be running, which survives a crash. */
  desiredState: 'running' | 'stopped';
  /** An encoder instance is up: the settings it reads at start are locked (services/settingsLock.ts). */
  encoderRunning: boolean;
  /** Request-body keys that are locked while it runs. */
  lockedWhileRunning: string[];
  /** Set only when auto-connect has stopped trying; carries the reason. */
  resumeGaveUpAt: string | null;
  resumeLastError: string | null;
  /** Set once this run showed server, input, encoder and output all healthy:
   *  only then will auto connect put it back after a fault. */
  resumeArmedAt: string | null;
  resumeAttempts: number;
  ladder: { height: number; bitrate_kbps: number }[];
  sources: any[];
  viewers: { current: number; peak: number; peakAt: string; trendPct: number; series: { t: number; v: number }[] };
  epg: { now: any; next: any; lane: any[] };
  statusBoard: { output: string; activeSource: string; fallback: string; packager: string; inputs: any[] };
  log: { ts: string; level: string; title: string; detail: string }[];
  health: PipelineHealth;
  billing: Billing;
  degraded?: boolean;
  onAir: boolean;
  public: { url: string; dashUrl: string; available: boolean };
  watermark: { enabled: boolean; ref: string | null; position: string; offsetX: number; offsetY: number; opacity: number; scale: number };
}

function pad(n: number) { return String(n).padStart(2, '0'); }
function hhmm(ms: number) { const d = new Date(ms); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; }
function packagingLabel(profile: any): string {
  const p = profile?.packaging;
  if (p === 'hls') return 'HLS';
  if (p === 'dash') return 'DASH';
  return 'HLS + DASH';
}

// Surface the REAL encoder failures (ffmpeg / source / packager errors) from the
// on-box encoder.log so the event log shows WHY a source or output failed, not just
// lifecycle events. Local mode writes this file into the origin dir; ignored otherwise.
function encoderLogTail(channelId: string): { ts: string; level: string; title: string; detail: string }[] {
  try {
    const p = join(config.testStream.originDir, channelId, 'encoder.log');
    if (!existsSync(p)) return [];
    const allLines = readFileSync(p, 'utf8').split(/\r?\n/).filter(Boolean);
    // encoder.log is APPENDED across runs. Only THIS run's lines may surface: errors
    // from a previous run painted a flash of red on every clean start. The encoder
    // prints a run banner at boot; scope the tail to the last banner onward.
    let lastStart = -1;
    for (let i = allLines.length - 1; i >= 0; i--) {
      if (allLines[i].includes('[volt-encoder] channel=')) { lastStart = i; break; }
    }
    const lines = lastStart >= 0 ? allLines.slice(lastStart) : allLines;
    const rx = /FATAL|error|Error|Unknown|Could not|No such|Invalid|failed|Connection|Server returned|Immediate exit|not found|Unsupported|Cannot|denied|refused|timed out|timeout/i;
    const bad = /FATAL|Could not|No such|failed|Server returned|Unsupported|Invalid|not found|denied|refused/i;
    // Spawn announcements ('[volt-encoder] start <name>: ffmpeg ... -loglevel error ...')
    // quote the ffmpeg command, so the substring 'error' matches and a NORMAL start-up
    // line gets surfaced as an input failure. A command echo is never an error: skip them.
    const spawn = /^\[volt-encoder\]\s+start\s+[\w:.<>-]+:/;
    // Probe noise: reading a multi-variant HLS master, ffmpeg reports 'could not find
    // codec parameters' for every rendition it probed but never downloaded. Harmless
    // start-up chatter, not a fault: keep it out of the error feed entirely.
    const probeNoise = /Could not find codec parameters/i;
    return lines.filter((l) => rx.test(l) && !spawn.test(l) && !probeNoise.test(l)).slice(-10).map((l) => ({
      ts: 'encoder',
      level: bad.test(l) ? 'down' : 'warn',
      title: 'Encoder',
      detail: l.replace(/^\[volt-encoder\]\s*/, '').slice(0, 300),
    }));
  } catch { return []; }
}

/**
 * Newest HLS/DASH manifest mtime (ms) under the stream's origin — 0 if none.
 * Shaka rewrites these on every new segment, so a recent mtime means the
 * output is advancing.
 *
 * IT MUST LOOK ONE LEVEL DOWN AS WELL. For TV, Shaka writes master.m3u8 and
 * manifest.mpd into the run root and keeps rewriting them, so the root scan
 * was enough. Radio does not work that way: the run-root master.m3u8 is
 * written ONCE at start and ffmpeg advances audio/index.m3u8 in a
 * subdirectory. Scanning only the root therefore measured the age of a file
 * that never changes, and every healthy station's output age grew from the
 * moment it started — degraded after fifteen seconds, "no new segments for
 * 3600s" after an hour. The radio detail page read the right file and said
 * healthy, so the channels list and the live board contradicted it all day.
 */
function newestManifestMtimeMs(channelId: string): number {
  const newestIn = (dir: string): number => {
    let newest = 0;
    try {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        if (e.isFile() && (e.name.endsWith('.m3u8') || e.name.endsWith('.mpd'))) {
          try { const m = statSync(join(dir, e.name)).mtimeMs; if (m > newest) newest = m; } catch { /* ignore */ }
        }
      }
    } catch { /* ignore */ }
    return newest;
  };
  try {
    const dir = liveDirFor(channelId);   // per-run namespace: probe the CURRENT run
    let newest = newestIn(dir);
    // One level of rendition directories (audio/, 720p/, …). Not deeper: the
    // point is to find the playlist a packager is rewriting, and those live
    // beside their segments.
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (!e.isDirectory()) continue;
      const m = newestIn(join(dir, e.name));
      if (m > newest) newest = m;
    }
    return newest;
  } catch { return 0; }
}

/** Compute the SAME five-gate health used by the detail page, but with only the loads
 *  it needs, so the channels LIST shows a status that never disagrees with the detail.
 *  Per channel: one stream_status row, recent events, the encoder log tail, and the
 *  manifest mtime (ground truth). Returns the health (incl. the `overall` roll-up). */
/** launched_at (ms) of the running encoder instance, or null when none is running.
 *  Status/events older than this belong to a PREVIOUS run: using them while a new run
 *  boots painted a flash of stale errors on every clean start. */
export async function runningSinceMs(channelId: string, kind: OwnerKind = 'channel'): Promise<number | null> {
  const col = kind === 'event' ? 'event_id' : 'channel_id';
  const inst = await one<any>(
    `SELECT min(launched_at) AS since FROM instances WHERE ${col} = $1 AND terminated_at IS NULL`,
    [channelId]);
  return inst?.since ? new Date(inst.since).getTime() : null;
}

/** Channels and events run the SAME encoder and report through the SAME tables;
 *  only the owning column differs. Everything keyed by the owner's id on disk
 *  (the origin dir, encoder.log, the manifests) is identical for both. */
export type OwnerKind = 'channel' | 'event';
const RUN_GRACE_MS = 2000;

export function scopeToRun<T extends { ts: string }>(evs: T[], runSince: number | null): T[] {
  if (!runSince) return evs;
  return evs.filter((e) => new Date(e.ts).getTime() >= runSince - RUN_GRACE_MS);
}

export function scopeStatusToRun(st: any, runSince: number | null): any {
  if (!st || !runSince) return st;
  const upd = st.updated_at ? new Date(st.updated_at).getTime() : 0;
  return upd < runSince - RUN_GRACE_MS ? null : st;   // stale report from the previous run
}

export async function loadChannelHealthLite(
  channel: any, nowMs: number, kind: OwnerKind = 'channel'
): Promise<PipelineHealth> {
  const col = kind === 'event' ? 'event_id' : 'channel_id';
  const runSince = await runningSinceMs(channel.id, kind);
  const st = scopeStatusToRun(await one<any>(
    `SELECT output_available, active_source, fallback_in_use, filler_in_use, packager_ok, sources, updated_at
       FROM stream_status WHERE ${col} = $1`, [channel.id]), runSince);
  const evs = scopeToRun(await query<any>(
    `SELECT seq, type, detail, ts FROM stream_events WHERE ${col} = $1 ORDER BY ts DESC LIMIT 30`, [channel.id]), runSince);
  const encTail = encoderLogTail(channel.id);
  const logTailErrors = encTail.filter((l) => l.level === 'down' || l.level === 'warn').map((l) => l.detail).reverse();
  const outMtime = newestManifestMtimeMs(channel.id);
  const outputAgeMs = outMtime > 0 ? (nowMs - outMtime) : null;
  const sstates: Record<string, any> = (st && st.sources && typeof st.sources === 'object') ? st.sources : {};
  return computePipelineHealth({
    ownerStatus: channel.status,
    st,
    events: evs,
    runStartedAt: runSince,
    logTailErrors,
    hasPrimarySource: Object.keys(sstates).length > 0,
    packagingLabel: '',
    outputFresh: outputAgeMs != null ? outputAgeMs < 15000 : false,
    outputAgeMs,
    onAirPublished: channel.on_air === true,
    recovery: recoveryOf(channel),
  });
}

export async function buildChannelDetail(channel: any, nowMs: number): Promise<ChannelDetail> {
  const group = channel.group_id
    ? await one<any>('SELECT id, name, output_profile_id FROM groups WHERE id = $1', [channel.group_id])
    : null;
  const profile = group?.output_profile_id
    ? await one<any>('SELECT * FROM output_profiles WHERE id = $1', [group.output_profile_id])
    : null;
  const sources = await query<any>('SELECT * FROM stream_inputs WHERE channel_id = $1 ORDER BY role', [channel.id]);

  // effective DVR window: per-channel override wins, else profile default, capped at 4h
  const profDefault = profile?.dvr_window_sec ?? 300;
  const chanOverride: number | null = channel.dvr_window_sec ?? null;
  const rawEffective = chanOverride ?? profDefault;
  const effective = Math.min(rawEffective, DVR_MAX_SEC);
  const dvr = {
    effective_sec: effective,
    max_sec: DVR_MAX_SEC,
    mode: channel.dvr_mode || 'sliding',
    source: (chanOverride != null ? 'channel' : 'profile') as 'channel' | 'profile',
    capped: rawEffective > DVR_MAX_SEC,
  };

  const ladder: { height: number; bitrate_kbps: number }[] =
    Array.isArray(channel.output_ladder) ? channel.output_ladder
    : Array.isArray(profile?.rungs) ? profile.rungs : [];
  const captions = {
    enabled: !!profile?.captions_enabled,
    targets: Array.isArray(profile?.caption_targets) ? profile.caption_targets : [],
    source_lang: profile?.caption_source_lang || 'auto',
    // lip-sync trim in seconds (positive = cues later); operator-tunable in Settings
    offset_sec: Number(profile?.caption_offset_sec ?? 0),
  };

  // ---- REAL status (latest encoder report), REAL events, REAL EPG -----------
  // Everything is scoped to the CURRENT run: a freshly launched encoder must not be
  // painted with the previous run's status row, events or log lines (the start-up
  // error flash). runSince also feeds billing below.
  const runSince = await runningSinceMs(channel.id);
  const st = scopeStatusToRun(await one<any>(
    `SELECT output_available, active_source, fallback_in_use, filler_in_use, packager_ok, sources, updated_at
       FROM stream_status WHERE channel_id = $1`, [channel.id]), runSince);
  const reporting = !!st;
  const outputAvailable = !!st?.output_available;
  const seg = Number(profile?.segment_dur ?? 4).toFixed(1);
  const sstates: Record<string, any> = (st && st.sources && typeof st.sources === 'object') ? st.sources : {};

  // event log — real stream_events, newest first; empty when none
  const evs = scopeToRun(await query<any>(
    `SELECT seq, type, detail, ts FROM stream_events WHERE channel_id = $1 ORDER BY ts DESC LIMIT 30`, [channel.id]), runSince);

  // real encoder-log error lines (newest-first), shared by the log view + health model
  const encTail = encoderLogTail(channel.id);
  const logTailErrors = encTail
    .filter((l) => l.level === 'down' || l.level === 'warn')
    .map((l) => l.detail)
    .reverse(); // encTail is oldest→newest; health wants newest-first

  // FIVE-GATE HEALTH (server → input → encoder → output → public): the single
  // source of truth for the badge, the primary error banner, and the QC page.
  // ground truth: is the origin manifest advancing right now? (within ~3 segments)
  const segDur = Number(profile?.segment_dur ?? 4) || 4;
  const outMtime = newestManifestMtimeMs(channel.id);
  const outputFresh = outMtime > 0 && (nowMs - outMtime) < Math.max(15000, segDur * 3 * 1000);
  const health = computePipelineHealth({
    ownerStatus: channel.status,
    st,
    events: evs,
    runStartedAt: runSince,
    logTailErrors,
    hasPrimarySource: sources.some((s: any) => s.role === 'primary' && s.ingest_url) || sources.length > 0,
    packagingLabel: packagingLabel(profile),
    outputFresh,
    outputAgeMs: outMtime > 0 ? (nowMs - outMtime) : null,
    onAirPublished: channel.on_air === true,
    recovery: recoveryOf(channel),
  });
  // back-compat: `degraded` now means "a gate is failed or degraded" (a REAL problem,
  // not merely 'starting'). This kills the false OUTPUT ERROR during warm-up.
  const degraded = !!health.primaryError;

  // billing: the encoder SERVER is the billable unit. Metering runs while the
  // channel is live; `since` = when the running encoder task launched (runSince).
  const serverUp = channel.status === 'live';
  const sinceMs = runSince;
  const billing = buildBilling(serverUp, sinceMs, nowMs, recommendInstance(profile?.workflow_type, ladder));

  const outGate = health.gates.find((g) => g.gate === 'output')!;
  const encGate = health.gates.find((g) => g.gate === 'encoder')!;
  const statusBoard = {
    output: outGate.status === 'healthy' ? `Available · ${packagingLabel(profile)}`
          : outGate.status === 'degraded' ? `Degraded · ${outGate.detail}`
          : outGate.status === 'failed' ? `Error · ${outGate.detail}`
          : outGate.status === 'starting' ? 'Starting…'
          : outGate.status === 'stopped' ? 'Stopped' : 'Idle',
    activeSource: st?.active_source || '—',
    fallback: st?.fallback_in_use ? 'Engaged' : 'Not engaged',
    packager: encGate.status === 'healthy' ? `Healthy · ${seg}s segments`
            : encGate.status === 'failed' ? `Error · ${encGate.detail}`
            : encGate.status === 'starting' ? 'Starting…'
            : channel.status === 'live' ? 'Starting…' : 'Stopped',
    inputs: (sources.length ? sources : []).map((s: any) => {
      const ss = sstates[s.role] || sstates[s.rendition_label] || null;
      const up = ss?.state === 'up';
      return {
        role: s.role,
        protocol: (s.protocol || '').toUpperCase(),
        state: up ? 'live' : (reporting ? 'down' : 'idle'),
        detail: up ? (ss?.detail || 'receiving')
              : reporting ? (ss?.detail || 'no signal')
              : (s.ingest_url ? 'configured · idle' : 'no source configured'),
      };
    }),
  };

  const levelFor = (t: string) =>
    /down|error|fail|loss/i.test(t) ? 'down'
    : /warn|drop|spike|degrad/i.test(t) ? 'warn'
    : /up|start|recover|live|packager/i.test(t) ? 'live' : 'sched';
  const eventsLog = evs.map((e: any) => {
    let detail = '';
    try { detail = typeof e.detail === 'string' ? e.detail : JSON.stringify(e.detail ?? {}); } catch { detail = ''; }
    if (detail === '{}') detail = '';
    return { ts: hhmm(new Date(e.ts).getTime()), level: levelFor(String(e.type)), title: String(e.type), detail };
  });

  const log = [...encTail, ...eventsLog];

  // EPG — real programmes around now; empty when the channel has no schedule
  const progs = await query<any>(
    `SELECT id, title, starts_at, ends_at FROM programmes
       WHERE channel_id = $1 AND ends_at > now() - interval '2 hours' AND starts_at < now() + interval '8 hours'
       ORDER BY starts_at`, [channel.id]);
  let nowObj: any = null; let nextObj: any = null;
  const lane = progs.map((p: any) => {
    const s = new Date(p.starts_at).getTime(); const en = new Date(p.ends_at).getTime();
    const mins = Math.max(1, Math.round((en - s) / 60000));
    const isNow = nowMs >= s && nowMs < en;
    const state = en <= nowMs ? 'past' : isNow ? 'now' : '';
    const entry: any = { name: p.title, start: hhmm(s), end: hhmm(en), mins, state };
    if (isNow) { entry.progress = Math.round(((nowMs - s) / (en - s)) * 100); nowObj = { ...entry, elapsedMin: Math.floor((nowMs - s) / 60000) }; }
    return entry;
  });
  const nextRow = progs.find((p: any) => new Date(p.starts_at).getTime() > nowMs);
  if (nextRow) nextObj = { name: nextRow.title, start: hhmm(new Date(nextRow.starts_at).getTime()) };
  const epg = { now: nowObj, next: nextObj, lane };

  // viewers — real analytics only; empty until wired/there is live data (no fabrication)
  const viewers = { current: 0, peak: 0, peakAt: '', trendPct: 0, series: [] as { t: number; v: number }[] };

  // Public delivery: the on-air state + the public playback URL a viewer/app would use.
  // available = the public URL would actually serve right now (published + valid content).
  const onAir = channel.on_air === true;
  const publicBlock = {
    url: `/live/${channel.id}/master.m3u8`,
    dashUrl: `/live/${channel.id}/manifest.mpd`,
    available: onAir && health.onAir,
  };

  return {
    kind: 'channel', group: group ? { id: group.id, name: group.name } : null, profile, dvr, captions,
    epgEnabled: channel.epg_enabled !== false,
    autoConnect: channel.auto_connect !== false,
    schemaId: channel.schema_id ?? null,
    metadata: (channel.metadata && typeof channel.metadata === 'object') ? channel.metadata : {},
    desiredState: (channel.desired_state ?? 'stopped') as 'running' | 'stopped',
    encoderRunning: await encoderRunning(channel.id),
    lockedWhileRunning: Object.keys(LOCKED_WHILE_RUNNING),
    resumeGaveUpAt: channel.resume_gave_up_at ?? null,
    resumeLastError: channel.resume_last_error ?? null,
    resumeArmedAt: channel.resume_armed_at ?? null,
    resumeAttempts: Number(channel.resume_attempts ?? 0) || 0,
    ladder, sources, viewers, epg, statusBoard, log, health, billing, degraded,
    onAir, public: publicBlock,
    watermark: {
      enabled: channel.watermark_enabled === true,
      ref: channel.watermark_ref ?? null,
      position: channel.watermark_position ?? 'br',
      offsetX: channel.watermark_offset_x ?? 24,
      offsetY: channel.watermark_offset_y ?? 24,
      opacity: channel.watermark_opacity ?? 100,
      scale: channel.watermark_scale ?? 12,
    },
  };
}

export { DVR_MAX_SEC };
