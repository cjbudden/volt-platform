import { pressable } from './a11y'

/* ============================================================================
   IN-STREAM GRAPHICS for one channel or event: today, Up next.

   The control plane turns the guide into triggers that travel IN the stream
   (EXT-X-DATERANGE / DASH EventStream), so every player that has "Show graphics
   the stream asks for" on draws the same card at the same moment, with no extra
   request. These are overrides: an empty value means the defaults below.
   Not locked while the channel runs: the encoder re-reads them every few seconds.
   ========================================================================== */

export interface GraphicsValue {
  upNext?: { enabled?: boolean; leadSec?: number; durationSec?: number }
}

const LEADS = [60, 120, 180, 300]
const DURATIONS = [8, 12, 20, 30]

export function GraphicsSettings({ value, onChange, hasGuide }: {
  value: GraphicsValue
  onChange: (v: GraphicsValue) => void
  /** Without a guide there is nothing to name, so say so instead of pretending. */
  hasGuide: boolean
}) {
  const u = { enabled: true, leadSec: 120, durationSec: 12, ...(value.upNext ?? {}) }
  const set = (p: Partial<typeof u>) => onChange({ ...value, upNext: { ...(value.upNext ?? {}), ...p } })
  return (
    <>
      <div className="sec-label">Graphics in the stream</div>
      <div className="toggle-row">
        <div>
          <div className="tt">Up next</div>
          <div className="td">
            Names the next programme towards the end of each one, from this channel's guide.
            Shown by players with stream graphics on (Player setup). {hasGuide ? '' : 'This channel has no guide yet, so nothing is sent until it has one.'}
          </div>
        </div>
        <div className={`sw ${u.enabled ? '' : 'off'}`} {...pressable(() => set({ enabled: !u.enabled }))} data-a11y-click=""><i /></div>
      </div>
      {u.enabled && (
        <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr) minmax(0,1fr)', gap: 10 }}>
          <div className="field"><label>Appears</label>
            <select className="inp" value={u.leadSec} onChange={(e) => set({ leadSec: Number(e.target.value) })}>
              {[...new Set([...LEADS, u.leadSec])].sort((a, b) => a - b).map((s) => (
                <option key={s} value={s}>{s % 60 === 0 ? `${s / 60} min` : `${s} s`} before the end</option>
              ))}
            </select>
          </div>
          <div className="field"><label>Stays for</label>
            <select className="inp" value={u.durationSec} onChange={(e) => set({ durationSec: Number(e.target.value) })}>
              {[...new Set([...DURATIONS, u.durationSec])].sort((a, b) => a - b).map((s) => <option key={s} value={s}>{s} seconds</option>)}
            </select>
          </div>
        </div>
      )}
    </>
  )
}
