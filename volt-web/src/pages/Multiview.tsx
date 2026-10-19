import { useEffect, useMemo, useRef, useState } from 'react'
import { api, type LiveStream } from '../api'
import { navigate } from '../router'
import { pressable } from '../a11y'
import { PageError, usePageNotice } from '../notices'

/* ============================================================================
   MULTIVIEW — the wall of confidence monitors.

   A broadcast multiviewer exists because a status light can be green while the
   picture is wrong. Nothing in the five-gate model can tell you the video is
   upside down, the wrong feed is patched, or the presenter's mic is dead. Only
   a person looking can, and this is the screen they look at.

   FOUR DECISIONS THAT MAKE IT A MULTIVIEWER RATHER THAN A PAGE OF PLAYERS.

   IT MONITORS THE ORIGIN, NOT THE PUBLIC URL. Each tile plays
   /origin/<id>/live/master.m3u8: what the encoder is producing right now,
   whether or not the channel has been published. An operator has to see the
   picture BEFORE taking it on air, which is exactly when the public URL is
   closed.

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
function Tile({ s, playing, soloed, onToggle, onSolo }: {
  s: LiveStream
  playing: boolean
  soloed: boolean
  onToggle: () => void
  onSolo: () => void
}) {
  const ref = useRef<HTMLVideoElement & HTMLAudioElement | null>(null)
  const [err, setErr] = useState('')
  const [el, setEl] = useState<HTMLMediaElement | null>(null)
  const level = useLevel(s.audioOnly ? el : null, playing && s.audioOnly)
  const tone = GATE_TONE[s.overall] ?? '#64748b'

  useEffect(() => {
    const m = ref.current
    if (!m) return
    let hls: any = null
    let killed = false
    setErr('')

    async function attach() {
      if (!m) return
      try {
        if (m.canPlayType('application/vnd.apple.mpegurl')) {
          m.src = s.previewUrl
          await m.play().catch(() => {})
          return
        }
        const Hls = (await import('hls.js')).default
        if (killed) return
        if (!Hls.isSupported()) { setErr('HLS unsupported here'); return }
        // A monitor wants the live edge, not a buffered-back copy: a
        // multiviewer that is eight seconds behind is a multiviewer that
        // shows you a fault after the viewers have already seen it.
        hls = new Hls({ liveDurationInfinity: true, lowLatencyMode: true, backBufferLength: 10 })
        hls.loadSource(s.previewUrl)
        hls.attachMedia(m)
        hls.on(Hls.Events.MANIFEST_PARSED, () => m.play().catch(() => {}))
        hls.on(Hls.Events.ERROR, (_e: any, d: any) => {
          if (d?.fatal) setErr(SIGNAL_FAULT[d.details] ?? d.details ?? 'no signal')
        })
      } catch (e: any) { setErr(e?.message || 'no signal') }
    }

    if (playing) attach()
    else { try { m.pause(); m.removeAttribute('src'); m.load() } catch { /* ignore */ } }

    return () => {
      killed = true
      if (hls) { try { hls.destroy() } catch { /* ignore */ } }
    }
  }, [playing, s.previewUrl])

  // Audio is exclusive across the wall: exactly one tile is monitored at a time.
  useEffect(() => {
    const m = ref.current
    if (m) m.muted = !soloed
  }, [soloed, playing])

  return (
    <div style={{
      border: `2px solid ${tone}`, borderRadius: 12, overflow: 'hidden',
      background: '#05070c', position: 'relative',
      boxShadow: soloed ? `0 0 0 2px ${tone}55` : undefined,
    }}>
      <div style={{
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

        {!playing && !s.audioOnly && (
          <button onClick={onToggle} className="btn ghost"
            style={{ position: 'absolute', inset: 0, margin: 'auto', width: 96, height: 34 }}>
            Monitor
          </button>
        )}
        {err && (
          <div style={{
            position: 'absolute', inset: 0, display: 'grid', placeItems: 'center',
            background: 'rgba(5,7,12,.72)', color: '#fca5a5', fontSize: 'var(--fs-sm)',
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
        <span style={{ fontSize: 'var(--fs-micro)', color: 'var(--faint)', flex: 'none' }}>
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
export default function MultiviewPage() {
  const [streams, setStreams] = useState<LiveStream[] | null>(null)
  const [err, setErr] = useState('')
  const [playing, setPlaying] = useState<Set<string>>(new Set())
  const [solo, setSolo] = useState<string | null>(null)
  const [cols, setCols] = useState(3)
  const dead = useRef(false)

  async function load() {
    try { const b = await api.liveBoard(); setStreams(b.streams); setErr('') }
    catch (e: any) { setErr(e.message) }
  }

  // The wall refreshes its STATE often; the video elements are left alone, so a
  // refresh never interrupts what an operator is watching.
  useEffect(() => {
    dead.current = false
    load()
    const h = setInterval(() => { if (!dead.current) load() }, 15000)
    return () => { dead.current = true; clearInterval(h) }
    /* eslint-disable-next-line */
  }, [])

  const tiles = useMemo(
    () => (streams ?? []).filter(s => MONITORABLE.has(s.overall)),
    [streams]
  )

  function toggle(id: string) {
    setPlaying(p => {
      const n = new Set(p)
      if (n.has(id)) { n.delete(id); if (solo === id) setSolo(null) }
      else n.add(id)
      return n
    })
  }

  usePageNotice('load', err && streams ? { kind: 'error', title: "Couldn't load the streams.", message: err, actions: [{ label: 'Retry', onClick: () => { load() } }] } : null)

  if (err && !streams) return <PageError message={err} onRetry={load} />
  if (!streams) return <div className="card p-4"><div className="loading">Loading the wall…</div></div>

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Multiview</h1>
          <p>Confidence monitors on the encoder output. A green light cannot tell you the picture is wrong.</p>
        </div>
        <div className="spacer" />
        <div className="flex items-center gap-2">
          {[2, 3, 4].map(c => (
            <button key={c} className={`btn ${cols === c ? '' : 'ghost'}`} onClick={() => setCols(c)}>
              {c}×
            </button>
          ))}
          <button className="btn ghost" disabled={!tiles.length}
            onClick={() => setPlaying(new Set(tiles.map(t => t.id)))}>
            Monitor all
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
          <div style={{
            display: 'grid', gap: 12,
            gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`,
          }}>
            {tiles.map(s => (
              <Tile key={s.id} s={s}
                playing={playing.has(s.id)}
                soloed={solo === s.id}
                onToggle={() => toggle(s.id)}
                onSolo={() => setSolo(v => (v === s.id ? null : s.id))} />
            ))}
          </div>
          <p style={{ color: 'var(--faint)', fontSize: 'var(--fs-sm)', marginTop: 14 }}>
            Tiles start paused and muted: every playing tile is a decode, and a wall that
            autoplays everything stalls the browser. One tile's audio can be monitored at a time.
          </p>
        </>
      )}
    </>
  )
}
