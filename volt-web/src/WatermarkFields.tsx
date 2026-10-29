import { useEffect, useState } from 'react'
import { thumbUrl, type WatermarkCfg, type WatermarkPatch } from './api'
import { ImageRefField } from './ImageRefField'
import { pressable } from './a11y'

/* ============================================================================
   WATERMARK / CHANNEL BRAND OVERLAY fields, shared by New channel and the
   channel's Settings so the two can never drift apart.

   The logo is burned into the encoded output, so it applies to TRANSCODE
   channels only; a packaging channel passes the source through untouched and
   the caller says so instead of showing these fields.

   A small 16:9 frame previews the placement: offsets are pixels from the edge
   of a 1920×1080 frame and the size is a share of the frame height, the same
   numbers the encoder uses.

   LOGOS ARE RARELY SQUARE. The preview shows the image at its own proportions
   (it used to ask for a 16:9 crop, which cut a wide logo down to its middle),
   and a logo can be sized by WIDTH as well as height. Only the height is
   stored (watermark_scale, what every renderer reads): with the logo's aspect
   ratio known, a width is simply the height that gives it. The readout says
   what will actually be drawn, in pixels on a 1080p frame, and warns when a
   wide logo takes over the frame or runs off its edge.
   ========================================================================== */
export interface WmForm {
  enabled: boolean; ref: string; position: WatermarkCfg['position']
  x: string; y: string; opacity: number; scale: number
}
export const wmDefaults = (w?: Partial<WatermarkCfg> | null): WmForm => ({
  enabled: w?.enabled ?? false, ref: w?.ref ?? '', position: w?.position ?? 'br',
  x: String(w?.offsetX ?? 24), y: String(w?.offsetY ?? 24), opacity: w?.opacity ?? 100, scale: w?.scale ?? 12,
})
export const wmPatch = (v: WmForm): WatermarkPatch => ({
  enabled: v.enabled, ref: v.enabled && v.ref.trim() ? v.ref.trim() : null, position: v.position,
  offsetX: Math.max(0, Number(v.x) || 0), offsetY: Math.max(0, Number(v.y) || 0), opacity: v.opacity, scale: v.scale,
})
/** Why the watermark cannot be saved as it is, or null. */
export const wmProblem = (v: WmForm) => v.enabled && !v.ref.trim() ? 'Choose the watermark image, or turn the watermark off' : null

const POSITIONS: [WatermarkCfg['position'], string][] = [['tl', 'Top left'], ['tc', 'Top centre'], ['tr', 'Top right'], ['bl', 'Bottom left'], ['bc', 'Bottom centre'], ['br', 'Bottom right']]

const FW = 1920, FH = 1080
const r2 = (n: number) => Math.round(n * 100) / 100
/** A ratio as people say it: 4.9:1, 1:1, 1:2.5. */
const ratioLabel = (r: number) => r >= 1 ? `${r >= 10 ? Math.round(r) : r.toFixed(r % 1 ? 1 : 0)}:1` : `1:${(1 / r).toFixed((1 / r) % 1 ? 1 : 0)}`

export function WatermarkFields({ value: v, onChange, hint }: { value: WmForm; onChange: (p: Partial<WmForm>) => void; hint?: string }) {
  const [broken, setBroken] = useState('')
  // the logo's own width / height, read from the image once it loads
  const [ratio, setRatio] = useState<number | null>(null)
  const [sizeBy, setSizeBy] = useState<'height' | 'width'>('height')
  const ref = v.ref.trim()
  useEffect(() => { setRatio(null) }, [ref])
  // A clearly wide logo is easier to size by its width; offer that once its shape is known.
  useEffect(() => { if (ratio && ratio >= 2) setSizeBy('width') }, [ratio])
  // What will be drawn, in pixels on a 1080p frame (the encoder: height = scale % of the frame height).
  const hPx = FH * v.scale / 100
  const wPx = ratio ? hPx * ratio : null
  const wPct = wPx != null ? wPx / FW * 100 : null
  const ox = (Number(v.x) || 0) / FW * 100, oy = (Number(v.y) || 0) / FH * 100
  const overflowX = wPx != null && v.position[1] !== 'c' && wPx + (Number(v.x) || 0) > FW
  const overflowY = hPx + (Number(v.y) || 0) > FH
  const setWidthPct = (w: number) => { if (ratio) onChange({ scale: r2(Math.max(1, Math.min(100, (FW * w / 100) / ratio / FH * 100))) }) }
  const pos: React.CSSProperties = {
    position: 'absolute', height: `${v.scale}%`, opacity: v.opacity / 100,
    ...(v.position[0] === 't' ? { top: `${oy}%` } : { bottom: `${oy}%` }),
    ...(v.position[1] === 'l' ? { left: `${ox}%` } : v.position[1] === 'r' ? { right: `${ox}%` } : { left: '50%', transform: 'translateX(-50%)' }),
  }
  return (
    <>
      <div className="toggle-row">
        <div><div className="tt">Overlay a brand watermark</div><div className="td">{hint ?? 'Burned into every rendition of the transcoded output.'}</div></div>
        <div className={`sw ${v.enabled ? '' : 'off'}`} {...pressable(() => onChange({ enabled: !v.enabled }), { label: v.enabled ? 'Turn the watermark off' : 'Turn the watermark on' })}><i /></div>
      </div>
      {v.enabled && (
        <div className="wm-grid">
          <div style={{ maxWidth: 300 }}>
            <div className="wm-frame" aria-label="Watermark placement preview">
              {v.ref.trim() && broken !== v.ref.trim()
                ? <img src={thumbUrl(ref, 640, 360, 'inside')} alt="" style={{ ...pos, width: 'auto', maxWidth: 'none' }}
                    onLoad={(e) => { const i = e.currentTarget; if (i.naturalWidth && i.naturalHeight) setRatio(i.naturalWidth / i.naturalHeight) }}
                    onError={() => setBroken(ref)} />
                : <span className="wm-ghost" style={pos}>LOGO</span>}
            </div>
            <div className="hintxt" style={{ textAlign: 'center' }}>Placement on a 16:9 frame</div>
            {ratio && wPx != null && wPct != null && (
              <div className="hintxt" style={{ textAlign: 'center' }}>
                Logo {ratioLabel(ratio)} · drawn at {Math.round(wPx)}×{Math.round(hPx)} px on 1080p ({Math.round(wPct)}% of the width, {r2(v.scale)}% of the height)
              </div>
            )}
            {wPct != null && wPct > 35 && !overflowX && (
              <div className="hintxt" style={{ textAlign: 'center', color: 'var(--warn)' }}>A wide logo at this size covers more than a third of the picture width.</div>
            )}
            {(overflowX || overflowY) && (
              <div className="hintxt" style={{ textAlign: 'center', color: 'var(--down)' }}>At this size and offset the logo runs off the edge of the frame.</div>
            )}
          </div>
          <div style={{ minWidth: 0 }}>
            <ImageRefField label="Watermark image" value={v.ref} onChange={ref => onChange({ ref })} preview={false}
              pickerTitle="Choose or upload a brand watermark" kinds={['brand', 'slate', 'other']}
              help="A PNG with transparency works best." />
            <div className="field"><label>Position</label>
              <div className="wm-pos" role="radiogroup" aria-label="Watermark position">
                {POSITIONS.map(([p, lbl]) => (
                  <button key={p} type="button" role="radio" aria-checked={v.position === p} title={lbl}
                    className={`wm-pos-btn${v.position === p ? ' sel' : ''}`} onClick={() => onChange({ position: p })}>
                    <span className={`wm-dot ${p}`} aria-hidden="true" />
                  </button>
                ))}
              </div>
            </div>
            <div className="field"><label>Offset from the edge (px on a 1080p frame)</label>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <span className="hintxt" style={{ marginTop: 0 }}>X</span>
                <input className="inp" style={{ width: 80 }} inputMode="numeric" aria-label="Horizontal offset in pixels" placeholder="0" value={v.x}
                  onChange={e => onChange({ x: e.target.value.replace(/[^0-9]/g, '') })} onBlur={() => { if (v.x === '') onChange({ x: '0' }) }} />
                <span className="hintxt" style={{ marginTop: 0 }}>Y</span>
                <input className="inp" style={{ width: 80 }} inputMode="numeric" aria-label="Vertical offset in pixels" placeholder="0" value={v.y}
                  onChange={e => onChange({ y: e.target.value.replace(/[^0-9]/g, '') })} onBlur={() => { if (v.y === '') onChange({ y: '0' }) }} />
                <button type="button" className="btn ghost" style={{ padding: '4px 10px' }} title="Broadcast title-safe: 5% in from each edge (96 × 54 px on 1080p)"
                  onClick={() => onChange({ x: '96', y: '54' })}>Title-safe</button>
              </div>
            </div>
            <div className="field">
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                <label style={{ margin: 0 }}>Size: {sizeBy === 'width' && wPct != null ? `${Math.round(wPct)}% of the frame width` : `${r2(v.scale)}% of the frame height`}</label>
                <div role="group" aria-label="Size the logo by" style={{ display: 'inline-flex', gap: 4 }}>
                  {(['height', 'width'] as const).map((m) => (
                    <button key={m} type="button" className={`btn ${sizeBy === m ? 'primary' : 'ghost'}`} style={{ padding: '3px 10px', fontSize: 'var(--fs-sm)' }}
                      aria-pressed={sizeBy === m} disabled={m === 'width' && !ratio} title={m === 'width' && !ratio ? 'Choose an image first: its shape decides the width' : undefined}
                      onClick={() => setSizeBy(m)}>By {m}</button>
                  ))}
                </div>
              </div>
              {sizeBy === 'width' && ratio && wPct != null
                ? <input type="range" min={2} max={60} step={1} value={Math.round(wPct)} aria-label="Logo width as a percent of the frame width"
                    onChange={e => setWidthPct(Number(e.target.value))} style={{ width: '100%', accentColor: 'var(--brand)' }} />
                : <input type="range" min={2} max={40} step={1} value={Math.round(v.scale)} aria-label="Logo height as a percent of the frame height"
                    onChange={e => onChange({ scale: Number(e.target.value) })} style={{ width: '100%', accentColor: 'var(--brand)' }} />}
            </div>
            <div className="field"><label>Opacity: {v.opacity}%</label>
              <input type="range" min={10} max={100} step={5} value={v.opacity} onChange={e => onChange({ opacity: Number(e.target.value) })} style={{ width: '100%', accentColor: 'var(--brand)' }} />
            </div>
          </div>
        </div>
      )}
    </>
  )
}
