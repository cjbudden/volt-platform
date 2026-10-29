import type { MouseEvent, ReactElement } from 'react'
import { navigate } from './router'
import type { ProgrammeMedia, ProgrammeFlag } from './api'

/* ============================================================================
   THE PROGRAMME FLAG: one per guide entry or logged song, the most useful
   thing about it right now. The server decides which (programmeMedia.flagFor
   in volt-app); this only paints it, so the EPG list and day view, the guide
   strip, the Live Streams timeline and the station's metadata log can never
   disagree.

     AUTO VOD     before air: will become a VOD asset once aired   (outlined)
     VOD          an asset exists                     -> opens the asset
                    blue   created, not published (or scheduled to publish)
                    green  published: viewers can watch it
                    grey   expired or withdrawn
     CONVERTING   auto VOD is building it             -> the recording meanwhile
     VOD FAILED   auto VOD failed, recording kept     -> the recording
     REC · 6d     recording kept, no asset, removed in 6 days
                                                      -> the recording, playing
                                                         from the entry's start
                  amber within 2 days of removal; "REC" alone = kept indefinitely
     EXPIRED      it was recorded; the keep period removed it, no VOD  (grey)
     NOT RECORDED no recording ever covered it (recording off, stream down)
     UNAVAILABLE  cannot tell: listed as recorded but the media is missing
                  (these three are grey, with no link)

   No flag at all before air means: it will be recorded, as everything is.
   ========================================================================== */

export function assetHref(id: string) { return `/vod?asset=${encodeURIComponent(id)}` }
/** The workbench with the entry's range marked, playing from its start. */
export function recordingHref(r: { id: string; from: number; to: number }) {
  return `/recordings/${encodeURIComponent(r.id)}?from=${Math.round(r.from)}&to=${Math.round(r.to)}&play=1`
}
/** Where the flag leads, or null when it leads nowhere. */
export function flagHref(f: ProgrammeFlag | null | undefined): string | null {
  if (!f) return null
  if (f.kind === 'vod' && f.assetId) return assetHref(f.assetId)
  if (f.recording && (f.kind === 'rec' || f.kind === 'failed' || f.kind === 'converting')) return recordingHref(f.recording)
  return null
}
/** Kept for callers holding the media block rather than the flag. */
export function mediaHref(m: ProgrammeMedia | null | undefined): string | null { return flagHref(m?.flag) }

export function flagLabel(f: ProgrammeFlag): string {
  switch (f.kind) {
    case 'autovod': return 'Auto VOD'
    case 'vod': return 'VOD'
    case 'converting': return 'Converting'
    case 'failed': return 'VOD failed'
    case 'expired': return 'Expired'
    case 'notrecorded': return 'Not recorded'
    case 'unavailable': return 'Unavailable'
    case 'rec': return `REC${f.daysLeft != null ? ` · ${f.daysLeft}d` : ''}${f.partial ? ' · part' : ''}`
  }
}

const ICON: Partial<Record<ProgrammeFlag['kind'], ReactElement>> = {
  autovod: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" aria-hidden><circle cx="12" cy="12" r="8.5" /><path d="M12 7.5V12l3 2" /></svg>,
  vod: <svg viewBox="0 0 24 24" aria-hidden><path d="M8 5v14l11-7z" fill="currentColor" /></svg>,
}

/**
 * The flag. `link` off inside something already clickable (a timeline block
 * is a button; an anchor inside it would be invalid and steal the click).
 */
export function ProgrammeFlagMark({ flag, link = true, className = '' }: { flag: ProgrammeFlag | null | undefined; link?: boolean; className?: string }) {
  if (!flag) return null
  const href = link ? flagHref(flag) : null
  const cls = `pflag ${flag.kind}${flag.kind === 'vod' ? ` pub-${flag.publish ?? 'draft'}` : ''}${flag.warn ? ' warn' : ''} ${className}`.trim()
  const inner = <>
    {ICON[flag.kind]}
    {(flag.kind === 'rec' || flag.kind === 'failed') && <span className="rec-dot" aria-hidden />}
    {flagLabel(flag)}
  </>
  const title = `${flag.note}${href ? `\n${flag.kind === 'vod' ? 'Click to open the VOD asset.' : 'Click to play the recording from here.'}` : ''}`
  if (!href) return <span className={cls} title={title}>{inner}</span>
  return (
    <a href={href} className={cls} title={title}
      onClick={(e: MouseEvent) => { e.preventDefault(); e.stopPropagation(); navigate(href) }}>{inner}</a>
  )
}

/** Compatibility: the earlier VOD / REC mark, now the flag. */
export function MediaMark({ media }: { media: ProgrammeMedia | null | undefined; compact?: boolean }) {
  return <ProgrammeFlagMark flag={media?.flag} />
}

/** "Removed in 6 days (Sat 31 Oct)", or "Kept indefinitely". `warn` within 2 days. */
export function removalText(expiresAt: string | null | undefined, now = Date.now()): { text: string; short: string; warn: boolean } {
  if (!expiresAt) return { text: 'Kept indefinitely', short: 'kept', warn: false }
  const ms = Date.parse(expiresAt)
  if (!Number.isFinite(ms)) return { text: 'Kept indefinitely', short: 'kept', warn: false }
  const days = Math.ceil((ms - now) / 86_400_000)
  const day = new Date(ms).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' })
  if (days <= 0) return { text: `Due for removal (${day})`, short: 'due', warn: true }
  return { text: `Removed in ${days} day${days === 1 ? '' : 's'} (${day})`, short: `${days}d left`, warn: days <= 2 }
}

/* ----------------------------------------------------------------------------
   THE FLAG AS AN ICON, for tight places (the guide strip's cards). The same
   flag, one glyph, the detail on hover:

     blue clock      Auto VOD set (before air)
     amber clock     converting
     red clock       VOD failed
     grey TV         recording available (amber when it goes within 2 days)
     TV blue/green/grey   VOD: not published / published / restricted
     grey dot        not recorded, expired or unavailable
   -------------------------------------------------------------------------- */
const CLOCK = <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" aria-hidden><circle cx="12" cy="12" r="8.5" /><path d="M12 7.5V12l3 2" /></svg>
const TV = <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" aria-hidden><rect x="3" y="5.5" width="18" height="12" rx="2" /><path d="M8 21h8M12 17.5V21" /></svg>
const DOT = <svg viewBox="0 0 24 24" aria-hidden><circle cx="12" cy="12" r="5" fill="currentColor" /></svg>

export function flagIconTone(f: ProgrammeFlag): { glyph: 'clock' | 'tv' | 'dot'; tone: string } {
  switch (f.kind) {
    case 'autovod': return { glyph: 'clock', tone: 'blue' }
    case 'converting': return { glyph: 'clock', tone: 'amber' }
    case 'failed': return { glyph: 'clock', tone: 'red' }
    case 'rec': return { glyph: 'tv', tone: f.warn ? 'amber' : 'grey' }
    case 'vod': return { glyph: 'tv', tone: f.publish === 'published' ? 'green' : f.publish === 'expired' || f.publish === 'withdrawn' ? 'midgrey' : 'blue' }
    default: return { glyph: 'dot', tone: 'grey' }
  }
}

/** The hover text: the note, led by the flag's name only when the note does not already start with it. */
export function flagTitle(f: ProgrammeFlag): string {
  const label = flagLabel(f)
  const head = label.split(' · ')[0].toLowerCase()
  return f.note.toLowerCase().startsWith(head) ? f.note : `${label}. ${f.note}`
}

export function ProgrammeFlagIcon({ flag }: { flag: ProgrammeFlag | null | undefined }) {
  if (!flag) return null
  const { glyph, tone } = flagIconTone(flag)
  const label = flagLabel(flag)
  return (
    <span className={`pflag-ic ${tone}`} title={flagTitle(flag)} aria-label={label} role="img">
      {glyph === 'clock' ? CLOCK : glyph === 'tv' ? TV : DOT}
    </span>
  )
}
