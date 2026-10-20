// ============================================================================
//  IN-STREAM GRAPHIC TRIGGERS: what a player should draw, and when, carried in
//  the manifests the viewer already loads. No side channel, no extra API call.
//
//  THE STANDARD IS THE ONE THE STREAM ALREADY SPEAKS.
//    HLS   EXT-X-DATERANGE (RFC 8216 4.3.2.7). CLASS says what kind of trigger,
//          X- attributes carry the data. A player that does not know the CLASS
//          ignores it, as the spec requires, so partner platforms are unaffected.
//    DASH  an inband-free MPD EventStream with one Event per trigger, the same
//          data as JSON in messageData.
//  Shaka (our engine) surfaces the first as `metadata` / `metadataadded` and the
//  second as `timelineregionadded` / `timelineregionenter`, and Safari's own HLS
//  turns DATERANGE into DataCues on a metadata text track.
//
//  WHO WRITES THEM. The schedule lives here; the delivered manifests are written
//  by the encoder (they reach viewers from S3 through the CDN and never pass this
//  process). So this module builds the triggers and formats the HLS line, the
//  encoder asks for them every few seconds (GET /api/streams/:id/timed-events)
//  and writes them into the playlists it already rewrites. One grammar, owned in
//  one place, tested here.
//
//  WALL-CLOCK TIMES, ALWAYS. A trigger says "from 20:58:00 for 12 s", not "at
//  segment 1832". The player compares that with its own playhead clock, so a
//  viewer who joins mid-window, or watches 40 s behind live, or scrubs back in
//  the DVR, sees what was on screen at that moment.
//
//  PURE above the loader: no database import at module load, same as
//  timedMetadata.ts, so the whole grammar is tested in node without Postgres.
// ============================================================================
import { quoted, CLASS_PROGRAMME, CLASS_AD } from './timedMetadata';

/** Reverse-DNS, as the spec advises, so the CLASS can never collide with anyone's. */
export const CLASS_GRAPHIC = 'com.boomlabs.volt.graphic';
/** DASH schemes. Versioned so the payload can change shape without breaking old players. */
export const SCHEME_GRAPHIC = 'urn:com:boomlabs:volt:graphic:2026';
export const SCHEME_PROGRAMME = 'urn:com:boomlabs:volt:programme:2026';

export interface ScheduleItem {
  id: string;
  title: string;
  subtitle?: string | null;
  imageUrl?: string | null;
  startsAt: Date;
  endsAt: Date | null;
  kind?: string | null;
}

/** Per channel or event, stored as overrides in `graphics` (migration 0060). */
export interface GraphicsSettings {
  upNext: { enabled: boolean; leadSec: number; durationSec: number };
}

export const DEFAULT_GRAPHICS: GraphicsSettings = {
  // On by default: any channel with a guide gets it, and only a player with
  // graphics switched on draws it.
  upNext: { enabled: true, leadSec: 120, durationSec: 12 },
};

const clamp = (v: unknown, lo: number, hi: number, d: number) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(lo, Math.min(hi, Math.round(n))) : d;
};

/** Stored overrides, whatever shape they arrived in, to settings that are always valid. */
export function resolveGraphics(raw: unknown): GraphicsSettings {
  const r = (raw && typeof raw === 'object' ? raw : {}) as any;
  const u = (r.upNext ?? r.up_next ?? {}) as any;
  const d = DEFAULT_GRAPHICS.upNext;
  return {
    upNext: {
      enabled: typeof u.enabled === 'boolean' ? u.enabled : d.enabled,
      leadSec: clamp(u.leadSec ?? u.lead_sec, 15, 900, d.leadSec),
      durationSec: clamp(u.durationSec ?? u.duration_sec, 5, 60, d.durationSec),
    },
  };
}

/** One trigger, format-free. The encoder and the local origin render it. */
export interface Trigger {
  id: string;
  cls: string;
  /** What to draw. 'programme' is the boundary marker; the rest are graphics. */
  graphic: 'programme' | 'ad' | 'up-next' | 'ad-break';
  start: Date;
  /** Null for an open-ended programme. */
  durationSec: number | null;
  /** Client attributes, without the X- prefix. Values are plain strings. */
  data: Record<string, string>;
}

/**
 * An ad break on the stream: a FAST channel's scheduled break, a live
 * source's SCTE-35 cue, or an operator's Go to break (stream_breaks,
 * migration 0064). It is the ONE signal every graphic consults: the player
 * hides its graphics for it, Up next is moved out of it, and a burn-in
 * compositor reads the same windows from the timed-events feed.
 */
export interface BreakWindow {
  id: string;
  start: Date;
  durationSec: number;
  source?: string;
  /** Default true. False keeps graphics up (a sponsored break that wants its bug). */
  hideGraphics?: boolean;
}

export const SCHEME_AD = 'urn:com:boomlabs:volt:ad:2026';

/** Content, not an ad or a filler strand: what "up next" may name. */
const isContent = (p: ScheduleItem) => !['ad', 'filler', 'slate'].includes(String(p.kind ?? 'content').toLowerCase());

/** Only an image a player can fetch as is. A storage key needs signing, so it is left out. */
const fetchable = (u: string | null | undefined) => (u && /^(https?:\/\/|\/(?!\/))/i.test(u) ? u : null);

/**
 * Every trigger for a schedule.
 *
 * PROGRAMME triggers are the existing boundary markers (timedMetadata.ts), kept
 * so the player can show what is on without a guide fetch.
 *
 * UP NEXT, at `leadSec` before a content programme ends, for `durationSec`,
 * naming the next content programme, when:
 *   - the programme has a known end (an open-ended strand has no "towards the end");
 *   - the next one follows on within five minutes (a show tomorrow is not "next");
 *   - the programme is long enough that the card does not cover most of it
 *     (at least the lead plus the card plus a minute).
 */
export function buildTriggers(items: ScheduleItem[], settings: GraphicsSettings, breaks: BreakWindow[] = []): Trigger[] {
  const list = [...items].sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime());
  const out: Trigger[] = [];
  const hiding = breaks.filter((b) => b.durationSec > 0 && b.hideGraphics !== false);
  for (const b of breaks) {
    if (!(b.durationSec > 0)) continue;
    out.push({
      id: `brk:${b.id}`, cls: CLASS_AD, graphic: 'ad-break', start: b.start, durationSec: b.durationSec,
      data: { GRAPHIC: 'ad-break', BREAK: b.id, 'HIDE-GRAPHICS': b.hideGraphics === false ? 'none' : 'all', ...(b.source ? { SOURCE: b.source } : {}) },
    });
  }
  for (const p of list) {
    const isAd = String(p.kind ?? '').toLowerCase() === 'ad';
    const dur = p.endsAt ? (p.endsAt.getTime() - p.startsAt.getTime()) / 1000 : null;
    out.push({
      id: p.id, cls: isAd ? CLASS_AD : CLASS_PROGRAMME, graphic: isAd ? 'ad' : 'programme',
      start: p.startsAt, durationSec: dur != null && dur > 0 ? dur : null,
      data: {
        TITLE: p.title,
        ...(p.kind ? { KIND: String(p.kind) } : {}),
        ...(p.subtitle ? { SUBTITLE: p.subtitle } : {}),
        ...(fetchable(p.imageUrl) ? { IMAGE: fetchable(p.imageUrl)! } : {}),
      },
    });
  }
  const u = settings.upNext;
  if (!u.enabled) return out;
  for (let i = 0; i < list.length; i++) {
    const p = list[i];
    if (!p.endsAt || !isContent(p)) continue;
    const next = list.slice(i + 1).find((n) => isContent(n) && n.startsAt.getTime() >= p.endsAt!.getTime() - 1000);
    if (!next) continue;
    if (next.startsAt.getTime() - p.endsAt.getTime() > 5 * 60_000) continue;
    const len = (p.endsAt.getTime() - p.startsAt.getTime()) / 1000;
    if (len < u.leadSec + u.durationSec + 60) continue;
    let start = new Date(p.endsAt.getTime() - u.leadSec * 1000);
    // NEVER OVER A BREAK. A card that would be on screen during an ad break is
    // moved to finish just before it (FAST channels put a break at the end of
    // most programmes, exactly where Up next goes); if that leaves it too close
    // to the programme's start, there is no card.
    for (let guard = 0; guard < 8; guard++) {
      const hit = hiding.find((b) => start.getTime() < b.start.getTime() + b.durationSec * 1000 && start.getTime() + u.durationSec * 1000 > b.start.getTime());
      if (!hit) break;
      start = new Date(hit.start.getTime() - (u.durationSec + 2) * 1000);
    }
    if (start.getTime() < p.startsAt.getTime() + 60_000) continue;
    out.push({
      id: `up-next:${p.id}`, cls: CLASS_GRAPHIC, graphic: 'up-next', start, durationSec: u.durationSec,
      data: {
        GRAPHIC: 'up-next',
        TITLE: next.title,
        STARTS: next.startsAt.toISOString(),
        PROGRAMME: next.id,
        ...(next.subtitle ? { SUBTITLE: next.subtitle } : {}),
        ...(fetchable(next.imageUrl) ? { IMAGE: fetchable(next.imageUrl)! } : {}),
      },
    });
  }
  return out.sort((a, b) => a.start.getTime() - b.start.getTime() || a.id.localeCompare(b.id));
}

/** The triggers that matter to a window: overlapping it, or starting within `aheadSec` of its end. */
export function triggersFor(all: Trigger[], from: Date, to: Date, aheadSec = 90): Trigger[] {
  const lo = from.getTime(), hi = to.getTime() + aheadSec * 1000;
  return all.filter((t) => {
    const s = t.start.getTime();
    const e = t.durationSec == null ? Number.POSITIVE_INFINITY : s + t.durationSec * 1000;
    return e > lo && s < hi;
  });
}

/** An X- attribute name: upper case letters, digits and hyphens only (the spec's AttributeName). */
const attrName = (k: string) => 'X-' + k.toUpperCase().replace(/[^A-Z0-9-]/g, '-');

/** The HLS line. Same grammar rules as timedMetadata.dateRangeTag, which the programme case matches. */
export function hlsTag(t: Trigger): string {
  const a: string[] = [`ID=${quoted(t.id)}`, `CLASS=${quoted(t.cls)}`, `START-DATE=${quoted(t.start.toISOString())}`];
  if (t.durationSec != null && t.durationSec > 0) a.push(`DURATION=${t.durationSec.toFixed(3)}`);
  // The ID again as a client attribute. Shaka drops the spec's ID when it turns a
  // DATERANGE into metadata, so without this a player cannot tell that a retimed
  // programme REPLACES the copy it already has, and shows both.
  a.push(`X-ID=${quoted(t.id)}`);
  for (const [k, v] of Object.entries(t.data)) if (v != null && String(v) !== '') a.push(`${attrName(k)}=${quoted(String(v))}`);
  return `#EXT-X-DATERANGE:${a.join(',')}`;
}

/** The DASH half: scheme, value and a JSON payload. The encoder places it in its Period. */
export function dashEvent(t: Trigger): { schemeIdUri: string; value: string; id: string; start: string; durationMs: number | null; messageData: string } {
  const data: Record<string, string> = {};
  for (const [k, v] of Object.entries(t.data)) data[k.toLowerCase()] = String(v);
  return {
    schemeIdUri: t.graphic === 'up-next' ? SCHEME_GRAPHIC : t.graphic === 'ad-break' ? SCHEME_AD : SCHEME_PROGRAMME,
    value: t.graphic,
    id: t.id,
    start: t.start.toISOString(),
    durationMs: t.durationSec == null ? null : Math.round(t.durationSec * 1000),
    messageData: JSON.stringify({ graphic: t.graphic, ...data }),
  };
}

/** What the encoder is handed: the trigger, plus both renderings. */
export function wireFormat(t: Trigger) {
  return { id: t.id, class: t.cls, graphic: t.graphic, start: t.start.toISOString(), duration: t.durationSec, hls: hlsTag(t), dash: dashEvent(t) };
}

// ============================================================================
//  THE LOADER: the schedule around a moment, cached per channel.
//
//  The number of schedule reads must not grow with viewers or with renditions.
//  Every encoder asks every few seconds and, locally, every playlist request
//  asks too, so the schedule is read once per six-hour block and held. Any
//  insert, update or delete on `programmes` (and any change to the channel or
//  event row, which carries the graphics settings) announces `asset:<id>`
//  through the existing triggers (migration 0046), which drops the entry in
//  every process within milliseconds. The TTL is only the backstop.
// ============================================================================
const BLOCK_MS = 6 * 3600_000;

async function loadBlock(kind: 'channel' | 'event', id: string, blockStart: number) {
  const { cached } = await import('../scale/cache');
  return cached<{ items: any[]; graphics: unknown; breaks?: any[] }>(
    `gtrig:${id}:${blockStart}`,
    { ttlSec: 300, tags: [`asset:${id}`], l2: true },
    async () => {
      const { query, one } = await import('../db');
      // A programme ending just after the block still names what is next, so the
      // read runs on past the block by the longest lead plus a margin.
      const from = new Date(blockStart - 3600_000), to = new Date(blockStart + BLOCK_MS + 3600_000);
      const rows = await query<any>(
        `SELECT id, title, starts_at, ends_at, metadata
           FROM programmes
          WHERE ${kind === 'channel' ? 'channel_id' : 'event_id'} = $1
            AND COALESCE(metadata->>'source','') <> 'icy'
            AND starts_at < $3::timestamptz
            AND (ends_at IS NULL OR ends_at > $2::timestamptz)
          ORDER BY starts_at
          LIMIT 500`,
        [id, from.toISOString(), to.toISOString()]);
      const owner = await one<any>(`SELECT graphics FROM ${kind === 'channel' ? 'channels' : 'events'} WHERE id = $1`, [id]).catch(() => null);
      // Ad breaks (migration 0064). A database without the table yet has none.
      const brk = await query<any>(
        `SELECT id, starts_at, duration_ms, source, hide_graphics FROM stream_breaks
          WHERE ${kind === 'channel' ? 'channel_id' : 'event_id'} = $1 AND status <> 'cancelled'
            AND starts_at < $3::timestamptz AND starts_at + make_interval(secs => duration_ms / 1000.0) > $2::timestamptz
          ORDER BY starts_at LIMIT 2000`,
        [id, from.toISOString(), to.toISOString()]).catch(() => [] as any[]);
      return {
        breaks: brk.map((b) => ({ id: String(b.id), start: new Date(b.starts_at).toISOString(), durationSec: Number(b.duration_ms) / 1000, source: b.source, hideGraphics: b.hide_graphics !== false })),
        graphics: owner?.graphics ?? {},
        items: rows.map((r) => {
          const m = r.metadata ?? {};
          return {
            id: String(r.id), title: String(r.title ?? ''),
            subtitle: m.subTitle ?? m.sub_title ?? m.subtitle ?? null,
            imageUrl: m.image ?? m.icon ?? m.thumbnail ?? null,
            startsAt: new Date(r.starts_at).toISOString(), endsAt: r.ends_at ? new Date(r.ends_at).toISOString() : null,
            kind: m.kind ?? m.class ?? 'content',
          };
        }),
      };
    });
}

/**
 * The triggers for a stream over a window. Fails open: a schedule that cannot be
 * read is no triggers, never a failed playlist.
 */
export async function triggersForStream(kind: 'channel' | 'event', id: string, from: Date, to: Date, aheadSec = 90): Promise<Trigger[]> {
  try {
    const first = Math.floor(from.getTime() / BLOCK_MS) * BLOCK_MS;
    const last = Math.floor((to.getTime() + aheadSec * 1000) / BLOCK_MS) * BLOCK_MS;
    const seen = new Map<string, ScheduleItem>();
    const brks = new Map<string, BreakWindow>();
    let graphics: unknown = {};
    for (let b = first; b <= last; b += BLOCK_MS) {
      const blk = await loadBlock(kind, id, b);
      graphics = blk.graphics ?? graphics;
      for (const r of blk.items) {
        seen.set(r.id, { ...r, startsAt: new Date(r.startsAt), endsAt: r.endsAt ? new Date(r.endsAt) : null });
      }
      for (const b of blk.breaks ?? []) brks.set(b.id, { ...b, start: new Date(b.start) });
    }
    return triggersFor(buildTriggers([...seen.values()], resolveGraphics(graphics), [...brks.values()]), from, to, aheadSec);
  } catch {
    return [];
  }
}
