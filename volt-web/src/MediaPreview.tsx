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
import { useEffect, useMemo, useRef, useState } from 'react'
import AudioVisualizer from './AudioVisualizer'
import { getToken } from './api'
import { parseThumbVtt, ThumbScrubStrip } from './storyboard'
import { Notice } from './notices'
import VoltPlayerView from './VoltPlayerView'
import { FrameStill } from './FrameStill'
import { frameAtMs, frameMs, getVodFrame, getVodFrameIndex, msOfFrame, timecode, type ExactFrame, type Rate } from './frames'

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

/** A request from outside the player (a QC finding, say) to go to a time, and
 *  optionally play a stretch and stop at its end. `key` changes per request so
 *  asking for the same place twice still seeks. */
export interface SeekRequest { ms: number; play?: boolean; untilMs?: number | null; key: number }

/** Seek, play, and stop at untilMs, on any media element. */
function useSeekRequest(ref: { current: HTMLMediaElement | null }, seek: SeekRequest | null | undefined) {
  useEffect(() => {
    const el = ref.current
    if (!el || !seek) return
    const go = () => {
      el.currentTime = Math.max(0, seek.ms / 1000)
      if (seek.play) el.play().catch(() => { /* autoplay refused: it is still at the place */ })
      else el.pause()
    }
    if (el.readyState >= 1) go(); else el.addEventListener('loadedmetadata', go, { once: true })
    if (!seek.play || seek.untilMs == null) return () => el.removeEventListener('loadedmetadata', go)
    const stopAt = seek.untilMs / 1000
    const onT = () => { if (el.currentTime >= stopAt) { el.pause(); el.removeEventListener('timeupdate', onT) } }
    el.addEventListener('timeupdate', onT)
    return () => { el.removeEventListener('timeupdate', onT); el.removeEventListener('loadedmetadata', go) }
    /* eslint-disable-next-line */
  }, [seek?.key])
}

export default function MediaPreview({ sources, audioOnly, title, thumbnailsVtt, poster, assetId, seek }: {
  sources: PreviewSources
  /** Go to a time from outside (QC review). */
  seek?: SeekRequest | null
  /** The library asset being previewed: turns on frame stepping and timecode
   *  from its frame index (build queue 3.2-3). Without it the preview is a
   *  plain player, as for a loop's media. */
  assetId?: string | null
  /** The asset's image, shown in the player until it plays (a signed image-service URL). */
  poster?: string | null
  audioOnly: boolean
  title?: string | null
  /** WebVTT thumbnails for this media (a clip's or a recording's): a scrub
   *  strip under the player shows the frame under the pointer. */
  thumbnailsVtt?: string | null
}) {
  const [err, setErr] = useState('')
  const hasAny = !!(sources.file || sources.hls)
  if (!hasAny) return null
  return audioOnly
    ? <AudioPreview sources={sources} title={title} err={err} setErr={setErr} seek={seek} />
    : <VideoPreview sources={sources} err={err} setErr={setErr} thumbnailsVtt={thumbnailsVtt} poster={poster} assetId={assetId} seek={seek} />
}

/** Video: the Volt player SDK with the admin skin (the same player customers embed). */
function VideoPreview({ sources, err, setErr, thumbnailsVtt, poster, assetId, seek }: { sources: PreviewSources; err: string; setErr: (m: string) => void; thumbnailsVtt?: string | null; poster?: string | null; assetId?: string | null; seek?: SeekRequest | null }) {
  const ref = useRef<HTMLVideoElement | null>(null)
  useSeekRequest(ref, seek)
  const frames = useFrameStepping(ref, assetId ?? null)
  // THE ASSET'S IMAGE AS THE POSTER, on the video element itself: shown until it plays, and
  // put back if loading a new source clears it. A newly chosen image is a new URL (versioned).
  useEffect(() => {
    const v = ref.current
    if (!v) return
    const apply = () => { if (poster) { if (v.poster !== poster) v.poster = poster } else v.removeAttribute('poster') }
    apply()
    v.addEventListener('loadstart', apply); v.addEventListener('emptied', apply)
    return () => { v.removeEventListener('loadstart', apply); v.removeEventListener('emptied', apply) }
  }, [poster])
  const [noPicture, setNoPicture] = useState(false)
  const [t, setT] = useState(0)
  const [dur, setDur] = useState(NaN)
  const cues = useMemo(() => (thumbnailsVtt ? parseThumbVtt(thumbnailsVtt) : []), [thumbnailsVtt])
  const src = assetUrl(sources.file) ?? assetUrl(sources.hls)
  useEffect(() => {
    const v = ref.current
    if (!v) return
    const onT = () => setT(v.currentTime)
    const onD = () => setDur(v.duration)
    const onM = () => setNoPicture(v.videoHeight === 0)
    v.addEventListener('timeupdate', onT); v.addEventListener('durationchange', onD); v.addEventListener('loadedmetadata', onM)
    return () => { v.removeEventListener('timeupdate', onT); v.removeEventListener('durationchange', onD); v.removeEventListener('loadedmetadata', onM) }
  }, [])
  return (
    // tabIndex -1: a click anywhere in the preview (the readout included) gives
    // it the keys, so the arrows step frames here and not elsewhere on the page.
    <div className="frame-preview" onKeyDownCapture={frames.onKey} tabIndex={-1} style={{ outline: 'none' }}>
      <div className="frame-host">
        <VoltPlayerView src={src} mediaRef={ref} skin="admin" autoplay={false}
          onError={m => setErr(m ? 'Playback failed: ' + m : '')}
          style={{ borderRadius: 8, overflow: 'hidden', border: '1px solid var(--border)', ['--vp-admin-max' as any]: '380px' }} />
        <FrameStill still={frames.still} busy={frames.busy} />
      </div>
      {frames.rate && !noPicture && (
        <div className="frame-readout">
          <span className="tc">{frames.still ? frames.still.timecode : timecode(frames.rate, frameAtMs(frames.rate, t * 1000))}</span>
          <span>frame {frames.still ? frames.still.frame : frameAtMs(frames.rate, t * 1000)}{frames.total ? ` of ${frames.total}` : ''}</span>
          <span style={{ flex: 1 }} />
          <span style={{ fontSize: 'var(--fs-label)', color: 'var(--faint)' }}>Paused: ← → step one frame</span>
        </div>
      )}
      {frames.err && <div style={{ marginTop: 6 }}><Notice kind="error" variant="compact" message={frames.err} /></div>}
      {!noPicture && cues.length > 0 && (
        <ThumbScrubStrip cues={cues} duration={Number.isFinite(dur) ? dur : cues[cues.length - 1].end} current={t}
          onSeek={(sec) => { const v = ref.current; if (v) v.currentTime = sec }} />
      )}
      {noPicture && <div style={{ color: 'var(--faint)', fontSize: 'var(--fs-sm)', marginTop: 8 }}>This file carries no picture: audio only.</div>}
      {err && <div style={{ marginTop: 8 }}><Notice kind="error" variant="compact" message={err} /></div>}
    </div>
  )
}

function AudioPreview({ sources, title, err, setErr, seek }: { sources: PreviewSources; title?: string | null; err: string; setErr: (m: string) => void; seek?: SeekRequest | null }) {
  const ref = useRef<HTMLAudioElement | null>(null)
  useSeekRequest(ref, seek)
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
      {err && <div style={{ marginTop: 8 }}><Notice kind="error" variant="compact" message={err} /></div>}
    </div>
  )
}

/**
 * FRAME STEPPING for a library asset (build queue 3.2-3). While the player is
 * paused, the left and right arrows step one frame and the server's exact
 * still of that frame is shown over the player; playing again, or seeking any
 * other way, puts the player's own picture back. While playing the arrows keep
 * the player's 10 second jumps. Needs the asset's frame index (its rate and
 * frame count); until that is made the player behaves as before.
 */
function useFrameStepping(ref: { current: HTMLVideoElement | null }, assetId: string | null) {
  const [rate, setRate] = useState<Rate | null>(null)
  const [total, setTotal] = useState(0)
  const [still, setStill] = useState<ExactFrame | null>(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const seq = useRef(0)
  const ourSeek = useRef(false)
  const current = useRef<number | null>(null)
  useEffect(() => {
    setRate(null); setTotal(0); setStill(null); current.current = null
    if (!assetId) return
    let gone = false
    let timer: ReturnType<typeof setTimeout> | undefined
    // The first ask queues the index when an asset has none yet (a few seconds
    // for a film), so ask again until it is ready, for up to two minutes.
    const ask = (tries: number) => getVodFrameIndex(assetId).then(i => {
      if (gone) return
      if (i.rate) { setRate(i.rate); setTotal(i.totalFrames ?? 0); return }
      if ((i.state === 'queued' || i.state === 'indexing') && tries < 24) timer = setTimeout(() => ask(tries + 1), 5000)
    }).catch(() => { /* no index: plain player */ })
    void ask(0)
    return () => { gone = true; if (timer) clearTimeout(timer) }
  }, [assetId])
  // Any seek or play we did not make puts the player's own picture back.
  useEffect(() => {
    const v = ref.current
    if (!v) return
    const drop = () => { if (ourSeek.current) { ourSeek.current = false; return } seq.current++; setStill(null); setBusy(false); current.current = null }
    const onPlay = () => { seq.current++; setStill(null); setBusy(false); current.current = null }
    v.addEventListener('seeking', drop); v.addEventListener('play', onPlay)
    return () => { v.removeEventListener('seeking', drop); v.removeEventListener('play', onPlay) }
  }, [ref.current])
  async function step(dir: 1 | -1) {
    const v = ref.current
    if (!v || !rate || !assetId) return
    const base = current.current ?? frameAtMs(rate, v.currentTime * 1000)
    const last = total > 0 ? total - 1 : Number.MAX_SAFE_INTEGER
    const n = Math.min(last, Math.max(0, base + dir))
    current.current = n
    // The player is moved to the MIDDLE of the frame, so its own picture is
    // the right one too wherever the browser can manage it.
    ourSeek.current = true
    v.currentTime = (msOfFrame(rate, n) + frameMs(rate) / 2) / 1000
    const my = ++seq.current
    setBusy(true); setErr('')
    try {
      const f = await getVodFrame(assetId, n)
      if (my === seq.current) setStill(f)
    } catch (e: any) {
      if (my === seq.current) setErr("Couldn't show the exact frame: " + (e?.message || e))
    } finally { if (my === seq.current) setBusy(false) }
  }
  function onKey(e: React.KeyboardEvent) {
    const v = ref.current
    if (!v || !rate || !v.paused) return
    if ((e.target as HTMLElement)?.closest?.('input,select,textarea')) return
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return
    // Before the player's own handler, which would jump 10 seconds.
    e.preventDefault(); e.stopPropagation()
    void step(e.key === 'ArrowRight' ? 1 : -1)
  }
  return { rate, total, still, busy, err, onKey }
}
