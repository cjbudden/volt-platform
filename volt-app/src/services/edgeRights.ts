// ============================================================================
//  EDGE RIGHTS: the rules a CloudFront Function enforces on every manifest
//  request (deploy/edge/rights-viewer-request.js), kept in the CloudFront
//  KeyValueStore by the control plane.
//
//  In production viewers fetch playlists from CloudFront, which reads them
//  from S3; the control plane is not on that path, so the play gate's geo
//  checks (services/rights.ts, services/geoAccess.ts) only decide who gets a
//  play URL. The edge function closes that: same stable URL, the decision
//  re-made per manifest request from the viewer's country.
//
//  One key per stream, "s:<id>", a compact JSON value (the store allows 1 KB
//  per value):
//    {"v":1,"a":[mode,[cc]],"c":[mode,[cc]],"w":[[from,to,mode,[cc],r,[rc]?]],
//     "vm":{"AU":"v1a2b3c4d","*/premium":...},"vs":1,"u":until}
//  mode "b" = block list, "a" = allow list. Windows are the programmes with a
//  geo rule over the next RIGHTS_HORIZON_SEC, nearest first, cut to fit; `u`
//  says until when the list is complete, and the sync rewrites the key well
//  before then. No restriction at all = no key, which the function reads as
//  open.
//
//  VARIANTS (EDGE_RIGHTS_VARIANTS.md, which replaces the single `_rp`
//  replacement playlist). Different audiences can be replaced at different
//  times (AU 20:00 to 21:00, NZ 21:00 to 22:00), so one replacement playlist
//  cannot serve them all. reduceVariants() works out, per audience (a country
//  the rules name, or "*" for every other one, optionally with a rights
//  class), its replace timeline: the windows and the asset for each. Every
//  audience with the same timeline shares one variant, keyed by a hash of the
//  timeline ("v" + 8 hex), so the key is the same on every edge and cache
//  entry and the work grows with distinct outcomes, never with viewers.
//  `vm` maps audiences to keys (only where the more general entry would give
//  a different key, to keep the value small); the edge answers
//  replace:<key> and rewrites to /<kind>/<id>/v/<key>/<file>. `vs` says the
//  variant manifest service is running (queue item 1.14b); until it is, a
//  replace is enforced as a block, exactly as the old function did when no
//  `_rp` playlists existed: never serve what the rights say a viewer may not
//  see.
//
//  RIGHTS CLASS. A window's 6th element lists the rights classes exempt from
//  it (from the programme's metadata.rights_exempt), for example a tier that
//  may watch through a blackout. A viewer's class reaches the edge as a short
//  HMAC-signed claim (signRightsClaim, `vrc` query parameter or cookie) that
//  the function verifies with the key the sync keeps at "k:rc". No valid
//  claim means the default class, which no window exempts.
//
//  The store is behind EdgeStore so it is testable, and the AWS client is
//  loaded only when EDGE_RIGHTS_KVS_ARN is set: the CloudFront KeyValueStore
//  data API signs with SigV4A, which needs @aws-sdk/client-cloudfront-keyvaluestore
//  and @aws-sdk/signature-v4-crt (not installed by default).
// ============================================================================
import { createHmac, createHash, timingSafeEqual } from 'node:crypto';
import { query, one } from '../db';
import { config } from '../config';
import { normGeo, channelGeo, type GeoAccess } from './geoAccess';

export const RIGHTS_HORIZON_SEC = 24 * 3600;
export const KVS_VALUE_MAX = 1024;

type Mode = 'b' | 'a';
type ListRule = [Mode, string[]];
/** [from, to, mode, countries, replace?, exempt rights classes?] in epoch seconds. */
type Window = [number, number, Mode, string[], 0 | 1] | [number, number, Mode, string[], 0 | 1, string[]];
export interface EdgeRules {
  v: 1; a?: ListRule; c?: ListRule; w?: Window[];
  /** audience ("AU", "*", "AU/premium", or "*" then "/" and a class) -> variant key */
  vm?: Record<string, string>;
  /** the variant manifest service answers /v/<key>/ (until then a replace is a block) */
  vs?: 1;
  u?: number;
}

export interface ProgrammeRight {
  starts_at: Date | string; ends_at: Date | string;
  geo_mode: string | null; geo_countries: string[] | null;
  replacement_asset_id?: string | null; replacement_kind?: string | null;
  replacement_ref?: string | null;
  metadata?: { rights_exempt?: unknown } | null;
}

/** A rights class: short, lower case, safe in a URL and a store key. */
export const RC_RE = /^[a-z0-9_-]{1,16}$/;

/**
 * Whether the variant manifest service answers /v/<key>/ (services/variantManifest.ts).
 * The app itself is the service, so wherever it serves the public route
 * (the Mac, development) it is on unless EDGE_VARIANT_SERVICE=0. In
 * production the CDN must also send /v/ to it (deploy/terraform, the
 * variants origin), so there it is on only when Terraform sets
 * EDGE_VARIANT_SERVICE=1.
 */
export const variantServiceOn = () => {
  const v = process.env.EDGE_VARIANT_SERVICE;
  if (v === '1') return true;
  if (v === '0') return false;
  return config.env !== 'production';
};

// ---------------------------------------------------------------------------
//  The decision. The CloudFront Function carries a copy of exactly this
//  (deploy/edge/rights-viewer-request.js cannot import from the app); the
//  parity test (test/edge-variants.check.ts) runs both over one fixture
//  table and fails on any difference.
// ---------------------------------------------------------------------------
function listStops(rule: [string, string[]] | undefined, cc: string): boolean {
  if (!rule) return false;
  const mode = rule[0], list = rule[1] || [];
  if (mode === 'b') return !!cc && list.indexOf(cc) >= 0;
  if (mode === 'a') return !cc || list.indexOf(cc) < 0;
  return false;
}
const exempted = (x: Window, rc: string) => !!rc && !!x[5] && x[5].indexOf(rc) >= 0;

/** "allow" | "block" | "replace" for a country and rights class at a time. */
export function decideFor(rules: EdgeRules | null, cc: string, rc: string, nowSec: number): 'allow' | 'block' | 'replace' {
  if (!rules || rules.v !== 1) return 'allow';
  if (listStops(rules.a, cc)) return 'block';
  if (listStops(rules.c, cc)) return 'block';
  for (const x of rules.w || []) {
    if (nowSec >= x[0] && nowSec < x[1] && listStops([x[2], x[3]], cc) && !exempted(x, rc)) return x[4] ? 'replace' : 'block';
  }
  return 'allow';
}

/** The variant an audience is mapped to: most specific entry first. */
export function variantFor(vm: Record<string, string> | undefined, cc: string, rc: string): string | null {
  if (!vm) return null;
  return (cc && rc ? vm[cc + '/' + rc] : undefined) ?? (cc ? vm[cc] : undefined) ?? (rc ? vm['*/' + rc] : undefined) ?? vm['*'] ?? null;
}

/**
 * What the edge does with a manifest request: "allow", "block" or
 * "replace:<key>". A replace with no variant (or no variant service yet) is a
 * block. Same string as the CloudFront Function's edgeDecision().
 */
export function edgeDecision(rules: EdgeRules | null, cc: string, rc: string, nowSec: number): string {
  const d = decideFor(rules, cc, rc, nowSec);
  if (d !== 'replace') return d;
  const k = variantFor(rules!.vm, cc, rc);
  return k && rules!.vs ? 'replace:' + k : 'block';
}

// ---------------------------------------------------------------------------
//  The reducer: rules to variants
// ---------------------------------------------------------------------------
/** One replace timeline: [from, to, asset] with asset an id or "<kind>:<ref>". */
export type Timeline = [number, number, string][];
export interface Variant { key: string; timeline: Timeline; audiences: string[] }

interface Win { from: number; to: number; mode: Mode; cc: string[]; replace: boolean; asset: string; exempt: string[] }

const asWindow = (w: Win): Window => (w.exempt.length
  ? [w.from, w.to, w.mode, w.cc, w.replace ? 1 : 0, w.exempt]
  : [w.from, w.to, w.mode, w.cc, w.replace ? 1 : 0]);

/** A short stable key for a timeline: the same on every edge and cache entry. */
export const variantKey = (t: Timeline) => 'v' + createHash('sha256').update(JSON.stringify(t)).digest('hex').slice(0, 8);

/**
 * The replace timeline one audience sees over the windows, evaluated exactly
 * as decideFor() does (first window that applies wins), interval by interval
 * between every window edge, adjacent pieces with the same asset merged.
 */
function timelineFor(wins: Win[], cc: string, rc: string): Timeline {
  const edges = [...new Set(wins.flatMap((w) => [w.from, w.to]))].sort((a, b) => a - b);
  const out: Timeline = [];
  for (let i = 0; i + 1 < edges.length; i++) {
    const t0 = edges[i], t1 = edges[i + 1];
    const w = wins.find((x) => t0 >= x.from && t0 < x.to && listStops([x.mode, x.cc], cc) && !(rc && x.exempt.includes(rc)));
    if (!w || !w.replace) continue;
    const last = out[out.length - 1];
    if (last && last[1] === t0 && last[2] === w.asset) last[1] = t1;
    else out.push([t0, t1, w.asset]);
  }
  return out;
}

/**
 * Pure: the variants for a set of windows (already sorted as published) and
 * the audience map the edge reads. Audiences are every country the windows
 * name plus "*" (any other country, or one the CDN cannot tell), each also
 * with every rights class the windows exempt.
 */
export function reduceVariants(windows: Win[]): { variants: Variant[]; vm: Record<string, string> } {
  const countries = [...new Set(windows.flatMap((w) => w.cc))].sort();
  const classes = [...new Set(windows.flatMap((w) => w.exempt))].sort();
  const audiences: [string, string, string][] = [];   // [name, cc, rc], general before specific
  audiences.push(['*', '', '']);
  for (const rc of classes) audiences.push(['*/' + rc, '', rc]);
  for (const cc of countries) {
    audiences.push([cc, cc, '']);
    for (const rc of classes) audiences.push([cc + '/' + rc, cc, rc]);
  }
  const byKey = new Map<string, Variant>();
  const vm: Record<string, string> = {};
  for (const [name, cc, rc] of audiences) {
    const t = timelineFor(windows, cc, rc);
    if (!t.length) continue;          // never replaced: the key is never asked for
    const key = variantKey(t);
    if (!byKey.has(key)) byKey.set(key, { key, timeline: t, audiences: [] });
    byKey.get(key)!.audiences.push(name);
    if (variantFor(vm, cc, rc) !== key) vm[name] = key;
  }
  return { variants: [...byKey.values()], vm };
}

function exemptOf(p: ProgrammeRight): string[] {
  const raw = (p.metadata as any)?.rights_exempt;
  if (!Array.isArray(raw)) return [];
  return [...new Set(raw.map((x) => String(x).toLowerCase()).filter((x) => RC_RE.test(x)))].sort();
}

/** The windows a stream's programmes give, nearest first, from now to the horizon. */
function windowsOf(programmes: ProgrammeRight[], nowSec: number, horizon: number): Win[] {
  const out: Win[] = [];
  for (const p of programmes) {
    const g = normGeo({ mode: p.geo_mode, countries: p.geo_countries ?? [] });
    if (!g) continue;
    const from = secs(p.starts_at), to = secs(p.ends_at);
    if (!(to > nowSec) || from >= horizon || to <= from) continue;
    const kind = p.replacement_kind && p.replacement_kind !== 'none' ? p.replacement_kind : null;
    const replace = !!(p.replacement_asset_id || kind);
    out.push({ from, to, mode: g.mode === 'block' ? 'b' : 'a', cc: g.countries, replace,
      asset: p.replacement_asset_id ? String(p.replacement_asset_id) : replace ? `${kind}:${p.replacement_ref ?? ''}` : '',
      exempt: exemptOf(p) });
  }
  // stable: programmes arrive ordered by start, and ties keep that order
  return out.sort((x, y) => x.from - y.from);
}

/** The variants a stream has now (for the manifest service and the rights preview). */
export function streamVariants(programmes: ProgrammeRight[], nowSec: number, horizonSec = RIGHTS_HORIZON_SEC) {
  return reduceVariants(windowsOf(programmes, nowSec, nowSec + horizonSec));
}

// ---------------------------------------------------------------------------
//  The rights-class claim
// ---------------------------------------------------------------------------
/** The key the claim is signed with, and that the sync publishes at "k:rc". */
export function rightsClaimKey(): string {
  return process.env.EDGE_RIGHTS_CLAIM_KEY
    || createHmac('sha256', config.jwt.accessSecret).update('volt-edge-rights-claim-v1').digest('hex');
}
const claimSig = (key: string, streamId: string, rc: string, exp: number) =>
  createHmac('sha256', key).update(`${streamId}|${rc}|${exp}`).digest('hex').slice(0, 32);

/** "<rc>.<exp>.<sig>": tied to one stream, valid until `expSec`. */
export function signRightsClaim(streamId: string, rc: string, expSec: number, key = rightsClaimKey()): string {
  if (!RC_RE.test(rc)) throw new Error(`rights class must match ${RC_RE}`);
  return `${rc}.${expSec}.${claimSig(key, streamId, rc, expSec)}`;
}

/** The rights class a claim proves, or '' (the default class) when it proves nothing. */
export function verifyRightsClaim(value: string | null | undefined, streamId: string, nowSec: number, key = rightsClaimKey()): string {
  const m = /^([a-z0-9_-]{1,16})\.(\d{1,12})\.([0-9a-f]{32})$/.exec(String(value ?? ''));
  if (!m) return '';
  const exp = Number(m[2]);
  if (!(exp > nowSec)) return '';
  const want = Buffer.from(claimSig(key, streamId, m[1], exp)), got = Buffer.from(m[3]);
  return want.length === got.length && timingSafeEqual(want, got) ? m[1] : '';
}

const toRule = (g: GeoAccess | null): ListRule | undefined => (g ? [g.mode === 'block' ? 'b' : 'a', g.countries] : undefined);
const secs = (d: Date | string) => Math.floor(new Date(d).getTime() / 1000);

/**
 * Pure: the value for one stream, or null when nothing restricts it.
 * `variantService` says the variant manifest service answers /v/<key>/ for
 * this deployment (until it does, a "replace" window is enforced as a block).
 */
export function compileEdgeRules(inp: {
  account: GeoAccess | null; channel: GeoAccess | null; programmes: ProgrammeRight[];
  variantService?: boolean; nowSec: number; horizonSec?: number;
}): EdgeRules | null {
  const horizon = inp.nowSec + (inp.horizonSec ?? RIGHTS_HORIZON_SEC);
  const windows = windowsOf(inp.programmes, inp.nowSec, horizon);
  const base: EdgeRules = { v: 1 };
  const a = toRule(inp.account), c = toRule(inp.channel);
  if (a) base.a = a;
  if (c) base.c = c;
  if (!a && !c && !windows.length) return null;
  if (inp.variantService) base.vs = 1;
  // The value for the first n windows: the audience map is worked out from
  // exactly the windows published, so the edge never maps an audience to a
  // variant built from windows it cannot see.
  const build = (n: number, u: number): EdgeRules => {
    const ws = windows.slice(0, n);
    const out: EdgeRules = { ...base };
    if (ws.length) out.w = ws.map(asWindow);
    const { vm } = reduceVariants(ws);
    if (Object.keys(vm).length) out.vm = vm;
    out.u = u;
    return out;
  };
  // Fit the store's 1 KB: nearest windows first, and say until when the list
  // is complete so the sync refreshes it before the edge runs past it.
  let out = build(0, windows.length ? windows[0].from : horizon);
  for (let n = 1; n <= windows.length; n++) {
    const trial = build(n, n < windows.length ? windows[n].from : horizon);
    if (Buffer.byteLength(JSON.stringify(trial)) > KVS_VALUE_MAX) break;
    out = trial;
  }
  if (Buffer.byteLength(JSON.stringify(out)) > KVS_VALUE_MAX) {
    // Only the account and channel lists left and still too big (hundreds of
    // countries): the allow/block list is the part that must not be cut.
    throw new Error(`edge rules for one stream exceed ${KVS_VALUE_MAX} bytes even without programme windows`);
  }
  return out;
}

/** The rules for one stream, read from the database. */
export async function loadEdgeRules(kind: 'channel' | 'event', id: string, nowSec = Math.floor(Date.now() / 1000)): Promise<EdgeRules | null> {
  return (await loadEdgeState(kind, id, nowSec)).rules;
}

/**
 * The rules AND the variants behind their audience map, from exactly the
 * windows the rules publish (the 1 KB cut included), so the manifest service
 * builds each key from the same timeline the edge was given that key for.
 */
export async function loadEdgeState(kind: 'channel' | 'event', id: string, nowSec = Math.floor(Date.now() / 1000)): Promise<{ rules: EdgeRules | null; variants: Variant[] }> {
  const rules = await loadEdgeRulesFromDb(kind, id, nowSec);
  if (!rules.rules) return { rules: null, variants: [] };
  const n = rules.rules.w?.length ?? 0;
  return { rules: rules.rules, variants: reduceVariants(windowsOf(rules.programmes, nowSec, nowSec + RIGHTS_HORIZON_SEC).slice(0, n)).variants };
}

async function loadEdgeRulesFromDb(kind: 'channel' | 'event', id: string, nowSec: number): Promise<{ rules: EdgeRules | null; programmes: ProgrammeRight[] }> {
  const owner = kind === 'channel'
    ? await one<any>(`SELECT c.geo_mode, c.geo_countries, a.geo_access FROM channels c JOIN groups g ON g.id = c.group_id JOIN accounts a ON a.id = g.account_id WHERE c.id = $1`, [id])
    : await one<any>(`SELECT NULL AS geo_mode, NULL AS geo_countries, a.geo_access FROM events e JOIN groups g ON g.id = e.group_id JOIN accounts a ON a.id = g.account_id WHERE e.id = $1`, [id]);
  if (!owner) return { rules: null, programmes: [] };
  const col = kind === 'channel' ? 'channel_id' : 'event_id';
  const progs = await query<ProgrammeRight>(
    `SELECT starts_at, ends_at, geo_mode, geo_countries, replacement_asset_id, replacement_kind, replacement_ref, metadata
       FROM programmes
      WHERE ${col} = $1 AND geo_mode IN ('block', 'allow')
        AND ends_at > to_timestamp($2) AND starts_at < to_timestamp($3)
      ORDER BY starts_at LIMIT 200`, [id, nowSec, nowSec + RIGHTS_HORIZON_SEC]);
  return {
    programmes: progs,
    rules: compileEdgeRules({
      account: normGeo(owner.geo_access), channel: channelGeo(owner), programmes: progs,
      variantService: variantServiceOn(), nowSec,
    }),
  };
}

// ---------------------------------------------------------------------------
//  The store and the sync
// ---------------------------------------------------------------------------
export interface EdgeStore {
  get(key: string): Promise<string | null>;
  put(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}

export const keyFor = (id: string) => `s:${id}`;

/**
 * Write each stream's rules where they changed, delete keys that no longer
 * restrict anything. Rewrites a key whose window list will run out within
 * the hour even if nothing else changed. Returns what it did.
 */
export async function syncEdgeRights(store: EdgeStore, streams: { kind: 'channel' | 'event'; id: string }[],
  nowSec = Math.floor(Date.now() / 1000),
  /** What this process last wrote per key, so a steady state reads nothing from the store. */
  memo?: Map<string, string | null>): Promise<{ put: number; deleted: number; unchanged: number; failed: number }> {
  const res = { put: 0, deleted: 0, unchanged: 0, failed: 0 };
  for (const s of streams) {
    try {
      const rules = await loadEdgeRules(s.kind, s.id, nowSec);
      const key = keyFor(s.id);
      const cur = memo?.has(key) ? memo.get(key)! : await store.get(key);
      if (!rules) {
        if (cur != null) { await store.delete(key); res.deleted++; } else res.unchanged++;
        memo?.set(key, null);
        continue;
      }
      const next = JSON.stringify(rules);
      let stale = true;
      if (cur != null) {
        try {
          const c = JSON.parse(cur) as EdgeRules;
          const same = JSON.stringify({ ...c, u: 0 }) === JSON.stringify({ ...rules, u: 0 });
          stale = !same || (c.u ?? 0) - nowSec < 3600;
        } catch { stale = true; }
      }
      if (stale) { await store.put(key, next); res.put++; memo?.set(key, next); } else { res.unchanged++; memo?.set(key, cur); }
    } catch (e) {
      res.failed++;
      console.error(`[edge-rights] ${s.kind} ${s.id}:`, e);
    }
  }
  return res;
}

/** The key that publishes the claim key to the edge. */
export const CLAIM_KEY = 'k:rc';

/** Keep the claim key in the store (the function verifies `vrc` claims with it). */
export async function syncClaimKey(store: EdgeStore, memo?: Map<string, string | null>, key = rightsClaimKey()): Promise<boolean> {
  const cur = memo?.has(CLAIM_KEY) ? memo.get(CLAIM_KEY)! : await store.get(CLAIM_KEY);
  memo?.set(CLAIM_KEY, key);
  if (cur === key) return false;
  await store.put(CLAIM_KEY, key);
  return true;
}

/** Every channel and event that could have a rule: all of them that are not deleted. */
export async function allStreams(): Promise<{ kind: 'channel' | 'event'; id: string }[]> {
  const ch = await query<any>(`SELECT id FROM channels`);
  const ev = await query<any>(`SELECT id FROM events WHERE COALESCE(status::text, '') <> 'ended' OR scheduled_end > now() - interval '1 day'`);
  return [...ch.map((r: any) => ({ kind: 'channel' as const, id: r.id })), ...ev.map((r: any) => ({ kind: 'event' as const, id: r.id }))];
}

/**
 * The CloudFront KeyValueStore behind EdgeStore. Every write needs the
 * store's current ETag (optimistic concurrency), so it is fetched per write.
 */
export async function cloudFrontKvsStore(arn: string): Promise<EdgeStore> {
  let mod: any;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    mod = require('@aws-sdk/client-cloudfront-keyvaluestore');
    require('@aws-sdk/signature-v4-crt');
  } catch {
    throw new Error('EDGE_RIGHTS_KVS_ARN is set but @aws-sdk/client-cloudfront-keyvaluestore and @aws-sdk/signature-v4-crt are not installed (the KeyValueStore API signs with SigV4A)');
  }
  const client = new mod.CloudFrontKeyValueStoreClient({});
  const etag = async () => (await client.send(new mod.DescribeKeyValueStoreCommand({ KvsARN: arn }))).ETag;
  return {
    async get(key) {
      try { return (await client.send(new mod.GetKeyCommand({ KvsARN: arn, Key: key }))).Value ?? null; } catch (e: any) {
        if (e?.name === 'ResourceNotFoundException') return null;
        throw e;
      }
    },
    async put(key, value) { await client.send(new mod.PutKeyCommand({ KvsARN: arn, Key: key, Value: value, IfMatch: await etag() })); },
    async delete(key) {
      try { await client.send(new mod.DeleteKeyCommand({ KvsARN: arn, Key: key, IfMatch: await etag() })); } catch (e: any) {
        if (e?.name !== 'ResourceNotFoundException') throw e;
      }
    },
  };
}
