// Tiny history-based router — clean (hashless) deep-linkable URLs via the History
// API, no dependency. Routes:
//   /                     -> default section (channels)
//   /:section             -> a nav section (channels, events, recordings, …)
//   /channels/:id         -> a channel's detail/control page
//   /channels/new         -> channels list with the create drawer open
// Bookmark / reload / share of any of these restores app state; browser back and
// forward work. In dev, Vite's SPA fallback serves index.html for these paths; in
// production the control plane serves index.html for non-/api,/origin routes.
import { useSyncExternalStore, useCallback } from 'react'

export interface Route {
  section: string
  channelId: string | null
  recordingId: string | null
  /** Recordings is TIERED: /recordings lists sources, /recordings/source/:id is
   *  one source's continuous timeline, /recordings/:id is a single capture. */
  recordingSource: { id: string } | null
  radioId: string | null
  /** /events/:id, the event's own page (22 Oct 2026). */
  eventId: string | null
  /** /radio/:id/player — the embed setup page for one station. */
  radioPlayerId: string | null
  /** A guide's owner. 'radio' is a THIRD kind, not a flavour of channel: a
   *  station and a television channel are different products with different
   *  control pages, and the EPG list is filtered by exactly this. Programmes
   *  still hang off channel_id for both — see epgProgrammes(). */
  epgOwner: { kind: 'channel' | 'radio' | 'event'; id: string } | null
  create: boolean
  path: string
}

const listeners = new Set<() => void>()
function emit() { for (const l of listeners) l() }

if (typeof window !== 'undefined') window.addEventListener('popstate', emit)

/** Navigate to a clean URL (pushState by default; replace to avoid a history entry). */
export function navigate(to: string, opts: { replace?: boolean } = {}) {
  const cur = window.location.pathname + window.location.search
  if (to === cur) return
  window.history[opts.replace ? 'replaceState' : 'pushState']({}, '', to)
  emit()
}

export function parseRoute(pathname: string, search = ''): Route {
  const parts = pathname.replace(/^\/+|\/+$/g, '').split('/').filter(Boolean)
  const create = new URLSearchParams(search).has('new')
  const base = { channelId: null as string | null, recordingId: null as string | null,
    recordingSource: null as Route['recordingSource'],
    radioId: null as string | null,
    eventId: null as string | null,
    radioPlayerId: null as string | null,
    epgOwner: null as Route['epgOwner'], create, path: pathname }
  if (parts.length === 0) return { ...base, section: 'channels' }
  if (parts[0] === 'channels') {
    if (parts[1] === 'new') return { ...base, section: 'channels', create: true }
    if (parts[1]) return { ...base, section: 'channels', channelId: decodeURIComponent(parts[1]), create: false }
    return { ...base, section: 'channels' }
  }
  if (parts[0] === 'events' && parts[1] && parts[1] !== 'new') {
    return { ...base, section: 'events', eventId: decodeURIComponent(parts[1]) }
  }
  if (parts[0] === 'recordings' && parts[1] === 'source' && parts[2]) {
    return { ...base, section: 'recordings', recordingSource: { id: decodeURIComponent(parts[2]) } }
  }
  if (parts[0] === 'recordings' && parts[1]) {
    return { ...base, section: 'recordings', recordingId: decodeURIComponent(parts[1]) }
  }
  if (parts[0] === 'radio' && parts[1]) {
    if (parts[1] === 'new') return { ...base, section: 'radio', create: true }
    // A SUB-ROUTE, not a section of its own: the player setup belongs to one
    // station and is reached from it, so its URL says so and Back is obvious.
    if (parts[2] === 'player') {
      return { ...base, section: 'radio', radioPlayerId: decodeURIComponent(parts[1]) }
    }
    return { ...base, section: 'radio', radioId: decodeURIComponent(parts[1]) }
  }
  if (parts[0] === 'epg' && (parts[1] === 'channel' || parts[1] === 'radio' || parts[1] === 'event') && parts[2]) {
    return { ...base, section: 'epg', epgOwner: { kind: parts[1], id: decodeURIComponent(parts[2]) } }
  }
  return { ...base, section: parts[0] }
}

/** Subscribe to the current route; re-renders on navigate / back / forward. */
export function useRoute(): Route {
  const path = useSyncExternalStore(
    (cb) => { listeners.add(cb); return () => listeners.delete(cb) },
    () => window.location.pathname + '?' + window.location.search,
    () => '/',
  )
  void path
  return parseRoute(window.location.pathname, window.location.search)
}

/** Stable navigate helpers bound to the app's route shape. */
export function useNavigate() {
  return useCallback((to: string, opts?: { replace?: boolean }) => navigate(to, opts), [])
}

export function hrefFor(r: { section?: string; channelId?: string | null; create?: boolean }): string {
  if (r.channelId) return `/channels/${r.channelId}`
  if (r.create) return '/channels/new'
  const s = r.section || 'channels'
  return s === 'channels' ? '/channels' : `/${s}`
}
