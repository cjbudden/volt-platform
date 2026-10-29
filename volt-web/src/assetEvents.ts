// ============================================================================
//  "THESE ASSETS JUST CHANGED", ACROSS THE CONSOLE, WITHOUT POLLING.
//
//  A save made in one part of the console (the ingest queue's Fill in, a
//  duplicate settled) is announced as a window event; any page showing those
//  assets (the Media Library's grid and list) refreshes at once, in this tab
//  and, through a BroadcastChannel, in the operator's other console tabs.
// ============================================================================
import { useEffect, useRef } from 'react'

const EVENT = 'volt:assets-changed'
let channel: BroadcastChannel | null = null
try { channel = typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel('volt-assets') : null } catch { channel = null }

/** Tell the console these assets changed (metadata, status, image...). */
export function announceAssetsChanged(ids: (string | null | undefined)[]): void {
  const list = ids.filter(Boolean) as string[]
  if (!list.length) return
  window.dispatchEvent(new CustomEvent(EVENT, { detail: { ids: list } }))
  try { channel?.postMessage({ ids: list }) } catch { /* another tab will catch up on its next load */ }
}

/** Run `onChange` with the ids whenever assets are announced as changed. */
export function useAssetsChanged(onChange: (ids: string[]) => void): void {
  const cb = useRef(onChange)
  cb.current = onChange
  useEffect(() => {
    const h = (e: Event) => { const ids = (e as CustomEvent).detail?.ids; if (Array.isArray(ids) && ids.length) cb.current(ids) }
    const m = (e: MessageEvent) => { const ids = e.data?.ids; if (Array.isArray(ids) && ids.length) cb.current(ids) }
    window.addEventListener(EVENT, h)
    channel?.addEventListener('message', m)
    return () => { window.removeEventListener(EVENT, h); channel?.removeEventListener('message', m) }
  }, [])
}
