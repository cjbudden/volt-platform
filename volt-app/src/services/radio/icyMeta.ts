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

/** Heuristic classifier for a now-playing title. Kept deliberately readable. */
export function classifyIcyTitle(title: string): IcyClass {
  const t = (title || '').trim();
  if (!t) return 'ad'; // stations blank the title during ad breaks
  if (/\b(advert(isement)?s?|commercials?|sponsor(ed)?|promo(tion)?|ad\s*break|jingle)\b/i.test(t)) return 'ad';
  if (/\b(news|weather|traffic|bulletin|interview|talk\s*show|phone[- ]?in|dj|host|presenter|station\s*id|live\s*session|drivetime|breakfast\s*show)\b/i.test(t)) return 'content';
  // The Icecast convention for music is "Artist - Title"
  if (/\s-\s/.test(t)) return 'song';
  return 'content';
}

function parseIcyBlock(block: string): { title: string | null; streamUrl: string | null } {
  const m = /StreamTitle='((?:[^'\\]|\\.|'(?!;))*)';?/.exec(block);
  const u = /StreamUrl='((?:[^'\\]|\\.|'(?!;))*)';?/.exec(block);
  return { title: m ? m[1] : null, streamUrl: u ? u[1] : null };
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
    this.connect();
  }

  private connect() {
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
    this.retryTimer = setTimeout(() => this.connect(), 5000);
  }

  private async onMeta(block: string) {
    const { title, streamUrl } = parseIcyBlock(block);
    if (streamUrl != null) this.state.streamUrl = streamUrl || null;
    if (title == null || title === this.state.title) return;
    const now = Date.now();
    const cls = classifyIcyTitle(title);
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
