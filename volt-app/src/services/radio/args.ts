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
//  WHY MP3 CHANGED SHAPE. The old pipeline wrote MP3 to `pipe:1` so the control
//  plane could read the child's stdout and fan bytes out to listeners itself.
//  That is exactly the property that made radio impossible to containerise: it
//  is the one output that is a live connection rather than a file, so it kept
//  the audio path inside the API process.
//
//  Television never had this problem because the encoder container accepts no
//  inbound connections at all: it pushes segments to storage and pushes status
//  to the API, and CloudFront serves viewers from S3. Radio now follows the
//  same rule by doing what Icecast itself does. The station is a SOURCE:
//  ffmpeg speaks `icecast://` natively, so MP3 is pushed to a relay tier that
//  owns listener fan-out and ICY metadata, and nothing in our control plane is
//  in the audio path.
//
//  `pipe:1` therefore survives only as a deliberate fallback for the in-process
//  development path, where there is no relay to push to. Set `icecast` and you
//  get the real topology; leave it null and you get the old preview pipe.
// ============================================================================

/** Where MP3 goes. Null means the legacy stdout pipe (dev preview only). */
export interface IcecastTarget {
  /** Host of the relay, e.g. `icecast` in compose or the service DNS name. */
  host: string;
  port: number;
  /** Mount without a leading slash is accepted; it is normalised here. */
  mount: string;
  username: string;
  password: string;
  /** Sent as ICY headers so the relay's directory and players show it. */
  stationName?: string;
  description?: string;
  genre?: string;
  /** TLS to the relay. Off by default: the relay is normally in-VPC. */
  tls?: boolean;
}

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
  icecast?: IcecastTarget | null;
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
 * MP3 IS OPT-IN. HLS AND DASH ARE NOT.
 *
 * The three are not alike, and defaulting them together was hiding that. HLS
 * and DASH are FILES this process writes into the origin: their cost is disk
 * and a CDN that is already there, and they cost the same whether anybody is
 * listening or not because nobody is served from here.
 *
 * MP3 is a live PUSH to a relay, and the relay's bill is EGRESS -- roughly 98%
 * of what the tier costs. A station with MP3 on and no MP3 listeners still
 * occupies a mount, still holds a source connection, and still counts against
 * the relay's capacity for stations that do have an audience. Defaulting it on
 * meant every station ever created reserved fan-out capacity on the assumption
 * somebody would want it.
 *
 * It is also the only output with an external dependency. A missing relay used
 * to take the whole ffmpeg down (one process carries every output and opens
 * them all before encoding), which is now handled by a probe -- but an output
 * nobody asked for should not be able to degrade a station at all.
 *
 * So: ask for MP3 and you get it. Say nothing and you get HLS and DASH, which
 * is what an OTT platform is for.
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
    return [...RECONNECT, '-fflags', '+genpts', '-live_start_index', '-1', '-http_persistent', '0', '-i', url];
  }
  if (p === 'icecast' || http) return [...RECONNECT, '-i', url];
  if (p === 'srt') return ['-fflags', '+genpts', '-i', url];
  return ['-i', url];
}

/**
 * The URL ffmpeg pushes MP3 to. Credentials are in it because that is the only
 * form the icecast protocol accepts; see `redactIcecastUrl` for logging, and
 * never put the raw value in an event detail or an error message.
 */
export function icecastUrl(t: IcecastTarget): string {
  const scheme = t.tls ? 'icecast+https' : 'icecast';
  const mount = t.mount.startsWith('/') ? t.mount : `/${t.mount}`;
  return `${scheme}://${encodeURIComponent(t.username)}:${encodeURIComponent(t.password)}@${t.host}:${t.port}${mount}`;
}

/** The same URL with the password replaced, safe to log and to store. */
export function redactIcecastUrl(t: IcecastTarget): string {
  const scheme = t.tls ? 'icecast+https' : 'icecast';
  const mount = t.mount.startsWith('/') ? t.mount : `/${t.mount}`;
  return `${scheme}://${t.username}:***@${t.host}:${t.port}${mount}`;
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

    if (cfg.icecast) {
      // ICY headers travel with the connection, so the relay's mount is
      // self-describing and players show the station rather than a bare mount.
      const t = cfg.icecast;
      if (t.stationName) args.push('-ice_name', t.stationName);
      if (t.description) args.push('-ice_description', t.description);
      if (t.genre) args.push('-ice_genre', t.genre);
      args.push('-ice_public', '1');
      // `content_type` is required by the icecast muxer for MP3; without it the
      // relay refuses the source with a 400 that reads like an auth failure.
      args.push('-content_type', 'audio/mpeg');
      args.push('-f', 'mp3', icecastUrl(t));
    } else {
      // DEV ONLY. No relay to push to, so the control plane reads stdout and
      // fans out itself, which is the old topology and does not scale.
      args.push('-f', 'mp3', 'pipe:1');
    }
  }

  return args;
}
