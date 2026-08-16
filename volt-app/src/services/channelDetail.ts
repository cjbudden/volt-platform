// Builds the detail payload for a channel's control page from REAL state only:
// effective DVR window, sources, rendition ladder, captions, plus telemetry read
// from the actual tables — stream_status (encoder health/signal), stream_events
// (event log) and programmes (EPG). No fabricated data: when nothing is reporting
// yet, the fields are empty/idle so the UI shows honest "no signal / no EPG /
// no data" states rather than invented numbers.
import { one, query } from '../db';
import { config } from '../config';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { computePipelineHealth, type PipelineHealth } from './pipelineHealth';
import { recommendInstance, buildBilling, type Billing } from './billing';

const DVR_MAX_SEC = 14400; // 4h cap for 24x7 channels

export interface ChannelDetail {
  kind: 'channel';
  group: { id: string; name: string } | null;
  profile: any | null;
  dvr: { effective_sec: number; max_sec: number; mode: string; source: 'channel' | 'profile'; capped: boolean };
  captions: { enabled: boolean; targets: string[]; source_lang: string };
  epgEnabled: boolean;
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
    const lines = readFileSync(p, 'utf8').split(/\r?\n/).filter(Boolean);
    const rx = /FATAL|error|Error|Unknown|Could not|No such|Invalid|failed|Connection|Server returned|Immediate exit|not found|Unsupported|Cannot|denied|refused|timed out|timeout/i;
    const bad = /FATAL|Could not|No such|failed|Server returned|Unsupported|Invalid|not found|denied|refused/i;
    return lines.filter((l) => rx.test(l)).slice(-10).map((l) => ({
      ts: 'encoder',
      level: bad.test(l) ? 'down' : 'warn',
      title: 'Encoder',
      detail: l.replace(/^\[volt-encoder\]\s*/, '').slice(0, 300),
    }));
  } catch { return []; }
}

/** Newest HLS/DASH manifest mtime (ms) under the channel's origin — 0 if none.
 *  Shaka rewrites these every new segment, so a recent mtime = output is advancing. */
function newestManifestMtimeMs(channelId: string): number {
  try {
    const dir = join(config.testStream.originDir, channelId);
    let newest = 0;
    for (const f of readdirSync(dir)) {
      if (f.endsWith('.m3u8') || f.endsWith('.mpd')) {
        try { const m = statSync(join(dir, f)).mtimeMs; if (m > newest) newest = m; } catch { /* ignore */ }
      }
    }
    return newest;
  } catch { return 0; }
}

/** Compute the SAME five-gate health used by the detail page, but with only the loads
 *  it needs, so the channels LIST shows a status that never disagrees with the detail.
 *  Per channel: one stream_status row, recent events, the encoder log tail, and the
 *  manifest mtime (ground truth). Returns the health (incl. the `overall` roll-up). */
export async function loadChannelHealthLite(channel: any, nowMs: number): Promise<PipelineHealth> {
  const st = await one<any>(
    `SELECT output_available, active_source, fallback_in_use, filler_in_use, packager_ok, sources, updated_at
       FROM stream_status WHERE channel_id = $1`, [channel.id]);
  const evs = await query<any>(
    `SELECT seq, type, detail, ts FROM stream_events WHERE channel_id = $1 ORDER BY ts DESC LIMIT 30`, [channel.id]);
  const encTail = encoderLogTail(channel.id);
  const logTailErrors = encTail.filter((l) => l.level === 'down' || l.level === 'warn').map((l) => l.detail).reverse();
  const outMtime = newestManifestMtimeMs(channel.id);
  const outputAgeMs = outMtime > 0 ? (nowMs - outMtime) : null;
  const sstates: Record<string, any> = (st && st.sources && typeof st.sources === 'object') ? st.sources : {};
  return computePipelineHealth({
    ownerStatus: channel.status,
    st,
    events: evs,
    logTailErrors,
    hasPrimarySource: Object.keys(sstates).length > 0,
    packagingLabel: '',
    outputFresh: outputAgeMs != null ? outputAgeMs < 15000 : false,
    outputAgeMs,
    onAirPublished: channel.on_air === true,
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
  };

  // ---- REAL status (latest encoder report), REAL events, REAL EPG -----------
  const st = await one<any>(
    `SELECT output_available, active_source, fallback_in_use, filler_in_use, packager_ok, sources, updated_at
       FROM stream_status WHERE channel_id = $1`, [channel.id]);
  const reporting = !!st;
  const outputAvailable = !!st?.output_available;
  const seg = Number(profile?.segment_dur ?? 4).toFixed(1);
  const sstates: Record<string, any> = (st && st.sources && typeof st.sources === 'object') ? st.sources : {};

  // event log — real stream_events, newest first; empty when none
  const evs = await query<any>(
    `SELECT seq, type, detail, ts FROM stream_events WHERE channel_id = $1 ORDER BY ts DESC LIMIT 30`, [channel.id]);

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
    logTailErrors,
    hasPrimarySource: sources.some((s: any) => s.role === 'primary' && s.ingest_url) || sources.length > 0,
    packagingLabel: packagingLabel(profile),
    outputFresh,
    outputAgeMs: outMtime > 0 ? (nowMs - outMtime) : null,
    onAirPublished: channel.on_air === true,
  });
  // back-compat: `degraded` now means "a gate is failed or degraded" (a REAL problem,
  // not merely 'starting'). This kills the false OUTPUT ERROR during warm-up.
  const degraded = !!health.primaryError;

  // billing: the encoder SERVER is the billable unit. Metering runs while the
  // channel is live; `since` = when the running encoder task launched.
  const inst = await one<any>(
    `SELECT min(launched_at) AS since FROM instances WHERE channel_id = $1 AND terminated_at IS NULL`,
    [channel.id]);
  const serverUp = channel.status === 'live';
  const sinceMs = inst?.since ? new Date(inst.since).getTime() : null;
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
