// Builds the detail payload for a channel's control page from REAL state only:
// effective DVR window, sources, rendition ladder, captions, plus telemetry read
// from the actual tables — stream_status (encoder health/signal), stream_events
// (event log) and programmes (EPG). No fabricated data: when nothing is reporting
// yet, the fields are empty/idle so the UI shows honest "no signal / no EPG /
// no data" states rather than invented numbers.
import { encoderRunning, LOCKED_WHILE_RUNNING } from './settingsLock';
import { one, query } from '../db';
import { config } from '../config';
import { existsSync, readFileSync, readdirSync, statSync, openSync, fstatSync, readSync, closeSync } from 'node:fs';
import { join } from 'node:path';
import { liveDirFor } from './liveOrigin';
import { fleetContext } from './fleetContext';
import { computePipelineHealth, recoveryOf, type PipelineHealth } from './pipelineHealth';
import { recommendInstance, buildBilling, type Billing } from './billing';
import { serverStatusFor, type ServerStatus } from './fleet/serverStatus';
import { splitStamp, foldRepeats, newestFirst, type EncoderLogRow } from './encoderLog';
import { epgLane } from './epgLane';

const DVR_MAX_SEC = 14400; // 4h cap for 24x7 channels

/**
 * CPU AND BYTES RECEIVED for the run in progress, from numbers already kept:
 *
 *   cpu     the encoder's own reading of its processes (its ten-second
 *           heartbeat, stream_metrics.py), as a share of the CPU it may use.
 *           An encoder that cannot measure itself (a Mac running it natively)
 *           sends none, and the host's sampled CPU stands in, marked as the
 *           whole machine, with how many streams share it.
 *   ingest  bytes each input has received since the run started, and the
 *           rate over the last heartbeat.
 *
 * A reading older than a minute is dropped rather than shown as current.
 */
/**
 * REALTIME VIEWERS for the channel page, from the same session beacons every
 * report uses (services/analytics.ts): now (the live concurrency), the last
 * hour minute by minute (from play_sessions), the change against an hour ago
 * and today's peak. Share-link previews count, console previews do not (the
 * console's players send no beacons). Zero is a real zero here: there is
 * always a reading, and an empty hour reads as an empty hour.
 */
export async function channelViewers(accountId: string | null, id: string, kind: 'channel' | 'event') {
  const { liveConcurrency } = await import('./analytics');
  const current = await liveConcurrency(kind, id).catch(() => 0);
  const rows = accountId ? await query<{ t: string; v: number }>(
    `SELECT m AS t, (SELECT count(*)::int FROM play_sessions s
                      WHERE s.account_id = $1 AND s.asset_kind = $2 AND s.asset_id = $3
                        AND s.started_at <= m AND COALESCE(s.ended_at, s.last_seen_at) >= m - interval '30 seconds') AS v
       FROM generate_series(date_trunc('minute', now()) - interval '60 minutes', date_trunc('minute', now()), interval '1 minute') AS m`,
    [accountId, kind, id]).catch(() => []) : [];
  const series = rows.map((r) => ({ t: new Date(r.t).getTime(), v: Number(r.v) }));
  if (series.length) series[series.length - 1].v = Math.max(series[series.length - 1].v, current);
  const hourAgo = series[0]?.v ?? 0;
  const trendPct = hourAgo > 0 ? Math.round(((current - hourAgo) / hourAgo) * 100) : (current > 0 ? 100 : 0);
  const today = accountId ? await one<{ peak_concurrent: number }>(
    `SELECT peak_concurrent FROM analytics_rollups WHERE account_id = $1 AND scope = $2 AND scope_id = $3 AND bucket_date = current_date`,
    [accountId, kind, id]).catch(() => null) : null;
  let peak = Math.max(Number(today?.peak_concurrent ?? 0), current, ...series.map((p) => p.v));
  let peakAt = '';
  const top = series.reduce((a, p) => (p.v >= (a?.v ?? -1) ? p : a), null as null | { t: number; v: number });
  if (top && top.v === peak) peakAt = new Date(top.t).toISOString();
  return { current, peak, peakAt, trendPct, series };
}

export interface StreamMetricsView {
  cpu: { pct: number; cores: number | null; source: 'encoder' | 'host'; tasksOnHost?: number | null; atMs: number } | null;
  ingest: { key: string; role: string | null; label: string | null; bytes: number | null; bps: number | null }[];
  ingestAtMs: number | null;
}
export async function streamMetrics(channelId: string, st: any, kind: OwnerKind = 'channel'): Promise<StreamMetricsView> {
  const m = st?.metrics ?? null;
  const fresh = m?.at_ms && Date.now() - Number(m.at_ms) < 60_000;
  let cpu: StreamMetricsView['cpu'] = null;
  if (fresh && typeof m.cpu_pct === 'number') cpu = { pct: m.cpu_pct, cores: m.cpu_cores ?? null, source: 'encoder', atMs: Number(m.at_ms) };
  else {
    const h = await one<any>(
      `SELECT hs.cpu_pct, hs.tasks_on_host, hs.at FROM instances i JOIN host_samples hs ON hs.host_id = i.host_id
        WHERE i.${kind === 'event' ? 'event_id' : 'channel_id'} = $1 AND i.terminated_at IS NULL AND hs.cpu_pct IS NOT NULL
          AND hs.at > now() - interval '5 minutes'
        ORDER BY hs.at DESC LIMIT 1`, [channelId]).catch(() => null);
    if (h) cpu = { pct: Number(h.cpu_pct), cores: null, source: 'host', tasksOnHost: h.tasks_on_host ?? null, atMs: new Date(h.at).getTime() };
  }
  const ingest = fresh && m.ingest && typeof m.ingest === 'object'
    ? Object.entries(m.ingest).map(([key, v]: [string, any]) => ({ key, role: v?.role ?? null, label: v?.label ?? null, bytes: v?.bytes ?? null, bps: v?.bps ?? null }))
    : [];
  return { cpu, ingest, ingestAtMs: fresh ? Number(m.at_ms) : null };
}

export interface ChannelDetail {
  kind: 'channel' | 'event';
  metrics: StreamMetricsView | null;
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
  log: { ts: string; at?: string | null; firstAt?: string | null; count?: number; level: string; title: string; detail: string }[];
  health: PipelineHealth;
  billing: Billing;
  /** Is there a server for it, and if anything is wrong, what to do (no load figures). */
  server: ServerStatus;
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
function readTail(path: string, bytes: number): string {
  const fd = openSync(path, 'r');
  try {
    const size = fstatSync(fd).size;
    const len = Math.min(size, bytes);
    const buf = Buffer.alloc(len);
    readSync(fd, buf, 0, len, size - len);
    const text = buf.toString('utf8');
    // drop a partial first line when we started mid-file
    return len < size ? text.slice(text.indexOf('\n') + 1) : text;
  } finally { closeSync(fd); }
}

function encoderLogTail(channelId: string): EncoderLogRow[] {
  try {
    const p = join(config.testStream.originDir, channelId, 'encoder.log');
    if (!existsSync(p)) return [];
    // ONLY THE TAIL. encoder.log grows for as long as the stream runs, and this
    // is read for every stream on every board refresh. The newest 256 KB holds
    // far more than the ten lines kept; when the run banner is older than that,
    // everything in the window belongs to this run anyway.
    const allLines = readTail(p, 256 * 1024).split(/\r?\n/).filter(Boolean);
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
    // Each line's time comes off the front first (encoderLog.ts), so the
    // anchored patterns below see the text exactly as before.
    const rows = lines.map(splitStamp)
      .filter(({ text }) => rx.test(text) && !spawn.test(text) && !probeNoise.test(text))
      .map(({ at, text }): EncoderLogRow => ({
        ts: at ? hhmm(Date.parse(at)) : 'encoder',
        at,
        count: 1,
        level: bad.test(text) ? 'down' : 'warn',
        title: 'Encoder',
        detail: text.replace(/^\[volt-encoder\]\s*/, '').slice(0, 300),
      }));
    // Fold repeats BEFORE keeping ten, so one message written fifty times
    // cannot push every other line out of the window.
    return foldRepeats(rows).slice(-10);
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
    // TV: the packager rewrites the root playlists every segment, so a fresh root
    // answers the question without listing the rendition folders, which hold
    // every recorded segment (tens of thousands a day).
    if (newest > 0 && Date.now() - newest < 15000) return newest;
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
    fleet: await fleetContext(),
  });
}

export async function buildChannelDetail(channel: any, nowMs: number): Promise<ChannelDetail> {
  return buildStreamDetail(channel, nowMs, 'channel');
}

/**
 * THE DETAIL OF ONE STREAM, channel or event (22 Oct 2026). Channels and events
 * run the same encoder and report through the same tables keyed by a different
 * column, so the event page is built by the same code as the channel page
 * rather than a copy that would drift. What differs is stated where it is
 * used: events have no on-air switch (they are public while live inside their
 * public window), no DVR or ladder override, no watermark and no EPG toggle.
 */
export async function buildStreamDetail(channel: any, nowMs: number, kind: OwnerKind): Promise<ChannelDetail> {
  const col = kind === 'event' ? 'event_id' : 'channel_id';
  const group = channel.group_id
    ? await one<any>('SELECT id, name, output_profile_id, account_id FROM groups WHERE id = $1', [channel.group_id])
    : null;
  const profile = group?.output_profile_id
    ? await one<any>('SELECT * FROM output_profiles WHERE id = $1', [group.output_profile_id])
    : null;
  const sources = await query<any>(`SELECT * FROM stream_inputs WHERE ${col} = $1 ORDER BY role`, [channel.id]);

  // effective DVR window: per-channel override wins, else profile default, capped at 4h
  const profDefault = profile?.dvr_window_sec ?? 300;
  const chanOverride: number | null = channel.dvr_window_sec ?? null;
  const rawEffective = chanOverride ?? profDefault;
  const effective = Math.min(rawEffective, DVR_MAX_SEC);
  const dvr = {
    effective_sec: effective,
    max_sec: DVR_MAX_SEC,
    mode: channel.dvr_mode || (kind === 'event' ? 'event_start' : 'sliding'),
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
  const runSince = await runningSinceMs(channel.id, kind);
  const st = scopeStatusToRun(await one<any>(
    `SELECT output_available, active_source, fallback_in_use, filler_in_use, packager_ok, sources, metrics, updated_at
       FROM stream_status WHERE ${col} = $1`, [channel.id]), runSince);
  const metrics = channel.status === 'live' ? await streamMetrics(channel.id, st, kind) : null;
  const reporting = !!st;
  const outputAvailable = !!st?.output_available;
  const seg = Number(profile?.segment_dur ?? 4).toFixed(1);
  const sstates: Record<string, any> = (st && st.sources && typeof st.sources === 'object') ? st.sources : {};

  // event log — real stream_events, newest first; empty when none
  const evs = scopeToRun(await query<any>(
    `SELECT seq, type, detail, ts FROM stream_events WHERE ${col} = $1 ORDER BY ts DESC LIMIT 30`, [channel.id]), runSince);

  // real encoder-log error lines (newest-first), shared by the log view + health model
  const encTail = encoderLogTail(channel.id);
  const logTailErrors = encTail
    .filter((l) => l.level === 'down' || l.level === 'warn')
    .map((l) => l.detail)
    .reverse(); // encTail is oldest→newest; health wants newest-first

  // PUBLISHED NOW. A channel has an on-air switch. An event has none: it is
  // public while it is live and inside its public window, the same rule the
  // public /live/<id> route applies (modules/publicLive.ts).
  const publishedNow = kind === 'event'
    ? channel.status === 'live'
      && (!channel.public_start || new Date(channel.public_start).getTime() <= nowMs)
      && (!channel.public_end || new Date(channel.public_end).getTime() > nowMs)
    : channel.on_air === true;
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
    onAirPublished: publishedNow,
    recovery: recoveryOf(channel),
    fleet: await fleetContext(),
  });
  // back-compat: `degraded` now means "a gate is failed or degraded" (a REAL problem,
  // not merely 'starting'). This kills the false OUTPUT ERROR during warm-up.
  const degraded = !!health.primaryError;

  // billing: the encoder SERVER is the billable unit. Metering runs while the
  // channel is live; `since` = when the running encoder task launched (runSince).
  const serverUp = channel.status === 'live';
  const sinceMs = runSince;
  const billing = buildBilling(serverUp, sinceMs, nowMs, recommendInstance(profile?.workflow_type, ladder));
  const server = await serverStatusFor({
    kind, id: channel.id, streamLive: serverUp,
    workflow: profile?.workflow_type ?? null, ladder, sources,
    watermark: channel.watermark_enabled === true && !!channel.watermark_ref,
    gpu: profile?.codec_backend === 'nvenc',
  });

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
        id: s.id,
        role: s.role,
        label: s.rendition_label ?? null,
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
    // Verdicts that carry their own state say it in words, not as a JSON dump.
    const dd = (e.detail && typeof e.detail === 'object') ? e.detail : {};
    if (e.type === 'output.timeline') {
      const fault = dd.state === 'fault';
      return { ts: hhmm(new Date(e.ts).getTime()), at: new Date(e.ts).toISOString(), level: fault ? 'warn' : 'live',
        title: fault ? 'Output timing fault' : 'Output timing OK',
        detail: fault ? String(dd.message || '') : `cleared: ${(dd.cleared || []).join(', ')}` };
    }
    if (e.type === 'source.waiting') {
      return { ts: hhmm(new Date(e.ts).getTime()), at: new Date(e.ts).toISOString(), level: 'warn', title: 'No source pushed',
        detail: `${dd.source || 'primary'} has not arrived after ${dd.waited_s ?? '?'}s` };
    }
    return { ts: hhmm(new Date(e.ts).getTime()), at: new Date(e.ts).toISOString(), level: levelFor(String(e.type)), title: String(e.type), detail };
  });

  // One log in time order, newest first: encoder lines now have their time too.
  const log = newestFirst<{ at?: string | null }>([...encTail, ...eventsLog]) as typeof eventsLog;

  // EPG: real programmes around now, with each one's flag (services/epgLane.ts,
  // shared with the event and radio pages); empty when there is no schedule.
  const epg = await epgLane(col as 'channel_id' | 'event_id', channel.id, nowMs);

  // viewers — real analytics only; empty until wired/there is live data (no fabrication)
  const viewers = await channelViewers(group?.account_id ?? null, channel.id, kind);

  // Public delivery: the on-air state + the public playback URL a viewer/app would use.
  // available = the public URL would actually serve right now (published + valid content).
  const onAir = publishedNow;
  const publicBlock = {
    url: `/live/${channel.id}/master.m3u8`,
    dashUrl: `/live/${channel.id}/manifest.mpd`,
    available: onAir && health.onAir,
  };

  return {
    kind, group: group ? { id: group.id, name: group.name } : null, profile, dvr, captions,
    epgEnabled: channel.epg_enabled !== false,
    autoConnect: channel.auto_connect !== false,
    schemaId: channel.schema_id ?? null,
    metadata: (channel.metadata && typeof channel.metadata === 'object') ? channel.metadata : {},
    desiredState: (channel.desired_state ?? 'stopped') as 'running' | 'stopped',
    encoderRunning: await encoderRunning(channel.id, kind),
    lockedWhileRunning: Object.keys(LOCKED_WHILE_RUNNING),
    resumeGaveUpAt: channel.resume_gave_up_at ?? null,
    resumeLastError: channel.resume_last_error ?? null,
    resumeArmedAt: channel.resume_armed_at ?? null,
    resumeAttempts: Number(channel.resume_attempts ?? 0) || 0,
    ladder, sources, viewers, epg, statusBoard, log, health, billing, server, degraded, metrics,
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
