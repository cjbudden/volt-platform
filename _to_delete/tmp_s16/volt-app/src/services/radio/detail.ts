// ============================================================================
//  Radio detail payload — the audio counterpart of channelDetail.ts, built from
//  REAL state only and reusing the SAME five-gate pipeline health model, so a
//  station's status can never disagree with a channel's for the same situation.
//
//  Ground truth per gate:
//    server  — the station's pipeline process is up (instances row + running proc)
//    input   — audio actually arriving (stream_status.sources from the monitor,
//              ICY connection state, ffmpeg error events)
//    encoder — ffmpeg alive and the packager writing (playlist advancing)
//    output  — the live audio playlist mtime is advancing right now
//    public  — on_air AND valid content (what /live/:id/* would actually serve)
// ============================================================================
import { one, query } from '../../db';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { liveDirFor } from '../liveOrigin';
import { computePipelineHealth, type PipelineHealth } from '../pipelineHealth';
import { radioStatus, isRadioRunning } from './pipeline';
import { radioMonitorState } from './monitor';
import { icyState } from './icyMeta';

/** ms since the station's live audio playlist last advanced (null = none yet). */
export function radioOutputAgeMs(channelId: string, nowMs = Date.now()): number | null {
  try {
    const p = join(liveDirFor(channelId), 'audio', 'index.m3u8');
    if (!existsSync(p)) return null;
    return nowMs - statSync(p).mtimeMs;
  } catch { return null; }
}

/** GROUND TRUTH for the public gate: is this station serving valid content now? */
export function radioHasValidContent(channelId: string): boolean {
  const age = radioOutputAgeMs(channelId);
  return age != null && age < 15000;
}

/** Error lines from THIS run's ffmpeg log, newest-first (event log + gates). */
export function radioLogTail(channelId: string): { ts: string; level: string; title: string; detail: string }[] {
  try {
    const p = join(liveDirFor(channelId), 'radio.log');
    if (!existsSync(p)) return [];
    const lines = readFileSync(p, 'utf8').split(/\r?\n/).filter(Boolean);
    const rx = /error|failed|Invalid|No such|Could not|Connection|refused|timed out|denied|Server returned|40[0-9]|50[0-9]/i;
    const bad = /failed|Could not|No such|refused|denied|Server returned|50[0-9]/i;
    // BENIGN DECODER CHATTER: internet radio mounts routinely produce these on
    // stream joins, loop points and ID3 frames. ffmpeg recovers within a frame,
    // so surfacing them as faults paints a permanently red log on a healthy
    // station. Real faults (connection, 4xx/5xx, exits) still come through.
    const noise = /invalid concatenated file|Error submitting packet to decoder|Audio packet of size|Header missing|skipping \d+ bytes|Estimating duration|missing picture in access unit|Could not update timestamps|non-existing (PPS|SPS)|Discarding interlaced/i;
    return lines.filter((l) => rx.test(l) && !noise.test(l)).slice(-10).map((l) => ({
      ts: 'encoder', level: bad.test(l) ? 'down' : 'warn', title: 'Encoder', detail: l.slice(0, 300),
    }));
  } catch { return []; }
}

export async function loadRadioHealth(station: any, nowMs = Date.now()): Promise<PipelineHealth> {
  const running = isRadioRunning(station.id);
  const st = await one<any>(
    `SELECT output_available, active_source, packager_ok, sources, updated_at
       FROM stream_status WHERE channel_id=$1`, [station.id]);
  const evs = await query<any>(
    `SELECT seq, type, detail, ts FROM stream_events WHERE channel_id=$1 ORDER BY ts DESC LIMIT 30`, [station.id]);
  const logTailErrors = radioLogTail(station.id).map((l) => l.detail).reverse();
  const outputAgeMs = radioOutputAgeMs(station.id, nowMs);
  const icy = icyState(station.id);
  const sources = (st?.sources && typeof st.sources === 'object') ? st.sources : {};
  return computePipelineHealth({
    // the pipeline process is the server: a dead process means the run is down,
    // even if the row still says 'live' (same rule channels apply to crashes).
    ownerStatus: running ? station.status : (station.status === 'live' ? 'ended' : station.status),
    st: st ? { ...st, sources } : null,
    events: evs,
    logTailErrors,
    hasPrimarySource: true,
    packagingLabel: 'MP3 + HLS + DASH',
    outputFresh: outputAgeMs != null ? outputAgeMs < 15000 : false,
    outputAgeMs,
    onAirPublished: station.on_air === true,
  });
}

export interface RadioDetailExtras {
  health: PipelineHealth;
  qc: {
    verdict: string;
    lastSampleAt: number | null;
    checks: { ok: number; failed: number };
    issues: { code: string; message: string; at: number }[];
    segments: number;
    outputFreshMs: number | null;
    silenceSinceMs: number | null;
    staticSinceMs: number | null;
    level: { peakDb: number; rmsDb: number; crestDb: number; entropy: number } | null;
  };
  log: { ts: string; level: string; title: string; detail: string }[];
  statusBoard: { output: string; input: string; encoder: string; onAir: string };
}

const LEVEL_NAME: Record<string, string> = { down: 'down', warn: 'warn', info: 'info' };

/** Event rows + encoder errors merged into the channel-style event log. */
export async function radioEventLog(channelId: string) {
  const evs = await query<any>(
    `SELECT type, detail, ts FROM stream_events WHERE channel_id=$1 ORDER BY ts DESC LIMIT 40`, [channelId]);
  const TITLE: Record<string, string> = {
    'channel.start': 'Station started', 'channel.stop': 'Station stopped',
    'channel.air': 'On air', 'channel.off_air': 'Off air',
    'output.stalled': 'Output stalled', 'output.resumed': 'Output resumed',
    'input.error': 'Input error', 'source.up': 'Source up', 'source.down': 'Source down',
    'qc.silence': 'QC: dead air', 'qc.static': 'QC: static-like signal', 'qc.recovered': 'QC: recovered',
  };
  const LEVEL: Record<string, string> = {
    'input.error': 'down', 'source.down': 'down', 'qc.silence': 'down',
    'output.stalled': 'warn', 'qc.static': 'warn', 'channel.stop': 'info',
  };
  const rows = evs.map((e) => {
    const d = typeof e.detail === 'string' ? (() => { try { return JSON.parse(e.detail); } catch { return { text: e.detail }; } })() : (e.detail || {});
    return {
      ts: new Date(e.ts).toISOString(),
      level: LEVEL_NAME[LEVEL[e.type]] || 'info',
      title: TITLE[e.type] || e.type,
      detail: String(d.message || d.reason || Object.entries(d).map(([k, v]) => `${k}=${v}`).join(' ') || ''),
    };
  });
  return [...rows, ...radioLogTail(channelId)].slice(0, 40);
}

export function radioQc(channelId: string): RadioDetailExtras['qc'] {
  const m = radioMonitorState(channelId);
  const last = m?.levels[m.levels.length - 1] ?? null;
  return {
    verdict: m?.verdict ?? 'unknown',
    lastSampleAt: m?.lastSampleAt ?? null,
    checks: m?.checks ?? { ok: 0, failed: 0 },
    issues: m?.issues ?? [],
    segments: m?.segments ?? 0,
    outputFreshMs: m?.outputFreshMs ?? null,
    silenceSinceMs: m?.silenceSinceMs ?? null,
    staticSinceMs: m?.staticSinceMs ?? null,
    level: last ? { peakDb: last.peakDb, rmsDb: last.rmsDb, crestDb: last.crestDb, entropy: last.entropy } : null,
  };
}

export function radioStatusBoard(health: PipelineHealth, qc: RadioDetailExtras['qc']) {
  const g = (n: string) => health.gates.find((x) => x.gate === n)!;
  const verdictText: Record<string, string> = {
    audio: 'programme audio', quiet: 'audio present (low level)', silent: 'DEAD AIR — no audio',
    static: 'noise/static — not programme audio', unknown: 'no measurement yet',
  };
  return {
    input: `${g('input').status} · ${g('input').detail}`,
    encoder: `${g('encoder').status} · ${g('encoder').detail}`,
    output: `${g('output').status} · ${g('output').detail}`,
    onAir: `${g('public').status} · ${g('public').detail}`,
    signal: verdictText[qc.verdict] ?? qc.verdict,
  };
}

export { radioStatus };
