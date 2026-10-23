// ============================================================================
//  Re-read a channel's or event's graphics when they change, not every second.
//
//  The control plane announces every graphics state change on the admin status
//  stream as a 'gfx' frame (services/graphics/livePush.ts): an operator's take,
//  an API or feed update, a rundown cue, a rule going on at a programme start.
//  This hook calls `load` when one arrives for the stream, and on (re)connect
//  (the 'resync' every subscriber gets), so nothing is missed across a gap.
//
//  Frames that arrive together (a take writes the state and the rundown) are
//  folded into one re-read. While the stream is down (a proxy that buffers
//  SSE, a refused ticket) the page falls back to reading every few seconds,
//  and a slow safety read covers anything announced to another process that
//  never reached this one.
// ============================================================================
import { useEffect, useRef } from 'react'
import { subscribeLive, isLiveUp } from '../liveStatus'

/** Fold frames that arrive within this window into one read. */
const COALESCE_MS = 120
/** While the stream is down, read this often. */
const DOWN_POLL_MS = 3000
/** With the stream up, still read this often, in case a frame was lost. */
const SAFETY_MS = 30_000

export function useGfxLive(kind: 'channel' | 'event' | null, id: string | null, load: () => void, active = true) {
  const fn = useRef(load)
  fn.current = load
  useEffect(() => {
    if (!active || !kind || !id) return
    let timer: ReturnType<typeof setTimeout> | null = null
    let last = Date.now()
    const run = () => { timer = null; last = Date.now(); fn.current() }
    const soon = () => { if (!timer) timer = setTimeout(run, COALESCE_MS) }
    const off = subscribeLive(`gfx:${kind}:${id}`, (m) => { if (m.type === 'gfx' || m.type === 'resync') soon() })
    const h = setInterval(() => {
      const quiet = Date.now() - last
      if ((!isLiveUp() && quiet >= DOWN_POLL_MS) || quiet >= SAFETY_MS) soon()
    }, 1000)
    return () => { off(); clearInterval(h); if (timer) clearTimeout(timer) }
  }, [kind, id, active])
}
