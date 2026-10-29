import { useEffect, useRef, useState } from 'react'
import {
  attachStats, combineProbes, mediaProbe, hlsJsProbe, dashJsProbe, SDK_VERSION,
  type AttachedStats, type StatsProbe,
} from '@volt/player/stats'

/* ============================================================================
   THE PLAYBACK STATS PANEL ON A CONSOLE PLAYER THE SDK DOES NOT OWN.

   The channel output monitor, the source preview and the output URL previews
   still drive hls.js / dash.js themselves. This puts the SDK's own panel and
   right-click menu on them (volt-player/src/sdk/stats.ts), so an operator sees
   the same readout everywhere: right-click > Debug mode, Shift+D or Cmd/Ctrl+D, or the
   page's Stats button (`toggle`).

   The engines are read through refs on every sample, so a format switch or a
   fallback that builds a new hls.js instance is picked up without re-binding.
   Imports only sdk/stats.ts (no Shaka), so pages that never open it pay ~nothing.
   ========================================================================== */

type Ref<T> = { current: T }

export function useStatsPanel(
  box: Ref<HTMLElement | null>,
  video: Ref<HTMLVideoElement | null>,
  engines: { hls?: Ref<any>; dash?: Ref<any> } = {},
  /** Facts only the page knows, e.g. the board's verdict on the stream (server side). */
  extra?: Ref<StatsProbe | null>,
) {
  const st = useRef<AttachedStats | null>(null)
  const eng = useRef(engines); eng.current = engines
  const [open, setOpen] = useState(false)
  useEffect(() => {
    const host = box.current, v = video.current
    if (!host || !v) return
    const mp = mediaProbe(v, host)
    let hSeen: any = null, hp: ReturnType<typeof hlsJsProbe> | null = null
    let dSeen: any = null, dp: ReturnType<typeof dashJsProbe> | null = null
    const probe: StatsProbe = () => {
      const h = eng.current.hls?.current ?? null
      if (h !== hSeen) { hp?.destroy(); hp = h ? hlsJsProbe(h, v) : null; hSeen = h }
      const d = eng.current.dash?.current ?? null
      if (d !== dSeen) { dp?.destroy(); dp = d ? dashJsProbe(d) : null; dSeen = d }
      return combineProbes(extra?.current ?? null, hp, dp, mp)()
    }
    const a = attachStats(host, probe, { version: SDK_VERSION, onChange: setOpen, media: v })
    st.current = a
    return () => { a.destroy(); hp?.destroy(); dp?.destroy(); mp.destroy(); st.current = null }
  }, [])
  return { open, toggle: () => st.current?.show() }
}
