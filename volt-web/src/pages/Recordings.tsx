import { useEffect, useMemo, useRef, useState } from 'react'
import { api, getToken, recordingRangeUrl, type RecordingRow, type RecordingTimeline, type VodAssetRow, type RecordingProgramme, type TranscriptSearch } from '../api'
import { PageHead, FChip, EntityCell, StatusTag } from '../scaffold'

/* ============================================================================
   Recordings — review what was captured, pick a range, preview it, and turn it
   into clips / VOD assets / downloads.

   The timeline shows the REAL on-disk coverage (per-run spans from the local
   segment index), so gaps from restarts are visible instead of silently
   collapsed. The selected range plays through the range-manifest endpoint
   (VOD playlist spanning runs with DISCONTINUITY + per-run MAP), which is the
   exact same addressing a clip uses — what you preview is what you cut.
   ========================================================================== */

const fmtClock = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
const fmtDate = (ms: number) => new Date(ms).toLocaleDateString([], { day: '2-digit', month: 'short' })
function fmtDur(ms: number) {
  const s = Math.max(0, Math.round(ms / 1000))
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), ss = s % 60
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(ss).padStart(2, '0')}` : `${m}:${String(ss).padStart(2, '0')}`
}
const KIND_LABEL: Record<string, string> = { event: 'Event', channel_day: 'Channel day' }

const MATCH_LABEL: Record<string, string> = { title: 'name match', programme: 'EPG match', transcript: 'spoken match' }

export default function Recordings() {
  const [rows, setRows] = useState<RecordingRow[] | null>(null)
  const [err, setErr] = useState('')
  const [openId, setOpenId] = useState<string | null>(null)
  const [kindFilter, setKindFilter] = useState<'all' | 'event' | 'channel_day'>('all')
  const [q, setQ] = useState('')

  async function load(searchQ = q) {
    try {
      setRows(await api.recordings(searchQ.trim() ? { q: searchQ.trim() } : {}))
    } catch (e: any) { setErr(e.message) }
  }
  useEffect(() => { load() /* eslint-disable-next-line */ }, [])
  // debounced content search: matches recording names, EPG programme titles that
  // aired inside a recording, and the words spoken (transcript)
  useEffect(() => {
    const t = setTimeout(() => { load() }, 350)
    return () => clearTimeout(t)
    /* eslint-disable-next-line */
  }, [q])

  const open = rows?.find(r => r.id === openId) || null
  const counts = useMemo(() => {
    const c = rows || []
    return {
      all: c.length,
      event: c.filter(r => r.kind === 'event').length,
      channel_day: c.filter(r => r.kind === 'channel_day').length,
    }
  }, [rows])
  const shown = useMemo(() => {
    if (!rows) return []
    return kindFilter === 'all' ? rows : rows.filter(r => r.kind === kindFilter)
  }, [rows, kindFilter])

  return (
    <>
      <PageHead title="Recordings" sub="Review captures, select a range, preview it, and create clips or VOD assets." />
      {err && <div className="err">{err}</div>}
      {rows === null ? (
        <div className="loading">Loading recordings…</div>
      ) : rows.length === 0 && !q.trim() ? (
        <div className="empty">
          <div className="ic"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="9" /><circle cx="12" cy="12" r="3" /></svg></div>
          <h3>No recordings yet</h3>
          <p>Recordings appear here when a channel or event runs with recording enabled (the toggle in its settings). The live segments are kept per run and become the recording.</p>
        </div>
      ) : (
        <>
          <div className="filters">
            <FChip label="All" n={counts.all} on={kindFilter === 'all'} onClick={() => setKindFilter('all')} />
            <FChip label="Events" n={counts.event} on={kindFilter === 'event'} onClick={() => setKindFilter('event')} />
            <FChip label="Channel days" n={counts.channel_day} on={kindFilter === 'channel_day'} onClick={() => setKindFilter('channel_day')} />
            <input className="inp rec-search" style={{ width: 300, marginLeft: 'auto' }} value={q} onChange={e => setQ(e.target.value)}
              placeholder="Search names, EPG programmes, spoken words…" />
          </div>
          <div className="card">
            <table>
              <thead><tr><th>Recording</th><th>Kind</th><th>Window</th><th>Duration</th><th>Status</th><th>Assets</th><th></th></tr></thead>
              <tbody>
                {shown.map((r, i) => {
                  const start = Number(r.start_epoch_ms)
                  const end = r.end_epoch_ms != null ? Number(r.end_epoch_ms) : null
                  const live = r.status === 'recording'
                  return (
                    <tr key={r.id} onClick={() => setOpenId(openId === r.id ? null : r.id)} style={{ cursor: 'pointer', background: openId === r.id ? 'rgba(120,140,255,.06)' : undefined }}>
                      <td><EntityCell name={r.source_name || 'Recording'} sub={r.title || undefined} index={i} /></td>
                      <td>
                        <span className={`tag type ${r.kind === 'event' ? 'event' : 'chan'}`}>{KIND_LABEL[r.kind] || r.kind}</span>
                        {r.matched_by && <div style={{ fontSize: 10, color: 'var(--brand)', marginTop: 3 }}>{MATCH_LABEL[r.matched_by] || r.matched_by}</div>}
                      </td>
                      <td style={{ color: 'var(--muted)' }}>{fmtDate(start)} {fmtClock(start)} → {end != null ? fmtClock(end) : '…'}</td>
                      <td style={{ color: 'var(--muted)' }}>{end != null ? fmtDur(end - start) : fmtDur(Date.now() - start)}</td>
                      <td>{live ? <StatusTag label="Recording" cls="live" /> : <StatusTag label="Closed" cls="idle" />}</td>
                      <td style={{ color: 'var(--muted)' }}>{r.vod_count ? `${r.vod_count} VOD` : '—'}</td>
                      <td style={{ textAlign: 'right' }} onClick={e => e.stopPropagation()}>
                        <button className={`btn ${openId === r.id ? 'ghost' : 'primary'}`} onClick={() => setOpenId(openId === r.id ? null : r.id)}>{openId === r.id ? 'Close' : 'Open'}</button>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </>
      )}
      {open && <RecordingWorkbench key={open.id} rec={open} initialQuery={q} onChanged={() => load()} />}
    </>
  )
}

/* ------------------------------------------------------------- workbench */
function RecordingWorkbench({ rec, initialQuery, onChanged }: { rec: RecordingRow; initialQuery?: string; onChanged: () => void }) {
  const [tl, setTl] = useState<RecordingTimeline | null>(null)
  const [tlErr, setTlErr] = useState('')
  const [vods, setVods] = useState<VodAssetRow[] | null>(null)
  // content-aware navigation: what was ON AIR (EPG) and what was SAID (transcript)
  const [programmes, setProgrammes] = useState<RecordingProgramme[]>([])
  const [tsLangs, setTsLangs] = useState<string[]>([])
  const [tsQ, setTsQ] = useState(initialQuery || '')
  const [tsLang, setTsLang] = useState('')
  const [tsRes, setTsRes] = useState<TranscriptSearch | null>(null)
  const [tsBusy, setTsBusy] = useState(false)
  // selection (wall-clock ms)
  const [selFrom, setSelFrom] = useState<number | null>(null)
  const [selTo, setSelTo] = useState<number | null>(null)
  const [playUrl, setPlayUrl] = useState<string | null>(null)
  const [clipTitle, setClipTitle] = useState('')
  const [outputKind, setOutputKind] = useState<'manifest' | 'progressive' | 'both'>('manifest')
  const [busy, setBusy] = useState('')
  const [msg, setMsg] = useState('')
  const [actErr, setActErr] = useState('')

  async function loadTl() {
    setTlErr('')
    try {
      const t = await api.recordingTimeline(rec.id)
      setTl(t)
      if (t.spans.length && selFrom == null) {
        // default selection: the last span (most recent material), capped to 5 min
        const s = t.spans[t.spans.length - 1]
        setSelFrom(Math.max(s.startMs, s.endMs - 5 * 60_000)); setSelTo(s.endMs)
      }
    } catch (e: any) { setTlErr(e.message) }
  }
  async function loadVods() {
    try { setVods((await api.recording(rec.id)).vod_assets) } catch { setVods([]) }
  }
  useEffect(() => {
    loadTl(); loadVods()
    api.recordingProgrammes(rec.id).then(r => setProgrammes(r.programmes)).catch(() => setProgrammes([]))
    api.recordingTranscript(rec.id).then(r => setTsLangs(r.languages)).catch(() => setTsLangs([]))
    /* eslint-disable-next-line */
  }, [rec.id])

  async function searchTs(query = tsQ) {
    if (!query.trim()) { setTsRes(null); return }
    setTsBusy(true)
    try { setTsRes(await api.recordingTranscript(rec.id, { q: query.trim(), lang: tsLang || undefined })) }
    catch { setTsRes(null) } finally { setTsBusy(false) }
  }
  // list search term carries into the workbench so a "spoken match" hit lands
  // ready to locate: run it once when transcripts exist
  useEffect(() => {
    if (initialQuery?.trim() && tsLangs.length) searchTs(initialQuery)
    /* eslint-disable-next-line */
  }, [tsLangs.length])

  const domain = useMemo(() => {
    const start = Number(rec.start_epoch_ms)
    const end = rec.end_epoch_ms != null ? Number(rec.end_epoch_ms)
      : (tl?.spans.length ? tl.spans[tl.spans.length - 1].endMs : Date.now())
    return { start, end: Math.max(end, start + 1) }
  }, [rec, tl])

  const selOk = selFrom != null && selTo != null && selTo > selFrom
  const coveredMs = useMemo(() => {
    if (!tl || !selOk) return 0
    return tl.spans.reduce((a, s) => a + Math.max(0, Math.min(s.endMs, selTo!) - Math.max(s.startMs, selFrom!)), 0)
  }, [tl, selFrom, selTo, selOk])

  function preview() {
    if (!selOk) return
    setPlayUrl(recordingRangeUrl(rec.id, selFrom!, selTo!))
  }
  /** Jump the range picker to a moment/slice and start playing it. */
  function jumpTo(fromMs: number, toMs: number) {
    const f = Math.max(domain.start, Math.min(fromMs, domain.end - 1000))
    const t = Math.min(domain.end, Math.max(toMs, f + 1000))
    setSelFrom(f); setSelTo(t)
    setPlayUrl(recordingRangeUrl(rec.id, f, t))
  }
  async function createClip() {
    if (!selOk) { setActErr('Select a range first'); return }
    if (!clipTitle.trim()) { setActErr('Give the clip a title'); return }
    setActErr(''); setMsg(''); setBusy('clip')
    try {
      await api.clipRecording(rec.id, { title: clipTitle.trim(), startMs: Math.round(selFrom!), endMs: Math.round(selTo!), outputKind })
      setMsg('Clip created — it is listed under assets below and in the VOD library.')
      setClipTitle(''); loadVods(); onChanged()
    } catch (e: any) { setActErr(e.message) } finally { setBusy('') }
  }
  async function publishFull() {
    setActErr(''); setMsg(''); setBusy('publish')
    try {
      await api.publishRecording(rec.id, rec.title || undefined)
      setMsg('Recording published as a full VOD asset.')
      loadVods(); onChanged()
    } catch (e: any) { setActErr(e.message) } finally { setBusy('') }
  }
  async function download() {
    setActErr(''); setMsg(''); setBusy('download')
    try {
      const r = await api.recordingDownload(rec.id)
      if (r.status === 'ready' && r.url) window.open(r.url, '_blank')
      else setMsg('MP4 export is being prepared — check back shortly.')
    } catch (e: any) { setActErr(e.message) } finally { setBusy('') }
  }

  return (
    <div className="card" style={{ marginTop: 14, padding: 18 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginBottom: 10 }}>
        <h2 style={{ margin: 0, fontSize: 17 }}>{rec.source_name || 'Recording'}</h2>
        <span style={{ color: 'var(--faint)', fontSize: 13 }}>{KIND_LABEL[rec.kind] || rec.kind} · {fmtDate(domain.start)} {fmtClock(domain.start)} → {rec.end_epoch_ms != null ? fmtClock(domain.end) : 'recording…'}</span>
        <span style={{ flex: 1 }} />
        <button className="btn ghost" onClick={() => { loadTl(); loadVods() }}>Refresh</button>
      </div>

      {tlErr && <div className="err">{tlErr}</div>}
      {tl && tl.spans.length === 0 && (
        <div style={{ color: 'var(--warn)', fontSize: 13, marginBottom: 10 }}>
          No recorded segments are on disk for this recording (they may have been pruned by retention, or recording was off for this run).
        </div>
      )}
      {tl && tl.spans.length > 0 && (
        <>
          <TimelineBar domain={domain} spans={tl.spans} from={selFrom} to={selTo}
            onChange={(f, t) => { setSelFrom(f); setSelTo(t); setPlayUrl(null) }} />
          {programmes.length > 0 && (
            <ProgrammeLane domain={domain} programmes={programmes} onPick={p => jumpTo(p.startMs, p.endMs)} />
          )}
          <div style={{ display: 'flex', gap: 14, alignItems: 'center', margin: '10px 0 14px', flexWrap: 'wrap' }}>
            <RangeInput label="From" value={selFrom} min={domain.start} max={domain.end} onChange={v => { setSelFrom(v); setPlayUrl(null) }} />
            <RangeInput label="To" value={selTo} min={domain.start} max={domain.end} onChange={v => { setSelTo(v); setPlayUrl(null) }} />
            {selOk && <span style={{ color: 'var(--muted)', fontSize: 13 }}>
              {fmtDur(selTo! - selFrom!)} selected{coveredMs < (selTo! - selFrom!) - 1500 ? ` · ${fmtDur(coveredMs)} recorded (rest is gap)` : ''}
            </span>}
            <span style={{ flex: 1 }} />
            <button className="btn primary" disabled={!selOk} onClick={preview}>Preview range</button>
          </div>
          {playUrl && <RangePlayer url={playUrl} />}

          {tsLangs.length > 0 && (
            <div style={{ borderTop: '1px solid var(--border)', margin: '14px 0 0', paddingTop: 14 }}>
              <div style={{ fontSize: 12, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.06em', color: 'var(--faint)', marginBottom: 6 }}>
                Find in transcript <span style={{ fontWeight: 400, textTransform: 'none', letterSpacing: 0 }}>— search what was said; click a hit to jump there and clip it</span>
              </div>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                <input className="inp ts-q" style={{ flex: '1 1 260px' }} value={tsQ}
                  onChange={e => setTsQ(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter') searchTs() }}
                  placeholder='e.g. "interest rates" — all words, any order' />
                {tsLangs.length > 1 && (
                  <select className="inp" style={{ width: 130 }} value={tsLang} onChange={e => setTsLang(e.target.value)}>
                    <option value="">all languages</option>
                    {tsLangs.map(l => <option key={l} value={l}>{l}</option>)}
                  </select>
                )}
                <button className="btn primary" disabled={tsBusy || !tsQ.trim()} onClick={() => searchTs()}>{tsBusy ? 'Searching…' : 'Search'}</button>
              </div>
              {tsRes && (
                tsRes.matches.length === 0
                  ? <div style={{ color: 'var(--faint)', fontSize: 13, marginTop: 8 }}>No spoken match for "{tsQ.trim()}" in this recording ({tsRes.entries} transcript lines checked).</div>
                  : (
                    <div className="ts-hits" style={{ marginTop: 8, maxHeight: 260, overflowY: 'auto', border: '1px solid var(--border)', borderRadius: 8 }}>
                      {tsRes.matches.map((m, i) => (
                        <div key={i} onClick={() => jumpTo(m.tMs - 5000, m.endMs + 10000)}
                          style={{ display: 'flex', gap: 10, alignItems: 'baseline', padding: '8px 12px', cursor: 'pointer', borderTop: i ? '1px solid var(--border)' : 'none' }}>
                          <span style={{ fontFamily: 'ui-monospace,monospace', fontSize: 12, color: 'var(--brand)', flex: 'none' }}>{fmtClock(m.tMs)}</span>
                          <span style={{ fontSize: 10, color: 'var(--faint)', textTransform: 'uppercase', flex: 'none', width: 24 }}>{m.lang}</span>
                          <span style={{ fontSize: 13, flex: 1 }}>{m.text}</span>
                          {m.approx && <span style={{ fontSize: 10, color: 'var(--faint)', flex: 'none' }} title="Placed from subtitle file times; accurate to a few seconds">~approx</span>}
                        </div>
                      ))}
                    </div>
                  )
              )}
            </div>
          )}

          <div style={{ borderTop: '1px solid var(--border)', margin: '14px 0', paddingTop: 14, display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'flex-end' }}>
            <div className="field" style={{ margin: 0, flex: '1 1 220px' }}>
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
            <button className="btn primary" disabled={busy === 'clip' || !selOk} onClick={createClip}>{busy === 'clip' ? 'Creating…' : 'Create clip from range'}</button>
            <button className="btn ghost" disabled={busy === 'publish' || rec.status === 'recording'} onClick={publishFull}
              title={rec.status === 'recording' ? 'Available when the recording closes' : 'Publish the whole recording as a VOD asset'}>
              {busy === 'publish' ? 'Publishing…' : 'Publish full VOD'}
            </button>
            <button className="btn ghost" disabled={busy === 'download'} onClick={download}>{busy === 'download' ? '…' : 'Download MP4'}</button>
          </div>
          {actErr && <div className="err">{actErr}</div>}
          {msg && <div style={{ color: 'var(--ok,#3fbf6f)', fontSize: 13 }}>{msg}</div>}
        </>
      )}

      {vods && vods.length > 0 && (
        <div style={{ marginTop: 14 }}>
          <div style={{ fontSize: 12, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.06em', color: 'var(--faint)', marginBottom: 6 }}>Assets from this recording</div>
          <table className="table">
            <thead><tr><th>Title</th><th>Kind</th><th>Range</th><th>Duration</th><th>Output</th><th>Created</th></tr></thead>
            <tbody>
              {vods.map(v => (
                <tr key={v.id}>
                  <td><b>{v.title || '—'}</b></td>
                  <td style={{ color: 'var(--muted)' }}>{v.kind === 'clip' ? 'Clip' : 'Full VOD'}</td>
                  <td style={{ color: 'var(--muted)' }}>{fmtClock(Number(v.start_epoch_ms))} → {fmtClock(Number(v.end_epoch_ms))}</td>
                  <td style={{ color: 'var(--muted)' }}>{v.duration_ms != null ? fmtDur(Number(v.duration_ms)) : '—'}</td>
                  <td style={{ color: 'var(--muted)' }}>{v.output_kind || 'manifest'}</td>
                  <td style={{ color: 'var(--muted)' }}>{new Date(v.created_at).toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

/* --------------------------------------------------------------- timeline */
/** Coverage bar with a draggable selection. Spans = recorded material; the dark
 *  parts are gaps (channel stopped / retention pruned). Drag on empty area to
 *  select fresh; drag a handle to adjust an edge. */
function TimelineBar({ domain, spans, from, to, onChange }: {
  domain: { start: number; end: number }
  spans: { runId: string; startMs: number; endMs: number }[]
  from: number | null; to: number | null
  onChange: (from: number, to: number) => void
}) {
  const barRef = useRef<HTMLDivElement | null>(null)
  const drag = useRef<{ mode: 'new' | 'from' | 'to'; anchor: number } | null>(null)
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
    drag.current = { mode, anchor: mode === 'new' ? at : (mode === 'from' ? (to ?? at) : (from ?? at)) }
    if (mode === 'new') onChange(at, at)
  }
  function move(e: React.PointerEvent) {
    if (!drag.current) return
    const at = msAt(e.clientX); const a = drag.current.anchor
    onChange(Math.min(a, at), Math.max(a, at))
  }
  function up() { drag.current = null }

  return (
    <div>
      <div ref={barRef} className="rec-timeline" onPointerDown={e => down(e, 'new')} onPointerMove={move} onPointerUp={up}
        style={{ position: 'relative', height: 44, background: '#0b0f16', border: '1px solid var(--border)', borderRadius: 8, cursor: 'crosshair', userSelect: 'none', touchAction: 'none' }}>
        {spans.map(s => (
          <div key={s.runId} title={`${fmtClock(s.startMs)} → ${fmtClock(s.endMs)}`}
            style={{ position: 'absolute', top: 6, bottom: 6, left: pct(s.startMs), width: `calc(${pct(s.endMs)} - ${pct(s.startMs)})`, background: 'rgba(120,150,255,.35)', borderRadius: 4, minWidth: 2 }} />
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
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', color: 'var(--faint)', fontSize: 11, marginTop: 4 }}>
        <span>{fmtDate(domain.start)} {fmtClock(domain.start)}</span>
        <span>filled = recorded · dark = gap · drag to select</span>
        <span>{fmtClock(domain.end)}</span>
      </div>
    </div>
  )
}

/** EPG lane under the coverage bar: the programmes that AIRED inside this
 *  recording, positioned on the same time axis. Click one to snap the range
 *  picker to its slice (as-run times when observed) and start playback. */
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

/** Wall-clock time input for a selection edge (HH:MM:SS local time within the
 *  recording's day; typing adjusts the ms value). */
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
    const v = Math.max(min, Math.min(max, d.getTime()))
    onChange(v)
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

/* ----------------------------------------------------------------- player */
/** VOD player for the selected range. The master + media playlists live under
 *  /api (bearer via xhrSetup); the segments they reference are public /origin
 *  paths, so no header is attached there. */
function RangePlayer({ url }: { url: string }) {
  const ref = useRef<HTMLVideoElement | null>(null)
  const [err, setErr] = useState('')
  useEffect(() => {
    let cancelled = false; let hls: any
    const v = ref.current; if (!v) return
    setErr('')
    ;(async () => {
      const Hls = (await import('hls.js')).default
      if (cancelled) return
      if (Hls.isSupported()) {
        hls = new Hls({
          // hls.js invokes xhrSetup BEFORE xhr.open, and headers can only be set on
          // an opened request — so open it ourselves, then attach the bearer for the
          // /api playlists (the /origin segments stay header-free and cacheable).
          xhrSetup: (xhr: XMLHttpRequest, u: string) => {
            try {
              if (new URL(u, window.location.href).pathname.startsWith('/api/')) {
                xhr.open('GET', u, true)
                xhr.setRequestHeader('authorization', `Bearer ${getToken()}`)
              }
            } catch {}
          },
        })
        hls.loadSource(url); hls.attachMedia(v)
        hls.on(Hls.Events.MANIFEST_PARSED, () => { v.play().catch(() => {}) })
        let mediaRecoveries = 0
        hls.on(Hls.Events.ERROR, (_e: any, data: any) => {
          if (!data.fatal) return
          // recoverMediaError retries the append; cap it so an undecodable stream
          // surfaces an error instead of refetching the same segment forever.
          if (data.type === Hls.ErrorTypes.MEDIA_ERROR && mediaRecoveries < 3) {
            mediaRecoveries++; try { hls.recoverMediaError() } catch {}
            return
          }
          setErr('Playback failed: ' + (data.details || data.type))
          try { hls.stopLoad() } catch {}
        })
      } else if (v.canPlayType('application/vnd.apple.mpegurl')) {
        v.src = url; v.play().catch(() => {})
      } else setErr('HLS is not supported in this browser')
    })()
    return () => { cancelled = true; try { hls?.destroy() } catch {} }
  }, [url])
  return (
    <div style={{ marginTop: 4 }}>
      <video ref={ref} controls playsInline style={{ width: '100%', maxHeight: 420, background: '#000', borderRadius: 10, border: '1px solid var(--border)' }} />
      {err && <div className="err" style={{ marginTop: 6 }}>{err}</div>}
    </div>
  )
}
