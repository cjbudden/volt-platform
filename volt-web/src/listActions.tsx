// ============================================================================
//  LIST ACTIONS: the "⋯" row menu, row selection and the bulk action bar.
//
//  Used by the Channels and Radio lists. A row keeps its one primary action
//  (Start / Stop) as a button; everything else (View, Edit settings, Remove)
//  is in the row's "⋯" menu, which is the same height as that button and sits
//  beside it. Ticking rows brings up the bulk bar above the table.
//
//  The menu is positioned `fixed` from the button's rectangle, so a table
//  card that clips its overflow cannot cut it off, and it opens upwards when
//  there is no room below.
// ============================================================================
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'

export interface MenuItem {
  key: string
  label: string
  icon?: ReactNode
  onSelect: () => void
  /** shown, but cannot be chosen; the reason is shown under the label */
  disabledReason?: string | null
  danger?: boolean
  /** a rule above this item */
  separator?: boolean
}

export const Icons = {
  view: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z" /><circle cx="12" cy="12" r="3" /></svg>,
  settings: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="3" /><path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M5.6 18.4l2.1-2.1M16.3 7.7l2.1-2.1" /></svg>,
  remove: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14M10 11v6M14 11v6" /></svg>,
  start: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M7 5v14l12-7z" /></svg>,
  stop: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="6" y="6" width="12" height="12" rx="1" /></svg>,
  more: <svg viewBox="0 0 24 24" fill="currentColor" stroke="none"><circle cx="5" cy="12" r="1.9" /><circle cx="12" cy="12" r="1.9" /><circle cx="19" cy="12" r="1.9" /></svg>,
}

/** The "⋯" button and its menu. */
export function RowMenu({ label, items }: { label: string; items: MenuItem[] }) {
  const [open, setOpen] = useState(false)
  const [pos, setPos] = useState<{ top: number; right: number; up: boolean } | null>(null)
  const btn = useRef<HTMLButtonElement>(null)
  const menu = useRef<HTMLDivElement>(null)

  const place = () => {
    const r = btn.current?.getBoundingClientRect()
    if (!r) return
    const h = menu.current?.offsetHeight ?? 44 * items.length + 12
    const up = r.bottom + h + 8 > window.innerHeight && r.top - h - 8 > 0
    setPos({ top: up ? r.top - h - 6 : r.bottom + 6, right: Math.max(8, window.innerWidth - r.right), up })
  }
  useLayoutEffect(() => { if (open) place() /* eslint-disable-next-line */ }, [open])
  useEffect(() => {
    if (!open) return
    const close = (e: Event) => {
      if (menu.current?.contains(e.target as Node) || btn.current?.contains(e.target as Node)) return
      setOpen(false)
    }
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') { setOpen(false); btn.current?.focus() } }
    const away = () => setOpen(false)
    document.addEventListener('mousedown', close)
    document.addEventListener('keydown', key)
    window.addEventListener('resize', away)
    window.addEventListener('scroll', away, true)
    // first enabled item takes focus, so the keyboard can go straight on
    requestAnimationFrame(() => menu.current?.querySelector<HTMLButtonElement>('button:not([disabled])')?.focus())
    return () => {
      document.removeEventListener('mousedown', close)
      document.removeEventListener('keydown', key)
      window.removeEventListener('resize', away)
      window.removeEventListener('scroll', away, true)
    }
  }, [open])

  function onMenuKey(e: React.KeyboardEvent) {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp' && e.key !== 'Home' && e.key !== 'End') return
    e.preventDefault()
    const all = Array.from(menu.current?.querySelectorAll<HTMLButtonElement>('button:not([disabled])') ?? [])
    if (!all.length) return
    const i = all.indexOf(document.activeElement as HTMLButtonElement)
    const next = e.key === 'Home' ? 0 : e.key === 'End' ? all.length - 1
      : e.key === 'ArrowDown' ? (i + 1) % all.length : (i - 1 + all.length) % all.length
    all[next].focus()
  }

  return (
    <>
      <button ref={btn} type="button" className="btn ghost btn-more" aria-label={label} title={label}
        aria-haspopup="menu" aria-expanded={open} onClick={e => { e.stopPropagation(); setOpen(o => !o) }}>
        {Icons.more}
      </button>
      {open && (
        <div ref={menu} className={`row-menu${pos?.up ? ' up' : ''}`} role="menu" aria-label={label} onKeyDown={onMenuKey}
          onClick={e => e.stopPropagation()}
          style={{ top: pos?.top ?? -9999, right: pos?.right ?? 0, visibility: pos ? 'visible' : 'hidden' }}>
          {items.map(it => (
            <div key={it.key}>
              {it.separator && <div className="row-menu-sep" role="separator" />}
              <button type="button" role="menuitem" className={`row-menu-item${it.danger ? ' danger' : ''}`}
                disabled={!!it.disabledReason} title={it.disabledReason ?? undefined}
                onClick={() => { setOpen(false); it.onSelect() }}>
                {it.icon && <span className="row-menu-ic">{it.icon}</span>}
                <span className="row-menu-txt">
                  {it.label}
                  {it.disabledReason && <small>{it.disabledReason}</small>}
                </span>
              </button>
            </div>
          ))}
        </div>
      )}
    </>
  )
}

/** Selection over a list of ids, pruned when rows go away. */
export function useSelection(ids: string[]) {
  const [sel, setSel] = useState<Set<string>>(new Set())
  const key = ids.join(',')
  useEffect(() => {
    setSel(s => {
      const keep = new Set([...s].filter(id => ids.includes(id)))
      return keep.size === s.size ? s : keep
    })
    // eslint-disable-next-line
  }, [key])
  const toggle = (id: string) => setSel(s => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n })
  const allOn = ids.length > 0 && ids.every(id => sel.has(id))
  const someOn = ids.some(id => sel.has(id))
  const toggleAll = () => setSel(allOn ? new Set() : new Set(ids))
  const clear = () => setSel(new Set())
  return { sel, toggle, toggleAll, allOn, someOn, clear }
}

/** A checkbox cell that does not open the row. */
export function SelectCell({ on, onToggle, label }: { on: boolean; onToggle: () => void; label: string }) {
  return (
    <td className="sel-cell" onClick={e => { e.stopPropagation(); onToggle() }}>
      <input type="checkbox" checked={on} onChange={onToggle} onClick={e => e.stopPropagation()} aria-label={label} />
    </td>
  )
}

export function SelectAllHead({ allOn, someOn, onToggle, label }: { allOn: boolean; someOn: boolean; onToggle: () => void; label: string }) {
  const ref = useRef<HTMLInputElement>(null)
  useEffect(() => { if (ref.current) ref.current.indeterminate = someOn && !allOn }, [someOn, allOn])
  return (
    <th className="sel-cell">
      <input ref={ref} type="checkbox" checked={allOn} onChange={onToggle} aria-label={label} />
    </th>
  )
}

export interface BulkAction {
  key: string
  label: string
  icon?: ReactNode
  /** how many of the selection this applies to; 0 disables it */
  count: number
  onRun: () => void
  danger?: boolean
  /** why it applies to none or only some, shown on hover */
  hint?: string
}

/** The bar above a table while rows are ticked. */
export function BulkBar({ count, noun, actions, onClear, busy }: {
  count: number; noun: [string, string]; actions: BulkAction[]; onClear: () => void; busy?: string | null
}) {
  if (!count) return null
  return (
    <div className="bulk-bar" role="region" aria-label="Bulk actions">
      <span className="bulk-n"><b>{count}</b> {count === 1 ? noun[0] : noun[1]} selected</span>
      {busy ? <span className="bulk-busy" role="status">{busy}</span> : actions.map(a => (
        <button key={a.key} type="button" className={`btn ghost${a.danger ? ' danger' : ''}`} disabled={!a.count} onClick={a.onRun}
          title={a.hint ?? (a.count < count ? `Applies to ${a.count} of the ${count} selected` : undefined)}>
          {a.icon}{a.label}{a.count !== count && a.count > 0 ? ` (${a.count})` : ''}
        </button>
      ))}
      <button type="button" className="btn ghost bulk-clear" onClick={onClear} disabled={!!busy}>Clear</button>
    </div>
  )
}

/** Run one call per id, a few at a time; collect what failed and why. */
export async function runBulk<T extends { id: string; name: string }>(
  rows: T[], fn: (r: T) => Promise<unknown>, onProgress?: (done: number) => void, width = 4,
): Promise<{ ok: T[]; failed: { row: T; reason: string }[] }> {
  const ok: T[] = []; const failed: { row: T; reason: string }[] = []
  let i = 0, done = 0
  async function lane() {
    while (i < rows.length) {
      const r = rows[i++]
      try { await fn(r); ok.push(r) }
      catch (e: any) { failed.push({ row: r, reason: e?.forbidden ? 'not permitted' : (e?.message || 'failed') }) }
      onProgress?.(++done)
    }
  }
  await Promise.all(Array.from({ length: Math.min(width, rows.length) }, lane))
  return { ok, failed }
}

/** "Stopped 3. RTM Sport: not permitted" */
export function bulkSummary(verb: string, res: { ok: { name: string }[]; failed: { row: { name: string }; reason: string }[] }): string {
  const parts: string[] = []
  if (res.ok.length) parts.push(`${verb} ${res.ok.length}.`)
  for (const f of res.failed.slice(0, 5)) parts.push(`${f.row.name}: ${f.reason}.`)
  if (res.failed.length > 5) parts.push(`${res.failed.length - 5} more failed.`)
  return parts.join(' ')
}

/** A plain confirm for non-destructive bulk actions that still disrupt (stop). */
export function ConfirmDialog({ title, body, confirmLabel, danger, onCancel, onConfirm, typeToConfirm }: {
  title: string; body: ReactNode; confirmLabel: string; danger?: boolean; onCancel: () => void; onConfirm: () => void
  /** a phrase to type before the button works (removals): "remove 3", a name */
  typeToConfirm?: string
}) {
  const [typed, setTyped] = useState('')
  const ok = !typeToConfirm || typed.trim().toLowerCase() === typeToConfirm.trim().toLowerCase()
  return (
    <div className="drawer-scrim" onClick={e => { if (e.target === e.currentTarget) onCancel() }} style={{ alignItems: 'center', justifyContent: 'center' }}>
      <div className="card" role="alertdialog" aria-modal="true" aria-labelledby="cfm-t"
        onKeyDown={e => { if (e.key === 'Escape') onCancel() }} style={{ width: 460, maxWidth: 'calc(100vw - 32px)', padding: 20 }}>
        <h3 id="cfm-t" style={{ margin: '0 0 8px' }}>{title}</h3>
        <div style={{ color: 'var(--muted)', fontSize: 'var(--fs-body)' }}>{body}</div>
        {typeToConfirm && (
          <div className="field" style={{ margin: '12px 0 0' }}>
            <label htmlFor="cfm-type">Type <b>{typeToConfirm}</b> to confirm</label>
            <input id="cfm-type" className="inp" autoFocus value={typed} onChange={e => setTyped(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter' && ok) onConfirm() }} autoComplete="off" spellCheck={false} />
          </div>
        )}
        <div className="modal-f">
          <div style={{ flex: 1 }} />
          <button className="btn ghost" onClick={onCancel} autoFocus={!typeToConfirm}>Cancel</button>
          <button className={`btn primary${danger ? ' danger' : ''}`} disabled={!ok} onClick={onConfirm}>{confirmLabel}</button>
        </div>
      </div>
    </div>
  )
}
