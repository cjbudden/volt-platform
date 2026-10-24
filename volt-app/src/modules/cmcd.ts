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
 * View rows, minute aggregates and the reports are build queue 1.14e.
 */
import express, { Router } from 'express';
import { asyncHandler } from '../util/http';
import { verifyKey } from '../services/apiKeys';
import { checkEventReport } from '../services/qoe/cmcdParse';
import { appendRaw, type RawRow } from '../services/qoe/rawStore';

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

/** For tests. */
export function resetCmcdLimits(): void { perSession.clear(); }

export const cmcdRouter = Router();
cmcdRouter.use(express.text({ type: ['application/cmcd', 'text/cmcd'], limit: '256kb' }));

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
  if (!rows.length) { res.status(400).json({ error: 'no valid CMCD v2 event reports', rejected: rejected.slice(0, 5) }); return; }
  const sids = new Map<string, number>();
  for (const r of rows) sids.set(r.sid, (sids.get(r.sid) ?? 0) + 1);
  for (const [sid, n] of sids) {
    if (overLimit(sid, n, now)) { res.setHeader('retry-after', '30'); res.status(429).json({ error: 'slow down' }); return; }
  }
  await appendRaw(key.account_id, rows);
  if (rejected.length) res.setHeader('x-cmcd-rejected', String(rejected.length));
  res.status(204).end();
}));
