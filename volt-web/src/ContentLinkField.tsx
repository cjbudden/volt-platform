// ============================================================================
//  CONTENT-LINK FIELD: a metadata field that points at another library record
//  (services/contentLinks.ts on the server). Replaces the free-text box that
//  "Trailer for" used to be.
//
//  Three states, each drawn differently so they are never confused:
//    LINKED       {id, name}: the record, its type, and Change / Remove.
//    NAME ONLY    {name}: a dashed outline and "Not linked to a record", with
//                 the suggestions the matcher found and Find the record.
//    EMPTY        a search box over the library by name, with "Keep as a name"
//                 when nothing fits.
//  The value is part of the form: it is saved with the rest of the metadata,
//  and the server checks the id (same account, not itself, no loop back).
// ============================================================================
import { useEffect, useId, useMemo, useRef, useState } from 'react'
import type { SchemaField } from './api'
import { libraryApi, type LinkCandidate, type OutgoingLink } from './pages/vod/libraryApi'
import './contentLink.css'

type Value = { id?: string; name: string } | null

const s = { viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const, 'aria-hidden': true }
const I = {
  link: <svg {...s}><path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1" /><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1" /></svg>,
  unlinked: <svg {...s}><path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1" strokeDasharray="2.5 2.5" /><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1" strokeDasharray="2.5 2.5" /></svg>,
  search: <svg {...s}><circle cx="11" cy="11" r="6" /><path d="M20 20l-4.2-4.2" /></svg>,
  close: <svg {...s}><path d="M6 6l12 12M18 6L6 18" /></svg>,
  auto: <svg {...s}><path d="M12 3l1.8 4.7L18.5 9.5l-4.7 1.8L12 16l-1.8-4.7L5.5 9.5l4.7-1.8z" /><path d="M19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8z" /></svg>,
}

export function linkValueOf(v: any): Value {
  if (v == null || v === '') return null
  if (typeof v === 'string') return v.trim() ? { name: v.trim() } : null
  if (typeof v === 'object') return v.id ? { id: String(v.id), name: String(v.name ?? '') } : v.name ? { name: String(v.name) } : null
  return null
}

const pct = (n: number) => `${Math.round(n * 100)}%`

export function ContentLinkField({ field, value, onChange, assetId, link }: {
  field: SchemaField
  value: any
  onChange: (v: Value) => void
  /** The asset being edited: left out of the results, and its suggestions shown. */
  assetId?: string
  /** What the server knows about this link (source, reasons, suggestions), when the asset exists. */
  link?: OutgoingLink | null
}) {
  const v = linkValueOf(value)
  const [searching, setSearching] = useState(false)
  const [q, setQ] = useState('')
  const [items, setItems] = useState<LinkCandidate[] | null>(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [active, setActive] = useState(-1)
  const listId = useId()
  const inputRef = useRef<HTMLInputElement>(null)
  const label = field.label || field.key

  // The server's record of this link is for the saved value; once the person changes it here, it no longer applies.
  const known = link && v && ((v.id && link.asset?.id === v.id) || (!v.id && link.state === 'unresolved' && link.name === v.name)) ? link : null
  const suggestions = !v?.id ? (known?.candidates ?? link?.candidates ?? []) : []

  useEffect(() => {
    if (!searching) return
    const text = q.trim()
    if (!text) { setItems(null); return }
    let gone = false
    setBusy(true)
    const t = setTimeout(() => {
      libraryApi.linkCandidates(text, { forId: assetId, field: field.key })
        .then((r) => { if (!gone) { setItems(r.items); setErr(''); setActive(r.items.length ? 0 : -1) } })
        .catch((e) => { if (!gone) setErr(e.message) })
        .finally(() => { if (!gone) setBusy(false) })
    }, 220)
    return () => { gone = true; clearTimeout(t) }
  }, [q, searching, assetId, field.key])

  function startSearch(prefill = '') {
    setSearching(true); setQ(prefill); setItems(null); setErr('')
    setTimeout(() => inputRef.current?.focus(), 0)
  }
  function choose(c: { id: string; title: string }) { onChange({ id: c.id, name: c.title }); setSearching(false); setQ('') }
  function keepName() { const n = q.trim(); if (!n) return; onChange({ name: n }); setSearching(false); setQ('') }
  const options = useMemo(() => [...(items ?? []).map((c) => ({ kind: 'rec' as const, c })), ...(q.trim() ? [{ kind: 'name' as const, c: null }] : [])], [items, q])
  function onKey(e: React.KeyboardEvent) {
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive((a) => Math.min(options.length - 1, a + 1)) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => Math.max(0, a - 1)) }
    else if (e.key === 'Enter') { e.preventDefault(); const o = options[active]; if (o?.kind === 'rec') choose(o.c); else if (o?.kind === 'name') keepName() }
    else if (e.key === 'Escape') { e.preventDefault(); setSearching(false) }
  }

  const how = known?.source === 'auto' ? `Linked automatically${known.confidence != null ? `, ${pct(known.confidence)} sure` : ''}` : known?.source === 'migration' ? 'Linked when the text field was moved over' : null

  return (
    <div className="field cl-field">
      <label htmlFor={searching ? `${listId}-q` : undefined}>{label}{field.required && <span style={{ color: 'var(--warn,#fbbf24)' }}> *</span>}
        {field.epg && <span style={{ marginLeft: 6, fontSize: 'var(--fs-micro)', color: 'var(--faint)', fontWeight: 400 }}>→ EPG {field.epg}</span>}</label>

      {!searching && v?.id && (
        <div className="cl-box cl-linked">
          <span className="cl-ic" aria-hidden="true">{I.link}</span>
          <div className="cl-main">
            <div className="cl-title">{known?.asset?.title ?? v.name ?? 'Linked record'}
              {known?.asset?.contentType && <span className="tag type chan cl-type">{known.asset.contentType.name}</span>}</div>
            <div className="cl-sub">
              <span className="cl-state">Linked</span>
              {how && <span className="cl-how" title={known?.reasons.join(' ')}>{I.auto}{how}</span>}
            </div>
            {known?.reasons?.length ? <details className="cl-why"><summary>Why this record</summary><ul>{known.reasons.map((r, i) => <li key={i}>{r}</li>)}</ul></details> : null}
          </div>
          <div className="cl-acts">
            <button type="button" className="btn ghost" onClick={() => startSearch(known?.asset?.title ?? v.name)}>Change</button>
            <button type="button" className="icon-btn" aria-label={`Remove the ${label} link`} title="Remove" onClick={() => onChange(null)}>{I.close}</button>
          </div>
        </div>
      )}

      {!searching && v && !v.id && (
        <div className="cl-box cl-name">
          <span className="cl-ic" aria-hidden="true">{I.unlinked}</span>
          <div className="cl-main">
            <div className="cl-title">{v.name}</div>
            <div className="cl-sub"><span className="cl-state warn">Not linked to a record</span>
              {known?.source === 'auto' && <span className="cl-how">{I.auto}Name from the file name</span>}</div>
            {known?.reasons?.length ? <div className="cl-reason">{known.reasons[0]}</div> : null}
            {suggestions.length > 0 && (
              <div className="cl-sugg" role="group" aria-label="Suggested records">
                <span className="cl-sugg-l">Is it one of these?</span>
                {suggestions.map((c) => (
                  <button key={c.assetId} type="button" className="chip cl-chip" title={c.reasons.join(' ')} onClick={() => choose({ id: c.assetId, title: c.asset?.title ?? c.title })}>
                    {I.link}{c.asset?.title ?? c.title}<span className="cl-score">{pct(c.score)}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
          <div className="cl-acts">
            <button type="button" className="btn ghost" onClick={() => startSearch(v.name)}>{I.search}Find the record</button>
            <button type="button" className="icon-btn" aria-label={`Clear ${label}`} title="Clear" onClick={() => onChange(null)}>{I.close}</button>
          </div>
        </div>
      )}

      {(searching || !v) && (
        <div className="cl-search">
          <div className="cl-input">
            <span className="cl-ic" aria-hidden="true">{I.search}</span>
            <input id={`${listId}-q`} ref={inputRef} role="combobox" aria-expanded={!!(searching && q.trim())} aria-controls={listId} aria-autocomplete="list"
              aria-activedescendant={active >= 0 ? `${listId}-o${active}` : undefined}
              placeholder="Search the library by name" value={q} onFocus={() => setSearching(true)} onChange={(e) => { setSearching(true); setQ(e.target.value) }} onKeyDown={onKey} />
            {searching && v && <button type="button" className="btn ghost" onClick={() => setSearching(false)}>Cancel</button>}
          </div>
          {searching && q.trim() && (
            <ul className="cl-list" role="listbox" id={listId} aria-label={`Records for ${label}`}>
              {busy && !items && <li className="cl-note">Searching…</li>}
              {err && <li className="cl-note warn">{err}</li>}
              {items && items.length === 0 && <li className="cl-note">No record in the library has a name like that.</li>}
              {options.map((o, i) => o.kind === 'rec' ? (
                <li key={o.c.id} id={`${listId}-o${i}`} role="option" aria-selected={i === active} className={i === active ? 'on' : ''}
                  onMouseDown={(e) => e.preventDefault()} onClick={() => choose(o.c)} onMouseEnter={() => setActive(i)} title={o.c.reasons.join(' ')}>
                  <span className="cl-ic" aria-hidden="true">{I.link}</span>
                  <span className="cl-opt-t">{o.c.asset?.title ?? o.c.title}</span>
                  {o.c.asset?.contentType && <span className="tag type chan cl-type">{o.c.asset.contentType.name}</span>}
                  <span className="cl-score">{pct(o.c.score)}</span>
                </li>
              ) : (
                <li key="name" id={`${listId}-o${i}`} role="option" aria-selected={i === active} className={`cl-keep${i === active ? ' on' : ''}`}
                  onMouseDown={(e) => e.preventDefault()} onClick={keepName} onMouseEnter={() => setActive(i)}>
                  <span className="cl-ic" aria-hidden="true">{I.unlinked}</span>
                  <span className="cl-opt-t">Keep "{q.trim()}" as a name, not linked to a record</span>
                </li>
              ))}
            </ul>
          )}
          {!searching && !v && <div className="hintxt">Link the record this points at, or keep a name until that record is in the library.</div>}
        </div>
      )}
    </div>
  )
}
