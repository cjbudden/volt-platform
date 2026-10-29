// ============================================================================
//  INGEST QUEUE: the drawer that follows the operator around the console.
//
//  Uploads are a module-level singleton (uploadManager.ts), so this drawer
//  can be mounted once in App and show every transfer wherever the operator
//  is. Per file: thumbnail, name, size, progress, pause / resume / cancel.
//  Bottom: the total, the rate and the time left. Held items (the metadata
//  gate, duplicates) sit in the same drawer under "Needs you", because the
//  question "where did my file go" has one answer.
// ============================================================================
import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { api, type IngestHeld, type IngestTransfer } from './api'
import { subscribe, cancel, pause, resume, retryFailed, clearFinished, type UploadItem } from './uploadManager'
import { MetadataForm } from './ContentTypeFields'
import { announceAssetsChanged } from './assetEvents'
import { fmtBytes, label } from './IngestPanel'
import './ingest.css'

export function IngestQueue() {
  const [items, setItems] = useState<UploadItem[]>([])
  const [held, setHeld] = useState<IngestHeld[]>([])
  const [transfers, setTransfers] = useState<IngestTransfer[]>([])
  const [open, setOpen] = useState(false)
  const [fill, setFill] = useState<string | null>(null)
  const [meta, setMeta] = useState<Record<string, any>>({})
  const [err, setErr] = useState('')
  const loadHeld = () => api.ingestHeld().then(setHeld).catch(() => {})
  useEffect(() => subscribe(all => { setItems(all); if (all.some(i => i.status === 'done')) loadHeld() }), [])
  useEffect(() => { loadHeld(); const t = setInterval(() => { loadHeld(); api.ingestTransfers().then(ts => setTransfers(ts.filter(x => x.state !== 'landed'))).catch(() => {}) }, 20000); return () => clearInterval(t) }, [])

  const active = items.filter(i => ['queued', 'uploading', 'assembling', 'background', 'paused'].includes(i.status))
  const failed = items.filter(i => i.status === 'error')
  const done = items.filter(i => i.status === 'done')
  const sent = active.reduce((a, i) => a + i.sentBytes, 0), tot = active.reduce((a, i) => a + i.totalBytes, 0)
  const rate = active.reduce((a, i) => a + (i.rate ?? 0), 0)
  const eta = rate > 0 ? Math.round((tot - sent) / rate) : null
  const pct = tot ? Math.round((sent / tot) * 100) : 0
  const count = active.length + held.length + failed.length + transfers.length
  if (!count && !open) return null

  // `id`: the asset the action changed, announced so an open Media Library refreshes its card (assetEvents.ts)
  const act = async (fn: () => Promise<any>, id?: string) => { setErr(''); try { await fn(); setFill(null); setMeta({}); loadHeld(); announceAssetsChanged([id]) } catch (e: any) { setErr(String(e?.message ?? e)) } }

  return (
    <>
      {count > 0 && (
        <button type="button" aria-expanded={open} className={`iq-fab${held.length && !active.length ? ' warn' : ''}${failed.length && !active.length && !held.length ? ' bad' : ''}`} onClick={() => setOpen(o => !o)} style={{ ['--p' as any]: `${pct}%` }}
          title={[active.length && `Uploading ${active.length} file${active.length === 1 ? '' : 's'}, ${pct}%`, held.length && `${held.length} waiting on you in the ingest queue`,
            failed.length && `${failed.length} failed`, transfers.length && `${transfers.length} accelerated transfer${transfers.length === 1 ? '' : 's'}`].filter(Boolean).join(' · ')}
          aria-label="Open the ingest queue">
          <span className="ring" />
          <span className="lbl">{active.length ? `${pct}%` : held.length ? `${held.length} waiting` : failed.length ? `${failed.length} failed` : `${transfers.length} transfer${transfers.length === 1 ? '' : 's'}`}</span>
        </button>
      )}
      {/* Portalled: the top bar's backdrop blur would otherwise make it the drawer's containing block. */}
      {open && createPortal(
        <aside className="iq" role="dialog" aria-label="Ingest queue">
          <div className="iq-h">Ingest Queue<span className="sp" /><button type="button" className="iq-ic" aria-label="Close" onClick={() => setOpen(false)}>✕</button></div>
          {(active.length > 0 || done.length > 0 || failed.length > 0) && (
            <div className="iq-sub">
              <button type="button" onClick={() => { active.forEach(i => cancel(i.id)) }} disabled={!active.length}>Cancel all</button>
              <span className="sp">{active.length ? `Uploading ${active.length} file${active.length === 1 ? '' : 's'}` : failed.length ? `${failed.length} failed` : `${done.length} done`}</span>
              {failed.length > 0 ? <button type="button" onClick={retryFailed}>Retry</button> : <button type="button" onClick={clearFinished}>Clear</button>}
            </div>
          )}
          <div className="iq-list">
            {/* A finished upload that is held for metadata is listed once, under Needs you. */}
            {items.slice().reverse().filter(i => !(i.status === 'done' && i.assetId && held.some(h => h.id === i.assetId))).map(i => {
              const p = i.totalBytes ? Math.round((i.sentBytes / i.totalBytes) * 100) : 0
              return (
                <div key={i.id} className="iq-row">
                  <div className="th">{(i.filename.split('.').pop() ?? '').slice(0, 4).toUpperCase()}</div>
                  <div className="b">
                    <div className="nm" title={i.error || i.filename}>{i.filename}</div>
                    <div className="mt">{fmtBytes(i.totalBytes)}{i.status === 'done' ? ` · ${i.ingest?.status === 'awaiting_metadata' ? 'in the Media Library' : label(i.ingest)}` : i.status === 'error' ? ` · ${i.error ?? 'failed'}` : i.status === 'background' ? ' · the browser is carrying it' : i.status === 'paused' ? ' · paused' : i.status === 'assembling' ? ' · assembling' : i.rate ? ` · ${fmtBytes(i.rate)}/s` : ''}</div>
                    <div className={`pb${i.status === 'done' ? ' ok' : i.status === 'error' ? ' bad' : ''}`}><i style={{ width: `${i.status === 'done' ? 100 : p}%` }} /></div>
                  </div>
                  {i.status === 'uploading' && <button type="button" className="iq-ic" title="Pause" onClick={() => pause(i.id)}>❚❚</button>}
                  {i.status === 'paused' && <button type="button" className="iq-ic" title="Resume" onClick={() => resume(i.id)}>▶</button>}
                  {i.status !== 'done' && <button type="button" className="iq-ic" title="Cancel" onClick={() => cancel(i.id)}>✕</button>}
                </div>
              )
            })}
            {transfers.length > 0 && <div className="iq-sec">Accelerated transfers</div>}
            {transfers.map(t => (
              <div key={t.id} className="iq-row">
                <div className="th">{t.provider.slice(0, 4).toUpperCase()}</div>
                <div className="b"><div className="nm">{t.files.length} file{t.files.length === 1 ? '' : 's'} via {t.provider}</div><div className="mt">{t.state}{t.progress?.pct != null ? ` · ${t.progress.pct}%` : ''}{t.error ? ` · ${t.error}` : ''}</div>
                  {t.progress?.pct != null && <div className="pb"><i style={{ width: `${t.progress.pct}%` }} /></div>}</div>
                {t.launch?.kind === 'portal' && <a className="iq-ic" href={t.launch.url} target="_blank" rel="noreferrer" title="Open the portal">↗</a>}
              </div>
            ))}
            {held.length > 0 && <div className="iq-sec">Needs you</div>}
            {err && <div style={{ color: 'var(--down)', fontSize: 'var(--fs-xs)', padding: '4px 18px' }}>{err}</div>}
            {held.map(h => (
              <div key={h.id} style={{ borderBottom: '1px solid var(--border)' }}>
                <div className="iq-row" style={{ borderBottom: 0 }}>
                  <div className="th">{(h.originalFilename?.split('.').pop() ?? '').slice(0, 4).toUpperCase()}</div>
                  <div className="b">
                    <div className="nm">{h.originalFilename ?? h.title}</div>
                    <div className="mt" style={{ color: 'var(--warn)' }}>{h.status === 'awaiting_metadata' ? `needs ${(h.awaitingMetadata ?? []).join(', ')}${h.encoded ? ' · encoded, can be published once filled in' : h.mediaState === 'failed' ? ' · encode failed' : ' · encoding'}` : h.status === 'duplicate' ? `same ${h.duplicate?.strength === 'content' ? 'content' : 'name and size'} as a library asset` : `refused by ${h.rules.map(r => r.ruleName).join(', ')}`}</div>
                  </div>
                  {h.status === 'awaiting_metadata' && <button type="button" className="btn ghost" style={{ padding: '5px 10px', fontSize: 'var(--fs-xs)' }} onClick={() => { setFill(fill === h.id ? null : h.id); setMeta({ ...(h.metadata ?? {}) }) }}>{fill === h.id ? 'Close' : 'Fill in'}</button>}
                </div>
                {h.status === 'duplicate' && (
                  <div style={{ display: 'flex', gap: 6, padding: '0 18px 12px 86px' }}>
                    <button type="button" className="btn ghost" style={{ padding: '5px 10px', fontSize: 'var(--fs-xs)' }} onClick={() => act(() => api.ingestResolveDuplicate(h.id, 'skip'), h.id)}>Skip it</button>
                    <button type="button" className="btn ghost" style={{ padding: '5px 10px', fontSize: 'var(--fs-xs)' }} onClick={() => act(() => api.ingestResolveDuplicate(h.id, 'version'), h.id)}>Keep both</button>
                    <button type="button" className="btn ghost" style={{ padding: '5px 10px', fontSize: 'var(--fs-xs)' }} onClick={() => act(() => api.ingestResolveDuplicate(h.id, 'replace'), h.id)}>Replace old</button>
                  </div>
                )}
                {fill === h.id && (
                  <div style={{ padding: '0 18px 12px' }}>
                    <MetadataForm typeId={h.schemaId} value={meta} onChange={setMeta} compact />
                    <button type="button" className="btn primary" style={{ marginTop: 8, padding: '6px 12px', fontSize: 'var(--fs-xs)' }} onClick={() => act(() => api.ingestSetMetadata(h.id, meta), h.id)}>Save</button>
                  </div>
                )}
              </div>
            ))}
            {!items.length && !held.length && !transfers.length && <div style={{ padding: 24, color: 'var(--faint)', fontSize: 'var(--fs-sm)', textAlign: 'center' }}>Nothing in the queue.</div>}
          </div>
          {active.length > 0 && (
            <div className="iq-f">
              <span className="iq-fab" style={{ height: 'auto', padding: 0, border: 0, boxShadow: 'none', background: 'transparent', ['--p' as any]: `${pct}%` }}><span className="ring" /></span>
              <div className="b">
                <div><b>Uploading: {pct}%</b></div>
                <div className="mt">{done.length} of {done.length + active.length} files uploaded · {fmtBytes(sent)} of {fmtBytes(tot)}{rate > 0 ? ` · ${fmtBytes(rate)}/s` : ''}{eta != null ? ` · ${eta >= 60 ? Math.round(eta / 60) + 'm ' + (eta % 60) + 's' : eta + 's'} left` : ''}</div>
                <div className="pb"><i style={{ width: `${pct}%` }} /></div>
              </div>
              <button type="button" className="iq-ic" title={active.some(i => i.status === 'uploading') ? 'Pause all' : 'Resume all'} onClick={() => active.some(i => i.status === 'uploading') ? active.forEach(i => pause(i.id)) : active.forEach(i => resume(i.id))}>{active.some(i => i.status === 'uploading') ? '❚❚' : '▶'}</button>
              <button type="button" className="iq-ic" title="Cancel all" onClick={() => active.forEach(i => cancel(i.id))}>✕</button>
            </div>
          )}
        </aside>, document.body
      )}
    </>
  )
}
