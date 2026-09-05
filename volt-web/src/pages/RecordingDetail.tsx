import { Fragment, useEffect, useMemo, useRef, useState } from 'react'
import { api, getToken, recordingRangeUrl, type RecordingRow, type RecordingTimeline, type VodAssetRow, type RecordingProgramme, type TranscriptSearch } from '../api'
import AudioVisualizer from '../AudioVisualizer'
import ClipTimeline from '../ClipTimeline'
import { ClipProvenancePanel } from '../ClipProvenance'
import type { Waveform } from '../api'
import { pressable } from '../a11y'

/* ============================================================================
   Recording detail — the review/trim/clip page, following the same structural
   flow as channels and events: the LIST page links here, this page owns the
   work. Built like a lightweight NLE:

   - the player is always on: a working range is loaded and you scrub it
   - the timeline shows recorded coverage, the loaded range, the trim marks
     (in/out) and the CURRENT PLAYHEAD
   - keyboard, matching standard editor conventions (active when not typing):
       Space        play / pause
       ← / →        jump 10s back / forward
       , / .        (< / >) single frame back / forward
       I / O        set trim start / trim end at the playhead
   - Create clip cuts the marked range; clips already made from this recording
     are listed right under the clip controls
   ========================================================================== */

const FRAME = 1 / 25   // matches the platform's default output fps

const fmtClock = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
const fmtDate = (ms: number) => new Date(ms).toLocaleDateString([], { day: '2-digit', month: 'short' })
function fmtDur(ms: number) {
  const s = Math.max(0, Math.round(ms / 1000))
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), ss = s % 60
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(ss).padStart(2, '0')}` : `${m}:${String(ss).padStart(2, '0')}`
}
const KIND_LABEL: Record<string, string> = { event: 'Event', channel_day: 'Channel day' }

type Rec = RecordingRow & { vod_assets?: VodAssetRow[] }

/* ---------------------------------------------------------------------------
   WHAT IS LOADING, AND WHY.

   This page pulls five separate things, each on its own clock: the recording
   row, the on-disk coverage (a scan of every segment), the audio envelope for
   the visible window, the metadata lane for that window, and the transcript
   languages. On a 24x7 capture the second and third can take seconds, and
   until now the only sign of that was a lane that stayed empty. Each part now
   reports what it is doing, so a wait reads as "coverage: scanning 21,600
   segments" rather than "the page is broken".
   ------------------------------------------------------------------------ */
type LoadPart = 'recording' | 'coverage' | 'waveform' | 'metadata' | 'transcript'
interface LoadInfo { state: 'idle' | 'loading' | 'done' | 'error'; note?: string; ms?: number }
const PART_LABEL: Record<LoadPart, string> = {
  recording: 'Recording', coverage: 'Coverage', waveform: 'Audio envelope', metadata: 'Metadata lane', transcript: 'Transcript',
}

function LoadStatus({ parts }: { parts: Record<LoadPart, LoadInfo> }) {
  const entries = (Object.keys(parts) as LoadPart[]).map(k => [k, parts[k]] as const)
  const busy = entries.filter(([, v]) => v.state === 'loading')
  const failed = entries.filter(([, v]) => v.state === 'error')
  if (!busy.length && !failed.length) return null
  const dot = (st: LoadInfo['state']) => st === 'loading' ? '#7dd3fc' : st === 'error' ? '#f87171' : st === 'done' ? '#4ade80' : '#475569'
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px 16px', alignItems: 'center', padding: '6px 10px', marginBottom: 8,
      border: '1px solid var(--border)', borderRadius: 8, background: 'rgba(125,211,252,.05)', fontSize: 'var(--fs-xs)', color: 'var(--faint)' }}>
      <span style={{ color: 'var(--muted)', fontWeight: 600 }}>
        {busy.length ? `Loading ${busy.length} of ${entries.length}` : 'Some parts did not load'}
      </span>
      {entries.map(([k, v]) => (
        <span key={k} title={v.note} style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
          <span style={{ width: 7, height: 7, borderRadius: 4, background: dot(v.state), flex: 'none',
            animation: v.state === 'loading' ? 'pulse2 1.2s ease-in-out infinite' : undefined }} />
          <span style={{ color: v.state === 'error' ? '#f87171' : undefined }}>{PART_LABEL[k]}</span>
          {v.state === 'loading' && v.note && <span>· {v.note}</span>}
          {v.state === 'error' && v.note && <span>· {v.note}</span>}
          {v.state === 'done' && v.ms != null && v.ms > 800 && <span>· {(v.ms / 1000).toFixed(1)}s</span>}
        </span>
      ))}
    </div>
  )
}

export default function RecordingDetail({ id, onBack }: { id: string; onBack: () => void }) {
  const initialQuery = useMemo(() => new URLSearchParams(window.location.search).get('q') || '', [])
  const [rec, setRec] = useState<Rec | null>(null)
  const [tl, setTl] = useState<RecordingTimeline | null>(null)
  const [err, setErr] = useState('')
  const [programmes, setProgrammes] = useState<RecordingProgramme[]>([])
  // trim marks (wall-clock ms) + the range currently LOADED in the player
  const [selFrom, setSelFrom] = useState<number | null>(null)
  const [selTo, setSelTo] = useState<number | null>(null)
  const [loaded, setLoaded] = useState<{ from: number; to: number } | null>(null)
  const [playheadMs, setPlayheadMs] = useState<number | null>(null)
  // ZOOM window over the recording (a 24x7 capture can span days) + its waveform
  const [view, setView] = useState<{ start: number; end: number } | null>(null)
  const [wave, setWave] = useState<Waveform | null>(null)
  const [waveBusy, setWaveBusy] = useState(false)
  const [loadParts, setLoadParts] = useState<Record<LoadPart, LoadInfo>>({
    recording: { state: 'idle' }, coverage: { state: 'idle' }, waveform: { state: 'idle' }, metadata: { state: 'idle' }, transcript: { state: 'idle' },
  })
  const part = (k: LoadPart, info: LoadInfo) => setLoadParts(p => ({ ...p, [k]: info }))
  const [playerErr, setPlayerErr] = useState('')
  const videoRef = useRef<HTMLVideoElement | null>(null)
  // transcript side panel: cues for the LOADED range (live-follows the playhead)
  // or, when a search term is set, matches across the whole recording
  const [tsLangs, setTsLangs] = useState<string[]>([])
  const [tsQ, setTsQ] = useState(initialQuery)
  const [tsLang, setTsLang] = useState('')
  const [cues, setCues] = useState<TranscriptSearch['matches']>([])
  const [tsMode, setTsMode] = useState<'range' | 'search'>('range')
  const [flash, setFlash] = useState<{ from: number; to: number } | null>(null)
  const cueListRef = useRef<HTMLDivElement | null>(null)
  // clip creation
  const [clipTitle, setClipTitle] = useState('')
  const [outputKind, setOutputKind] = useState<'manifest' | 'progressive' | 'both'>('manifest')
  const [busy, setBusy] = useState('')
  /** Which clip has its source chain open. One at a time: the panel is a
   *  record you consult, not a column you scan. */
  const [openProv, setOpenProv] = useState<string | null>(null)
  const [msg, setMsg] = useState('')
  const [actErr, setActErr] = useState('')

  async function loadRec() {
    const t0 = Date.now()
    part('recording', { state: 'loading', note: 'fetching the recording' })
    try { setRec(await api.recording(id)); part('recording', { state: 'done', ms: Date.now() - t0 }) }
    catch (e: any) { setErr(e.message); part('recording', { state: 'error', note: e.message }) }
  }
  async function loadTl() {
    const t0 = Date.now()
    part('coverage', { state: 'loading', note: 'scanning the segments on disk' })
    try {
      const t = await api.recordingTimeline(id)
      setTl(t)
      const n = t.spans.reduce((a, s) => a + (s.segments ?? 0), 0)
      part('coverage', { state: 'done', ms: Date.now() - t0, note: n ? `${n.toLocaleString()} segments` : undefined })
    } catch (e: any) { setErr(e.message); part('coverage', { state: 'error', note: e.message }) }
  }
  useEffect(() => {
    loadRec(); loadTl()
    // The metadata lane is fetched for the VISIBLE window only (below). The
    // unbounded call that used to sit here pulled every entry of the recording,
    // tens of thousands on a 24x7 radio station, and then threw them away the
    // moment the zoom window arrived.
    part('transcript', { state: 'loading', note: 'checking for subtitles' })
    api.recordingTranscript(id).then(r => { setTsLangs(r.languages); part('transcript', { state: 'done' }) })
      .catch(() => { setTsLangs([]); part('transcript', { state: 'done' }) })
    /* eslint-disable-next-line */
  }, [id])

  const domain = useMemo(() => {
    if (!rec) return null
    const start = Number(rec.start_epoch_ms)
    const end = rec.end_epoch_ms != null ? Number(rec.end_epoch_ms)
      : (tl?.spans.length ? tl.spans[tl.spans.length - 1].endMs : Date.now())
    return { start, end: Math.max(end, start + 1) }
  }, [rec, tl])

  /** Load [from..to] into the player (clamped to the domain). */
  function loadRange(fromMs: number, toMs: number) {
    if (!domain) return
    const f = Math.max(domain.start, Math.min(fromMs, domain.end - 1000))
    const t = Math.min(domain.end, Math.max(toMs, f + 1000))
    setLoaded({ from: f, to: t })
    setPlayheadMs(f)
  }

  // first load: bring the most recent material into the player (up to 2h of
  // context to scrub in), default marks on the last 5 minutes
  useEffect(() => {
    if (!tl || !tl.spans.length || loaded) return
    const last = tl.spans[tl.spans.length - 1]
    const from = Math.max(tl.spans[0].startMs, last.endMs - 2 * 3600_000)
    loadRange(from, last.endMs)
    setSelFrom(Math.max(last.startMs, last.endMs - 5 * 60_000)); setSelTo(last.endMs)
    /* eslint-disable-next-line */
  }, [tl])

  // OPENING ZOOM: the last 30 minutes of material, so a long 24x7 recording
  // starts where the work usually is instead of squashed across days.
  useEffect(() => {
    if (!domain || view) return
    const end = domain.end
    const start = Math.max(domain.start, end - 30 * 60_000)
    setView({ start, end })
    /* eslint-disable-next-line */
  }, [domain])

  // WAVEFORM for the visible window. Debounced (zooming fires a lot), one
  // bucket per ~2px, and re-requested while the server reports `pending` so a
  // wide window fills in progressively instead of blocking.
  useEffect(() => {
    if (!view) return
    let cancelled = false
    const t = setTimeout(async () => {
      setWaveBusy(true)
      const t0 = Date.now()
      const span = view.end - view.start
      part('waveform', { state: 'loading', note: span <= 15 * 60_000 ? 'exact: decoding this window (cached after the first look)' : 'sampled: one segment per column' })
      try {
        const buckets = Math.max(120, Math.min(900, Math.round((window.innerWidth - 420) / 2)))
        let w = await api.recordingWaveform(id, view.start, view.end, buckets)
        if (cancelled) return
        setWave(w)
        // The server measures the whole recording in the background and never
        // blocks a request past its budget; poll while THIS window still has
        // unmeasured segments so it fills in, then stop. The background pass
        // over the rest of the recording is not waited on: it only matters
        // when the operator zooms somewhere new, and that view polls itself.
        const pc = (a: number, b: number) => `${Math.round(100 * a / Math.max(1, b))}%`
        for (let i = 0; i < 40 && !cancelled && w.pending > 0; i++) {
          part('waveform', { state: 'loading', note: w.coverage ? `${pc(w.coverage.measured, w.coverage.total)} of this window measured` : 'filling in' })
          await new Promise(r => setTimeout(r, Math.min(4000, 1200 + i * 200)))
          if (cancelled) return
          w = await api.recordingWaveform(id, view.start, view.end, buckets)
          if (cancelled) return
          setWave(w)
        }
        part('waveform', { state: w.pending > 0 ? 'error' : 'done', ms: Date.now() - t0, note: w.pending > 0 ? 'some of this window could not be measured' : undefined })
      } catch (e: any) { if (!cancelled) { setWave(null); part('waveform', { state: 'error', note: e?.message || 'failed' }) } }
      finally { if (!cancelled) setWaveBusy(false) }
    }, 260)
    return () => { cancelled = true; clearTimeout(t) }
    /* eslint-disable-next-line */
  }, [id, view?.start, view?.end])

  // metadata lane follows the zoom: a 24x7 radio recording can hold tens of
  // thousands of now-playing entries, so only the visible window is fetched
  useEffect(() => {
    if (!view) return
    let cancelled = false
    const t = setTimeout(() => {
      const pad = (view.end - view.start) * 0.1
      const t0 = Date.now()
      part('metadata', { state: 'loading', note: 'EPG and now-playing for this window' })
      api.recordingProgrammes(id, { from: view.start - pad, to: view.end + pad })
        .then(r => { if (!cancelled) { setProgrammes(r.programmes); part('metadata', { state: 'done', ms: Date.now() - t0, note: `${r.programmes.length} items` }) } })
        .catch((e: any) => { if (!cancelled) part('metadata', { state: 'error', note: e?.message || 'failed' }) })
    }, 260)
    return () => { cancelled = true; clearTimeout(t) }
    /* eslint-disable-next-line */
  }, [id, view?.start, view?.end])

  // side panel content: debounced — search term set = whole-recording search;
  // empty = the cues inside the loaded player range
  useEffect(() => {
    if (!tsLangs.length) return
    const t = setTimeout(async () => {
      try {
        if (tsQ.trim()) {
          const r = await api.recordingTranscript(id, { q: tsQ.trim(), lang: tsLang || undefined })
          setCues(r.matches); setTsMode('search')
        } else if (loaded) {
          const r = await api.recordingTranscript(id, { from: loaded.from, to: loaded.to, lang: tsLang || undefined })
          setCues(r.matches); setTsMode('range')
        }
      } catch { /* panel stays as-is */ }
    }, 300)
    return () => clearTimeout(t)
    /* eslint-disable-next-line */
  }, [tsQ, tsLang, tsLangs.length, loaded?.from, loaded?.to])

  // the cue under the playhead (for the highlight + auto-follow)
  const activeCue = useMemo(() => {
    if (playheadMs == null || tsMode !== 'range') return -1
    for (let i = cues.length - 1; i >= 0; i--) {
      if (cues[i].tMs <= playheadMs && playheadMs <= cues[i].endMs + 1500) return i
    }
    return -1
  }, [cues, playheadMs, tsMode])
  useEffect(() => {
    if (activeCue < 0) return
    const el = cueListRef.current?.querySelector(`[data-cue="${activeCue}"]`)
    el?.scrollIntoView({ block: 'nearest' })
  }, [activeCue])

  /** Subtitle line click: jump the playhead there and flash the cue's slice on
   *  the clipping bar (marks are untouched — use I/O to set them). */
  function jumpToCue(c: { tMs: number; endMs: number }) {
    const v = videoRef.current
    const lead = 1500
    if (v && loaded && c.tMs - lead >= loaded.from && c.tMs <= loaded.to) {
      v.currentTime = Math.max(0, (c.tMs - lead - loaded.from) / 1000)
      v.play().catch(() => {})
    } else {
      loadRange(c.tMs - lead, Math.max(c.endMs + 60_000, c.tMs + 60_000))
    }
    setFlash({ from: c.tMs, to: c.endMs })
    setTimeout(() => setFlash(null), 2600)
  }

  // ---- player wiring --------------------------------------------------------
  const playUrl = loaded ? recordingRangeUrl(id, loaded.from, loaded.to) : null
  useEffect(() => {
    let cancelled = false; let hls: any
    const v = videoRef.current
    if (!v || !playUrl) return
    setPlayerErr('')
    ;(async () => {
      const Hls = (await import('hls.js')).default
      if (cancelled) return
      if (Hls.isSupported()) {
        hls = new Hls({
          // hls.js invokes xhrSetup BEFORE xhr.open; open it ourselves so we can
          // attach the bearer for the /api playlists (segments stay public).
          xhrSetup: (xhr: XMLHttpRequest, u: string) => {
            try {
              if (new URL(u, window.location.href).pathname.startsWith('/api/')) {
                xhr.open('GET', u, true)
                xhr.setRequestHeader('authorization', `Bearer ${getToken()}`)
              }
            } catch {}
          },
        })
        hls.loadSource(playUrl); hls.attachMedia(v)
        hls.on(Hls.Events.MANIFEST_PARSED, () => { v.play().catch(() => {}) })
        let recoveries = 0
        hls.on(Hls.Events.ERROR, (_e: any, data: any) => {
          if (!data.fatal) return
          if (data.type === Hls.ErrorTypes.MEDIA_ERROR && recoveries < 3) { recoveries++; try { hls.recoverMediaError() } catch {}; return }
          setPlayerErr('Playback failed: ' + (data.details || data.type))
          try { hls.stopLoad() } catch {}
        })
      } else if (v.canPlayType('application/vnd.apple.mpegurl')) {
        v.src = playUrl; v.play().catch(() => {})
      } else setPlayerErr('HLS is not supported in this browser')
    })()
    return () => { cancelled = true; try { hls?.destroy() } catch {} }
  }, [playUrl])

  // playhead: player time -> wall clock on the loaded range
  useEffect(() => {
    const v = videoRef.current
    if (!v || !loaded) return
    const onTime = () => setPlayheadMs(loaded.from + v.currentTime * 1000)
    v.addEventListener('timeupdate', onTime)
    return () => v.removeEventListener('timeupdate', onTime)
  }, [loaded])

  // ---- NLE keyboard controls ------------------------------------------------
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return
      const v = videoRef.current
      if (!v || !loaded) return
      const wall = () => loaded.from + v.currentTime * 1000
      switch (e.key) {
        case ' ':
          e.preventDefault(); if (v.paused) v.play().catch(() => {}); else v.pause(); break
        case 'ArrowRight':
          e.preventDefault(); v.currentTime = Math.min(v.duration || 1e9, v.currentTime + 10); break
        case 'ArrowLeft':
          e.preventDefault(); v.currentTime = Math.max(0, v.currentTime - 10); break
        case '.': case '>':
          e.preventDefault(); v.pause(); v.currentTime = Math.min(v.duration || 1e9, v.currentTime + FRAME); break
        case ',': case '<':
          e.preventDefault(); v.pause(); v.currentTime = Math.max(0, v.currentTime - FRAME); break
        case 'i': case 'I': {
          e.preventDefault()
          const w = wall()
          setSelFrom(w)
          setSelTo(prev => (prev == null || prev <= w) ? loaded.to : prev)
          break
        }
        case 'o': case 'O': {
          e.preventDefault()
          const w = wall()
          setSelTo(w)
          setSelFrom(prev => (prev == null || prev >= w) ? loaded.from : prev)
          break
        }
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [loaded])

  const selOk = selFrom != null && selTo != null && selTo > selFrom
  const coveredMs = useMemo(() => {
    if (!tl || !selOk) return 0
    return tl.spans.reduce((a, s) => a + Math.max(0, Math.min(s.endMs, selTo!) - Math.max(s.startMs, selFrom!)), 0)
  }, [tl, selFrom, selTo, selOk])

  /** Jump: mark a slice AND load it into the player. */
  function jumpTo(fromMs: number, toMs: number) {
    if (!domain) return
    const f = Math.max(domain.start, Math.min(fromMs, domain.end - 1000))
    const t = Math.min(domain.end, Math.max(toMs, f + 1000))
    setSelFrom(f); setSelTo(t)
    loadRange(f, t)
  }

  async function createClip() {
    if (!selOk) { setActErr('Set the trim marks first (I and O, or drag on the timeline)'); return }
    if (!clipTitle.trim()) { setActErr('Give the clip a title'); return }
    setActErr(''); setMsg(''); setBusy('clip')
    try {
      await api.clipRecording(id, { title: clipTitle.trim(), startMs: Math.round(selFrom!), endMs: Math.round(selTo!), outputKind })
      setMsg('Clip created — listed below and in the Media Library.')
      setClipTitle(''); loadRec()
    } catch (e: any) { setActErr(e.message) } finally { setBusy('') }
  }
  async function publishFull() {
    setActErr(''); setMsg(''); setBusy('publish')
    try { await api.publishRecording(id, rec?.title || undefined); setMsg('Recording published as a full VOD asset.'); loadRec() }
    catch (e: any) { setActErr(e.message) } finally { setBusy('') }
  }
  const [altDownloads, setAltDownloads] = useState<{ format: string; label: string; url: string }[]>([])
  async function download() {
    setActErr(''); setMsg(''); setBusy('download')
    try {
      const r = await api.recordingDownload(id)
      if (r.status === 'ready' && r.url) {
        window.open(r.url, '_blank')
        setAltDownloads(r.alternatives ?? [])
      } else {
        setMsg(`${(r.format ?? 'mp4').toUpperCase()} export is being prepared. Check back shortly.`)
      }
    } catch (e: any) { setActErr(e.message) } finally { setBusy('') }
  }

  // Only when there is nothing to show. `err` is also written by the actions
  // on this page, so an unconditional guard let one rejected action replace
  // the working page — including the controls needed to retry — with a line
  // of red text and no way back except navigating away.
  if (err && !rec) return (<><BackRow onBack={onBack} /><div className="err">{err}</div></>)
  if (!rec || !domain) return (<><BackRow onBack={onBack} /><div className="loading">Loading recording…</div></>)

  const vods = rec.vod_assets ?? []

  return (
    <>
      <BackRow onBack={onBack} name={rec.source_name || 'Recording'} />
      <div className="page-head" style={{ marginBottom: 10 }}>
        <div>
          <h1 style={{ display: 'flex', alignItems: 'baseline', gap: 10 }}>{rec.source_name || 'Recording'}
            <span style={{ fontSize: 'var(--fs-body)', fontWeight: 400, color: 'var(--faint)' }}>{KIND_LABEL[rec.kind] || rec.kind} · {fmtDate(domain.start)} {fmtClock(domain.start)} → {rec.end_epoch_ms != null ? fmtClock(domain.end) : 'recording…'}</span>
          </h1>
          <p>{rec.title || 'Scrub with the keyboard, mark the range, cut the clip.'}</p>
        </div>
        <div className="spacer" />
        <button className="btn ghost" onClick={() => { loadTl(); loadRec() }}>Refresh</button>
      </div>

      <LoadStatus parts={loadParts} />
      {tl && tl.spans.length === 0 ? (
        <div className="empty"><h3>No segments on disk</h3><p>Nothing is recorded for this entry (pruned by retention, or recording was off for the run).</p></div>
      ) : (
        <div className="card" style={{ padding: 18 }}>
          {/* ------- player + live transcript side panel ------- */}
          <div style={{ display: 'grid', gridTemplateColumns: tsLangs.length ? '1fr 330px' : '1fr', gap: 14, alignItems: 'stretch' }}>
            <div>
              {/* RADIO recordings are audio-only: replace the 16:9 video surface with
                  the live audio visualiser (level + spectrum), so a muted review still
                  shows whether there is signal. The <video> element still drives
                  playback/seek; it is just not the visible surface. */}
              <video ref={videoRef} controls playsInline
                style={tl?.audioOnly
                  ? { width: '100%', height: 44, background: '#000', borderRadius: 10, border: '1px solid var(--border)' }
                  : { width: '100%', height: '100%', maxHeight: 430, background: '#000', borderRadius: 10, border: '1px solid var(--border)', objectFit: 'contain' }} />
              {tl?.audioOnly && (
                <div style={{ marginTop: 10 }}>
                  <AudioVisualizer media={videoRef.current} height={330} idleText="Load a range and press play" />
                </div>
              )}
            </div>
            {tsLangs.length > 0 && (
              <div style={{ display: 'flex', flexDirection: 'column', border: '1px solid var(--border)', borderRadius: 10, overflow: 'hidden', maxHeight: 430 }}>
                <div style={{ display: 'flex', gap: 6, alignItems: 'center', padding: '8px 10px', borderBottom: '1px solid var(--border)', flex: 'none' }}>
                  <input className="inp ts-q" style={{ flex: 1, fontSize: 'var(--fs-sm)', padding: '6px 9px' }} value={tsQ}
                    onChange={e => setTsQ(e.target.value)}
                    placeholder="Search subtitles… (all words, any order)" />
                  {tsLangs.length > 1 && (
                    <select className="inp" style={{ width: 64, fontSize: 'var(--fs-sm)', padding: '6px 6px' }} value={tsLang} onChange={e => setTsLang(e.target.value)}>
                      <option value="">all</option>
                      {tsLangs.map(l => <option key={l} value={l}>{l}</option>)}
                    </select>
                  )}
                </div>
                <div ref={cueListRef} className="ts-hits" style={{ flex: 1, overflowY: 'auto' }}>
                  {cues.length === 0 ? (
                    <div style={{ padding: '12px 12px', color: 'var(--faint)', fontSize: 'var(--fs-sm)' }}>
                      {tsQ.trim() ? `No spoken match for "${tsQ.trim()}".` : 'No subtitles in the loaded range.'}
                    </div>
                  ) : cues.map((m, i) => (
                    <div key={i} data-cue={i} {...pressable((e: any) => { ((() => jumpToCue(m)) as any)(e) })} data-a11y-click=""
                      style={{ display: 'flex', gap: 8, alignItems: 'baseline', padding: '6px 10px', cursor: 'pointer',
                        borderLeft: i === activeCue ? '3px solid var(--brand)' : '3px solid transparent',
                        background: i === activeCue ? 'rgba(120,140,255,.12)' : 'transparent' }}>
                      <span style={{ fontFamily: 'ui-monospace,monospace', fontSize: 'var(--fs-label)', color: 'var(--brand)', flex: 'none' }}>{fmtClock(m.tMs)}</span>
                      <span style={{ fontSize: 'var(--fs-sm)', flex: 1, color: i === activeCue ? 'var(--text,#fff)' : 'var(--muted)' }}>{m.text}</span>
                    </div>
                  ))}
                </div>
                <div style={{ padding: '5px 10px', borderTop: '1px solid var(--border)', fontSize: 'var(--fs-micro)', color: 'var(--faint)', flex: 'none' }}>
                  {tsMode === 'search' ? `${cues.length} match(es) across the recording — click to jump` : 'live transcript — click a line to jump there'}
                </div>
              </div>
            )}
          </div>
          {playerErr && <div className="err" style={{ marginTop: 6 }}>{playerErr}</div>}
          <div style={{ display: 'flex', alignItems: 'center', gap: 14, margin: '8px 0 12px', flexWrap: 'wrap' }}>
            <span style={{ fontFamily: 'ui-monospace,monospace', fontSize: 'var(--fs-body)' }}>
              <span style={{ color: 'var(--faint)' }}>Position </span>{playheadMs != null ? fmtClock(playheadMs) : '—'}
            </span>
            <span style={{ fontFamily: 'ui-monospace,monospace', fontSize: 'var(--fs-body)' }}>
              <span style={{ color: 'var(--faint)' }}>In </span>{selFrom != null ? fmtClock(selFrom) : '—'}
              <span style={{ color: 'var(--faint)' }}> Out </span>{selTo != null ? fmtClock(selTo) : '—'}
              {selOk && <span style={{ color: 'var(--muted)' }}> ({fmtDur(selTo! - selFrom!)}{coveredMs < (selTo! - selFrom!) - 1500 ? `, ${fmtDur(coveredMs)} recorded` : ''})</span>}
            </span>
            <span style={{ flex: 1 }} />
            <span style={{ fontSize: 'var(--fs-label)', color: 'var(--faint)' }}>
              <Kbd>space</Kbd> play/pause · <Kbd>←</Kbd><Kbd>→</Kbd> 10s · <Kbd>&lt;</Kbd><Kbd>&gt;</Kbd> frame · <Kbd>I</Kbd> in · <Kbd>O</Kbd> out
            </span>
          </div>

          {/* ------- ZOOMABLE clipping timeline: waveform + metadata + scrub -------
              A 24x7 channel can hold days of retained material, so the view is a
              zoom window over the recording rather than the whole thing squashed
              into one bar. The waveform shows where the content actually is, and
              the metadata lane turns "clip that item" into one click. */}
          {tl && view && <ClipTimeline
            domain={domain} spans={tl.spans} view={view} setView={setView}
            programmes={programmes} waveform={wave} waveLoading={waveBusy}
            from={selFrom} to={selTo} loaded={loaded} playheadMs={playheadMs} flash={flash}
            onChange={(f, t) => { setSelFrom(f); setSelTo(t) }}
            onSeek={(ms) => {
              const v = videoRef.current
              if (v && loaded && ms >= loaded.from && ms <= loaded.to) v.currentTime = (ms - loaded.from) / 1000
              else loadRange(ms, Math.max(ms + 60_000, selTo ?? ms + 60_000))
            }}
            onPickProgramme={(p) => {
              // trim to exactly this item and pre-fill the clip title from it
              setSelFrom(p.startMs); setSelTo(p.endMs)
              setFlash({ from: p.startMs, to: p.endMs })
              setTimeout(() => setFlash(null), 1600)
              if (!clipTitle.trim()) setClipTitle(p.title)
              jumpTo(p.startMs, p.endMs)
            }} />}

          {/* ------- marks + CLIP CREATION, right under the player ------- */}
          <div style={{ display: 'flex', gap: 12, alignItems: 'flex-end', margin: '10px 0 4px', flexWrap: 'wrap' }}>
            <RangeInput label="In" value={selFrom} min={domain.start} max={domain.end} onChange={v => setSelFrom(v)} />
            <RangeInput label="Out" value={selTo} min={domain.start} max={domain.end} onChange={v => setSelTo(v)} />
            <button className="btn ghost" disabled={!selOk} onClick={() => loadRange(selFrom!, selTo!)}>Load marks</button>
            <span style={{ flex: 1 }} />
            <div className="field" style={{ margin: 0, flex: '1 1 200px', maxWidth: 300 }}>
              <label>Clip title</label>
              <input className="inp" value={clipTitle} onChange={e => setClipTitle(e.target.value)} placeholder="e.g. Goal 73' — highlight" />
            </div>
            <div className="field" style={{ margin: 0 }}>
              <label>Output</label>
              <select className="inp" value={outputKind} onChange={e => setOutputKind(e.target.value as any)}>
                <option value="manifest">Streaming (HLS/DASH)</option>
                <option value="progressive">Downloadable MP4</option>
                <option value="both">Streaming + MP4</option>
              </select>
            </div>
            <button className="btn primary" disabled={busy === 'clip' || !selOk} onClick={createClip}>{busy === 'clip' ? 'Creating…' : 'Create clip'}</button>
          </div>
          <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginTop: 6 }}>
            <span style={{ flex: 1 }} />
            <button className="btn ghost" disabled={busy === 'publish' || rec.status === 'recording'} onClick={publishFull}
              title={rec.status === 'recording' ? 'Available when the recording closes' : 'Publish the whole recording as a VOD asset'}>
              {busy === 'publish' ? 'Publishing…' : 'Publish full VOD'}
            </button>
            {/* An audio recording downloads as audio: MP3, with the AAC (.m4a)
                offered beside it once the export exists. Video stays MP4. */}
            <button className="btn ghost" disabled={busy === 'download'} onClick={download}
              title={tl?.audioOnly ? 'Export the whole recording as an MP3 (an AAC .m4a is produced alongside)' : 'Export the whole recording as an MP4'}>
              {busy === 'download' ? '…' : tl?.audioOnly ? 'Download MP3' : 'Download MP4'}
            </button>
            {altDownloads.map(a => (
              <a key={a.format} className="btn ghost" href={a.url} download style={{ marginLeft: 6 }}>{a.label}</a>
            ))}
          </div>
          {actErr && <div className="err" style={{ marginTop: 8 }}>{actErr}</div>}
          {msg && <div style={{ color: 'var(--ok,#3fbf6f)', fontSize: 'var(--fs-body)', marginTop: 8 }}>{msg}</div>}

          {/* ------- clips already made from this recording -------
               Each row can open its SOURCES: the runs and segment ranges the
               clip was actually built from. Start and end times only say what
               was asked for; the chain says what was used, and whether the media
               behind it still exists. */}
          {vods.length > 0 && (
            <div style={{ marginTop: 14 }}>
              <table>
                <thead><tr><th>Title</th><th>Kind</th><th>Range</th><th>Duration</th><th>Sources</th><th>Output</th><th>Created</th><th></th></tr></thead>
                <tbody>
                  {vods.map(v => (
                    <Fragment key={v.id}>
                      <tr>
                        <td><b>{v.title || '—'}</b></td>
                        <td style={{ color: 'var(--muted)' }}>{v.kind === 'clip' ? 'Clip' : 'Full VOD'}</td>
                        <td style={{ color: 'var(--muted)' }}>{fmtClock(Number(v.start_epoch_ms))} → {fmtClock(Number(v.end_epoch_ms))}</td>
                        <td style={{ color: 'var(--muted)' }}>{v.duration_ms != null ? fmtDur(Number(v.duration_ms)) : '—'}</td>
                        <td style={{ color: 'var(--muted)' }}>{sourceSummary(v)}</td>
                        <td style={{ color: 'var(--muted)' }}>{v.output_kind || 'manifest'}</td>
                        <td style={{ color: 'var(--muted)' }}>{new Date(v.created_at).toLocaleString()}</td>
                        <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                          <button className="btn ghost" onClick={() => setOpenProv(openProv === v.id ? null : v.id)}>
                            {openProv === v.id ? 'Hide sources' : 'Sources'}
                          </button>
                          {v.kind === 'clip' && <button className="btn ghost" style={{ marginLeft: 6 }} onClick={() => jumpTo(Number(v.start_epoch_ms), Number(v.end_epoch_ms))}>Review</button>}
                        </td>
                      </tr>
                      {openProv === v.id && (
                        <tr>
                          <td colSpan={8} style={{ background: 'var(--panel-2)' }}>
                            <ClipProvenancePanel assetId={v.id} />
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </>
  )
}

/** Breadcrumb, matching Channels/Events/Radio — the platform navigates by
 *  breadcrumb, never by a floating back arrow. */
function BackRow({ onBack, name }: { onBack: () => void; name?: string }) {
  return (
    <div className="crumb" style={{ marginBottom: 8 }}>
      <span className="lnk" style={{ cursor: 'pointer', color: 'var(--brand)' }} {...pressable((e: any) => { ((onBack) as any)(e) })} data-a11y-click="">Recordings</span>
      {name && <>&nbsp;/&nbsp; <b style={{ color: 'var(--text)' }}>{name}</b></>}
    </div>
  )
}

function Kbd({ children }: { children: React.ReactNode }) {
  return <span style={{ border: '1px solid var(--border)', borderRadius: 4, padding: '1px 5px', fontFamily: 'ui-monospace,monospace', fontSize: 'var(--fs-micro)', margin: '0 1px' }}>{children}</span>
}

/* The zoomable clipping timeline (waveform + metadata lane + scrub bar)
   now lives in ../ClipTimeline.tsx, shared and self-contained. */

/* ------------------------------------------------------------ time input */
function RangeInput({ label, value, min, max, onChange }: {
  label: string; value: number | null; min: number; max: number
  onChange: (v: number) => void
}) {
  const [text, setText] = useState(value != null ? fmtClock(value) : '')
  useEffect(() => { setText(value != null ? fmtClock(value) : '') }, [value])
  function commit() {
    const m = text.trim().match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/)
    if (!m || value == null) { setText(value != null ? fmtClock(value) : ''); return }
    const d = new Date(value)
    d.setHours(Number(m[1]), Number(m[2]), Number(m[3] ?? 0), 0)
    onChange(Math.max(min, Math.min(max, d.getTime())))
  }
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
      <span style={{ color: 'var(--faint)', fontSize: 'var(--fs-sm)' }}>{label}</span>
      <input className="inp" style={{ width: 96, fontFamily: 'ui-monospace,monospace' }} value={text}
        onChange={e => setText(e.target.value)} onBlur={commit}
        onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }} />
    </div>
  )
}

/**
 * The one-line answer in the list: how many separate stretches of media went in.
 *
 * "1 block" is the ordinary case and says the clip is one continuous piece.
 * Anything more means it crosses a restart or a hole, which is the thing worth
 * seeing without opening the panel. An asset built before the chain was recorded
 * says so rather than reporting zero as though it were a fact.
 */
function sourceSummary(v: VodAssetRow): string {
  if (v.source_block_count == null) return 'not recorded'
  const parts = [`${v.source_block_count} block${v.source_block_count === 1 ? '' : 's'}`]
  if ((v.source_container_count ?? 0) > 1) parts.push(`${v.source_container_count} days`)
  else if ((v.source_run_count ?? 0) > 1) parts.push(`${v.source_run_count} runs`)
  return parts.join(' · ')
}
