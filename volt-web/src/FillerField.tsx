// THE FALLBACK FIELD on channel, station and event forms (22 Oct 2026).
//
// What a stream shows when every source is gone now comes from ONE place,
// Loops & Fillers. The forms used to pick slates from the Image Library into
// `filler_slate_ref`, a different field from the `filler_asset_id` that page
// manages, so neither side could see the other: a slate chosen here never
// appeared on Loops & Fillers, and a loop uploaded there could not be chosen
// here. The Loop picker also saved the video's address in the SLATE field, so
// the encoder treated a loop as a still image.
//
// A stream that still points at a pasted address (an Image Library image) keeps
// working; it is shown as such, with a one-step copy into Loops & Fillers.
import { useEffect, useRef, useState } from 'react'
import { api, thumbUrl, type FillerAsset } from './api'
import { pressable } from './a11y'
import { startUpload, subscribe } from './uploadManager'
import { navigate } from './router'

type Behavior = 'slate' | 'vod_loop'

const IC = {
  slate: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="3" width="18" height="18" rx="2" /><circle cx="9" cy="9" r="2" /><path d="m21 15-5-5L5 21" /></svg>,
  loop: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M17 2l4 4-4 4" /><path d="M3 11v-1a4 4 0 014-4h14M7 22l-4-4 4-4" /><path d="M21 13v1a4 4 0 01-4 4H3" /></svg>,
  upload: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4M17 8l-5-5-5 5M12 3v12" /></svg>,
  copy: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="9" y="9" width="13" height="13" rx="2" /><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" /></svg>,
}

function Preview({ a, w = 64, h = 36 }: { a: FillerAsset; w?: number; h?: number }) {
  const st = { width: w, height: h, objectFit: 'cover' as const, borderRadius: 4, background: '#000', flex: 'none' as const }
  if (a.status !== 'ready' || !a.source_key) return <div className="ff-ph" style={{ width: w, height: h }}>{a.kind === 'loop' ? IC.loop : IC.slate}</div>
  return a.kind === 'slate'
    ? <img src={`/${a.source_key}`} alt="" style={st} />
    : <video src={`/${a.source_key}`} muted preload="metadata" style={st} />
}

export function FillerField(props: {
  behavior: Behavior
  assetId: string | null
  onAssetId: (id: string | null) => void
  /** The old pasted address (Image Library image or URL), if any. */
  legacyRef: string
  onLegacyRef: (ref: string) => void
}) {
  const { behavior, assetId, onAssetId, legacyRef, onLegacyRef } = props
  const [assets, setAssets] = useState<FillerAsset[] | null>(null)
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')

  const load = () => api.fillerAssets().then(setAssets).catch((e: any) => { setAssets([]); setErr(e.message) })
  useEffect(() => { load() }, [])

  const chosen = assets?.find(a => a.id === assetId) ?? null
  const label = behavior === 'slate' ? 'Slate image' : 'Loop video'

  async function copyIn() {
    setBusy(true); setErr('')
    try {
      const r = await api.copyFillerFromLibrary(legacyRef)
      await load()
      onAssetId(r.asset.id); onLegacyRef('')
    } catch (e: any) { setErr(e.message) } finally { setBusy(false) }
  }

  return (
    <div className="field"><label>{label}</label>
      {chosen ? (
        <div className="ff-row">
          <Preview a={chosen} />
          <div className="ff-meta">
            <div className="ff-name">{chosen.name}</div>
            <div className="ff-sub">{chosen.kind === 'loop' ? 'Loop' : 'Slate'} in Loops &amp; Fillers
              {behavior === 'vod_loop' && chosen.kind === 'slate' ? ' · played as a gently moving loop' : ''}</div>
          </div>
          <div className="ff-actions">
            <button type="button" className="btn ghost" onClick={() => setOpen(true)}>Change…</button>
            <button type="button" className="btn ghost" onClick={() => onAssetId(null)}>Remove</button>
          </div>
        </div>
      ) : assetId && assets === null ? (
        <div className="ff-row"><div className="ff-sub">Loading…</div></div>
      ) : assetId ? (
        <div className="ff-row">
          <div className="ff-meta"><div className="ff-name" style={{ color: '#fca5a5' }}>The chosen {behavior === 'slate' ? 'slate' : 'loop'} is no longer in Loops &amp; Fillers</div></div>
          <button type="button" className="btn ghost" onClick={() => setOpen(true)}>Choose another…</button>
        </div>
      ) : legacyRef ? (
        <div className="ff-row ff-legacy">
          {behavior === 'slate' && <img src={thumbUrl(legacyRef, 128, 72)} alt="" style={{ width: 64, height: 36, objectFit: 'cover', borderRadius: 4, background: '#000', flex: 'none' }} />}
          <div className="ff-meta">
            <div className="ff-name" title={legacyRef}>{legacyRef.split('/').pop()}</div>
            <div className="ff-sub">Not in Loops &amp; Fillers: this is {legacyRef.startsWith('/library/') ? 'an Image Library image' : 'a pasted address'}. It still works.</div>
          </div>
          <div className="ff-actions">
            {legacyRef.startsWith('/library/') && (
              <button type="button" className="btn ghost" disabled={busy} onClick={copyIn}>{IC.copy}{busy ? 'Copying…' : 'Copy into Loops & Fillers'}</button>
            )}
            <button type="button" className="btn ghost" onClick={() => setOpen(true)}>Choose instead…</button>
          </div>
        </div>
      ) : (
        <div className="ff-row">
          <button type="button" className="btn ghost" onClick={() => setOpen(true)}>{behavior === 'slate' ? IC.slate : IC.loop}Choose from Loops &amp; Fillers…</button>
          {behavior === 'vod_loop' && <span className="ff-sub">No loop video? A slate works too: it plays as a gently moving loop.</span>}
        </div>
      )}
      {err && <div className="ff-err">{err}</div>}
      {open && (
        <FillerPicker behavior={behavior} assets={assets} selected={assetId}
          onReload={load}
          onClose={() => setOpen(false)}
          onPick={(a) => { onAssetId(a.id); onLegacyRef(''); setOpen(false) }} />
      )}
    </div>
  )
}

function FillerPicker({ behavior, assets, selected, onPick, onClose, onReload }: {
  behavior: Behavior; assets: FillerAsset[] | null; selected: string | null
  onPick: (a: FillerAsset) => void; onClose: () => void; onReload: () => Promise<any>
}) {
  // A slate fallback takes slates. A loop fallback takes loops first, and a
  // slate as well, which the encoder turns into a slow-moving loop.
  const kinds: ('slate' | 'loop')[] = behavior === 'slate' ? ['slate'] : ['loop', 'slate']
  const [tab, setTab] = useState<'slate' | 'loop'>(kinds[0])
  const [q, setQ] = useState('')
  const [up, setUp] = useState<{ id: string; pct: number; error?: string | null } | null>(null)
  const fileInput = useRef<HTMLInputElement | null>(null)
  const waitFor = useRef<string | null>(null)

  // Follow the upload this picker started; select it the moment it lands.
  useEffect(() => subscribe(items => {
    const it = items.find(i => i.id === waitFor.current)
    if (!it) return
    setUp({ id: it.id, pct: it.totalBytes ? Math.round((it.sentBytes / it.totalBytes) * 100) : 0, error: it.error })
    if (it.status === 'done' && it.assetId) {
      const id = it.assetId
      waitFor.current = null
      onReload().then(() => api.fillerAssets().then(list => { const a = list.find(x => x.id === id); if (a) onPick(a) }))
    }
  }), [])

  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', k)
    return () => document.removeEventListener('keydown', k)
  }, [onClose])

  const needle = q.trim().toLowerCase()
  const list = (assets ?? []).filter(a => a.kind === tab && a.status === 'ready' && (!needle || a.name.toLowerCase().includes(needle)))

  return (
    <div className="drawer-scrim" style={{ alignItems: 'center', justifyContent: 'center', zIndex: 80 }} onMouseDown={e => { if (e.target === e.currentTarget) onClose() }}>
      <div className="card ff-picker" role="dialog" aria-label="Choose from Loops & Fillers">
        <div className="card-h">
          <h3>Choose from Loops &amp; Fillers</h3>
          <div className="spacer" />
          <input className="inp" style={{ maxWidth: 180 }} placeholder="Search…" value={q} onChange={e => setQ(e.target.value)} />
          <button className="xbtn" onClick={onClose} aria-label="Close">✕</button>
        </div>
        <div className="ff-tools">
          {kinds.length > 1 && kinds.map(k => (
            <button key={k} type="button" className={`chip ${tab === k ? 'active' : ''}`} onClick={() => setTab(k)}>
              {k === 'loop' ? IC.loop : IC.slate}{k === 'loop' ? 'Loops' : 'Slates'}
              <span className="ct">{(assets ?? []).filter(a => a.kind === k && a.status === 'ready').length}</span>
            </button>
          ))}
          <div style={{ flex: 1 }} />
          <input ref={fileInput} type="file" style={{ display: 'none' }}
            accept={tab === 'slate' ? 'image/*' : 'video/*'}
            onChange={e => {
              const f = e.target.files?.[0]; e.target.value = ''
              if (!f) return
              startUpload(f, { kind: tab }).then(it => { waitFor.current = it.id; setUp({ id: it.id, pct: 0 }) })
                .catch((ex: any) => setUp({ id: '', pct: 0, error: ex.message }))
            }} />
          <button type="button" className="btn primary" disabled={!!up && !up.error} onClick={() => fileInput.current?.click()}>
            {IC.upload}{up && !up.error ? `Uploading ${up.pct}%` : `Upload a ${tab}`}
          </button>
        </div>
        {up?.error && <div className="ff-err" style={{ margin: '0 18px 8px' }}>{up.error}</div>}
        <div className="card-b ff-grid-wrap">
          {assets === null ? <div className="loading">Loading…</div>
            : list.length === 0 ? (
              <div className="ff-empty">No {tab === 'loop' ? 'loops' : 'slates'} {needle ? `match “${q.trim()}”` : 'yet'}. Upload one here, or on the Loops &amp; Fillers page.</div>
            ) : (
              <div className="ff-grid">
                {list.map(a => (
                  <div key={a.id} className={`ff-card ${a.id === selected ? 'sel' : ''}`} {...pressable(() => onPick(a), { label: a.name })}>
                    <Preview a={a} w={180} h={101} />
                    <div className="ff-card-t">{a.name}</div>
                    <div className="ff-sub">{(a.used_by?.length ?? 0) === 0 ? 'Not used yet' : `Used by ${a.used_by!.length}`}</div>
                  </div>
                ))}
              </div>
            )}
        </div>
        <div className="ff-foot">
          <a href="/loops" onClick={e => { e.preventDefault(); onClose(); navigate('/loops') }}>Manage in Loops &amp; Fillers</a>
        </div>
      </div>
    </div>
  )
}
