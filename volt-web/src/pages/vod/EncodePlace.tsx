// ============================================================================
//  WHERE AN ASSET IS ENCODED (build queue H4-8, HYBRID_SITES.md).
//
//  An item from an Encode at site watchfolder is encoded by a server at the
//  customer's site, which can take hours when the site is busy, so "Building"
//  alone left people wondering whether anything was happening. The server
//  answers `encode_place` (volt-app services/sites/encodePlace.ts): at the
//  site, or in the cloud because the site did not take it in time. This file
//  turns that into the small "At site" tag shown beside the status, and the
//  sentence the asset page shows in its status panel, Facts and Encode tab.
// ============================================================================
import { LibIcon } from './icons'

export interface EncodePlace {
  at: 'site' | 'cloud'
  state: 'site' | 'fallback_waiting' | 'fallback_cloud' | 'fallback_failed'
  siteId: string
  siteName: string | null
  reason: string | null
  error: string | null
}

/** An asset (list row or detail) that may carry the place. */
type WithPlace = { encode_place?: EncodePlace | null; usage_status?: string | null; encode_state?: string | null }

const siteWords = (p: EncodePlace) => p.siteName ? `your site ${p.siteName}` : 'your site'
const sentenceCase = (t: string) => t ? t[0].toUpperCase() + t.slice(1) : t
const stop = (t: string) => /[.!?]$/.test(t) ? t : `${t}.`

/**
 * The sentence for the asset page. `busy` while the encode is still to come or
 * running ("Being encoded ..."), otherwise what happened ("Encoded ...").
 */
export function encodePlaceText(p: EncodePlace, busy: boolean): string {
  if (p.state === 'site') {
    return `${busy ? 'Being encoded' : 'Encoded'} at ${siteWords(p)}. The original stays on your storage; only the finished streams come to Volt.`
  }
  if (p.state === 'fallback_failed') {
    return stop(sentenceCase(p.error ?? 'the site could not send the original for the cloud encode'))
  }
  const why = p.reason ? ` because ${p.reason}` : ''
  if (p.state === 'fallback_waiting') {
    return `Encoded in the cloud${why}. Waiting for ${siteWords(p)} to send the original.`
  }
  return `${busy ? 'Being encoded' : 'Encoded'} in the cloud${why}.`
}

/** Still being made: the place matters most then, so the tag shows only then. */
export const isBusy = (a: WithPlace) => a.usage_status === 'processing' || a.encode_state === 'queued' || a.encode_state === 'running'

/** The tag beside Processing: At site, Sending to cloud or In the cloud. Nothing for other assets. */
export function EncodePlaceTag({ asset }: { asset: WithPlace }) {
  const p = asset.encode_place
  if (!p || !isBusy(asset) || p.state === 'fallback_failed') return null
  const label = p.state === 'site' ? 'At site' : p.state === 'fallback_waiting' ? 'Sending to cloud' : 'In the cloud'
  return (
    <span className="tag type lib-pill lib-place" data-place={p.state} title={encodePlaceText(p, true)}>
      {p.at === 'site' ? LibIcon.site : LibIcon.cloud}{label}
    </span>
  )
}

/** The encode progress words with the place in them: "Encoding at site 40%". */
export function encodeProgressWords(state: string, pct: number | null | undefined, p: EncodePlace | null | undefined): string {
  const where = p?.state === 'site' ? ' at site' : ''
  return state === 'queued' ? `Queued${where ? ' at site' : ' to encode'}` : `Encoding${where} ${pct ?? 0}%`
}

/** One line for the asset page: icon and sentence. */
export function EncodePlaceLine({ asset, className }: { asset: WithPlace; className?: string }) {
  const p = asset.encode_place
  if (!p) return null
  return (
    <span className={`lib-place-line${className ? ` ${className}` : ''}`} data-place={p.state}>
      {p.at === 'site' ? LibIcon.site : LibIcon.cloud}<span>{encodePlaceText(p, isBusy(asset))}</span>
    </span>
  )
}
