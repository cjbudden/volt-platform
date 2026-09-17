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
import { api, type IngestHeld, type IngestTransfer } from './api'
import { subscribe, cancel, pause, resume, retryFailed, clearFinished, type UploadItem } from './uploadManager'
import { MetadataForm } from './ContentTypeFields'
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

  const act = async (fn: () => Promise<any>) => { setErr(''); try { await fn(); setFill(null); setMeta({}); loadHeld() } catch (e: any) { setErr(String(e?.message ?? e)) } }

  return (
    <>
      {!open && count > 0 && (
        <button type="button" className="iq-fab" onClick={() => setOpen(true)} style={{ ['--p' as any]: `${pct}%` }}>
          <span className="ring" />
          <span>{active.length ? `Uploading ${active.length} · ${pct}%` : held.length ? `${held.length} waiting on you` : failed.length ? `${failed.length} failed` : `${transfers.length} transfer${transfers.length === 1 ? '' : 's'} running`}</span>
        </button>
      )}
      {open && (
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
            {items.slice().reverse().map(i => {
              const p = i.totalBytes ? Math.round((i.sentBytes / i.totalBytes) * 100) : 0
              return (
                <div key={i.id} className="iq-row">
                  <div className="th">{(i.filename.split('.').pop() ?? '').slice(0, 4).toUpperCase()}</div>
                  <div className="b">
                    <div className="nm" title={i.error || i.filename}>{i.filename}</div>
                    <div className="mt">{fmtBytes(i.totalBytes)}{i.status === 'done' ? ` · ${label(i.ingest)}` : i.status === 'error' ? ` · ${i.error ?? 'failed'}` : i.status === 'background' ? ' · the browser is carrying it' : i.status === 'paused' ? ' · paused' : i.status === 'assembling' ? ' · assembling' : i.rate ? ` · ${fmtBytes(i.rate)}/s` : ''}</div>
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
                    <div className="mt" style={{ color: 'var(--warn)' }}>{h.status === 'awaiting_metadata' ? `needs ${(h.awaitingMetadata ?? []).join(', ')}` : h.status === 'duplicate' ? `same ${h.duplicate?.strength === 'content' ? 'content' : 'name and size'} as a library asset` : `refused by ${h.rules.map(r => r.ruleName).join(', ')}`}</div>
                  </div>
                  {h.status === 'awaiting_metadata' && <button type="button" className="btn ghost" style={{ padding: '5px 10px', fontSize: 'var(--fs-xs)' }} onClick={() => { setFill(fill === h.id ? null : h.id); setMeta({}) }}>{fill === h.id ? 'Close' : 'Fill in'}</button>}
                </div>
                {h.status === 'duplicate' && (
                  <div style={{ display: 'flex', gap: 6, padding: '0 18px 12px 86px' }}>
                    <button type="button" className="btn ghost" style={{ padding: '5px 10px', fontSize: 'var(--fs-xs)' }} onClick={() => act(() => api.ingestResolveDuplicate(h.id, 'skip'))}>Skip it</button>
                    <button type="button" className="btn ghost" style={{ padding: '5px 10px', fontSize: 'var(--fs-xs)' }} onClick={() => act(() => api.ingestResolveDuplicate(h.id, 'version'))}>Keep both</button>
                    <button type="button" className="btn ghost" style={{ padding: '5px 10px', fontSize: 'var(--fs-xs)' }} onClick={() => act(() => api.ingestResolveDuplicate(h.id, 'replace'))}>Replace old</button>
                  </div>
                )}
                {fill === h.id && (
                  <div style={{ padding: '0 18px 12px' }}>
                    <MetadataForm typeId={h.schemaId} value={meta} onChange={setMeta} compact />
                    <button type="button" className="btn primary" style={{ marginTop: 8, padding: '6px 12px', fontSize: 'var(--fs-xs)' }} onClick={() => act(() => api.ingestSetMetadata(h.id, meta))}>Save and ingest</button>
                  </div>
                )}
              </div>
            ))}
            {!items.length && !held.length && !transfers.length && <div style={{ padding: 24, color: 'var(--faint)', fontSize: 'var(--fs-sm)', textAlign: 'center' }}>Nothing in the queue.</div>}
          </div>
          {active.length > 0 && (
            <div className="iq-f">
              <span className="iq-fab" style={{ position: 'static', padding: 0, border: 0, boxShadow: 'none', background: 'transparent', ['--p' as any]: `${pct}%` }}><span className="ring" /></span>
              <div className="b">
                <div><b>Uploading: {pct}%</b></div>
                <div className="mt">{done.length} of {done.length + active.length} files uploaded · {fmtBytes(sent)} of {fmtBytes(tot)}{rate > 0 ? ` · ${fmtBytes(rate)}/s` : ''}{eta != null ? ` · ${eta >= 60 ? Math.round(eta / 60) + 'm ' + (eta % 60) + 's' : eta + 's'} left` : ''}</div>
                <div className="pb"><i style={{ width: `${pct}%` }} /></div>
              </div>
              <button type="button" className="iq-ic" title={active.some(i => i.status === 'uploading') ? 'Pause all' : 'Resume all'} onClick={() => active.some(i => i.status === 'uploading') ? active.forEach(i => pause(i.id)) : active.forEach(i => resume(i.id))}>{active.some(i => i.status === 'uploading') ? '❚❚' : '▶'}</button>
              <button type="button" className="iq-ic" title="Cancel all" onClick={() => active.forEach(i => cancel(i.id))}>✕</button>
            </div>
          )}
        </aside>
      )}
    </>
  )
}
