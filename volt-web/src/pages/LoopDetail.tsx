// ============================================================================
//  ONE SLATE OR LOOP (Loops & Fillers > item; /loops/:id).
//
//  What it is, a preview of the file as uploaded, and every stream that falls
//  back to it, each with the copy Volt built for that stream: a loop is encoded
//  to each stream's own ladder (fillerPrep.ts), so "the renditions made to
//  date" are per stream. Each copy can be played exactly as viewers would get
//  it on a loss, and rebuilt. Built for generic loops shared across channels,
//  where the branding no longer says which channel a loop belongs to.
//  API: GET /api/filler-assets/:id/details, POST /api/filler-assets/:id/rebuild.
// ============================================================================
import { useEffect, useRef, useState } from 'react'
import { api, apiRequest, getToken, derivedThumb, type FillerAsset } from '../api'
import MediaPreview from '../MediaPreview'
import { SpriteHover } from '../SpriteHover'
import { navigate } from '../router'
import { Notice, useNotify } from '../notices'

interface Rendition { label: string; width: number; height: number; fps: number; bitrate_kbps: number; profile?: string }
interface StreamUse {
  kind: 'channel' | 'radio' | 'event'; id: string; name: string; href: string; status: string; group: string
  fallback: { active: boolean; failover: boolean; onLoss: string; note: string | null }
  build: null | {
    status: 'ready' | 'building' | 'queued' | 'failed' | 'none'; reason: string | null; error: string | null; at: string | null
    loopSeconds: number | null; buildSeconds: number | null; watermark: boolean; renditions: Rendition[]
    audio: { sample_rate?: number; channels?: number; bitrate_kbps?: number } | null
    fromThisAsset: boolean | null; preview: string | null
  }
}
interface Details {
  asset: { id: string; name: string; kind: 'slate' | 'loop'; status: string; filename: string | null; width: number | null; height: number | null
    duration_ms: number | string | null; bytes: number | string | null; content_type: string | null; created_at: string; uploaded_at: string | null; error: string | null }
    & Pick<FillerAsset, 'poster_key' | 'poster_source' | 'poster_candidates' | 'sprite' | 'thumb_status' | 'thumb_error' | 'probe'>
  media: string | null
  streams: StreamUse[]
  /** FAST channels playing it: each plays a copy made for its own ladder (Build > Brand & filler). */
  fast?: FastUse[]
  summary: { streams: number; ready: number; outOfDate: number; failed: number; renditions: number }
}

interface FastUse {
  channelId: string; name: string; status: string; href: string; roles: string[]
  copy: { state: 'ready' | 'preparing' | 'needs-prepare' | 'no-source'; why: string | null; progress: number | null; note: string | null; failed: boolean } | null
}
function FastCopyPill({ c }: { c: FastUse['copy'] }) {
  if (!c) return <span className="tag idle" title="The channel has not listed it yet: open the channel's Build page">Not prepared</span>
  if (c.failed) return <span className="tag down" title={c.why ?? undefined}>Prepare failed</span>
  if (c.state === 'ready') return <span className="tag live">Ready</span>
  if (c.state === 'preparing') return <span className="tag sched">Preparing{c.progress != null ? ` ${Math.round(c.progress)}%` : ''}</span>
  if (c.state === 'no-source') return <span className="tag down" title={c.why ?? undefined}>No source</span>
  return <span className="tag warn" title={c.why ?? undefined}>Needs preparing</span>
}

const KIND = { slate: 'Slate', loop: 'Loop' } as const
const fmtBytes = (n: unknown) => { const v = Number(n) || 0; return v >= 1 << 30 ? `${(v / (1 << 30)).toFixed(1)} GB` : v >= 1 << 20 ? `${(v / (1 << 20)).toFixed(1)} MB` : v ? `${Math.round(v / 1024)} KB` : '—' }
const fmtDur = (ms: unknown) => { const s = Math.round((Number(ms) || 0) / 1000); return s ? `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}` : '—' }
const when = (t: string | null) => t ? new Date(t).toLocaleString() : '—'
const CODEC: Record<string, string> = { h264: 'H.264', hevc: 'HEVC', av1: 'AV1', vp9: 'VP9', prores: 'ProRes', mpeg2video: 'MPEG-2', aac: 'AAC', mp3: 'MP3', ac3: 'AC-3', eac3: 'E-AC-3', opus: 'Opus', pcm_s16le: 'PCM 16-bit', pcm_s24le: 'PCM 24-bit', png: 'PNG', mjpeg: 'JPEG', webp: 'WebP' }
const codec = (c?: string | null) => c ? CODEC[c] ?? c.toUpperCase() : '—'
const chans = (n: number | null, layout: string | null) => n === 1 ? 'mono' : n === 2 ? 'stereo' : layout || (n ? `${n} channels` : '')
const join = (...xs: (string | number | null | undefined | false)[]) => xs.filter((x) => x != null && x !== '' && x !== false).join(' · ')
/**
 * CAN THIS BROWSER PLAY THE FILE AS UPLOADED? The "As uploaded" player plays the
 * original, and a ProRes, MXF or (outside Safari) HEVC loop cannot play in a
 * browser at all. Asked of the browser itself (canPlayType with the codec), so
 * Safari's HEVC counts. Unknown answers count as playable: the player then says
 * what went wrong, as before.
 */
const CODEC_TYPE: Record<string, string> = { h264: 'avc1.640028', hevc: 'hvc1.1.6.L120.90', av1: 'av01.0.08M.08', vp9: 'vp09.00.40.08', vp8: 'vp8' }
function canPlayOriginal(a: Details['asset']): { ok: boolean; why: string | null } {
  const v = a.probe?.video
  if (!v || v.still) return { ok: true, why: null }
  const name = codec(v.codec)
  const container = a.probe?.container ?? ''
  const codecId = CODEC_TYPE[v.codec]
  if (!codecId) return { ok: false, why: `${name}${container ? ` in ${container}` : ''}` }
  const mime = /webm/i.test(container) ? 'video/webm' : /QuickTime/i.test(container) ? 'video/quicktime' : 'video/mp4'
  try {
    const el = document.createElement('video')
    const r = el.canPlayType(`${mime}; codecs="${codecId}"`) || (mime === 'video/quicktime' ? el.canPlayType(`video/mp4; codecs="${codecId}"`) : '')
    return r ? { ok: true, why: null } : { ok: false, why: `${name}${container ? ` in ${container}` : ''}` }
  } catch { return { ok: true, why: null } }
}
const at = (ms?: number | null) => ms == null ? '' : `${Math.floor(ms / 60000)}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')}`

/**
 * THE THUMBNAIL, like a media asset's (migration 0120): what Loops & Fillers and
 * the fallback pickers show. A loop's is the best of a dozen frames, or the one
 * a person picks here; a slate's is the image itself.
 */
/**
 * EVERY RENDITION MADE FROM THIS FILE, in one place: each stream that falls back
 * to it gets its own copy at its own ladder (fillerPrep.ts), so the same file can
 * exist as several sets. Copies built from an earlier file are left out here and
 * flagged under Used by.
 */
function MadeFromFile({ streams }: { streams: StreamUse[] }) {
  const rows = new Map<string, { r: Rendition; by: string[] }>()
  for (const s of streams) {
    if (s.build?.status !== 'ready' || s.build.fromThisAsset === false) continue
    for (const r of s.build.renditions) {
      const k = `${r.width}x${r.height}@${r.fps}/${r.bitrate_kbps}/${r.profile ?? ''}`
      const e = rows.get(k) ?? { r, by: [] }
      e.by.push(s.name); rows.set(k, e)
    }
  }
  const list = [...rows.values()].sort((x, y) => y.r.height - x.r.height || y.r.bitrate_kbps - x.r.bitrate_kbps)
  const pending = streams.filter((s) => s.build && (s.build.status === 'queued' || s.build.status === 'building')).length
  return (
    <section className="card">
      <div className="card-h"><h3>Renditions made from this file</h3>
        <span className="sub">{list.length ? `${list.length} distinct, across ${new Set(list.flatMap((x) => x.by)).size} stream${new Set(list.flatMap((x) => x.by)).size === 1 ? '' : 's'}` : 'none yet'}{pending ? ` · ${pending} being built` : ''}</span></div>
      <div className="card-b">
        {list.length === 0
          ? <div style={{ color: 'var(--faint)', fontSize: 'var(--fs-sm)' }}>Renditions are made when a channel, station or event uses this as its fallback: one set per stream, to its own ladder.</div>
          : <div style={{ overflowX: 'auto' }}><table>
              <thead><tr><th>Rendition</th><th>Picture</th><th>Bitrate</th><th>Profile</th><th>Made for</th></tr></thead>
              <tbody>{list.map(({ r, by }) => (
                <tr key={`${r.label}-${by.join()}`}><td>{r.label}</td><td className="mono">{r.width}×{r.height} · {r.fps}fps</td><td className="mono">{r.bitrate_kbps} kbps</td><td>{r.profile ?? '—'}</td><td>{by.join(', ')}</td></tr>
              ))}</tbody>
            </table></div>}
      </div>
    </section>
  )
}

function Thumbnail({ a, onChanged }: { a: Details['asset']; onChanged: () => void }) {
  const [busy, setBusy] = useState('')
  const notify = useNotify()
  const frames = (a.poster_candidates ?? []).slice().sort((x, y) => (x.atMs ?? 0) - (y.atMs ?? 0))
  const run = async (what: string, fn: () => Promise<unknown>, ok: string) => {
    setBusy(what)
    try { await fn(); notify({ kind: 'ok', message: ok }); onChanged() } catch (e: any) { notify({ kind: 'error', message: e.message }) } finally { setBusy('') }
  }
  const making = a.status === 'ready' && !a.thumb_status
  return (
    <section className="card">
      <div className="card-h"><h3>Thumbnail</h3>
        <span className="sub">{a.kind === 'slate' ? 'The image, scaled' : a.poster_source === 'manual' ? 'Chosen by hand' : 'The best frame, picked automatically'}</span>
        <span style={{ flex: 1 }} />
        {a.kind === 'loop' && a.poster_source === 'manual' && (
          <button className="btn ghost sm" disabled={!!busy} onClick={() => run('auto', () => api.setFillerPoster(a.id, { auto: true }), 'Back to the automatic thumbnail.')}>Pick automatically</button>
        )}
        <button className="btn ghost sm" disabled={!!busy || making || a.status !== 'ready'} style={{ marginLeft: 6 }}
          onClick={() => run('rebuild', () => api.rebuildFillerThumbnails(a.id), 'Making the thumbnails again.')}>
          {busy === 'rebuild' ? 'Queuing…' : 'Make again'}
        </button>
      </div>
      <div className="card-b">
        {a.thumb_status === 'failed' && <div style={{ color: 'var(--down)', fontSize: 'var(--fs-sm)', marginBottom: 8 }}>Could not make thumbnails: {a.thumb_error}</div>}
        {making && <div style={{ color: 'var(--faint)', fontSize: 'var(--fs-sm)', marginBottom: 8 }}>Being made from the file. This takes a few seconds.</div>}
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 16, alignItems: 'flex-start' }}>
          <div style={{ width: 256, maxWidth: '100%', aspectRatio: '16 / 9', background: '#000', borderRadius: 8, overflow: 'hidden', flex: 'none' }}>
            {derivedThumb(a.poster_key, 512, 288) && <img src={derivedThumb(a.poster_key, 512, 288)!} alt={`Thumbnail of ${a.name}`} style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} />}
          </div>
          {frames.length > 0 && (
            <div style={{ flex: '1 1 320px', minWidth: 0 }}>
              <div style={{ color: 'var(--muted)', fontSize: 'var(--fs-sm)', marginBottom: 6 }}>Frames from the loop: choose one to use it.</div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(112px, 1fr))', gap: 8 }}>
                {frames.map((f) => {
                  const on = f.key === a.poster_key
                  return (
                    <button key={f.key} type="button" disabled={!!busy || on} onClick={() => run(f.key, () => api.setFillerPoster(a.id, { key: f.key }), 'Thumbnail changed.')}
                      title={f.rejected ? `${at(f.atMs)}: ${f.rejected}` : `${at(f.atMs)}${on ? ' (in use)' : ''}`} aria-pressed={on}
                      style={{ padding: 0, border: `2px solid ${on ? 'var(--brand)' : 'transparent'}`, borderRadius: 6, background: '#000', cursor: on ? 'default' : 'pointer', position: 'relative', opacity: f.rejected ? 0.55 : 1 }}>
                      {derivedThumb(f.key, 224, 126) && <img src={derivedThumb(f.key, 224, 126)!} alt="" loading="lazy" style={{ width: '100%', aspectRatio: '16 / 9', objectFit: 'cover', display: 'block', borderRadius: 4 }} />}
                      <span style={{ position: 'absolute', left: 4, bottom: 3, fontSize: 'var(--fs-micro)', color: '#fff', background: 'rgba(0,0,0,.6)', padding: '0 4px', borderRadius: 3 }}>{at(f.atMs)}</span>
                    </button>
                  )
                })}
              </div>
            </div>
          )}
        </div>
      </div>
    </section>
  )
}

function BuildPill({ b }: { b: StreamUse['build'] }) {
  if (!b || b.status === 'none') return <span className="tag idle">Not built</span>
  if (b.fromThisAsset === false) return <span className="tag warn" title="Built from a different file: rebuild to use this one">Out of date</span>
  if (b.status === 'ready') return <span className="tag live">Ready</span>
  if (b.status === 'failed') return <span className="tag down" title={b.error ?? undefined}>Build failed</span>
  return <span className="tag sched">{b.status === 'queued' ? 'Queued' : 'Building'}</span>
}

/** The built copy, played as viewers would get it, with its renditions to step through. */
function BuildPlayer({ src, renditions }: { src: string; renditions: Rendition[] }) {
  const ref = useRef<HTMLVideoElement | null>(null)
  const hlsRef = useRef<any>(null)
  const [levels, setLevels] = useState<{ i: number; h: number; kbps: number }[]>([])
  const [level, setLevel] = useState(-1)
  const [err, setErr] = useState('')
  useEffect(() => {
    const el = ref.current
    if (!el) return
    let cancelled = false
    setErr(''); setLevels([]); setLevel(-1)
    ;(async () => {
      const Hls = (await import('hls.js')).default
      if (cancelled) return
      if (Hls.isSupported()) {
        const h = new Hls({ xhrSetup: (xhr: XMLHttpRequest, u: string) => {
          try { if (new URL(u, location.href).pathname.startsWith('/api/')) { xhr.open('GET', u, true); xhr.setRequestHeader('authorization', `Bearer ${getToken()}`) } } catch { /* */ }
        } })
        hlsRef.current = h
        h.on(Hls.Events.MANIFEST_PARSED, (_e: any, d: any) => setLevels((d.levels ?? []).map((l: any, i: number) => ({ i, h: l.height, kbps: Math.round((l.bitrate ?? 0) / 1000) }))))
        h.on(Hls.Events.ERROR, (_e: any, d: any) => { if (d.fatal) setErr(`Cannot play the built copy (${d.details || d.type})`) })
        h.loadSource(src); h.attachMedia(el)
      } else if (el.canPlayType('application/vnd.apple.mpegurl')) el.src = src
      else setErr('HLS is not supported in this browser')
    })()
    return () => { cancelled = true; try { hlsRef.current?.destroy() } catch { /* */ }; hlsRef.current = null }
  }, [src])
  const pick = (i: number) => { setLevel(i); if (hlsRef.current) hlsRef.current.currentLevel = i }
  return (
    <div>
      <video ref={ref} controls muted loop playsInline style={{ width: '100%', aspectRatio: '16 / 9', background: '#000', borderRadius: 8, display: 'block' }} />
      {err && <div style={{ color: 'var(--down)', fontSize: 'var(--fs-sm)', marginTop: 6 }}>{err}</div>}
      {levels.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 8, alignItems: 'center' }}>
          <span style={{ fontSize: 'var(--fs-sm)', color: 'var(--muted)' }}>Rendition</span>
          <button className={`chip ${level === -1 ? 'active' : ''}`} onClick={() => pick(-1)}>Auto</button>
          {levels.map((l) => (
            <button key={l.i} className={`chip ${level === l.i ? 'active' : ''}`} onClick={() => pick(l.i)}
              title={renditions.find((r) => r.height === l.h) ? `${renditions.find((r) => r.height === l.h)!.bitrate_kbps} kbps target` : undefined}>
              {l.h}p
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

export default function LoopDetail({ id }: { id: string }) {
  const [d, setD] = useState<Details | null>(null)
  const [err, setErr] = useState('')
  const [playing, setPlaying] = useState<string | null>(null)
  const [busy, setBusy] = useState('')
  const [vtt, setVtt] = useState<string | null>(null)
  const notify = useNotify()
  const load = async () => {
    try { const x = await apiRequest(`/filler-assets/${id}/details`) as Details; setD(x); setErr('')
      setPlaying((p) => p ?? x.streams.find((s) => s.build?.preview)?.id ?? null)
    } catch (e: any) { setErr(e.message) }
  }
  useEffect(() => { void load() /* eslint-disable-next-line */ }, [id])
  // follow a rebuild while it runs
  const running = !!d?.streams.some((s) => s.build && (s.build.status === 'queued' || s.build.status === 'building'))
    || (d?.asset.status === 'ready' && !d.asset.thumb_status)
  // A loop's scrub previews (sprite sheets): loaded once they exist.
  const sheets = d?.asset.sprite?.sheets?.length ?? 0
  useEffect(() => {
    let gone = false
    if (!sheets) { setVtt(null); return }
    api.fillerThumbnailsVtt(id).then((v) => { if (!gone) setVtt(v) }).catch(() => { /* none yet */ })
    return () => { gone = true }
  }, [id, sheets])
  useEffect(() => { if (!running) return; const h = setInterval(load, 3000); return () => clearInterval(h) /* eslint-disable-next-line */ }, [running])

  async function rebuild(s: StreamUse) {
    setBusy(s.id)
    try {
      await apiRequest(`/filler-assets/${id}/rebuild`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kind: s.kind === 'event' ? 'event' : 'channel', id: s.id }) })
      notify({ kind: 'ok', message: `Rebuilding the copy for ${s.name}.` })
      await load()
    } catch (e: any) { notify({ kind: 'error', message: e.message }) } finally { setBusy('') }
  }

  if (err && !d) return <Notice kind="error" title="Couldn't load this slate or loop." message={err} actions={[{ label: 'Back to Loops & Fillers', onClick: () => navigate('/loops') }]} />
  if (!d) return <div className="loading">Loading…</div>
  const a = d.asset
  const sel = d.streams.find((s) => s.id === playing && s.build?.preview) ?? null
  const fast = d.fast ?? []

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div>
        <div className="crumb"><a href="/loops" onClick={(e) => { e.preventDefault(); navigate('/loops') }}>Loops & Fillers</a><span>/</span><span>{a.name}</span></div>
        <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 10, marginTop: 6 }}>
          <h1 style={{ margin: 0, fontSize: 'var(--fs-h1, 23px)' }}>{a.name}</h1>
          <span className="tag type">{KIND[a.kind]}</span>
          {a.status !== 'ready' && <span className="tag warn">{a.status}</span>}
        </div>
        <div style={{ color: 'var(--muted)', fontSize: 'var(--fs-sm)', marginTop: 4 }}>
          {d.summary.streams === 0 ? 'Not used by any stream' : `Fallback for ${d.summary.streams} stream${d.summary.streams === 1 ? '' : 's'} · ${d.summary.renditions} rendition${d.summary.renditions === 1 ? '' : 's'} built`}
          {d.summary.outOfDate > 0 && <span style={{ color: 'var(--warn)' }}> · {d.summary.outOfDate} out of date</span>}
          {d.summary.failed > 0 && <span style={{ color: 'var(--down)' }}> · {d.summary.failed} failed</span>}
        </div>
      </div>

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 16, alignItems: 'flex-start' }}>
        <section className="card" style={{ flex: '1 1 380px', minWidth: 0 }}>
          <div className="card-h"><h3>As uploaded</h3></div>
          <div className="card-b">
            {d.media && a.status === 'ready'
              ? a.kind === 'slate'
                ? <img src={d.media} alt="" style={{ width: '100%', aspectRatio: '16 / 9', objectFit: 'contain', background: '#000', borderRadius: 8, display: 'block' }} />
                : canPlayOriginal(a).ok
                  ? <MediaPreview sources={{ file: d.media }} audioOnly={false} title={a.name} thumbnailsVtt={vtt} poster={derivedThumb(a.poster_key, 1280, 720)} />
                  : <div>
                      <div style={{ position: 'relative', aspectRatio: '16 / 9', background: '#000', borderRadius: 8, overflow: 'hidden' }}>
                        {a.sprite?.sheets?.length
                          ? <SpriteHover id={a.id} poster={derivedThumb(a.poster_key, 1280, 720)} loadVtt={() => api.fillerThumbnailsVtt(a.id)} label={`Preview of ${a.name}`} />
                          : derivedThumb(a.poster_key, 1280, 720) && <img src={derivedThumb(a.poster_key, 1280, 720)!} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} />}
                      </div>
                      <div style={{ color: 'var(--muted)', fontSize: 'var(--fs-sm)', marginTop: 8 }}>
                        This browser can't play the file as uploaded ({canPlayOriginal(a).why}). Hover over the picture for a preview made from it.
                        Streams don't play the original either: each gets its own encoded copy, shown under <b>Built copy</b>.
                      </div>
                    </div>
              : <div style={{ aspectRatio: '16 / 9', display: 'grid', placeItems: 'center', background: 'var(--panel-2)', borderRadius: 8, color: 'var(--faint)' }}>No preview</div>}
            <table style={{ marginTop: 12 }}>
              <tbody>
                <tr><td style={{ color: 'var(--faint)' }}>File</td><td style={{ wordBreak: 'break-all' }}>{a.filename ?? '—'}</td></tr>
                <tr><td style={{ color: 'var(--faint)' }}>Picture</td><td>{a.width && a.height ? `${a.width}×${a.height}` : '—'}{a.kind === 'loop' ? ` · ${fmtDur(a.duration_ms)}` : ''}
                  {a.probe?.video && !a.probe.video.still && <>{a.probe.video.fps ? ` · ${a.probe.video.fps} fps` : ''}{a.probe.video.scan === 'interlaced' ? ' · interlaced' : ''}</>}</td></tr>
                {/* THE FILE AS DELIVERED (read with the thumbnails, migration 0120). */}
                {a.probe?.video && (
                  <tr><td style={{ color: 'var(--faint)' }}>{a.probe.video.still ? 'Image' : 'Video'}</td>
                    <td>{join(codec(a.probe.video.codec), a.probe.video.profile, a.probe.video.level && `level ${a.probe.video.level}`,
                      a.probe.video.bitrateKbps && `${a.probe.video.bitrateKbps} kbps`, a.probe.video.pixFmt, a.probe.video.bitDepth && a.probe.video.bitDepth > 8 && `${a.probe.video.bitDepth}-bit`, a.probe.video.colour)}</td></tr>
                )}
                {a.probe && !a.probe.video?.still && (
                  <tr><td style={{ color: 'var(--faint)' }}>Audio</td>
                    <td>{a.probe.audio ? join(codec(a.probe.audio.codec), a.probe.audio.profile, chans(a.probe.audio.channels, a.probe.audio.layout),
                      a.probe.audio.sampleRate && `${a.probe.audio.sampleRate / 1000} kHz`, a.probe.audio.bitrateKbps && `${a.probe.audio.bitrateKbps} kbps`,
                      a.probe.audio.tracks > 1 && `${a.probe.audio.tracks} tracks`) : 'None (a fallback adds silence)'}</td></tr>
                )}
                {a.probe?.container && <tr><td style={{ color: 'var(--faint)' }}>Container</td><td>{join(a.probe.container, a.probe.bitrateKbps && !a.probe.video?.still && `${a.probe.bitrateKbps} kbps overall`)}</td></tr>}
                {a.status === 'ready' && !a.probe && <tr><td style={{ color: 'var(--faint)' }}>Format</td><td style={{ color: 'var(--faint)' }}>{a.thumb_status === 'failed' ? 'Could not be read' : 'Being read from the file'}</td></tr>}
                <tr><td style={{ color: 'var(--faint)' }}>Size</td><td>{fmtBytes(a.bytes)}{a.content_type ? ` · ${a.content_type}` : ''}</td></tr>
                <tr><td style={{ color: 'var(--faint)' }}>Added</td><td>{when(a.created_at)}</td></tr>
              </tbody>
            </table>
          </div>
        </section>

        <section className="card" style={{ flex: '1 1 420px', minWidth: 0 }}>
          <div className="card-h"><h3>Built copy</h3><span className="sub">{sel ? `as ${sel.name} shows it on a loss` : 'nothing built to play yet'}</span></div>
          <div className="card-b">
            {sel?.build?.preview
              ? <BuildPlayer key={sel.id} src={sel.build.preview} renditions={sel.build.renditions} />
              : <div style={{ aspectRatio: '16 / 9', display: 'grid', placeItems: 'center', background: 'var(--panel-2)', borderRadius: 8, color: 'var(--faint)', textAlign: 'center', padding: 16 }}>
                  {d.streams.length ? 'No stream has a finished copy of this yet.'
                    : fast.length ? `${fast.map((f) => f.name).join(', ')} ${fast.length === 1 ? 'plays' : 'play'} this as ${fast.length === 1 ? 'a FAST channel' : 'FAST channels'}, from a copy made for ${fast.length === 1 ? 'its' : 'each'} own ladder: see Used by below.`
                    : 'Choose this as a channel or event fallback, or as a FAST channel\'s brand loop or slate, and Volt builds a copy to match its ladder.'}
                </div>}
          </div>
        </section>
      </div>

      <Thumbnail a={a} onChanged={load} />

      <MadeFromFile streams={d.streams} />

      <section className="card">
        <div className="card-h"><h3>Used by</h3><span className="sub">Each stream gets its own copy, encoded to its ladder and segment length</span></div>
        <div className="card-b" style={{ display: 'flex', flexDirection: 'column', gap: 0 }}>
          {d.streams.length === 0 && fast.length === 0 && <div style={{ color: 'var(--faint)' }}>No channel, station, event or FAST channel uses this.</div>}
          {fast.map((f) => (
            <div key={`fast-${f.channelId}`} style={{ borderTop: '1px solid var(--border)', padding: '12px 0', display: 'flex', flexDirection: 'column', gap: 6 }}>
              <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 10 }}>
                <a href={f.href} onClick={(e) => { if (e.metaKey || e.ctrlKey) return; e.preventDefault(); navigate(f.href) }} style={{ fontWeight: 600 }}>{f.name}</a>
                <span className="tag type">FAST channel</span>
                <span style={{ color: 'var(--faint)', fontSize: 'var(--fs-sm)' }}>{f.roles.join(' · ')} · {f.status}</span>
                <FastCopyPill c={f.copy} />
              </div>
              {f.copy?.why && f.copy.state !== 'ready' && <div style={{ color: 'var(--faint)', fontSize: 'var(--fs-sm)' }}>{f.copy.why}</div>}
              <div style={{ color: 'var(--faint)', fontSize: 'var(--fs-sm)' }}>Plays a copy made for the channel's own ladder. Change it under the channel's Build &gt; Brand &amp; filler.</div>
            </div>
          ))}
          {d.streams.map((s) => (
            <div key={s.id} style={{ borderTop: '1px solid var(--border)', padding: '12px 0', display: 'flex', flexDirection: 'column', gap: 8 }}>
              <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 10 }}>
                <a href={s.href} onClick={(e) => { if (e.metaKey || e.ctrlKey) return; e.preventDefault(); navigate(s.href) }} style={{ fontWeight: 600 }}>{s.name}</a>
                <span className="tag type">{s.kind === 'event' ? 'Event' : s.kind === 'radio' ? 'Station' : 'Channel'}</span>
                <span style={{ color: 'var(--faint)', fontSize: 'var(--fs-sm)' }}>{s.group} · {s.status}</span>
                <BuildPill b={s.build} />
                <span style={{ flex: 1 }} />
                {s.build?.preview && (
                  <button className={`btn ${playing === s.id ? 'primary' : 'ghost'} sm`} onClick={() => setPlaying(s.id)}>{playing === s.id ? 'Playing' : 'Preview'}</button>
                )}
                <button className="btn ghost sm" disabled={busy === s.id || s.build?.status === 'queued' || s.build?.status === 'building'} onClick={() => rebuild(s)}>
                  {busy === s.id ? 'Queuing…' : 'Rebuild'}
                </button>
              </div>
              {s.fallback.note && <div style={{ color: 'var(--warn)', fontSize: 'var(--fs-sm)' }}>{s.fallback.note}.</div>}
              {s.build?.status === 'failed' && <div style={{ color: 'var(--down)', fontSize: 'var(--fs-sm)' }}>{s.build.error}</div>}
              {s.build?.status === 'none' && s.build.reason && <div style={{ color: 'var(--faint)', fontSize: 'var(--fs-sm)' }}>Not built: {s.build.reason}.</div>}
              {s.build && s.build.renditions.length > 0 && (
                <div style={{ overflowX: 'auto' }}>
                  <table>
                    <thead><tr><th>Rendition</th><th>Picture</th><th>Bitrate</th><th>Profile</th></tr></thead>
                    <tbody>
                      {s.build.renditions.map((r) => (
                        <tr key={r.label}><td>{r.label}</td><td className="mono">{r.width}×{r.height} · {r.fps}fps</td><td className="mono">{r.bitrate_kbps} kbps</td><td>{r.profile ?? '—'}</td></tr>
                      ))}
                      {s.build.audio && <tr><td>Audio</td><td className="mono">{s.build.audio.sample_rate ? `${s.build.audio.sample_rate / 1000} kHz` : ''}{s.build.audio.channels ? ` · ${s.build.audio.channels === 2 ? 'stereo' : `${s.build.audio.channels} ch`}` : ''}</td><td className="mono">{s.build.audio.bitrate_kbps ?? '—'} kbps</td><td>AAC</td></tr>}
                    </tbody>
                  </table>
                  <div style={{ color: 'var(--faint)', fontSize: 'var(--fs-sm)', marginTop: 6 }}>
                    {s.build.loopSeconds ? `${Math.round(s.build.loopSeconds)} s loop` : ''}{s.build.watermark ? ' · with the channel watermark' : ''}
                    {s.build.at ? ` · built ${when(s.build.at)}` : ''}{s.build.buildSeconds ? ` in ${s.build.buildSeconds} s` : ''}
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      </section>
    </div>
  )
}

