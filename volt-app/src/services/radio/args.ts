// ============================================================================
//  RADIO FFMPEG ARGUMENTS — one description of the pipeline, two places to run it.
//
//  This file exists because a radio station is moving from "an ffmpeg the
//  control plane spawns" to "a container the launcher runs", and those two
//  things must not drift into two different pipelines. The argv IS the
//  pipeline, so it is built here, from a job config, by a pure function that
//  touches no filesystem and no process table. The in-process path (dev, and
//  the local launcher) calls it; volt-radio's entrypoint in the container is
//  handed the same job config and builds the same argv from it.
//
//  NO MP3 FROM THE STATION (build queue 2.1c-2, Christian 3 Nov 2026). A
//  station writes HLS and DASH: files, like television. It used to push MP3 to
//  an Icecast relay; that relay, and the push, are gone. MP3 for listeners,
//  where an account has it, is made on demand from the HLS by the control
//  plane (mp3Gateway.ts), so the station never knows MP3 exists.
//
//  `outputs.mp3` survives only for the in-process development path
//  (RADIO_MODE=inprocess), where the control plane reads MP3 off the child's
//  stdout (`pipe:1`) for its private preview. The container never writes it.
// ============================================================================

export interface RadioOutputs {
  mp3?: boolean;
  hls?: boolean;
  dash?: boolean;
}

/**
 * Everything the pipeline needs, and nothing about where it runs. This is the
 * shape handed to the container as JSON, exactly the way buildEncoderJobConfig
 * hands the encoder its own config.
 */
export interface RadioJobConfig {
  channelId: string;
  /** Source. `protocol` only decides whether reconnect flags make sense. */
  protocol: string;
  url: string;
  outputs: RadioOutputs;
  bitrateKbps: number;
  /** Re-encode rather than copy, even when the source is already MP3. */
  transcode?: boolean;
  /** Resolved by probing the source; null when unknown. Drives copy vs encode. */
  sourceCodec?: string | null;
  segmentSeconds?: number;
}

/** Absolute paths the pipeline writes to, resolved by whoever runs it. */
export interface RadioPaths {
  runDir: string;
  audioDir: string;
  dashDir: string;
}

export const DEFAULT_BITRATE_KBPS = 128;
export const MIN_BITRATE_KBPS = 32;
export const MAX_BITRATE_KBPS = 320;

/** Clamp to what the MP3/AAC encoders will actually accept. */
export function clampBitrate(kbps: number | undefined): number {
  const n = Number(kbps);
  if (!Number.isFinite(n)) return DEFAULT_BITRATE_KBPS;
  return Math.min(MAX_BITRATE_KBPS, Math.max(MIN_BITRATE_KBPS, Math.round(n)));
}

/**
 * Which outputs are on, with the defaults applied once, in one place.
 *
 * HLS AND DASH ARE THE STATION'S OUTPUTS; MP3 IS OFF. HLS and DASH are files
 * written into the origin. MP3 is only ever the in-process development pipe
 * (args below); the container ignores it, and listeners who get MP3 get it
 * from the control plane's on-demand gateway (2.1c-2).
 */
export function resolveOutputs(outputs: RadioOutputs | undefined): Required<RadioOutputs> {
  return { mp3: false, hls: true, dash: true, ...(outputs || {}) };
}

/**
 * True when MP3 can be a straight copy rather than a re-encode: the source is
 * already MP3 and nobody asked for a transcode. This is the difference between
 * a station costing a rounding error of CPU and costing a core.
 */
export function isMp3Copy(cfg: Pick<RadioJobConfig, 'transcode' | 'sourceCodec'>): boolean {
  return !cfg.transcode && cfg.sourceCodec === 'mp3';
}

/** Reconnect flags: an HTTP pull source drops, and ffmpeg will not retry unasked. */
const RECONNECT = ['-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '5'];

/** An HLS source is a playlist, not a byte stream, whatever the row says it is. */
export function looksLikeHls(protocol: string, url: string): boolean {
  return String(protocol).toLowerCase() === 'hls' || /\.m3u8(\?|$)/i.test(String(url));
}

/**
 * Input flags for a station's SOURCE, by protocol.
 *
 * THREE DIFFERENT KINDS OF THING ARRIVE HERE and they are not interchangeable:
 *
 *   Icecast / plain HTTP  A single endless response body. It drops, and when it
 *                         does ffmpeg exits unless told to reconnect. Nothing
 *                         else is needed: there is no playlist and no edge.
 *
 *   HLS                   A PLAYLIST, refetched on a timer. ffmpeg's default
 *                         entry point is `live_start_index = -3`, three segments
 *                         back from the end, so a station whose source uses six
 *                         second segments goes on air EIGHTEEN SECONDS BEHIND
 *                         REAL TIME and stays there for the whole run. That is
 *                         not a startup cost you wait out; it is a permanent
 *                         offset, and it is why a broadcaster-app HLS source
 *                         used to feel a beat late against the same station's
 *                         Icecast mount. `-1` starts at the newest complete
 *                         segment, which is the closest to live that HLS allows.
 *
 *                         `-re` and `-2` since 11 Oct 2026. Read as fast as it
 *                         arrived, an HLS source came out in BURSTS (ABC Jazz:
 *                         10 s segments, so two or three output segments within
 *                         0.1 s, then nothing for 10 s). The Icecast relay (since
 *                         removed) dropped a source silent for 10 s, the mp3
 *                         output broke its pipe, the pipeline exited and auto-connect started a
 *                         new run: 28 runs in an hour. `-re` reads at real time
 *                         so audio leaves evenly; it needs one segment in hand,
 *                         hence `-2`. The cost is one source segment of latency.
 *
 *                         `-http_persistent 0` is here because these playlists
 *                         are normally fronted by a CDN that redirects segments
 *                         to a different host than the manifest; reusing the
 *                         connection then logs "Cannot reuse HTTP connection for
 *                         different host" on every fetch.
 *
 *   SRT                   A CONTRIBUTION feed carrying MPEG-TS, where timestamps
 *                         can be absent or discontinuous across a reconnect.
 *                         `+genpts` is what encoder.py already does for the same
 *                         reason. Reconnect flags are HTTP-only and meaningless
 *                         here: libsrt does its own reconnection.
 *
 * The station is always the CALLER on SRT, never a listener. A container that
 * accepts an inbound connection cannot be scaled, moved or reaped like the rest
 * of the fleet, and that rule is the entire reason radio became a container.
 */
export function inputArgs(protocol: string, url: string): string[] {
  const p = String(protocol).toLowerCase();
  const http = /^https?:/i.test(String(url));

  if (looksLikeHls(p, url) && http) {
    return [...RECONNECT, '-re', '-fflags', '+genpts', '-live_start_index', '-2', '-http_persistent', '0', '-i', url];
  }
  if (p === 'icecast' || http) return [...RECONNECT, '-i', url];
  if (p === 'srt') return ['-fflags', '+genpts', '-i', url];
  return ['-i', url];
}

/** The audio-only HLS master that sits at the run root. */
export function masterPlaylist(bitrateKbps: number): string {
  const bw = (clampBitrate(bitrateKbps) + 8) * 1000;
  return `#EXTM3U\n#EXT-X-VERSION:7\n#EXT-X-INDEPENDENT-SEGMENTS\n` +
    `#EXT-X-STREAM-INF:BANDWIDTH=${bw},CODECS="mp4a.40.2"\naudio/index.m3u8\n`;
}

/**
 * Build the complete ffmpeg argv. Pure: no mkdir, no spawn, no probing. The
 * caller creates the directories and decides how stdout is wired, because that
 * differs between the container and the in-process path and nothing else does.
 */
export function buildRadioArgs(cfg: RadioJobConfig, paths: RadioPaths): string[] {
  const outs = resolveOutputs(cfg.outputs);
  const kbps = clampBitrate(cfg.bitrateKbps);
  const br = `${kbps}k`;
  const seg = cfg.segmentSeconds && cfg.segmentSeconds > 0 ? cfg.segmentSeconds : 4;

  const args: string[] = [
    '-hide_banner', '-loglevel', 'warning', '-nostdin',
    ...inputArgs(cfg.protocol, cfg.url),
  ];

  if (outs.hls) {
    args.push(
      '-map', '0:a:0', '-c:a', 'aac', '-b:a', br, '-ac', '2',
      '-f', 'hls', '-hls_time', String(seg), '-hls_list_size', '0',
      '-hls_flags', 'program_date_time+independent_segments',
      '-hls_segment_type', 'fmp4', '-hls_fmp4_init_filename', 'init.mp4',
      '-hls_segment_filename', `${paths.audioDir}/seg_%05d.m4s`,
      `${paths.audioDir}/index.m3u8`,
    );
  }

  if (outs.dash) {
    args.push(
      '-map', '0:a:0', '-c:a', 'aac', '-b:a', br, '-ac', '2',
      '-f', 'dash', '-seg_duration', String(seg), '-streaming', '1',
      '-window_size', '20', '-extra_window_size', '10', '-remove_at_exit', '0',
      `${paths.dashDir}/manifest.mpd`,
    );
  }

  if (outs.mp3) {
    // Copy when we honestly can; the codec choice is identical either way,
    // only the destination changes.
    if (isMp3Copy(cfg)) args.push('-map', '0:a:0', '-c:a', 'copy');
    else args.push('-map', '0:a:0', '-c:a', 'libmp3lame', '-b:a', br, '-ac', '2');

    // DEV ONLY (RADIO_MODE=inprocess): the control plane reads stdout for its
    // preview. There is no relay to push to (2.1c-2).
    args.push('-f', 'mp3', 'pipe:1');
  }

  return args;
}
