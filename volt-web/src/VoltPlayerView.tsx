import { useEffect, useLayoutEffect, useRef, type CSSProperties, type MutableRefObject } from 'react'
import type { VoltPlayer, PlayerState, Theme, VoltPlayerSdkOptions } from '@volt/player'
import { getToken } from './api'

/* ============================================================================
   THE VOLT PLAYER IN THE CONSOLE.

   The same SDK a customer embeds (volt-player/src/sdk), with the admin skin by
   default: no branding, no casting, the technical readout operators need.

   THE MEDIA ELEMENT IS CREATED HERE, NOT BY REACT. The player moves it into
   its own stage, and a <video> React rendered would be pulled out from under
   React's feet. It is created once, handed to the page through `mediaRef`
   (before the page's own effects run, so timecode and seek code that reads
   videoRef.current keeps working), and handed to the player as `media`.

   Console playlists under /api/ need the operator's token; segments do not.
   ========================================================================== */

export interface VoltPlayerViewProps {
  /** Manifest or file URL. Changing it loads the new source in the same player. */
  src?: string | null
  skin?: string
  theme?: Partial<Theme>
  autoplay?: boolean
  title?: string | null
  live?: boolean
  /** The page's handle on the media element (seek, time, visualisers). */
  mediaRef?: MutableRefObject<HTMLVideoElement | null>
  onError?: (message: string | null) => void
  onState?: (s: PlayerState) => void
  /** Demo state (Player setup preview): nothing is played. */
  demo?: Partial<PlayerState>
  extra?: Partial<VoltPlayerSdkOptions>
  playerRef?: MutableRefObject<VoltPlayer | null>
  style?: CSSProperties
  className?: string
}

const withToken = (url: string) => {
  try {
    if (new URL(url, window.location.href).pathname.startsWith('/api/')) {
      const t = getToken()
      return t ? { authorization: `Bearer ${t}` } : null
    }
  } catch { /* */ }
  return null
}

export default function VoltPlayerView(p: VoltPlayerViewProps) {
  const host = useRef<HTMLDivElement | null>(null)
  const player = useRef<VoltPlayer | null>(null)
  const media = useRef<HTMLVideoElement | null>(null)
  const cb = useRef(p)
  cb.current = p
  if (!media.current && typeof document !== 'undefined') media.current = document.createElement('video')

  useLayoutEffect(() => { if (p.mediaRef) p.mediaRef.current = media.current }, [p.mediaRef])

  // One player for the life of the component.
  useEffect(() => {
    if (!host.current) return
    let gone = false
    const first = cb.current
    // Loaded on first use: Shaka is large and most console pages never play anything.
    import('@volt/player').then(({ VoltPlayer }) => gone ? null : VoltPlayer.create({
      el: host.current!,
      skin: first.skin ?? 'admin',
      theme: first.theme,
      media: media.current!,
      cast: false, airplay: false, beacons: false,
      requestHeaders: withToken,
      autoplay: first.autoplay ?? true,
      demo: first.demo,
      item: first.src && !first.demo ? { id: first.src, title: first.title ?? null, live: first.live, source: { url: first.src } } : undefined,
      onEvent: (name, d: any) => {
        if (name === 'error') cb.current.onError?.(d?.message ?? 'Playback failed')
        if (name === 'play') cb.current.onError?.(null)
        if (name === 'state') cb.current.onState?.(d as PlayerState)
      },
      ...first.extra,
    })).then((pl) => {
      if (!pl) return
      if (gone) { void pl.destroy(); return }
      player.current = pl
      if (cb.current.playerRef) cb.current.playerRef.current = pl
      loaded.current = first.src ?? null
      if (cb.current.src !== loaded.current) load(cb.current.src)
    }).catch((e) => cb.current.onError?.(String(e?.message ?? e)))
    return () => { gone = true; void player.current?.destroy(); player.current = null }
  }, [])

  const loaded = useRef<string | null>(null)
  function load(src: string | null | undefined) {
    const pl = player.current
    if (!pl || cb.current.demo) return
    loaded.current = src ?? null
    if (!src) return
    void pl.setSource({ url: src }, { id: src, title: cb.current.title ?? null, live: cb.current.live }, cb.current.autoplay ?? true)
  }
  useEffect(() => { if (player.current && p.src !== loaded.current) load(p.src) }, [p.src])
  useEffect(() => { if (p.theme) player.current?.setTheme(p.theme) }, [JSON.stringify(p.theme ?? null)])
  useEffect(() => { if (p.skin) player.current?.setSkin(p.skin) }, [p.skin])
  useEffect(() => { if (p.demo) player.current?.setDemo(p.demo) }, [JSON.stringify(p.demo ?? null)])

  return <div ref={host} className={p.className} style={p.style} />
}
