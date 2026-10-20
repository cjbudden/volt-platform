// Small pieces shared by the grid cards and the table: the keyscreen, the
// availability pill, the metadata completeness meter and the encode summary.
import { useState } from 'react'
import { thumbUrl } from '../../api'
import { LibIcon } from './icons'
import { codecLabel, resLabel } from './libraryQuery'
import type { LibraryRow } from './libraryApi'

export function fmtDur(ms: number | string | null | undefined) {
  const s = Math.round(Number(ms ?? 0) / 1000)
  if (!s) return ''
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), ss = s % 60
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(ss).padStart(2, '0')}` : `${m}:${String(ss).padStart(2, '0')}`
}

/** The keyscreen through the image service, sized for where it is shown. Lazy. */
export function posterSrc(r: LibraryRow, w: number, h: number): string | null {
  if (r.poster_key) return thumbUrl(`/${String(r.poster_key).replace(/^\/+/, '')}`, w, h)
  const m = r.metadata ?? {}
  const img = m.image ?? m.thumbnail ?? m.artwork ?? null
  return typeof img === 'string' && /^(https?:)?\//.test(img) ? (img.startsWith('/library/') ? thumbUrl(img, w, h) : img) : null
}

export function Keyscreen({ row, w, h, className }: { row: LibraryRow; w: number; h: number; className?: string }) {
  const src = posterSrc(row, w, h)
  const [broken, setBroken] = useState(false)
  return (
    <div className={`lib-thumb ${className ?? ''}`}>
      {src && !broken
        ? <img src={src} alt="" loading="lazy" decoding="async" width={w} height={h} onError={() => setBroken(true)} />
        : <span className="lib-thumb-ph" aria-hidden="true">{LibIcon.media}</span>}
    </div>
  )
}

const AVAIL: Record<string, { label: string; cls: string }> = {
  draft: { label: 'Not published', cls: 'idle' },
  scheduled: { label: 'Scheduled', cls: 'sched' },
  available: { label: 'Available', cls: 'live' },
  expired: { label: 'Expired', cls: 'warn' },
  withdrawn: { label: 'Access removed', cls: 'down' },
}
export function AvailabilityPill({ row }: { row: LibraryRow }) {
  const st = row.availability_state ?? (row.published ? 'available' : 'draft')
  const ui = AVAIL[st] ?? AVAIL.draft
  return (
    <span className={`tag ${ui.cls} lib-pill`} title={row.available_until ? `until ${new Date(row.available_until).toLocaleString()}` : undefined}>
      <span className="lib-dot" aria-hidden="true" />{ui.label}
    </span>
  )
}

/** "62%" with a thin bar; a warning icon and word when a required field is empty. */
export function Completeness({ row, compact }: { row: LibraryRow; compact?: boolean }) {
  const pct = row.metadata_completeness
  if (pct == null) {
    return <span className="lib-meta lib-meta-none" title="No content type, so nothing to measure against">{LibIcon.alert}No type</span>
  }
  const missing = !!row.metadata_missing_required
  return (
    <span className={`lib-meta${missing ? ' warn' : pct === 100 ? ' done' : ''}`}
      title={missing ? `${pct}% of the target metadata. A required field is empty.` : `${pct}% of the target metadata`}>
      {missing ? LibIcon.alert : pct === 100 ? LibIcon.check : null}
      <span className="lib-bar" aria-hidden="true"><span style={{ width: `${pct}%` }} /></span>
      <span className="lib-pct">{pct}%</span>
      {!compact && missing && <span className="lib-miss">missing</span>}
    </span>
  )
}

export function EncodeSummary({ row }: { row: LibraryRow }) {
  if (row.encode_state === 'queued' || row.encode_state === 'running') {
    return <span className="lib-enc busy">{LibIcon.clock}{row.encode_state === 'queued' ? 'Queued to encode' : `Encoding ${row.encode_pct ?? 0}%`}</span>
  }
  if (row.encode_state === 'failed') return <span className="lib-enc bad">{LibIcon.alert}Encode failed</span>
  const parts = [resLabel(row.top_height), codecLabel(row.video_codec), row.rendition_count ? `${row.rendition_count} renditions` : ''].filter(Boolean)
  if (!parts.length) return <span className="lib-enc none">Encode not known</span>
  return <span className="lib-enc">{LibIcon.encode}{parts.join(' · ')}</span>
}

export function TypeLabel({ row }: { row: LibraryRow }) {
  if (!row.schema_name) return <span className="lib-type none">No type</span>
  return <span className="tag type lib-type" title={row.schema_org_type ? `schema.org ${row.schema_org_type}` : undefined}>{row.schema_name}</span>
}
