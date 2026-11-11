// ============================================================================
//  REMOVE SELECTED ASSETS (the Media Library bulk bar's Remove).
//
//  The single delete's workflow for many at once (DeleteAssetDialog): before
//  anything goes the dialog lists what will, and which cannot go now and why
//  (in an active FAST lineup); those are left out. The person types how many
//  will go to confirm, and the server checks that number again. Everything
//  removed goes to the restore bin (Storage > Recently removed) for the bin's
//  days, and the page offers Undo straight after.
//
//  When the account wants a manager to confirm bulk actions (Account settings),
//  the same dialog sends a request instead and says so: nothing is removed
//  until an administrator or owner approves it.
// ============================================================================
import { useEffect, useState } from 'react'
import { api, type BulkImpact, type BulkRemoveResult } from './api'
import { FormStatus } from './notices'

const plural = (n: number, one: string, many = one + 's') => `${n} ${n === 1 ? one : many}`

export default function BulkRemoveDialog({ ids, onClose, onDone }: {
  ids: string[]; onClose: () => void; onDone: (r: BulkRemoveResult, sent: string[]) => void
}) {
  const [impact, setImpact] = useState<BulkImpact | null>(null)
  const [typed, setTyped] = useState('')
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  useEffect(() => {
    api.vodBulkRemoveImpact(ids).then(setImpact).catch((e: any) => setErr(e?.forbidden ? 'Your role cannot remove assets.' : (e?.message || 'Could not check what this would remove')))
  }, [ids])

  const ready = impact?.items.filter(i => !i.blocker) ?? []
  const blocked = impact?.items.filter(i => i.blocker) ?? []
  const matches = !!ready.length && typed.trim() === String(ready.length)
  const asks = !!impact?.needsApproval

  async function go() {
    if (!matches) return
    setBusy(true); setErr('')
    try { const sent = ready.map(i => i.id); onDone(await api.vodBulkRemove(sent, sent.length, note), sent) }
    catch (e: any) {
      setErr(e?.forbidden ? 'Your role cannot remove assets.' : (e?.message || 'The remove failed'))
      api.vodBulkRemoveImpact(ids).then(setImpact).catch(() => {})
    } finally { setBusy(false) }
  }

  return (
    <div className="drawer-scrim" onClick={e => { if (e.target === e.currentTarget && !busy) onClose() }} style={{ alignItems: 'center', justifyContent: 'center' }}>
      <div className="card" role="dialog" aria-modal="true" aria-labelledby="bulkrm-t"
        onKeyDown={e => { if (e.key === 'Escape' && !busy) onClose() }}
        style={{ width: 520, maxWidth: 'calc(100vw - 32px)', maxHeight: 'calc(100vh - 48px)', overflow: 'auto', padding: 20 }}>
        <h3 id="bulkrm-t" style={{ margin: '0 0 8px' }}>{asks ? 'Ask to remove' : 'Remove'} {plural(ids.length, 'asset')}?</h3>
        {!impact && !err && <div className="loading">Checking what this would remove…</div>}
        {impact && (
          <>
            <p style={{ color: 'var(--muted)', fontSize: 'var(--fs-body)', margin: '0 0 10px' }}>
              {ready.length ? <>Each one goes with its metadata and media files: the HLS and DASH renditions, FAST channel copies, social formats,
                preview images, subtitles, and the source when it was uploaded. Anything published stops playing.</> : 'None of these can be removed now.'}
            </p>
            {ready.length > 0 && (
              <details style={{ margin: '0 0 10px', fontSize: 'var(--fs-body)' }}>
                <summary style={{ cursor: 'pointer' }}>{plural(ready.length, 'asset')} {asks ? 'in the request' : 'will be removed'}</summary>
                <ul style={{ margin: '6px 0 0', paddingLeft: 18, maxHeight: 180, overflow: 'auto' }}>{ready.map(i => <li key={i.id}>{i.name}</li>)}</ul>
              </details>
            )}
            {blocked.length > 0 && (
              <div role="note" style={{ margin: '0 0 10px', padding: '8px 10px', borderRadius: 8, fontSize: 'var(--fs-body)',
                background: 'color-mix(in srgb, var(--warn, #d97706) 12%, transparent)', border: '1px solid color-mix(in srgb, var(--warn, #d97706) 40%, transparent)' }}>
                <b>{plural(blocked.length, 'asset')} left out:</b>
                <ul style={{ margin: '4px 0 0', paddingLeft: 18 }}>{blocked.map(i => <li key={i.id}>{i.name}: {i.blocker}</li>)}</ul>
              </div>
            )}
            {ready.length > 0 && (
              <p style={{ color: 'var(--muted)', fontSize: 'var(--fs-body)', margin: '0 0 12px' }}>
                {asks
                  ? <>Your account asks an administrator or owner to confirm bulk actions. <b>Nothing is removed until one approves it.</b> After that, the assets
                    go to <b>Storage &gt; Recently removed</b> for a short time, where they can be restored.</>
                  : <>They go to <b>Storage &gt; Recently removed</b>, where they can be restored for a short time. After that they are gone for good.</>}
              </p>
            )}
            {ready.length > 0 && asks && (
              <div className="field">
                <label htmlFor="bulkrm-note">Note for the approver (optional)</label>
                <input id="bulkrm-note" className="inp" value={note} maxLength={500} onChange={e => setNote(e.target.value)} placeholder="Why these should go" />
              </div>
            )}
            {ready.length > 0 && (
              <div className="field" style={{ marginBottom: 0 }}>
                <label htmlFor="bulkrm-n">Type <b>{ready.length}</b> to confirm</label>
                <input id="bulkrm-n" className="inp" inputMode="numeric" autoFocus value={typed} onChange={e => setTyped(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter') go() }} autoComplete="off" />
              </div>
            )}
          </>
        )}
        <p style={{ color: 'var(--faint)', fontSize: 'var(--fs-sm)', margin: '10px 0 0' }}>{asks ? 'The request and its decision are' : 'Each removal is'} recorded in the audit log with your name.</p>
        <div className="modal-f">
          <FormStatus error={err} blocked={impact && !ready.length ? 'None of the selected assets can be removed now.' : undefined} />
          <button className="btn ghost" onClick={onClose} disabled={busy}>Cancel</button>
          <button className="btn primary danger" onClick={go} disabled={busy || !matches}>
            {busy ? (asks ? 'Sending…' : 'Removing…') : asks ? `Send for approval (${ready.length})` : `Remove ${plural(ready.length, 'asset')}`}
          </button>
        </div>
      </div>
    </div>
  )
}
