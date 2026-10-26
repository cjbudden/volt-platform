// ============================================================================
//  VOLT PLAYER — the embed entry point (window.VoltPlayer).
//
//  Two players in one bundle, one API:
//
//    THE SDK PLAYER   video and audio, playlists, the guide, up next, start
//                     over, quality and subtitle menus, Chromecast, AirPlay,
//                     viewer beacons, themeable skins (src/sdk).
//    THE STATION EMBED the original radio card/bar/hero/stage layouts, driven
//                     by a station's saved player config.
//
//  create() picks: anything SDK-shaped (a source, a playlist, an asset id, a
//  skin) goes to the SDK player; a bare appKey + channelId goes through the
//  station handshake, and if the station's saved config names an SDK skin the
//  station embed hands over to the SDK player with the session it already has.
//
//  Two ways in, because embedders arrive from two directions:
//
//    DECLARATIVE  <div data-volt-player data-app-key="pk_…" data-asset-id="…">
//                 No JavaScript to write. scan() mounts every one on the page,
//                 and can be called again after markup is injected later.
//    IMPERATIVE   VoltPlayer.create({...}) for an app that wants a handle.
// ============================================================================
import { VoltPlayerCore } from './core'
import type { VoltPlayerOptions } from './types'
import {
  VoltPlayer, registerSkin, skinNames, isSdkSkin, resolveTheme, themeFromConfig, kit, BUILT_IN_SKINS, SDK_VERSION,
  VoltJourney, ga4Forward,
} from './sdk'
import type { VoltPlayerSdkOptions, Theme } from './sdk'

const mounted = new WeakSet<HTMLElement>()
export const version = SDK_VERSION

type AnyOptions = VoltPlayerOptions | VoltPlayerSdkOptions

function isSdkOptions(o: any): o is VoltPlayerSdkOptions {
  return !!(o.source || o.item || o.playlist || o.assetId || o.skin || o.epg || o.media || o.stationId || o.eventId) || !o.channelId
}

async function create(opts: AnyOptions): Promise<VoltPlayer | VoltPlayerCore> {
  if (isSdkOptions(opts)) return VoltPlayer.create(opts)
  const legacy = opts as VoltPlayerOptions
  let sdk: Promise<VoltPlayer> | null = null
  const p = new VoltPlayerCore({
    ...legacy,
    handoff: (session, cfg) => {
      if (!isSdkSkin(cfg.layout as string)) return false
      sdk = VoltPlayer.create({
        el: legacy.el, apiBase: legacy.apiBase, appKey: legacy.appKey,
        skin: cfg.layout as string,
        theme: themeFromConfig(cfg as any),
        // Off air: the station is shown with "not on air" and a retry, rather
        // than a spinner while every manifest request fails.
        item: { id: session.station.id, title: session.station.name, description: session.station.description,
          artworkUrl: session.station.artworkUrl, live: true,
          source: session.station.onAir ? { hls: session.sources.hls, dash: session.sources.dash, mp3: session.sources.mp3 } : null },
        stationId: session.station.id,
        epg: { channelId: session.station.id },
        autoplay: legacy.autoplay,
      })
      return true
    },
  })
  await p.init()
  return sdk ? await sdk : p
}

function attrTheme(node: HTMLElement): Partial<Theme> {
  const t: Partial<Theme> = {}
  const a = (k: string) => node.getAttribute(k) ?? undefined
  if (a('data-primary-color')) t.primary = a('data-primary-color')
  if (a('data-secondary-color')) t.secondary = a('data-secondary-color')
  if (a('data-logo')) t.logoUrl = a('data-logo')
  const json = a('data-theme')
  if (json) { try { Object.assign(t, JSON.parse(json)) } catch { console.warn('[volt-player] data-theme is not valid JSON', node) } }
  return t
}

/** Mount every [data-volt-player] on the page that is not already mounted. */
function scan(root: ParentNode = document): void {
  root.querySelectorAll<HTMLElement>('[data-volt-player]').forEach((node) => {
    if (mounted.has(node)) return
    const a = (k: string) => node.getAttribute(k) ?? undefined
    const appKey = a('data-app-key')
    const sdkShaped = a('data-skin') || a('data-asset-id') || a('data-src') || a('data-playlist') || a('data-event-id')
    if (sdkShaped) {
      mounted.add(node)
      const playlist = a('data-playlist')?.split(/[\s,]+/).filter(Boolean)
      const src = a('data-src')
      const theme = attrTheme(node)
      void VoltPlayer.create({
        el: node, appKey, apiBase: a('data-api-base'),
        skin: a('data-skin') ?? 'video',
        theme,
        // A control turned off in the theme also skips its machinery (no Cast script, no native HLS for AirPlay).
        cast: theme.controls?.cast === false ? false : undefined,
        airplay: theme.controls?.airplay === false ? false : undefined,
        assetId: a('data-asset-id'),
        playlist,
        source: src ? { url: src } : undefined,
        epg: a('data-epg-channel') ? { channelId: a('data-epg-channel')! } : undefined,
        stationId: a('data-station-id'),
        eventId: a('data-event-id'),
        purchaseUrl: a('data-purchase-url'),
        signInUrl: a('data-sign-in-url'),
        autoplay: a('data-autoplay') === 'true',
        muted: a('data-muted') === 'true',
        poster: a('data-poster'),
        debug: a('data-debug') === 'false' ? false : a('data-debug') === 'open' ? { open: true } : undefined,
      }).then((p) => { (node as any).voltPlayer = p; node.dispatchEvent(new CustomEvent('volt-player-ready', { detail: p, bubbles: true })) })
        .catch((e) => console.error('[volt-player] failed to mount', e))
      return
    }
    const channelId = a('data-channel-id')
    if (!appKey || !channelId) {
      console.warn('[volt-player] element needs data-app-key with data-asset-id, data-playlist or data-channel-id', node)
      return
    }
    mounted.add(node)
    const cfg: Record<string, string> = {}
    if (a('data-primary-color')) cfg.primaryColor = a('data-primary-color')!
    if (a('data-secondary-color')) cfg.secondaryColor = a('data-secondary-color')!
    if (a('data-layout')) cfg.layout = a('data-layout')!
    void create({
      el: node, appKey, channelId,
      apiBase: a('data-api-base'),
      preferred: (a('data-preferred') as any) ?? 'auto',
      autoplay: a('data-autoplay') === 'true',
      config: Object.keys(cfg).length ? (cfg as any) : undefined,
    }).catch((e) => console.error('[volt-player] failed to mount', e))
  })
}

if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => scan(), { once: true })
  else scan()
}

// Journey to play (sdk/journey.ts): new VoltPlayer.VoltJourney({...}), passed to create() as `journey`.
export { create, scan, VoltPlayerCore, VoltPlayer, registerSkin, skinNames, resolveTheme, kit, BUILT_IN_SKINS, VoltJourney, ga4Forward }
export type { VoltPlayerOptions, PlayerConfig, NowPlaying, Layout, LayoutState, PlayerEvent } from './types'
export default { create, scan, registerSkin, skinNames, resolveTheme, kit, version, VoltPlayer, VoltJourney, ga4Forward }
