// ============================================================================
//  AudioVisualizer — the radio replacement for the 16:9 video surface.
//
//  TWO SOURCES, because the operator's question is "are we RECEIVING audio?",
//  not "is my laptop playing it":
//
//   1. STREAM LEVELS (default). Server-measured levels from the broadcast
//      output (ffmpeg ebur128/astats in the radio monitor). These arrive
//      whether or not anyone is listening, so the meter moves with the SIGNAL
//      even when the page is muted or playback is stopped. Frames are played
//      back on a timer at their real ~100ms cadence, so the motion is honest
//      rather than an animation.
//   2. LOCAL ANALYSER (overlay). When the operator is actually listening, the
//      Web Audio AnalyserNode gives a live spectrum for detail. It is the
//      cherry on top, never the proof of signal.
//
//  A VERDICT badge states what the signal actually is — programme audio, low,
//  DEAD AIR, or noise/static — so "something is coming in" is distinguishable
//  from "the right thing is coming in".
// ============================================================================
import { useEffect, useRef } from 'react'
import type { RadioLevelSample, SignalVerdict } from './api'

/** One AudioContext + source node per media element for the page's lifetime —
 *  createMediaElementSource can only ever be called once per element. */
const wired = new WeakMap<HTMLMediaElement, { ctx: AudioContext; analyser: AnalyserNode }>()

function wire(el: HTMLMediaElement): { ctx: AudioContext; analyser: AnalyserNode } | null {
  const got = wired.get(el)
  if (got) return got
  try {
    const ctx = new (window.AudioContext || (window as any).webkitAudioContext)()
    const src = ctx.createMediaElementSource(el)
    const analyser = ctx.createAnalyser()
    analyser.fftSize = 256
    analyser.smoothingTimeConstant = 0.82
    src.connect(analyser)
    analyser.connect(ctx.destination)   // keep the audio audible
    const rec = { ctx, analyser }
    wired.set(el, rec)
    return rec
  } catch { return null }
}

export const VERDICT_UI: Record<SignalVerdict, { label: string; color: string; note: string }> = {
  audio: { label: 'Audio present', color: '#4ade80', note: 'programme audio received' },
  quiet: { label: 'Low level', color: '#fbbf24', note: 'audio present but quiet' },
  silent: { label: 'Dead air', color: '#f87171', note: 'no audio in the output' },
  static: { label: 'Static-like', color: '#fb923c', note: 'noise-like, not programme audio' },
  unknown: { label: 'No measurement', color: '#64748b', note: 'waiting for the first segment' },
}

/** dBFS (-100..0) → 0..1 meter scale, weighted so speech/music sits mid-scale. */
function dbToUnit(db: number): number {
  if (!Number.isFinite(db) || db <= -60) return 0
  return Math.max(0, Math.min(1, (db + 60) / 60))
}

export default function AudioVisualizer({
  media, height = 220, idleText = 'No audio',
  levels, verdict = 'unknown', live = false,
}: {
  media: HTMLMediaElement | null
  height?: number
  idleText?: string
  /** Server-measured level samples (newest last) — the signal source of truth. */
  levels?: RadioLevelSample[]
  verdict?: SignalVerdict
  /** True while the station is running: drives the "receiving" vs idle wording. */
  live?: boolean
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  // rolling ring of recent level values (0..1), fed by the stream frames
  const ringRef = useRef<number[]>(new Array(120).fill(0))
  const queueRef = useRef<number[]>([])
  const lastSampleT = useRef<number>(0)

  // Push newly-arrived server frames into a queue that drains at ~100ms, the
  // rate they were measured at, so the meter moves at the stream's own pace.
  useEffect(() => {
    if (!levels || !levels.length) return
    const newest = levels[levels.length - 1]
    if (!newest || newest.t === lastSampleT.current) return
    const first = lastSampleT.current === 0
    lastSampleT.current = newest.t
    if (first) {
      // PRIME the history from the samples we already have, so opening the page
      // shows the last ~12s of received signal instead of an empty meter.
      const hist = levels.flatMap((s) => (s.frames?.length ? s.frames : [s.rmsDb])).map(dbToUnit)
      ringRef.current = hist.slice(-120)
      while (ringRef.current.length < 120) ringRef.current.unshift(0)
      return
    }
    const frames = newest.frames?.length ? newest.frames : [newest.rmsDb]
    queueRef.current.push(...frames.map(dbToUnit))
    // never let the queue run away if a poll is late
    if (queueRef.current.length > 240) queueRef.current = queueRef.current.slice(-240)
  }, [levels])

  useEffect(() => {
    const id = setInterval(() => {
      const q = queueRef.current
      const ring = ringRef.current
      // drain a couple of frames per tick when we are behind, else hold the last
      const take = q.length > 60 ? 2 : 1
      for (let i = 0; i < take; i++) {
        const v = q.length ? q.shift()! : (live ? ring[ring.length - 1] * 0.88 : 0)
        ring.push(v)
        if (ring.length > 120) ring.shift()
      }
    }, 100)
    return () => clearInterval(id)
  }, [live])

  useEffect(() => {
    if (!canvasRef.current) return
    const rec = media ? wire(media) : null
    const canvas = canvasRef.current
    const g = canvas.getContext('2d')!
    let raf = 0
    const freq = rec ? new Uint8Array(rec.analyser.frequencyBinCount) : null
    const resume = () => { rec?.ctx.resume().catch(() => {}) }
    media?.addEventListener('play', resume)

    const draw = () => {
      raf = requestAnimationFrame(draw)
      const w = canvas.clientWidth, h = canvas.clientHeight
      if (canvas.width !== w * devicePixelRatio || canvas.height !== h * devicePixelRatio) {
        canvas.width = w * devicePixelRatio; canvas.height = h * devicePixelRatio
      }
      g.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0)
      g.clearRect(0, 0, w, h)
      g.fillStyle = 'rgba(255,255,255,.035)'
      for (let y = h - 26; y > 8; y -= 22) g.fillRect(10, y, w - 20, 1)

      const v = VERDICT_UI[verdict] ?? VERDICT_UI.unknown
      const ring = ringRef.current
      const plotH = h - 44

      // ---- 1) STREAM HISTORY: the received signal over the last ~12s --------
      const bars = ring.length
      const bw = (w - 20) / bars
      let streamLevel = 0
      for (let i = 0; i < bars; i++) {
        const val = ring[i]
        streamLevel = Math.max(streamLevel, val)
        const bh = Math.max(1, val * plotH)
        const x = 10 + i * bw
        const alpha = 0.35 + 0.65 * (i / bars)     // older = dimmer
        g.globalAlpha = alpha
        g.fillStyle = val <= 0.001 ? 'rgba(148,163,184,.35)' : v.color
        g.fillRect(x, h - 26 - bh, Math.max(1, bw - 1), bh)
      }
      g.globalAlpha = 1

      // ---- 2) LOCAL SPECTRUM overlay while actually listening ---------------
      if (rec && freq && media && !media.paused) {
        rec.analyser.getByteFrequencyData(freq as any)
        const n = 48
        const step = Math.floor(freq.length / n)
        const sw = (w - 20) / n
        g.globalAlpha = 0.5
        for (let i = 0; i < n; i++) {
          let sum = 0
          for (let j = 0; j < step; j++) sum += freq[i * step + j]
          const val = sum / step / 255
          const bh = Math.max(1, val * plotH)
          g.fillStyle = '#7dd3fc'
          g.fillRect(10 + i * sw + 1, h - 26 - bh, Math.max(1, sw - 3), bh)
        }
        g.globalAlpha = 1
      }

      // ---- 3) SIGNAL BAR + verdict ------------------------------------------
      g.fillStyle = 'rgba(255,255,255,.08)'
      g.fillRect(10, h - 16, w - 20, 7)
      g.fillStyle = streamLevel > 0.02 ? v.color : '#475569'
      g.fillRect(10, h - 16, (w - 20) * Math.min(1, streamLevel * 1.1), 7)

      // The verdict badge belongs to a LIVE station (server-measured levels).
      // In the recording workbench there is no such feed, so it is omitted
      // rather than reporting "no measurement" about a finished capture.
      if (levels) {
        g.font = '600 11px system-ui'
        g.textAlign = 'left'
        g.fillStyle = v.color
        g.fillText(v.label.toUpperCase(), 12, 18)
        const labelW = g.measureText(v.label.toUpperCase()).width
        g.fillStyle = 'rgba(255,255,255,.45)'
        g.font = '11px system-ui'
        g.fillText(v.note, 12 + labelW + 12, 18)
      }

      if (!live) {
        g.fillStyle = 'rgba(255,255,255,.32)'
        g.font = '12px system-ui'
        g.textAlign = 'center'
        g.fillText(idleText, w / 2, h / 2)
      }
    }
    draw()
    return () => { cancelAnimationFrame(raf); media?.removeEventListener('play', resume) }
  }, [media, idleText, verdict, live, levels])

  return (
    <canvas ref={canvasRef} style={{
      width: '100%', height, display: 'block', borderRadius: 10,
      background: 'linear-gradient(180deg, rgba(13,19,31,.9), rgba(9,13,22,.95))',
    }} />
  )
}
