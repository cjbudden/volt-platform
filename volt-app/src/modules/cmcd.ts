/**
 * CMCD v2 EVENT MODE COLLECTOR (QOE_REPORTING.md sections 2 and 3).
 *
 *   POST /api/cmcd?appKey=pk_...        (also /api/public/cmcd)
 *   Content-Type: application/cmcd      (text/cmcd, CTA-5004-A's name, accepted)
 *   Body: one CMCD report per line
 *
 * Public: a viewer's player sends it, before the play gate has answered (a
 * refused entitlement is still reported), so the publishable key, not a
 * playback token, says whose viewer it is. Each line must be a v2 event
 * report with v, ts, e and sid; the lines that are not are counted and left
 * out, the rest are kept raw (services/qoe/rawStore.ts) before anything is
 * made of them. Answers, by the spec's collector rules:
 *
 *   204  received
 *   400  nothing in the body was a valid report
 *   410  stop reporting: the key is not a publishable key we know
 *   413  more than MAX_LINES reports in one POST
 *   415  not application/cmcd
 *   429  this session is sending too fast (the player sends bigger batches,
 *        later); Retry-After says when
 *
 * Once kept raw, the batch goes to the live path (services/qoe/collector.ts),
 * which builds view rows and minute aggregates in the separate analytics
 * database; the reports are modules/qoe.ts. With several collector tasks,
 * each session's rows go to the one task that owns it (services/qoe/
 * sidRoute.ts); the owners take them on POST /api/cmcd/_peer, a signed
 * request from another task, never from a player.
 */
import express, { Router } from 'express';
import { asyncHandler } from '../util/http';
import { verifyKey } from '../services/apiKeys';
import { checkEventReport } from '../services/qoe/cmcdParse';
import { appendRaw, type RawRow } from '../services/qoe/rawStore';
import { countReports, ingestReports } from '../services/qoe/collector';
import { receiveForward, route, routeStats, startRouting, verifyPeer } from '../services/qoe/sidRoute';
import type { RawCtx } from '../services/qoe/views';
import { scaleConfig } from '../scale/config';

export const MAX_LINES = 200;
/** Reports one session may send per minute. The SDK's worst case is far below (a heartbeat every 30 s, events, 1 in 50 requests). */
export const SESSION_LINES_PER_MIN = 600;

const perSession = new Map<string, { n: number; since: number }>();
function overLimit(sid: string, n: number, now: number): boolean {
  const s = perSession.get(sid);
  if (!s || now - s.since >= 60_000) { perSession.set(sid, { n, since: now }); return n > SESSION_LINES_PER_MIN; }
  s.n += n;
  return s.n > SESSION_LINES_PER_MIN;
}
// Forget idle sessions, so the map stays the size of the live audience.
setInterval(() => { const cut = Date.now() - 120_000; for (const [k, v] of perSession) if (v.since < cut) perSession.delete(k); }, 60_000).unref?.();

/**
 * What the request says about the viewer, kept with the session's first raw
 * row of each POST: the user agent and platform hints (OS, browser, device
 * class are read from them at derive time, so a better parser can replay),
 * and country, region and network (ASN) from the CDN's own headers when the
 * edge is trusted (TRUST_EDGE_GEO, as the play gate). Never the IP address.
 */
function requestCtx(req: express.Request): RawCtx {
  const c: RawCtx = {};
  const ua = req.get('user-agent'); if (ua) c.ua = ua.slice(0, 300);
  const chp = req.get('sec-ch-ua-platform'); if (chp) c.chp = chp.slice(0, 40);
  const chv = req.get('sec-ch-ua-platform-version'); if (chv) c.chv = chv.slice(0, 40);
  const e = scaleConfig.edge;
  if (e.trustGeoHeader && (!e.sharedSecret || req.get('x-volt-edge') === e.sharedSecret)) {
    for (const h of e.geoHeaders) { const v = req.get(h); if (v && /^[A-Za-z]{2}$/.test(v)) { c.cc = v.toUpperCase(); break; } }
    const rg = req.get('cloudfront-viewer-country-region') ?? req.get('x-viewer-region'); if (rg && /^[A-Za-z0-9-]{1,8}$/.test(rg)) c.rg = rg.toUpperCase();
    const asn = req.get('cloudfront-viewer-asn') ?? req.get('x-viewer-asn'); if (asn && /^\d{1,10}$/.test(asn)) c.asn = asn;
  }
  return c;
}

/** For tests. */
export function resetCmcdLimits(): void { perSession.clear(); }

export const cmcdRouter = Router();
cmcdRouter.use(express.text({ type: ['application/cmcd', 'text/cmcd'], limit: '256kb' }));

// FROM ANOTHER COLLECTOR TASK: the sessions this task owns, received by a
// peer and already kept raw there. Signed with the key every task derives
// (sidRoute.ts); anything else is 401. Read as text so the signature is
// checked over the exact bytes sent.
cmcdRouter.post('/_peer', express.text({ type: 'application/json', limit: '8mb' }), asyncHandler(async (req, res) => {
  const body = typeof req.body === 'string' ? req.body : '';
  if (!verifyPeer(req.get('x-volt-peer'), body)) { routeStats.refused++; res.status(401).json({ error: 'not a collector task' }); return; }
  let msg: any;
  try { msg = JSON.parse(body); } catch { res.status(400).json({ error: 'bad body' }); return; }
  const batches = Array.isArray(msg?.batches) ? msg.batches.filter((b: any) => typeof b?.acct === 'string' && Array.isArray(b.rows)) : [];
  receiveForward(batches, ingestReports);
  res.status(204).end();
}));

cmcdRouter.post('/', asyncHandler(async (req, res) => {
  res.setHeader('cache-control', 'no-store');
  if (!req.is('application/cmcd') && !req.is('text/cmcd')) { res.status(415).json({ error: 'use Content-Type: application/cmcd' }); return; }
  const raw = String(req.query.appKey ?? req.query.key ?? '');
  const key = raw ? await verifyKey(raw) : null;
  // 410, not 401: the spec's "stop reporting", so a player with a wrong or
  // revoked key goes quiet instead of retrying every few seconds.
  if (!key || key.kind !== 'publishable') { res.status(410).json({ error: 'unknown publishable key' }); return; }
  const lines = String(req.body ?? '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (lines.length > MAX_LINES) { res.status(413).json({ error: `at most ${MAX_LINES} reports per request` }); return; }
  const now = Date.now();
  const rows: RawRow[] = [];
  const rejected: string[] = [];
  for (const line of lines) {
    if (line.length > 4096) { rejected.push('line too long'); continue; }
    const c = checkEventReport(line, now);
    if (!c.ok) { rejected.push(c.why ?? 'invalid'); continue; }
    rows.push({ rt: now, app: key.app_id ?? null, sid: String(c.report!.sid), e: String(c.report!.e), line });
  }
  if (!rows.length) { countReports(key.account_id, now, 0, rejected); res.status(400).json({ error: 'no valid CMCD v2 event reports', rejected: rejected.slice(0, 5) }); return; }
  const sids = new Map<string, number>();
  for (const r of rows) sids.set(r.sid, (sids.get(r.sid) ?? 0) + 1);
  for (const [sid, n] of sids) {
    if (overLimit(sid, n, now)) { res.setHeader('retry-after', '30'); res.status(429).json({ error: 'slow down' }); return; }
  }
  // The request's context once per session in this POST (the first row).
  const ctx = requestCtx(req);
  const seen = new Set<string>();
  for (const r of rows) if (!seen.has(r.sid)) { seen.add(r.sid); r.ctx = ctx; }
  // RAW FIRST: the record is on disk (or in the S3 write buffer) before
  // anything is derived from it, and before the player hears 204.
  await appendRaw(key.account_id, rows);
  countReports(key.account_id, now, rows.length, rejected);
  // Derive the sessions this task owns; the others go to their owners.
  await startRouting();
  route(key.account_id, rows, ingestReports);
  if (rejected.length) res.setHeader('x-cmcd-rejected', String(rejected.length));
  res.status(204).end();
}));
