// CUSTOMISABLE PAGE LAYOUT (22 Oct 2026, option A: saved in this browser).
//
// Each person arranges the panels on a key page (channel, station) the way they
// work: move them up and down, between columns where the page has two, hide
// the ones they never read and minimise the ones they only glance at. Saved
// per user and per page in this browser's storage; "Reset to default" puts the
// page back. Nothing is stored on the server, so another browser or device
// starts from the default.
//
// WHAT NEVER MOVES: the page header and its actions, the pipeline strip and the
// failure banners stay above, and Remove stays at the foot. Those are fixed by
// the page, outside this component, so a warning is always where people look
// and Remove can never be dragged next to Start.
//
// A hidden panel is not mounted, so it makes no requests (a hidden viewers
// chart stops its live feed). A minimised panel is a slim bar with its name.
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import { useAccess } from './access'

export type Zone = 'left' | 'right' | 'full'
export interface PanelDef { id: string; label: string; zone?: Zone; node: ReactNode }
interface Saved { v: 1; zones: Record<Zone, string[]>; hidden: string[]; min: string[] }

const ZONES: Zone[] = ['left', 'right', 'full']
const ZONE_LABEL: Record<Zone, string> = { left: 'Left column', right: 'Right column', full: 'Full width' }

function defaults(panels: PanelDef[]): Saved {
  const zones: Record<Zone, string[]> = { left: [], right: [], full: [] }
  for (const p of panels) zones[p.zone ?? 'full'].push(p.id)
  return { v: 1, zones, hidden: [], min: [] }
}

/** Saved layout merged with today's panels: unknown ids dropped, new ones placed where the default puts them. */
function merge(saved: Saved | null, panels: PanelDef[], twoCol: boolean): Saved {
  const def = defaults(panels)
  if (!saved || saved.v !== 1) return def
  const known = new Set(panels.map(p => p.id))
  const zones: Record<Zone, string[]> = { left: [], right: [], full: [] }
  for (const z of ZONES) zones[z] = (saved.zones?.[z] ?? []).filter(id => known.has(id))
  if (!twoCol) { zones.full = [...zones.left, ...zones.right, ...zones.full]; zones.left = []; zones.right = [] }
  const placed = new Set(ZONES.flatMap(z => zones[z]))
  for (const p of panels) {
    if (placed.has(p.id)) continue
    const z = twoCol ? (p.zone ?? 'full') : 'full'
    const order = def.zones[p.zone ?? 'full']
    const prev = order.slice(0, order.indexOf(p.id)).reverse().find(id => zones[z].includes(id))
    const at = prev ? zones[z].indexOf(prev) + 1 : 0
    zones[z].splice(at, 0, p.id)
    placed.add(p.id)
  }
  return { v: 1, zones, hidden: (saved.hidden ?? []).filter(id => known.has(id)), min: (saved.min ?? []).filter(id => known.has(id)) }
}

function read(key: string): Saved | null {
  try { const t = localStorage.getItem(key); return t ? JSON.parse(t) : null } catch { return null }
}
function write(key: string, s: Saved | null) {
  try { if (s) localStorage.setItem(key, JSON.stringify(s)); else localStorage.removeItem(key) } catch { /* private mode: the layout lasts for this visit */ }
}

/** Lets a panel offer its own minimise button (Output URLs does). */
const PanelCtx = createContext<{ minimise: () => void } | null>(null)
export function usePanelControls() { return useContext(PanelCtx) }

const IC = {
  grip: <svg viewBox="0 0 24 24" fill="currentColor"><circle cx="9" cy="6" r="1.6" /><circle cx="15" cy="6" r="1.6" /><circle cx="9" cy="12" r="1.6" /><circle cx="15" cy="12" r="1.6" /><circle cx="9" cy="18" r="1.6" /><circle cx="15" cy="18" r="1.6" /></svg>,
  up: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"><path d="m6 15 6-6 6 6" /></svg>,
  down: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"><path d="m6 9 6 6 6-6" /></svg>,
  min: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"><path d="M5 12h14" /></svg>,
  expand: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"><path d="m6 9 6 6 6-6" /></svg>,
  eye: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z" /><circle cx="12" cy="12" r="3" /></svg>,
  eyeOff: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 3l18 18M10.6 10.6a2 2 0 002.8 2.8M9.9 5.1A10 10 0 0112 5c6.5 0 10 7 10 7a17 17 0 01-3.2 4.2M6.1 6.1C3.6 7.8 2 12 2 12s3.5 7 10 7c1.8 0 3.4-.5 4.8-1.2" /></svg>,
  layout: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="3" width="18" height="18" rx="2" /><path d="M3 9h18M9 21V9" /></svg>,
}

export function PanelLayout({ pageKey, panels, twoCol = false }: { pageKey: string; panels: PanelDef[]; twoCol?: boolean }) {
  const { me } = useAccess()
  const key = `volt.layout.v1.${me?.id ?? 'anon'}.${pageKey}`
  const sig = panels.map(p => `${p.id}:${p.zone ?? 'full'}`).join(',')
  const [saved, setSaved] = useState<Saved | null>(() => read(key))
  useEffect(() => { setSaved(read(key)) }, [key])
  const lay = useMemo(() => merge(saved, panels, twoCol), [saved, sig, twoCol])  // eslint-disable-line react-hooks/exhaustive-deps
  const [editing, setEditing] = useState(false)
  const [drag, setDrag] = useState<string | null>(null)
  const byId = new Map(panels.map(p => [p.id, p]))
  const customised = saved != null

  const save = (s: Saved) => { setSaved(s); write(key, s) }
  const update = (f: (s: Saved) => void) => {
    const s: Saved = { v: 1, zones: { left: [...lay.zones.left], right: [...lay.zones.right], full: [...lay.zones.full] }, hidden: [...lay.hidden], min: [...lay.min] }
    f(s); save(s)
  }
  const zoneOf = (id: string) => ZONES.find(z => lay.zones[z].includes(id))!
  const move = (id: string, dir: -1 | 1) => update(s => {
    const z = zoneOf(id); const a = s.zones[z]; const i = a.indexOf(id); const j = i + dir
    if (j < 0 || j >= a.length) return
    ;[a[i], a[j]] = [a[j], a[i]]
  })
  const toZone = (id: string, z: Zone, before?: string) => update(s => {
    for (const k of ZONES) s.zones[k] = s.zones[k].filter(x => x !== id)
    const a = s.zones[z]; const at = before ? a.indexOf(before) : -1
    if (at >= 0) a.splice(at, 0, id); else a.push(id)
  })
  const toggle = (list: 'hidden' | 'min', id: string, on?: boolean) => update(s => {
    const has = s[list].includes(id); const want = on ?? !has
    s[list] = want ? (has ? s[list] : [...s[list], id]) : s[list].filter(x => x !== id)
  })
  const reset = () => { setSaved(null); write(key, null) }

  const renderPanel = (id: string, z: Zone) => {
    const p = byId.get(id); if (!p) return null
    const hidden = lay.hidden.includes(id), min = lay.min.includes(id)
    if (!editing) {
      if (hidden) return null
      if (min) return (
        <div key={id} className="pl-min">
          <span className="pl-min-t">{p.label}</span>
          <button type="button" className="pl-ib" onClick={() => toggle('min', id, false)} aria-label={`Expand ${p.label}`} title="Expand">{IC.expand}<span>Expand</span></button>
        </div>
      )
      return <PanelCtx.Provider key={id} value={{ minimise: () => toggle('min', id, true) }}><div className="pl-panel">{p.node}</div></PanelCtx.Provider>
    }
    const list = lay.zones[z]; const i = list.indexOf(id)
    return (
      <div key={id} className={`pl-edit${hidden ? ' is-hidden' : ''}${drag === id ? ' is-drag' : ''}`}
        draggable onDragStart={e => { setDrag(id); e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', id) }}
        onDragEnd={() => setDrag(null)}
        onDragOver={e => { if (drag && drag !== id) e.preventDefault() }}
        onDrop={e => {
          e.preventDefault(); const src = drag ?? e.dataTransfer.getData('text/plain'); setDrag(null)
          if (!src || src === id) return
          const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
          const after = e.clientY > r.top + r.height / 2
          const next = after ? list[i + 1] : id
          toZone(src, z, next && next !== src ? next : undefined)
        }}>
        <div className="pl-bar">
          <span className="pl-grip" title="Drag to move">{IC.grip}</span>
          <b className="pl-label">{p.label}</b>
          {hidden && <span className="pl-tag">Hidden</span>}
          {!hidden && min && <span className="pl-tag">Minimised</span>}
          <span style={{ flex: 1 }} />
          <button type="button" className="pl-ib" disabled={i === 0} onClick={() => move(id, -1)} aria-label={`Move ${p.label} up`} title="Move up">{IC.up}</button>
          <button type="button" className="pl-ib" disabled={i === list.length - 1} onClick={() => move(id, 1)} aria-label={`Move ${p.label} down`} title="Move down">{IC.down}</button>
          {twoCol && (
            <select className="inp pl-zone" value={z} onChange={e => toZone(id, e.target.value as Zone)} aria-label={`Where ${p.label} goes`}>
              {ZONES.map(k => <option key={k} value={k}>{ZONE_LABEL[k]}</option>)}
            </select>
          )}
          <button type="button" className="pl-ib" disabled={hidden} onClick={() => toggle('min', id)} aria-pressed={min} title={min ? 'Show in full' : 'Minimise'}>{min ? IC.expand : IC.min}<span>{min ? 'Expand' : 'Minimise'}</span></button>
          <button type="button" className="pl-ib" onClick={() => toggle('hidden', id)} aria-pressed={hidden} title={hidden ? 'Show' : 'Hide'}>{hidden ? IC.eye : IC.eyeOff}<span>{hidden ? 'Show' : 'Hide'}</span></button>
        </div>
        {!hidden && !min && <div className="pl-peek" aria-hidden>{p.node}</div>}
      </div>
    )
  }
  const zoneBox = (z: Zone) => (
    <div className={`pl-zone-stack${editing ? ' editing' : ''}`}
      onDragOver={e => { if (drag && editing) e.preventDefault() }}
      onDrop={e => { if (!drag || e.target !== e.currentTarget) return; e.preventDefault(); toZone(drag, z); setDrag(null) }}>
      {lay.zones[z].map(id => renderPanel(id, z))}
      {editing && lay.zones[z].length === 0 && <div className="pl-empty">Drop a panel here</div>}
    </div>
  )

  return (
    <div className="pl-root">
      <div className={`pl-tools${editing ? ' editing' : ''}`}>
        {editing ? <>
          <span className="pl-hint">Drag panels, or use the arrows. Saved in this browser for you.</span>
          <span style={{ flex: 1 }} />
          {customised && <button type="button" className="btn ghost" onClick={reset}>Reset to default</button>}
          <button type="button" className="btn primary" onClick={() => setEditing(false)}>Done</button>
        </> : <>
          <span style={{ flex: 1 }} />
          <button type="button" className="pl-open" onClick={() => setEditing(true)}>{IC.layout}Customise layout{customised ? ' · yours' : ''}</button>
        </>}
      </div>
      {twoCol && (lay.zones.left.length || lay.zones.right.length || editing) ? (
        <div className="grid-2 pl-cols" style={{ alignItems: 'start' }}>
          {zoneBox('left')}
          {zoneBox('right')}
        </div>
      ) : null}
      {zoneBox('full')}
    </div>
  )
}
