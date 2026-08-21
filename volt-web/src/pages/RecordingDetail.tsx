import { useEffect, useMemo, useRef, useState } from 'react'
import { api, getToken, recordingRangeUrl, type RecordingRow, type RecordingTimeline, type VodAssetRow, type RecordingProgramme, type TranscriptSearch } from '../api'
import { SEC } from '../scaffold'

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
  const [msg, setMsg] = useState('')
  const [actErr, setActErr] = useState('')

  async function loadRec() {
    try { setRec(await api.recording(id)) } catch (e: any) { setErr(e.message) }
  }
  async function loadTl() {
    try { setTl(await api.recordingTimeline(id)) } catch (e: any) { setErr(e.message) }
  }
  useEffect(() => {
    loadRec(); loadTl()
    api.recordingProgrammes(id).then(r => setProgrammes(r.programmes)).catch(() => setProgrammes([]))
    api.recordingTranscript(id).then(r => setTsLangs(r.languages)).catch(() => setTsLangs([]))
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
      setMsg('Clip created — listed below and in the VOD library.')
      setClipTitle(''); loadRec()
    } catch (e: any) { setActErr(e.message) } finally { setBusy('') }
  }
  async function publishFull() {
    setActErr(''); setMsg(''); setBusy('publish')
    try { await api.publishRecording(id, rec?.title || undefined); setMsg('Recording published as a full VOD asset.'); loadRec() }
    catch (e: any) { setActErr(e.message) } finally { setBusy('') }
  }
  async function download() {
    setActErr(''); setMsg(''); setBusy('download')
    try {
      const r = await api.recordingDownload(id)
      if (r.status === 'ready' && r.url) window.open(r.url, '_blank')
      else setMsg('MP4 export is being prepared — check back shortly.')
    } catch (e: any) { setActErr(e.message) } finally { setBusy('') }
  }

  if (err) return (<><BackRow onBack={onBack} /><div className="err">{err}</div></>)
  if (!rec || !domain) return (<><BackRow onBack={onBack} /><div className="loading">Loading recording…</div></>)

  const vods = rec.vod_assets ?? []

  return (
    <>
      <BackRow onBack={onBack} />
      <div className="page-head" style={{ marginBottom: 10 }}>
        <div>
          <h1 style={{ display: 'flex', alignItems: 'baseline', gap: 10 }}>{rec.source_name || 'Recording'}
            <span style={{ fontSize: 13, fontWeight: 400, color: 'var(--faint)' }}>{KIND_LABEL[rec.kind] || rec.kind} · {fmtDate(domain.start)} {fmtClock(domain.start)} → {rec.end_epoch_ms != null ? fmtClock(domain.end) : 'recording…'}</span>
          </h1>
          <p>{rec.title || 'Scrub with the keyboard, mark the range, cut the clip.'}</p>
        </div>
        <div className="spacer" />
        <button className="btn ghost" onClick={() => { loadTl(); loadRec() }}>Refresh</button>
      </div>

      {tl && tl.spans.length === 0 ? (
        <div className="empty"><h3>No segments on disk</h3><p>Nothing is recorded for this entry (pruned by retention, or recording was off for the run).</p></div>
      ) : (
        <div className="card" style={{ padding: 18 }}>
          {/* ------- player + live transcript side panel ------- */}
          <div style={{ display: 'grid', gridTemplateColumns: tsLangs.length ? '1fr 330px' : '1fr', gap: 14, alignItems: 'stretch' }}>
            <div>
              <video ref={videoRef} controls playsInline
                style={{ width: '100%', height: '100%', maxHeight: 430, background: '#000', borderRadius: 10, border: '1px solid var(--border)', objectFit: 'contain' }} />
            </div>
            {tsLangs.length > 0 && (
              <div style={{ display: 'flex', flexDirection: 'column', border: '1px solid var(--border)', borderRadius: 10, overflow: 'hidden', maxHeight: 430 }}>
                <div style={{ display: 'flex', gap: 6, alignItems: 'center', padding: '8px 10px', borderBottom: '1px solid var(--border)', flex: 'none' }}>
                  <input className="inp ts-q" style={{ flex: 1, fontSize: 12.5, padding: '6px 9px' }} value={tsQ}
                    onChange={e => setTsQ(e.target.value)}
                    placeholder="Search subtitles… (all words, any order)" />
                  {tsLangs.length > 1 && (
                    <select className="inp" style={{ width: 64, fontSize: 12, padding: '6px 6px' }} value={tsLang} onChange={e => setTsLang(e.target.value)}>
                      <option value="">all</option>
                      {tsLangs.map(l => <option key={l} value={l}>{l}</option>)}
                    </select>
                  )}
                </div>
                <div ref={cueListRef} className="ts-hits" style={{ flex: 1, overflowY: 'auto' }}>
                  {cues.length === 0 ? (
                    <div style={{ padding: '12px 12px', color: 'var(--faint)', fontSize: 12.5 }}>
                      {tsQ.trim() ? `No spoken match for "${tsQ.trim()}".` : 'No subtitles in the loaded range.'}
                    </div>
                  ) : cues.map((m, i) => (
                    <div key={i} data-cue={i} onClick={() => jumpToCue(m)}
                      style={{ display: 'flex', gap: 8, alignItems: 'baseline', padding: '6px 10px', cursor: 'pointer',
                        borderLeft: i === activeCue ? '3px solid var(--brand)' : '3px solid transparent',
                        background: i === activeCue ? 'rgba(120,140,255,.12)' : 'transparent' }}>
                      <span style={{ fontFamily: 'ui-monospace,monospace', fontSize: 11, color: 'var(--brand)', flex: 'none' }}>{fmtClock(m.tMs)}</span>
                      <span style={{ fontSize: 12.5, flex: 1, color: i === activeCue ? 'var(--text,#fff)' : 'var(--muted)' }}>{m.text}</span>
                    </div>
                  ))}
                </div>
                <div style={{ padding: '5px 10px', borderTop: '1px solid var(--border)', fontSize: 10.5, color: 'var(--faint)', flex: 'none' }}>
                  {tsMode === 'search' ? `${cues.length} match(es) across the recording — click to jump` : 'live transcript — click a line to jump there'}
                </div>
              </div>
            )}
          </div>
          {playerErr && <div className="err" style={{ marginTop: 6 }}>{playerErr}</div>}
          <div style={{ display: 'flex', alignItems: 'center', gap: 14, margin: '8px 0 12px', flexWrap: 'wrap' }}>
            <span style={{ fontFamily: 'ui-monospace,monospace', fontSize: 13 }}>
              <span style={{ color: 'var(--faint)' }}>Position </span>{playheadMs != null ? fmtClock(playheadMs) : '—'}
            </span>
            <span style={{ fontFamily: 'ui-monospace,monospace', fontSize: 13 }}>
              <span style={{ color: 'var(--faint)' }}>In </span>{selFrom != null ? fmtClock(selFrom) : '—'}
              <span style={{ color: 'var(--faint)' }}> Out </span>{selTo != null ? fmtClock(selTo) : '—'}
              {selOk && <span style={{ color: 'var(--muted)' }}> ({fmtDur(selTo! - selFrom!)}{coveredMs < (selTo! - selFrom!) - 1500 ? `, ${fmtDur(coveredMs)} recorded` : ''})</span>}
            </span>
            <span style={{ flex: 1 }} />
            <span style={{ fontSize: 11, color: 'var(--faint)' }}>
              <Kbd>space</Kbd> play/pause · <Kbd>←</Kbd><Kbd>→</Kbd> 10s · <Kbd>&lt;</Kbd><Kbd>&gt;</Kbd> frame · <Kbd>I</Kbd> in · <Kbd>O</Kbd> out
            </span>
          </div>

          {/* ------- timeline: coverage + loaded range + marks + playhead ------- */}
          {tl && <TimelineBar domain={domain} spans={tl.spans} from={selFrom} to={selTo}
            loaded={loaded} playheadMs={playheadMs} flash={flash}
            onChange={(f, t) => { setSelFrom(f); setSelTo(t) }}
            onSeek={(ms) => {
              const v = videoRef.current
              if (v && loaded && ms >= loaded.from && ms <= loaded.to) v.currentTime = (ms - loaded.from) / 1000
              else loadRange(ms, Math.max(ms + 60_000, selTo ?? ms + 60_000))
            }} />}
          {programmes.length > 0 && <ProgrammeLane domain={domain} programmes={programmes} onPick={p => jumpTo(p.startMs, p.endMs)} />}

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
            <button className="btn ghost" disabled={busy === 'download'} onClick={download}>{busy === 'download' ? '…' : 'Download MP4'}</button>
          </div>
          {actErr && <div className="err" style={{ marginTop: 8 }}>{actErr}</div>}
          {msg && <div style={{ color: 'var(--ok,#3fbf6f)', fontSize: 13, marginTop: 8 }}>{msg}</div>}

          {/* ------- clips already made from this recording ------- */}
          {vods.length > 0 && (
            <div style={{ marginTop: 14 }}>
              <table>
                <thead><tr><th>Title</th><th>Kind</th><th>Range</th><th>Duration</th><th>Output</th><th>Created</th><th></th></tr></thead>
                <tbody>
                  {vods.map(v => (
                    <tr key={v.id}>
                      <td><b>{v.title || '—'}</b></td>
                      <td style={{ color: 'var(--muted)' }}>{v.kind === 'clip' ? 'Clip' : 'Full VOD'}</td>
                      <td style={{ color: 'var(--muted)' }}>{fmtClock(Number(v.start_epoch_ms))} → {fmtClock(Number(v.end_epoch_ms))}</td>
                      <td style={{ color: 'var(--muted)' }}>{v.duration_ms != null ? fmtDur(Number(v.duration_ms)) : '—'}</td>
                      <td style={{ color: 'var(--muted)' }}>{v.output_kind || 'manifest'}</td>
                      <td style={{ color: 'var(--muted)' }}>{new Date(v.created_at).toLocaleString()}</td>
                      <td style={{ textAlign: 'right' }}>
                        {v.kind === 'clip' && <button className="btn ghost" onClick={() => jumpTo(Number(v.start_epoch_ms), Number(v.end_epoch_ms))}>Review</button>}
                      </td>
                    </tr>
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

function BackRow({ onBack }: { onBack: () => void }) {
  return (
    <div style={{ marginBottom: 10 }}>
      <button className="btn ghost" onClick={onBack}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ width: 14 }}><path d="M19 12H5M12 19l-7-7 7-7" /></svg>
        Recordings
      </button>
    </div>
  )
}

function Kbd({ children }: { children: React.ReactNode }) {
  return <span style={{ border: '1px solid var(--border)', borderRadius: 4, padding: '1px 5px', fontFamily: 'ui-monospace,monospace', fontSize: 10, margin: '0 1px' }}>{children}</span>
}

/* --------------------------------------------------------------- timeline */
/** Coverage bar with trim marks, the loaded player range, and the playhead.
 *  Drag = set marks; click (no drag) = seek the playhead. */
function TimelineBar({ domain, spans, from, to, loaded, playheadMs, flash, onChange, onSeek }: {
  domain: { start: number; end: number }
  spans: { runId: string; startMs: number; endMs: number }[]
  from: number | null; to: number | null
  loaded: { from: number; to: number } | null
  playheadMs: number | null
  flash?: { from: number; to: number } | null
  onChange: (from: number, to: number) => void
  onSeek: (ms: number) => void
}) {
  const barRef = useRef<HTMLDivElement | null>(null)
  const drag = useRef<{ mode: 'new' | 'from' | 'to'; anchor: number; startX: number; moved: boolean } | null>(null)
  const W = domain.end - domain.start
  const pct = (ms: number) => `${Math.max(0, Math.min(100, ((ms - domain.start) / W) * 100))}%`
  const msAt = (clientX: number) => {
    const el = barRef.current!; const r = el.getBoundingClientRect()
    const f = Math.max(0, Math.min(1, (clientX - r.left) / r.width))
    return domain.start + f * W
  }
  function down(e: React.PointerEvent, mode: 'new' | 'from' | 'to') {
    e.preventDefault(); (e.target as Element).setPointerCapture?.(e.pointerId)
    const at = msAt(e.clientX)
    drag.current = { mode, anchor: mode === 'new' ? at : (mode === 'from' ? (to ?? at) : (from ?? at)), startX: e.clientX, moved: false }
  }
  function move(e: React.PointerEvent) {
    if (!drag.current) return
    if (Math.abs(e.clientX - drag.current.startX) > 3) drag.current.moved = true
    if (!drag.current.moved) return
    const at = msAt(e.clientX); const a = drag.current.anchor
    onChange(Math.min(a, at), Math.max(a, at))
  }
  function up(e: React.PointerEvent) {
    if (drag.current && !drag.current.moved && drag.current.mode === 'new') onSeek(msAt(e.clientX))
    drag.current = null
  }

  return (
    <div>
      <div ref={barRef} className="rec-timeline" onPointerDown={e => down(e, 'new')} onPointerMove={move} onPointerUp={up}
        style={{ position: 'relative', height: 44, background: '#0b0f16', border: '1px solid var(--border)', borderRadius: 8, cursor: 'crosshair', userSelect: 'none', touchAction: 'none' }}>
        {loaded && (
          <div style={{ position: 'absolute', top: 0, bottom: 0, left: pct(loaded.from), width: `calc(${pct(loaded.to)} - ${pct(loaded.from)})`, background: 'rgba(120,150,255,.07)', borderLeft: '1px dashed rgba(120,150,255,.4)', borderRight: '1px dashed rgba(120,150,255,.4)', pointerEvents: 'none' }} />
        )}
        {spans.map(s => (
          <div key={s.runId} title={`${fmtClock(s.startMs)} → ${fmtClock(s.endMs)}`}
            style={{ position: 'absolute', top: 6, bottom: 6, left: pct(s.startMs), width: `calc(${pct(s.endMs)} - ${pct(s.startMs)})`, background: 'rgba(120,150,255,.35)', borderRadius: 4, minWidth: 2, pointerEvents: 'none' }} />
        ))}
        {from != null && to != null && to > from && (
          <>
            <div style={{ position: 'absolute', top: 0, bottom: 0, left: pct(from), width: `calc(${pct(to)} - ${pct(from)})`, background: 'rgba(90,220,150,.18)', border: '1px solid rgba(90,220,150,.7)', borderRadius: 6, pointerEvents: 'none' }} />
            <div onPointerDown={e => { e.stopPropagation(); down(e, 'from') }} onPointerMove={move} onPointerUp={up}
              style={{ position: 'absolute', top: -2, bottom: -2, left: pct(from), width: 10, marginLeft: -5, cursor: 'ew-resize', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <div style={{ width: 4, height: '100%', background: 'rgba(90,220,150,.95)', borderRadius: 2 }} />
            </div>
            <div onPointerDown={e => { e.stopPropagation(); down(e, 'to') }} onPointerMove={move} onPointerUp={up}
              style={{ position: 'absolute', top: -2, bottom: -2, left: pct(to), width: 10, marginLeft: -5, cursor: 'ew-resize', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <div style={{ width: 4, height: '100%', background: 'rgba(90,220,150,.95)', borderRadius: 2 }} />
            </div>
          </>
        )}
        {flash && (
          <div style={{ position: 'absolute', top: 2, bottom: 2, left: pct(flash.from),
            width: `max(3px, calc(${pct(flash.to)} - ${pct(flash.from)}))`,
            background: 'rgba(255,200,80,.55)', border: '1px solid rgba(255,210,110,.9)', borderRadius: 4,
            pointerEvents: 'none', transition: 'opacity .4s', animation: 'pulse 1.2s ease-in-out infinite' }} />
        )}
        {playheadMs != null && (
          <div style={{ position: 'absolute', top: -3, bottom: -3, left: pct(playheadMs), width: 2, marginLeft: -1, background: '#fff', boxShadow: '0 0 6px rgba(255,255,255,.6)', pointerEvents: 'none' }} />
        )}
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', color: 'var(--faint)', fontSize: 11, marginTop: 4 }}>
        <span>{fmtDate(domain.start)} {fmtClock(domain.start)}</span>
        <span>filled = recorded · green = marks · white = playhead · click to seek, drag to mark</span>
        <span>{fmtClock(domain.end)}</span>
      </div>
    </div>
  )
}

/* --------------------------------------------------------- programme lane */
function ProgrammeLane({ domain, programmes, onPick }: {
  domain: { start: number; end: number }
  programmes: RecordingProgramme[]
  onPick: (p: RecordingProgramme) => void
}) {
  const W = domain.end - domain.start
  const pct = (ms: number) => Math.max(0, Math.min(100, ((ms - domain.start) / W) * 100))
  return (
    <div className="prog-lane" style={{ position: 'relative', height: 26, marginTop: 4 }}>
      {programmes.map(p => {
        const l = pct(p.startMs), r = pct(p.endMs)
        if (r <= l) return null
        return (
          <div key={p.id} onClick={() => onPick(p)}
            title={`${p.title} · ${fmtClock(p.startMs)} → ${fmtClock(p.endMs)}${p.asRun ? ' (as run)' : ' (scheduled)'}`}
            style={{ position: 'absolute', top: 2, bottom: 2, left: `${l}%`, width: `${Math.max(r - l, 0.6)}%`,
              background: 'rgba(200,160,60,.22)', border: '1px solid rgba(220,180,80,.55)', borderRadius: 5,
              cursor: 'pointer', overflow: 'hidden', display: 'flex', alignItems: 'center', padding: '0 6px' }}>
            <span style={{ fontSize: 10.5, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', color: 'var(--muted)' }}>{p.title}</span>
          </div>
        )
      })}
    </div>
  )
}

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
      <span style={{ color: 'var(--faint)', fontSize: 12 }}>{label}</span>
      <input className="inp" style={{ width: 96, fontFamily: 'ui-monospace,monospace' }} value={text}
        onChange={e => setText(e.target.value)} onBlur={commit}
        onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }} />
    </div>
  )
}
