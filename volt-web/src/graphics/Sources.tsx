// Data sources: JSON or RSS feeds Volt polls, and push sources a customer's
// system sends to. Setups read values from them by path.
import { useState } from 'react'
import { Notice, useNotify } from '../notices'
import { ConfirmDialog } from '../listActions'
import { gfx, type DataSource } from './gfxApi'

export function SourcesTab({ sources, canManage, onChanged }: { sources: DataSource[] | null; canManage: boolean; onChanged: () => void }) {
  const notify = useNotify()
  const [edit, setEdit] = useState<Partial<DataSource> | null>(null)
  const [test, setTest] = useState<{ id: string; text: string; ok: boolean } | null>(null)
  const [confirm, setConfirm] = useState<DataSource | null>(null)
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  if (!sources) return <div className="loading">Loading…</div>
  const save = async () => {
    if (!edit) return
    setErr(''); setBusy(true)
    try {
      if (edit.id) await gfx.patchSource(edit.id, { name: edit.name, url: edit.url ?? undefined, everySec: edit.everySec, onStale: edit.onStale, staleAfterSec: edit.staleAfterSec })
      else await gfx.createSource({ name: edit.name ?? '', kind: edit.kind ?? 'json', url: edit.kind === 'push' ? null : edit.url, everySec: edit.everySec, onStale: edit.onStale, staleAfterSec: edit.staleAfterSec })
      setEdit(null); onChanged(); notify({ kind: 'ok', message: 'Data source saved.' })
    } catch (e: any) { setErr(e.message) } finally { setBusy(false) }
  }
  const runTest = async (s: DataSource) => {
    setTest({ id: s.id, text: 'Fetching…', ok: true })
    try {
      const r = await gfx.testSource(s.id)
      setTest({ id: s.id, ok: r.ok, text: r.ok ? JSON.stringify(r.payload, null, 2).slice(0, 4000) : (r.error ?? 'Failed') }); onChanged()
    } catch (e: any) { setTest({ id: s.id, ok: false, text: e.message }) }
  }
  const status = (s: DataSource) => s.status === 'ok' ? <span className="tag live">OK</span> : s.status === 'stale' ? <span className="tag warn">Stale</span>
    : s.status === 'error' ? <span className="tag down" title={s.lastError ?? ''}>Error</span> : <span className="tag idle">Waiting</span>
  return (
    <>
      <div className="gfx-toolbar">
        <p className="gfx-meta" style={{ margin: 0, flex: '1 1 380px' }}>Feeds that fill graphics: scores, tickers, results. Volt only polls a source while something that reads it is live.</p>
        {canManage && <button className="btn ghost" onClick={() => setEdit({ kind: 'json', everySec: 5, onStale: 'hold', staleAfterSec: 60 })}>Add data source</button>}
      </div>
      {sources.length === 0 ? <div className="empty"><h3>No data sources yet</h3><p>Add a JSON or RSS URL, or a push source your system sends to.</p></div> : (
        <div className="card" style={{ overflowX: 'auto' }}>
          <table className="tbl">
            <thead><tr><th>Name</th><th>Kind</th><th>Where</th><th>Every</th><th>If it stops</th><th>Status</th><th /></tr></thead>
            <tbody>{sources.map((s) => (
              <tr key={s.id}>
                <td style={{ fontWeight: 600 }}>{s.name}</td>
                <td><span className="tag type">{s.kind === 'json' ? 'JSON' : s.kind === 'rss' ? 'RSS' : 'Push'}</span></td>
                <td style={{ maxWidth: 320, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontFamily: 'ui-monospace,Menlo,monospace', fontSize: 'var(--fs-sm)' }}>
                  {s.kind === 'push' ? `POST /api/graphics/sources/${s.id}/push` : s.url}</td>
                <td>{s.kind === 'push' ? '–' : `${s.everySec} s`}</td>
                <td>{s.onStale === 'hide' ? 'Hide the graphic' : 'Keep last values'}</td>
                <td>{status(s)}{s.lastOkAt && <div className="gfx-meta">{new Date(s.lastOkAt).toLocaleTimeString()}</div>}</td>
                <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                  <button className="btn ghost sm" onClick={() => runTest(s)}>{s.kind === 'push' ? 'Last payload' : 'Test now'}</button>{' '}
                  {canManage && <><button className="btn ghost sm" onClick={() => setEdit(s)}>Edit</button>{' '}
                    <button className="btn ghost sm" onClick={() => setConfirm(s)}>Remove</button></>}
                </td>
              </tr>))}</tbody>
          </table>
        </div>
      )}
      {test && (
        <div className="card card-b" style={{ marginTop: 14 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}><b>{test.ok ? 'What the source sent' : 'The source could not be read'}</b><div style={{ flex: 1 }} />
            <button className="btn ghost sm" onClick={() => setTest(null)}>Close</button></div>
          <pre className="gfx-code" style={{ minHeight: 0, maxHeight: 360, overflow: 'auto', color: test.ok ? undefined : 'var(--down)' }}>{test.text}</pre>
          {test.ok && <div className="gfx-meta" style={{ marginTop: 6 }}>Use a dotted path in a setup to pick a value, for example score.home or items.0.title.</div>}
        </div>
      )}
      {edit && (
        <div className="drawer-scrim" onClick={() => setEdit(null)}>
          <div className="drawer" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Data source">
            <div className="drawer-h"><div className="t">{edit.id ? 'Edit data source' : 'New data source'}</div><button className="xbtn" aria-label="Close" onClick={() => setEdit(null)}>✕</button></div>
            <div className="drawer-b">
              <div className="field"><label htmlFor="ds-name">Name</label><input id="ds-name" className="inp" value={edit.name ?? ''} onChange={(e) => setEdit({ ...edit, name: e.target.value })} /></div>
              {!edit.id && <div className="field"><label>Kind</label>
                <div className="seg-choice" role="group">{(['json', 'rss', 'push'] as const).map((k) => <button key={k} type="button" className={edit.kind === k ? 'sel' : ''}
                  onClick={() => setEdit({ ...edit, kind: k, everySec: k === 'rss' ? 60 : 5 })}>{k === 'json' ? 'JSON URL' : k === 'rss' ? 'RSS or Atom' : 'Pushed to Volt'}</button>)}</div></div>}
              {edit.kind !== 'push' ? <>
                <div className="field"><label htmlFor="ds-url">URL</label><input id="ds-url" className="inp" placeholder="https://" value={edit.url ?? ''} onChange={(e) => setEdit({ ...edit, url: e.target.value })} /></div>
                <div className="field"><label htmlFor="ds-every">Check every (seconds)</label><input id="ds-every" className="inp" type="number" min={1} max={3600} value={edit.everySec ?? 5} onChange={(e) => setEdit({ ...edit, everySec: Number(e.target.value) })} /></div>
                <div className="field"><label htmlFor="ds-stale">Stale after (seconds without an answer)</label><input id="ds-stale" className="inp" type="number" min={5} value={edit.staleAfterSec ?? 60} onChange={(e) => setEdit({ ...edit, staleAfterSec: Number(e.target.value) })} /></div>
                <div className="field"><label htmlFor="ds-on">If it goes stale</label><select id="ds-on" className="inp" value={edit.onStale ?? 'hold'} onChange={(e) => setEdit({ ...edit, onStale: e.target.value as any })}>
                  <option value="hold">Keep the last values on screen</option><option value="hide">Hide the graphics that read it</option></select></div>
              </> : <p className="gfx-meta">Your system sends JSON to Volt with an API key: <code>POST /api/graphics/sources/&lt;id&gt;/push</code>. Each push replaces the last payload and fires any rundown cues waiting on it.</p>}
            </div>
            <div className="drawer-f">
              {err && <div className="drawer-f-err"><Notice kind="error" variant="compact" message={err} /></div>}
              <button className="btn ghost" onClick={() => setEdit(null)}>Cancel</button>
              <button className="btn primary" disabled={busy || !edit.name} onClick={save}>{busy ? 'Saving…' : 'Save'}</button>
            </div>
          </div>
        </div>
      )}
      {confirm && <ConfirmDialog danger title={`Remove ${confirm.name}?`} body="A source that setups still read cannot be removed." confirmLabel="Remove"
        onCancel={() => setConfirm(null)} onConfirm={async () => { const s = confirm; setConfirm(null); try { await gfx.deleteSource(s.id); onChanged() } catch (e: any) { notify({ kind: 'error', message: e.message }) } }} />}
    </>
  )
}
