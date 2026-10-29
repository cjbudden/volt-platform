// ============================================================================
//  MEDIA LIBRARY GRID: one card per asset.
//
//  The keyscreen (sized by the image service, loaded lazily), the length and
//  what it is (video, audio, song) on it, then the title, the content type, availability,
//  how complete the target metadata is, and the encode summary. The checkbox
//  is the same selection the table uses, so bulk actions work in either view.
//  The card's title is a button: Tab reaches the checkbox then the card,
//  Enter or Space opens it.
// ============================================================================
import { useEffect, useRef } from 'react'
import type { LibraryRow } from './libraryApi'
import { AvailabilityPill, Completeness, EncodeSummary, KindBadge, Keyscreen, TypeLabel, fmtDur } from './LibraryCells'
import { UsageBadge, hasNoMedia } from './AssetStatus'

export function LibraryGrid({ rows, selected, onToggle, onOpen, openId, lastOpenId, fresh }: {
  rows: LibraryRow[]; selected: Set<string>; onToggle: (id: string) => void; onOpen: (id: string) => void; openId: string | null
  /** The card opened last: still marked after the panel closes, and focus goes back to it. */
  lastOpenId?: string | null
  /** Cards that just changed: a short pulse and an "Updated" tag. */
  fresh?: Set<string>
}) {
  const list = useRef<HTMLUListElement | null>(null)
  const wasOpen = useRef<string | null>(null)
  useEffect(() => {
    const card = (id: string) => list.current?.querySelector<HTMLElement>(`[data-asset="${CSS.escape(id)}"]`)
    if (openId) card(openId)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
    // Closed: keyboard focus returns to the card it was opened from.
    else if (wasOpen.current) card(wasOpen.current)?.querySelector<HTMLElement>('.lib-card-open')?.focus({ preventScroll: false })
    wasOpen.current = openId
  }, [openId])
  return (
    <ul className="lib-grid" aria-label="Assets" ref={list}>
      {rows.map((r) => {
        const on = selected.has(r.id)
        const dur = fmtDur(r.duration_ms)
        return (
          <li key={r.id} data-asset={r.id} aria-current={openId === r.id ? 'true' : undefined}
            className={`lib-card${on ? ' on' : ''}${hasNoMedia(r.usage_status) ? ' unusable' : ''}${openId === r.id ? ' open' : !openId && lastOpenId === r.id ? ' last' : ''}${fresh?.has(r.id) ? ' lib-fresh' : ''}`}>
            {openId === r.id ? <span className="lib-card-tag">Open</span>
              : fresh?.has(r.id) ? <span className="lib-card-tag upd">Updated</span>
              : !openId && lastOpenId === r.id ? <span className="lib-card-tag last">Last opened</span> : null}
            <label className="lib-card-sel" title={on ? 'Deselect' : 'Select'}>
              <input type="checkbox" checked={on} onChange={() => onToggle(r.id)} aria-label={`Select ${r.title || 'Untitled'}`} />
            </label>
            <button type="button" className="lib-card-open" onClick={() => onOpen(r.id)} aria-label={`Open ${r.title || 'Untitled'}`}>
              <Keyscreen row={r} w={480} h={270} />
              {dur && <span className="lib-badge lib-badge-dur">{dur}</span>}
              <KindBadge row={r} />
              <UsageBadge row={r} quiet overlay />
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
