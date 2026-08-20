// ============================================================================
//  Shared page scaffold — the COMMON DESIGN LANGUAGE for list pages
//  (Channels, Events, Recordings, and future sections like Radio).
//
//  Every list page follows the same base structure so actions live in
//  predictable places:
//    1. .page-head     : title + one-line description LEFT, primary "New X"
//                        button RIGHT (always the same spot).
//    2. .filters row   : filter chips with counts LEFT, optional search RIGHT.
//    3. .card > table  : first column = entity identity (thumb + name + group
//                        subtitle), middle columns = contextual data, then a
//                        STATUS pill (tag + dot), and ONE primary action button
//                        right-aligned. Row click opens the entity (detail page
//                        or settings drawer). Destructive actions live INSIDE
//                        the drawer, never on the row.
// ============================================================================
import type { ReactNode } from 'react'

export const THUMB_BG = [
  'linear-gradient(135deg,#7dd3fc,#3f7bff)', 'linear-gradient(135deg,#4ade80,#16a34a)',
  'linear-gradient(135deg,#c4b5fd,#7c3aed)', 'linear-gradient(135deg,#fca5a5,#ef4444)',
  'linear-gradient(135deg,#fdba74,#f97316)',
]

export function initials(name: string) {
  return name.split(/\s+/).slice(0, 2).map(w => w[0]).join('').toUpperCase() || '?'
}

/** Filter chip with a count — the standard list filter control. */
export function FChip({ label, n, on, onClick }: { label: string; n: number; on: boolean; onClick: () => void }) {
  return (
    <div className={`chip ${on ? 'active' : ''}`} onClick={onClick}>
      {label}<span className="ct">{n}</span>
    </div>
  )
}

/** Standard page header: title + description left, primary action right. */
export function PageHead({ title, sub, action }: { title: string; sub: string; action?: ReactNode }) {
  return (
    <div className="page-head">
      <div><h1>{title}</h1><p>{sub}</p></div>
      <div className="spacer" />
      {action}
    </div>
  )
}

/** Standard "New X" primary button for the page head. */
export function NewButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button className="btn primary" onClick={onClick}>
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4"><path d="M12 5v14M5 12h14" /></svg>
      {label}
    </button>
  )
}

/** Entity identity cell: brand image or initials thumb + name + subtitle. */
export function EntityCell({ name, sub, index = 0, imgUrl }: { name: string; sub?: string; index?: number; imgUrl?: string | null }) {
  return (
    <div className="cell-name">
      {imgUrl
        ? <div className="thumb" style={{ background: '#0b0f16', overflow: 'hidden', padding: 0 }}><img src={imgUrl} alt="" style={{ width: '100%', height: '100%', objectFit: 'contain' }} /></div>
        : <div className="thumb" style={{ background: THUMB_BG[index % THUMB_BG.length] }}>{initials(name)}</div>}
      <div>
        <div className="nm">{name}</div>
        <div className="id">{sub || '—'}</div>
      </div>
    </div>
  )
}

/** Status pill (tag + dot) with an optional sub-line, e.g. a countdown. */
export function StatusTag({ label, cls, sub }: { label: string; cls: string; sub?: string }) {
  return (
    <div>
      <span className={`tag ${cls}`}><span className={`dot-s ${cls}`} />{label}</span>
      {sub && <div style={{ fontSize: 11, color: 'var(--faint)', marginTop: 3 }}>{sub}</div>}
    </div>
  )
}
