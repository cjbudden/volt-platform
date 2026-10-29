// Small pieces shared by the grid cards and the table: the keyscreen, the
// availability pill, the metadata completeness meter and the encode summary.
import { useState, type ReactElement } from 'react'
import { thumbUrl } from '../../api'
import { signImage } from '../../imageSigning'
import { posterVersion } from './useLibraryChanges'
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
  if (r.poster_key) {
    // Versioned by when it was picked: choosing another image (even one saved at the same
    // path) is a new URL, so the card shows it at once instead of a cached copy.
    const key = String(r.poster_key).replace(/^\/+/, ''), v = posterVersion((r as any).poster_picked_at)
    return signImage(`${w}x${h},${r.poster_shape === 'square' ? 'inside' : 'cover'}${v ? `,v=${v}` : ''}`, key)
      ?? thumbUrl(`/${key}`, w, h, r.poster_shape === 'square' ? 'inside' : 'cover')
  }
  const m = r.metadata ?? {}
  const img = m.image ?? m.thumbnail ?? m.artwork ?? null
  return typeof img === 'string' && /^(https?:)?\//.test(img) ? (img.startsWith('/library/') ? thumbUrl(img, w, h) : img) : null
}

/**
 * THE COLOUR KEY: an asset with no image yet is filled with its kind's colour,
 * so a grid of placeholders still reads at a glance (legend: KindLegend).
 */
export type MediaKind = 'video' | 'audio' | 'music'
export const KIND_LABEL: Record<MediaKind, string> = { video: 'Video', audio: 'Audio', music: 'Song' }
export const KIND_ICON: Record<MediaKind, ReactElement> = { video: LibIcon.media, audio: LibIcon.wave, music: LibIcon.audio }
/** What the asset is, top right of the card: Video, Audio, or Song (audio that is a song). */
export function KindBadge({ row }: { row: LibraryRow }) {
  const k = kindOf(row)
  return <span className={`lib-badge lib-badge-kind kind-${k}`} title={KIND_LABEL[k]}>{KIND_ICON[k]}{KIND_LABEL[k]}</span>
}
export const kindOf = (r: LibraryRow): MediaKind => r.media_kind ?? (r.audio_only ? 'audio' : 'video')
export function KindLegend() {
  return (
    <div className="lib-kind-legend" aria-label="Colour key for assets without an image">
      <span className="lib-faint">No image yet:</span>
      {(['video', 'audio', 'music'] as MediaKind[]).map((k) => <span key={k} className="lib-kind-key"><i className={`kind-${k}`} />{KIND_LABEL[k]}</span>)}
    </div>
  )
}

/**
 * Square artwork (an album cover, a station's logo) is drawn whole in the
 * middle of the 16:9 frame over a blurred, dimmed copy of itself, so a grid
 * of radio and video assets keeps one card shape and no cover is cropped.
 */
export function Keyscreen({ row, w, h, className }: { row: LibraryRow; w: number; h: number; className?: string }) {
  const square = row.poster_shape === 'square'
  const src = posterSrc(row, square ? h : w, h)
  const [broken, setBroken] = useState(false)
  return (
    <div className={`lib-thumb ${square ? 'square' : ''} ${className ?? ''}`}>
      {src && !broken ? (square ? <>
          <img className="lib-thumb-bg" src={src} alt="" aria-hidden="true" loading="lazy" decoding="async" />
          <img className="lib-thumb-sq" src={src} alt="" loading="lazy" decoding="async" width={h} height={h} onError={() => setBroken(true)} />
        </> : <img src={src} alt="" loading="lazy" decoding="async" width={w} height={h} onError={() => setBroken(true)} />)
        : <span className={`lib-thumb-ph kind-${kindOf(row)}`} aria-hidden="true">{KIND_ICON[kindOf(row)]}<span className="lib-thumb-ph-t">{KIND_LABEL[kindOf(row)]}</span></span>}
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
  // NO MEDIA, NO RENDITIONS. A failed clip read "1080p · 2 renditions" from
  // its channel's ladder while nothing had been built.
  const u = row.usage_status
  if (u === 'failed' || u === 'no_media' || u === 'unplayable') {
    return <span className="lib-enc bad" title={row.media_error ?? undefined}>{LibIcon.alert}{u === 'failed' ? 'Build failed' : u === 'unplayable' ? 'Will not play' : 'No media'}</span>
  }
  if (u === 'processing' && !row.encode_state) return <span className="lib-enc busy">{LibIcon.clock}Building</span>
  if (row.encode_state === 'queued' || row.encode_state === 'running') {
    return <span className="lib-enc busy">{LibIcon.clock}{row.encode_state === 'queued' ? 'Queued to encode' : `Encoding ${row.encode_pct ?? 0}%`}</span>
  }
  if (row.encode_state === 'failed') return <span className="lib-enc bad">{LibIcon.alert}Encode failed</span>
  // Audio has no picture to describe: say so (the Encode tab has the bitrate and the deliveries).
  if (kindOf(row) !== 'video' && !row.top_height) return <span className="lib-enc">{LibIcon.audio}Audio only{row.has_mp3 ? ' · MP3' : ''}</span>
  const parts = [resLabel(row.top_height), codecLabel(row.video_codec), row.rendition_count ? `${row.rendition_count} renditions` : ''].filter(Boolean)
  if (!parts.length) return <span className="lib-enc none">Encode not known</span>
  return <span className="lib-enc">{LibIcon.encode}{parts.join(' · ')}</span>
}

export function TypeLabel({ row }: { row: LibraryRow }) {
  if (!row.schema_name) return <span className="lib-type none">No type</span>
  return <span className="tag type lib-type" title={row.schema_org_type ? `schema.org ${row.schema_org_type}` : undefined}>{row.schema_name}</span>
}
