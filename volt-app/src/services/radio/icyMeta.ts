// ============================================================================
//  ICY (Icecast/SHOUTcast) metadata capture — the radio content log.
//
//  While a radio channel runs against an Icecast/HTTP audio source, we keep a
//  SECOND lightweight connection to the mount with `Icy-MetaData: 1`. The
//  server then interleaves a metadata block every `icy-metaint` audio bytes;
//  each block carries the now-playing text (StreamTitle='…';StreamUrl='…';).
//
//  Every title CHANGE becomes one entry in the TIMED LOG, stored as a
//  programme row owned by the channel (the EPG tables/APIs are already the
//  platform's model for titled time ranges): starts_at = when the title
//  appeared, ends_at = when the next replaced it, status 'aired' with as-run
//  times, and metadata jsonb { source:'icy', class, raw, stream_url }. That
//  reuse is what makes the log searchable from the recordings search, visible
//  on the guide, and usable by the post-airing clip automation for trimming.
//
//  Each entry is CLASSIFIED as song / ad / content (news, DJ talk…) with a
//  transparent heuristic (below). The class is stored data, correctable via
//  the normal programme PATCH, and replaceable by smarter (audio-analysis)
//  classifiers later without changing the model.
// ============================================================================
import * as http from 'node:http';
import * as https from 'node:https';
import { query, one } from '../../db';

export type IcyClass = 'song' | 'ad' | 'content';

export interface IcyState {
  connected: boolean;
  station: { name?: string; genre?: string; url?: string; bitrateKbps?: number; contentType?: string };
  title: string | null;          // current StreamTitle
  streamUrl: string | null;      // current StreamUrl (artwork / link when the station sends one)
  class: IcyClass | null;
  since: number | null;          // epoch ms the current title started
  changes: number;               // total title changes seen this run
  lastError: string | null;
}

/**
 * Heuristic classifier for a now-playing title: song / ad / content.
 *
 * Tuned against how real stations actually label things (verified live):
 *   SomaFM        "Alex Cortiz - Funked up flow"                  -> song
 *   WFMU          "\"Wonderful Thing\" by Ralfi Pagan on ..."      -> song
 *   NPO Radio 1   "NPO Radio 1 - De Ochtend - KRO-NCRV"           -> content (programme)
 *   WPLN / NA0D   ""  (speech stations send no track titles)      -> content
 *   any station   ""  BETWEEN songs on a music station            -> ad (break)
 *
 * The empty-title case is why this takes CONTEXT: a blank title means "ad
 * break" on a station that normally names its tracks, and simply "this station
 * does not send titles" on a news/talk stream. Passing songsSeen lets one rule
 * serve both without mislabelling every speech station as advertising.
 */
export interface ClassifyCtx {
  /** icy-name of the station: a title that merely repeats it is station/programme info. */
  stationName?: string | null;
  /** how many song-shaped titles this run has already seen. */
  songsSeen?: number;
}

export function classifyIcyTitle(title: string, ctx: ClassifyCtx = {}): IcyClass {
  const t = (title || '').trim();
  // ---- no title -----------------------------------------------------------
  if (!t) return (ctx.songsSeen ?? 0) >= 2 ? 'ad' : 'content';

  // ---- explicit advertising language --------------------------------------
  if (/\b(advert(isement)?s?|commercials?|sponsor(ed)?( by)?|promo(tion)?|ad\s*break|underwriting)\b/i.test(t)) return 'ad';

  // ---- station / programme identification ---------------------------------
  // A title that leads with the station's own name is the station telling you
  // WHAT IS ON, not what track is playing (NPO Radio 1, most news streams).
  const station = (ctx.stationName || '').trim();
  if (station && t.toLowerCase().startsWith(station.toLowerCase().slice(0, Math.min(station.length, 14)))) return 'content';
  // three-part "Station - Programme - Broadcaster" shapes are programme info
  if (t.split(/\s+-\s+/).length >= 3 && !/\bft\.?\b|\bfeat\b|remix/i.test(t)) return 'content';
  if (/\b(news|nieuws|weather|traffic|bulletin|headlines|interview|talk\s*show|phone[- ]?in|call[- ]?in|presenter|station\s*id|drivetime|breakfast\s*show|morning\s*edition|all\s*things\s*considered|repeater|net\s*control|live\s*from)\b/i.test(t)) return 'content';

  // ---- song shapes --------------------------------------------------------
  if (/\s[-–—]\s/.test(t)) return 'song';                 // Artist - Title (the Icecast convention)
  if (/^".+"\s+by\s+.+/i.test(t)) return 'song';          // "Title" by Artist   (WFMU)
  if (/\bby\s+\S+/i.test(t) && t.length < 120) return 'song';
  return 'content';
}

function parseIcyBlock(block: string): { title: string | null; streamUrl: string | null } {
  const m = /StreamTitle='((?:[^'\\]|\\.|'(?!;))*)';?/.exec(block);
  const u = /StreamUrl='((?:[^'\\]|\\.|'(?!;))*)';?/.exec(block);
  return { title: m ? m[1] : null, streamUrl: u ? u[1] : null };
}

/**
 * Some station "stream URLs" are actually PLAYLISTS (.m3u / .pls) naming the
 * real mount. Resolve one level so an operator can paste whatever the station's
 * website gives them. Returns the original URL when it is already a stream.
 */
export async function resolveStreamUrl(url: string, depth = 0): Promise<string> {
  if (depth > 1) return url;
  const looksPlaylist = /\.(m3u|m3u8|pls)(\?|$)/i.test(url);
  if (!looksPlaylist) return url;
  try {
    const body = await new Promise<string>((resolve, reject) => {
      const lib = url.startsWith('https') ? https : http;
      const req = lib.get(url, { headers: { 'User-Agent': 'VOLT-Radio/1.0' } }, (res) => {
        const ct = String(res.headers['content-type'] || '');
        // StreamGuys and friends serve real audio from a .m3u-looking path
        if (/^audio\/(mpeg|aac|mp4|ogg)/i.test(ct)) { res.destroy(); reject(new Error('is-audio')); return; }
        let s = '';
        res.setEncoding('utf8');
        res.on('data', (c) => { s += c; if (s.length > 8192) { res.destroy(); } });
        res.on('end', () => resolve(s));
        res.on('close', () => resolve(s));
        res.on('error', reject);
      });
      req.on('error', reject);
      req.setTimeout(6000, () => { req.destroy(new Error('timeout')); });
    });
    const line = body.split(/\r?\n/)
      .map((l) => l.trim())
      .map((l) => (/^File\d+\s*=\s*/i.test(l) ? l.replace(/^File\d+\s*=\s*/i, '') : l))
      .find((l) => /^https?:\/\//i.test(l));
    return line ? await resolveStreamUrl(line, depth + 1) : url;
  } catch {
    return url;   // already audio, or unreachable: let the caller try it directly
  }
}

class IcyCapture {
  state: IcyState = {
    connected: false, station: {}, title: null, streamUrl: null,
    class: null, since: null, changes: 0, lastError: null,
  };
  private req: http.ClientRequest | null = null;
  private stopped = false;
  private retryTimer: NodeJS.Timeout | null = null;
  private openProgrammeId: string | null = null;
  /** how many song-shaped titles this run has seen: decides what a BLANK title
   *  means (ad break on a music station, no-metadata on a speech station). */
  private songsSeen = 0;

  constructor(private channelId: string, private url: string, private writeLog: boolean) {}

  start() {
    // A control-plane restart can leave the previous run's last entry open
    // ('live' forever). Close any stale open icy entries before logging anew.
    if (this.writeLog) {
      query(
        `UPDATE programmes SET status='aired',
                ends_at=GREATEST(starts_at + interval '1 second', now()), actual_end=now()
          WHERE channel_id=$1 AND metadata->>'source'='icy' AND status='live'`,
        [this.channelId]
      ).catch(() => {});
    }
    void this.connect();
  }

  private async connect() {
    if (this.stopped) return;
    // a station may hand us a .m3u/.pls playlist instead of the mount itself
    this.url = await resolveStreamUrl(this.url);
    if (this.stopped) return;
    const lib = this.url.startsWith('https') ? https : http;
    try {
      this.req = lib.get(this.url, {
        headers: { 'Icy-MetaData': '1', 'User-Agent': 'VOLT-Radio/1.0', Accept: '*/*' },
      }, (res) => {
        const h = res.headers as Record<string, string>;
        const metaint = parseInt(String(h['icy-metaint'] || '0'), 10);
        this.state.connected = true;
        this.state.lastError = null;
        this.state.station = {
          name: h['icy-name'], genre: h['icy-genre'], url: h['icy-url'],
          bitrateKbps: h['icy-br'] ? parseInt(String(h['icy-br']), 10) : undefined,
          contentType: h['content-type'],
        };
        if (!metaint) {
          // No interleaved metadata on this mount: keep the connection only as a
          // liveness probe, then bow out (nothing to log).
          res.destroy();
          this.state.connected = false;
          return;
        }
        let audioLeft = metaint;   // audio bytes until the next metadata block
        let metaNeed = 0;          // metadata bytes still expected
        let metaBuf: Buffer[] = [];
        res.on('data', (chunk: Buffer) => {
          let i = 0;
          while (i < chunk.length) {
            if (metaNeed > 0) {
              const take = Math.min(metaNeed, chunk.length - i);
              metaBuf.push(chunk.subarray(i, i + take));
              metaNeed -= take; i += take;
              if (metaNeed === 0) {
                const text = Buffer.concat(metaBuf).toString('utf8').replace(/\0+$/g, '');
                metaBuf = [];
                if (text.trim()) this.onMeta(text);
                audioLeft = metaint;
              }
            } else if (audioLeft === 0) {
              metaNeed = chunk[i] * 16; i += 1;
              if (metaNeed === 0) audioLeft = metaint; // empty block = no change
            } else {
              const skip = Math.min(audioLeft, chunk.length - i);
              audioLeft -= skip; i += skip;
            }
          }
        });
        res.on('end', () => this.onDrop('stream ended'));
        res.on('error', (e) => this.onDrop(e.message));
      });
      this.req.on('error', (e) => this.onDrop(e.message));
    } catch (e: any) {
      this.onDrop(e?.message || 'connect failed');
    }
  }

  private onDrop(reason: string) {
    this.state.connected = false;
    this.state.lastError = reason;
    if (this.stopped) return;
    this.retryTimer = setTimeout(() => { void this.connect(); }, 5000);
  }

  private async onMeta(block: string) {
    const { title, streamUrl } = parseIcyBlock(block);
    if (streamUrl != null) this.state.streamUrl = streamUrl || null;
    if (title == null || title === this.state.title) return;
    const now = Date.now();
    const cls = classifyIcyTitle(title, { stationName: this.state.station?.name, songsSeen: this.songsSeen });
    if (cls === 'song') this.songsSeen++;
    // close the previous entry at the moment of change
    await this.closeOpenEntry(now).catch(() => {});
    this.state.title = title;
    this.state.class = cls;
    this.state.since = now;
    this.state.changes += 1;
    if (!this.writeLog) return;
    try {
      // Open-ended entry: ends_at starts as a short placeholder window and is
      // finalised when the next title arrives (or on stop). starts/actual = as-run.
      const row = await one<any>(
        `INSERT INTO programmes(channel_id, source_ref, title, starts_at, ends_at, status,
                                actual_start, auto_vod, metadata)
         VALUES ($1,$2,$3, to_timestamp($4/1000.0), to_timestamp($4/1000.0) + interval '1 second',
                 'live', to_timestamp($4/1000.0), false, $5::jsonb)
         ON CONFLICT (channel_id, source_ref) WHERE source_ref IS NOT NULL
         DO UPDATE SET title=EXCLUDED.title RETURNING id`,
        [this.channelId, `icy:${now}`, title.slice(0, 500), now,
         JSON.stringify({ source: 'icy', class: cls, raw: block.slice(0, 1000), stream_url: streamUrl || null })]
      );
      this.openProgrammeId = row?.id ?? null;
    } catch (e) {
      console.error('[icy] log insert failed', this.channelId, e);
    }
  }

  private async closeOpenEntry(atMs: number) {
    if (!this.openProgrammeId) return;
    const id = this.openProgrammeId;
    this.openProgrammeId = null;
    await query(
      `UPDATE programmes SET ends_at = GREATEST(starts_at + interval '1 second', to_timestamp($2/1000.0)),
              actual_end = to_timestamp($2/1000.0), status='aired'
        WHERE id=$1`,
      [id, atMs]
    );
  }

  async stop() {
    this.stopped = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    try { this.req?.destroy(); } catch { /* */ }
    this.state.connected = false;
    await this.closeOpenEntry(Date.now()).catch(() => {});
  }
}

const captures = new Map<string, IcyCapture>();

export function startIcyCapture(channelId: string, url: string, writeLog: boolean): void {
  stopIcyCapture(channelId); // idempotent restart
  const c = new IcyCapture(channelId, url, writeLog);
  captures.set(channelId, c);
  c.start();
}

export function stopIcyCapture(channelId: string): void {
  const c = captures.get(channelId);
  if (c) { captures.delete(channelId); void c.stop(); }
}

export function icyState(channelId: string): IcyState | null {
  return captures.get(channelId)?.state ?? null;
}
