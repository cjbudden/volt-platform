// LIVE CARDS WITHOUT A RELOAD: while the media library is on screen, ask the
// server every few seconds what changed since the last answer
// (GET /api/vod/changes) and merge just those rows into the page.
//
// Light by design: one small request per interval, only while the tab is
// visible (paused when hidden, asked at once when it comes back), backing off
// to a minute when the server cannot be reached, and the server answers from a
// short range scan shared between viewers. `more` (a burst of changes) asks the
// caller to reload the page instead.
import { useEffect, useRef } from 'react'
import { apiRequest } from '../../api'

export interface AssetChange {
  id: string; title?: string | null; poster_key?: string | null; poster_shape?: 'wide' | 'square' | null; poster_source?: string | null
  poster_picked_at?: string | null; updated_at?: string; availability_state?: string | null; encode_state?: string | null; encode_pct?: number | null
}

const EVERY_MS = 8000, MAX_MS = 60000

export function useLibraryChanges(onChanges: (rows: AssetChange[]) => void, onReload: () => void, enabled = true) {
  const cb = useRef({ onChanges, onReload })
  cb.current = { onChanges, onReload }
  useEffect(() => {
    if (!enabled) return
    let since: string | null = null, timer: number | undefined, delay = EVERY_MS, stopped = false, inFlight = false
    const schedule = (ms: number) => { window.clearTimeout(timer); if (!stopped) timer = window.setTimeout(tick, ms) }
    async function tick() {
      if (stopped || inFlight) return
      if (document.visibilityState !== 'visible') return            // resumes on visibilitychange
      inFlight = true
      try {
        const r: any = await apiRequest(`/vod/changes${since ? `?since=${encodeURIComponent(since)}` : ''}`)
        if (since && r.more) cb.current.onReload()
        else if (since && r.changes?.length) cb.current.onChanges(r.changes)
        since = r.now ?? since
        delay = EVERY_MS
      } catch { delay = Math.min(MAX_MS, delay * 2) }
      finally { inFlight = false; schedule(delay) }
    }
    const onVis = () => { if (document.visibilityState === 'visible') schedule(0) }
    document.addEventListener('visibilitychange', onVis)
    tick()
    return () => { stopped = true; window.clearTimeout(timer); document.removeEventListener('visibilitychange', onVis) }
  }, [enabled])
}

/** The image-service version of an asset's image: a new pick is a new URL, so no cache shows the old one. */
export const posterVersion = (picked?: string | null) => { const t = picked ? Date.parse(picked) : NaN; return Number.isFinite(t) ? String(t) : '' }
