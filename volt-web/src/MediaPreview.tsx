// ============================================================================
//  MediaPreview — play any library asset, with the right surface for what it is.
//
//  The library used to hand a <video> nothing but `progressive_key`, so a clip
//  cut with the default output (a streaming manifest) sat as a black box with
//  dead controls, and a radio clip that DID have a file was a 380px black
//  rectangle with a sentence under it apologising for being audio. The
//  preview is the one thing an operator needs from a library entry before
//  deciding anything about it, so it has to work for every asset.
//
//  TWO SURFACES:
//    VIDEO  a <video>, fed a progressive file when there is one, otherwise the
//           HLS manifest through hls.js (native HLS on Safari).
//    AUDIO  the same AudioVisualizer the station page uses, drawn from the
//           element's own output, over a native audio transport. The source is
//           the MP3 or M4A if present (plays anywhere, seeks instantly), else
//           the HLS manifest through hls.js on an <audio> element.
//
//  Which surface is decided by the SERVER (`audioOnly`: the source stream has
//  no video rendition, or an upload produced only audio files), not by
//  loading the media and looking. The element's own metadata is still used as
//  a tie-breaker for an old asset that predates the flag.
// ============================================================================
import { useEffect, useRef, useState } from 'react'
import AudioVisualizer from './AudioVisualizer'
import { getToken } from './api'

export interface PreviewSources {
  /** HLS master/index manifest path. */
  hls?: string | null
  /** A single progressive file: MP4 for video, MP3/M4A for audio. */
  file?: string | null
}

/** Paths from the API arrive both with and without a leading slash. */
export function assetUrl(p: string | null | undefined): string | null {
  if (!p) return null
  if (/^https?:\/\//i.test(p) || p.startsWith('/')) return p
  return '/' + p
}

/**
 * Attach a source to a media element: progressive file directly, HLS through
 * hls.js (bearer added only for /api playlists, the same rule the recording
 * player uses), native HLS where the browser has it.
 */
function useAttach(ref: { current: HTMLMediaElement | null }, sources: PreviewSources, onError: (m: string) => void) {
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const file = assetUrl(sources.file)
    const hls = assetUrl(sources.hls)
    let cancelled = false; let engine: any
    onError('')
    if (file) {
      el.src = file
      return () => { el.removeAttribute('src'); el.load() }
    }
    if (!hls) return
    ;(async () => {
      const Hls = (await import('hls.js')).default
      if (cancelled) return
      if (Hls.isSupported()) {
        engine = new Hls({
          xhrSetup: (xhr: XMLHttpRequest, u: string) => {
            try {
              if (new URL(u, window.location.href).pathname.startsWith('/api/')) {
                xhr.open('GET', u, true)
                xhr.setRequestHeader('authorization', `Bearer ${getToken()}`)
              }
            } catch {}
          },
        })
        engine.loadSource(hls); engine.attachMedia(el)
        let recoveries = 0
        engine.on(Hls.Events.ERROR, (_e: any, data: any) => {
          if (!data.fatal) return
          if (data.type === Hls.ErrorTypes.MEDIA_ERROR && recoveries < 3) { recoveries++; try { engine.recoverMediaError() } catch {}; return }
          onError('Playback failed: ' + (data.details || data.type))
          try { engine.stopLoad() } catch {}
        })
      } else if (el.canPlayType('application/vnd.apple.mpegurl')) {
        el.src = hls
      } else onError('HLS is not supported in this browser')
    })()
    return () => { cancelled = true; try { engine?.destroy() } catch {}; el.removeAttribute('src'); el.load() }
    /* eslint-disable-next-line */
  }, [ref.current, sources.file, sources.hls])
}

const fmt = (s: number) => {
  if (!Number.isFinite(s)) return '–:––'
  const m = Math.floor(s / 60), ss = Math.floor(s % 60)
  const h = Math.floor(m / 60)
  return h ? `${h}:${String(m % 60).padStart(2, '0')}:${String(ss).padStart(2, '0')}` : `${m}:${String(ss).padStart(2, '0')}`
}

export default function MediaPreview({ sources, audioOnly, title }: {
  sources: PreviewSources
  audioOnly: boolean
  title?: string | null
}) {
  const [err, setErr] = useState('')
  const hasAny = !!(sources.file || sources.hls)
  if (!hasAny) return null
  return audioOnly
    ? <AudioPreview sources={sources} title={title} err={err} setErr={setErr} />
    : <VideoPreview sources={sources} err={err} setErr={setErr} />
}

function VideoPreview({ sources, err, setErr }: { sources: PreviewSources; err: string; setErr: (m: string) => void }) {
  const ref = useRef<HTMLVideoElement | null>(null)
  const [noPicture, setNoPicture] = useState(false)
  useAttach(ref, sources, setErr)
  return (
    <div>
      <video ref={ref} controls playsInline preload="metadata"
        onLoadedMetadata={e => setNoPicture((e.currentTarget as HTMLVideoElement).videoHeight === 0)}
        style={noPicture
          ? { width: '100%', height: 44, background: '#000', borderRadius: 8, border: '1px solid var(--border)' }
          : { width: '100%', maxHeight: 380, background: '#000', borderRadius: 8, border: '1px solid var(--border)' }} />
      {noPicture && <div style={{ color: 'var(--faint)', fontSize: 'var(--fs-sm)', marginTop: 8 }}>This file carries no picture: audio only.</div>}
      {err && <div className="err" style={{ marginTop: 8 }}>{err}</div>}
    </div>
  )
}

function AudioPreview({ sources, title, err, setErr }: { sources: PreviewSources; title?: string | null; err: string; setErr: (m: string) => void }) {
  const ref = useRef<HTMLAudioElement | null>(null)
  const [el, setEl] = useState<HTMLAudioElement | null>(null)
  const [playing, setPlaying] = useState(false)
  const [t, setT] = useState(0)
  const [dur, setDur] = useState(NaN)
  useAttach(ref, sources, setErr)
  useEffect(() => {
    const a = ref.current
    if (!a) return
    setEl(a)
    const onT = () => setT(a.currentTime)
    const onD = () => setDur(a.duration)
    const onP = () => setPlaying(!a.paused)
    a.addEventListener('timeupdate', onT); a.addEventListener('durationchange', onD)
    a.addEventListener('play', onP); a.addEventListener('pause', onP); a.addEventListener('ended', onP)
    return () => {
      a.removeEventListener('timeupdate', onT); a.removeEventListener('durationchange', onD)
      a.removeEventListener('play', onP); a.removeEventListener('pause', onP); a.removeEventListener('ended', onP)
    }
  }, [])
  const toggle = () => { const a = ref.current; if (!a) return; if (a.paused) a.play().catch(e => setErr(String(e?.message || e))); else a.pause() }
  const seek = (f: number) => { const a = ref.current; if (a && Number.isFinite(a.duration)) a.currentTime = f * a.duration }
  const frac = Number.isFinite(dur) && dur > 0 ? t / dur : 0
  return (
    <div>
      {/* THE PICTURE OF THE SOUND. Same component, same scale, as the live
          station meter, fed from this element's own output so what is drawn is
          what is heard. */}
      <AudioVisualizer media={el} height={180} idleText={playing ? '' : 'Press play'} />
      <audio ref={ref} preload="metadata" style={{ display: 'none' }} />
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 8 }}>
        <button className="btn primary" onClick={toggle} style={{ width: 44, justifyContent: 'center' }} title={playing ? 'Pause' : 'Play'}>
          {playing ? '❚❚' : '▶'}
        </button>
        <span style={{ fontFamily: 'ui-monospace,monospace', fontSize: 'var(--fs-sm)', color: 'var(--muted)', minWidth: 96 }}>
          {fmt(t)} / {fmt(dur)}
        </span>
        <input type="range" min={0} max={1000} value={Math.round(frac * 1000)}
          onChange={e => seek(Number(e.target.value) / 1000)}
          style={{ flex: 1 }} aria-label="Seek" />
        {title && <span style={{ fontSize: 'var(--fs-sm)', color: 'var(--faint)', maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{title}</span>}
      </div>
      {err && <div className="err" style={{ marginTop: 8 }}>{err}</div>}
    </div>
  )
}
