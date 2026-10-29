// ============================================================================
//  FIND MEDIA for a FAST run order: the Media Library's own search, filters
//  and collections (pages/vod), in a dialog beside the builder.
//
//  Every filter the library has (type, genre / content type, duration,
//  resolution, codec, dates, metadata, status...) plus the collection rail,
//  over GET /api/vod. Results the channel can air (its media, ready to air:
//  the builder's own library) can be ticked and added in one go, as new slots
//  or as alternates to the slot being edited. The rest are shown greyed with
//  the reason, so a missing title is never a mystery.
// ============================================================================
import { useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { libraryApi, type LibraryFacets, type LibraryRow } from '../pages/vod/libraryApi'
import { EMPTY_FILTERS, SORTS, filtersToApi, type LibraryFilters, type SortKey } from '../pages/vod/libraryQuery'
import { LibraryFilterPanel } from '../pages/vod/LibraryFilters'
import { CollectionTree, ColIcon, collectionsApi, useCollections } from '../pages/vod/collections'
import type { FastMedia, LibAsset } from './fastApi'

const fmt = (ms: number | null | undefined) => { const s = Math.round((ms ?? 0) / 1000); const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s % 60; return h ? `${h}h ${m}m` : `${m}m ${String(x).padStart(2, '0')}s` }

export function FindMediaDialog({ media, airable, picking, onAdd, onClose, below, onShowAll }: {
  media: FastMedia
  /** titles the channel's ladder leaves out, with why (fast.ts /library belowLadder) */
  below?: { id: string; why: string | null }[]
  /** offer them anyway (the Library's "Show anyway") */
  onShowAll?: () => void
  /** the builder's library: what this channel can air, by id */
  airable: Map<string, LibAsset>
  /** the name of the slot taking alternates, if one is */
  picking: string | null
  onAdd: (assets: LibAsset[]) => void
  onClose: () => void
}) {
  // THE CHANNEL'S MEDIA ONLY: a video channel is offered video, an audio
  // channel audio and songs. The filter can narrow inside that, never leave it.
  const allowed = media === 'audio' ? ['audio', 'song'] : ['video']
  const [f, setF] = useState<LibraryFilters>({ ...EMPTY_FILTERS, media: allowed, status: ['ready'] })
  const inMedia = f.media.filter((m) => allowed.includes(m))
  const eff: LibraryFilters = { ...f, media: inMedia.length ? inMedia : allowed }
  const [q, setQ] = useState('')
  const [rows, setRows] = useState<LibraryRow[] | null>(null)
  const [total, setTotal] = useState<number | null>(null)
  const [next, setNext] = useState<string | null>(null)
  const [facets, setFacets] = useState<LibraryFacets | null>(null)
  const [err, setErr] = useState('')
  const [sel, setSel] = useState<string[]>([])
  const [showFilters, setShowFilters] = useState(true)
  const cols = useCollections()
  useEffect(() => { const t = setTimeout(() => setF((x) => (x.q === q ? x : { ...x, q })), 300); return () => clearTimeout(t) }, [q])
  const qs = filtersToApi(eff, { limit: 60 })
  useEffect(() => {
    let gone = false
    setRows(null)
    libraryApi.page(qs).then((p) => { if (!gone) { setRows(p.rows); setTotal(p.total); setNext(p.next); setErr('') } }).catch((e) => { if (!gone) setErr(e.message) })
    libraryApi.facets(filtersToApi(eff, { facets: true })).then((x) => { if (!gone) setFacets(x) }).catch(() => {})
    return () => { gone = true }
  }, [qs])
  const more = async () => { if (!next) return; const p = await libraryApi.page(`${qs}&cursor=${encodeURIComponent(next)}`); setRows((r) => [...(r ?? []), ...p.rows]); setNext(p.next) }
  const can = (r: LibraryRow) => airable.has(r.id)
  const why = (r: LibraryRow) => {
    const isAudio = (r as any).media_type === 'audio' || (r as any).media_type === 'song'
    if ((media === 'audio') !== isAudio) return media === 'audio' ? 'video: this is an audio channel' : 'audio: this is a video channel'
    if ((r as any).usage_status && (r as any).usage_status !== 'ready') return 'not ready to air (Media Library > Status)'
    const b = below?.find((x) => x.id === r.id)
    if (b) return `below the channel's ladder: ${b.why ?? 'it cannot fill the top rendition'}`
    return 'no usable source to prepare it from'
  }
  const pickable = (rows ?? []).filter(can)
  const toggle = (id: string) => setSel((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]))
  const allOn = pickable.length > 0 && pickable.every((r) => sel.includes(r.id))
  const chosen = useMemo(() => sel.map((id) => airable.get(id)).filter(Boolean) as LibAsset[], [sel, airable])
  // a whole collection, in its own order
  const addCollection = async () => {
    if (!f.col) return
    const r = await collectionsApi.items(f.col, f.colDeep)
    const list = r.items.map((i) => airable.get(i.id)).filter(Boolean) as LibAsset[]
    onAdd(list); onClose()
  }
  const colName = cols.rows?.find((c) => c.id === f.col)?.name
  // TO document.body: the dialog is opened from the Library card, which is
  // position: sticky and so its own stacking context; rendered in place, page
  // content after it (the run order's notices) painted over the dialog.
  return createPortal(
    <div className="drawer-scrim" onClick={(e) => { if (e.target === e.currentTarget) onClose() }} style={{ alignItems: 'center', justifyContent: 'center' }}>
      <div className="card fm" role="dialog" aria-modal="true" aria-labelledby="fm-t" onKeyDown={(e) => { if (e.key === 'Escape') onClose() }}>
        <div className="fm-h">
          <h3 id="fm-t">Find media</h3>
          <span className="sub">{picking ? <>adding alternates to <b>{picking}</b></> : 'adding to the end of the run order'} · {media === 'audio' ? 'audio and songs only (an audio channel)' : 'video only (a video channel)'}</span>
          <span className="spacer" />
          <button className="fast-ico" aria-label="Close" onClick={onClose}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"><path d="M6 6l12 12M18 6 6 18" /></svg></button>
        </div>
        <div className="fm-body">
          <aside className="fm-rail" aria-label="Collections">
            <div className="lib-rail-h">Collections</div>
            <div className={`col-row compact${!f.col ? ' on' : ''}`} onClick={() => setF({ ...f, col: '' })} tabIndex={0}><span className="col-tw" />{ColIcon.all}<span className="col-nm">All media</span></div>
            <CollectionTree compact tree={cols.tree} selected={f.col || null} onSelect={(c) => setF({ ...f, col: c.id })} />
            {f.col && <label className="fm-deep"><input type="checkbox" checked={f.colDeep} onChange={(e) => setF({ ...f, colDeep: e.target.checked })} /> Include sub-collections</label>}
          </aside>
          <div className="fm-main">
            <div className="fm-bar">
              <input className="inp" autoFocus placeholder="Search titles, descriptions, sources…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search the library" />
              <select className="inp" value={f.sort} onChange={(e) => setF({ ...f, sort: e.target.value as SortKey })} aria-label="Sort by" style={{ width: 'auto' }}>
                {SORTS.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
              </select>
              <button className={`btn ghost sm${showFilters ? ' active' : ''}`} onClick={() => setShowFilters((v) => !v)} aria-pressed={showFilters}>Filters</button>
            </div>
            {showFilters && <div className="fm-filters"><LibraryFilterPanel filters={eff} onChange={setF} facets={facets} mediaOnly={allowed} /></div>}
            {f.col && <div className="fm-col">{ColIcon.folder}<b>{colName}</b><span className="spacer" />
              <button className="btn ghost sm" onClick={addCollection} title="Every airable item of the collection, in the collection's own order">Add the whole collection in its order</button></div>}
            <div className="fm-list" role="list">
              {err ? <div className="hintxt" style={{ padding: 14 }}>{err}</div>
                : !rows ? <div className="loading">Searching…</div>
                : !rows.length ? <div className="hintxt" style={{ padding: 14 }}>Nothing matches. Loosen a filter, or search all media.</div>
                : <>
                  <label className="fm-row head"><input type="checkbox" checked={allOn} disabled={!pickable.length}
                    onChange={() => setSel(allOn ? sel.filter((id) => !pickable.some((r) => r.id === id)) : [...new Set([...sel, ...pickable.map((r) => r.id)])])} />
                    <span>{total != null ? `${total} found` : `${rows.length} shown`}{pickable.length < rows.length ? ` · ${rows.length - pickable.length} can't air here` : ''}</span></label>
                    {onShowAll && rows.some((r) => below?.some((b) => b.id === r.id)) && <div className="hintxt" style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 14px', borderBottom: '1px solid var(--border)' }}>
                      <span style={{ flex: 1 }}>Some titles are below the channel's ladder (hover one to see why). They can still go on, scaled up to fill its top rendition.</span>
                      <button type="button" className="btn ghost sm" onClick={onShowAll}>Include them</button></div>}
                  {rows.map((r) => {
                    const ok = can(r); const a = airable.get(r.id)
                    return (
                      <label key={r.id} role="listitem" className={`fm-row${ok ? '' : ' off'}${sel.includes(r.id) ? ' on' : ''}`} title={ok ? undefined : `Can't air on this channel: ${why(r)}`}>
                        <input type="checkbox" disabled={!ok} checked={sel.includes(r.id)} onChange={() => toggle(r.id)} />
                        <div className="tt"><div className="nm">{r.title || 'Untitled'}</div>
                          <div className="meta">{[(r as any).schema_name, a?.genre, a?.series ? `${a.series}${a.season != null ? ` S${a.season}` : ''}${a.episode != null ? `E${a.episode}` : ''}` : null, ok ? null : why(r)].filter(Boolean).join(' · ')}</div></div>
                        <span className="du">{fmt(r.duration_ms as any)}</span>
                      </label>
                    )
                  })}
                  {next && <div style={{ padding: 10, textAlign: 'center' }}><button className="btn ghost sm" onClick={more}>Show more</button></div>}
                </>}
            </div>
          </div>
        </div>
        <div className="modal-f" style={{ marginTop: 0, padding: '12px 16px', borderTop: '1px solid var(--border)' }}>
          <span className="hintxt" style={{ margin: 0 }}>{chosen.length ? `${chosen.length} selected, added in the order you ticked them.` : 'Tick media to add.'}</span>
          <div style={{ flex: 1 }} />
          <button className="btn ghost" onClick={onClose}>Cancel</button>
          <button className="btn primary" disabled={!chosen.length} onClick={() => { onAdd(chosen); onClose() }}>
            {picking ? `Add ${chosen.length || ''} as alternates` : `Add ${chosen.length || ''} to the run order`}
          </button>
        </div>
      </div>
    </div>
  , document.body)
}
