// Builds the rich detail payload for a channel's control page: effective DVR window,
// sources, rendition ladder, captions, plus representative-but-DETERMINISTIC realtime
// telemetry (viewers timeseries, EPG now/next, status board, event log). Deterministic
// so the same channel renders stably (seeded from the channel id + the current 5-min
// bucket) rather than jumping on every poll — in production these come from
// stream_status / analytics_rollups / stream_events.
import { one, query } from '../db';

const DVR_MAX_SEC = 14400; // 4h cap for 24x7 channels

// --- tiny deterministic PRNG (mulberry32) seeded from a string ---------------
function seedFrom(s: string): number {
  let h = 1779033703 ^ s.length;
  for (let i = 0; i < s.length; i++) {
    h = Math.imul(h ^ s.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  return h >>> 0;
}
function mulberry32(a: number) {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface ChannelDetail {
  kind: 'channel';
  group: { id: string; name: string } | null;
  profile: any | null;
  dvr: { effective_sec: number; max_sec: number; mode: string; source: 'channel' | 'profile'; capped: boolean };
  captions: { enabled: boolean; targets: string[]; source_lang: string };
  ladder: { height: number; bitrate_kbps: number }[];
  sources: any[];
  viewers: { current: number; peak: number; peakAt: string; trendPct: number; series: { t: number; v: number }[] };
  epg: { now: any; next: any; lane: any[] };
  statusBoard: { output: string; activeSource: string; fallback: string; packager: string; inputs: any[] };
  log: { ts: string; level: string; title: string; detail: string }[];
}

export async function buildChannelDetail(channel: any, nowMs: number): Promise<ChannelDetail> {
  const group = channel.group_id
    ? await one<any>('SELECT id, name, output_profile_id FROM groups WHERE id = $1', [channel.group_id])
    : null;
  const profile = group?.output_profile_id
    ? await one<any>('SELECT * FROM output_profiles WHERE id = $1', [group.output_profile_id])
    : null;
  const sources = await query('SELECT * FROM stream_inputs WHERE channel_id = $1 ORDER BY role', [channel.id]);

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

  const ladder: { height: number; bitrate_kbps: number }[] = Array.isArray(profile?.rungs) ? profile.rungs : [];
  const captions = {
    enabled: !!profile?.captions_enabled,
    targets: Array.isArray(profile?.caption_targets) ? profile.caption_targets : [],
    source_lang: profile?.caption_source_lang || 'auto',
  };

  const live = channel.status === 'live';

  // ---- deterministic telemetry (seeded per channel + 5-min bucket) ----------
  const bucket = Math.floor(nowMs / (5 * 60 * 1000));
  const rnd = mulberry32(seedFrom(channel.id + ':' + bucket));

  // viewers curve: 60 points over the last hour with a smooth base + noise
  const base = live ? 8000 + Math.floor(rnd() * 12000) : Math.floor(rnd() * 400);
  const series: { t: number; v: number }[] = [];
  let peak = 0; let peakIdx = 0;
  for (let i = 0; i < 60; i++) {
    const wave = Math.sin((i / 60) * Math.PI * 2 + rnd() * 0.4) * 0.12 + 1;
    const drift = 1 + (i / 60) * (live ? 0.15 : 0);
    const v = Math.max(0, Math.round(base * wave * drift + (rnd() - 0.5) * base * 0.06));
    series.push({ t: nowMs - (59 - i) * 60 * 1000, v });
    if (v > peak) { peak = v; peakIdx = i; }
  }
  const current = series[series.length - 1].v;
  const hourAgo = series[0].v || 1;
  const trendPct = Math.round(((current - hourAgo) / hourAgo) * 1000) / 10;
  const peakAt = new Date(series[peakIdx].t).toISOString();
  const viewers = { current, peak, peakAt, trendPct, series };

  // ---- EPG now/next lane (representative, aligned to real clock) -------------
  const epg = buildEpg(nowMs, rnd);

  // ---- status board ---------------------------------------------------------
  const primaryUp = live;
  const status = {
    output: live ? 'Available · ' + packagingLabel(profile) : 'Idle',
    activeSource: primaryUp ? 'Primary (direct)' : '—',
    fallback: 'Not engaged',
    packager: live ? `Healthy · ${Number(profile?.segment_dur ?? 4).toFixed(1)}s segments` : 'Stopped',
    inputs: sources.length
      ? sources.map((s: any) => ({
          role: s.role,
          protocol: (s.protocol || '').toUpperCase(),
          state: s.role === 'primary' ? (live ? 'live' : 'idle') : 'standby',
          detail: s.role === 'primary'
            ? (live ? '1080p50 · 18.4 Mbps · 0 drops' : 'offline')
            : 'ready · standby',
        }))
      : [
          { role: 'primary', protocol: 'SRT', state: live ? 'live' : 'idle', detail: live ? '1080p50 · 18.4 Mbps · 0 drops' : 'no source configured' },
        ],
  };

  // ---- event log ------------------------------------------------------------
  const log = buildLog(nowMs, live, dvr, rnd);

  return { kind: 'channel', group: group ? { id: group.id, name: group.name } : null, profile, dvr, captions, ladder, sources, viewers, epg, statusBoard: status, log };
}

function packagingLabel(profile: any): string {
  const p = profile?.packaging;
  if (p === 'hls') return 'HLS';
  if (p === 'dash') return 'DASH';
  return 'HLS + DASH';
}

function pad(n: number) { return String(n).padStart(2, '0'); }
function hhmm(ms: number) { const d = new Date(ms); return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`; }

function buildEpg(nowMs: number, rnd: () => number) {
  const titles = ['Sunrise', 'Morning News', 'Midday Report', 'Afternoon Wrap', 'Drive Time', 'Evening News', 'Prime Feature', 'Late Wrap'];
  const slotMin = 60;
  const nowSlot = Math.floor(nowMs / (slotMin * 60 * 1000));
  const lane: any[] = [];
  let nowObj: any = null; let nextObj: any = null;
  for (let i = -2; i <= 5; i++) {
    const startMs = (nowSlot + i) * slotMin * 60 * 1000;
    const endMs = startMs + slotMin * 60 * 1000;
    const name = titles[((nowSlot + i) % titles.length + titles.length) % titles.length];
    const state = i < 0 ? 'past' : i === 0 ? 'now' : '';
    const entry: any = { name, start: hhmm(startMs), end: hhmm(endMs), mins: slotMin, state };
    if (i === 0) {
      const elapsed = (nowMs - startMs) / (slotMin * 60 * 1000);
      entry.progress = Math.round(elapsed * 100);
      nowObj = { ...entry, elapsedMin: Math.floor((nowMs - startMs) / 60000) };
    }
    if (i === 1) nextObj = { name, start: hhmm(startMs) };
    lane.push(entry);
  }
  return { now: nowObj, next: nextObj, lane };
}

function buildLog(nowMs: number, live: boolean, dvr: any, rnd: () => number) {
  if (!live) {
    return [
      { ts: 'Now', level: 'sched', title: 'Channel idle', detail: 'Encoder not running · start to go live' },
      { ts: 'Earlier', level: 'sched', title: 'Channel created', detail: 'Awaiting first start' },
    ];
  }
  const t = (minsAgo: number) => hhmm(nowMs - minsAgo * 60000);
  return [
    { ts: t(4), level: 'live', title: 'Primary source recovered', detail: 'SRT reconnected · failback from backup' },
    { ts: t(6), level: 'warn', title: 'Failover → backup source', detail: 'Primary RTT spike 480ms · 6 pkt loss/s' },
    { ts: t(180), level: 'sched', title: 'DVR window rolled', detail: `Sliding ${Math.round(dvr.effective_sec / 60)}m catch-up archive` },
    { ts: t(320), level: 'warn', title: 'Brief bitrate dip on ingest', detail: 'Recovered in 3s · no output impact' },
    { ts: 'Yesterday', level: 'live', title: 'Channel started', detail: 'g4dn-host · encoder packed' },
  ];
}

export { DVR_MAX_SEC };
