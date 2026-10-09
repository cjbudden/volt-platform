// ============================================================================
//  VOLT Stream audio player — the embed entry point.
//
//  Two ways in, because embedders arrive from two directions:
//
//    DECLARATIVE  a script tag with data- attributes. No JavaScript to write,
//                 which is what a CMS block or a marketing page needs.
//
//    IMPERATIVE   window.VoltPlayer.create({...}). For an application that
//                 wants a handle, a callback, or more than one player.
//
//  The declarative path is the one most people will use, so it auto-discovers
//  on DOMContentLoaded and again on demand — a page that injects markup later
//  (a tab, a modal, an infinite scroll) can call `scan()` and get the same
//  behaviour without knowing anything else about the API.
// ============================================================================
import { VoltPlayerCore } from './core'
import type { VoltPlayerOptions } from './types'

const mounted = new WeakSet<HTMLElement>()

async function create(opts: VoltPlayerOptions): Promise<VoltPlayerCore> {
  const p = new VoltPlayerCore(opts)
  await p.init()
  return p
}

/**
 * Mount every [data-volt-player] on the page that is not already mounted.
 *
 * The WeakSet is what makes this safe to call repeatedly: a second scan after
 * a tab switch must not open a second player onto the same element, which
 * would play two copies of the same station at once.
 */
function scan(root: ParentNode = document): void {
  const nodes = root.querySelectorAll<HTMLElement>('[data-volt-player]')
  nodes.forEach((node) => {
    if (mounted.has(node)) return
    const appKey = node.getAttribute('data-app-key')
    const channelId = node.getAttribute('data-channel-id')
    if (!appKey || !channelId) {
      console.warn('[volt-player] element is missing data-app-key or data-channel-id', node)
      return
    }
    mounted.add(node)
    const cfg: Partial<VoltPlayerOptions['config']> = {}
    const primary = node.getAttribute('data-primary-color')
    const secondary = node.getAttribute('data-secondary-color')
    const layout = node.getAttribute('data-layout')
    if (primary) (cfg as any).primaryColor = primary
    if (secondary) (cfg as any).secondaryColor = secondary
    if (layout) (cfg as any).layout = layout

    void create({
      el: node,
      appKey,
      channelId,
      apiBase: node.getAttribute('data-api-base') ?? undefined,
      preferred: (node.getAttribute('data-preferred') as any) ?? 'auto',
      autoplay: node.getAttribute('data-autoplay') === 'true',
      config: Object.keys(cfg).length ? (cfg as any) : undefined,
    }).catch((e) => console.error('[volt-player] failed to mount', e))
  })
}

if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => scan(), { once: true })
  } else {
    scan()
  }
}

export { create, scan, VoltPlayerCore }
export type { VoltPlayerOptions, PlayerConfig, NowPlaying, Layout, LayoutState, PlayerEvent } from './types'
export default { create, scan }
