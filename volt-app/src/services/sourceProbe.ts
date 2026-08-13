// Probe an ingest source with ffprobe and return the received broadcast details:
// container, video (dimensions/codec/fps/bitrate), audio track(s), and any ADDITIONAL
// elementary streams the source carries (in-band metadata, subtitles, extra audio, data).
// Push protocols (SRT/RTMP) cannot be probed on demand; their details appear once a feed
// is actually being received (surfaced live from the ingest instead).
import { execFile } from 'node:child_process';

export interface SourceProbe {
  ok: boolean;
  reachable: boolean;
  container?: { format?: string; bitrate_kbps?: number | null };
  video?: { codec?: string; width?: number; height?: number; fps?: number | null; pix_fmt?: string; profile?: string; bitrate_kbps?: number | null };
  audio?: Array<{ codec?: string; channels?: number; sample_rate?: number; bitrate_kbps?: number | null; language?: string | null }>;
  other?: Array<{ kind: string; codec?: string; language?: string | null; note?: string }>;
  note?: string;
  error?: string;
}

function fps(r?: string): number | null {
  if (!r || r === '0/0') return null;
  const [n, d] = r.split('/').map(Number);
  return d ? Math.round((n / d) * 100) / 100 : null;
}
function kbps(v: any): number | null { const n = Number(v); return Number.isFinite(n) && n > 0 ? Math.round(n / 1000) : null; }

export async function probeSource(url: string, protocol?: string, timeoutMs = 20000): Promise<SourceProbe> {
  const proto = (protocol || '').toLowerCase();
  if (proto === 'srt' || proto === 'rtmp' || proto === 'rtmps') {
    return { ok: true, reachable: false, note: `${proto.toUpperCase()} is a push source; received details appear once a feed is pushed to the ingest endpoint.` };
  }
  const args = ['-v', 'error', '-show_format', '-show_streams', '-of', 'json', '-rw_timeout', '8000000', url];
  return await new Promise<SourceProbe>((resolve) => {
    execFile('ffprobe', args, { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
      if (err && !stdout) { resolve({ ok: false, reachable: false, error: 'Could not read the source (unreachable, blocked, or not a stream).' }); return; }
      let j: any;
      try { j = JSON.parse(stdout); } catch { resolve({ ok: false, reachable: false, error: 'Source did not return a probeable stream.' }); return; }
      const streams: any[] = j.streams || [];
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
