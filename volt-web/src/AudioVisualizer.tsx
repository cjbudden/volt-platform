// ============================================================================
//  AudioVisualizer — the radio replacement for the 16:9 video surface.
//
//  Draws a live frequency-bar spectrum + peak level strip from a media
//  element's ACTUAL decoded audio (Web Audio AnalyserNode), so it answers the
//  operator's real question: "are we receiving something?" A flat line means
//  silence ON AIR; local volume/mute does not affect it (the analyser taps the
//  element before the volume node the element applies to its output).
//
//  Reused wherever playback is audio-only: the Radio detail player and the
//  recording workbench for radio recordings.
// ============================================================================
import { useEffect, useRef } from 'react'

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

export default function AudioVisualizer({ media, height = 220, idleText = 'No audio' }: {
  media: HTMLMediaElement | null
  height?: number
  idleText?: string
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)

  useEffect(() => {
    if (!media || !canvasRef.current) return
    const rec = wire(media)
    const canvas = canvasRef.current
    const g = canvas.getContext('2d')!
    let raf = 0
    const freq = rec ? new Uint8Array(rec.analyser.frequencyBinCount) : null
    const resume = () => { rec?.ctx.resume().catch(() => {}) }
    media.addEventListener('play', resume)

    const draw = () => {
      raf = requestAnimationFrame(draw)
      const w = canvas.clientWidth, h = canvas.clientHeight
      if (canvas.width !== w * devicePixelRatio || canvas.height !== h * devicePixelRatio) {
        canvas.width = w * devicePixelRatio; canvas.height = h * devicePixelRatio
      }
      g.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0)
      g.clearRect(0, 0, w, h)
      // backdrop grid
      g.fillStyle = 'rgba(255,255,255,.035)'
      for (let y = h - 24; y > 8; y -= 22) g.fillRect(10, y, w - 20, 1)

      let level = 0
      if (rec && freq) {
        rec.analyser.getByteFrequencyData(freq as any)
        const bars = 56
        const step = Math.floor(freq.length / bars)
        const bw = (w - 20) / bars
        for (let i = 0; i < bars; i++) {
          let sum = 0
          for (let j = 0; j < step; j++) sum += freq[i * step + j]
          const v = sum / step / 255
          level = Math.max(level, v)
          const bh = Math.max(2, v * (h - 40))
          const x = 10 + i * bw
          const grad = g.createLinearGradient(0, h - 24 - bh, 0, h - 24)
          grad.addColorStop(0, '#7dd3fc')
          grad.addColorStop(1, '#3f7bff')
          g.fillStyle = grad
          g.globalAlpha = 0.92
          g.fillRect(x + 1, h - 24 - bh, Math.max(1, bw - 3), bh)
          g.globalAlpha = 1
        }
      }
      // peak level strip along the bottom (the "signal present" meter)
      g.fillStyle = 'rgba(255,255,255,.08)'
      g.fillRect(10, h - 14, w - 20, 6)
      g.fillStyle = level > 0.02 ? (level > 0.85 ? '#f87171' : '#4ade80') : '#64748b'
      g.fillRect(10, h - 14, (w - 20) * Math.min(1, level * 1.15), 6)
      if (level <= 0.004 && (!media || media.paused)) {
        g.fillStyle = 'rgba(255,255,255,.35)'
        g.font = '12px system-ui'
        g.textAlign = 'center'
        g.fillText(idleText, w / 2, h / 2)
      }
    }
    draw()
    return () => { cancelAnimationFrame(raf); media.removeEventListener('play', resume) }
  }, [media, idleText])

  return (
    <canvas ref={canvasRef} style={{
      width: '100%', height, display: 'block', borderRadius: 10,
      background: 'linear-gradient(180deg, rgba(13,19,31,.9), rgba(9,13,22,.95))',
    }} />
  )
}
