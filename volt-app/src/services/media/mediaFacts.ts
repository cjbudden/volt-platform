// ============================================================================
//  MEDIA FACTS: what a delivered asset actually carries, read from its own
//  files and kept on the asset (vod_assets.media_facts, migration 0077).
//
//  WHY READ THE OUTPUT, NOT THE SETTINGS. The Encode tab used to show the video
//  profile, the audio tracks and their languages from what the encoder is told
//  to do ("libx264 uses High by default", "AAC 128 kb/s stereo"), marked
//  derived. That is a guess about the file. ffprobe on a rendition's init
//  segment answers from the bitstream itself (the avcC/hvcC box carries the
//  profile and level, the audio sample entry the codec, channels and rate, the
//  mdhd box the language), and an init segment never changes once written, so
//  reading it once and keeping the answer is exact and costs nothing later.
//
//  WHY IT IS ALSO HOW A PACKAGE-ONLY SOURCE IS KNOWN. A package-only stream
//  passes the contributor's own encode through, so nothing in Volt chose its
//  codec or audio. The recording's init segments are the only record of it.
// ============================================================================
import { execFile } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

export interface VideoFact { label: string; codec: string | null; profile: string | null; level: string | null; width: number | null; height: number | null; fps: number | null }
export interface AudioFact { label: string; codec: string | null; channels: number | null; sampleRate: number | null; bitrateKbps: number | null; language: string | null }
export interface SubtitleFact { codec: string | null; language: string | null }
export interface MediaFacts {
  /** encode: read from a file encode's packaged renditions; recording: from the live recording's init segments. */
  how: 'encode' | 'recording';
  at: string;
  video: VideoFact[];
  audio: AudioFact[];
  subtitles: SubtitleFact[];
  /** Recording only: the run the facts were read from, and how many runs the asset spans. */
  run?: string | null;
  runs?: number;
}

const n = (v: unknown): number | null => { const x = Number(v); return v == null || v === '' || !Number.isFinite(x) || x <= 0 ? null : x; };
/** 'und' is ISO 639-2 for "undetermined": no language, not a language called und. */
const lang = (s: any): string | null => { const t = s?.tags?.language; return t && t !== 'und' ? String(t) : null; };
function rate(r?: string): number | null {
  if (!r || !r.includes('/')) return null;
  const [a, b] = r.split('/').map(Number);
  return a > 0 && b > 0 ? Math.round((a / b) * 1000) / 1000 : null;
}
/** ffprobe gives H.264 level as 31 for 3.1 and HEVC as 93 for 3.1 (level x 30). */
function levelOf(codec: string | null, l: unknown): string | null {
  const v = n(l);
  if (v == null) return null;
  const x = codec === 'hevc' ? v / 30 : v / 10;
  return String(Math.round(x * 10) / 10);
}

/** The streams of one ffprobe -show_streams JSON, sorted into kinds. Pure, for the tests. */
export function parseStreams(j: any, label = ''): { video: VideoFact[]; audio: AudioFact[]; subtitles: SubtitleFact[] } {
  const streams: any[] = Array.isArray(j?.streams) ? j.streams : [];
  const video: VideoFact[] = [], audio: AudioFact[] = [], subtitles: SubtitleFact[] = [];
  for (const s of streams) {
    const codec = s.codec_name ? String(s.codec_name) : null;
    if (s.codec_type === 'video') {
      // Cover art in an MP4 or MP3 is a video stream too; it is not a picture track.
      if (s.disposition?.attached_pic) continue;
      video.push({ label, codec, profile: s.profile && s.profile !== 'unknown' ? String(s.profile) : null, level: levelOf(codec, s.level),
        width: n(s.width), height: n(s.height), fps: rate(s.avg_frame_rate) ?? rate(s.r_frame_rate) });
    } else if (s.codec_type === 'audio') {
      const br = n(s.bit_rate);
      audio.push({ label, codec, channels: n(s.channels), sampleRate: n(s.sample_rate), bitrateKbps: br == null ? null : Math.round(br / 1000), language: lang(s) });
    } else if (s.codec_type === 'subtitle') {
      subtitles.push({ codec, language: lang(s) });
    }
  }
  return { video, audio, subtitles };
}

/**
 * What to hand ffprobe for an init segment: the init followed by the first
 * media segment beside it, joined with ffmpeg's concat protocol (an fMP4 init
 * plus a fragment is a valid file when the bytes are simply joined).
 *
 * WHY NOT THE INIT ALONE. Shaka Packager writes the H.264 parameter sets in
 * band (avc3-style, as the live path needs), so its init.mp4 has no profile or
 * level for ffprobe to read, and with no samples the frame rate comes out as
 * the 90 kHz timescale. The first fragment carries the SPS and real timing.
 */
function probeTarget(path: string): string {
  if (!/init\.mp4$/.test(path)) return path;
  try {
    const dir = dirname(path);
    const first = readdirSync(dir).map((f) => /^seg_(\d+)\.m4s$/.exec(f)).filter(Boolean)
      .sort((a, b) => Number(a![1]) - Number(b![1]))[0];
    return first ? `concat:${path}|${join(dir, first[0])}` : path;
  } catch { return path; }
}

function ffprobeJson(path: string, bin: string): Promise<any | null> {
  return new Promise((resolve) => {
    execFile(bin, ['-v', 'error', '-print_format', 'json', '-show_streams', probeTarget(path)], { timeout: 15_000, maxBuffer: 4 << 20 }, (err, out) => {
      if (err) return resolve(null);
      try { resolve(JSON.parse(String(out))); } catch { resolve(null); }
    });
  });
}

/**
 * Read the facts from a set of local files (each rendition's init segment, or
 * a source file). Returns null when none of them could be read, so a caller
 * never stores an empty answer as if it were "nothing in there".
 */
export async function probeFiles(files: { label: string; path: string }[], how: MediaFacts['how'],
  bin = process.env.FFPROBE_BIN || 'ffprobe'): Promise<MediaFacts | null> {
  const out: MediaFacts = { how, at: new Date().toISOString(), video: [], audio: [], subtitles: [] };
  let read = 0;
  for (const f of files) {
    if (!existsSync(f.path)) continue;
    const j = await ffprobeJson(f.path, bin);
    if (!j) continue;
    read++;
    const p = parseStreams(j, f.label);
    out.video.push(...p.video); out.audio.push(...p.audio); out.subtitles.push(...p.subtitles);
  }
  out.video.sort((a, b) => (b.height ?? 0) - (a.height ?? 0));
  return read ? out : null;
}
