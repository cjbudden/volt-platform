// ============================================================================
//  AudioVisualizer — the radio replacement for the 16:9 video surface.
//
//  ONE WAVEFORM, ONE MEANING: the signal actually leaving the platform.
//
//  There used to be a second, blue local-spectrum overlay drawn on top while
//  the operator was listening. It had to go. Two waveforms in one box invite
//  the reading "the picture changes when I press play", and the whole point of
//  this surface is the opposite: it answers "are we RECEIVING audio?", never
//  "is my laptop playing it". Muting or stopping local playback now changes
//  nothing on screen except the mute icon.
//
//  The bars are SERVER-MEASURED levels from the broadcast output (ffmpeg
//  ebur128/astats in the radio monitor), pushed through a queue that drains at
//  their real ~100ms cadence so the motion is the stream's, not an animation.
//
//  FALLBACK: with no server feed (the recording workbench, which visualises a
//  local file), the same single waveform is fed from the Web Audio analyser at
//  the same cadence and drawn identically. One visual language either way.
//
//  A VERDICT badge states what the signal actually is — programme audio, low,
//  DEAD AIR, or noise/static — so "something is coming in" is distinguishable
//  from "the right thing is coming in".
// ============================================================================
import { useEffect, useRef, type ReactNode } from 'react'
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

/** dBFS → LINEAR AMPLITUDE 0..1. This is the waveform scale, the same one a
 *  SoundCloud-style view uses, and it is why the bars have shape: -4 dBFS is
 *  0.63 of full scale, -13 dBFS is 0.22, so transients read as transients.
 *
 *  What it replaced, and why: the meter used to plot momentary LOUDNESS mapped
 *  linearly in dB over a 60 dB window. Broadcast audio is loudness-normalised
 *  and compressed, so momentary loudness barely moves — a real Groove Salad
 *  segment measured -17.8 to -14.0 LUFS, under 4 LU — and every one of those
 *  values lands at 0.70-0.77 on that scale. The result was a solid block of
 *  near-full-height bars: it looked like the station was pinned at 100% and
 *  showed no dynamics at all. */
function dbToAmp(db: number): number {
  if (!Number.isFinite(db) || db <= -60) return 0
  return Math.max(0, Math.min(1, Math.pow(10, db / 20)))
}

/** dBFS (-100..0) → 0..1 over a 60 dB window. Fallback only, for a feed that
 *  predates per-frame true peak and carries loudness frames alone. */
function dbToUnit(db: number): number {
  if (!Number.isFinite(db) || db <= -60) return 0
  return Math.max(0, Math.min(1, (db + 60) / 60))
}

/** One sample's ~100ms frames as waveform units: true peak when the feed has
 *  it, loudness as a fallback, the segment's own peak as a last resort. */
function sampleUnits(s: RadioLevelSample): number[] {
  if (s.peaks?.length) return s.peaks.map(dbToAmp)
  if (s.frames?.length) return s.frames.map(dbToUnit)
  return [dbToAmp(s.peakDb)]
}

export default function AudioVisualizer({
  media, height = 220, idleText = 'No audio',
  levels, verdict = 'unknown', live = false, idleOverlay,
}: {
  media: HTMLMediaElement | null
  height?: number
  idleText?: string
  /** Rendered centred over the surface while the station is OFF, in place of
   *  `idleText`. This is where the start call to action goes, so the audio
   *  surface offers the same "press to begin" affordance as a channel's video
   *  surface instead of only stating that nothing is running. */
  idleOverlay?: ReactNode
  /** Server-measured level samples (newest last) — the signal source of truth. */
  levels?: RadioLevelSample[]
  verdict?: SignalVerdict
  /** True while the station is running: drives the "receiving" vs idle wording. */
  live?: boolean
}) {
  const hasOverlay = !!idleOverlay
  const hasFeed = !!(levels && levels.length)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const recRef = useRef<{ ctx: AudioContext; analyser: AnalyserNode } | null>(null)
  const pcmRef = useRef<Uint8Array | null>(null)
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
      const hist = levels.flatMap(sampleUnits)
      ringRef.current = hist.slice(-120)
      while (ringRef.current.length < 120) ringRef.current.unshift(0)
      return
    }
    queueRef.current.push(...sampleUnits(newest))
    // never let the queue run away if a poll is late
    if (queueRef.current.length > 240) queueRef.current = queueRef.current.slice(-240)
  }, [levels])

  /** PEAK amplitude of the local analyser window, 0..1 — the same quantity and
   *  the same scale as a server true-peak frame, so the fallback path draws the
   *  same picture as the measured path. */
  function localLevel(): number {
    const rec = recRef.current
    if (!rec || !media || media.paused) return 0
    const buf = pcmRef.current && pcmRef.current.length === rec.analyser.fftSize
      ? pcmRef.current : (pcmRef.current = new Uint8Array(rec.analyser.fftSize))
    rec.analyser.getByteTimeDomainData(buf as any)
    let peak = 0
    for (let i = 0; i < buf.length; i++) {
      const d = Math.abs((buf[i] - 128) / 128)
      if (d > peak) peak = d
    }
    return Math.max(0, Math.min(1, peak))
  }

  useEffect(() => {
    const id = setInterval(() => {
      const q = queueRef.current
      const ring = ringRef.current
      // drain a couple of frames per tick when we are behind, else hold the last
      const take = q.length > 60 ? 2 : 1
      for (let i = 0; i < take; i++) {
        // WITH a server feed the local analyser is never consulted, so local
        // playback and mute cannot move these bars.
        const v = hasFeed
          ? (q.length ? q.shift()! : (live ? ring[ring.length - 1] * 0.88 : 0))
          : localLevel()
        ring.push(v)
        if (ring.length > 120) ring.shift()
      }
    }, 100)
    return () => clearInterval(id)
    /* eslint-disable-next-line */
  }, [live, hasFeed, media])

  useEffect(() => {
    if (!canvasRef.current) return
    // The analyser stays wired for the fallback path (and to keep audio audible
    // through the graph); nothing is drawn from it while a server feed exists.
    const rec = media ? wire(media) : null
    recRef.current = rec
    const canvas = canvasRef.current
    const g = canvas.getContext('2d')!
    let raf = 0
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

      // ---- 1) THE WAVEFORM: the received signal over the last ~12s ----------
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

      // ---- 2) SIGNAL BAR + verdict ------------------------------------------
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

      // The idle caption is painted on the canvas ONLY when nothing better is
      // offered. With an overlay, the call to action says "off" more usefully.
      if (!live && !hasOverlay) {
        g.fillStyle = 'rgba(255,255,255,.32)'
        g.font = '12px system-ui'
        g.textAlign = 'center'
        g.fillText(idleText, w / 2, h / 2)
      }
    }
    draw()
    return () => { cancelAnimationFrame(raf); media?.removeEventListener('play', resume) }
  }, [media, idleText, verdict, live, levels, hasOverlay])

  return (
    <div style={{ position: 'relative' }}>
      <canvas ref={canvasRef} style={{
        width: '100%', height, display: 'block', borderRadius: 10,
        background: 'linear-gradient(180deg, rgba(13,19,31,.9), rgba(9,13,22,.95))',
      }} />
      {!live && idleOverlay && (
        <div style={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center', textAlign: 'center', padding: 20 }}>
          {idleOverlay}
        </div>
      )}
    </div>
  )
}
