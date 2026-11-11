// ============================================================================
//  BULK ACTIONS WAITING FOR A MANAGER (Account settings > Bulk actions).
//
//  Shown above the Media Library while any wait. An administrator or owner
//  sees every request with its list and Approve / Reject; approving runs it
//  there and then, on the items as they are now. Everyone else sees their own
//  requests waiting, and can withdraw them. Nobody approves their own.
// ============================================================================
import { useCallback, useEffect, useState } from 'react'
import { api, type BulkRequest } from './api'
import { useNotify } from './notices'

const when = (iso: string) => new Date(iso).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })

export function BulkRequests({ onChanged }: { onChanged: () => void }) {
  const notify = useNotify()
  const [data, setData] = useState<{ requests: BulkRequest[]; canDecide: boolean; me: string | null } | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [open, setOpen] = useState<string | null>(null)
  const load = useCallback(() => { api.bulkRequests(true).then(setData).catch(() => setData(null)) }, [])
  useEffect(() => { load(); const t = setInterval(load, 60_000); return () => clearInterval(t) }, [load])
  if (!data) return null
  const mine = data.requests.filter(r => r.requestedById && r.requestedById === data.me)
  const shown = data.canDecide ? data.requests : mine
  if (!shown.length) return null

  async function decide(r: BulkRequest, approve: boolean) {
    let note: string | undefined
    if (!approve) { const n = window.prompt(`Reject the request to ${r.label.toLowerCase()} (${r.count})? A reason for ${r.requestedBy ?? 'them'} (optional):`, ''); if (n === null) return; note = n }
    setBusy(r.id)
    try {
      const res = await api.decideBulkRequest(r.id, approve, note)
      if (approve && res.outcome) {
        const o = res.outcome
        notify({ id: `bulkreq-${r.id}`, kind: o.refused.length ? 'warn' : 'ok', autoHideMs: o.refused.length ? undefined : 30000,
          title: `Approved: ${o.done.length} of ${r.count} removed.`,
          message: o.refused.length ? `Left out: ${o.refused.map(x => `${x.name} (${x.why})`).join('; ')}` : 'They are in Storage > Recently removed, and can be restored from there.',
          actions: o.done.length ? [{ label: 'Undo', onClick: async () => {
            try { const b = await api.vodBulkRestore(o.done.map(x => x.id)); onChanged(); notify({ id: `bulkreq-${r.id}`, kind: 'ok', message: `${b.restored.length} restored.` }) }
            catch (e: any) { notify({ id: `bulkreq-${r.id}`, kind: 'error', message: e.message }) }
          } }] : undefined })
        onChanged()
      } else notify({ kind: 'ok', message: `Rejected. Nothing was removed.` })
    } catch (e: any) { notify({ kind: 'error', title: "Couldn't decide the request.", message: e.message }) }
    finally { setBusy(null); load() }
  }
  async function withdraw(r: BulkRequest) {
    setBusy(r.id)
    try { await api.cancelBulkRequest(r.id); notify({ kind: 'ok', message: 'Request withdrawn.' }) }
    catch (e: any) { notify({ kind: 'error', message: e.message }) } finally { setBusy(null); load() }
  }

  return (
    <div className="card" role="region" aria-label="Bulk actions waiting for approval" style={{ padding: '10px 14px', margin: '0 0 12px' }}>
      <div className="sec-label" style={{ marginTop: 0 }}>{data.canDecide ? 'Waiting for your approval' : 'Your requests waiting for approval'}</div>
      {shown.map(r => {
        const own = r.requestedById === data.me
        return (
          <div key={r.id} style={{ padding: '8px 0', borderTop: '1px solid var(--border)' }}>
            <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
              <div style={{ flex: '1 1 260px', minWidth: 0 }}>
                <b>{r.label}: {r.count} {r.count === 1 ? 'asset' : 'assets'}</b>
                <div className="hintxt" style={{ marginTop: 2 }}>
                  {own ? 'You asked' : `${r.requestedBy ?? 'Someone'} asked`} {when(r.createdAt)}{r.note ? `: "${r.note}"` : ''} · expires {when(r.expiresAt)}
                </div>
              </div>
              <button className="btn ghost" onClick={() => setOpen(open === r.id ? null : r.id)} aria-expanded={open === r.id}>{open === r.id ? 'Hide list' : 'See list'}</button>
              {data.canDecide && !own && <>
                <button className="btn ghost" disabled={busy === r.id} onClick={() => decide(r, false)}>Reject</button>
                <button className="btn primary danger" disabled={busy === r.id} onClick={() => decide(r, true)}>{busy === r.id ? 'Working…' : 'Approve and remove'}</button>
              </>}
              {own && <button className="btn ghost" disabled={busy === r.id} onClick={() => withdraw(r)}>Withdraw</button>}
            </div>
            {open === r.id && <ul style={{ margin: '6px 0 0', paddingLeft: 18, maxHeight: 200, overflow: 'auto', fontSize: 'var(--fs-body)' }}>{r.items.map(i => <li key={i.id}>{i.name}</li>)}</ul>}
            {data.canDecide && own && <div className="hintxt" style={{ marginTop: 4 }}>Another administrator or owner approves your own request.</div>}
          </div>
        )
      })}
    </div>
  )
}
