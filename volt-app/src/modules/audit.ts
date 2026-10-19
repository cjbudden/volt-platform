// ============================================================================
//  AUDIT LOG REPORT (docs/AUDIT_LOG.md). Administrators only.
//
//  GET /api/audit?action&entityType&entityId&userId&q&from&to&limit&offset
//        -> { total, items:[{id, created_at, action, entity_type, entity_id,
//                            user_id, user_email, actor, name, detail}] }
//  GET /api/audit/facets   -> the actions, entity types and people that appear
//  GET /api/audit/export.csv (same filters, up to 50,000 rows)
//
//  Every row is the caller's own account. `from`/`to` are ISO dates or epoch ms.
// ============================================================================
import { Router, type Request } from 'express';
import { query } from '../db';
import { requireAuth, accountId } from '../auth/middleware';
import { requireMinRole } from '../auth/roles';
import { asyncHandler, badRequest } from '../util/http';

export const auditRouter = Router();
auditRouter.use(requireAuth, requireMinRole('admin'));

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function when(v: unknown, field: string): Date | null {
  if (v === undefined || v === '') return null;
  const s = String(v);
  const d = /^\d+$/.test(s) ? new Date(Number(s)) : new Date(s);
  if (Number.isNaN(d.getTime())) throw badRequest(`${field} must be an ISO date or epoch milliseconds`);
  return d;
}

/** WHERE clause + params for the shared filters. */
export function filters(req: Request) {
  const q = req.query as Record<string, string | undefined>;
  const where = ['a.account_id = $1'];
  const params: unknown[] = [accountId(req)];
  const add = (sql: string, v: unknown) => { params.push(v); where.push(sql.replace('?', `$${params.length}`)); };
  if (q.action) {
    // "delete" also covers refused deletes when asked with deletes=all
    const acts = q.action.split(',').map((s) => s.trim()).filter(Boolean);
    add('a.action = ANY(?)', acts);
  }
  if (q.entityType) add('a.entity_type = ANY(?)', q.entityType.split(',').map((s) => s.trim()).filter(Boolean));
  if (q.entityId) { if (!UUID.test(q.entityId)) throw badRequest('entityId must be a uuid'); add('a.entity_id = ?', q.entityId); }
  if (q.userId) { if (!UUID.test(q.userId)) throw badRequest('userId must be a uuid'); add('a.user_id = ?', q.userId); }
  const from = when(q.from, 'from'), to = when(q.to, 'to');
  if (from) add('a.created_at >= ?', from);
  if (to) add('a.created_at < ?', to);
  if (q.q && q.q.trim()) {
    const like = `%${q.q.trim().replace(/[\\%_]/g, (m) => '\\' + m)}%`;
    add(`(a.detail::text ILIKE ? OR coalesce(u.email,'') ILIKE $${params.length + 1} OR a.entity_type ILIKE $${params.length + 1} OR a.entity_id::text ILIKE $${params.length + 1})`, like);
  }
  return { where: where.join(' AND '), params };
}

const SELECT = `
  SELECT a.id, a.created_at, a.action, a.entity_type, a.entity_id, a.user_id,
         u.email AS user_email, a.detail->>'actor' AS actor,
         coalesce(a.detail#>>'{snapshot,name}', a.detail#>>'{changes,name,from}', a.detail->>'name') AS name,
         a.detail
    FROM audit_log a LEFT JOIN users u ON u.id = a.user_id`;

auditRouter.get('/', asyncHandler(async (req, res) => {
  const { where, params } = filters(req);
  const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 500);
  const offset = Math.max(Number(req.query.offset) || 0, 0);
  const [total, items] = await Promise.all([
    query<{ n: number }>(`SELECT count(*)::int AS n FROM audit_log a LEFT JOIN users u ON u.id = a.user_id WHERE ${where}`, params),
    query(`${SELECT} WHERE ${where} ORDER BY a.created_at DESC, a.id DESC LIMIT ${limit} OFFSET ${offset}`, params),
  ]);
  res.setHeader('Cache-Control', 'no-store');
  res.json({ total: total[0]?.n ?? 0, limit, offset, items });
}));

auditRouter.get('/facets', asyncHandler(async (req, res) => {
  const acc = accountId(req);
  const [actions, types, users] = await Promise.all([
    query(`SELECT action, count(*)::int AS n FROM audit_log WHERE account_id = $1 GROUP BY 1 ORDER BY 2 DESC`, [acc]),
    query(`SELECT entity_type, count(*)::int AS n FROM audit_log WHERE account_id = $1 AND entity_type IS NOT NULL GROUP BY 1 ORDER BY 1`, [acc]),
    query(`SELECT a.user_id, u.email, count(*)::int AS n FROM audit_log a JOIN users u ON u.id = a.user_id
            WHERE a.account_id = $1 GROUP BY 1, 2 ORDER BY u.email`, [acc]),
  ]);
  res.setHeader('Cache-Control', 'no-store');
  res.json({ actions, entityTypes: types, users });
}));

function csvCell(v: unknown): string {
  if (v === null || v === undefined) return '';
  let s = v instanceof Date ? v.toISOString() : typeof v === 'object' ? JSON.stringify(v) : String(v);
  // a cell a spreadsheet would run as a formula is quoted as text
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

auditRouter.get('/export.csv', asyncHandler(async (req, res) => {
  const { where, params } = filters(req);
  const r = await query<any>(`${SELECT} WHERE ${where} ORDER BY a.created_at DESC, a.id DESC LIMIT 50000`, params);
  const cols = ['created_at', 'action', 'entity_type', 'entity_id', 'name', 'user_email', 'actor', 'detail'];
  const lines = [cols.join(',')].concat(r.map((row: any) => cols.map((c) => csvCell(row[c])).join(',')));
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="audit-log-${new Date().toISOString().slice(0, 10)}.csv"`);
  res.setHeader('Cache-Control', 'no-store');
  res.send(lines.join('\r\n') + '\r\n');
}));
