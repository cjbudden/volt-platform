// ============================================================================
//  RIGHTS PREVIEW (EDGE_RIGHTS_VARIANTS.md, "Testing it from the admin side";
//  build queue 1.14c).
//
//  An operator picks a country, a rights class and a time (now, or any time
//  in the guide) on a channel or event page and is told what the edge would
//  do for that viewer: normal, replaced (with which variant) or blocked, and
//  which rule made it so. Every answer comes from the functions the edge
//  decision itself uses (services/edgeRights.ts: loadEdgeDetail, decideFor,
//  variantFor, edgeDecision), never a second reading of the rules, so the
//  preview cannot say "normal" where the edge says "replace".
//
//  PLAYING THE VARIANT. The answer carries an admin-only address,
//  /origin/<id>/v/<key>/master.m3u8?pt=<token>, served by the variant
//  manifest service itself (modules/publicLive.ts serveVariant) as that
//  viewer, so what the operator watches is byte for byte what the viewer
//  would get, loop wraps included. A video element cannot send the console's
//  bearer token, so the token is the credential, as for the source preview:
//  minted only by the authenticated, account-scoped preview route, signed,
//  for one stream, one audience and one time, for two hours. Unlike the
//  public route it does not wait for the stream to be on air: the point is to
//  check a window before it airs.
//
//  THE 24 HOUR STRIP. Per audience (every country the rules name, "anywhere
//  else", each with every exempt rights class, plus the one asked about):
//  when it is normal, replaced or blocked over the next 24 hours, from the
//  same decision at every rule edge. The store holds at most 1 KB per stream,
//  so the published windows may stop before 24 hours (rules.u); the strip
//  then reloads the rules as the sync would publish them at that time and
//  carries on, exactly as the edge would see them.
// ============================================================================
import { createHmac, timingSafeEqual } from 'node:crypto';
import { config } from '../config';
import { one } from '../db';
import {
  loadEdgeDetail, explainDecision, decideFor, variantFor, edgeDecision, variantServiceOn, RC_RE,
  type EdgeRules, type EdgeWindow,
} from './edgeRights';

export const STRIP_SEC = 24 * 3600;
const TOKEN_TTL_MS = 2 * 3600 * 1000;
const MAX_AUDIENCES = 40;
/** How far from now a preview may look (the guide is rarely longer). */
const MAX_OFFSET_SEC = 31 * 24 * 3600;

type Kind = 'channel' | 'event';
type Decision = 'allow' | 'block' | 'replace';

// ---------------------------------------------------------------------------
//  The play token
// ---------------------------------------------------------------------------
const key = () => createHmac('sha256', config.jwt.accessSecret).update('volt-rights-preview-v1').digest();
const sign = (s: string) => createHmac('sha256', key()).update(s).digest('base64url');
const same = (a: string, b: string) => { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && timingSafeEqual(x, y); };

/** a: account, k: kind, s: stream, c: country ('' unknown), r: rights class, t: time (epoch s, 0 = now), e: expiry (ms) */
export interface PreviewClaims { a: string; k: Kind; s: string; c: string; r: string; t: number; e: number }

export function mintPreviewPlayToken(c: Omit<PreviewClaims, 'e'>, ttlMs = TOKEN_TTL_MS): string {
  const body = Buffer.from(JSON.stringify({ ...c, e: Date.now() + ttlMs })).toString('base64url');
  return `${body}.${sign(body)}`;
}

/** The claims of a valid, unexpired token for this stream, else null. */
export function readPreviewPlayToken(t: string | undefined | null, streamId: string): PreviewClaims | null {
  if (!t || typeof t !== 'string') return null;
  const [body, sig] = t.split('.');
  if (!body || !sig || !same(sign(body), sig)) return null;
  try {
    const c = JSON.parse(Buffer.from(body, 'base64url').toString()) as PreviewClaims;
    return c.e > Date.now() && c.s === streamId ? c : null;
  } catch { return null; }
}

// ---------------------------------------------------------------------------
//  The question
// ---------------------------------------------------------------------------
export interface PreviewAsk { cc: string; rc: string; atSec: number | null }

/** Validate ?country=&rightsClass=&at= (400 on nonsense, never a silent default). */
export function parsePreviewQuery(q: any, nowSec = Math.floor(Date.now() / 1000)): PreviewAsk | { error: string } {
  const pick = (v: unknown) => (Array.isArray(v) ? v[0] : v);
  const ccRaw = String(pick(q.country) ?? '').trim().toUpperCase();
  if (ccRaw && !/^[A-Z]{2}$/.test(ccRaw)) return { error: 'country must be a two-letter code (XX or empty for a country the CDN cannot tell)' };
  const rc = String(pick(q.rightsClass) ?? pick(q.rc) ?? '').trim().toLowerCase();
  if (rc && !RC_RE.test(rc)) return { error: 'rightsClass must be up to 16 lower case letters, digits, - or _' };
  const atRaw = pick(q.at);
  let atSec: number | null = null;
  if (atRaw != null && String(atRaw) !== '' && String(atRaw) !== 'now') {
    const s = String(atRaw);
    const ms = /^\d{9,11}$/.test(s) ? Number(s) * 1000 : Date.parse(s);
    if (!Number.isFinite(ms)) return { error: 'at must be an ISO time, epoch seconds or "now"' };
    atSec = Math.floor(ms / 1000);
    if (Math.abs(atSec - nowSec) > MAX_OFFSET_SEC) return { error: 'at must be within 31 days of now' };
  }
  return { cc: ccRaw === 'XX' ? '' : ccRaw, rc, atSec };
}

// ---------------------------------------------------------------------------
//  The answer
// ---------------------------------------------------------------------------
const iso = (s: number) => new Date(s * 1000).toISOString();
const audienceName = (cc: string, rc: string) => (cc || '*') + (rc ? '/' + rc : '');
const audienceLabel = (cc: string, rc: string) =>
  (cc ? cc : 'Anywhere else') + (rc ? `, rights class ${rc}` : '');

/** One audience's day: contiguous pieces with one decision (and variant). */
export interface StripRow {
  audience: string; country: string; rightsClass: string; label: string; asked: boolean;
  segments: { from: string; to: string; decision: Decision; variant: string | null }[];
}

interface Slice { from: number; to: number; rules: EdgeRules | null; windows: EdgeWindow[] }

/** The rules as the edge sees them from `from` to `to`: reloaded wherever the published list ends. */
async function slices(kind: Kind, id: string, from: number, to: number): Promise<Slice[]> {
  const out: Slice[] = [];
  let t = from;
  for (let i = 0; t < to && i < 48; i++) {
    const d = await loadEdgeDetail(kind, id, t);
    let end = Math.min(to, d.rules?.u ?? to);
    if (!(end > t)) end = to;         // nothing more to learn by reloading
    out.push({ from: t, to: end, rules: d.rules, windows: d.windows });
    t = end;
  }
  if (t < to && out.length) out[out.length - 1].to = to;
  return out;
}

function audiencesOf(sl: Slice[], ask: { cc: string; rc: string }): { list: [string, string][]; truncated: boolean } {
  const countries = new Set<string>(), classes = new Set<string>();
  for (const s of sl) {
    for (const r of [s.rules?.a, s.rules?.c]) for (const c of r?.[1] ?? []) countries.add(c);
    for (const w of s.windows) { for (const c of w.cc) countries.add(c); for (const x of w.exempt) classes.add(x); }
  }
  const list: [string, string][] = [['', '']];
  for (const rc of [...classes].sort()) list.push(['', rc]);
  for (const cc of [...countries].sort()) { list.push([cc, '']); for (const rc of [...classes].sort()) list.push([cc, rc]); }
  const truncated = list.length > MAX_AUDIENCES;
  const cut = list.slice(0, MAX_AUDIENCES);
  if (!cut.some(([c, r]) => c === ask.cc && r === ask.rc)) cut.unshift([ask.cc, ask.rc]);
  return { list: cut, truncated };
}

/**
 * The rules in force from each rule edge on. A variant key is a hash of the
 * audience's whole timeline, and the sync drops a window once it has ended,
 * so the key AU is mapped to at 21:00 can differ from the one it has now
 * (same pictures, another cache name). Each piece of the strip is therefore
 * decided on the rules as the sync publishes them at that piece's start.
 */
async function rulesAtEdges(kind: Kind, id: string, sl: Slice[]): Promise<{ t: number; to: number; rules: EdgeRules | null }[]> {
  const out: { t: number; to: number; rules: EdgeRules | null }[] = [];
  for (const s of sl) {
    const edges = new Set<number>([s.from, s.to]);
    for (const w of s.windows) for (const e of [w.from, w.to]) if (e > s.from && e < s.to) edges.add(e);
    const pts = [...edges].sort((a, b) => a - b);
    for (let i = 0; i + 1 < pts.length; i++) {
      // the slice's own load answers its first point; past a sensible number
      // of edges the slice's rules stand in (same decisions, maybe older keys)
      const rules = i === 0 || out.length > 120 ? s.rules : (await loadEdgeDetail(kind, id, pts[i])).rules;
      out.push({ t: pts[i], to: pts[i + 1], rules });
    }
  }
  return out;
}

function stripRows(pieces: { t: number; to: number; rules: EdgeRules | null }[], audiences: [string, string][], ask: { cc: string; rc: string }): StripRow[] {
  return audiences.map(([cc, rc]) => {
    const segs: { from: number; to: number; decision: Decision; variant: string | null }[] = [];
    for (const pc of pieces) {
      const decision = decideFor(pc.rules, cc, rc, pc.t);
      const variant = decision === 'replace' ? variantFor(pc.rules?.vm, cc, rc) : null;
      const last = segs[segs.length - 1];
      if (last && last.to === pc.t && last.decision === decision && last.variant === variant) last.to = pc.to;
      else segs.push({ from: pc.t, to: pc.to, decision, variant });
    }
    return {
      audience: audienceName(cc, rc), country: cc, rightsClass: rc, label: audienceLabel(cc, rc),
      asked: cc === ask.cc && rc === ask.rc,
      segments: segs.map((x) => ({ from: iso(x.from), to: iso(x.to), decision: x.decision, variant: x.variant })),
    };
  });
}

async function replacementName(w: EdgeWindow): Promise<{ kind: string; ref: string | null; assetId: string | null; title: string | null } | null> {
  if (!w.replace) return null;
  const p = w.src;
  const assetId = p?.replacement_asset_id ? String(p.replacement_asset_id) : null;
  let title: string | null = null;
  if (assetId) title = (await one<any>(`SELECT title FROM vod_assets WHERE id = $1`, [assetId]).catch(() => null))?.title ?? null;
  return { kind: assetId ? 'asset' : String(p?.replacement_kind ?? 'loop'), ref: p?.replacement_ref ?? null, assetId, title };
}

export async function rightsPreview(kind: Kind, id: string, accountId: string, ask: PreviewAsk) {
  const realNow = Math.floor(Date.now() / 1000);
  const at = ask.atSec ?? realNow;
  const sl = await slices(kind, id, at, at + STRIP_SEC);
  const first = sl[0] ?? { from: at, to: at + STRIP_SEC, rules: null, windows: [] };
  const rules = first.rules;
  const ex = explainDecision(rules, ask.cc, ask.rc, at);
  const decision = ex.decision;
  const variant = decision === 'replace' ? variantFor(rules?.vm, ask.cc, ask.rc) : null;
  const who = ask.cc || 'a country the CDN cannot tell';
  const cls = ask.rc ? ` with rights class ${ask.rc}` : '';

  let rule: any = { layer: ex.layer, programme: null };
  if (ex.layer === 'account') {
    rule.reason = `The account's ${rules!.a![0] === 'a' ? 'allow list leaves out' : 'block list names'} ${who}.`;
  } else if (ex.layer === 'channel') {
    rule.reason = `The ${kind}'s own ${rules!.c![0] === 'a' ? 'allow list leaves out' : 'block list names'} ${who}.`;
  } else if (ex.layer === 'window') {
    const w = first.windows[ex.index];
    const p = w?.src;
    const listed = w.mode === 'a' ? `its allow list (${w.cc.join(', ')}) leaves out ${who}` : `its block list names ${who}`;
    rule.programme = {
      id: p?.id ?? null, title: p?.title ?? null, startsAt: iso(w.from), endsAt: iso(w.to),
      mode: w.mode === 'a' ? 'allow' : 'block', countries: w.cc, exemptRightsClasses: w.exempt,
      replacement: await replacementName(w),
    };
    rule.reason = `"${p?.title ?? 'A programme'}" is ${w.replace ? 'replaced' : 'blacked out'} for ${who}${cls}: ${listed}`
      + (w.exempt.length ? `, and ${w.exempt.join(', ')} ${w.exempt.length === 1 ? 'is' : 'are'} exempt` : '') + '.';
  } else {
    rule.reason = rules ? `No rule stops ${who}${cls} at this time.` : `No geo or rights rule applies to this ${kind}.`;
  }

  const aud = audiencesOf(sl, ask);
  const strip = stripRows(await rulesAtEdges(kind, id, sl), aud.list, ask);
  const mine = strip.find((r) => r.asked)!;
  const cur = mine.segments.find((s) => Date.parse(s.from) <= at * 1000 && at * 1000 < Date.parse(s.to));
  const until = cur && Date.parse(cur.to) < (at + STRIP_SEC) * 1000 ? cur.to : null;

  // Whether the replacement can be built: every window plays the stream's own pre-built loop.
  let loopReady: boolean | null = null;
  // When it is not ready: what it would be built from (a slate image or a loop
  // video) or why there is nothing to build it from, so the console says the
  // right thing to fix.
  let loopSource: Awaited<ReturnType<typeof import('./fillerPrep').fillerSource>> | null = null;
  if (decision === 'replace') {
    const { loadLoop } = await import('./variantManifest');
    loopReady = !!(await loadLoop(kind, id).catch(() => null));
    if (!loopReady) loopSource = await (await import('./fillerPrep')).fillerSource(kind, id).catch(() => null);
  }

  let play: { hls: string; dash: string; expiresInSec: number } | null = null;
  if (decision !== 'block') {
    const token = mintPreviewPlayToken({ a: accountId, k: kind, s: id, c: ask.cc, r: ask.rc, t: ask.atSec ?? 0 });
    // allow plays the normal stream through the same path (an empty timeline)
    const k = variant ?? 'v00000000';
    const q = `?pt=${encodeURIComponent(token)}`;
    play = { hls: `/origin/${id}/v/${k}/master.m3u8${q}`, dash: `/origin/${id}/v/${k}/manifest.mpd${q}`, expiresInSec: TOKEN_TTL_MS / 1000 };
  }

  return {
    kind, id,
    country: ask.cc || 'XX', rightsClass: ask.rc, at: iso(at), atIsNow: ask.atSec == null,
    decision,
    /** the edge's own answer string: replace with no variant service is a block there */
    edge: edgeDecision(rules, ask.cc, ask.rc, at),
    variant, variantService: variantServiceOn(), loopReady, loopSource,
    rule, until,
    play,
    windows: first.windows.map((w) => ({
      programmeId: w.src?.id ?? null, title: w.src?.title ?? null, from: iso(w.from), to: iso(w.to),
      mode: w.mode === 'a' ? 'allow' : 'block', countries: w.cc, replace: w.replace, exemptRightsClasses: w.exempt,
    })),
    strip: { from: iso(at), to: iso(at + STRIP_SEC), rows: strip, truncated: aud.truncated },
  };
}
