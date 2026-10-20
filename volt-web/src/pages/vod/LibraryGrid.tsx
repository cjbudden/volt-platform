// ============================================================================
//  MEDIA LIBRARY GRID: one card per asset.
//
//  The keyscreen (sized by the image service, loaded lazily), the length and
//  the top rendition on it, then the title, the content type, availability,
//  how complete the target metadata is, and the encode summary. The checkbox
//  is the same selection the table uses, so bulk actions work in either view.
//  The card's title is a button: Tab reaches the checkbox then the card,
//  Enter or Space opens it.
// ============================================================================
import type { LibraryRow } from './libraryApi'
import { AvailabilityPill, Completeness, EncodeSummary, Keyscreen, TypeLabel, fmtDur } from './LibraryCells'
import { resLabel } from './libraryQuery'

export function LibraryGrid({ rows, selected, onToggle, onOpen, openId }: {
  rows: LibraryRow[]; selected: Set<string>; onToggle: (id: string) => void; onOpen: (id: string) => void; openId: string | null
}) {
  return (
    <ul className="lib-grid" aria-label="Assets">
      {rows.map((r) => {
        const on = selected.has(r.id)
        const dur = fmtDur(r.duration_ms)
        return (
          <li key={r.id} className={`lib-card${on ? ' on' : ''}${openId === r.id ? ' open' : ''}`}>
            <label className="lib-card-sel" title={on ? 'Deselect' : 'Select'}>
              <input type="checkbox" checked={on} onChange={() => onToggle(r.id)} aria-label={`Select ${r.title || 'Untitled'}`} />
            </label>
            <button type="button" className="lib-card-open" onClick={() => onOpen(r.id)} aria-label={`Open ${r.title || 'Untitled'}`}>
              <Keyscreen row={r} w={480} h={270} />
              {dur && <span className="lib-badge lib-badge-dur">{dur}</span>}
              {r.top_height ? <span className="lib-badge lib-badge-res">{resLabel(r.top_height)}</span> : null}
            </button>
            <div className="lib-card-b">
              <div className="lib-card-t" title={r.title || 'Untitled'}>{r.title || 'Untitled'}</div>
              <div className="lib-card-row">
                <TypeLabel row={r} />
                <AvailabilityPill row={r} />
              </div>
              {r.metadata_completeness != null && (
                <div className="lib-card-row">
                  <Completeness row={r} compact />
                </div>
              )}
              <div className="lib-card-row lib-card-foot">
                <EncodeSummary row={r} />
              </div>
            </div>
          </li>
        )
      })}
    </ul>
  )
}
