import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { api, type LiveStream } from '../api'
import { navigate } from '../router'
import { pressable } from '../a11y'
import { PageError, usePageNotice } from '../notices'
import { subscribeLive } from '../liveStatus'
import { useStatsPanel } from '../useStatsPanel'
import type { StatsProbe } from '@volt/player/stats'

/* ============================================================================
   MULTIVIEW — the wall of confidence monitors.

   A broadcast multiviewer exists because a status light can be green while the
   picture is wrong. Nothing in the five-gate model can tell you the video is
   upside down, the wrong feed is patched, or the presenter's mic is dead. Only
   a person looking can, and this is the screen they look at.

   FOUR DECISIONS THAT MAKE IT A MULTIVIEWER RATHER THAN A PAGE OF PLAYERS.

   IT MONITORS WHAT VIEWERS ARE GIVEN, FROM THE ORIGIN. Each tile plays the
   DELIVERED manifest (the encoder's *_cc copies: wall clock, splice, triggers)
   straight from the origin, so it works before the stream is public, which is
   exactly when an operator needs to see it. "Packager" switches to the
   packager's own files when the question is the encoder rather than delivery.
   "Viewer location" plays the same output through the edge's rights decision
   for one country (/origin/<id>/as/<CC>/...), so a blackout or replacement can
   be watched on the wall, beside the decision and its reason.

   ALWAYS hls.js WHERE MSE EXISTS. Chrome reports native HLS support on desktop
   ('maybe' since late 2025), and the old "native first" order put every tile
   on Chrome's built-in player. Measured 23 Oct 2026: it started at the OLDEST
   segment of the five-minute window (the picture "rolled back" on every
   Monitor click) and played audio and video from different points. The
   encoder output itself was in sync to the millisecond. Native is now only
   for browsers without MSE (iPhone), and it is snapped to the live edge.

   THE WALL IS PAGED TO WHAT FITS. The number of tiles per page comes from the
   screen and the column choice, and at most MAX_PLAYING decode at once: the
   browser, not the server, is the limit on a monitor wall.

   FLAGS COST NOTHING. Sources, outputs, timing and NO SOURCE are drawn from
   the board row the page already has; no request per flag. The board itself
   is refreshed on stream events from the shared status socket (not on every
   heartbeat), with a slow poll as the backstop, and the server computes it
   once per account every two seconds however many walls are open.

   DEBUG MODE on every tile: right-click > Debug mode, Shift+D or Cmd/Ctrl+D.
   It says which side a problem is on (this device, access rules, delivery,
   the stream, the player) and whether it is worth reporting.

   TILES ARE MUTED AND START PAUSED. Twelve autoplaying streams is twelve
   simultaneous decodes and twelve audio tracks, and no browser survives it.
   Playback is per-tile and opt-in; audio is exclusive, so selecting one tile's
   sound mutes the rest. That mirrors a real multiviewer's audio bus, where
   exactly one source is monitored at a time.

   THE TILE FRAME CARRIES THE STATE. A tile is bordered by its pipeline state,
   so a wall of green with one red edge reads instantly from across a room,
   before any label is legible. The label is there for when you walk closer.

   AUDIO-ONLY IS NOT A BLACK SQUARE. Radio has no picture, so its tile renders
   a live level meter drawn from the actual audio, which is the thing an
   operator would be checking anyway. A black video element would look like a
   fault.
   ========================================================================== */

const GATE_TONE: Record<string, string> = {
  onair: '#4ade80', ready: '#38bdf8', starting: '#60a5fa',
  degraded: '#fbbf24', error: '#f87171', stopped: '#94a3b8', idle: '#64748b',
}

const STATE_LABEL: Record<string, string> = {
  onair: 'ON AIR', ready: 'READY', starting: 'STARTING',
  degraded: 'DEGRADED', error: 'DOWN', stopped: 'STOPPED', idle: 'IDLE',
}

/** Streams worth a tile: anything with a pipeline doing work. */
const MONITORABLE = new Set(['onair', 'ready', 'starting', 'degraded'])

/* hls.js reports failures with its own internal names. "manifestLoadError" is
   accurate and useless: what an operator needs to read on a monitor wall is
   the broadcast word for the condition. Anything unmapped falls through to the
   raw detail rather than being flattened, so a novel fault stays diagnosable. */
const SIGNAL_FAULT: Record<string, string> = {
  manifestLoadError: 'no signal',
  manifestLoadTimeOut: 'no signal',
  manifestParsingError: 'bad manifest',
  levelLoadError: 'signal lost',
  levelLoadTimeOut: 'signal lost',
  fragLoadError: 'dropping segments',
  fragLoadTimeOut: 'dropping segments',
  fragParsingError: 'corrupt segments',
  bufferStalledError: 'stalled',
  bufferAppendError: 'decode failed',
  audioTrackLoadError: 'no audio',
}

// ---------------------------------------------------------------------------
//  A live level meter for audio-only tiles. Peak amplitude, not loudness: the
//  same definition the recording waveform uses, so a level that looks high
//  here means the same thing it means there.
// ---------------------------------------------------------------------------
/**
 * ONE AudioContext and ONE source node per media element, for the lifetime of
 * the page.
 *
 * `createMediaElementSource` may be called only once per element, and once it
 * has been, that element's audio is permanently routed through the graph.
 * Building a fresh context inside the effect meant Stop → Play threw
 * InvalidStateError on the second Play; the throw was swallowed, so the meter
 * sat at silence and the tile produced no sound even when soloed — a station
 * that was broadcasting perfectly looked like dead air on the wall. The same
 * WeakMap pattern is already used by AudioVisualizer for the same reason.
 */
const wired = new WeakMap<HTMLMediaElement, { ctx: AudioContext; an: AnalyserNode }>()

function wireMeter(el: HTMLMediaElement): { ctx: AudioContext; an: AnalyserNode } | null {
  const got = wired.get(el)
  if (got) return got
  try {
    const ctx = new (window.AudioContext || (window as any).webkitAudioContext)()
    const src = ctx.createMediaElementSource(el)
    const an = ctx.createAnalyser()
    an.fftSize = 1024
    src.connect(an)
    an.connect(ctx.destination)   // keep the tile audible
    const rec = { ctx, an }
    wired.set(el, rec)
    return rec
  } catch { return null }
}

function useLevel(el: HTMLMediaElement | null, on: boolean) {
  const [level, setLevel] = useState(0)
  useEffect(() => {
    if (!el || !on) { setLevel(0); return }
    const rec = wireMeter(el)
    if (!rec) return                       // a tile without a meter still plays
    // A context created before a user gesture starts suspended.
    if (rec.ctx.state === 'suspended') rec.ctx.resume().catch(() => { /* ignore */ })
    let raf = 0
    let dead = false
    const buf = new Float32Array(rec.an.fftSize)
    const tick = () => {
      if (dead) return
      rec.an.getFloatTimeDomainData(buf)
      let peak = 0
      for (let i = 0; i < buf.length; i++) { const v = Math.abs(buf[i]); if (v > peak) peak = v }
      setLevel(peak)
      raf = requestAnimationFrame(tick)
    }
    tick()
    // The context is NOT closed here: it belongs to the element, not to this
    // subscription, and closing it would make the next Play silent forever.
    return () => { dead = true; cancelAnimationFrame(raf) }
  }, [el, on])
  return level
}

function Meter({ level }: { level: number }) {
  // Peak amplitude on a dB scale, floored at -60: linear amplitude spends
  // almost all its range in the top few dB and reads as a meter that never moves.
  const db = level > 0 ? 20 * Math.log10(level) : -60
  const pct = Math.max(0, Math.min(1, (db + 60) / 60))
  const tone = db > -1 ? '#f87171' : db > -6 ? '#fbbf24' : '#4ade80'
  return (
    <div style={{ width: '100%', padding: '0 18px' }}>
      <div style={{ height: 8, borderRadius: 4, background: 'rgba(255,255,255,.08)', overflow: 'hidden' }}>
        <div style={{
          width: `${pct * 100}%`, height: '100%', background: tone,
          transition: 'width 60ms linear',
        }} />
      </div>
      <div style={{
        marginTop: 6, fontSize: 'var(--fs-micro)', color: 'var(--faint)',
        fontVariantNumeric: 'tabular-nums', textAlign: 'center',
      }}>
        peak {db <= -60 ? '−∞' : `${db.toFixed(1)}`} dBFS
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
//  Tile flags: sources on the left, outputs on the right. Pure, from the row.
// ---------------------------------------------------------------------------
type Flag = { label: string; tone: string; title: string }
const T = { ok: '#4ade80', warn: '#fbbf24', bad: '#f87171', info: '#93c5fd', dim: '#94a3b8' }
const SRC_SHORT: Record<string, string> = { primary: 'PRI', backup: 'BKP', filler: 'FILL' }

export function sourceFlags(s: LiveStream): Flag[] {
  const out: Flag[] = []
  if (s.noSource) out.push({ label: 'NO SOURCE', tone: T.warn, title: 'Running and listening, but no source has been pushed yet' })
  for (const [k, st] of Object.entries(s.sources ?? {})) {
    if (k === 'filler') continue
    const tone = st === 'up' ? T.ok : st === 'down' ? T.bad : T.warn
    out.push({ label: `${SRC_SHORT[k] ?? k.toUpperCase().slice(0, 4)} ${st === 'up' ? 'UP' : st === 'down' ? 'DOWN' : 'WAIT'}`, tone, title: `${k} source: ${st}` })
  }
  if (s.fillerInUse) out.push({ label: 'FILLER ON AIR', tone: T.bad, title: 'Every source is lost: the slate or loop is on air' })
  else if (s.fallbackInUse) out.push({ label: `ON ${String(s.activeSource ?? 'backup').toUpperCase()}`, tone: T.warn, title: 'Failed over from the primary source' })
  return out
}

export function outputFlags(s: LiveStream): Flag[] {
  const out: Flag[] = []
  if (s.outputAvailable === false) out.push({ label: 'OUTPUT DOWN', tone: T.bad, title: 'The encoder reports the output is not being fed' })
  for (const [o, why] of Object.entries(s.degradedOutputs ?? {})) out.push({ label: `${o.toUpperCase()} DROPPED`, tone: T.bad, title: why })
  if (s.timingFault) out.push({ label: 'TIMING', tone: T.warn, title: s.timingFault })
  if (s.reportAgeMs != null && s.reportAgeMs > 30000 && s.uptimeMs != null) out.push({ label: `NO REPORT ${Math.round(s.reportAgeMs / 1000)}s`, tone: T.warn, title: 'The encoder has stopped reporting' })
  out.push(s.onAir ? { label: 'PUBLIC', tone: T.ok, title: 'On air: the public URL serves this' } : { label: 'PRIVATE', tone: T.dim, title: 'Not on air: viewers cannot see this yet' })
  return out
}

function Flags({ flags, align }: { flags: Flag[]; align: 'left' | 'right' }) {
  if (!flags.length) return null
  return (
    <div style={{
      position: 'absolute', top: 6, [align]: 6, display: 'flex', flexWrap: 'wrap', gap: 4,
      justifyContent: align === 'right' ? 'flex-end' : 'flex-start', maxWidth: '48%', zIndex: 3, pointerEvents: 'auto',
    }}>
      {flags.map(f => (
        <span key={f.label} title={f.title} style={{
          display: 'inline-flex', alignItems: 'center', gap: 4, padding: '1px 6px', borderRadius: 4,
          background: 'rgba(5,7,12,.72)', color: '#e5e7eb', fontSize: 9.5, fontWeight: 700, letterSpacing: '.04em',
          whiteSpace: 'nowrap', lineHeight: '16px',
        }}>
          <i style={{ width: 6, height: 6, borderRadius: '50%', background: f.tone, flex: 'none' }} />
          {f.label}
        </span>
      ))}
    </div>
  )
}

/** The URL a tile plays for the chosen output and viewer location. */
export function tileUrl(s: LiveStream, output: 'delivered' | 'packager', cc: string): string {
  const base = output === 'packager' ? s.previewUrl : (s.deliveredUrl || s.previewUrl)
  if (!cc || s.audioOnly) return base
  const file = base.replace(/^.*\/live\//, '')
  return `/origin/${s.id}/as/${cc}/${file}`
}

// ---------------------------------------------------------------------------
function Tile({ s, url, cc, playing, soloed, onToggle, onSolo }: {
  s: LiveStream
  url: string
  cc: string
  playing: boolean
  soloed: boolean
  onToggle: () => void
  onSolo: () => void
}) {
  const ref = useRef<HTMLVideoElement & HTMLAudioElement | null>(null)
  const box = useRef<HTMLDivElement | null>(null)
  const hlsRef = useRef<any>(null)
  const [err, setErr] = useState('')
  const [el, setEl] = useState<HTMLMediaElement | null>(null)
  const [edge, setEdge] = useState<{ decision?: string; reason?: string; until?: number | null } | null>(null)
  const level = useLevel(s.audioOnly ? el : null, playing && s.audioOnly)
  const tone = GATE_TONE[s.overall] ?? '#64748b'

  // What only the board knows goes into debug mode as the SERVER's verdict, so
  // the panel can tell "your connection" from "the stream" on this wall too.
  const extra = useRef<StatsProbe | null>(null)
  extra.current = () => ({
    server: s.timingFault ? { state: 'fault', detail: `Output timing fault: ${s.timingFault}` }
      : s.overall === 'error' ? { state: 'fault', detail: s.primaryError?.message ?? 'pipeline error' }
      : { state: 'ok' },
  })
  useStatsPanel(box, ref as any, { hls: hlsRef }, extra)

  // the edge's decision for this country, beside the picture (cached server side)
  useEffect(() => {
    if (!cc || s.audioOnly) { setEdge(null); return }
    let dead = false
    const load = () => api.edgeViewAs(s.id, cc).then(r => { if (!dead) setEdge(r) }).catch(() => { if (!dead) setEdge(null) })
    load()
    const h = setInterval(load, 60000)
    return () => { dead = true; clearInterval(h) }
  }, [cc, s.id, s.audioOnly])

  useEffect(() => {
    const m = ref.current
    if (!m) return
    let hls: any = null
    let killed = false
    let retry: ReturnType<typeof setTimeout> | null = null
    setErr('')

    async function attach() {
      if (!m) return
      try {
        const Hls = (await import('hls.js')).default
        if (killed) return
        if (Hls.isSupported()) {
          // A monitor wants the live edge and a quick first picture: two
          // segments behind live, catch up gently if it falls behind, and
          // pick the rendition the tile can show (a small tile never pulls 1080p).
          hls = new Hls({
            lowLatencyMode: false, liveSyncDurationCount: 2, liveMaxLatencyDurationCount: 5,
            maxLiveSyncPlaybackRate: 1.2, capLevelToPlayerSize: true, backBufferLength: 10, maxBufferLength: 12,
            manifestLoadingMaxRetry: 4, levelLoadingMaxRetry: 4, fragLoadingMaxRetry: 4,
          })
          hlsRef.current = hls
          hls.loadSource(url)
          hls.attachMedia(m)
          hls.on(Hls.Events.MANIFEST_PARSED, () => m.play().catch(() => {}))
          hls.on(Hls.Events.FRAG_BUFFERED, () => setErr(''))
          hls.on(Hls.Events.ERROR, (_e: any, d: any) => {
            if (!d?.fatal) return
            const code = d?.response?.code
            if (code === 451) { setErr(`blocked for ${cc || 'this location'} (rights)`); return }
            if (code === 401 || code === 403) { setErr('not permitted'); return }
            if (d.type === Hls.ErrorTypes.MEDIA_ERROR) { try { hls.recoverMediaError() } catch { /* */ } return }
            setErr(SIGNAL_FAULT[d.details] ?? d.details ?? 'no signal')
            retry = setTimeout(() => { try { hls.loadSource(url); hls.startLoad() } catch { /* */ } }, 3000)
          })
          return
        }
        if (m.canPlayType('application/vnd.apple.mpegurl')) {
          // No MSE (iPhone): the platform player, snapped to the live edge.
          m.src = url
          m.addEventListener('loadedmetadata', () => {
            try { const sk = m.seekable; if (sk.length) m.currentTime = Math.max(sk.start(0), sk.end(sk.length - 1) - 8) } catch { /* */ }
          }, { once: true })
          await m.play().catch(() => {})
          return
        }
        setErr('HLS unsupported here')
      } catch (e: any) { setErr(e?.message || 'no signal') }
    }

    if (playing) attach()
    else { try { m.pause(); m.removeAttribute('src'); m.load() } catch { /* ignore */ } }

    return () => {
      killed = true
      if (retry) clearTimeout(retry)
      if (hls) { try { hls.destroy() } catch { /* ignore */ } }
      hlsRef.current = null
    }
  }, [playing, url, cc])

  // Audio is exclusive across the wall: exactly one tile is monitored at a time.
  useEffect(() => {
    const m = ref.current
    if (m) m.muted = !soloed
  }, [soloed, playing])

  const fmtUntil = (u?: number | null) => u ? new Date(u * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : ''

  return (
    <div style={{
      border: `2px solid ${tone}`, borderRadius: 12, overflow: 'hidden',
      background: '#05070c', position: 'relative',
      boxShadow: soloed ? `0 0 0 2px ${tone}55` : undefined,
    }}>
      <div ref={box} style={{
        position: 'relative', aspectRatio: '16 / 9', display: 'grid', placeItems: 'center',
      }}>
        {s.audioOnly ? (
          <>
            <audio ref={ref as any} crossOrigin="anonymous" style={{ display: 'none' }}
              onCanPlay={e => setEl(e.currentTarget)} />
            {playing
              ? <Meter level={level} />
              : <span style={{ color: 'var(--faint)', fontSize: 'var(--fs-sm)' }}>audio only</span>}
          </>
        ) : (
          <video ref={ref as any} playsInline muted crossOrigin="anonymous"
            style={{ width: '100%', height: '100%', objectFit: 'contain', background: '#05070c' }} />
        )}

        <Flags flags={sourceFlags(s)} align="left" />
        <Flags flags={outputFlags(s)} align="right" />

        {edge?.decision && (
          <div title={edge.reason} style={{
            position: 'absolute', left: 6, bottom: 6, zIndex: 3, padding: '1px 7px', borderRadius: 4,
            background: 'rgba(5,7,12,.78)', fontSize: 10, fontWeight: 700, letterSpacing: '.04em',
            color: edge.decision === 'allow' ? '#86efac' : edge.decision === 'replace' ? '#fde68a' : '#fca5a5',
          }}>
            {cc} · {edge.decision === 'allow' ? 'ALLOWED' : edge.decision === 'replace' ? 'REPLACED' : 'BLOCKED'}
            {edge.until ? ` until ${fmtUntil(edge.until)}` : ''}
          </div>
        )}

        {!playing && !s.audioOnly && (
          <button onClick={onToggle} className="btn ghost"
            style={{ position: 'absolute', inset: 0, margin: 'auto', width: 96, height: 34 }}>
            Monitor
          </button>
        )}
        {err && (
          <div style={{
            position: 'absolute', inset: 0, display: 'grid', placeItems: 'center',
            background: 'rgba(5,7,12,.72)', color: '#fca5a5', fontSize: 'var(--fs-sm)', zIndex: 2,
          }}>{err}</div>
        )}
      </div>

      <div className="flex items-center gap-2" style={{ padding: '7px 10px', background: 'var(--panel-2)' }}>
        <span className="lnk" {...pressable((e: any) => { ((() => navigate(s.href)) as any)(e) })} data-a11y-click=""
          style={{
            fontWeight: 700, fontSize: 'var(--fs-sm)', cursor: 'pointer', minWidth: 0,
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          }}>{s.name}</span>
        <span style={{
          fontSize: 9, fontWeight: 700, letterSpacing: 'var(--ls-label)', color: tone, flex: 'none',
        }}>{STATE_LABEL[s.overall] ?? s.overall.toUpperCase()}</span>
        <div style={{ flex: 1 }} />
        <span style={{ fontSize: 'var(--fs-micro)', color: 'var(--faint)', flex: 'none' }} title="Viewers now">
          {s.concurrent.toLocaleString()}
        </span>
        <button className="btn ghost" style={{ padding: '2px 8px', fontSize: 'var(--fs-micro)', flex: 'none' }}
          onClick={onToggle}>{playing ? 'Stop' : 'Play'}</button>
        <button className="btn ghost" style={{
          padding: '2px 8px', fontSize: 'var(--fs-micro)', flex: 'none',
          color: soloed ? tone : undefined,
        }} disabled={!playing} onClick={onSolo}
          title="Monitor this tile's audio; every other tile is muted">
          {soloed ? '🔊' : '🔇'}
        </button>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
/** At most this many tiles decode at once, whatever fits on the page. */
export const MAX_PLAYING = 9
/** Never more tiles than this on one page, however large the screen. */
export const MAX_PER_PAGE = 16
const GAP = 12
const FOOTER_H = 38

/** Columns for a width when the operator has not chosen. */
export function autoCols(width: number): number {
  return width < 640 ? 1 : width < 1050 ? 2 : width < 1600 ? 3 : 4
}

/** Tiles per page: whole rows that fit the visible height, at least one row. */
export function tilesPerPage(width: number, height: number, cols: number): number {
  const tileW = (width - GAP * (cols - 1)) / cols
  const tileH = tileW * 9 / 16 + FOOTER_H + 4
  const rows = Math.max(1, Math.floor((height + GAP) / (tileH + GAP)))
  return Math.max(1, Math.min(MAX_PER_PAGE, rows * cols))
}

const PRESET_CC = ['MY', 'SG', 'ID', 'AU', 'NZ', 'GB', 'US']

export default function MultiviewPage() {
  const [streams, setStreams] = useState<LiveStream[] | null>(null)
  const [err, setErr] = useState('')
  const [playing, setPlaying] = useState<Set<string>>(new Set())
  const [solo, setSolo] = useState<string | null>(null)
  const [colsPick, setColsPick] = useState<number | 'auto'>('auto')
  const [output, setOutput] = useState<'delivered' | 'packager'>('delivered')
  const [cc, setCc] = useState('')
  const [ruleCc, setRuleCc] = useState<Record<string, string[]>>({})
  const [page, setPage] = useState(0)
  const [size, setSize] = useState({ w: 1200, h: 800 })
  const grid = useRef<HTMLDivElement | null>(null)
  const dead = useRef(false)

  async function load() {
    try { const b = await api.liveBoard(); setStreams(b.streams); setErr('') }
    catch (e: any) { setErr(e.message) }
  }

  // STATE ON CHANGE, NOT ON A CLOCK. Stream events (source up/down, failover,
  // start/stop, timing) arrive on the app's one status socket; heartbeats do
  // not wake the wall. A slow poll catches what is not an event (a manifest
  // that starts advancing). The video elements are never touched by a refresh.
  useEffect(() => {
    dead.current = false
    load()
    let t: ReturnType<typeof setTimeout> | null = null
    const unsub = subscribeLive('*', (msg) => {
      if (msg.type !== 'event' && msg.type !== 'resync') return
      if (t) return
      t = setTimeout(() => { t = null; if (!dead.current) load() }, 3000)
    })
    const h = setInterval(() => { if (!dead.current) load() }, 30000)
    return () => { dead.current = true; clearInterval(h); if (t) clearTimeout(t); unsub() }
    /* eslint-disable-next-line */
  }, [])

  // what fits: the grid's width and the height left below it on screen
  useLayoutEffect(() => {
    const measure = () => {
      const g = grid.current
      if (!g) return
      const r = g.getBoundingClientRect()
      setSize({ w: r.width, h: Math.max(240, window.innerHeight - Math.max(0, r.top) - 70) })
    }
    measure()
    const ro = new ResizeObserver(measure)
    if (grid.current) ro.observe(grid.current)
    window.addEventListener('resize', measure)
    return () => { ro.disconnect(); window.removeEventListener('resize', measure) }
  }, [streams === null])

  const tiles = useMemo(
    () => (streams ?? []).filter(s => MONITORABLE.has(s.overall)),
    [streams]
  )
  const cols = colsPick === 'auto' ? autoCols(size.w) : colsPick
  const perPage = tilesPerPage(size.w, size.h, cols)
  const pages = Math.max(1, Math.ceil(tiles.length / perPage))
  const pg = Math.min(page, pages - 1)
  const shown = tiles.slice(pg * perPage, pg * perPage + perPage)
  const shownKey = shown.map(t => t.id).join(',')

  // Off the page means off: a tile that is not drawn must not keep decoding.
  useEffect(() => {
    const on = new Set(shown.map(t => t.id))
    setPlaying(p => {
      const n = new Set([...p].filter(id => on.has(id)))
      return n.size === p.size ? p : n
    })
    if (solo && !on.has(solo)) setSolo(null)
    /* eslint-disable-next-line */
  }, [shownKey])

  // countries the visible streams' rules name: the ones worth testing
  useEffect(() => {
    for (const t of shown) {
      if (t.audioOnly || ruleCc[t.id]) continue
      api.edgeViewAs(t.id).then(r => setRuleCc(m => ({ ...m, [t.id]: r.countries ?? [] }))).catch(() => setRuleCc(m => ({ ...m, [t.id]: [] })))
    }
    /* eslint-disable-next-line */
  }, [shownKey])
  const ccOptions = useMemo(() => {
    const fromRules = [...new Set(Object.values(ruleCc).flat())].sort()
    return { fromRules, presets: PRESET_CC.filter(c => !fromRules.includes(c)) }
  }, [ruleCc])

  function toggle(id: string) {
    setPlaying(p => {
      const n = new Set(p)
      if (n.has(id)) { n.delete(id); if (solo === id) setSolo(null) }
      else if (n.size < MAX_PLAYING) n.add(id)
      return n
    })
  }

  usePageNotice('load', err && streams ? { kind: 'error', title: "Couldn't load the streams.", message: err, actions: [{ label: 'Retry', onClick: () => { load() } }] } : null)

  if (err && !streams) return <PageError message={err} onRetry={load} />
  if (!streams) return <div className="card p-4"><div className="loading">Loading the wall…</div></div>

  const atCap = playing.size >= MAX_PLAYING

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Multiview</h1>
          <p>Confidence monitors on what viewers are given. A green light cannot tell you the picture is wrong.</p>
        </div>
        <div className="spacer" />
        <div className="flex items-center gap-2" style={{ flexWrap: 'wrap', justifyContent: 'flex-end' }}>
          <select className="inp" value={output} onChange={e => setOutput(e.target.value as any)}
            title="Delivered: the manifest viewers get. Packager: the packager's own files, to separate an encoder fault from a delivery one."
            style={{ width: 'auto' }}>
            <option value="delivered">Output: delivered</option>
            <option value="packager">Output: packager</option>
          </select>
          <select className="inp" value={cc} onChange={e => setCc(e.target.value)}
            title="Play every tile as a viewer in this country sees it, through the edge's rights rules"
            style={{ width: 'auto' }}>
            <option value="">Viewer location: any</option>
            {ccOptions.fromRules.length > 0 && (
              <optgroup label="Named in these streams' rules">
                {ccOptions.fromRules.map(c => <option key={c} value={c}>{c}</option>)}
              </optgroup>
            )}
            <optgroup label="Other">
              {ccOptions.presets.map(c => <option key={c} value={c}>{c}</option>)}
              <option value="XX">Unknown country</option>
            </optgroup>
          </select>
          {(['auto', 2, 3, 4] as const).map(c => (
            <button key={String(c)} className={`btn ${colsPick === c ? '' : 'ghost'}`} onClick={() => { setColsPick(c); setPage(0) }}>
              {c === 'auto' ? 'Auto' : `${c}×`}
            </button>
          ))}
          <button className="btn ghost" disabled={!shown.length}
            onClick={() => setPlaying(new Set(shown.slice(0, MAX_PLAYING).map(t => t.id)))}
            title={`Play the tiles on this page (at most ${MAX_PLAYING} at once)`}>
            Monitor page
          </button>
          <button className="btn ghost" disabled={!playing.size}
            onClick={() => { setPlaying(new Set()); setSolo(null) }}>
            Stop all
          </button>
        </div>
      </div>

      {tiles.length === 0 ? (
        <div className="empty">
          <h3>Nothing to monitor</h3>
          <p>
            No channel, station or event is producing output. Tiles appear here as soon as a
            pipeline starts, before it goes on air: this monitors the origin, not the public URL.
          </p>
        </div>
      ) : (
        <>
          <div ref={grid} style={{
            display: 'grid', gap: GAP,
            gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`,
          }}>
            {shown.map(s => (
              <Tile key={s.id} s={s}
                url={tileUrl(s, output, cc)}
                cc={cc}
                playing={playing.has(s.id)}
                soloed={solo === s.id}
                onToggle={() => toggle(s.id)}
                onSolo={() => setSolo(v => (v === s.id ? null : s.id))} />
            ))}
          </div>
          <div className="flex items-center gap-2" style={{ marginTop: 12 }}>
            <span style={{ color: 'var(--faint)', fontSize: 'var(--fs-sm)' }}>
              {tiles.length} stream{tiles.length === 1 ? '' : 's'} · {perPage} per page · {playing.size}/{MAX_PLAYING} playing
              {atCap ? ' (decode limit reached: stop one to play another)' : ''}
            </span>
            <div style={{ flex: 1 }} />
            {pages > 1 && (
              <>
                <button className="btn ghost" disabled={pg === 0} onClick={() => setPage(pg - 1)}>Previous</button>
                <span style={{ fontSize: 'var(--fs-sm)' }}>Page {pg + 1} of {pages}</span>
                <button className="btn ghost" disabled={pg >= pages - 1} onClick={() => setPage(pg + 1)}>Next</button>
              </>
            )}
          </div>
          <p style={{ color: 'var(--faint)', fontSize: 'var(--fs-sm)', marginTop: 10 }}>
            Tiles start paused and muted: every playing tile is a decode. One tile's audio can be
            monitored at a time. Right-click a tile, or press Cmd/Ctrl+D over it, for debug mode.
          </p>
        </>
      )}
    </>
  )
}
