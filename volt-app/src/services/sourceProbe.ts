// Probe an ingest source with ffprobe and return the received broadcast details:
// container, video (dimensions/codec/fps/bitrate), audio track(s), and any ADDITIONAL
// elementary streams the source carries (in-band metadata, subtitles, extra audio, data).
// Push protocols (SRT/RTMP) cannot be probed on demand; their details appear once a feed
// is actually being received (surfaced live from the ingest instead).
import { execFile } from 'node:child_process';
import { inspectHls, looksLikeHls, type HlsInspection } from './hlsMaster';

export interface SourceProbe {
  ok: boolean;
  reachable: boolean;
  container?: { format?: string; bitrate_kbps?: number | null };
  video?: { codec?: string; width?: number; height?: number; fps?: number | null; pix_fmt?: string; profile?: string; bitrate_kbps?: number | null };
  audio?: Array<{ codec?: string; channels?: number; sample_rate?: number; bitrate_kbps?: number | null; language?: string | null }>;
  other?: Array<{ kind: string; codec?: string; language?: string | null; note?: string }>;
  note?: string;
  error?: string;
  /** For an HLS address: the playlist itself (master with its variants, or media), and any redirect. */
  hls?: HlsInspection;
}

function fps(r?: string): number | null {
  if (!r || r === '0/0') return null;
  const [n, d] = r.split('/').map(Number);
  return d ? Math.round((n / d) * 100) / 100 : null;
}
function kbps(v: any): number | null { const n = Number(v); return Number.isFinite(n) && n > 0 ? Math.round(n / 1000) : null; }

// WHAT THE PROBE MAY OPEN. It runs ffprobe on a string an operator typed, from
// the control plane, so without a fence it reads local files (`/etc/passwd`,
// `file:` URLs, or a playlist whose segments point at them) and anything else
// ffmpeg has a protocol for. Network schemes only, and the same list is handed
// to ffprobe as its protocol whitelist so a playlist cannot reach outside it.
export const PROBE_SCHEMES = ['http', 'https', 'rtmp', 'rtmps', 'rtsp', 'srt', 'udp', 'rtp'];
const PROTOCOL_WHITELIST = 'http,https,tls,tcp,udp,rtp,rtmp,rtmps,rtsp,srt,crypto,hls,httpproxy';
// A probe holds an ffprobe process for up to 20 s. A small global cap keeps a
// burst of clicks (or a script) from spawning dozens of them.
const MAX_CONCURRENT = 4;
let inFlight = 0;

export function probeUrlProblem(url: string): string | null {
  const m = /^([a-z][a-z0-9+.-]*):\/\//i.exec(url.trim());
  if (!m) return 'Enter a full URL, starting with its scheme (for example https:// or srt://).';
  if (!PROBE_SCHEMES.includes(m[1].toLowerCase())) return `${m[1]}:// sources cannot be checked from here.`;
  return null;
}

export async function probeSource(url: string, protocol?: string, timeoutMs = 20000): Promise<SourceProbe> {
  const proto = (protocol || '').toLowerCase();
  if (proto === 'ndi' || proto === 'st2110') {
    return { ok: true, reachable: false, note: `${proto === 'ndi' ? 'NDI' : 'ST 2110'} is only visible on the local network of the ingest node, so it is checked when the channel starts.` };
  }
  // A push source is a LISTENER we open: there is nothing to dial until the
  // sender connects. A caller-mode SRT URL (mode=caller) is a pull and is probed.
  const pushListener = (proto === 'rtmp' || proto === 'rtmps') || (proto === 'srt' && !/[?&]mode=caller\b/i.test(url));
  if (pushListener) {
    return { ok: true, reachable: false, note: `${proto.toUpperCase()} is a push source; received details appear once a feed is pushed to the ingest endpoint.` };
  }
  const problem = probeUrlProblem(url);
  if (problem) return { ok: false, reachable: false, error: problem };
  if (inFlight >= MAX_CONCURRENT) return { ok: false, reachable: false, error: 'Several sources are being checked already. Try again in a few seconds.' };
  inFlight++;
  try {
    // An HLS address is also read as a playlist, alongside ffprobe: ffprobe
    // flattens a master's variants into one list of tracks, the playlist says
    // which variant each belongs to and lets one be chosen.
    const [probe, hls] = await Promise.all([runProbe(url, timeoutMs), looksLikeHls(url, proto) ? inspectHls(url) : Promise.resolve(undefined)]);
    return hls ? { ...probe, hls } : probe;
  } finally { inFlight--; }
}

async function runProbe(url: string, timeoutMs: number): Promise<SourceProbe> {
  const args = ['-v', 'error', '-protocol_whitelist', PROTOCOL_WHITELIST, '-show_format', '-show_streams', '-of', 'json', '-rw_timeout', '8000000', url];
  return await new Promise<SourceProbe>((resolve) => {
    execFile('ffprobe', args, { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
      if (err && !stdout) { resolve({ ok: false, reachable: false, error: 'Could not read the source (unreachable, blocked, or not a stream).' }); return; }
      let j: any;
      try { j = JSON.parse(stdout); } catch { resolve({ ok: false, reachable: false, error: 'Source did not return a probeable stream.' }); return; }
      const streams: any[] = j.streams || [];
      // ffprobe prints an empty object on most failures (a 404, a refused
      // protocol), so an exit error or a stream with nothing in it is a failure,
      // not a reachable source with no tracks.
      if (!streams.length) {
        resolve({ ok: false, reachable: false, error: err ? 'Could not read the source (unreachable, blocked, or not a stream).' : 'The source answered but carries no audio or video.' });
        return;
      }
      const v = streams.find((s) => s.codec_type === 'video');
      const audio = streams.filter((s) => s.codec_type === 'audio').map((s) => ({
        codec: s.codec_name, channels: s.channels,
        sample_rate: s.sample_rate ? Number(s.sample_rate) : undefined,
        bitrate_kbps: kbps(s.bit_rate), language: s.tags?.language ?? null,
      }));
      const other = streams.filter((s) => !['video', 'audio'].includes(s.codec_type)).map((s) => ({
        kind: s.codec_type,
        codec: s.codec_name || s.codec_tag_string,
        language: s.tags?.language ?? null,
        note: s.codec_name === 'timed_id3' ? 'in-band timed metadata (ID3)' : undefined,
      }));
      resolve({
        ok: true, reachable: true,
        container: { format: j.format?.format_name, bitrate_kbps: kbps(j.format?.bit_rate) },
        video: v ? { codec: v.codec_name, width: v.width, height: v.height, fps: fps(v.avg_frame_rate || v.r_frame_rate), pix_fmt: v.pix_fmt, profile: v.profile, bitrate_kbps: kbps(v.bit_rate) } : undefined,
        audio, other,
      });
    });
  });
}
