// ============================================================================
//  THE GRAPHICS STAGE: one or more templates drawn over a 16:9 picture.
//
//  Each template runs in its own iframe, sandboxed WITHOUT allow-same-origin
//  (and served with a CSP sandbox, connect-src limited to its own package), so uploaded HTML
//  cannot read the console's session, its cookies or the network. The page
//  cannot call into it either; it posts messages, and the bridge the server
//  injects into index.html calls the template's own CasparCG functions:
//    { type: 'volt-gfx', op: 'update', data }   update(JSON string)
//    { type: 'volt-gfx', op: 'play' | 'stop' | 'next' }
//  This is the same contract the player overlay and the burn-in renderer use,
//  which is what makes the preview a preview (REQ FR-12).
//
//  The iframe is laid out at the template's canvas size (1920x1080) and scaled
//  to the box, so the template's pixel positions are the broadcast's.
// ============================================================================
import { forwardRef, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState } from 'react'
import type { Placement } from './gfxApi'

export interface StageLayer {
  key: string
  url: string
  values: Record<string, any>
  onAir: boolean
  canvas?: [number, number]
  placement?: Placement
}
export type StageBackground = 'picture' | 'checker' | 'black'
export interface StageHandle { next: (key?: string) => void; replay: (key?: string) => void }

const ORIGIN: Record<string, string> = {
  top_left: '0 0', top: '50% 0', top_right: '100% 0', left: '0 50%', center: '50% 50%', right: '100% 50%',
  bottom_left: '0 100%', bottom: '50% 100%', bottom_right: '100% 100%',
}

function Layer({ layer, scale, crop, onError, register }: {
  layer: StageLayer; scale: number; crop: { x: number; y: number } | null; onError: (key: string, msg: string | null) => void
  register: (key: string, post: ((op: string, data?: any) => void) | null) => void
}) {
  const ref = useRef<HTMLIFrameElement>(null)
  const ready = useRef(false)
  const last = useRef<{ values: string; onAir: boolean | null }>({ values: '', onAir: null })
  const [w, h] = layer.canvas ?? [1920, 1080]

  const post = (op: string, data?: any) => {
    try { ref.current?.contentWindow?.postMessage({ type: 'volt-gfx', op, data }, '*') } catch { /* gone */ }
  }
  const sync = () => {
    if (!ready.current) return
    const v = JSON.stringify(layer.values ?? {})
    if (v !== last.current.values) { post('update', layer.values ?? {}); last.current.values = v }
    if (layer.onAir !== last.current.onAir) { post(layer.onAir ? 'play' : 'stop'); last.current.onAir = layer.onAir }
  }

  useEffect(() => {
    const onMsg = (e: MessageEvent) => {
      if (e.source !== ref.current?.contentWindow || !e.data || typeof e.data !== 'object') return
      if (e.data.type === 'volt-gfx-ready') { ready.current = true; last.current = { values: '', onAir: null }; onError(layer.key, null); sync() }
      if (e.data.type === 'volt-gfx-error') onError(layer.key, String(e.data.message ?? 'The template reported an error'))
    }
    window.addEventListener('message', onMsg)
    register(layer.key, post)
    return () => { window.removeEventListener('message', onMsg); register(layer.key, null) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layer.key, layer.url])
  useEffect(sync)
  useEffect(() => { ready.current = false }, [layer.url])

  const p = layer.placement ?? {}
  const tf = `translate(${p.x ?? 0}px, ${p.y ?? 0}px) scale(${p.scale ?? 1})`
  return (
    <div style={{ position: 'absolute', left: 0, top: 0, width: w, height: h, transform: `${crop ? `translate(${-crop.x * scale}px, ${-crop.y * scale}px) ` : ''}scale(${scale})`, transformOrigin: '0 0', pointerEvents: 'none', zIndex: p.layer ?? 1 }}>
      <div style={{ width: w, height: h, transform: tf, transformOrigin: ORIGIN[p.anchor ?? 'top_left'] ?? '0 0' }}>
        <iframe ref={ref} src={layer.url} title={`Graphic ${layer.key}`} sandbox="allow-scripts" referrerPolicy="no-referrer"
          style={{ width: w, height: h, border: 0, background: 'transparent', display: 'block', colorScheme: 'normal' }} />
        {/* colorScheme: a dark console around a template that declares no colour scheme makes Chrome paint the frame opaque white. */}
      </div>
    </div>
  )
}

export const GraphicStage = forwardRef<StageHandle, {
  layers: StageLayer[]
  background?: StageBackground
  safeArea?: boolean
  caption?: string
  /** Zoom to this part of the canvas [x, y, w, h], for thumbnails of small graphics. */
  focus?: [number, number, number, number]
}>(function GraphicStage({ layers, background = 'picture', safeArea = false, caption, focus }, ref) {
  const box = useRef<HTMLDivElement>(null)
  const view = (() => {
    if (!focus) return { w: 1920, x: 0, y: 0, cropped: false }
    const [fx, fy, fw, fh] = focus
    const cw = Math.min(1920, Math.max(fw * 1.3, fh * 1.3 * 16 / 9, 560)), ch = cw * 9 / 16
    const clamp = (v: number, hi: number) => Math.max(0, Math.min(v, hi))
    return { w: cw, x: clamp(fx + fw / 2 - cw / 2, 1920 - cw), y: clamp(fy + fh / 2 - ch / 2, 1080 - ch), cropped: true }
  })()
  const [scale, setScale] = useState(0.4)
  const [errors, setErrors] = useState<Record<string, string>>({})
  const posts = useRef(new Map<string, (op: string, data?: any) => void>())
  useLayoutEffect(() => {
    const el = box.current; if (!el) return
    const ro = new ResizeObserver(() => setScale(el.clientWidth / view.w))
    ro.observe(el); setScale(el.clientWidth / view.w)
    return () => ro.disconnect()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view.w])
  useImperativeHandle(ref, () => ({
    next: (key) => { for (const [k, p] of posts.current) if (!key || k === key) p('next') },
    replay: (key) => { for (const [k, p] of posts.current) if (!key || k === key) { p('stop'); setTimeout(() => p('play'), 450) } },
  }), [])
  const onError = (key: string, msg: string | null) => setErrors((e) => {
    const n = { ...e }; if (msg) n[key] = msg; else delete n[key]; return n
  })
  const errList = Object.values(errors)
  return (
    <div className={`gfx-stage bg-${background}`} ref={box}>
      {background === 'picture' && <div className="gfx-picture" aria-hidden="true"><span>Picture</span></div>}
      {layers.map((l) => <Layer key={l.key + l.url} layer={l} scale={scale} crop={view.cropped ? { x: view.x, y: view.y } : null} onError={onError}
        register={(k, p) => { if (p) posts.current.set(k, p); else posts.current.delete(k) }} />)}
      {safeArea && <div className="gfx-safe" aria-hidden="true"><i /><b /></div>}
      {caption && <div className="gfx-stage-cap">{caption}</div>}
      {errList.length > 0 && <div className="gfx-stage-err" role="status">Template error: {errList[0]}</div>}
    </div>
  )
})
