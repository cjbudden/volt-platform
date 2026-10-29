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
import { apiRequest, getToken } from '../api'
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
  media: string | null
  streams: StreamUse[]
  summary: { streams: number; ready: number; outOfDate: number; failed: number; renditions: number }
}

const KIND = { slate: 'Slate', loop: 'Loop' } as const
const fmtBytes = (n: unknown) => { const v = Number(n) || 0; return v >= 1 << 30 ? `${(v / (1 << 30)).toFixed(1)} GB` : v >= 1 << 20 ? `${(v / (1 << 20)).toFixed(1)} MB` : v ? `${Math.round(v / 1024)} KB` : '—' }
const fmtDur = (ms: unknown) => { const s = Math.round((Number(ms) || 0) / 1000); return s ? `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}` : '—' }
const when = (t: string | null) => t ? new Date(t).toLocaleString() : '—'

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
  const notify = useNotify()
  const load = async () => {
    try { const x = await apiRequest(`/filler-assets/${id}/details`) as Details; setD(x); setErr('')
      setPlaying((p) => p ?? x.streams.find((s) => s.build?.preview)?.id ?? null)
    } catch (e: any) { setErr(e.message) }
  }
  useEffect(() => { void load() /* eslint-disable-next-line */ }, [id])
  // follow a rebuild while it runs
  const running = !!d?.streams.some((s) => s.build && (s.build.status === 'queued' || s.build.status === 'building'))
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
                : <video src={d.media} controls muted loop playsInline style={{ width: '100%', aspectRatio: '16 / 9', background: '#000', borderRadius: 8, display: 'block' }} />
              : <div style={{ aspectRatio: '16 / 9', display: 'grid', placeItems: 'center', background: 'var(--panel-2)', borderRadius: 8, color: 'var(--faint)' }}>No preview</div>}
            <table style={{ marginTop: 12 }}>
              <tbody>
                <tr><td style={{ color: 'var(--faint)' }}>File</td><td style={{ wordBreak: 'break-all' }}>{a.filename ?? '—'}</td></tr>
                <tr><td style={{ color: 'var(--faint)' }}>Picture</td><td>{a.width && a.height ? `${a.width}×${a.height}` : '—'}{a.kind === 'loop' ? ` · ${fmtDur(a.duration_ms)}` : ''}</td></tr>
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
                  {d.streams.length ? 'No stream has a finished copy of this yet.' : 'Choose this as a channel or event fallback, and Volt builds a copy to match its ladder.'}
                </div>}
          </div>
        </section>
      </div>

      <section className="card">
        <div className="card-h"><h3>Used by</h3><span className="sub">Each stream gets its own copy, encoded to its ladder and segment length</span></div>
        <div className="card-b" style={{ display: 'flex', flexDirection: 'column', gap: 0 }}>
          {d.streams.length === 0 && <div style={{ color: 'var(--faint)' }}>No channel, station or event uses this as its fallback.</div>}
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

