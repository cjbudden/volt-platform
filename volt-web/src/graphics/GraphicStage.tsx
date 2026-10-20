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

export type LayerHealth = 'loading' | 'ready' | 'drawn' | 'blank' | 'no-answer'
/** How long a template page has to start before the stage says it did not load. */
const LOAD_TIMEOUT_MS = 10_000

function Layer({ layer, scale, crop, onError, onHealth, register }: {
  layer: StageLayer; scale: number; crop: { x: number; y: number } | null; onError: (key: string, msg: string | null) => void
  onHealth: (key: string, h: LayerHealth, box?: [number, number, number, number]) => void
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
    if (layer.onAir !== last.current.onAir) {
      post(layer.onAir ? 'play' : 'stop'); last.current.onAir = layer.onAir
      // Once its animation has had time to run, ask the bridge whether anything is on screen.
      if (layer.onAir) { probes.current = 0; schedule() }
    }
  }
  const probeT = useRef<ReturnType<typeof setTimeout>>(undefined)
  const probes = useRef(0)
  /**
   * Ask only while the frame is on screen: Chrome pauses animation in
   * off-screen cross-origin frames, so a graphic below the fold would look empty.
   */
  const schedule = (ms = 2500) => {
    clearTimeout(probeT.current)
    probeT.current = setTimeout(() => {
      const r = ref.current?.getBoundingClientRect()
      const visible = !!r && r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth && !document.hidden
      if (visible) post('probe'); else schedule(1500)
    }, ms)
  }

  useEffect(() => {
    const onMsg = (e: MessageEvent) => {
      if (e.source !== ref.current?.contentWindow || !e.data || typeof e.data !== 'object') return
      if (e.data.type === 'volt-gfx-ready') { ready.current = true; clearTimeout(loadT); onHealth(layer.key, 'ready'); last.current = { values: '', onAir: null }; onError(layer.key, null); sync() }
      if (e.data.type === 'volt-gfx-probe') {
        const box = Array.isArray(e.data.box) && e.data.box.length === 4 && e.data.box.every(Number.isFinite) ? e.data.box as [number, number, number, number] : undefined
        if (Number(e.data.visible) > 0) onHealth(layer.key, 'drawn', box)
        else if (++probes.current < 2) schedule(3000)   // slow animations get a second look
        else onHealth(layer.key, 'blank')
      }
      if (e.data.type === 'volt-gfx-error') onError(layer.key, String(e.data.message ?? 'The template reported an error'))
    }
    onHealth(layer.key, 'loading')
    // No bridge answer: the URL did not serve a template (a dev server without the /gfx proxy
    // serves the console's own page), or the page never finished loading.
    const loadT = setTimeout(() => { if (!ready.current) onHealth(layer.key, 'no-answer') }, LOAD_TIMEOUT_MS)
    window.addEventListener('message', onMsg)
    register(layer.key, post)
    return () => { clearTimeout(loadT); clearTimeout(probeT.current); window.removeEventListener('message', onMsg); register(layer.key, null) }
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
  /** A ribbon across the top: what state the template is in (In development, 2 errors...). */
  badge?: { text: string; tone: 'dev' | 'error' | 'info' }
  /** Shown in place of the picture when there are no layers. */
  empty?: string
  /** Compact wording for small thumbnails. */
  compact?: boolean
  /** With no focus, zoom to where the graphic actually drew (thumbnails of graphics that declare no area). */
  autoFocus?: boolean
}>(function GraphicStage({ layers, background = 'picture', safeArea = false, caption, focus: focusProp, badge, empty, compact, autoFocus }, ref) {
  const box = useRef<HTMLDivElement>(null)
  const [drawnBox, setDrawnBox] = useState<[number, number, number, number] | undefined>()
  const focus = focusProp ?? (autoFocus && drawnBox && drawnBox[2] * drawnBox[3] < 1920 * 1080 * 0.5 ? drawnBox : undefined)
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
  const [health, setHealth] = useState<Record<string, LayerHealth>>({})
  const onHealth = (key: string, h: LayerHealth, b?: [number, number, number, number]) => {
    setHealth((m) => (m[key] === h ? m : { ...m, [key]: h }))
    if (b && layers.length === 1 && !drawnBox) setDrawnBox(b)
  }
  const hs = layers.map((l) => health[l.key] ?? 'loading')
  const anyOn = layers.some((l) => l.onAir)
  const note = !layers.length ? (empty ?? 'No preview') :
    hs.includes('no-answer') ? (compact ? 'Preview did not load' : 'The preview did not load: the template page did not answer within 10 seconds. If the console runs from the dev server, restart it so /gfx is proxied to the API.') :
    errList.length ? null :
    anyOn && hs.length && hs.every((h) => h === 'blank') ? (compact ? 'Nothing drawn with sample data' : 'The template ran but drew nothing with this data. Try other sample values, or check its play().') :
    hs.some((h) => h === 'loading') ? 'Loading preview…' : null
  return (
    <div className={`gfx-stage bg-${background}`} ref={box}>
      {background === 'picture' && <div className="gfx-picture" aria-hidden="true"><span>Picture</span></div>}
      {layers.map((l) => <Layer key={l.key + l.url} layer={l} scale={scale} crop={view.cropped ? { x: view.x, y: view.y } : null} onError={onError} onHealth={onHealth}
        register={(k, p) => { if (p) posts.current.set(k, p); else posts.current.delete(k) }} />)}
      {safeArea && <div className="gfx-safe" aria-hidden="true"><i /><b /></div>}
      {caption && <div className="gfx-stage-cap">{caption}</div>}
      {errList.length > 0 && <div className="gfx-stage-err" role="status">Template error: {errList[0]}</div>}
      {badge && <div className={`gfx-stage-badge ${badge.tone}`}>{badge.text}</div>}
      {note && <div className={`gfx-stage-note${note === 'Loading preview…' ? ' quiet' : ''}${compact ? ' compact' : ''}`} role="status">{note}</div>}
    </div>
  )
})
