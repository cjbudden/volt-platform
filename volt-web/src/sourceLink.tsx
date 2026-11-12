/* ============================================================================
   A RECORDING WEARS ITS SOURCE'S BRAND, AND LEADS BACK TO IT.

   A recording belongs to a channel, a radio station or an event. The pages
   for it (the Recordings list, one source's recordings, one recording) show
   the source's own logo, cut the way its own list cuts it, and offer a way to
   open the source itself. Events have no logo, so they keep their initials.
   ========================================================================== */
import { thumbUrl, type RecordingSourceType } from './api'
import { navigate } from './router'

/** Where the source lives in the console. */
export function sourcePath(type: RecordingSourceType | null | undefined, id: string): string {
  return type === 'event' ? `/events/${id}` : type === 'radio' ? `/radio/${id}` : `/channels/${id}`
}

/** The source's logo as its own list shows it (channels fit inside, stations fill), or null. */
export function sourceLogo(type: RecordingSourceType | null | undefined, brandRef: string | null | undefined, size = 80): string | null {
  if (!brandRef || type === 'event') return null
  return thumbUrl(brandRef, size, size, type === 'radio' ? 'cover' : 'inside')
}

const WORD: Record<RecordingSourceType, string> = { channel: 'channel', radio: 'station', event: 'event' }

/** "Open channel", "Open station" or "Open event": goes to the source this recording belongs to. */
export function OpenSourceButton({ type, id, name }: { type: RecordingSourceType | null | undefined; id: string | null | undefined; name?: string | null }) {
  if (!id) return null
  const word = WORD[type ?? 'channel'] ?? 'channel'
  const href = sourcePath(type, id)
  return (
    <a className="btn ghost" href={href} title={name ? `Open ${name}` : undefined}
      onClick={(e) => { if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return; e.preventDefault(); navigate(href) }}
      style={{ display: 'inline-flex', alignItems: 'center', gap: 6, textDecoration: 'none' }}>
      <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
        <path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" />
      </svg>
      Open {word}
    </a>
  )
}
