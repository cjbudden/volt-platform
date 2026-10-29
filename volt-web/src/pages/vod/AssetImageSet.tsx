// An asset's images by type (docs/ASSET_IMAGES.md section 13). The primary
// image (Thumbnail on video, Cover on audio) is shown above by AssetImage;
// this lists every other type the asset offers, content images first, then
// publishing images for portals, apps and feeds. A type with no image of its
// own shows what portals get instead: its fallback, cropped to its shape.
import { useEffect, useMemo, useState } from 'react'
import { apiRequest } from '../../api'
import { ImagePicker } from '../../ImagePicker'
import './assetImageSet.css'

interface Focus { x: number; y: number }
interface TypeView {
  key: string; label: string; description: string; purpose: 'content' | 'publishing'; aspect: string
  aspectW: number | null; aspectH: number | null; minWidth: number; minHeight: number
  appliesTo: ('video' | 'audio')[]; primaryFor: string[]; fallback: string[]; transparent: boolean
  isStandard: boolean; enabled: boolean; sort: number; primary?: boolean
}
interface Slot {
  type: TypeView
  image: null | { key: string; url: string | null; previewUrl: string | null; sourceUrl?: string | null; width: number | null; height: number | null; focus: Focus | null; source: string | null; chosenBy?: string | null; missing?: boolean }
  fallback: null | { from: string; previewUrl: string | null }
  warnings: string[]
}
interface View { assetId: string; media: 'video' | 'audio'; primaryType: string; slots: Slot[] }
interface Cand { key: string; atMs: number | null; url: string | null; rejected: string | null }

const J = (b: unknown): RequestInit => ({ body: JSON.stringify(b), headers: { 'content-type': 'application/json' } })
const clock = (ms: number) => { const s = Math.round(ms / 1000); return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}` }
const ratio = (t: TypeView) => (t.aspectW && t.aspectH ? `${t.aspectW} / ${t.aspectH}` : '16 / 9')

export function AssetImageSet({ id, folder, candidates, primaryKey }: { id: string; folder?: string | null; candidates: Cand[]; primaryKey?: string | null }) {
  const [v, setV] = useState<View | null>(null)
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [picking, setPicking] = useState<TypeView | null>(null)
  const [frames, setFrames] = useState<string | null>(null)
  const [focusing, setFocusing] = useState<Slot | null>(null)
  const [managing, setManaging] = useState(false)

  const load = () => apiRequest(`/vod/${id}/images`).then((x: View) => { setV(x); setErr('') }, (e: any) => setErr(e.message))
  useEffect(() => { setV(null); load() }, [id, primaryKey]) // eslint-disable-line react-hooks/exhaustive-deps

  const act = async (label: string, fn: () => Promise<View>) => {
    setBusy(label); setErr('')
    try { setV(await fn()) } catch (e: any) { setErr(e.message) } finally { setBusy(null) }
  }
  const choose = (type: string, ref: string, focus?: Focus | null) => act(type, () => apiRequest(`/vod/${id}/images/${type}`, { method: 'PUT', ...J({ ref, focus: focus ?? null }) }))
  const remove = (type: string) => act(type, () => apiRequest(`/vod/${id}/images/${type}`, { method: 'DELETE' }))
  const refocus = (type: string, focus: Focus | null) => act(type, () => apiRequest(`/vod/${id}/images/${type}`, { method: 'PATCH', ...J({ focus }) }))

  const groups = useMemo(() => {
    const others = (v?.slots ?? []).filter((s) => !s.type.primary)
    return [
      { title: 'Content images', slots: others.filter((s) => s.type.purpose === 'content') },
      { title: 'Publishing images', note: 'For portals, apps and feeds. A type without its own image is made from its fallback, cropped to shape.', slots: others.filter((s) => s.type.purpose === 'publishing') },
    ].filter((g) => g.slots.length)
  }, [v])
  const label = (key: string) => v?.slots.find((s) => s.type.key === key)?.type.label ?? key
  const usable = candidates.filter((c) => c.url && !c.rejected)

  return (
    <div className="aiset">
      <div className="asset-img-h">
        <div className="sec-label" style={{ margin: 0 }}>More images</div>
        <div style={{ flex: 1 }} />
        <button className="btn ghost sm" onClick={() => setManaging(true)}>Image types…</button>
      </div>
      {err && <div className="asset-img-err">{err}</div>}
      {!v && !err && <div className="lib-faint">Loading…</div>}
      {groups.map((g) => (
        <div key={g.title} className="aiset-group">
          <div className="aiset-gh">{g.title}{g.note && <span className="lib-faint"> · {g.note}</span>}</div>
          <div className="aiset-grid">
            {g.slots.map((s) => {
              const t = s.type
              const img = s.image
              const src = img?.previewUrl ?? s.fallback?.previewUrl ?? null
              return (
                <div key={t.key} className={`aiset-slot${img ? ' own' : ''}`}>
                  <div className={`aiset-pic${t.transparent ? ' checker' : ''}${!img && s.fallback ? ' derived' : ''}`} style={{ aspectRatio: ratio(t), width: t.aspectW && t.aspectH && t.aspectW < t.aspectH ? `${Math.round((t.aspectW / t.aspectH) * 100)}%` : '100%' }}>
                    {src ? <img src={src} alt="" loading="lazy" /> : <span className="lib-faint">No image</span>}
                    {img?.focus && <span className="aiset-dot" style={{ left: `${img.focus.x}%`, top: `${img.focus.y}%` }} />}
                  </div>
                  <div className="aiset-meta">
                    <div className="aiset-name" title={t.description}>{t.label} <span className="aiset-aspect">{t.aspect}</span></div>
                    <div className="aiset-state">
                      {img ? (img.missing ? 'Image missing from the library' : `Own image${img.width ? `, ${img.width} × ${img.height}` : ''}${img.source === 'frame' ? ' (a frame)' : ''}`)
                        : s.fallback ? `From ${label(s.fallback.from)}, cropped` : t.transparent ? 'None: add a transparent PNG' : 'None'}
                    </div>
                    {s.warnings.map((w) => <div key={w} className="aiset-warn">{w}</div>)}
                    <div className="aiset-actions">
                      <button className="btn ghost sm" disabled={!!busy} onClick={() => setPicking(t)}>{img ? 'Replace' : 'Choose'}</button>
                      {usable.length > 0 && !t.transparent && <button className="btn ghost sm" disabled={!!busy} onClick={() => setFrames(frames === t.key ? null : t.key)}>Use a frame</button>}
                      {img && t.aspectW && <button className="btn ghost sm" disabled={!!busy} onClick={() => setFocusing(s)}>Focus</button>}
                      {img && <button className="btn ghost sm" disabled={!!busy} onClick={() => remove(t.key)}>{busy === t.key ? '…' : 'Remove'}</button>}
                    </div>
                  </div>
                  {frames === t.key && (
                    <div className="aiset-frames">
                      {usable.map((c) => (
                        <button key={c.key} type="button" className="asset-img-cand" disabled={!!busy} onClick={() => { setFrames(null); choose(t.key, c.key) }}>
                          <img src={c.url!} alt="" loading="lazy" />{c.atMs != null && <span className="t">{clock(c.atMs)}</span>}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        </div>
      ))}
      <ImagePicker open={!!picking} title={picking ? `${picking.label} (${picking.aspect}${picking.minWidth ? `, at least ${picking.minWidth}${picking.minHeight ? ` × ${picking.minHeight}` : ' wide'}` : ''})` : ''}
        assetId={id} kinds={picking?.key === 'cover' || v?.media === 'audio' ? ['cover', 'poster', 'brand', 'other', 'imported', 'keyframe'] : ['poster', 'brand', 'other', 'keyframe']}
        uploadKind={picking?.key === 'cover' ? 'cover' : 'poster'} uploadFolder={folder ?? 'posters'}
        onClose={() => setPicking(null)} onPick={(url) => { const t = picking!; setPicking(null); choose(t.key, url) }} />
      {focusing && <FocusEditor slot={focusing} onClose={() => setFocusing(null)} onSave={(f) => { const k = focusing.type.key; setFocusing(null); refocus(k, f) }} />}
      {managing && <ImageTypes onClose={() => { setManaging(false); load() }} />}
    </div>
  )
}

/** Click where portals should keep in frame; the outline is what this type's crop keeps. */
function FocusEditor({ slot, onClose, onSave }: { slot: Slot; onClose: () => void; onSave: (f: Focus | null) => void }) {
  const t = slot.type
  const [f, setF] = useState<Focus | null>(slot.image?.focus ?? null)
  const [nat, setNat] = useState<{ w: number; h: number } | null>(null)
  const box = useMemo(() => {
    if (!nat || !t.aspectW || !t.aspectH) return null
    const want = t.aspectW / t.aspectH, have = nat.w / nat.h
    const w = have > want ? (nat.h * want) / nat.w : 1, h = have > want ? 1 : (nat.w / want) / nat.h
    const cx = (f?.x ?? 50) / 100, cy = (f?.y ?? 50) / 100
    const x = Math.min(Math.max(cx - w / 2, 0), 1 - w), y = Math.min(Math.max(cy - h / 2, 0), 1 - h)
    return { x: x * 100, y: y * 100, w: w * 100, h: h * 100 }
  }, [nat, f, t.aspectW, t.aspectH])
  return (
    <div className="drawer-scrim" onClick={(e) => { if (e.target === e.currentTarget) onClose() }} style={{ alignItems: 'center', justifyContent: 'center' }}>
      <div className="card" role="dialog" aria-modal="true" aria-label={`Focus for ${t.label}`} style={{ width: 720, maxWidth: '95vw' }}>
        <div className="card-h"><h3>{t.label}: where to crop</h3><div style={{ flex: 1 }} /><button className="xbtn" onClick={onClose}>✕</button></div>
        <div className="card-b">
          <p className="lib-faint" style={{ marginTop: 0 }}>Click the part that must stay in frame. The outline is what a {t.aspect} crop keeps. Without a focus point the image service picks the most interesting part.</p>
          <div className="aiset-focus" onClick={(e) => { const r = (e.currentTarget as HTMLElement).getBoundingClientRect(); setF({ x: Math.round(((e.clientX - r.left) / r.width) * 100), y: Math.round(((e.clientY - r.top) / r.height) * 100) }) }}>
            {slot.image?.sourceUrl && <img src={slot.image.sourceUrl} alt="" onLoad={(e) => setNat({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })} />}
            {box && <span className="aiset-crop" style={{ left: `${box.x}%`, top: `${box.y}%`, width: `${box.w}%`, height: `${box.h}%` }} />}
            {f && <span className="aiset-dot" style={{ left: `${f.x}%`, top: `${f.y}%` }} />}
          </div>
        </div>
        <div className="modal-f">
          <button className="btn ghost" onClick={() => onSave(null)}>Automatic</button>
          <div style={{ flex: 1 }} />
          <button className="btn ghost" onClick={onClose}>Cancel</button>
          <button className="btn primary" disabled={!f} onClick={() => onSave(f)}>Save focus</button>
        </div>
      </div>
    </div>
  )
}

/** The account's image types: rename or switch off the standard ones, add your own. */
function ImageTypes({ onClose }: { onClose: () => void }) {
  const [types, setTypes] = useState<TypeView[] | null>(null)
  const [err, setErr] = useState('')
  const [draft, setDraft] = useState({ key: '', label: '', aspect: '16:9', minWidth: 1280, minHeight: 720, purpose: 'publishing', video: true, audio: true })
  const load = () => apiRequest('/vod/image-types').then(setTypes, (e: any) => setErr(e.message))
  useEffect(() => { load() }, [])
  const patch = async (key: string, body: Partial<TypeView>) => {
    setErr('')
    try { await apiRequest(`/vod/image-types/${key}`, { method: 'PATCH', ...J(body) }); load() } catch (e: any) { setErr(e.message) }
  }
  const add = async (key: string) => {
    setErr('')
    try {
      await apiRequest('/vod/image-types', { method: 'POST', ...J({ key, label: draft.label, aspect: draft.aspect, minWidth: Number(draft.minWidth) || 0, minHeight: Number(draft.minHeight) || 0,
        purpose: draft.purpose, appliesTo: [draft.video && 'video', draft.audio && 'audio'].filter(Boolean) }) })
      setDraft({ ...draft, key: '', label: '' }); load()
    } catch (e: any) { setErr(e.message) }
  }
  const del = async (t: TypeView) => {
    setErr('')
    try { await apiRequest(`/vod/image-types/${t.key}`, { method: 'DELETE' }); load() }
    catch (e: any) {
      if (/force/.test(e.message) && window.confirm(`${e.message}\n\nDelete the type and those images?`)) { await apiRequest(`/vod/image-types/${t.key}?force=1`, { method: 'DELETE' }).catch((x: any) => setErr(x.message)); load() }
      else setErr(e.message)
    }
  }
  return (
    <div className="drawer-scrim" onClick={(e) => { if (e.target === e.currentTarget) onClose() }} style={{ alignItems: 'center', justifyContent: 'center' }}>
      <div className="card" role="dialog" aria-modal="true" aria-label="Image types" style={{ width: 860, maxWidth: '96vw', maxHeight: '86vh', display: 'flex', flexDirection: 'column' }}>
        <div className="card-h"><h3>Image types</h3><div style={{ flex: 1 }} /><button className="xbtn" onClick={onClose}>✕</button></div>
        <div className="card-b" style={{ overflow: 'auto' }}>
          <p className="lib-faint" style={{ marginTop: 0 }}>Every asset in this account offers these images. Thumbnail (video) and Cover (audio) are each asset's main image and are picked automatically.</p>
          {err && <div className="asset-img-err">{err}</div>}
          {!types ? <div className="loading">Loading…</div> : (
            <table className="aiset-types">
              <thead><tr><th>On</th><th>Name</th><th>Shape</th><th>Minimum</th><th>For</th><th>Falls back to</th><th /></tr></thead>
              <tbody>
                {types.map((t) => (
                  <tr key={t.key} className={t.enabled ? '' : 'off'}>
                    <td><input type="checkbox" checked={t.enabled} disabled={t.primaryFor.length > 0} title={t.primaryFor.length ? 'The main image: always on' : ''} onChange={(e) => patch(t.key, { enabled: e.target.checked })} /></td>
                    <td><input className="inp" defaultValue={t.label} onBlur={(e) => e.target.value.trim() && e.target.value !== t.label && patch(t.key, { label: e.target.value.trim() })} />
                      <div className="lib-faint mono" style={{ fontSize: 11 }}>{t.key}{t.primaryFor.length ? ` · main image for ${t.primaryFor.join(', ')}` : ''}{t.isStandard ? '' : ' · custom'}</div></td>
                    <td>{t.aspect}</td>
                    <td>{t.minWidth ? `${t.minWidth}${t.minHeight ? ` × ${t.minHeight}` : ' wide'}` : '—'}</td>
                    <td>{t.appliesTo.join(', ')}</td>
                    <td>{t.fallback.length ? t.fallback.map((k) => k === 'primary' ? 'main image' : types.find((x) => x.key === k)?.label ?? k).join(' → ') : 'nothing'}</td>
                    <td>{!t.isStandard && <button className="btn ghost sm" onClick={() => del(t)}>Delete</button>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <div className="aiset-add">
            <div className="sec-label">Add a type</div>
            <div className="aiset-add-row">
              <label className="field"><span>Name</span><input className="inp" value={draft.label} placeholder="Partner tile" onChange={(e) => setDraft({ ...draft, label: e.target.value })} /></label>
              <label className="field"><span>Key</span><input className="inp mono" value={draft.key} placeholder={draft.label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'partner-tile'}
                onChange={(e) => setDraft({ ...draft, key: e.target.value.toLowerCase() })} /></label>
              <label className="field"><span>Shape</span><input className="inp" value={draft.aspect} placeholder="4:3, or any" onChange={(e) => setDraft({ ...draft, aspect: e.target.value })} /></label>
              <label className="field"><span>Min width</span><input className="inp" type="number" value={draft.minWidth} onChange={(e) => setDraft({ ...draft, minWidth: Number(e.target.value) })} /></label>
              <label className="field"><span>Min height</span><input className="inp" type="number" value={draft.minHeight} onChange={(e) => setDraft({ ...draft, minHeight: Number(e.target.value) })} /></label>
              <label className="field"><span>Kind</span><select className="inp" value={draft.purpose} onChange={(e) => setDraft({ ...draft, purpose: e.target.value })}><option value="publishing">Publishing</option><option value="content">Content</option></select></label>
              <label className="aiset-chk"><input type="checkbox" checked={draft.video} onChange={(e) => setDraft({ ...draft, video: e.target.checked })} /> Video</label>
              <label className="aiset-chk"><input type="checkbox" checked={draft.audio} onChange={(e) => setDraft({ ...draft, audio: e.target.checked })} /> Audio</label>
              <button className="btn primary" disabled={!draft.label.trim()} onClick={() => {
                add(draft.key || draft.label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''))
              }}>Add</button>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
