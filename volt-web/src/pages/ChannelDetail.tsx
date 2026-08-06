import { useEffect, useMemo, useRef, useState } from 'react'
import { api, originUrl, type ChannelDetail as CD, type ChannelSettingsPatch } from '../api'

const BOLT = <svg viewBox="0 0 24 24" fill="currentColor"><path d="M13 2 4 14h6l-1 8 9-12h-6z" /></svg>
const LANGS = [
  { code: 'en', label: 'English' }, { code: 'ms', label: 'Malay' },
  { code: 'zh', label: 'Chinese' }, { code: 'ta', label: 'Tamil' },
]
function fmtOffset(sec: number) {
  if (sec <= 0) return 'LIVE'
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = Math.floor(sec % 60)
  return '-' + (h ? `${h}:${String(m).padStart(2, '0')}` : `${m}`) + ':' + String(s).padStart(2, '0')
}
function fmtWindow(sec: number) {
  if (sec >= 3600) return `${(sec / 3600).toFixed(sec % 3600 ? 1 : 0)}h`
  return `${Math.round(sec / 60)}m`
}

export default function ChannelDetail({ id, onBack, onOpenSettings }: { id: string; onBack: () => void; onOpenSettings?: () => void }) {
  const [d, setD] = useState<CD | null>(null)
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)

  async function load() {
    try { setD(await api.channel(id)) } catch (e: any) { setErr(e.message) }
  }
  useEffect(() => { load(); /* eslint-disable-next-line */ }, [id])

  // In the test build, Start/Stop drives a real local test stream (FFmpeg → HLS/DASH
  // + live WebVTT) so playback + subtitles + DVR can actually be exercised.
  async function toggle() {
    if (!d) return
    setBusy(true)
    try {
      if (d.testStream?.running) { await api.testStreamStop(d.id); await load() }
      else {
        await api.testStreamStart(d.id, { langs: ['en', 'ms', 'zh', 'ta'], dvrSec: d.dvr_mode === 'event_start' ? 0 : d.dvr.effective_sec })
        // give ffmpeg a moment to emit the first segments, then refresh a few times
        for (let i = 0; i < 4; i++) { await new Promise(r => setTimeout(r, 1500)); await load() }
      }
    } catch (e: any) { setErr(e.message) } finally { setBusy(false) }
  }

  if (err) return <div className="err" style={{ margin: 20 }}>Couldn’t load channel: {err}</div>
  if (!d) return <div className="loading">Loading channel…</div>

  const live = d.status === 'live'
  const isEvent = d.dvr_mode === 'event_start'
  const wt = d.profile?.workflow_type
  const captionLangs = d.captions.targets.length ? d.captions.targets : ['en']

  return (
    <>
      <div className="page-head">
        <div>
          <div className="crumb" style={{ marginBottom: 6 }}>
            <span className="lnk" style={{ cursor: 'pointer', color: 'var(--brand)' }} onClick={onBack}>Channels</span>
            &nbsp;/&nbsp; <b style={{ color: 'var(--text)' }}>{d.name}</b>
          </div>
          <h1 style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <span className="dthumb" style={{ background: 'linear-gradient(135deg,#1d4ed8,#3b82f6)' }}>{d.name.split(/\s+/).slice(0, 2).map(w => w[0]).join('').toUpperCase()}</span>
            {d.name}
            <span className={`tag type ${wt === 'transcode' ? 'chan' : 'event'}`}>{wt === 'transcode' ? 'TRANSCODE' : 'PACKAGING'}</span>
            <span className={`tag ${live ? 'live' : 'idle'}`}><span className={`dot-s ${live ? 'live' : 'idle'}`} />{live ? 'OUTPUT LIVE' : 'IDLE'}</span>
          </h1>
          <p>
            {isEvent ? 'Event' : '24/7'} · DVR {isEvent ? 'to event start' : fmtWindow(d.dvr.effective_sec)}
            {d.dvr.capped && <span style={{ color: 'var(--warn)' }}> (capped 4h)</span>}
            {' · '}{(d.sources[0]?.protocol || 'SRT').toUpperCase()} ingest · {d.profile?.packaging === 'both' ? 'HLS + DASH' : (d.profile?.packaging || 'HLS').toUpperCase()}
            {d.captions.enabled ? ' · captions on' : ''}
            {d.geo_mode !== 'worldwide' ? ` · geo ${d.geo_mode}` : ''}
          </p>
        </div>
        <div className="spacer" />
        <button className="btn ghost" onClick={() => { setSettingsOpen(true); onOpenSettings?.() }}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="3" /><path d="M12 3v3M12 18v3M3 12h3M18 12h3" /></svg>Settings
        </button>
        <button className={`btn ${d.testStream?.running ? 'ghost' : 'primary'}`} disabled={busy} onClick={toggle} style={d.testStream?.running ? { color: '#fca5a5' } : undefined}>
          {busy ? (d.testStream?.running ? 'Stopping…' : 'Starting…') : d.testStream?.running ? 'Stop stream' : 'Start test stream'}
        </button>
      </div>

      <DualPlayers d={d} live={live} captionLangs={captionLangs} onStart={toggle} starting={busy} />

      <EpgStrip d={d} />

      <ViewersCard d={d} live={live} />

      <div className="grid-2">
        <StatusBoard d={d} live={live} />
        <EventLog d={d} />
      </div>

      {settingsOpen && (
        <SettingsDrawer d={d} onClose={() => setSettingsOpen(false)}
          onSaved={() => { setSettingsOpen(false); load() }} />
      )}
    </>
  )
}

/* ------------------------------------------------------------------ players */
interface Cue { start: number; end: number; text: string }
function parseVtt(txt: string): Cue[] {
  const cues: Cue[] = []
  const toSec = (s: string) => { const m = s.trim().match(/(?:(\d+):)?(\d+):(\d+)[.,](\d+)/); if (!m) return 0; const h = +(m[1] || 0), mi = +m[2], se = +m[3], ms = +m[4]; return h * 3600 + mi * 60 + se + ms / 1000 }
  for (const block of txt.split(/\r?\n\r?\n/)) {
    const lines = block.split(/\r?\n/).filter(Boolean)
    const tl = lines.find(l => l.includes('-->'))
    if (!tl) continue
    const [a, b] = tl.split('-->')
    const text = lines.slice(lines.indexOf(tl) + 1).join('\n')
    if (text) cues.push({ start: toSec(a), end: toSec(b), text })
  }
  return cues
}

function DualPlayers({ d, live, captionLangs, onStart, starting }: { d: CD; live: boolean; captionLangs: string[]; onStart: () => void; starting: boolean }) {
  const ts = d.testStream
  const playing = ts?.running && ts?.hls
  const [subOn, setSubOn] = useState(true)
  const [subLang, setSubLang] = useState(captionLangs[0] || 'en')

  return (
    <div className="player-grid" style={{ marginBottom: 18 }}>
      {/* SOURCE */}
      <div className="player">
        <div className="video">
          <div className="grad" />
          <div className="plabel"><span className="pt" style={{ color: '#a5b4fc' }}>SOURCE · raw ingest</span></div>
          <div className="badge-live" style={{ background: 'rgba(99,102,241,.85)' }}><span className="d" />{(d.sources[0]?.protocol || 'SRT').toUpperCase()}</div>
          <div className="play"><svg viewBox="0 0 24 24" fill="currentColor"><path d="M6 4l14 8-14 8z" /></svg></div>
          <div className="ptime">{playing ? 'test pattern · 1080p50' : live ? '00:12:44:07' : '— no signal —'}</div>
        </div>
        <div className="pfoot">
          <span className={`dot-s ${playing || live ? 'live' : 'idle'}`} /> {playing ? 'Test generator · testsrc + tone' : live ? 'Primary source · 1080p50 · 18.4 Mbps' : 'Primary source · offline'}
          <select value={0} onChange={() => {}}>
            {d.sources.length ? d.sources.map((s, i) => <option key={s.id} value={i}>Source · {s.role}</option>)
              : <><option>Source · Primary</option><option>Source · Backup</option></>}
          </select>
        </div>
      </div>

      {/* OUTPUT — real HLS playback when a test stream is running */}
      {playing
        ? <HlsOutput d={d} captionLangs={captionLangs} subOn={subOn} setSubOn={setSubOn} subLang={subLang} setSubLang={setSubLang} />
        : <IdleOutput onStart={onStart} starting={starting} />}
    </div>
  )
}

function IdleOutput({ onStart, starting }: { onStart: () => void; starting: boolean }) {
  return (
    <div className="player">
      <div className="video">
        <div className="grad" style={{ background: 'radial-gradient(120% 120% at 70% 20%,#20304a 0%,#0b0f16 70%)' }} />
        <div className="plabel"><span className="pt" style={{ color: '#98a1b6' }}>OUTPUT · idle</span></div>
        <div className="badge-live" style={{ background: 'rgba(102,112,138,.7)' }}><span className="d" />IDLE</div>
        <div style={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center' }}>
          <button className="btn primary" onClick={onStart} disabled={starting} style={{ transform: 'scale(1.05)' }}>
            {starting ? 'Starting encoder…' : '▶  Start test stream'}
          </button>
        </div>
        <div className="ptime">no output</div>
      </div>
      <div className="pfoot">
        <span className="dot-s idle" /> Start a test stream to package a live HLS/DASH ladder and play it back here
      </div>
    </div>
  )
}

function HlsOutput({ d, captionLangs, subOn, setSubOn, subLang, setSubLang }: {
  d: CD; captionLangs: string[]; subOn: boolean; setSubOn: (v: boolean) => void; subLang: string; setSubLang: (v: string) => void
}) {
  const ts = d.testStream
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const hlsRef = useRef<any>(null)
  const [levels, setLevels] = useState<{ height: number; bitrate: number }[]>([])
  const [level, setLevel] = useState(-1) // -1 = auto (ABR)
  const [atLive, setAtLive] = useState(true)
  const [behind, setBehind] = useState(0)
  const [winSec, setWinSec] = useState(d.dvr.effective_sec)
  const [cue, setCue] = useState('')
  const cuesRef = useRef<Cue[]>([])

  // attach hls.js
  useEffect(() => {
    let cancelled = false
    const video = videoRef.current
    if (!video || !ts.hls) return
    async function attach() {
      const Hls = (await import('hls.js')).default
      if (cancelled) return
      if (Hls.isSupported()) {
        const hls = new Hls({ lowLatencyMode: true, backBufferLength: d.dvr.effective_sec, liveSyncDurationCount: 3 })
        hlsRef.current = hls
        hls.loadSource(originUrl(ts.hls))
        hls.attachMedia(video!)
        hls.on(Hls.Events.MANIFEST_PARSED, () => {
          setLevels(hls.levels.map((l: any) => ({ height: l.height, bitrate: l.bitrate })))
          video!.muted = true; video!.play().catch(() => {})
        })
        hls.on(Hls.Events.ERROR, (_e: any, data: any) => {
          if (data.fatal) { // segments may not exist yet right after start — retry
            setTimeout(() => { try { hls.startLoad() } catch {} }, 1500)
          }
        })
      } else if (video!.canPlayType('application/vnd.apple.mpegurl')) {
        video!.src = originUrl(ts.hls); video!.muted = true; video!.play().catch(() => {})
      }
    }
    attach()
    return () => { cancelled = true; try { hlsRef.current?.destroy() } catch {} }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ts.hls])

  // apply rendition selection
  useEffect(() => { if (hlsRef.current) hlsRef.current.currentLevel = level }, [level])

  // track live-edge vs DVR position
  useEffect(() => {
    const v = videoRef.current; if (!v) return
    const onT = () => {
      const sk = v.seekable
      if (sk.length) {
        const end = sk.end(sk.length - 1), start = sk.start(0)
        setWinSec(Math.max(1, Math.round(end - start)))
        const b = Math.max(0, Math.round(end - v.currentTime))
        setBehind(b); setAtLive(b <= 3)
      }
    }
    v.addEventListener('timeupdate', onT)
    return () => v.removeEventListener('timeupdate', onT)
  }, [])

  // poll the live subtitle track and pick the current cue
  useEffect(() => {
    if (!subOn) { setCue(''); return }
    const url = ts.subtitles[subLang]; if (!url) return
    let stop = false
    async function poll() {
      try { const r = await fetch(originUrl(url) + '?_=' + Math.floor(Date.now() / 1000)); cuesRef.current = parseVtt(await r.text()) } catch { /* ignore */ }
    }
    poll(); const iv = setInterval(() => { if (!stop) poll() }, 2000)
    const tick = setInterval(() => {
      const v = videoRef.current; if (!v || !cuesRef.current.length) return
      const t = v.currentTime
      const hit = cuesRef.current.find(c => t >= c.start && t < c.end) || cuesRef.current[cuesRef.current.length - 1]
      setCue(hit?.text || '')
    }, 300)
    return () => { stop = true; clearInterval(iv); clearInterval(tick) }
  }, [subOn, subLang, ts.subtitles])

  function seekBehind(sec: number) {
    const v = videoRef.current; if (!v || !v.seekable.length) return
    const end = v.seekable.end(v.seekable.length - 1)
    v.currentTime = Math.max(v.seekable.start(0), end - sec)
  }
  function goLive() { const v = videoRef.current; if (!v || !v.seekable.length) return; v.currentTime = v.seekable.end(v.seekable.length - 1) - 0.5 }

  return (
    <div className="player">
      <div className="video">
        <video ref={videoRef} playsInline muted style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover', background: '#000' }} />
        <div className="plabel"><span className="pt" style={{ color: atLive ? '#4ade80' : '#fbbf24' }}>OUTPUT · {atLive ? 'as delivered' : 'DVR catch-up'}</span></div>
        <div className="badge-live" style={atLive ? undefined : { background: 'rgba(251,191,36,.9)' }}><span className="d" />{atLive ? 'LIVE' : 'DVR'}</div>
        <div className="bug"><span className="lg">{BOLT}</span>{d.name.toUpperCase()}</div>
        {subOn && cue && (
          <div style={{
            position: 'absolute', left: '50%', bottom: 20, transform: 'translateX(-50%)',
            background: 'rgba(0,0,0,.72)', color: '#fff', padding: '6px 14px', borderRadius: 6,
            fontSize: 15, fontWeight: 600, maxWidth: '88%', textAlign: 'center', lineHeight: 1.35, whiteSpace: 'pre-line',
          }}>{cue}</div>
        )}
        <div className="ptime">{atLive ? 'live edge' : `${fmtOffset(behind)} behind`}</div>
      </div>

      {/* DVR scrubber — seeks the real HLS timeline */}
      <div style={{ padding: '10px 12px 4px', borderBottom: '1px solid var(--border)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 7 }}>
          <span className={`tag ${atLive ? 'live' : 'warn'}`} style={{ minWidth: 62, justifyContent: 'center' }}>
            {atLive ? <><span className="dot-s live" />LIVE</> : fmtOffset(behind)}
          </span>
          <input type="range" min={0} max={winSec} step={1} value={winSec - behind}
            onChange={e => seekBehind(winSec - Number(e.target.value))}
            style={{ flex: 1, accentColor: atLive ? 'var(--live)' : 'var(--warn)' }} aria-label="DVR timeline" />
          <button className="chip" style={{ padding: '5px 10px' }} disabled={atLive} onClick={goLive}>Go live</button>
        </div>
        <div style={{ display: 'flex', gap: 6, justifyContent: 'space-between', fontSize: 11, color: 'var(--faint)' }}>
          <span>{d.dvr_mode === 'event_start' ? 'Event start' : `-${fmtWindow(winSec)} window`}</span>
          <span style={{ display: 'flex', gap: 6 }}>
            <button className="chip" style={{ padding: '3px 8px', fontSize: 11 }} onClick={() => seekBehind(behind + 15)}>« 15s</button>
            <button className="chip" style={{ padding: '3px 8px', fontSize: 11 }} onClick={() => seekBehind(behind + 60)}>« 1m</button>
          </span>
          <span>Live</span>
        </div>
      </div>

      <div className="pfoot">
        <span className="dot-s live" /> HLS · overlay burned-in
        <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center', marginLeft: 'auto' }}>
          <button className={`chip ${subOn ? 'active' : ''}`} style={{ padding: '5px 10px' }} onClick={() => setSubOn(!subOn)}>CC</button>
          {subOn && (
            <select value={subLang} onChange={e => setSubLang(e.target.value)}>
              {captionLangs.map(c => <option key={c} value={c}>{LANGS.find(l => l.code === c)?.label || c}</option>)}
            </select>
          )}
          <select value={level} onChange={e => setLevel(Number(e.target.value))}>
            <option value={-1}>Auto (ABR)</option>
            {levels.map((l, i) => <option key={i} value={i}>{l.height}p · {(l.bitrate / 1e6).toFixed(1)} Mbps</option>)}
          </select>
        </span>
      </div>
    </div>
  )
}

/* --------------------------------------------------------------------- EPG */
function EpgStrip({ d }: { d: CD }) {
  const now = d.epg.now
  return (
    <div className="card" style={{ marginBottom: 18 }}>
      <div className="epg-head">
        <span className="tag live"><span className="dot-s live" />ON NOW</span>
        <b>{now?.name || '—'}</b>
        {now && <span className="epg-elapsed">{now.elapsedMin}:00 <span>/ {now.mins}:00</span></span>}
        <div className="spacer" />
        {d.epg.next && <span className="epg-next">Up next · <b>{d.epg.next.name}</b> · {d.epg.next.start}</span>}
      </div>
      <div className="epg-lane">
        <div className="epg-track">
          {d.epg.lane.map((p: any, i: number) => (
            <div key={i} className={`epg-prog ${p.state || ''}`}>
              {p.state === 'now' && <><span className="fill" style={{ width: `${p.progress}%` }} /><span className="nowdot" style={{ left: `${p.progress}%` }} /></>}
              <div className="pnm">{p.name}</div>
              <div className="ptm">{p.start} – {p.end} · {p.mins}m{p.state === 'now' ? ` · ${p.progress}%` : ''}</div>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

/* ----------------------------------------------------------------- viewers */
function ViewersCard({ d, live }: { d: CD; live: boolean }) {
  const s = d.viewers.series
  const path = useMemo(() => {
    if (!s.length) return { line: '', area: '' }
    const w = 900, h = 190, pad = 6
    const max = Math.max(...s.map(p => p.v), 1)
    const x = (i: number) => (i / (s.length - 1)) * w
    const y = (v: number) => h - pad - (v / max) * (h - pad * 2)
    const line = s.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(p.v).toFixed(1)}`).join(' ')
    const area = `${line} L${w},${h} L0,${h} Z`
    return { line, area }
  }, [s])
  return (
    <div className="card" style={{ marginBottom: 18 }}>
      <div className="card-h"><h3>Realtime viewers</h3><div className="spacer" /><span className="sub">live via SSE</span></div>
      <div className="card-b">
        <div className="viewer-head" style={{ marginBottom: 8 }}>
          <div className="bignum">{live && <span className="lv" />}<span>{d.viewers.current.toLocaleString()}</span></div>
          <div style={{ color: 'var(--muted)', fontSize: 13 }}>
            <span className={`trend ${d.viewers.trendPct >= 0 ? 'up' : 'down'}`}>{d.viewers.trendPct >= 0 ? '▲' : '▼'} {Math.abs(d.viewers.trendPct)}%</span> vs 1h ago · peak <b style={{ color: 'var(--text)' }}>{d.viewers.peak.toLocaleString()}</b>
          </div>
        </div>
        <div className="chart-wrap">
          <svg viewBox="0 0 900 190" preserveAspectRatio="none" style={{ width: '100%', height: 190 }}>
            <defs><linearGradient id="vg" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="var(--brand)" stopOpacity="0.35" /><stop offset="100%" stopColor="var(--brand)" stopOpacity="0" />
            </linearGradient></defs>
            <path d={path.area} fill="url(#vg)" />
            <path d={path.line} fill="none" stroke="var(--brand)" strokeWidth="2.5" vectorEffect="non-scaling-stroke" />
          </svg>
        </div>
      </div>
    </div>
  )
}

/* ------------------------------------------------------------- status board */
function StatusBoard({ d, live }: { d: CD; live: boolean }) {
  const ladder = d.ladder.length ? d.ladder : []
  const maxBr = Math.max(...ladder.map(r => r.bitrate_kbps), 1)
  return (
    <div className="card">
      <div className="card-h"><h3>Output &amp; source status</h3><span className="sub">live via SSE</span></div>
      <div className="card-b">
        <div className="board" style={{ marginBottom: 14 }}>
          <div className="brow"><span className="k">Output</span><span className="v"><span className={`dot-s ${live ? 'live' : 'idle'}`} />{d.statusBoard.output}</span></div>
          <div className="brow"><span className="k">Active source</span><span className="v"><span className={`dot-s ${live ? 'live' : 'idle'}`} />{d.statusBoard.activeSource}</span></div>
          <div className="brow"><span className="k">Fallback</span><span className="v" style={{ color: 'var(--muted)' }}>{d.statusBoard.fallback}</span></div>
          <div className="brow"><span className="k">Packager</span><span className="v"><span className={`dot-s ${live ? 'live' : 'idle'}`} />{d.statusBoard.packager}</span></div>
          <div className="brow"><span className="k">DVR window</span><span className="v">{d.dvr_mode === 'event_start' ? 'To event start' : fmtWindow(d.dvr.effective_sec)}{d.dvr.source === 'channel' ? ' · channel' : ' · profile'}</span></div>
        </div>
        <div style={{ fontSize: 11, letterSpacing: '.06em', textTransform: 'uppercase', color: 'var(--faint)', marginBottom: 8 }}>Inputs</div>
        <div className="src-lights" style={{ marginBottom: 16 }}>
          {d.statusBoard.inputs.map((s: any, i: number) => (
            <div className="src" key={i}><span className={`dot-s ${s.state}`} /><span className="nm">{s.role[0].toUpperCase() + s.role.slice(1)} · {s.protocol}</span><span className="st">{s.detail}</span></div>
          ))}
        </div>
        {ladder.length > 0 && <>
          <div style={{ fontSize: 11, letterSpacing: '.06em', textTransform: 'uppercase', color: 'var(--faint)', marginBottom: 9 }}>Rendition ladder</div>
          <div className="ladder">
            {ladder.map((r, i) => (
              <div className="rung" key={i}><span className="q">{r.height}p</span><span className="bar"><i style={{ width: `${Math.round((r.bitrate_kbps / maxBr) * 100)}%` }} /></span><span className="br">{(r.bitrate_kbps / 1000).toFixed(1)} Mbps</span></div>
            ))}
          </div>
        </>}
      </div>
    </div>
  )
}

/* ----------------------------------------------------------------- the log */
const LOG_COLOR: Record<string, string> = { live: 'var(--live)', warn: 'var(--warn)', down: 'var(--down)', sched: 'var(--sched)', filler: 'var(--filler)' }
function EventLog({ d }: { d: CD }) {
  return (
    <div className="card">
      <div className="card-h"><h3>Connection issues &amp; event log</h3><div className="spacer" /><span className="tag warn">{d.log.filter(l => l.level === 'warn' || l.level === 'down').length} today</span></div>
      <div className="card-b" style={{ padding: '8px 18px' }}>
        <div className="log">
          {d.log.map((l, i) => (
            <div className="logrow" key={i}><span className="ts">{l.ts}</span><span className="ic" style={{ background: LOG_COLOR[l.level] || 'var(--sched)' }} /><span className="tx">{l.title}<small>{l.detail}</small></span></div>
          ))}
        </div>
      </div>
    </div>
  )
}

/* ------------------------------------------------------------ settings drawer */
function SettingsDrawer({ d, onClose, onSaved }: { d: CD; onClose: () => void; onSaved: () => void }) {
  const [name, setName] = useState(d.name)
  const [retention, setRetention] = useState<string>(d.recording_retention_days != null ? String(d.recording_retention_days) : '')
  // DVR
  const [dvrMode, setDvrMode] = useState<'sliding' | 'event_start'>(d.dvr_mode)
  const [dvrMin, setDvrMin] = useState<string>(String(Math.round((d.dvr_window_sec ?? d.dvr.effective_sec) / 60)))
  // source
  const src0 = d.sources.find(s => s.role === 'primary') || d.sources[0]
  const src1 = d.sources.find(s => s.role === 'backup')
  const [proto, setProto] = useState((src0?.protocol || 'srt').toLowerCase())
  const [primaryUrl, setPrimaryUrl] = useState(src0?.ingest_url || '')
  const [backupUrl, setBackupUrl] = useState(src1?.ingest_url || '')
  // geo
  const [geoMode, setGeoMode] = useState(d.geo_mode)
  const [geoCountries, setGeoCountries] = useState(d.geo_countries.join(', '))
  // subtitles
  const [capOn, setCapOn] = useState(d.captions.enabled)
  const [capLangs, setCapLangs] = useState<string[]>(d.captions.targets.length ? d.captions.targets : ['en'])
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')

  const DVR_MAX_MIN = 240 // 4h
  const dvrMinNum = Math.max(0, Math.min(DVR_MAX_MIN, Number(dvrMin) || 0))

  async function save() {
    setErr('')
    const patch: ChannelSettingsPatch = { version: d.version }
    if (name.trim() && name.trim() !== d.name) patch.name = name.trim()
    const retNum = retention ? Number(retention) : null
    if (retNum !== d.recording_retention_days) patch.recordingRetentionDays = retNum
    patch.dvrMode = dvrMode
    if (dvrMode === 'sliding') patch.dvrWindowSec = Math.max(30, dvrMinNum * 60)
    patch.geoMode = geoMode
    if (geoMode !== 'worldwide') patch.geoCountries = geoCountries.split(',').map(s => s.trim().toUpperCase()).filter(s => s.length === 2)
    else patch.geoCountries = []
    // sources
    const sources: ChannelSettingsPatch['sources'] = []
    if (primaryUrl.trim()) sources.push({ role: 'primary', protocol: proto, ingestUrl: primaryUrl.trim() })
    if (backupUrl.trim()) sources.push({ role: 'backup', protocol: proto, ingestUrl: backupUrl.trim() })
    if (sources.length) patch.sources = sources
    // captions
    patch.captions = { enabled: capOn, targets: capOn ? capLangs : [] }

    setBusy(true)
    try { await api.updateChannel(d.id, patch); onSaved() }
    catch (e: any) {
      if (String(e.message).includes('409') || /version|match/i.test(e.message)) setErr('This channel changed since you opened it — reopen settings and retry.')
      else setErr(e.message)
    } finally { setBusy(false) }
  }

  return (
    <div className="drawer-scrim" onClick={onClose}>
      <div className="drawer" onClick={e => e.stopPropagation()}>
        <div className="drawer-h"><div className="t">Channel settings</div><button className="xbtn" onClick={onClose}>✕</button></div>
        <div className="drawer-b">
          <div className="field"><label>Channel name</label><input className="inp" value={name} onChange={e => setName(e.target.value)} /></div>

          <div style={SEC}>Source</div>
          <div className="field"><label>Ingest protocol</label>
            <select className="inp" value={proto} onChange={e => setProto(e.target.value)}>
              {['srt', 'rtmp', 'rtp', 'rist', 'zixi', 'hls'].map(p => <option key={p} value={p}>{p.toUpperCase()}</option>)}
            </select>
          </div>
          <div className="field"><label>Primary ingest URL</label><input className="inp" value={primaryUrl} onChange={e => setPrimaryUrl(e.target.value)} placeholder="srt://ingest.volt…:9000?streamid=primary" /></div>
          <div className="field"><label>Backup ingest URL <span style={{ color: 'var(--faint)' }}>(optional)</span></label><input className="inp" value={backupUrl} onChange={e => setBackupUrl(e.target.value)} placeholder="srt://ingest.volt…:9000?streamid=backup" /></div>

          <div style={SEC}>DVR / catch-up</div>
          <div className="field"><label>DVR mode</label>
            <div className="presets">
              <div className={`preset ${dvrMode === 'sliding' ? 'sel' : ''}`} onClick={() => setDvrMode('sliding')}>
                <div className="pt">Sliding window</div><div className="px">24×7 — rolling catch-up up to 4h behind live.</div>
              </div>
              <div className={`preset ${dvrMode === 'event_start' ? 'sel' : ''}`} onClick={() => setDvrMode('event_start')}>
                <div className="pt">To event start</div><div className="px">Events — scrub back to the start of the stream.</div>
              </div>
            </div>
          </div>
          {dvrMode === 'sliding' && (
            <div className="field">
              <label>Window length — {dvrMinNum} min ({fmtWindow(dvrMinNum * 60)})</label>
              <input type="range" min={1} max={DVR_MAX_MIN} step={1} value={dvrMinNum} onChange={e => setDvrMin(e.target.value)} style={{ width: '100%', accentColor: 'var(--brand)' }} />
              <div className="hintxt">Maximum 4 hours (240 min) for 24×7 channels.</div>
            </div>
          )}

          <div style={SEC}>Source geo rules</div>
          <div className="field"><label>Access</label>
            <select className="inp" value={geoMode} onChange={e => setGeoMode(e.target.value as any)}>
              <option value="worldwide">Worldwide (no restriction)</option>
              <option value="allow">Allow only listed countries</option>
              <option value="block">Block listed countries</option>
            </select>
          </div>
          {geoMode !== 'worldwide' && (
            <div className="field"><label>Countries (ISO-2, comma-separated)</label><input className="inp" value={geoCountries} onChange={e => setGeoCountries(e.target.value)} placeholder="MY, SG, ID" /></div>
          )}

          <div style={SEC}>Subtitles</div>
          <div className="toggle-row">
            <div><div className="tt">Live captions / subtitles</div><div className="td">Applies to this channel’s output profile.</div></div>
            <div className={`sw ${capOn ? '' : 'off'}`} onClick={() => setCapOn(v => !v)}><i /></div>
          </div>
          {capOn && (
            <div className="field"><label>Target languages</label>
              <div className="chipset">
                {LANGS.map(l => {
                  const on = capLangs.includes(l.code)
                  return <div key={l.code} className={`selchip ${on ? 'sel' : ''}`} onClick={() => setCapLangs(on ? capLangs.filter(x => x !== l.code) : [...capLangs, l.code])}>{l.label}</div>
                })}
              </div>
            </div>
          )}

          <div style={SEC}>Recording</div>
          <div className="field"><label>Retention (days) <span style={{ color: 'var(--faint)' }}>— blank = keep forever</span></label><input className="inp" value={retention} onChange={e => setRetention(e.target.value.replace(/[^0-9]/g, ''))} /></div>

          {err && <div className="err">{err}</div>}
        </div>
        <div className="drawer-f">
          <button className="btn ghost" onClick={onClose}>Cancel</button>
          <button className="btn primary" disabled={busy} onClick={save}>{busy ? 'Saving…' : 'Save changes'}</button>
        </div>
      </div>
    </div>
  )
}

const SEC: React.CSSProperties = { fontSize: 11, letterSpacing: '.06em', textTransform: 'uppercase', color: 'var(--faint)', margin: '18px 0 10px', fontWeight: 700 }
