import { useEffect, useMemo, useRef, useState } from 'react'
import { api, type RadioStationDetail, type RadioNowPlaying, type RadioLog, type RadioClass, type Group, type RadioLevelsFeed, type Gate } from '../api'
import { thumbUrl } from '../api'
import AudioVisualizer, { VERDICT_UI } from '../AudioVisualizer'
import { SEC, PageIdentity, StatusPill, TypeTag } from '../scaffold'
import { RadioDrawer, ClassChip } from './Radio'
import { ShareDrawer } from '../ShareDrawer'

/* ============================================================================
   Radio station detail — the audio-only counterpart of the channel detail
   page. The 16:9 video surface is replaced by a live AUDIO VISUALISER (level +
   spectrum from the actual output), so "are we receiving something" is visible
   even when muted. Around it: station artwork + live ICY metadata, the MP3 /
   HLS / DASH output URLs, and the timed now-playing log (song / ad / content)
   with search — the raw material for trimming and clipping.
   ========================================================================== */

const fmtClock = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
const fmtDur = (ms: number) => {
  const s = Math.max(0, Math.round(ms / 1000))
  const m = Math.floor(s / 60)
  return m ? `${m}m ${String(s % 60).padStart(2, '0')}s` : `${s}s`
}
const isImg = (u?: string | null) => !!u && /\.(png|jpe?g|gif|webp|avif)(\?|$)/i.test(u)

export default function RadioDetail({ id, onBack }: { id: string; onBack: () => void }) {
  const [st, setSt] = useState<RadioStationDetail | null>(null)
  const [np, setNp] = useState<RadioNowPlaying | null>(null)
  const [levels, setLevels] = useState<RadioLevelsFeed | null>(null)
  const [log, setLog] = useState<RadioLog | null>(null)
  const [q, setQ] = useState('')
  const [cls, setCls] = useState<RadioClass | 'all'>('all')
  const [groups, setGroups] = useState<Group[]>([])
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [qcOpen, setQcOpen] = useState(false)
  const [shareOpen, setShareOpen] = useState(false)
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  const [playing, setPlaying] = useState(false)
  const [muted, setMuted] = useState(false)
  const [vol, setVol] = useState(0.9)
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const [mediaEl, setMediaEl] = useState<HTMLMediaElement | null>(null)

  async function load() {
    try { setSt(await api.radioStation(id)) } catch (e: any) { setErr(e.message) }
  }
  async function loadLog() {
    try { setLog(await api.radioLog(id, { q: q.trim() || undefined, class: cls === 'all' ? undefined : cls })) }
    catch { /* log is best-effort */ }
  }
  useEffect(() => { load(); api.groups().then(setGroups).catch(() => {}) /* eslint-disable-next-line */ }, [id])
  useEffect(() => {
    const t = setInterval(() => { api.radioNowPlaying(id).then(setNp).catch(() => {}) }, 5000)
    api.radioNowPlaying(id).then(setNp).catch(() => {})
    return () => clearInterval(t)
  }, [id])
  // SERVER LEVELS: polled continuously so the visualiser proves reception even
  // when nobody is listening. Also refreshes the gates/QC/event log with it.
  useEffect(() => {
    const poll = () => {
      api.radioLevels(id, 4).then(setLevels).catch(() => {})
      api.radioStation(id).then(setSt).catch(() => {})
    }
    const t = setInterval(poll, 4000)
    return () => clearInterval(t)
  }, [id])
  useEffect(() => {
    loadLog()
    const t = setInterval(loadLog, 12_000)
    return () => clearInterval(t)
    /* eslint-disable-next-line */
  }, [id, q, cls])

  const live = st?.status === 'live'
  const onAir = st?.onAir === true || st?.on_air === true
  const readyToAir = st?.health?.gates?.find(g => g.gate === 'public')?.status === 'ready'
  const verdict = levels?.verdict ?? st?.qc?.verdict ?? 'unknown'
  const title = np?.title ?? st?.nowPlaying ?? null
  const titleClass = np?.class ?? st?.nowPlayingClass ?? null
  // The configured contribution source, shown under the idle start button
  // exactly as the channel page shows its ingest URL.
  const srcRow = st?.sources?.find(s => s.role === 'primary' && s.ingest_url) || st?.sources?.find(s => s.ingest_url) || st?.sources?.[0]
  const srcProto = (srcRow?.protocol || 'icecast').toUpperCase()
  const srcUrl = srcRow?.ingest_url || null

  // ---- playback: MP3 fan-out when enabled (native, same-origin), else HLS ----
  useEffect(() => {
    const a = audioRef.current
    if (!a) return
    setMediaEl(a)
    let hls: any = null
    let cancelled = false
    async function attach() {
      if (!st || !live || !playing || !a) return
      if (st.outputs.mp3) { a.src = st.outputs.mp3; a.play().catch(() => {}); return }
      if (st.outputs.hls) {
        if (a.canPlayType('application/vnd.apple.mpegurl')) { a.src = st.outputs.hls; a.play().catch(() => {}); return }
        const Hls = (await import('hls.js')).default
        if (cancelled) return
        if (Hls.isSupported()) {
          hls = new Hls({ liveDurationInfinity: true })
          hls.loadSource(st.outputs.hls!)
          hls.attachMedia(a)
          hls.on(Hls.Events.MANIFEST_PARSED, () => a.play().catch(() => {}))
        }
      }
    }
    if (playing && live) attach()
    else { a.pause(); a.removeAttribute('src'); a.load() }
    return () => { cancelled = true; if (hls) hls.destroy() }
    /* eslint-disable-next-line */
  }, [playing, live, st?.outputs.mp3, st?.outputs.hls])
  useEffect(() => { const a = audioRef.current; if (a) { a.muted = muted; a.volume = vol } }, [muted, vol])
  useEffect(() => { if (!live) setPlaying(false) }, [live])

  async function startStop(action: 'start' | 'stop') {
    setBusy(true); setErr('')
    try { await api.radioStartStop(id, action); await load(); if (action === 'stop') setPlaying(false) }
    catch (e: any) { setErr(e.message) } finally { setBusy(false) }
  }
  // step two: open / close PUBLIC delivery
  async function setAir(on: boolean) {
    setBusy(true); setErr('')
    try { await api.radioSetAir(id, on); await load() }
    catch (e: any) { setErr(e.message) } finally { setBusy(false) }
  }

  const art = st?.brand_ref ? thumbUrl(st.brand_ref, 320, 320, 'cover')
    : isImg(np?.streamUrl) ? np!.streamUrl! : null

  const counts = log?.counts ?? {}
  const total = (counts.song ?? 0) + (counts.ad ?? 0) + (counts.content ?? 0)

  async function copy(text: string) {
    try { await navigator.clipboard.writeText(new URL(text, window.location.origin).toString()) } catch { /* */ }
  }

  if (!st) return <div className="loading">{err || 'Loading station…'}</div>

  return (
    <>
      {/* Identity row comes from the SHARED component, so the breadcrumb, thumb,
          title size and pill alignment are literally the same code as Channels. */}
      <div className="page-head">
        <PageIdentity
          crumbLabel="Radio" onCrumb={onBack} name={st.name} imgUrl={art}
          tags={<>
            <TypeTag label={st.radio_config?.transcode ? 'Transcode' : 'Packaging'} kind="chan" />
            <StatusPill state={st.pipelineState} />
          </>}
          sub={<>
            {st.group_name} · {(st.sources[0]?.protocol || 'icecast').toUpperCase()} in · {st.radio_config?.bitrateKbps ?? 128}k out
            {st.pipeline.running && st.pipeline.sourceCodec ? ` · source ${st.pipeline.sourceCodec}` : ''}
            {st.radio_config?.metadataCapture !== false ? ' · metadata log on' : ''}
            {st.recording_enabled !== false ? ' · recording on' : ''}
          </>}
        />
        <div className="spacer" />
        {/* Same action order as a channel: QC, Settings, then the lifecycle. */}
        <button className="btn ghost" onClick={() => setQcOpen(true)} title="Diagnose the pipeline (server → input → encoder → output) and see the audio QC"
          style={st.health?.primaryError ? { color: '#fca5a5', borderColor: 'rgba(248,113,113,.5)' } : undefined}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M9 12l2 2 4-4" /><circle cx="12" cy="12" r="9" /></svg>QC
        </button>
        <button className="btn ghost" onClick={() => setShareOpen(true)} title="Create a private, time-boxed preview link for a client or reviewer (does not go on air)">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M4 12v7a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-7" /><path d="M16 6l-4-4-4 4" /><path d="M12 2v14" /></svg>Share
        </button>
        <button className="btn ghost" onClick={() => setSettingsOpen(true)}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="3" /><path d="M12 3v3M12 18v3M3 12h3M18 12h3" /></svg>Settings
        </button>
        {/* TWO STEPS, same as channels: run the station (private), then publish. */}
        {!live ? (
          <button className="btn primary" disabled={busy} onClick={() => startStop('start')}
            title="Brings the audio pipeline up and starts receiving the source">
            {busy ? 'Starting…' : 'Start station'}
          </button>
        ) : (
          <>
            {!onAir ? (
              <button className="btn primary" disabled={busy || !readyToAir}
                onClick={() => setAir(true)}
                title={readyToAir ? 'Open the public URLs and go on air' : 'Output must be producing valid audio first'}>
                <span className="dot-s live" style={{ marginRight: 6 }} />{busy ? 'Going on air…' : 'Go on air'}
              </button>
            ) : (
              <button className="btn ghost" disabled={busy} onClick={() => setAir(false)}
                title="Close the public URLs (the station keeps running and recording)">
                {busy ? 'Taking off air…' : 'Take off air'}
              </button>
            )}
            <button className="btn ghost" disabled={busy} onClick={() => startStop('stop')}
              style={{ color: '#fca5a5', borderColor: 'rgba(248,113,113,.5)' }}>
              {busy ? 'Stopping…' : 'Stop station'}
            </button>
          </>
        )}
      </div>
      {err && <div className="err">{err}</div>}

      {/* PRIMARY ERROR banner — the first failed/degraded gate, same as channels */}
      {st.health?.primaryError && (
        <div style={{
          margin: '0 0 14px', padding: '12px 14px', borderRadius: 10, display: 'flex', gap: 12, alignItems: 'center',
          background: 'rgba(248,113,113,.10)', border: '1px solid rgba(248,113,113,.4)',
        }}>
          <span style={{ fontSize: 'var(--fs-h2)' }}>⚠</span>
          <div style={{ flex: 1 }}>
            <div style={{ fontWeight: 700, color: '#fca5a5' }}>{st.health.primaryError.label} failed</div>
            <div style={{ fontSize: 'var(--fs-body)', color: 'var(--muted)', wordBreak: 'break-word' }}>{st.health.primaryError.message}</div>
          </div>
        </div>
      )}

      {/* FIVE GATES — identical strip to the channel page (no extra container:
          the gates ARE the status line for the station). */}
      <PipelineStrip gates={st.health?.gates || []} />

      {/* same two-column proportions and gap as the channel page (.grid-2) */}
      <div className="grid-2" style={{ alignItems: 'start' }}>
        {/* ---- player: visualiser instead of a 16:9 video ----
             minWidth:0 matters: without it a long monospace URL in the other
             column stretches the grid past the page width. */}
        <div className="card" style={{ padding: 16, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
            <button className="btn primary" disabled={!live} onClick={() => setPlaying(p => !p)}>
              {playing ? 'Stop listening' : 'Listen'}
            </button>
            <div className="icon-btn" title={muted ? 'Unmute' : 'Mute'} onClick={() => setMuted(m => !m)}>
              {muted
                ? <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M11 5 6 9H2v6h4l5 4V5zM23 9l-6 6M17 9l6 6" /></svg>
                : <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M11 5 6 9H2v6h4l5 4V5zM15.5 8.5a5 5 0 0 1 0 7M19 5a9 9 0 0 1 0 14" /></svg>}
            </div>
            <input type="range" min={0} max={1} step={0.02} value={vol} onChange={e => setVol(Number(e.target.value))} style={{ width: 120 }} />
            <div style={{ marginLeft: 'auto', fontSize: 'var(--fs-sm)', color: 'var(--faint)' }}>
              {live ? (st.pipeline.running ? `${np?.listeners ?? st.pipeline.listeners ?? 0} MP3 listeners` : '') : 'Start the station to monitor the output'}
            </div>
          </div>
          {/* The meter is fed by SERVER-MEASURED levels from the broadcast output,
              so it moves whether or not you are listening; the local analyser is an
              overlay while playing. */}
          <AudioVisualizer media={mediaEl} height={230}
            levels={levels?.samples} verdict={verdict} live={live}
            idleText="Station is off"
            /* SAME CALL TO ACTION AS A CHANNEL. On the channel page the idle
               video surface carries the big "▶ Start channel (HLS)" button with
               the source URL under it; the audio surface is the same surface for
               radio, so it gets the same affordance rather than a flat caption.
               One primary start button on the page: this and the header button
               call the same startStop('start'). */
            idleOverlay={
              <div>
                <button className="btn primary" disabled={busy} onClick={() => startStop('start')}
                  style={{ transform: 'scale(1.05)' }}
                  title="Brings the audio pipeline up and starts receiving the source">
                  {busy ? 'Starting…' : `▶  Start station (${srcProto})`}
                </button>
                {srcUrl && (
                  <div style={{ marginTop: 10, fontSize: 'var(--fs-label)', color: 'var(--faint)', maxWidth: 340, wordBreak: 'break-all' }}>
                    {srcUrl}
                  </div>
                )}
              </div>
            } />
          {live && (
            <div style={{ display: 'flex', gap: 14, marginTop: 8, fontSize: 'var(--fs-xs)', color: 'var(--faint)', flexWrap: 'wrap' }}>
              <span>Measured from the output, {playing ? 'listening locally' : 'no local playback needed'}</span>
              {levels?.level && <span style={{ fontFamily: 'ui-monospace,monospace' }}>
                peak {levels.level.peakDb.toFixed(1)} dBFS · rms {levels.level.rmsDb.toFixed(1)} dBFS · crest {levels.level.crestDb.toFixed(1)} dB
              </span>}
              {levels?.lastSampleAt && <span>updated {Math.max(0, Math.round((Date.now() - levels.lastSampleAt) / 1000))}s ago</span>}
            </div>
          )}
          <audio ref={audioRef} crossOrigin="anonymous" style={{ display: 'none' }} />
          {/* now playing strip under the visualiser */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 12, minHeight: 30 }}>
            {isImg(np?.streamUrl) && <img src={np!.streamUrl!} alt="" style={{ width: 30, height: 30, borderRadius: 6, objectFit: 'cover' }} />}
            <div style={{ fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {live ? (title || 'Untitled break') : 'Off air'}
            </div>
            <ClassChip cls={live ? titleClass : null} />
            {live && np?.since && <span style={{ fontSize: 'var(--fs-sm)', color: 'var(--faint)' }}>{fmtDur(Date.now() - np.since)} in</span>}
          </div>
        </div>

        {/* ---- station metadata + outputs ---- */}
        <div style={{ display: 'grid', gap: 18, minWidth: 0 }}>
          <div className="card" style={{ padding: 16, minWidth: 0 }}>
            <div style={SEC}>Station metadata</div>
            {st.icy?.station?.name || np?.station?.name ? (
              <div style={{ display: 'grid', gap: 6, fontSize: 'var(--fs-body)' }}>
                <MetaRow k="Station" v={np?.station?.name || st.icy?.station?.name} />
                <MetaRow k="Genre" v={np?.station?.genre || st.icy?.station?.genre} />
                <MetaRow k="Website" v={np?.station?.url || st.icy?.station?.url} />
                <MetaRow k="Source bitrate" v={(np?.station?.bitrateKbps || st.icy?.station?.bitrateKbps) ? `${np?.station?.bitrateKbps || st.icy?.station?.bitrateKbps} kbps` : undefined} />
                <MetaRow k="Content type" v={np?.station?.contentType || st.icy?.station?.contentType} />
                <MetaRow k="Title changes" v={st.icy ? String(st.icy.changes) : undefined} />
              </div>
            ) : <div style={{ fontSize: 'var(--fs-sm)', color: 'var(--faint)' }}>ICY headers appear here when the station runs against an Icecast source.</div>}
          </div>
          {/* QC PANEL — the audio equivalent of the channel QC surface.
              Layout here is Tailwind utilities; the card itself stays a
              semantic class. That is the split the design system asks for. */}
          <div className="card p-4 min-w-0">
            <div className="sec-label">Quality checks</div>
            <div className="flex items-center gap-2 mb-2">
              <span className="w-2.5 h-2.5 rounded-full" style={{ background: VERDICT_UI[verdict]?.color ?? '#64748b' }} />
              <b className="text-body">{VERDICT_UI[verdict]?.label ?? verdict}</b>
              <span className="text-sm text-faint">{VERDICT_UI[verdict]?.note}</span>
            </div>
            <div className="grid gap-1.5 text-sm">
              <MetaRow k="Checks passed" v={st.qc ? `${st.qc.checks.ok} ok · ${st.qc.checks.failed} flagged` : undefined} />
              <MetaRow k="Segments live" v={st.qc?.segments != null ? String(st.qc.segments) : undefined} />
              <MetaRow k="Output age" v={st.qc?.outputFreshMs != null ? `${Math.round(st.qc.outputFreshMs / 1000)}s` : undefined} />
              <MetaRow k="Entropy / crest" v={st.qc?.level ? `${st.qc.level.entropy.toFixed(2)} / ${st.qc.level.crestDb.toFixed(1)} dB` : undefined} />
            </div>
            {st.qc?.issues?.length ? (
              <div style={{ marginTop: 10, borderTop: '1px solid var(--border)', paddingTop: 8 }}>
                {st.qc.issues.slice(-5).reverse().map((i, n) => (
                  <div key={n} style={{ fontSize: 'var(--fs-sm)', color: 'var(--warn,#fbbf24)', marginTop: 4 }}>
                    <span style={{ fontFamily: 'ui-monospace,monospace', fontSize: 'var(--fs-micro)', opacity: .8 }}>{i.code}</span> · {i.message}
                  </div>
                ))}
              </div>
            ) : (
              <div style={{ marginTop: 10, fontSize: 'var(--fs-sm)', color: 'var(--faint)' }}>
                No issues: playlist continuity, timing and audio level all pass.
              </div>
            )}
          </div>

          <div className="card" style={{ padding: 16, minWidth: 0 }}>
            <div style={SEC}>{onAir ? 'Public URLs (on air)' : 'Preview URLs (private)'}</div>
            {!onAir && <div className="hintxt" style={{ marginTop: -4, marginBottom: 6 }}>These are private monitoring URLs. Go on air to open the public ones.</div>}
            {(onAir
              ? ([['MP3', st.publicUrls?.mp3], ['HLS', st.publicUrls?.hls], ['DASH', st.publicUrls?.dash]] as const)
              : ([['MP3', st.outputs.mp3], ['HLS', st.outputs.hls], ['DASH', st.outputs.dash]] as const)
            ).map(([label, url]) => (
              <div key={label} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 0', borderBottom: '1px solid var(--border)', minWidth: 0 }}>
                <span style={{ width: 44, flex: 'none', fontSize: 'var(--fs-label)', fontWeight: 700, color: url ? 'var(--brand)' : 'var(--faint)' }}>{label}</span>
                <span title={url || undefined} style={{ flex: 1, minWidth: 0, fontFamily: 'ui-monospace,monospace', fontSize: 'var(--fs-xs)', color: url ? 'var(--muted)' : 'var(--faint)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {url || 'disabled'}
                </span>
                {url && <button className="btn ghost" style={{ padding: '3px 10px', fontSize: 'var(--fs-sm)' }} onClick={() => copy(url)}>Copy</button>}
              </div>
            ))}
            {st.openRecording && (
              <div style={{ marginTop: 10, fontSize: 'var(--fs-sm)' }}>
                Recording since {new Date(Number(st.openRecording.start_epoch_ms)).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} ·{' '}
                <a href={`/recordings/${st.openRecording.id}`} style={{ color: 'var(--brand)' }}
                  onClick={e => { e.preventDefault(); window.history.pushState({}, '', `/recordings/${st.openRecording!.id}`); window.dispatchEvent(new PopStateEvent('popstate')) }}>
                  open in the clipping workbench
                </a>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* ---- timed metadata log ---- */}
      <div className="card" style={{ marginTop: 16, padding: 16 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10, flexWrap: 'wrap' }}>
          <div style={{ ...SEC, margin: 0 }}>Received metadata log</div>
          <div style={{ display: 'flex', gap: 6, marginLeft: 8 }}>
            {(['all', 'song', 'ad', 'content'] as const).map(c => (
              <div key={c} className={`chip ${cls === c ? 'active' : ''}`} style={{ padding: '3px 10px', fontSize: 'var(--fs-sm)' }} onClick={() => setCls(c)}>
                {c === 'all' ? `All ${total}` : `${CLASS_LABEL[c]} ${counts[c] ?? 0}`}
              </div>
            ))}
          </div>
          <input className="inp" style={{ width: 260, maxWidth: '100%', marginLeft: 'auto' }} value={q} onChange={e => setQ(e.target.value)}
            placeholder="Search titles…" />
        </div>
        {!log || log.entries.length === 0 ? (
          <div style={{ fontSize: 'var(--fs-sm)', color: 'var(--faint)', padding: '14px 4px' }}>
            {q.trim() ? 'No entries match.' : 'Entries appear while the station runs against an Icecast source with the metadata log enabled: every now-playing change is captured with its time, classified as song, ad or content, and becomes searchable here and in Recordings.'}
          </div>
        ) : (
          <table>
            <thead><tr><th style={{ width: 170 }}>When</th><th style={{ width: 90 }}>Length</th><th>Title</th><th style={{ width: 90 }}>Class</th></tr></thead>
            <tbody>
              {log.entries.map((e) => {
                const liveRow = e.status === 'live'
                const dur = new Date(e.ends_at).getTime() - new Date(e.starts_at).getTime()
                return (
                  <tr key={e.id} style={liveRow ? { background: 'rgba(63,123,255,.07)' } : undefined}>
                    <td style={{ color: 'var(--muted)', fontVariantNumeric: 'tabular-nums' }}>
                      {fmtClock(e.starts_at)} → {liveRow ? 'now' : fmtClock(e.ends_at)}
                    </td>
                    <td style={{ color: 'var(--muted)' }}>{liveRow ? '…' : fmtDur(dur)}</td>
                    <td>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        {isImg(e.stream_url) && <img src={e.stream_url!} alt="" style={{ width: 22, height: 22, borderRadius: 4, objectFit: 'cover' }} />}
                        <span>{e.title || <span style={{ color: 'var(--faint)' }}>Untitled break</span>}</span>
                        {liveRow && <span className="tag live" style={{ fontSize: 9 }}>on air</span>}
                      </div>
                    </td>
                    <td><ClassChip cls={e.class} /></td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
      </div>

      {/* ---- event log: lifecycle, input/encoder errors and QC alarms ---- */}
      <div className="card" style={{ marginTop: 16, padding: 16 }}>
        <div style={{ ...SEC, marginTop: 0 }}>Event log</div>
        {!st.log?.length ? (
          <div style={{ fontSize: 'var(--fs-sm)', color: 'var(--faint)' }}>Nothing logged yet for this station.</div>
        ) : (
          <div style={{ maxHeight: 260, overflowY: 'auto' }}>
            {st.log.map((e, i) => (
              <div key={i} style={{ display: 'flex', gap: 10, alignItems: 'baseline', padding: '5px 0', borderBottom: '1px solid var(--border)' }}>
                <span style={{
                  fontSize: 'var(--fs-micro)', fontWeight: 700, width: 46, flex: 'none', textTransform: 'uppercase',
                  color: e.level === 'down' ? 'var(--down,#f87171)' : e.level === 'warn' ? 'var(--warn,#fbbf24)' : 'var(--faint)',
                }}>{e.level}</span>
                <span style={{ fontSize: 'var(--fs-xs)', color: 'var(--faint)', width: 74, flex: 'none', fontVariantNumeric: 'tabular-nums' }}>
                  {e.ts === 'encoder' ? 'encoder' : fmtClock(e.ts)}
                </span>
                <span style={{ fontSize: 'var(--fs-sm)', fontWeight: 600, width: 128, flex: 'none' }}>{e.title}</span>
                <span style={{ fontSize: 'var(--fs-sm)', color: 'var(--muted)', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis' }}>{e.detail}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      {settingsOpen && (
        <RadioDrawer groups={groups} station={st} onClose={() => setSettingsOpen(false)}
          onDone={() => { setSettingsOpen(false); load() }} />
      )}

      {shareOpen && <ShareDrawer target={{ kind: 'radio', id: st.id, name: st.name }} onClose={() => setShareOpen(false)} />}

      {qcOpen && <RadioQcPanel st={st} verdict={verdict} levels={levels}
        onClose={() => setQcOpen(false)} onRefresh={load} />}
    </>
  )
}

const CLASS_LABEL: Record<string, string> = { song: 'Songs', ad: 'Ads', content: 'Content' }

/* ------------------------------------------------------------- QC panel
   The radio counterpart of the channel QC dialog: the same five gates in the
   same layout, plus the audio-specific checks a station lives or dies by
   (dead air, static-like signal, playlist continuity) and the event log. */
function RadioQcPanel({ st, verdict, levels, onClose, onRefresh }: {
  st: RadioStationDetail; verdict: string; levels: RadioLevelsFeed | null
  onClose: () => void; onRefresh: () => void
}) {
  const gates = st.health?.gates || []
  const qc = st.qc
  const v = VERDICT_UI[verdict as keyof typeof VERDICT_UI] ?? VERDICT_UI.unknown
  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(2,6,14,.6)', zIndex: 60, display: 'grid', placeItems: 'center', padding: 20 }}>
      <div onClick={e => e.stopPropagation()} style={{ width: 'min(920px,96vw)', maxHeight: '92vh', overflow: 'auto', background: 'var(--panel,#0e1420)', border: '1px solid var(--border)', borderRadius: 14, padding: 20 }}>
        <div style={{ display: 'flex', alignItems: 'center', marginBottom: 4 }}>
          <h2 style={{ margin: 0, fontSize: 'var(--fs-h1)', letterSpacing: 'var(--ls-title)' }}>QC · pipeline diagnose</h2>
          <div style={{ flex: 1 }} />
          <button className="btn ghost" onClick={onRefresh} style={{ marginRight: 8 }}>Refresh</button>
          <button className="btn ghost" onClick={onClose}>Close</button>
        </div>
        <p style={{ color: 'var(--muted)', marginTop: 4, fontSize: 'var(--fs-body)' }}>
          Each stage is a gate — a later stage can only be healthy if the ones before it are.
          For a station the audio itself is also measured: silence and noise are faults you cannot see in a manifest.
        </p>

        {st.health?.primaryError && (
          <div style={{ margin: '10px 0 16px', padding: '12px 14px', borderRadius: 10, background: 'rgba(248,113,113,.10)', border: '1px solid rgba(248,113,113,.4)' }}>
            <div style={{ fontWeight: 700, color: '#fca5a5' }}>Primary issue — {st.health.primaryError.label}</div>
            <div style={{ fontSize: 'var(--fs-body)', color: 'var(--muted)' }}>{st.health.primaryError.message}</div>
          </div>
        )}

        {/* the five gates, left to right — same shape as the channel panel */}
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', margin: '8px 0 18px' }}>
          {gates.map((g, i) => (
            <div key={g.gate} style={{ display: 'flex', alignItems: 'stretch', gap: 8, flex: '1 1 160px' }}>
              <div style={{ flex: 1, border: `1px solid ${GATE_COLOR[g.status]}55`, background: `${GATE_COLOR[g.status]}12`, borderRadius: 10, padding: '10px 12px' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 'var(--fs-sm)', color: 'var(--muted)' }}>
                  {g.label}{g.billable && <span title="billable while up" style={{ marginLeft: 'auto', color: '#fbbf24', fontSize: 'var(--fs-micro)' }}>● billable</span>}
                </div>
                <div style={{ fontWeight: 700, color: GATE_COLOR[g.status], textTransform: 'uppercase', fontSize: 'var(--fs-h3)', marginTop: 4 }}>{g.status}</div>
                <div style={{ fontSize: 'var(--fs-sm)', color: 'var(--faint)', marginTop: 2, wordBreak: 'break-word' }}>{g.detail}</div>
              </div>
              {i < gates.length - 1 && <div style={{ display: 'grid', placeItems: 'center', color: 'var(--faint)' }}>→</div>}
            </div>
          ))}
        </div>

        {/* audio QC — the part a video channel does not have */}
        <div className="sec-label">Audio quality</div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
          <span style={{ width: 10, height: 10, borderRadius: 999, background: v.color }} />
          <b>{v.label}</b>
          <span style={{ color: 'var(--faint)', fontSize: 'var(--fs-sm)' }}>{v.note}</span>
          {levels?.level && (
            <span style={{ marginLeft: 'auto', fontFamily: 'ui-monospace,monospace', fontSize: 'var(--fs-sm)', color: 'var(--muted)' }}>
              peak {levels.level.peakDb.toFixed(1)} · rms {levels.level.rmsDb.toFixed(1)} dBFS · crest {levels.level.crestDb.toFixed(1)} dB · entropy {levels.level.entropy.toFixed(2)}
            </span>
          )}
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(150px,1fr))', gap: 8, marginBottom: 16 }}>
          <QcStat k="Checks passed" v={`${qc?.checks.ok ?? 0} ok · ${qc?.checks.failed ?? 0} flagged`} />
          <QcStat k="Segments live" v={String(qc?.segments ?? 0)} />
          <QcStat k="Output age" v={qc?.outputFreshMs != null ? `${Math.round(qc.outputFreshMs / 1000)}s` : '—'} />
          <QcStat k="Dead air" v={qc?.silenceSinceMs ? `since ${fmtClock(new Date(qc.silenceSinceMs).toISOString())}` : 'none'} />
        </div>

        <div className="sec-label">Checks and issues</div>
        {!qc?.issues?.length ? (
          <div style={{ fontSize: 'var(--fs-body)', color: 'var(--muted)' }}>
            No issues. Playlist continuity, media sequence, timing (PDT) and audio level all pass.
          </div>
        ) : (
          <div style={{ display: 'grid', gap: 6 }}>
            {qc.issues.slice(-12).reverse().map((i, n) => (
              <div key={n} style={{ display: 'flex', gap: 10, alignItems: 'baseline', fontSize: 'var(--fs-sm)' }}>
                <span className="tag warn" style={{ fontSize: 'var(--fs-micro)' }}>{i.code}</span>
                <span style={{ color: 'var(--muted)', flex: 1 }}>{i.message}</span>
                <span style={{ color: 'var(--faint)', fontSize: 'var(--fs-label)' }}>{fmtClock(new Date(i.at).toISOString())}</span>
              </div>
            ))}
          </div>
        )}

        <div className="sec-label">Recent events</div>
        <div style={{ maxHeight: 220, overflowY: 'auto' }}>
          {(st.log || []).slice(0, 15).map((e, i) => (
            <div key={i} style={{ display: 'flex', gap: 10, alignItems: 'baseline', padding: '4px 0', borderBottom: '1px solid var(--border)' }}>
              <span style={{ fontSize: 'var(--fs-micro)', fontWeight: 700, width: 46, flex: 'none', textTransform: 'uppercase', color: e.level === 'down' ? 'var(--down,#f87171)' : e.level === 'warn' ? 'var(--warn,#fbbf24)' : 'var(--faint)' }}>{e.level}</span>
              <span style={{ fontSize: 'var(--fs-xs)', color: 'var(--faint)', width: 74, flex: 'none' }}>{e.ts === 'encoder' ? 'encoder' : fmtClock(e.ts)}</span>
              <span style={{ fontSize: 'var(--fs-sm)', fontWeight: 600, width: 128, flex: 'none' }}>{e.title}</span>
              <span style={{ fontSize: 'var(--fs-sm)', color: 'var(--muted)', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis' }}>{e.detail}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

function QcStat({ k, v }: { k: string; v: string }) {
  return (
    <div style={{ border: '1px solid var(--border)', borderRadius: 10, padding: '8px 11px' }}>
      <div style={{ fontSize: 'var(--fs-label)', letterSpacing: 'var(--ls-label)', textTransform: 'uppercase', color: 'var(--faint)' }}>{k}</div>
      <div style={{ fontSize: 'var(--fs-h3)', fontWeight: 600, marginTop: 2 }}>{v}</div>
    </div>
  )
}

const GATE_COLOR: Record<string, string> = {
  idle: '#64748b', starting: '#fbbf24', ready: '#60a5fa', healthy: '#4ade80',
  degraded: '#fb923c', failed: '#f87171', stopped: '#64748b',
}
/** The five-gate strip — same markup, sizing and arrows as the channel page,
 *  so a station and a channel read identically at a glance. */
function PipelineStrip({ gates }: { gates: Gate[] }) {
  if (!gates.length) return null
  return (
    <div style={{ display: 'flex', alignItems: 'stretch', gap: 6, margin: '0 0 14px', flexWrap: 'wrap' }}>
      {gates.map((g, i) => {
        const label = (g.gate === 'public' && g.status === 'healthy') ? 'ON AIR' : g.status
        const color = GATE_COLOR[g.status] ?? '#64748b'
        return (
          <div key={g.gate} style={{ display: 'flex', alignItems: 'stretch', gap: 6, flex: '1 1 130px' }}>
            <div title={g.detail} style={{ flex: 1, border: `1px solid ${color}55`, background: `${color}12`, borderRadius: 9, padding: '7px 10px', minWidth: 0 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 'var(--fs-label)', color: 'var(--muted)' }}>
                <span className="dot-s" style={{ background: color }} />{g.label}
                {g.billable && <span style={{ marginLeft: 'auto', color: '#fbbf24', fontSize: 9 }}>●</span>}
              </div>
              <div style={{ fontWeight: 700, fontSize: 'var(--fs-xs)', color, textTransform: 'uppercase' }}>{label}</div>
              <div style={{ fontSize: 'var(--fs-micro)', color: 'var(--faint)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{g.detail}</div>
            </div>
            {i < gates.length - 1 && <div style={{ display: 'grid', placeItems: 'center', color: 'var(--faint)', fontSize: 'var(--fs-sm)' }}>→</div>}
          </div>
        )
      })}
    </div>
  )
}

function MetaRow({ k, v }: { k: string; v?: string | null }) {
  if (!v) return null
  return (
    <div style={{ display: 'flex', gap: 8 }}>
      <span style={{ width: 110, color: 'var(--faint)' }}>{k}</span>
      <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis' }}>{v}</span>
    </div>
  )
}
