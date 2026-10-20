// ============================================================================
//  WHAT A GRAPHIC SHOWS: one value per field, from wherever the setup says.
//
//  A setup maps each template field to a source:
//    text      a fixed value saved in the setup
//    image     an Image Library file (resolved to its URL)
//    feed      a path into a data source's last good payload ("score.home",
//              "items.0.title"); an operator can take a feed field over by
//              hand, and it stays theirs until they hand it back
//    guide     the channel or event guide: now / next title, subtitle, start
//    operator  typed live in live control; the setup's value is the default
//    api       pushed with PATCH .../state; the setup's value is the default
//  The live state (operator and API values, the overrides list) sits on top.
//
//  PURE, so the preview, live control, the player feed and the burn-in
//  sidecar resolve identically.
// ============================================================================

export type SourceKind = 'text' | 'image' | 'feed' | 'guide' | 'operator' | 'api';
export interface FieldBinding {
  source: SourceKind;
  value?: unknown;
  imageId?: string;
  sourceId?: string;
  path?: string;
  guide?: 'now_title' | 'next_title' | 'now_subtitle' | 'next_subtitle' | 'now_start' | 'next_start';
}
export interface GuideNowNext {
  now?: { title: string; subtitle?: string | null; startsAt: Date } | null;
  next?: { title: string; subtitle?: string | null; startsAt: Date } | null;
}
export interface FeedState { payload: unknown; stale: boolean; onStale: 'hold' | 'hide' }
export interface ResolveInput {
  fields: { id: string }[];
  bindings: Record<string, FieldBinding>;
  stateValues: Record<string, unknown>;
  overrides: string[];
  feeds: Map<string, FeedState>;
  guide: GuideNowNext;
  imageUrl: (id: string) => string | null;
}
export interface Resolved {
  values: Record<string, unknown>;
  origin: Record<string, SourceKind | 'override' | 'unset'>;
  /** A feed this graphic depends on is stale and says "hide". */
  hidden: boolean;
  staleFeeds: string[];
}

/** "a.b.0.c" into a parsed JSON payload. Undefined when any step is missing. */
export function pick(obj: unknown, path: string | undefined): unknown {
  if (!path) return obj;
  let cur: any = obj;
  for (const k of path.split('.').filter(Boolean)) {
    if (cur == null) return undefined;
    cur = Array.isArray(cur) && /^\d+$/.test(k) ? cur[Number(k)] : cur[k];
  }
  return cur;
}

export function resolveValues(i: ResolveInput): Resolved {
  const values: Record<string, unknown> = {};
  const origin: Resolved['origin'] = {};
  const staleFeeds = new Set<string>();
  let hidden = false;
  for (const f of i.fields) {
    const b = i.bindings[f.id];
    const live = Object.prototype.hasOwnProperty.call(i.stateValues, f.id) ? i.stateValues[f.id] : undefined;
    if (!b) {
      values[f.id] = live ?? '';
      origin[f.id] = live !== undefined ? 'operator' : 'unset';
      continue;
    }
    switch (b.source) {
      case 'text': values[f.id] = live ?? b.value ?? ''; origin[f.id] = 'text'; break;
      case 'image': {
        const url = live !== undefined ? live : b.imageId ? i.imageUrl(b.imageId) : null;
        values[f.id] = url ?? ''; origin[f.id] = 'image'; break;
      }
      case 'feed': {
        if (i.overrides.includes(f.id) && live !== undefined) { values[f.id] = live; origin[f.id] = 'override'; break; }
        const feed = b.sourceId ? i.feeds.get(b.sourceId) : undefined;
        if (feed?.stale) { staleFeeds.add(b.sourceId!); if (feed.onStale === 'hide') hidden = true; }
        const v = feed ? pick(feed.payload, b.path) : undefined;
        values[f.id] = v ?? b.value ?? ''; origin[f.id] = 'feed'; break;
      }
      case 'guide': {
        const g = b.guide ?? 'now_title';
        const p = g.startsWith('next') ? i.guide.next : i.guide.now;
        const v = !p ? '' : g.endsWith('subtitle') ? (p.subtitle ?? '') : g.endsWith('title') ? p.title : p.startsAt.toISOString();
        values[f.id] = live ?? v; origin[f.id] = 'guide'; break;
      }
      case 'operator':
      case 'api':
        values[f.id] = live ?? b.value ?? ''; origin[f.id] = b.source; break;
      default:
        values[f.id] = live ?? ''; origin[f.id] = 'unset';
    }
  }
  return { values, origin, hidden, staleFeeds: [...staleFeeds] };
}

/** Coerce an incoming value to the field's declared type, or say why not. */
export function coerce(type: string, v: unknown): { ok: true; value: unknown } | { ok: false; error: string } {
  if (v === null) return { ok: true, value: null };
  switch (type) {
    case 'number': {
      const n = typeof v === 'number' ? v : Number(String(v).trim());
      return Number.isFinite(n) ? { ok: true, value: n } : { ok: false, error: 'must be a number' };
    }
    case 'boolean':
      if (typeof v === 'boolean') return { ok: true, value: v };
      if (v === 'true' || v === 'false') return { ok: true, value: v === 'true' };
      return { ok: false, error: 'must be true or false' };
    case 'list':
      return Array.isArray(v) ? { ok: true, value: v.slice(0, 200) } : { ok: false, error: 'must be a list' };
    case 'color':
      return typeof v === 'string' && /^#[0-9a-f]{3,8}$/i.test(v) ? { ok: true, value: v } : { ok: false, error: 'must be a colour like #0b3a8a' };
    default: {
      if (typeof v === 'object') return { ok: false, error: 'must be text' };
      const s = String(v);
      return s.length <= 2000 ? { ok: true, value: s } : { ok: false, error: 'is longer than 2000 characters' };
    }
  }
}
