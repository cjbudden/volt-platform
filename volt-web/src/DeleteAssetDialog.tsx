// ============================================================================
//  DELETE A MEDIA LIBRARY ASSET (the asset form's Delete).
//
//  The same workflow as removing a channel or station (DeleteChannelDialog):
//  before anything goes the dialog shows what will, refuses up front when the
//  asset cannot go now (it is in an active FAST lineup), and asks for the title
//  to be typed. Unlike a channel, nothing is destroyed at once: the record and
//  its media go to the restore bin (Storage > Recently removed) for the bin's
//  days, and the page offers Undo straight after. The server checks the blocker
//  again, and the delete is in the audit log.
// ============================================================================
import { useEffect, useState } from 'react'
import { api, type AssetDeleteImpact } from './api'
import { FormStatus } from './notices'

const plural = (n: number, one: string, many = one + 's') => `${n} ${n === 1 ? one : many}`

export interface DeletedAsset { id: string; title: string; binDays: number; purgeAfter: string | null }

export default function DeleteAssetDialog({ id, onClose, onDeleted }: { id: string; onClose: () => void; onDeleted: (a: DeletedAsset) => void }) {
  const [impact, setImpact] = useState<AssetDeleteImpact | null>(null)
  const [typed, setTyped] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')

  useEffect(() => {
    api.vodDeleteImpact(id).then(setImpact).catch((e: any) =>
      setErr(e?.forbidden ? 'Your role cannot delete assets.' : (e?.message || 'Could not check what this would delete')))
  }, [id])

  const matches = !!impact && typed.trim() === impact.name.trim()

  async function go() {
    if (!impact || !matches || impact.blocker) return
    setBusy(true); setErr('')
    try {
      const r = await api.deleteVod(id)
      onDeleted({ id, title: impact.name, binDays: r.binDays, purgeAfter: r.purgeAfter })
    } catch (e: any) {
      setErr(e?.forbidden ? 'Your role cannot delete assets.' : (e?.message || 'The delete failed'))
      // the state may have moved on (it went into a lineup): show the current blocker
      api.vodDeleteImpact(id).then(setImpact).catch(() => {})
    } finally { setBusy(false) }
  }

  const c = impact?.counts
  const lines = c ? [
    'its metadata and media files (renditions, and the source when it was uploaded)',
    c.markers ? plural(c.markers, 'skip marker') : null,
    c.formats ? plural(c.formats, 'social format') : null,
    c.reviews ? plural(c.reviews, 'review') : null,
    c.publishing_points ? `${plural(c.publishing_points, 'publishing point')} (portal and apps stop serving it)` : null,
  ].filter(Boolean) as string[] : []
  const live = impact?.availability === 'available' || impact?.availability === 'scheduled'

  return (
    // Plain click handlers, not pressable(): the dialog holds a text input, and
    // a button role on its parents would turn Space into "close" while typing.
    <div className="drawer-scrim" onClick={e => { if (e.target === e.currentTarget && !busy) onClose() }} style={{ alignItems: 'center', justifyContent: 'center' }}>
      <div className="card" role="dialog" aria-modal="true" aria-labelledby="delas-t"
        onKeyDown={e => { if (e.key === 'Escape' && !busy) onClose() }}
        style={{ width: 460, maxWidth: 'calc(100vw - 32px)', padding: 20 }}>
        <h3 id="delas-t" style={{ margin: '0 0 8px' }}>Delete {impact ? `asset ${impact.name}` : 'asset'}?</h3>
        {!impact && !err && <div className="loading">Checking what this would delete…</div>}
        {impact && (
          <>
            <p style={{ color: 'var(--muted)', fontSize: 'var(--fs-body)', margin: '0 0 10px' }}>
              {live ? <>It is <b>{impact.availability === 'scheduled' ? 'scheduled for viewers' : 'available to viewers'}</b> and will stop playing. </> : null}
              These go with it:
            </p>
            <ul style={{ margin: '0 0 12px', paddingLeft: 18, fontSize: 'var(--fs-body)' }}>
              {lines.map(l => <li key={l}>{l}</li>)}
            </ul>
            <p style={{ color: 'var(--muted)', fontSize: 'var(--fs-body)', margin: '0 0 12px' }}>
              It goes to <b>Storage &gt; Recently removed</b> for {plural(impact.binDays, 'day')}, where it can be restored. After that it is gone for good.
              {c?.social_posts ? <> {plural(c.social_posts, 'post')} already on social platforms stay there; take them down first if they should go too.</> : null}
            </p>
            {impact.blocker ? null : (
              <div className="field" style={{ marginBottom: 0 }}>
                <label htmlFor="delas-name">Type <b>{impact.name}</b> to confirm</label>
                <input id="delas-name" className="inp" autoFocus value={typed} onChange={e => setTyped(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter') go() }} autoComplete="off" spellCheck={false} />
              </div>
            )}
            <p style={{ color: 'var(--faint)', fontSize: 'var(--fs-sm)', margin: '10px 0 0' }}>The delete is recorded in the audit log with your name.</p>
          </>
        )}
        {/* FORM status in the footer (notices.tsx): the failure, else why Delete is unavailable */}
        <div className="modal-f">
          <FormStatus error={err} blocked={impact?.blocker} />
          <button className="btn ghost" onClick={onClose} disabled={busy}>Cancel</button>
          <button className="btn primary danger" disabled={busy || !matches || !!impact?.blocker} onClick={go}>
            {busy ? 'Deleting…' : 'Delete asset'}
          </button>
        </div>
      </div>
    </div>
  )
}
