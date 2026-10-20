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
//    {"v":1,"a":[mode,[cc]],"c":[mode,[cc]],"w":[[from,to,mode,[cc],r]],"rp":1,"u":until}
//  mode "b" = block list, "a" = allow list. Windows are the programmes with a
//  geo rule over the next RIGHTS_HORIZON_SEC, nearest first, cut to fit; `u`
//  says until when the list is complete, and the sync rewrites the key well
//  before then. No restriction at all = no key, which the function reads as
//  open.
//
//  The store is behind EdgeStore so it is testable, and the AWS client is
//  loaded only when EDGE_RIGHTS_KVS_ARN is set: the CloudFront KeyValueStore
//  data API signs with SigV4A, which needs @aws-sdk/client-cloudfront-keyvaluestore
//  and @aws-sdk/signature-v4-crt (not installed by default).
// ============================================================================
import { query, one } from '../db';
import { normGeo, channelGeo, type GeoAccess } from './geoAccess';

export const RIGHTS_HORIZON_SEC = 24 * 3600;
export const KVS_VALUE_MAX = 1024;

type Mode = 'b' | 'a';
type ListRule = [Mode, string[]];
/** [from, to, mode, countries, replace?] in epoch seconds. */
type Window = [number, number, Mode, string[], 0 | 1];
export interface EdgeRules { v: 1; a?: ListRule; c?: ListRule; w?: Window[]; rp?: 1; u?: number }

export interface ProgrammeRight {
  starts_at: Date | string; ends_at: Date | string;
  geo_mode: string | null; geo_countries: string[] | null;
  replacement_asset_id?: string | null; replacement_kind?: string | null;
}

const toRule = (g: GeoAccess | null): ListRule | undefined => (g ? [g.mode === 'block' ? 'b' : 'a', g.countries] : undefined);
const secs = (d: Date | string) => Math.floor(new Date(d).getTime() / 1000);

/**
 * Pure: the value for one stream, or null when nothing restricts it.
 * `replacementPlaylists` says the encoder writes *_rp playlists for this
 * stream (until it does, a "replace" window is enforced as a block).
 */
export function compileEdgeRules(inp: {
  account: GeoAccess | null; channel: GeoAccess | null; programmes: ProgrammeRight[];
  replacementPlaylists?: boolean; nowSec: number; horizonSec?: number;
}): EdgeRules | null {
  const horizon = inp.nowSec + (inp.horizonSec ?? RIGHTS_HORIZON_SEC);
  const windows: Window[] = [];
  for (const p of inp.programmes) {
    const g = normGeo({ mode: p.geo_mode, countries: p.geo_countries ?? [] });
    if (!g) continue;
    const from = secs(p.starts_at), to = secs(p.ends_at);
    if (!(to > inp.nowSec) || from >= horizon || to <= from) continue;
    const replace = !!(p.replacement_asset_id || (p.replacement_kind && p.replacement_kind !== 'none'));
    windows.push([from, to, g.mode === 'block' ? 'b' : 'a', g.countries, replace ? 1 : 0]);
  }
  windows.sort((x, y) => x[0] - y[0]);
  const out: EdgeRules = { v: 1 };
  const a = toRule(inp.account), c = toRule(inp.channel);
  if (a) out.a = a;
  if (c) out.c = c;
  if (!a && !c && !windows.length) return null;
  if (inp.replacementPlaylists) out.rp = 1;
  // Fit the store's 1 KB: nearest windows first, and say until when the list
  // is complete so the sync refreshes it before the edge runs past it.
  out.w = [];
  out.u = horizon;
  for (const w of windows) {
    const trial = { ...out, w: [...out.w, w] };
    if (Buffer.byteLength(JSON.stringify(trial)) > KVS_VALUE_MAX) { out.u = w[0]; break; }
    out.w.push(w);
  }
  if (!out.w.length) delete out.w;
  if (Buffer.byteLength(JSON.stringify(out)) > KVS_VALUE_MAX) {
    // Only the account and channel lists left and still too big (hundreds of
    // countries): the allow/block list is the part that must not be cut.
    throw new Error(`edge rules for one stream exceed ${KVS_VALUE_MAX} bytes even without programme windows`);
  }
  return out;
}

/** The rules for one stream, read from the database. */
export async function loadEdgeRules(kind: 'channel' | 'event', id: string, nowSec = Math.floor(Date.now() / 1000)): Promise<EdgeRules | null> {
  const owner = kind === 'channel'
    ? await one<any>(`SELECT c.geo_mode, c.geo_countries, a.geo_access FROM channels c JOIN groups g ON g.id = c.group_id JOIN accounts a ON a.id = g.account_id WHERE c.id = $1`, [id])
    : await one<any>(`SELECT NULL AS geo_mode, NULL AS geo_countries, a.geo_access FROM events e JOIN groups g ON g.id = e.group_id JOIN accounts a ON a.id = g.account_id WHERE e.id = $1`, [id]);
  if (!owner) return null;
  const col = kind === 'channel' ? 'channel_id' : 'event_id';
  const progs = await query<ProgrammeRight>(
    `SELECT starts_at, ends_at, geo_mode, geo_countries, replacement_asset_id, replacement_kind
       FROM programmes
      WHERE ${col} = $1 AND geo_mode IN ('block', 'allow')
        AND ends_at > to_timestamp($2) AND starts_at < to_timestamp($3)
      ORDER BY starts_at LIMIT 200`, [id, nowSec, nowSec + RIGHTS_HORIZON_SEC]);
  return compileEdgeRules({
    account: normGeo(owner.geo_access), channel: channelGeo(owner), programmes: progs,
    replacementPlaylists: false, nowSec,
  });
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
