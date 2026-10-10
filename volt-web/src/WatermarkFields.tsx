import { useState } from 'react'
import { thumbUrl, type WatermarkCfg, type WatermarkPatch } from './api'
import { ImagePicker } from './ImagePicker'
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

export function WatermarkFields({ value: v, onChange, hint }: { value: WmForm; onChange: (p: Partial<WmForm>) => void; hint?: string }) {
  const [pickerOpen, setPickerOpen] = useState(false)
  const [broken, setBroken] = useState('')
  // Preview geometry, as fractions of a 1920×1080 frame.
  const ox = (Number(v.x) || 0) / 1920 * 100, oy = (Number(v.y) || 0) / 1080 * 100
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
                ? <img src={thumbUrl(v.ref.trim(), 320, 180)} alt="" style={pos} onError={() => setBroken(v.ref.trim())} />
                : <span className="wm-ghost" style={pos}>LOGO</span>}
            </div>
            <div className="hintxt" style={{ textAlign: 'center' }}>Placement on a 16:9 frame</div>
          </div>
          <div style={{ minWidth: 0 }}>
            <div className="field"><label>Watermark image</label>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <input className="inp" value={v.ref} onChange={e => onChange({ ref: e.target.value })} placeholder="Pick a logo, upload, or paste a URL" />
                <button type="button" className="btn ghost" onClick={() => setPickerOpen(true)}>Browse / upload…</button>
              </div>
              <div className="hintxt">A PNG with transparency works best.</div>
            </div>
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
                <input className="inp" style={{ width: 80 }} inputMode="numeric" value={v.x} onChange={e => onChange({ x: e.target.value.replace(/[^0-9]/g, '') })} />
                <span className="hintxt" style={{ marginTop: 0 }}>Y</span>
                <input className="inp" style={{ width: 80 }} inputMode="numeric" value={v.y} onChange={e => onChange({ y: e.target.value.replace(/[^0-9]/g, '') })} />
              </div>
            </div>
            <div className="field"><label>Size: {v.scale}% of the frame height</label>
              <input type="range" min={2} max={40} step={1} value={v.scale} onChange={e => onChange({ scale: Number(e.target.value) })} style={{ width: '100%', accentColor: 'var(--brand)' }} />
            </div>
            <div className="field"><label>Opacity: {v.opacity}%</label>
              <input type="range" min={10} max={100} step={5} value={v.opacity} onChange={e => onChange({ opacity: Number(e.target.value) })} style={{ width: '100%', accentColor: 'var(--brand)' }} />
            </div>
          </div>
        </div>
      )}
      <ImagePicker open={pickerOpen} kinds={['brand', 'slate', 'other']} title="Choose or upload a brand watermark"
        uploadKind="brand" uploadFolder="brands"
        onClose={() => setPickerOpen(false)} onPick={(url) => { onChange({ ref: url }); setPickerOpen(false) }} />
    </>
  )
}
