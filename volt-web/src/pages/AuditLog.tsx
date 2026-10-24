// ============================================================================
//  AUDIT LOG (Admin > Audit log). Administrators only.
//
//  Who did what and when in this account: every create, change and delete the
//  API records, and every delete that was refused with the reason. Filter by
//  action, kind of thing, person, dates and free text; open a row for the full
//  detail; export what is filtered as CSV. Served by /api/audit (modules/audit.ts).
// ============================================================================
import { Fragment, useEffect, useMemo, useState } from 'react'
import { api, type AuditFacets, type AuditQuery, type AuditRow } from '../api'
import { PageHead, FChip } from '../scaffold'
import { usePageNotice, useNotify } from '../notices'

const PAGE = 50
const ACTION_LABEL: Record<string, string> = {
  create: 'Created', update: 'Changed', delete: 'Deleted', delete_refused: 'Delete refused',
}
const actionLabel = (a: string) => ACTION_LABEL[a] ?? a.replace(/_/g, ' ').replace(/^./, c => c.toUpperCase())
const typeLabel = (t: string | null) => (t ?? 'unknown').replace(/_/g, ' ')
const actionCls = (a: string) => a === 'delete' ? 'down' : a === 'delete_refused' ? 'warn' : a === 'create' ? 'live' : 'idle'

function fmtWhen(iso: string) {
  const d = new Date(iso)
  return d.toLocaleString(undefined, { year: 'numeric', month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

/** A one-line summary of the row's detail: the reason, or which fields changed. */
function summary(r: AuditRow): string {
  const d = r.detail ?? {}
  if (r.action === 'delete_refused') return d.reason ? `Refused (${d.status}): ${d.reason}` : `Refused (${d.status})`
  if (d.changes && typeof d.changes === 'object') {
    const keys = Object.keys(d.changes)
    return keys.length ? `Changed ${keys.slice(0, 4).join(', ')}${keys.length > 4 ? ` and ${keys.length - 4} more` : ''}` : ''
  }
  if (r.action === 'delete') {
    const rm = d.snapshot?.removed
    if (rm && typeof rm === 'object') {
      const parts = Object.entries(rm).filter(([, n]) => Number(n) > 0).map(([k, n]) => `${n} ${k.replace(/_/g, ' ')}`)
      if (parts.length) return `Removed with it: ${parts.join(', ')}`
    }
    if (d.logged_by === 'request') return `DELETE ${d.path ?? ''}`
  }
  return ''
}

export default function AuditLog() {
  const [facets, setFacets] = useState<AuditFacets | null>(null)
  const [action, setAction] = useState('')
  const [etype, setEtype] = useState('')
  const [userId, setUserId] = useState('')
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [qText, setQText] = useState('')
  const [q, setQ] = useState('')
  const [offset, setOffset] = useState(0)
  const [rows, setRows] = useState<AuditRow[] | null>(null)
  const [total, setTotal] = useState(0)
  const [open, setOpen] = useState<string | null>(null)
  const [err, setErr] = useState('')
  const [exporting, setExporting] = useState(false)

  // typing searches after a pause, not on every key
  useEffect(() => { const t = setTimeout(() => { setQ(qText.trim()); setOffset(0) }, 350); return () => clearTimeout(t) }, [qText])

  const filter: AuditQuery = useMemo(() => ({
    action: action || undefined, entityType: etype || undefined, userId: userId || undefined, q: q || undefined,
    // dates are the local day: from its start, to the end of the "to" day
    from: from ? new Date(`${from}T00:00:00`).toISOString() : undefined,
    to: to ? new Date(new Date(`${to}T00:00:00`).getTime() + 86400_000).toISOString() : undefined,
  }), [action, etype, userId, q, from, to])

  useEffect(() => { api.auditFacets().then(setFacets).catch(() => {}) }, [])
  useEffect(() => {
    let gone = false
    setErr('')
    api.audit({ ...filter, limit: PAGE, offset })
      .then(r => { if (!gone) { setRows(r.items); setTotal(r.total) } })
      .catch((e: any) => { if (!gone) setErr(e?.forbidden ? 'The audit log is for administrators.' : (e?.message || 'Could not load the audit log')) })
    return () => { gone = true }
  }, [filter, offset])

  usePageNotice('load', err ? { kind: 'error', title: "Couldn't load the audit log.", message: err, onDismiss: () => setErr('') } : null)
  const notify = useNotify()
  const set = <T,>(fn: (v: T) => void) => (v: T) => { fn(v); setOffset(0) }
  const n = (a: string) => facets?.actions.find(x => x.action === a)?.n ?? 0
  const clear = () => { setAction(''); setEtype(''); setUserId(''); setFrom(''); setTo(''); setQText(''); setQ(''); setOffset(0) }
  const filtered = !!(action || etype || userId || from || to || q)

  async function exportCsv() {
    setExporting(true)
    try { await api.downloadAuditCsv(filter) } catch (e: any) { notify({ kind: 'error', title: 'Export failed.', message: e?.message || '' }) } finally { setExporting(false) }
  }

  return (
    <>
      <PageHead title="Audit log" sub="Who changed what, and when. Every delete is here, including deletes that were refused and why."
        action={<button className="btn ghost" onClick={exportCsv} disabled={exporting || !total}>{exporting ? 'Exporting…' : 'Export CSV'}</button>} />

      <div className="filters">
        <FChip label="All" n={facets?.actions.reduce((s, a) => s + a.n, 0) ?? 0} on={!action} onClick={() => set(setAction)('')} />
        <FChip label="Deleted" n={n('delete')} on={action === 'delete'} onClick={() => set(setAction)('delete')} />
        <FChip label="Delete refused" n={n('delete_refused')} on={action === 'delete_refused'} onClick={() => set(setAction)('delete_refused')} />
        <FChip label="Changed" n={n('update')} on={action === 'update'} onClick={() => set(setAction)('update')} />
        <FChip label="Created" n={n('create')} on={action === 'create'} onClick={() => set(setAction)('create')} />
      </div>
      <div className="audit-filters">
        <input className="inp" placeholder="Search names, people, reasons…" value={qText} onChange={e => setQText(e.target.value)} aria-label="Search the audit log" />
        <select className="inp" value={etype} onChange={e => set(setEtype)(e.target.value)} aria-label="Kind of thing">
          <option value="">Everything</option>
          {facets?.entityTypes.map(t => <option key={t.entity_type} value={t.entity_type}>{typeLabel(t.entity_type)} ({t.n})</option>)}
        </select>
        <select className="inp" value={userId} onChange={e => set(setUserId)(e.target.value)} aria-label="Person">
          <option value="">Anyone</option>
          {facets?.users.map(u => <option key={u.user_id} value={u.user_id}>{u.email}</option>)}
        </select>
        <label className="audit-date">From <input className="inp" type="date" value={from} onChange={e => set(setFrom)(e.target.value)} /></label>
        <label className="audit-date">To <input className="inp" type="date" value={to} onChange={e => set(setTo)(e.target.value)} /></label>
        {filtered && <button className="btn ghost" onClick={clear}>Clear</button>}
      </div>


      {rows === null ? (err ? null : <div className="loading">Loading the audit log…</div>) : rows.length === 0 ? (
        <div className="empty"><h3>{filtered ? 'Nothing matches these filters' : 'Nothing recorded yet'}</h3>
          <p>{filtered ? 'Try a wider date range or clear the filters.' : 'Creates, changes and deletes appear here as they happen.'}</p></div>
      ) : (
        <div className="card audit-card">
          <table className="audit-table">
            <thead><tr><th>When</th><th>Who</th><th>Action</th><th>What</th><th>Detail</th></tr></thead>
            <tbody>
              {rows.map(r => (
                <Fragment key={r.id}>
                  <tr className="audit-row" onClick={() => setOpen(open === r.id ? null : r.id)} aria-expanded={open === r.id}
                    tabIndex={0} onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setOpen(open === r.id ? null : r.id) } }}>
                    <td className="nowrap">{fmtWhen(r.created_at)}</td>
                    <td>{r.user_email ?? r.actor ?? 'system'}</td>
                    <td><span className={`tag ${actionCls(r.action)}`}>{actionLabel(r.action)}</span></td>
                    <td><span className="audit-type">{typeLabel(r.entity_type)}</span>{' '}{r.name ? <b>{r.name}</b> : r.entity_id ? <code>{r.entity_id.slice(0, 8)}</code> : null}</td>
                    <td className="audit-sum">{summary(r)}</td>
                  </tr>
                  {open === r.id && (
                    <tr className="audit-detail"><td colSpan={5}>
                      <div className="audit-kv">
                        <span>Entity id</span><code>{r.entity_id ?? '—'}</code>
                        <span>Recorded</span><span>{new Date(r.created_at).toISOString()}</span>
                      </div>
                      <pre>{JSON.stringify(r.detail ?? {}, null, 2)}</pre>
                    </td></tr>
                  )}
                </Fragment>
              ))}
            </tbody>
          </table>
          <div className="audit-pager">
            <span>{offset + 1}–{Math.min(offset + rows.length, total)} of {total}</span>
            <button className="btn ghost" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE))}>Newer</button>
            <button className="btn ghost" disabled={offset + rows.length >= total} onClick={() => setOffset(offset + PAGE)}>Older</button>
          </div>
        </div>
      )}
    </>
  )
}
