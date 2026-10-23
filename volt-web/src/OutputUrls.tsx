// OUTPUT URLS for a video stream (channel or event), 22 Oct 2026.
//
// The radio station page has had this since August: every address the stream
// is delivered on, each with its own player and a Copy button, so an operator
// can check HLS and DASH separately and hand an address to an app team without
// reading it off a manifest. Channels and events had the private origin only
// inside the main player and the public address only in an on-air banner.
//
// TWO GROUPS, because they answer different questions. PRIVATE monitoring
// addresses play whenever the encoder is producing, published or not.
// PUBLIC addresses are what viewers and apps use; they answer 404 until the
// stream is on air and inside its public window, and the row says which.
//
// Each row checks its own manifest (a small GET every 10 s while the panel is
// open), so "not produced" and "off air" are shown rather than discovered by
// pressing play.
import { useEffect, useRef, useState } from 'react'
import { usePanelControls } from './panelLayout'
import { useStatsPanel } from './useStatsPanel'

type Fmt = 'hls' | 'dash'
interface Row { key: string; label: string; sub?: string; url: string; fmt: Fmt; group: 'private' | 'public' }
type Probe = 'checking' | 'ok' | 'missing' | 'offair' | 'blocked' | 'error'

const PROBE_TEXT: Record<Probe, string> = {
  checking: 'checking…', ok: 'live', missing: 'not being produced', offair: 'not on air', blocked: 'blocked for this location', error: 'unreachable',
}

async function probe(url: string, group: Row['group']): Promise<Probe> {
  try {
    const r = await fetch(url + (url.includes('?') ? '&' : '?') + '_=' + Date.now(), { cache: 'no-store', redirect: 'follow' })
    // A page, not a playlist: a dev server or an SPA fallback answering for a
    // path it does not own. Treat it as no stream rather than "live".
    if (r.ok) return /text\/html/i.test(r.headers.get('content-type') || '') ? (group === 'public' ? 'offair' : 'missing') : 'ok'
    if (r.status === 451) return 'blocked'
    if (r.status === 404) return group === 'public' ? 'offair' : 'missing'
    if (r.status === 503) return group === 'public' ? 'offair' : 'missing'
    return 'error'
  } catch { return 'error' }
}

const abs = (u: string) => /^https?:\/\//i.test(u) ? u : `${window.location.origin}${u}`

export function OutputUrls({ id, packaging, captions, publicOpen, kindLabel = 'stream', compact = false }: {
  id: string
  /** 'hls' | 'dash' | 'both' from the output profile; unknown shows both. */
  packaging?: string | null
  /** Captioned variants exist when live captions are on. */
  captions?: boolean
  /** The public addresses should be serving now (on air, inside the window). */
  publicOpen: boolean
  kindLabel?: string
  /** Narrow host (a drawer): the address goes on its own line. */
  compact?: boolean
}) {
  const pkg = (packaging || 'both').toLowerCase()
  const hls = pkg === 'hls' || pkg === 'both'
  const dash = pkg === 'dash' || pkg === 'both'
  const rows: Row[] = [
    ...(hls ? [{ key: 'p-hls', label: 'HLS', url: `/origin/${id}/live/master.m3u8`, fmt: 'hls' as Fmt, group: 'private' as const }] : []),
    ...(hls && captions ? [{ key: 'p-hls-cc', label: 'HLS', sub: 'with captions', url: `/origin/${id}/live/master_cc.m3u8`, fmt: 'hls' as Fmt, group: 'private' as const }] : []),
    ...(dash ? [{ key: 'p-dash', label: 'DASH', url: `/origin/${id}/live/manifest.mpd`, fmt: 'dash' as Fmt, group: 'private' as const }] : []),
    ...(dash && captions ? [{ key: 'p-dash-cc', label: 'DASH', sub: 'with captions', url: `/origin/${id}/live/manifest_cc.mpd`, fmt: 'dash' as Fmt, group: 'private' as const }] : []),
    ...(hls ? [{ key: 'pub-hls', label: 'HLS', url: `/live/${id}/master.m3u8`, fmt: 'hls' as Fmt, group: 'public' as const }] : []),
    ...(dash ? [{ key: 'pub-dash', label: 'DASH', url: `/live/${id}/manifest.mpd`, fmt: 'dash' as Fmt, group: 'public' as const }] : []),
  ]
  const [state, setState] = useState<Record<string, Probe>>({})
  const [playing, setPlaying] = useState<string | null>(null)
  const [copied, setCopied] = useState<string | null>(null)
  const sig = rows.map(r => r.url).join('|')

  useEffect(() => {
    let alive = true
    const run = () => rows.forEach(r => probe(r.url, r.group).then(p => { if (alive) setState(s => s[r.key] === p ? s : { ...s, [r.key]: p }) }))
    run()
    const h = setInterval(run, 10_000)
    return () => { alive = false; clearInterval(h) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sig])

  async function copy(r: Row) {
    try { await navigator.clipboard.writeText(abs(r.url)); setCopied(r.key); setTimeout(() => setCopied(c => c === r.key ? null : c), 1500) } catch { /* clipboard refused */ }
  }

  const group = (g: Row['group']) => rows.filter(r => r.group === g)
  const panel = usePanelControls()
  return (
    <div className={`card ou-card${compact ? ' compact' : ''}`}>
      <div className="ou-head">
        <div className="sec-label" style={{ margin: 0 }}>Output URLs</div>
        {panel && <button type="button" className="pl-ib" onClick={panel.minimise} title="Minimise this panel" aria-label="Minimise Output URLs"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"><path d="M5 12h14" /></svg><span>Minimise</span></button>}
      </div>
      <div className="ou-group">
        <div className="ou-gh"><b>Private monitoring</b><span>Plays whenever the encoder is producing, published or not. For checking the output, not for viewers.</span></div>
        {group('private').map(r => <OutRow key={r.key} r={r} probe={state[r.key] ?? 'checking'} playing={playing === r.key}
          onToggle={() => setPlaying(p => p === r.key ? null : r.key)} onCopy={() => copy(r)} copied={copied === r.key} />)}
      </div>
      <div className="ou-group">
        <div className="ou-gh"><b>Public playback</b><span>{publicOpen
          ? `What viewers and apps use. Open now, subject to geo and access rules.`
          : `What viewers and apps will use. These answer "not on air" until the ${kindLabel} is on air${kindLabel === 'event' ? ' and inside its public window' : ''}.`}</span></div>
        {group('public').map(r => <OutRow key={r.key} r={r} probe={state[r.key] ?? 'checking'} playing={playing === r.key}
          onToggle={() => setPlaying(p => p === r.key ? null : r.key)} onCopy={() => copy(r)} copied={copied === r.key} />)}
      </div>
    </div>
  )
}

function OutRow({ r, probe, playing, onToggle, onCopy, copied }: {
  r: Row; probe: Probe; playing: boolean; onToggle: () => void; onCopy: () => void; copied: boolean
}) {
  const canPlay = probe === 'ok'
  return (
    <div className="ou-row-wrap">
      <div className="ou-row">
        <button type="button" className="ou-play" onClick={onToggle} disabled={!canPlay && !playing}
          aria-label={playing ? `Stop ${r.label} preview` : `Play ${r.label} preview`} title={canPlay ? 'Preview this output' : PROBE_TEXT[probe]}>
          {playing
            ? <svg viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="5" width="4" height="14" rx="1" /><rect x="14" y="5" width="4" height="14" rx="1" /></svg>
            : <svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z" /></svg>}
        </button>
        <span className="ou-fmt">{r.label}{r.sub && <span className="ou-sub">{r.sub}</span>}</span>
        <code className="ou-url" title={abs(r.url)}>{r.url}</code>
        <span className={`ou-st ${probe}`}><span className="dot" />{PROBE_TEXT[probe]}</span>
        <button type="button" className="btn ghost ou-copy" onClick={onCopy}>{copied ? 'Copied' : 'Copy'}</button>
      </div>
      {playing && <Preview url={r.url} fmt={r.fmt} />}
    </div>
  )
}

/** A codec error reads like a broken stream. It is usually the browser. */
function explain(detail?: string): string {
  if (!detail) return 'playback failed'
  if (/codec|bufferAdd|MEDIA_ERR_SRC_NOT_SUPPORTED|not supported/i.test(detail)) return 'This browser cannot decode this output\'s codec. Try it in Chrome, Edge or Safari.'
  return detail
}

/** A small muted player for one output, torn down when closed. */
function Preview({ url, fmt }: { url: string; fmt: Fmt }) {
  const ref = useRef<HTMLVideoElement | null>(null)
  const box = useRef<HTMLDivElement | null>(null)
  const hlsRef = useRef<any>(null)
  const dashRef = useRef<any>(null)
  const [err, setErr] = useState('')
  // Playback stats: right-click the preview, or Shift+D (useStatsPanel).
  useStatsPanel(box, ref, { hls: hlsRef, dash: dashRef })
  useEffect(() => {
    const v = ref.current
    if (!v) return
    let killed = false, hls: any = null, dash: any = null
    ;(async () => {
      try {
        if (fmt === 'hls') {
          if (v.canPlayType('application/vnd.apple.mpegurl')) { v.src = url; await v.play().catch(() => {}); return }
          const Hls = (await import('hls.js')).default
          if (killed) return
          if (!Hls.isSupported()) { setErr('HLS is not supported in this browser'); return }
          hls = new Hls({ liveDurationInfinity: true })
          hlsRef.current = hls
          hls.loadSource(url); hls.attachMedia(v)
          hls.on(Hls.Events.MANIFEST_PARSED, () => v.play().catch(() => {}))
          hls.on(Hls.Events.ERROR, (_e: any, d: any) => { if (d?.fatal) setErr(explain(d.details)) })
        } else {
          const dashjs: any = (await import('dashjs')).default
          if (killed) return
          dash = dashjs.MediaPlayer().create()
          dashRef.current = dash
          dash.initialize(v, url, true)
          try { dash.on(dashjs.MediaPlayer.events.ERROR, (e: any) => setErr(explain(e?.error?.message))) } catch { /* older dash.js */ }
        }
      } catch (e: any) { setErr(e?.message || 'playback failed') }
    })()
    return () => {
      killed = true
      try { hls?.destroy() } catch { /* ignore */ }
      try { dash?.reset() } catch { /* ignore */ }
      hlsRef.current = null; dashRef.current = null
      try { v.pause(); v.removeAttribute('src'); v.load() } catch { /* ignore */ }
    }
  }, [url, fmt])
  return (
    <div className="ou-preview">
      <div className="ou-pv" ref={box}><video ref={ref} muted playsInline controls /></div>
      {err && <div className="ou-err">{err}</div>}
    </div>
  )
}
