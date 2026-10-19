/**
 * Operating reports. docs/REQ_stream_reporting.md
 *
 *   GET /api/reports/stream/:id            one channel, station or event over a period
 *   GET /api/reports/stream/:id.csv        the same, one row per run plus a TOTAL row
 *   GET /api/reports/streams               every stream that ran or was on air in the period
 *   GET /api/reports/streams.csv           the same, as CSV (the version a client opens monthly)
 *
 * Query: from, to (ISO dates or timestamps; default the last 30 days, at most
 * 400 days). The summary also takes kind=channel|radio|event, q (name contains)
 * and sort=<column> or sort=-<column>.
 *
 * Tenant scoped like every other report. Cost is the PLATFORM's cost basis, so
 * it is only included for a reader with a platform role (RELAY.md).
 * Gated by the `analytics` feature (auth/roles.ts) alongside /api/analytics.
 */
import { Router, Request } from 'express';
import { requireAuth, accountId } from '../auth/middleware';
import { asyncHandler, badRequest, notFound } from '../util/http';
import { one } from '../db';
import {
  resolveStream, streamReport, streamReportCsv, streamsInPeriod, summaryRow, summaryCsv, SummaryRow,
} from '../services/streamReport';

export const reportsRouter = Router();
reportsRouter.use(requireAuth);

const DAY = 86_400_000;

function period(req: Request): { from: Date; to: Date } {
  const parse = (v: unknown, name: string): Date | null => {
    if (v == null || v === '') return null;
    const d = new Date(String(v));
    if (Number.isNaN(d.getTime())) throw badRequest(`${name} is not a valid date or timestamp`);
    return d;
  };
  const to = parse(req.query.to, 'to') ?? new Date();
  // A bare date for `to` means the whole of that day.
  if (typeof req.query.to === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(req.query.to)) to.setTime(to.getTime() + DAY);
  const from = parse(req.query.from, 'from') ?? new Date(to.getTime() - 30 * DAY);
  if (to <= from) throw badRequest('to must be after from');
  if (to.getTime() - from.getTime() > 400 * DAY) throw badRequest('a report covers at most 400 days');
  return { from, to };
}

/** Cost basis is ours, not the customer's spend: platform readers only. */
async function canSeeCost(req: Request): Promise<boolean> {
  const sub = req.auth?.sub;
  if (!sub || !/^[0-9a-f-]{36}$/i.test(sub)) return false;
  const u = await one<any>(`SELECT platform_role FROM users WHERE id = $1`, [sub]);
  return !!u?.platform_role;
}

const fileDate = (d: Date) => d.toISOString().slice(0, 10);
const slug = (s: string) => s.replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'stream';

reportsRouter.get('/stream/:id', asyncHandler(async (req, res) => {
  let id = String(req.params.id);
  const csv = id.endsWith('.csv') || req.query.format === 'csv';
  id = id.replace(/\.csv$/, '');
  const acct = accountId(req);
  const s = await resolveStream(acct, id);
  if (!s) throw notFound('No channel, station or event with that id in this account');
  const { from, to } = period(req);
  const cost = await canSeeCost(req);
  const r = await streamReport(acct, s, from, to, { includeCost: cost });
  res.setHeader('Cache-Control', 'no-store');
  if (csv) {
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="operating-report-${slug(s.name)}-${fileDate(from)}-to-${fileDate(new Date(to.getTime() - 1))}.csv"`);
    return res.send(streamReportCsv(r, cost));
  }
  res.json({
    ...r,
    links: {
      self: `/api/reports/stream/${id}?from=${encodeURIComponent(from.toISOString())}&to=${encodeURIComponent(to.toISOString())}`,
      csv: `/api/reports/stream/${id}.csv?from=${encodeURIComponent(from.toISOString())}&to=${encodeURIComponent(to.toISOString())}`,
      up: `/api/reports/streams?from=${encodeURIComponent(from.toISOString())}&to=${encodeURIComponent(to.toISOString())}`,
      stream: s.exists ? (s.kind === 'event' ? `/api/events/${id}` : s.kind === 'radio' ? `/api/radio/${id}` : `/api/channels/${id}`) : null,
    },
  });
}));

const SORTABLE = new Set(['name', 'kind', 'runs', 'hours_run', 'hours_on_air', 'availability_pct', 'planned_stops',
  'unplanned_stops', 'unknown_stops', 'mttr_seconds', 'peak_concurrent', 'views', 'watch_hours', 'cost_basis_usd']);

async function summary(req: Request) {
  const acct = accountId(req);
  const { from, to } = period(req);
  const cost = await canSeeCost(req);
  const kind = req.query.kind ? String(req.query.kind) : null;
  if (kind && !['channel', 'radio', 'event'].includes(kind)) throw badRequest('kind must be channel, radio or event');
  const q = req.query.q ? String(req.query.q).toLowerCase() : null;
  const sortRaw = req.query.sort ? String(req.query.sort) : '-hours_run';
  const sortKey = sortRaw.replace(/^-/, '');
  if (!SORTABLE.has(sortKey)) throw badRequest(`sort must be one of: ${[...SORTABLE].join(', ')} (prefix - for descending)`);

  const ids = await streamsInPeriod(acct, from, to);
  const rows: SummaryRow[] = [];
  for (const id of ids) {
    const s = await resolveStream(acct, id);
    if (!s) continue;
    if (kind && s.kind !== kind) continue;
    if (q && !s.name.toLowerCase().includes(q)) continue;
    rows.push(summaryRow(await streamReport(acct, s, from, to, { includeCost: cost }), cost));
  }
  const dir = sortRaw.startsWith('-') ? -1 : 1;
  rows.sort((a: any, b: any) => {
    const x = a[sortKey], y = b[sortKey];
    if (x == null && y == null) return 0;
    if (x == null) return 1;           // unknowns last, whichever way
    if (y == null) return -1;
    return (typeof x === 'string' ? x.localeCompare(y) : x - y) * dir;
  });
  const totals = {
    streams: rows.length,
    hours_run: Math.round(rows.reduce((n, r) => n + r.hours_run, 0) * 1000) / 1000,
    hours_on_air: Math.round(rows.reduce((n, r) => n + r.hours_on_air, 0) * 1000) / 1000,
    unplanned_stops: rows.reduce((n, r) => n + r.unplanned_stops, 0),
    ...(cost ? { cost_basis_usd: Math.round(rows.reduce((n, r) => n + (r.cost_basis_usd ?? 0), 0) * 1e4) / 1e4 } : {}),
  };
  return { from, to, cost, rows, totals };
}

reportsRouter.get('/streams.csv', asyncHandler(async (req, res) => {
  const s = await summary(req);
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="operating-summary-${fileDate(s.from)}-to-${fileDate(new Date(s.to.getTime() - 1))}.csv"`);
  res.send(summaryCsv(s.rows, s.cost));
}));

reportsRouter.get('/streams', asyncHandler(async (req, res) => {
  if (req.query.format === 'csv') {
    const s = await summary(req);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    return res.send(summaryCsv(s.rows, s.cost));
  }
  const s = await summary(req);
  res.setHeader('Cache-Control', 'no-store');
  res.json({
    period: { from: s.from.toISOString(), to: s.to.toISOString() },
    totals: s.totals,
    items: s.rows.map((r) => ({ ...r, links: { report: `/api/reports/stream/${r.stream_id}?from=${encodeURIComponent(s.from.toISOString())}&to=${encodeURIComponent(s.to.toISOString())}` } })),
    links: { csv: `/api/reports/streams.csv?from=${encodeURIComponent(s.from.toISOString())}&to=${encodeURIComponent(s.to.toISOString())}` },
  });
}));
