// ============================================================================
//  MP3 ON DEMAND — derived from the HLS the station is already writing.
//
//  THE PROBLEM WITH PUSHING MP3. A station's ffmpeg carried three outputs, and
//  MP3 was the odd one out: HLS and DASH are FILES it writes to the origin,
//  while MP3 is a live PUSH to an Icecast relay. That single difference caused
//  every radio problem this platform has had:
//
//    - A relay that was not listening killed the whole ffmpeg, because one
//      process opens all its outputs before encoding anything. A station with no
//      relay produced NOTHING and crash-looped. Ninety run directories.
//    - Patched with a TCP probe, it then produced a station permanently marked
//      "degraded" for an output nobody had asked for.
//    - The relay ran 24/7 per station whether or not a single person was
//      listening, and egress is ~98% of what that tier costs.
//
//  THE INVERSION. Stop pushing. HLS is already on disk, already segmented,
//  already the thing recordings and clipping read. So MP3 becomes a DERIVED,
//  ON-DEMAND transcode of it: one ffmpeg per channel that has listeners,
//  started by the first listener and stopped after the last one leaves.
//
//    idle station        zero cost. No process, no relay, no mount.
//    first listener      one ffmpeg reading <liveDir>/audio/index.m3u8 -> MP3
//    more listeners      the SAME ffmpeg; bytes are fanned out here
//    last listener out   linger, then stop
//
//  WHAT THIS BUYS BEYOND COST:
//
//    - MP3 leaves the station's critical path entirely. A station can no longer
//      be degraded, crash-looped or held up by a relay, because it no longer
//      knows one exists.
//    - Per-listener authentication and counting are ours by construction: we
//      terminate the connection, so we see every listener. That is precisely
//      what a CDN in front of Icecast would have taken away.
//    - Listener SESSIONS become measurable, with real byte counts rather than
//      an estimate from bitrate, which is the missing half of relay cost
//      attribution.
//
//  THE COST is latency: HLS is a segment or two behind, so an MP3 listener here
//  is roughly 8 seconds behind the source. Icecast listeners are already
//  buffered 5-20 seconds behind, so this is inside the noise for radio.
//
//  WHERE THIS SHOULD EVENTUALLY LIVE. This is an EDGE service: it terminates
//  inbound connections and it scales with listeners, not with streams. It is in
//  the control plane for now because that is where the origin and the auth
//  already are, and it is written to be liftable -- it touches the origin
//  through liveOrigin.ts and nothing else of the orchestrator. Scaling listeners
//  by scaling the control plane is the thing to fix when listeners are real.
// ============================================================================
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { config } from '../../config';
import { query } from '../../db';
import { liveDirFor } from '../liveOrigin';
import { icyState } from './icyMeta';

/** How often ICY metadata is interleaved, in bytes. 16 KB is the convention. */
const ICY_METAINT = 16_000;

/**
 * How long a feed survives with no listeners.
 *
 * NOT ZERO, and the reason is a page refresh. Tearing the ffmpeg down the
 * instant the last listener leaves means every reload pays the full start
 * latency again, and a station being flicked between by an operator would
 * restart its transcode a dozen times a minute. Thirty seconds costs a third of
 * a percent of a core and removes the whole class.
 */
const LINGER_MS = 30_000;

/**
 * How long a first listener waits for audio before being told no.
 *
 * The first listener pays for the ffmpeg start plus one segment fetch. A bound
 * is needed because a station whose origin is empty would otherwise hold the
 * connection open forever, which looks exactly like buffering.
 */
const FIRST_BYTE_TIMEOUT_MS = 15_000;

/**
 * How far behind a listener may fall before being disconnected.
 *
 * THE CLASSIC FAN-OUT BUG IS UNBOUNDED BUFFERING. A listener on a bad
 * connection cannot drain as fast as we write, Node buffers the difference in
 * memory, and one stuck client grows until the process dies -- taking every
 * other listener on every other station with it. Live audio is not resumable:
 * a listener two megabytes behind is over a minute late and will never catch
 * up, so the honest thing is to drop them and let their player reconnect.
 */
const MAX_LISTENER_BACKLOG_BYTES = 2_000_000;

interface Listener {
  res: any;
  /** Wants ICY metadata interleaved (sent `Icy-MetaData: 1`). */
  wantsMeta: boolean;
  /** Bytes until the next metadata block. */
  countdown: number;
  bytes: number;
  startedAt: number;
  accountId: string | null;
  ipHash: string | null;
  userAgent: string | null;
}

interface Feed {
  channelId: string;
  proc: ChildProcess | null;
  listeners: Set<Listener>;
  bitrateKbps: number;
  startedAt: number;
  /** True once ffmpeg has produced audio. Nothing is sent to a listener before. */
  ready: boolean;
  waiters: Array<(ok: boolean) => void>;
  lingerTimer: NodeJS.Timeout | null;
  stopping: boolean;
}

const feeds = new Map<string, Feed>();

/** ICY metadata block: a length byte (in 16-byte units) then padded text. */
function icyBlock(title: string): Buffer {
  if (!title) return Buffer.from([0]);
  const text = `StreamTitle='${title.replace(/'/g, ' ')}';`;
  const pad = Math.ceil(text.length / 16);
  const buf = Buffer.alloc(1 + pad * 16);
  buf[0] = pad;
  buf.write(text, 1, 'utf8');
  return buf;
}

/** The live HLS media playlist this channel is writing right now, or null. */
export function livePlaylistFor(channelId: string): string | null {
  const p = join(liveDirFor(channelId), 'audio', 'index.m3u8');
  return existsSync(p) ? p : null;
}

function ffmpegArgs(playlist: string, bitrateKbps: number): string[] {
  return [
    '-hide_banner', '-loglevel', 'warning', '-nostdin',
    // START AT THE LIVE EDGE. ffmpeg's default entry into a live playlist is
    // three segments back, which would put every MP3 listener a further twelve
    // seconds behind for no reason. Same flag, same reason, as a station reading
    // a remote HLS source (see radio/args.ts).
    '-live_start_index', '-1',
    '-i', playlist,
    '-map', '0:a:0',
    '-c:a', 'libmp3lame', '-b:a', `${bitrateKbps}k`, '-ac', '2',
    // -write_xing 0: a live MP3 stream has no length, and a Xing/VBR header
    // claiming one confuses players into showing a seek bar for a live stream.
    '-write_xing', '0',
    '-f', 'mp3', 'pipe:1',
  ];
}

function startFeed(channelId: string, bitrateKbps: number): Feed {
  const feed: Feed = {
    channelId, proc: null, listeners: new Set(), bitrateKbps,
    startedAt: Date.now(), ready: false, waiters: [], lingerTimer: null, stopping: false,
  };
  feeds.set(channelId, feed);

  const playlist = livePlaylistFor(channelId);
  if (!playlist) {
    // No origin to read. Resolve the waiters as a failure rather than leaving
    // them to time out: "the station is not producing" is knowable now.
    feed.waiters.splice(0).forEach((w) => w(false));
    feeds.delete(channelId);
    return feed;
  }

  const proc = spawn(config.clips.ffmpegBin, ffmpegArgs(playlist, bitrateKbps), {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  feed.proc = proc;

  proc.stdout!.on('data', (chunk: Buffer) => {
    if (!feed.ready) {
      feed.ready = true;
      feed.waiters.splice(0).forEach((w) => w(true));
    }
    broadcast(feed, chunk);
  });
  let errTail = '';
  proc.stderr!.on('data', (d: Buffer) => { errTail = (errTail + d.toString()).slice(-2000); });
  proc.on('exit', (code) => {
    // A FEED THAT DIES TAKES ITS LISTENERS WITH IT, and they are told so rather
    // than left holding a silent socket. A player that sees the connection close
    // reconnects; one held open on a dead feed plays nothing and says nothing.
    if (!feed.stopping) {
      console.warn(`[mp3] feed for ${channelId} exited rc=${code}: ${errTail.split('\n').filter(Boolean).slice(-1)[0] ?? ''}`);
    }
    feed.waiters.splice(0).forEach((w) => w(false));
    for (const l of feed.listeners) endListener(feed, l, 'feed_stopped');
    feed.listeners.clear();
    if (feeds.get(channelId) === feed) feeds.delete(channelId);
  });

  console.log(`[mp3] started on-demand feed for ${channelId} at ${bitrateKbps}k`);
  return feed;
}

/**
 * Fan one chunk out to every listener, interleaving ICY metadata per client.
 *
 * The CURRENT title goes into every block rather than only on change: players
 * dedupe, and a client whose countdown crosses zero between two changes would
 * otherwise miss one entirely.
 */
function broadcast(feed: Feed, chunk: Buffer) {
  const title = icyState(feed.channelId)?.title ?? '';
  for (const l of feed.listeners) {
    try {
      // Backpressure first: a listener already too far behind is dropped rather
      // than buffered. See MAX_LISTENER_BACKLOG_BYTES.
      if ((l.res.writableLength ?? 0) > MAX_LISTENER_BACKLOG_BYTES) {
        endListener(feed, l, 'too_slow');
        feed.listeners.delete(l);
        continue;
      }
      if (!l.wantsMeta) {
        l.res.write(chunk);
        l.bytes += chunk.length;
        continue;
      }
      let off = 0;
      while (off < chunk.length) {
        const take = Math.min(l.countdown, chunk.length - off);
        if (take > 0) {
          l.res.write(chunk.subarray(off, off + take));
          l.bytes += take;
          l.countdown -= take;
          off += take;
        }
        if (l.countdown === 0) {
          const block = icyBlock(title);
          l.res.write(block);
          l.bytes += block.length;
          l.countdown = ICY_METAINT;
        }
      }
    } catch {
      endListener(feed, l, 'write_failed');
      feed.listeners.delete(l);
    }
  }
}

function scheduleStopIfIdle(feed: Feed) {
  if (feed.listeners.size > 0) return;
  if (feed.lingerTimer) return;
  feed.lingerTimer = setTimeout(() => {
    feed.lingerTimer = null;
    if (feed.listeners.size > 0) return;   // somebody arrived during the linger
    stopFeed(feed.channelId, 'idle');
  }, LINGER_MS);
  feed.lingerTimer.unref?.();
}

export function stopFeed(channelId: string, reason = 'stopped'): void {
  const feed = feeds.get(channelId);
  if (!feed) return;
  feed.stopping = true;
  if (feed.lingerTimer) { clearTimeout(feed.lingerTimer); feed.lingerTimer = null; }
  for (const l of feed.listeners) endListener(feed, l, reason);
  feed.listeners.clear();
  try { feed.proc?.kill('SIGTERM'); } catch { /* already gone */ }
  feeds.delete(channelId);
  console.log(`[mp3] stopped feed for ${channelId} (${reason})`);
}

/**
 * Close one listener and RECORD THE SESSION.
 *
 * The byte count is measured, not derived from bitrate × duration. The gateway
 * wrote every one of those bytes, so this is the only place in the platform
 * where egress is a fact rather than an estimate — which is exactly what the
 * relay cost model needed and could not get from Icecast.
 */
function endListener(feed: Feed, l: Listener, reason: string): void {
  try { l.res.end(); } catch { /* already closed */ }
  const seconds = Math.max(0, Math.round((Date.now() - l.startedAt) / 1000));
  if (!l.accountId) return;                 // nothing to attribute it to
  // Fire and forget: a listener disconnecting must never wait on a database.
  void query(
    `INSERT INTO listener_sessions
       (channel_id, account_id, stream_ref, started_at, ended_at, seconds, bytes,
        bitrate_kbps, ip_hash, user_agent, ended_reason)
     VALUES ($1,$2,$1, to_timestamp($3/1000.0), now(), $4, $5, $6, $7, $8, $9)`,
    [feed.channelId, l.accountId, l.startedAt, seconds, l.bytes,
     feed.bitrateKbps, l.ipHash, l.userAgent, reason]
  ).catch((e) => console.error('[mp3] could not record a listener session', e));
}

/** A listener's IP, hashed. We need to count and rate-limit, not to identify. */
function hashIp(ip: string | undefined): string | null {
  if (!ip) return null;
  return createHash('sha256').update(`${ip}:${config.icecast.authSecret || 'volt'}`)
    .digest('hex').slice(0, 32);
}

export interface AttachResult {
  ok: boolean;
  reason?: 'no_content' | 'timeout' | 'feed_failed';
}

/**
 * Attach an HTTP listener, starting the feed if this is the first one.
 *
 * The caller has already decided the station may be listened to (on air, valid
 * content, rights). This decides only whether there is audio to give them.
 */
export async function attachListener(
  channelId: string,
  req: any,
  res: any,
  opts: { bitrateKbps?: number; stationName?: string; accountId?: string | null } = {}
): Promise<AttachResult> {
  const bitrateKbps = opts.bitrateKbps ?? 128;
  let feed = feeds.get(channelId);
  if (!feed || feed.stopping) feed = startFeed(channelId, bitrateKbps);
  if (!feeds.has(channelId)) return { ok: false, reason: 'no_content' };

  // Cancel any pending teardown: somebody wants it after all.
  if (feed.lingerTimer) { clearTimeout(feed.lingerTimer); feed.lingerTimer = null; }

  // NOTHING IS SENT BEFORE THERE IS AUDIO. Writing headers first and then
  // discovering the feed is dead gives the listener a 200 followed by silence,
  // which is indistinguishable from a station that has gone quiet.
  if (!feed.ready) {
    const ok = await new Promise<boolean>((resolve) => {
      const t = setTimeout(() => resolve(false), FIRST_BYTE_TIMEOUT_MS);
      feed!.waiters.push((good) => { clearTimeout(t); resolve(good); });
    });
    if (!ok) {
      if (feed.listeners.size === 0) stopFeed(channelId, 'never_started');
      return { ok: false, reason: 'timeout' };
    }
  }

  const wantsMeta = String(req.headers?.['icy-metadata'] ?? '') === '1';
  const icy = icyState(channelId);
  // `statusCode`, not Express's `res.status()`. This service terminates listener
  // connections and is meant to lift out of the control plane into its own edge
  // process, where there is no Express -- so it speaks the plain Node
  // ServerResponse contract, which Express's response also satisfies.
  res.statusCode = 200;
  res.setHeader('Content-Type', 'audio/mpeg');
  res.setHeader('Cache-Control', 'no-cache, no-store');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('icy-name', opts.stationName || icy?.station?.name || 'VOLT Radio');
  if (icy?.station?.genre) res.setHeader('icy-genre', icy.station.genre);
  res.setHeader('icy-br', String(bitrateKbps));
  if (wantsMeta) res.setHeader('icy-metaint', String(ICY_METAINT));
  res.flushHeaders?.();

  const listener: Listener = {
    res, wantsMeta, countdown: ICY_METAINT, bytes: 0, startedAt: Date.now(),
    accountId: opts.accountId ?? null,
    ipHash: hashIp(req.ip || req.socket?.remoteAddress),
    userAgent: String(req.headers?.['user-agent'] ?? '').slice(0, 300) || null,
  };
  feed.listeners.add(listener);

  const detach = () => {
    if (!feed!.listeners.delete(listener)) return;   // already ended
    endListener(feed!, listener, 'client_closed');
    scheduleStopIfIdle(feed!);
  };
  res.on?.('close', detach);
  res.on?.('error', detach);

  return { ok: true };
}

export interface FeedState {
  channelId: string;
  listeners: number;
  startedAt: number;
  bitrateKbps: number;
  ready: boolean;
}

/**
 * Live listener counts, per channel.
 *
 * THIS IS A MEASUREMENT. The console previously showed "0 MP3 listeners" for
 * every containerised station because the count came from an in-process map
 * that only the legacy path ever filled: an absence rendered as a confident
 * zero. The gateway terminates the connections, so its count is the truth.
 */
export function feedState(channelId: string): FeedState | null {
  const f = feeds.get(channelId);
  if (!f) return null;
  return {
    channelId, listeners: f.listeners.size, startedAt: f.startedAt,
    bitrateKbps: f.bitrateKbps, ready: f.ready,
  };
}

export function allFeeds(): FeedState[] {
  return [...feeds.keys()].map((id) => feedState(id)!).filter(Boolean);
}

/** Stop every feed. Called on shutdown so no ffmpeg outlives the process. */
export function stopAllFeeds(): void {
  for (const id of [...feeds.keys()]) stopFeed(id, 'shutdown');
}
