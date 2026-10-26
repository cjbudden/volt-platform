/**
 * JOURNEY TO PLAY: THE APP'S EVENTS (QOE_REPORTING.md section 13, build queue 1.14g).
 *
 *   POST /api/journey?appKey=pk_...        (also /api/public/journey)
 *   Content-Type: application/x-ndjson     (application/json with one event or an array also accepted)
 *   Body: one event per line, as services/qoe/journeys.ts describes
 *
 * Public, like the CMCD collector next to it (modules/cmcd.ts): the app sends
 * it with its publishable key, before and after the play. The app's consent
 * decides whether the SDK sends anything at all. Each event is checked
 * against the fixed set and only its allowed fields are kept, raw first,
 * before the app session and journey rows are made from it. Answers:
 *
 *   204  received (x-journey-dropped-fields: fields left out, if any)
 *   400  nothing in the body was a valid event
 *   410  stop sending: the key is not a publishable key we know
 *   413  more than MAX_EVENTS events in one POST
 *   415  not NDJSON or JSON
 *   429  this app session is sending too fast; Retry-After says when
 */
import express, { Router } from 'express';
import { asyncHandler } from '../util/http';
import { verifyKey } from '../services/apiKeys';
import { appendRaw, type RawRow } from '../services/qoe/rawStore';
import { checkJourneyEvent, ingestJourneyEvents, type JEv } from '../services/qoe/journeys';
import type { RawCtx } from '../services/qoe/views';
import { scaleConfig } from '../scale/config';

export const MAX_EVENTS = 200;
/** Events one app session may send per minute: far above the 20 to 40 a whole session makes. */
export const SESSION_EVENTS_PER_MIN = 300;

const perSession = new Map<string, { n: number; since: number }>();
function overLimit(asid: string, n: number, now: number): boolean {
  const s = perSession.get(asid);
  if (!s || now - s.since >= 60_000) { perSession.set(asid, { n, since: now }); return n > SESSION_EVENTS_PER_MIN; }
  s.n += n;
  return s.n > SESSION_EVENTS_PER_MIN;
}
setInterval(() => { const cut = Date.now() - 120_000; for (const [k, v] of perSession) if (v.since < cut) perSession.delete(k); }, 60_000).unref?.();
export function resetJourneyLimits(): void { perSession.clear(); }

/** The request's context, as the CMCD collector keeps it: user agent, platform hints, the trusted edge's geo. Never the IP. */
function requestCtx(req: express.Request): RawCtx {
  const c: RawCtx = {};
  const ua = req.get('user-agent'); if (ua) c.ua = ua.slice(0, 300);
  const chp = req.get('sec-ch-ua-platform'); if (chp) c.chp = chp.slice(0, 40);
  const chv = req.get('sec-ch-ua-platform-version'); if (chv) c.chv = chv.slice(0, 40);
  const e = scaleConfig.edge;
  if (e.trustGeoHeader && (!e.sharedSecret || req.get('x-volt-edge') === e.sharedSecret)) {
    for (const h of e.geoHeaders) { const v = req.get(h); if (v && /^[A-Za-z]{2}$/.test(v)) { c.cc = v.toUpperCase(); break; } }
  }
  return c;
}

export const journeyRouter = Router();
journeyRouter.use(express.text({ type: ['application/x-ndjson', 'application/json'], limit: '256kb' }));

journeyRouter.post('/', asyncHandler(async (req, res) => {
  res.setHeader('cache-control', 'no-store');
  const json = req.is('application/json');
  if (!req.is('application/x-ndjson') && !json) { res.status(415).json({ error: 'use Content-Type: application/x-ndjson' }); return; }
  const rawKey = String(req.query.appKey ?? req.query.key ?? '');
  const key = rawKey ? await verifyKey(rawKey) : null;
  if (!key || key.kind !== 'publishable') { res.status(410).json({ error: 'unknown publishable key' }); return; }
  // application/json may already be parsed by the app-wide JSON parser (server.ts); NDJSON arrives as text.
  const body: unknown = req.body;
  const text = typeof body === 'string' ? body : '';
  let items: unknown[] = [];
  try {
    if (json) { const v = typeof body === 'string' ? JSON.parse(body || 'null') : body; items = Array.isArray(v) ? v : v == null || (typeof v === 'object' && !Object.keys(v as object).length) ? [] : [v]; }
    else items = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } });
  } catch { items = [null]; }
  if (items.length > MAX_EVENTS) { res.status(413).json({ error: `at most ${MAX_EVENTS} events per request` }); return; }
  const now = Date.now();
  const rows: RawRow[] = [];
  const evs: JEv[] = [];
  const rejected: string[] = [];
  let dropped = 0;
  for (const it of items) {
    const c = checkJourneyEvent(it, now);
    if (!c.ok) { rejected.push(c.why ?? 'invalid'); continue; }
    dropped += c.dropped?.length ?? 0;
    // Raw first, but only what may be kept: the checked event, not the body as sent.
    rows.push({ rt: now, app: key.app_id ?? null, sid: c.ev!.asid, e: c.ev!.e, line: JSON.stringify(c.ev) });
    evs.push({ ev: c.ev!, rt: now, app: key.app_id ?? null });
  }
  if (!rows.length) { res.status(400).json({ error: 'no valid journey events', rejected: rejected.slice(0, 5) }); return; }
  const per = new Map<string, number>();
  for (const r of rows) per.set(r.sid, (per.get(r.sid) ?? 0) + 1);
  for (const [asid, n] of per) if (overLimit(asid, n, now)) { res.setHeader('retry-after', '30'); res.status(429).json({ error: 'slow down' }); return; }
  const ctx = requestCtx(req);
  const seen = new Set<string>();
  rows.forEach((r, i) => { if (!seen.has(r.sid)) { seen.add(r.sid); r.ctx = ctx; evs[i].ctx = ctx; } });
  await appendRaw(key.account_id, rows, 'journey');
  ingestJourneyEvents(key.account_id, evs, now);
  if (rejected.length) res.setHeader('x-journey-rejected', String(rejected.length));
  if (dropped) res.setHeader('x-journey-dropped-fields', String(dropped));
  res.status(204).end();
}));
