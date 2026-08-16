// Tiny history-based router — clean (hashless) deep-linkable URLs via the History
// API, no dependency. Routes:
//   /                     -> default section (channels)
//   /:section             -> a nav section (channels, events, recordings, …)
//   /channels/:id         -> a channel's detail/control page
//   /channels/new         -> channels list with the create drawer open
//   /radio, /radio/:id    -> the same pages at the audio-only (station) scope
// Bookmark / reload / share of any of these restores app state; browser back and
// forward work. In dev, Vite's SPA fallback serves index.html for these paths; in
// production the control plane serves index.html for non-/api,/origin routes.
import { useSyncExternalStore, useCallback } from 'react'

export interface Route {
  section: string
  channelId: string | null
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
  if (parts.length === 0) return { section: 'channels', channelId: null, create, path: pathname }
  // channels and radio are the same shape: list / :id / new
  if (parts[0] === 'channels' || parts[0] === 'radio') {
    const section = parts[0]
    if (parts[1] === 'new') return { section, channelId: null, create: true, path: pathname }
    if (parts[1]) return { section, channelId: decodeURIComponent(parts[1]), create: false, path: pathname }
    return { section, channelId: null, create, path: pathname }
  }
  return { section: parts[0], channelId: null, create, path: pathname }
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
