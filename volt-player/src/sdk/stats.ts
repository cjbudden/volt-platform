// ============================================================================
//  PLAYBACK STATS: the debug panel (docs/PLAYER_SDK.md, section 12).
//
//  What is actually playing, measured, not what was asked for: resolution and
//  frame rate, dropped frames, codecs, the bitrate and the connection behind
//  it, bytes on the wire, the buffer, the distance from live, the CDN that
//  answered, stalls and errors. For a support call ("what does your panel
//  say?") and for an operator checking an output.
//
//  Engine-agnostic. A PROBE answers sample(); this file draws and records.
//    shaka         Engine.debugSample() (sdk/engine.ts)
//    native/MP4    mediaProbe(): the media element alone
//    hls.js        hlsJsProbe(): the console's channel monitors
//    dash.js       dashJsProbe()
//  combineProbes() merges them, later probes filling what earlier ones left.
//
//  Opened by right-click > Playback stats, Shift+D, a skin's Stats button
//  (commands.toggleStats) or player.showStats(). Costs nothing while closed:
//  sampling runs once a second only while the panel is open, plus a fixed
//  60-sample history per graph.
//
//  Manifest URLs are shown and copied WITHOUT their query string, so a
//  pasted report never leaks a playback token.
// ============================================================================

/** The SDK's version, shown in the menu and on every copied report. */
export const SDK_VERSION = '1.0.0';

export interface StatsSample {
  /** 'Shaka 4.16.46 (MSE)', 'Safari HLS', 'hls.js 1.6.17', 'Progressive'. */
  engine: string | null;
  format: string | null;
  assetId: string | null;
  sessionId: string | null;
  title: string | null;
  status: string | null;
  manifest: string | null;
  viewport: { w: number; h: number; dpr: number } | null;
  frames: { dropped: number; total: number; corrupted?: number } | null;
  res: { w: number; h: number; fps: number | null } | null;
  optimal: { w: number; h: number; fps: number | null } | null;
  volume: number | null;
  muted: boolean | null;
  videoCodec: string | null;
  audioCodec: string | null;
  audioChannels: number | null;
  sampleRate: number | null;
  hdr: string | null;
  /** The playing rendition's declared bitrate, bits per second. */
  bitrate: number | null;
  abr: 'auto' | 'pinned' | null;
  /** The engine's bandwidth estimate, bits per second. */
  bandwidth: number | null;
  /** Bytes downloaded since the engine started (cumulative; the panel graphs the change). */
  bytes: number | null;
  /** Seconds buffered ahead of the playhead. */
  buffer: number | null;
  live: boolean | null;
  /** Seconds between the stream's live edge (or the programme's wall clock) and the picture. */
  latency: number | null;
  targetLatency: number | null;
  lowLatency: boolean | null;
  dvrWindow: number | null;
  segmentDuration: number | null;
  drm: string | null;
  cdn: { host: string | null; pop: string | null; cache: string | null; server: string | null } | null;
  stalls: number | null;
  stallSeconds: number | null;
  errors: number | null;
  lastError: string | null;
  programme: string | null;
  /** The playhead's wall clock (live with PROGRAM-DATE-TIME), else now. Epoch ms. */
  wallClock: number | null;
  // ---- what diagnose() needs (see WHERE IS THE FAULT below) ----
  /** HTTP status of the last failed request (0 = no response at all). */
  httpStatus: number | null;
  /** The engine's error family: 'network' | 'media' | 'mux' | 'key' | 'other'. */
  errorType: string | null;
  /** The last error stopped playback (not one the engine recovered from). */
  errorFatal: boolean | null;
  /** The lowest rendition's bitrate: below it, no quality can play smoothly. */
  lowestBitrate: number | null;
  /** Live playlist reloads in a row that brought nothing new. */
  playlistMisses: number | null;
  online: boolean | null;
  hidden: boolean | null;
  /** The platform's own verdict on the stream, when the host knows it (the
   *  console's monitors pass the five-gate board's view): fault = server side. */
  server: { state: 'ok' | 'fault'; detail?: string | null } | null;
}

export type StatsProbe = () => Partial<StatsSample>;

export function emptySample(): StatsSample {
  return {
    engine: null, format: null, assetId: null, sessionId: null, title: null, status: null, manifest: null,
    viewport: null, frames: null, res: null, optimal: null, volume: null, muted: null,
    videoCodec: null, audioCodec: null, audioChannels: null, sampleRate: null, hdr: null,
    bitrate: null, abr: null, bandwidth: null, bytes: null, buffer: null,
    live: null, latency: null, targetLatency: null, lowLatency: null, dvrWindow: null, segmentDuration: null,
    drm: null, cdn: null, stalls: null, stallSeconds: null, errors: null, lastError: null, programme: null, wallClock: null,
    httpStatus: null, errorType: null, errorFatal: null, lowestBitrate: null, playlistMisses: null,
    online: null, hidden: null, server: null,
  };
}

/** Later probes fill what earlier ones left empty (the engine first, the media element last). */
export function combineProbes(...probes: Array<StatsProbe | null | undefined>): StatsProbe {
  return () => {
    const out: any = emptySample();
    for (const p of probes) {
      if (!p) continue;
      let s: Partial<StatsSample> = {};
      try { s = p() ?? {}; } catch { /* a probe never breaks the panel */ }
      for (const [k, v] of Object.entries(s)) if (out[k] == null && v != null && !(typeof v === 'number' && !Number.isFinite(v))) out[k] = v;
    }
    return out as StatsSample;
  };
}

// --------------------------------------------------------------- WHERE IS THE FAULT

/**
 * WHERE IS THE FAULT: the viewer's side, the delivery, the stream, or our code.
 *
 * Most "the player is broken" reports are not about the player or the stream:
 * a slow connection, a country the rights exclude, an expired token, a laptop
 * decoding nine tiles at once. Each of those looks the same to the person
 * watching (it stutters, or it stops), and each was reported the same way.
 *
 * diagnose() reads what the panel already measures and says which side of the
 * line the problem is on, in words, with `report` true ONLY when the fault is
 * ours to fix (server, delivery, code). The panel leads with it, the copied
 * report carries it, and a viewer-side problem says plainly that there is
 * nothing to report. Pure, so every rule is tested
 * (volt-app/test/player-diagnose.check.ts).
 */
export type FaultSide = 'ok' | 'local' | 'access' | 'delivery' | 'server' | 'code';
export interface Diagnosis { side: FaultSide; title: string; detail: string; report: boolean }

export const SIDE_LABEL: Record<FaultSide, string> = {
  ok: 'Healthy', local: 'This device or connection', access: 'Access rules',
  delivery: 'Delivery (CDN / network path)', server: 'Stream output (server side)', code: 'Player code',
};

export function diagnose(s: Partial<StatsSample>): Diagnosis {
  const st = s.httpStatus ?? null;
  const err = String(s.lastError ?? '');
  const D = (side: FaultSide, title: string, detail: string): Diagnosis => ({ side, title, detail, report: side === 'server' || side === 'delivery' || side === 'code' });

  // 1) the platform already knows the stream is wrong
  if (s.server?.state === 'fault') return D('server', 'The stream itself has a fault', s.server.detail || 'The platform reports a problem with this output. It affects every viewer, not just you.');
  // 2) offline is offline
  if (s.online === false) return D('local', 'This device is offline', 'No network connection. Nothing is wrong with the stream.');
  // 3) answers that are rules, not faults
  if (st === 451) return D('access', 'Not available in this region', 'The rights for this stream exclude the viewer\'s country (HTTP 451). Working as configured, nothing to report.');
  if (st === 401 || st === 403) return D('access', 'Not permitted', `The request was refused (HTTP ${st}): an expired or missing playback token, or no entitlement. Sign in again or check the viewer's access.`);
  // 4) the stream is missing pieces
  if (st === 404 || st === 410) return D('server', 'Stream files missing', `The manifest or a segment was not found (HTTP ${st}). The output is not being written or published where the player was sent.`);
  if (st != null && st >= 500) return D('delivery', 'Delivery error', `The CDN or origin answered HTTP ${st}. Every viewer on this path is likely affected.`);
  if ((s.playlistMisses ?? 0) >= 3 && s.live) return D('server', 'Live playlist has stopped advancing', `The last ${s.playlistMisses} playlist reloads brought no new segments. The encoder or packager is not producing output.`);
  // 5) the bytes arrive but cannot be used
  if (/Incompatible|codec|NotSupported|SRC_NOT_SUPPORTED/i.test(err) && s.errorType !== 'network') return D('local', 'This browser cannot play this format', `${err}. Another browser or device will play it. Report only if it fails on a supported browser.`);
  if (/fragParsingError|bufferAppendError|demux|corrupt|MEDIA_ERR_DECODE/i.test(err) && s.errorFatal) return D('server', 'Corrupt media', `The player received media it could not decode (${err}). The packaged output is likely damaged.`);
  if (s.errorType === 'other' && s.errorFatal) return D('code', 'Player error', `${err || 'An unexpected player error'}. This is a defect in the player, please report it.`);
  // 6) connection without a status: the network between viewer and us
  if (st === 0 || (s.errorType === 'network' && s.errorFatal && st == null)) return D('local', 'Cannot reach the stream from here', 'Requests got no answer: a firewall, VPN, proxy or dropped connection on the viewer\'s side. If every viewer sees this, it is delivery.');
  // 7) bandwidth and the device
  const bw = s.bandwidth ?? null;
  if (bw != null && s.lowestBitrate != null && bw < s.lowestBitrate * 1.2) return D('local', 'Connection too slow for this stream', `Measured ${fmtKbps(bw)}, the lowest quality needs about ${fmtKbps(s.lowestBitrate * 1.2)}. Expect buffering on this connection. Nothing is wrong with the stream.`);
  if ((s.stalls ?? 0) > 0 && bw != null && s.bitrate != null && bw < s.bitrate) return D('local', 'Connection below the current quality', `Measured ${fmtKbps(bw)} against ${fmtKbps(s.bitrate)} playing; the player is stepping quality down. Local to this connection.`);
  const fr = s.frames;
  if (fr && fr.total > 250 && fr.dropped / fr.total > 0.1) return D('local', 'This device is dropping frames', `${Math.round((fr.dropped / fr.total) * 100)}% of frames dropped: the device cannot decode fast enough (too many players, tabs or a high resolution). Not a stream fault.`);
  if (s.hidden) return D('local', 'Playing in a background tab', 'The browser slows background tabs, so stalls here mean nothing.');
  if ((s.stalls ?? 0) > 0) return D('ok', 'Recovered from a stall', 'Playback stalled and resumed. Watch the buffer and connection graphs; a repeat on a good connection is worth reporting.');
  return D('ok', 'Playback healthy', 'Nothing to report.');
}

// --------------------------------------------------------------- formatting

/** Host and path only: never the query (playback tokens) or the fragment. */
export function redactUrl(u: string | null | undefined): string | null {
  if (!u) return null;
  try {
    const x = new URL(u, typeof location !== 'undefined' ? location.href : 'http://local/');
    return `${x.origin}${x.pathname}${x.search ? '?…' : ''}`;
  } catch { return u.split(/[?#]/)[0]; }
}

export function hostOf(u: string | null | undefined): string | null {
  if (!u) return null;
  try { return new URL(u, typeof location !== 'undefined' ? location.href : 'http://local/').host || null; } catch { return null; }
}

export function fmtKbps(bps: number | null | undefined): string {
  if (bps == null || !Number.isFinite(bps)) return '-';
  const k = bps / 1000;
  return k >= 10_000 ? `${(k / 1000).toFixed(1)} Mbps` : `${Math.round(k)} kbps`;
}

export function fmtBytes(b: number | null | undefined): string {
  if (b == null || !Number.isFinite(b)) return '-';
  if (b < 1024) return `${Math.round(b)} B`;
  if (b < 1024 * 1024) return `${Math.round(b / 1024)} KB`;
  if (b < 1024 ** 3) return `${(b / 1024 / 1024).toFixed(1)} MB`;
  return `${(b / 1024 ** 3).toFixed(2)} GB`;
}

export function fmtSeconds(s: number | null | undefined, dp = 2): string {
  return s == null || !Number.isFinite(s) ? '-' : `${s.toFixed(dp)} s`;
}

/** 7200 -> '2h 00m', 95 -> '1m 35s'. */
export function fmtSpan(s: number | null | undefined): string {
  if (s == null || !Number.isFinite(s) || s <= 0) return '-';
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = Math.round(s % 60);
  return h ? `${h}h ${String(m).padStart(2, '0')}m` : m ? `${m}m ${String(sec).padStart(2, '0')}s` : `${sec}s`;
}

function fmtRes(r: StatsSample['res']): string {
  if (!r || !r.w || !r.h) return '-';
  return `${r.w}×${r.h}${r.fps ? `@${Math.round(r.fps * 100) / 100}` : ''}`;
}

const H264_PROFILES: Record<number, string> = { 66: 'Baseline', 77: 'Main', 88: 'Extended', 100: 'High', 110: 'High 10', 122: 'High 4:2:2', 244: 'High 4:4:4' };

/**
 * A codec string a person can read, keeping the original:
 * 'avc1.64002a' -> 'H.264 High L4.2 (avc1.64002a)'.
 */
export function codecName(c: string | null | undefined): string | null {
  if (!c) return null;
  const s = c.trim();
  const lo = s.toLowerCase();
  let name: string | null = null;
  const avc = /^(avc[13])\.([0-9a-f]{2})[0-9a-f]{2}([0-9a-f]{2})$/i.exec(s);
  if (avc) {
    const prof = H264_PROFILES[parseInt(avc[2], 16)] ?? `profile ${parseInt(avc[2], 16)}`;
    const lvl = parseInt(avc[3], 16) / 10;
    name = `H.264 ${prof} L${lvl}`;
  } else if (lo.startsWith('avc')) name = 'H.264';
  else if (lo.startsWith('hvc1') || lo.startsWith('hev1')) name = /\.2\./.test(lo) ? 'HEVC Main 10' : 'HEVC';
  else if (lo.startsWith('dvh1') || lo.startsWith('dvhe')) name = 'Dolby Vision';
  else if (lo.startsWith('vp09') || lo === 'vp9') name = 'VP9';
  else if (lo.startsWith('vp8')) name = 'VP8';
  else if (lo.startsWith('av01')) name = 'AV1';
  else if (lo === 'mp4a.40.2') name = 'AAC-LC';
  else if (lo === 'mp4a.40.5') name = 'HE-AAC';
  else if (lo === 'mp4a.40.29') name = 'HE-AACv2';
  else if (lo === 'mp4a.40.34' || lo === 'mp3' || lo === 'mp4a.6b' || lo === 'mp4a.69') name = 'MP3';
  else if (lo.startsWith('mp4a')) name = 'AAC';
  else if (lo === 'ac-3') name = 'Dolby Digital';
  else if (lo === 'ec-3') name = 'Dolby Digital Plus';
  else if (lo === 'ac-4' || lo.startsWith('ac-4')) name = 'Dolby AC-4';
  else if (lo === 'opus') name = 'Opus';
  else if (lo === 'flac' || lo === 'fla') name = 'FLAC';
  else if (lo === 'wvtt' || lo === 'stpp' || lo.startsWith('stpp')) name = lo === 'wvtt' ? 'WebVTT' : 'TTML';
  return name && name !== s ? `${name} (${s})` : s;
}

/** One codec string may carry several ('avc1.64001f,mp4a.40.2'): split into video and audio. */
export function splitCodecs(codecs: string | null | undefined): { video: string | null; audio: string | null } {
  let video: string | null = null, audio: string | null = null;
  for (const c of (codecs ?? '').split(/[,\s]+/).filter(Boolean)) {
    const lo = c.toLowerCase();
    if (/^(mp4a|ac-3|ec-3|ac-4|opus|flac|mp3)/.test(lo)) audio = audio ?? c;
    else video = video ?? c;
  }
  return { video, audio };
}

/**
 * The size a player this big would want: the smallest rendition that fills
 * the box in device pixels (scaling down a little is sharp, scaling up is
 * soft; 10% short still counts as filling it), else the largest there is.
 * The same idea as hls.js capLevelToPlayerSize and Shaka's restrictToElementSize.
 */
export function optimalFor<T extends { width?: number | null; height?: number | null }>(list: T[], boxH: number, dpr: number): T | null {
  const v = list.filter((x) => x.height).sort((a, b) => (a.height as number) - (b.height as number));
  if (!v.length) return null;
  const want = Math.max(1, boxH * (dpr || 1));
  return v.find((x) => (x.height as number) >= want * 0.9) ?? v[v.length - 1];
}

/** Seconds buffered ahead of the playhead in the range that holds it. */
export function bufferAhead(m: HTMLMediaElement): number {
  try {
    const b = m.buffered;
    for (let i = 0; i < b.length; i++) if (b.start(i) <= m.currentTime + 0.5 && b.end(i) >= m.currentTime) return Math.max(0, b.end(i) - m.currentTime);
  } catch { /* */ }
  return 0;
}

/** Headers a CDN uses to say where it answered from and whether it was cached. */
export function cdnFromHeaders(get: (name: string) => string | null | undefined, url?: string | null): StatsSample['cdn'] {
  const h = (n: string) => { try { return get(n) || null; } catch { return null; } };
  const pop = h('x-amz-cf-pop') ?? h('x-served-by') ?? h('cf-ray')?.split('-').pop() ?? h('x-edge-location') ?? h('x-akamai-edgescape') ?? null;
  const cache = h('x-cache') ?? h('cf-cache-status') ?? h('x-cache-status') ?? h('x-proxy-cache') ?? null;
  return { host: hostOf(url), pop, cache, server: h('server') ?? h('via') ?? null };
}

// --------------------------------------------------------------- the rows

export interface StatsRow {
  key: string;
  label: string;
  value: string;
  /** A graph row: the value to plot this second, and its scale. */
  graph?: { v: number; max?: number; kind: 'speed' | 'net' | 'buffer' | 'latency' };
  /** Full text for the tooltip / copy when value is shortened. */
  full?: string;
}

/**
 * What the panel shows, in order. Pure (tests: volt-app/test/player-stats.check.ts).
 * `netDelta` is bytes downloaded since the previous sample.
 */
export function statsRows(s: StatsSample, netDelta: number | null = null, now = Date.now()): StatsRow[] {
  const rows: StatsRow[] = [];
  const add = (key: string, label: string, value: string | null | undefined, extra: Partial<StatsRow> = {}) => {
    if (value == null || value === '') return;
    rows.push({ key, label, value, ...extra });
  };
  const sess = s.sessionId ? (s.sessionId.length > 22 ? `${s.sessionId.slice(0, 20)}…` : s.sessionId) : null;
  add('ids', 'Asset / Session', s.assetId || sess ? `${s.assetId ?? '-'} / ${sess ?? '-'}` : null, { full: `${s.assetId ?? '-'} / ${s.sessionId ?? '-'}` });
  if (s.viewport || s.frames) {
    const vp = s.viewport ? `${Math.round(s.viewport.w)}×${Math.round(s.viewport.h)}*${s.viewport.dpr.toFixed(2)}` : '-';
    const fr = s.frames ? `${s.frames.dropped} dropped of ${s.frames.total}${s.frames.corrupted ? `, ${s.frames.corrupted} corrupt` : ''}` : '-';
    add('viewport', 'Viewport / Frames', `${vp} / ${fr}`);
  }
  if (s.res || s.optimal) add('res', 'Current / Optimal Res', `${fmtRes(s.res)} / ${fmtRes(s.optimal)}`);
  if (s.volume != null) add('volume', 'Volume', s.muted ? `${Math.round(s.volume * 100)}% (muted)` : `${Math.round(s.volume * 100)}%`);
  if (s.videoCodec || s.audioCodec) {
    const a = s.audioCodec ? `${codecName(s.audioCodec)}${s.audioChannels ? ` ${s.audioChannels}ch` : ''}${s.sampleRate ? ` ${Math.round(s.sampleRate / 100) / 10} kHz` : ''}` : '-';
    add('codecs', 'Codecs', `${codecName(s.videoCodec) ?? '-'} / ${a}${s.hdr && s.hdr !== 'SDR' ? ` / ${s.hdr}` : ''}`);
  }
  if (s.bitrate != null) add('bitrate', 'Bitrate', `${fmtKbps(s.bitrate)}${s.abr ? ` · ${s.abr === 'auto' ? 'auto (ABR)' : 'pinned'}` : ''}`);
  if (s.bandwidth != null) add('speed', 'Connection Speed', fmtKbps(s.bandwidth), { graph: { v: s.bandwidth, kind: 'speed' } });
  if (netDelta != null || s.bytes != null) add('net', 'Network Activity', `${fmtBytes(netDelta ?? 0)}${s.bytes != null ? `  (${fmtBytes(s.bytes)} total)` : ''}`, { graph: { v: Math.max(0, netDelta ?? 0), kind: 'net' } });
  if (s.buffer != null) add('buffer', 'Buffer Health', fmtSeconds(s.buffer), { graph: { v: s.buffer, kind: 'buffer' } });
  if (s.live) {
    if (s.latency != null) add('latency', 'Live Latency', `${fmtSeconds(s.latency)}${s.targetLatency != null ? ` (target ${fmtSeconds(s.targetLatency, 1)})` : ''}`, { graph: { v: s.latency, kind: 'latency' } });
    const mode = [s.format, s.lowLatency ? 'low latency' : 'normal latency', s.dvrWindow ? `DVR ${fmtSpan(s.dvrWindow)}` : 'no DVR', s.segmentDuration ? `${Math.round(s.segmentDuration * 10) / 10} s segments` : null].filter(Boolean).join(', ');
    add('mode', 'Live Mode', mode);
  } else if (s.format || s.segmentDuration) {
    add('mode', 'Stream', [s.format, 'on demand', s.segmentDuration ? `${Math.round(s.segmentDuration * 10) / 10} s segments` : null].filter(Boolean).join(', '));
  }
  add('engine', 'Engine', s.engine ? `${s.engine}${s.drm ? ` · DRM ${s.drm}` : ''}` : null);
  if (s.cdn && (s.cdn.host || s.cdn.pop || s.cdn.cache)) add('cdn', 'Delivery', [s.cdn.host, s.cdn.pop ? `POP ${s.cdn.pop}` : null, s.cdn.cache, s.cdn.server].filter(Boolean).join(' · '));
  if (s.stalls != null || s.errors != null) {
    const st = s.stalls != null ? `${s.stalls} stall${s.stalls === 1 ? '' : 's'}${s.stallSeconds ? ` (${s.stallSeconds.toFixed(1)} s)` : ''}` : '-';
    add('health', 'Stalls / Errors', `${st} / ${s.errors ?? 0}${s.lastError ? ` (last: ${s.lastError})` : ''}`);
  }
  add('status', 'Status', s.status);
  add('programme', 'Programme', s.programme);
  const man = redactUrl(s.manifest);
  add('manifest', 'Manifest', man ? (man.length > 64 ? `…${man.slice(-62)}` : man) : null, { full: man ?? undefined });
  add('date', 'Date', new Date(s.wallClock ?? now).toString());
  return rows;
}

/** The text Copy puts on the clipboard: every row in full, plus where it was taken. */
export function statsReport(s: StatsSample, netDelta: number | null = null, meta: { version?: string; userAgent?: string; page?: string } = {}, now = Date.now()): string {
  const rows = statsRows(s, netDelta, now);
  const w = Math.max(...rows.map((r) => r.label.length), 10);
  const dg = diagnose(s);
  const lines = [
    `Volt Player debug info${meta.version ? ` (SDK ${meta.version})` : ''}`,
    `Diagnosis   ${SIDE_LABEL[dg.side]}: ${dg.title}. ${dg.detail}`,
    `Report      ${dg.report ? 'YES, this is a platform fault' : 'no, not a platform fault'}`,
    `Taken       ${new Date(now).toISOString()}`,
    ...(meta.page ? [`Page        ${redactUrl(meta.page)}`] : []),
    ...(meta.userAgent ? [`Browser     ${meta.userAgent}`] : []),
    '',
    ...rows.map((r) => `${r.label.padEnd(w)}  ${r.full ?? r.value}`),
  ];
  return lines.join('\n');
}

// --------------------------------------------------------------- probes

interface StallTracker { stalls: number; seconds: number; since: number | null; started: boolean }

/** What the media element alone can say: any engine, including Safari's own HLS and plain MP4/MP3. */
export function mediaProbe(media: HTMLVideoElement, box?: HTMLElement | null): StatsProbe & { destroy(): void } {
  const st: StallTracker = { stalls: 0, seconds: 0, since: null, started: false };
  const playing = () => { if (st.since != null) { st.seconds += (performance.now() - st.since) / 1000; st.since = null; } st.started = true; };
  const waiting = () => { if (st.started && st.since == null && !media.seeking) { st.stalls++; st.since = performance.now(); } };
  media.addEventListener('playing', playing);
  media.addEventListener('waiting', waiting);
  const probe = (() => {
    const r = (box ?? media).getBoundingClientRect();
    const q = (media as any).getVideoPlaybackQuality?.();
    const wq = (media as any).webkitDecodedFrameCount != null ? { totalVideoFrames: (media as any).webkitDecodedFrameCount, droppedVideoFrames: (media as any).webkitDroppedFrameCount } : null;
    const fq = q ?? wq;
    let latency: number | null = null;
    const sd = (media as any).getStartDate?.();
    const t0 = sd && !isNaN(sd.getTime()) && sd.getTime() > 0 ? sd.getTime() : null;
    const live = !Number.isFinite(media.duration);
    if (live && t0) latency = Math.max(0, (Date.now() - (t0 + media.currentTime * 1000)) / 1000);
    else if (live && media.seekable.length) latency = Math.max(0, media.seekable.end(media.seekable.length - 1) - media.currentTime);
    const conn: any = (navigator as any).connection;
    return {
      viewport: { w: r.width, h: r.height, dpr: window.devicePixelRatio || 1 },
      frames: fq ? { dropped: fq.droppedVideoFrames ?? 0, total: fq.totalVideoFrames ?? 0, corrupted: fq.corruptedVideoFrames || undefined } : null,
      res: media.videoWidth ? { w: media.videoWidth, h: media.videoHeight, fps: null } : null,
      volume: media.volume, muted: media.muted,
      buffer: bufferAhead(media),
      live, latency,
      dvrWindow: live && media.seekable.length ? media.seekable.end(media.seekable.length - 1) - media.seekable.start(0) : null,
      manifest: media.currentSrc && !media.currentSrc.startsWith('blob:') ? media.currentSrc : null,
      // The browser's own rough figure, only when nothing better is known.
      bandwidth: conn?.downlink ? conn.downlink * 1_000_000 : null,
      stalls: st.stalls, stallSeconds: st.seconds + (st.since != null ? (performance.now() - st.since) / 1000 : 0),
      wallClock: live && t0 ? t0 + media.currentTime * 1000 : null,
      engine: media.currentSrc && !media.currentSrc.startsWith('blob:') ? (/\.m3u8/i.test(media.currentSrc) ? 'Browser HLS' : 'Progressive') : null,
      online: typeof navigator !== 'undefined' ? navigator.onLine : null,
      hidden: typeof document !== 'undefined' ? document.hidden : null,
      ...(media.error ? {
        lastError: (['', 'MEDIA_ERR_ABORTED', 'MEDIA_ERR_NETWORK', 'MEDIA_ERR_DECODE', 'MEDIA_ERR_SRC_NOT_SUPPORTED'][media.error.code] || 'media error'),
        errorType: media.error.code === 2 ? 'network' : 'media', errorFatal: true,
      } : {}),
    } as Partial<StatsSample>;
  }) as StatsProbe & { destroy(): void };
  probe.destroy = () => { media.removeEventListener('playing', playing); media.removeEventListener('waiting', waiting); };
  return probe;
}

/**
 * hls.js (the console's channel monitors). Pass the Hls instance; listens for
 * fragment loads to count bytes and read the CDN's headers.
 */
export function hlsJsProbe(hls: any, media?: HTMLVideoElement | null): StatsProbe & { destroy(): void } {
  let bytes = 0, errors = 0, lastError: string | null = null, cdn: StatsSample['cdn'] = null;
  const onFrag = (_e: unknown, d: any) => {
    try {
      bytes += d?.frag?.stats?.loaded ?? d?.payload?.byteLength ?? 0;
      const nd = d?.networkDetails;
      const get = nd?.getResponseHeader ? (n: string) => nd.getResponseHeader(n) : nd?.headers?.get ? (n: string) => nd.headers.get(n) : null;
      if (get) cdn = cdnFromHeaders(get, d?.frag?.url ?? d?.frag?.baseurl);
      else cdn = { host: hostOf(d?.frag?.url), pop: null, cache: null, server: null };
    } catch { /* */ }
  };
  let httpStatus: number | null = null, errorType: string | null = null, errorFatal: boolean | null = null;
  const onErr = (_e: unknown, d: any) => {
    errors++;
    lastError = d?.details ?? null;
    errorType = String(d?.type || '').replace(/Error$/, '') || null;   // networkError -> network
    errorFatal = !!d?.fatal;
    const code = d?.response?.code ?? d?.networkDetails?.status;
    httpStatus = typeof code === 'number' ? code : (errorType === 'network' ? 0 : httpStatus);
  };
  // A good load clears the network verdict: an old 404 must not haunt a stream that recovered.
  const onOk = () => { if (errorType === 'network') { httpStatus = null; errorType = null; errorFatal = null; } };
  try { hls.on('hlsFragLoaded', onFrag); hls.on('hlsFragLoaded', onOk); hls.on('hlsError', onErr); } catch { /* */ }
  const probe = (() => {
    const lv = hls.levels?.[hls.currentLevel] ?? hls.levels?.[hls.loadLevel] ?? null;
    const det = lv?.details ?? null;
    const at = hls.audioTracks?.[hls.audioTrack] ?? null;
    const box = media?.getBoundingClientRect();
    const opt = box ? optimalFor((hls.levels ?? []) as any[], box.height, window.devicePixelRatio || 1) : null;
    const fps = (l: any) => (l?.frameRate || Number(l?.attrs?.['FRAME-RATE']) || null);
    const live = det ? !!det.live : null;
    return {
      engine: `hls.js ${(hls.constructor as any)?.version ?? ''}`.trim() + ' (MSE)',
      format: 'HLS',
      manifest: hls.url ?? null,
      res: lv?.width ? { w: lv.width, h: lv.height, fps: fps(lv) } : null,
      optimal: opt ? { w: (opt as any).width, h: (opt as any).height, fps: fps(opt) } : null,
      videoCodec: lv?.videoCodec ?? splitCodecs(lv?.attrs?.CODECS).video,
      audioCodec: lv?.audioCodec ?? at?.audioCodec ?? splitCodecs(lv?.attrs?.CODECS).audio,
      audioChannels: at?.channels ? parseInt(at.channels, 10) || null : null,
      hdr: lv?.videoRange ?? null,
      bitrate: lv?.bitrate ?? null,
      abr: hls.autoLevelEnabled ? 'auto' : 'pinned',
      bandwidth: Number.isFinite(hls.bandwidthEstimate) ? hls.bandwidthEstimate : null,
      bytes,
      live,
      latency: live && Number.isFinite(hls.latency) && hls.latency > 0 ? hls.latency : null,
      targetLatency: live && Number.isFinite(hls.targetLatency) ? hls.targetLatency : null,
      lowLatency: !!hls.config?.lowLatencyMode && !!det?.partList,
      dvrWindow: live && det ? det.totalduration : null,
      segmentDuration: det?.targetduration ?? null,
      cdn, errors, lastError, httpStatus, errorType, errorFatal,
      lowestBitrate: (hls.levels ?? []).reduce((m: number | null, l: any) => (l?.bitrate && (m == null || l.bitrate < m) ? l.bitrate : m), null),
      playlistMisses: live && det ? (det.misses ?? null) : null,
    } as Partial<StatsSample>;
  }) as StatsProbe & { destroy(): void };
  probe.destroy = () => { try { hls.off('hlsFragLoaded', onFrag); hls.off('hlsFragLoaded', onOk); hls.off('hlsError', onErr); } catch { /* */ } };
  return probe;
}

/** '30', '25', '30000/1001' -> frames per second. */
export function parseFrameRate(f: unknown): number | null {
  if (f == null || f === '') return null;
  const [n, d] = String(f).split('/').map(Number);
  const v = d ? n / d : n;
  return Number.isFinite(v) && v > 0 ? Math.round(v * 100) / 100 : null;
}

/** dash.js 4 (the console's DASH monitors). */
export function dashJsProbe(player: any): StatsProbe & { destroy(): void } {
  let bytes = 0, errors = 0, lastError: string | null = null, host: string | null = null;
  const onFrag = (e: any) => { try { bytes += e?.response?.byteLength ?? 0; host = hostOf(e?.request?.url) ?? host; } catch { /* */ } };
  const onErr = (e: any) => { errors++; lastError = e?.error?.message ?? e?.error?.code ?? null; };
  try { player.on('fragmentLoadingCompleted', onFrag); player.on('error', onErr); } catch { /* */ }
  const probe = (() => {
    const s: Partial<StatsSample> = { format: 'DASH', bytes, errors, lastError, cdn: host ? { host, pop: null, cache: null, server: null } : null };
    try { s.engine = `dash.js ${player.getVersion?.() ?? ''}`.trim() + ' (MSE)'; } catch { /* */ }
    try { s.manifest = player.getSource?.() ?? null; } catch { /* */ }
    // The PLAYING representation (codec, frame rate, segment length): the
    // track's own codec is only its first representation's.
    const playing = (type: 'video' | 'audio') => {
      try {
        const t = player.getCurrentTrackFor(type);
        const q = player.getQualityFor(type);
        const reps: any[] = player.getDashAdapter?.()?.getVoRepresentations?.(t) ?? [];
        return { track: t, rep: reps.find((r) => r.index === q) ?? reps[q] ?? null };
      } catch { return { track: null, rep: null }; }
    };
    const trackCodec = (t: any) => (t?.codec ?? '').replace(/^.*codecs="?([^"]+)"?.*$/, '$1') || null;
    const v = playing('video'), a = playing('audio');
    const fps = parseFrameRate(v.rep?.frameRate);
    try {
      const list = player.getBitrateInfoListFor('video') ?? [];
      const q = list[player.getQualityFor('video')];
      if (q) { s.bitrate = q.bitrate; s.res = q.width ? { w: q.width, h: q.height, fps } : null; }
      const el: HTMLVideoElement | null = player.getVideoElement?.() ?? null;
      const o = el ? optimalFor(list, el.getBoundingClientRect().height, window.devicePixelRatio || 1) : null;
      if (o && o.width && o.height) s.optimal = { w: o.width, h: o.height, fps };
      const auto = player.getSettings?.()?.streaming?.abr?.autoSwitchBitrate?.video;
      s.abr = auto === false ? 'pinned' : 'auto';
    } catch { /* */ }
    s.videoCodec = v.rep?.codecs || trackCodec(v.track);
    s.audioCodec = a.rep?.codecs || trackCodec(a.track);
    if (v.rep?.segmentDuration > 0) s.segmentDuration = v.rep.segmentDuration;
    try { const ch = a.track?.audioChannelConfiguration?.[0]; if (ch && /^\d+$/.test(String(ch))) s.audioChannels = Number(ch); } catch { /* */ }
    try { const kbps = player.getAverageThroughput('video'); if (kbps > 0) s.bandwidth = kbps * 1000; } catch { /* */ }
    try { s.live = !!player.isDynamic(); } catch { /* */ }
    try { if (s.live) { const l = player.getCurrentLiveLatency(); if (Number.isFinite(l) && l > 0) s.latency = l; } } catch { /* */ }
    try { if (s.live) { const t = player.getTargetLiveDelay?.(); if (Number.isFinite(t) && t > 0) s.targetLatency = t; } } catch { /* */ }
    try { if (s.live) s.dvrWindow = player.getDVRWindowSize() || null; } catch { /* */ }
    try { const b = player.getBufferLength('video'); if (Number.isFinite(b)) s.buffer = b; } catch { /* */ }
    return s;
  }) as StatsProbe & { destroy(): void };
  probe.destroy = () => { try { player.off('fragmentLoadingCompleted', onFrag); player.off('error', onErr); } catch { /* */ } };
  return probe;
}

// --------------------------------------------------------------- the panel

const HISTORY = 60;
const GRAPH_COLOUR: Record<string, string> = { speed: '#5eead4', net: '#93c5fd', buffer: '#fde68a', latency: '#f9a8d4' };

export interface StatsPanelOptions {
  /** Where the panel is drawn (absolutely positioned, top left). */
  host: HTMLElement;
  probe: StatsProbe;
  version?: string;
  title?: string;
  /** Called when the viewer closes it with ×, so the owner's state follows. */
  onClose?: () => void;
}

export class StatsPanel {
  readonly el: HTMLElement;
  private o: StatsPanelOptions;
  private body: HTMLElement;
  private timer: ReturnType<typeof setInterval> | null = null;
  private hist = new Map<string, number[]>();
  private lastBytes: number | null = null;
  private lastDelta: number | null = null;
  private last: StatsSample | null = null;
  private rowEls = new Map<string, { row: HTMLElement; val: HTMLElement; cv?: HTMLCanvasElement }>();
  private verdict!: HTMLElement;
  private copyBtn!: HTMLButtonElement;
  open = false;

  constructor(o: StatsPanelOptions) {
    this.o = o;
    injectStatsStyles();
    this.el = document.createElement('div');
    this.el.className = 'vp-stats';
    this.el.hidden = true;
    this.el.setAttribute('role', 'dialog');
    this.el.setAttribute('aria-label', 'Playback stats');
    const head = document.createElement('div');
    head.className = 'vp-stats-head';
    const title = document.createElement('span');
    title.textContent = o.title ?? 'Playback stats';
    const copy = document.createElement('button');
    copy.type = 'button'; copy.className = 'vp-stats-btn'; copy.textContent = 'Copy';
    copy.title = 'Copy these stats for a support ticket';
    copy.addEventListener('click', (e) => { e.stopPropagation(); void this.copy().then((ok) => { copy.textContent = ok ? 'Copied' : 'Copy failed'; setTimeout(() => { copy.textContent = 'Copy'; }, 1500); }); });
    const close = document.createElement('button');
    close.type = 'button'; close.className = 'vp-stats-btn'; close.textContent = '×';
    close.setAttribute('aria-label', 'Close playback stats');
    close.addEventListener('click', (e) => { e.stopPropagation(); this.setOpen(false); this.o.onClose?.(); });
    head.append(title, copy, close);
    this.body = document.createElement('div');
    this.body.className = 'vp-stats-body';
    this.verdict = document.createElement('div');
    this.verdict.className = 'vp-stats-verdict';
    this.copyBtn = copy;
    this.el.append(head, this.verdict, this.body);
    // Clicks inside never reach the stage (which would play/pause).
    for (const ev of ['click', 'dblclick', 'pointerdown', 'contextmenu']) this.el.addEventListener(ev, (e) => e.stopPropagation());
    o.host.appendChild(this.el);
  }

  setProbe(p: StatsProbe): void { this.o.probe = p; this.lastBytes = null; }

  setOpen(on: boolean): void {
    if (on === this.open) return;
    this.open = on;
    this.el.hidden = !on;
    if (on) { this.sample(); this.timer = setInterval(() => this.sample(), 1000); }
    else if (this.timer) { clearInterval(this.timer); this.timer = null; }
  }

  toggle(): boolean { this.setOpen(!this.open); return this.open; }

  /** A fresh sample (whether or not the panel is open). */
  read(): StatsSample {
    let s: StatsSample;
    try { s = { ...emptySample(), ...this.o.probe() }; } catch { s = emptySample(); }
    return s;
  }

  text(): string {
    const s = this.last ?? this.read();
    return statsReport(s, this.lastDelta, { version: this.o.version, userAgent: navigator.userAgent, page: location.href });
  }

  async copy(): Promise<boolean> {
    const t = this.text();
    try { await navigator.clipboard.writeText(t); return true; } catch { /* insecure context: fall back */ }
    try {
      const ta = document.createElement('textarea');
      ta.value = t; ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      return ok;
    } catch { return false; }
  }

  private sample() {
    const s = this.read();
    this.last = s;
    let delta: number | null = null;
    if (s.bytes != null) { delta = this.lastBytes == null ? 0 : Math.max(0, s.bytes - this.lastBytes); this.lastBytes = s.bytes; }
    this.lastDelta = delta;
    // The verdict leads: which side of the line the problem is on, and whether
    // it is worth reporting at all.
    const dg = diagnose(s);
    const vt = `${SIDE_LABEL[dg.side]} · ${dg.title}`;
    if (this.verdict.dataset.side !== dg.side || this.verdict.firstChild?.textContent !== vt) {
      this.verdict.dataset.side = dg.side;
      this.verdict.replaceChildren();
      const b = document.createElement('b'); b.textContent = vt;
      const p = document.createElement('div'); p.textContent = dg.report ? `${dg.detail} Copy this panel into the support ticket.` : dg.detail;
      this.verdict.append(b, p);
      this.copyBtn.title = dg.report ? 'Copy for a support ticket: this looks like a platform fault' : 'Copy these stats (no platform fault found)';
    }
    const rows = statsRows(s, delta);
    const seen = new Set<string>();
    let prev: HTMLElement | null = null;
    for (const r of rows) {
      seen.add(r.key);
      let x = this.rowEls.get(r.key);
      if (!x) {
        const row = document.createElement('div'); row.className = 'vp-stats-row';
        const lab = document.createElement('span'); lab.className = 'vp-stats-k'; lab.textContent = r.label;
        const val = document.createElement('span'); val.className = 'vp-stats-v';
        row.append(lab);
        let cv: HTMLCanvasElement | undefined;
        if (r.graph) {
          const wrap = document.createElement('span'); wrap.className = 'vp-stats-g';
          cv = document.createElement('canvas'); cv.width = 240; cv.height = 22;
          wrap.append(cv, val); row.append(wrap);
        } else row.append(val);
        x = { row, val, cv };
        this.rowEls.set(r.key, x);
      }
      // Keep the order statsRows gives, inserting rows that appear later in place.
      if (x.row.previousElementSibling !== prev || !x.row.isConnected) {
        if (prev) prev.after(x.row); else this.body.prepend(x.row);
      }
      prev = x.row;
      if (x.val.textContent !== r.value) x.val.textContent = r.value;
      x.val.title = r.full ?? r.value;
      if (r.graph && x.cv) {
        const h = this.hist.get(r.key) ?? [];
        h.push(r.graph.v); if (h.length > HISTORY) h.shift();
        this.hist.set(r.key, h);
        drawGraph(x.cv, h, GRAPH_COLOUR[r.graph.kind] ?? '#e5e7eb');
      }
    }
    for (const [k, x] of this.rowEls) if (!seen.has(k)) { x.row.remove(); this.rowEls.delete(k); this.hist.delete(k); }
  }

  destroy(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.el.remove();
  }
}

/** Bars, newest on the right, scaled to the window's own peak so a change is visible at any level. */
function drawGraph(cv: HTMLCanvasElement, h: number[], colour: string) {
  const g = cv.getContext('2d');
  if (!g) return;
  const W = cv.width, H = cv.height;
  g.clearRect(0, 0, W, H);
  g.fillStyle = 'rgba(255,255,255,.08)';
  g.fillRect(0, 0, W, H);
  const max = Math.max(1e-9, ...h);
  const bw = W / HISTORY;
  g.fillStyle = colour;
  const off = HISTORY - h.length;
  for (let i = 0; i < h.length; i++) {
    const v = Math.max(0, h[i]) / max;
    const bh = Math.max(v > 0 ? 1 : 0, Math.round(v * (H - 2)));
    g.fillRect(Math.floor((off + i) * bw), H - bh, Math.max(1, Math.ceil(bw) - 1), bh);
  }
}

// --------------------------------------------------------------- the menu

export interface DebugMenuItem { label: string; checked?: boolean; run: () => void }

/**
 * The player's own right-click menu (Playback stats, Copy debug info). A
 * Shift+right-click still gives the browser's menu. Returns an unbind.
 */
export function bindDebugMenu(target: HTMLElement, items: () => DebugMenuItem[], footer?: string): () => void {
  injectStatsStyles();
  let menu: HTMLElement | null = null;
  const close = () => { menu?.remove(); menu = null; document.removeEventListener('pointerdown', outside, true); document.removeEventListener('keydown', esc, true); };
  const outside = (e: Event) => { if (menu && !menu.contains(e.target as Node)) close(); };
  const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } };
  const onCtx = (e: MouseEvent) => {
    if (e.shiftKey) return;
    e.preventDefault();
    close();
    const box = target.getBoundingClientRect();
    menu = document.createElement('div');
    menu.className = 'vp-ctx';
    menu.setAttribute('role', 'menu');
    for (const it of items()) {
      const b = document.createElement('button');
      b.type = 'button';
      b.setAttribute('role', it.checked != null ? 'menuitemcheckbox' : 'menuitem');
      if (it.checked != null) b.setAttribute('aria-checked', String(it.checked));
      b.textContent = it.label;
      if (it.checked) b.classList.add('on');
      b.addEventListener('click', (ev) => { ev.stopPropagation(); close(); it.run(); });
      menu.appendChild(b);
    }
    if (footer) { const f = document.createElement('div'); f.className = 'vp-ctx-foot'; f.textContent = footer; menu.appendChild(f); }
    for (const ev of ['click', 'pointerdown']) menu.addEventListener(ev, (x) => x.stopPropagation());
    if (getComputedStyle(target).position === 'static') target.style.position = 'relative';
    target.appendChild(menu);
    const mw = menu.offsetWidth, mh = menu.offsetHeight;
    menu.style.left = `${Math.max(4, Math.min(e.clientX - box.left, box.width - mw - 4))}px`;
    menu.style.top = `${Math.max(4, Math.min(e.clientY - box.top, box.height - mh - 4))}px`;
    (menu.querySelector('button') as HTMLElement | null)?.focus({ preventScroll: true });
    setTimeout(() => { document.addEventListener('pointerdown', outside, true); document.addEventListener('keydown', esc, true); });
  };
  target.addEventListener('contextmenu', onCtx);
  return () => { close(); target.removeEventListener('contextmenu', onCtx); };
}

// --------------------------------------------------------------- outside the SDK player

export interface AttachedStats {
  panel: StatsPanel;
  show(on?: boolean): void;
  copy(): Promise<boolean>;
  setProbe(p: StatsProbe): void;
  destroy(): void;
}

/**
 * The same panel and menu on a player the SDK does not own (the console's
 * hls.js / dash.js monitors):
 *
 *   const stats = attachStats(wrapper, combineProbes(hlsJsProbe(hls, video), mediaProbe(video, wrapper)))
 *   // later: stats.destroy()
 *
 * Right-click on `host` opens the menu; Shift+D toggles while it has focus.
 */
/** Debug mode: Shift+D, or Cmd+D (Mac) / Ctrl+D. Never inside a text field. */
export function isDebugKey(e: KeyboardEvent): boolean {
  if ((e.target as HTMLElement)?.closest?.('input,select,textarea,[contenteditable]')) return false;
  if (e.key !== 'D' && e.key !== 'd') return false;
  if (e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey) return true;
  return (e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey;
}

/**
 * A POOR CONNECTION SAYS SO, WITHOUT DEBUG MODE.
 *
 * Event driven, so it costs nothing while playback is fine: only a stall that
 * lasts three seconds takes one sample. When diagnose() puts the problem on
 * the viewer's side, a small note says so for a few seconds, so the viewer
 * knows to look at their own connection rather than file a report.
 */
export function watchConnection(host: HTMLElement, media: HTMLMediaElement, sample: () => Partial<StatsSample>): () => void {
  injectStatsStyles();
  let t: ReturnType<typeof setTimeout> | null = null;
  let note: HTMLElement | null = null;
  let shownAt = 0;
  const clear = () => { if (t) { clearTimeout(t); t = null; } };
  const waiting = () => {
    clear();
    t = setTimeout(() => {
      t = null;
      if (Date.now() - shownAt < 60_000) return;          // once a minute at most
      let dg: Diagnosis;
      try { dg = diagnose(sample()); } catch { return; }
      if (dg.side !== 'local') return;
      note?.remove();
      note = document.createElement('div');
      note.className = 'vp-net-note';
      note.textContent = `${dg.title}. Not a stream fault.`;
      host.appendChild(note);
      shownAt = Date.now();
      const n = note;
      setTimeout(() => { n.remove(); if (note === n) note = null; }, 8000);
    }, 3000);
  };
  media.addEventListener('waiting', waiting);
  media.addEventListener('playing', clear);
  return () => { clear(); note?.remove(); media.removeEventListener('waiting', waiting); media.removeEventListener('playing', clear); };
}

export function attachStats(host: HTMLElement, probe: StatsProbe, o: { version?: string; menu?: boolean; onChange?: (open: boolean) => void; media?: HTMLMediaElement } = {}): AttachedStats {
  if (getComputedStyle(host).position === 'static') host.style.position = 'relative';
  const panel = new StatsPanel({ host, probe, version: o.version, onClose: () => o.onChange?.(false) });
  const show = (on?: boolean) => { panel.setOpen(on ?? !panel.open); o.onChange?.(panel.open); };
  const unbind = o.menu === false ? () => {} : bindDebugMenu(host, () => [
    { label: 'Debug mode', checked: panel.open, run: () => show() },
    { label: 'Copy debug info', run: () => void panel.copy() },
  ], o.version ? `Volt Player ${o.version}` : undefined);
  const key = (e: KeyboardEvent) => { if (isDebugKey(e)) { e.preventDefault(); e.stopPropagation(); show(); } };
  if (!host.hasAttribute('tabindex')) host.tabIndex = -1;
  host.addEventListener('keydown', key);
  // Cmd/Ctrl+D while the pointer is over the player, without focusing it first.
  const hover = (e: KeyboardEvent) => { if (host.matches(':hover') && !host.contains(document.activeElement)) key(e); };
  document.addEventListener('keydown', hover);
  const hint = o.media ? watchConnection(host, o.media, () => panel.read()) : null;
  return {
    panel, show, copy: () => panel.copy(), setProbe: (p) => panel.setProbe(p),
    destroy: () => { unbind(); host.removeEventListener('keydown', key); document.removeEventListener('keydown', hover); hint?.(); panel.destroy(); },
  };
}

// --------------------------------------------------------------- styles

let styled = false;
/** Own stylesheet, so a console page using attachStats without the SDK's skins still gets it. */
export function injectStatsStyles(): void {
  if (styled || typeof document === 'undefined') return;
  styled = true;
  const s = document.createElement('style');
  s.id = 'volt-player-stats-styles';
  s.textContent = STATS_CSS;
  document.head.appendChild(s);
}

const STATS_CSS = `
.vp-stats{position:absolute;left:10px;top:10px;z-index:40;max-width:calc(100% - 20px);max-height:calc(100% - 20px);overflow:auto;box-sizing:border-box;
  background:rgba(12,14,18,.82);color:#e5e7eb;border:1px solid rgba(255,255,255,.12);border-radius:4px;padding:4px 10px 8px;
  font:12px/1.55 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;-webkit-backdrop-filter:blur(4px);backdrop-filter:blur(4px);text-align:left;cursor:default}
.vp-stats[hidden]{display:none}
.vp-stats-head{display:flex;align-items:center;gap:6px;padding:2px 0 4px;margin-bottom:4px;border-bottom:1px solid rgba(255,255,255,.1);font-family:system-ui,-apple-system,Segoe UI,sans-serif;font-size:12px;font-weight:600;letter-spacing:.02em}
.vp-stats-head span{flex:1}
.vp-stats-btn{all:unset;cursor:pointer;padding:1px 7px;border-radius:3px;color:#cbd5e1;font:500 12px/1.5 system-ui,-apple-system,Segoe UI,sans-serif}
.vp-stats-btn:hover,.vp-stats-btn:focus-visible{background:rgba(255,255,255,.12);color:#fff}
.vp-stats-verdict{margin:2px 0 6px;padding:5px 8px;border-radius:3px;font:12px/1.4 system-ui,-apple-system,Segoe UI,sans-serif;white-space:normal;max-width:460px;background:rgba(148,163,184,.14)}
.vp-stats-verdict b{display:block;font-weight:600}
.vp-stats-verdict div{color:#cbd5e1}
.vp-stats-verdict[data-side=ok]{background:rgba(74,222,128,.14)}
.vp-stats-verdict[data-side=local],.vp-stats-verdict[data-side=access]{background:rgba(96,165,250,.16)}
.vp-stats-verdict[data-side=delivery],.vp-stats-verdict[data-side=server],.vp-stats-verdict[data-side=code]{background:rgba(248,113,113,.2)}
.vp-net-note{position:absolute;left:50%;bottom:12px;transform:translateX(-50%);z-index:35;max-width:calc(100% - 24px);padding:5px 10px;border-radius:4px;background:rgba(12,14,18,.85);color:#e5e7eb;font:12px/1.4 system-ui,-apple-system,Segoe UI,sans-serif;pointer-events:none}
.vp-stats-body{display:grid;grid-template-columns:max-content minmax(0,1fr);column-gap:12px}
.vp-stats-row{display:contents}
.vp-stats-k{color:#9ca3af;text-align:right;white-space:nowrap}
.vp-stats-v{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0}
.vp-stats-g{display:flex;align-items:center;gap:8px;min-width:0}
.vp-stats-g canvas{width:120px;height:11px;flex:none;image-rendering:pixelated}
@container (max-width:520px){.vp-stats{font-size:10.5px;line-height:1.45;padding:3px 7px 6px}.vp-stats-g canvas{width:72px}}
.vp-ctx{position:absolute;z-index:60;min-width:190px;background:rgba(20,22,28,.96);color:#e5e7eb;border:1px solid rgba(255,255,255,.12);border-radius:4px;padding:4px 0;
  box-shadow:0 8px 24px rgba(0,0,0,.45);font:13px/1.4 system-ui,-apple-system,Segoe UI,sans-serif}
.vp-ctx button{all:unset;box-sizing:border-box;display:flex;align-items:center;width:100%;padding:7px 14px 7px 30px;cursor:pointer;position:relative}
.vp-ctx button:hover,.vp-ctx button:focus-visible{background:rgba(255,255,255,.1)}
.vp-ctx button.on::before{content:'';position:absolute;left:12px;top:50%;width:8px;height:4px;border:solid currentColor;border-width:0 0 2px 2px;transform:translateY(-70%) rotate(-45deg)}
.vp-ctx-foot{padding:6px 14px 3px 30px;margin-top:3px;border-top:1px solid rgba(255,255,255,.08);color:#9ca3af;font-size:11px}
`;
