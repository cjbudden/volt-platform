import { useEffect, useRef, useState } from 'react'
import { api, type RadioStationDetail, type RadioNowPlaying, type RadioLog, type RadioClass, type Group, type RadioLevelsFeed } from '../api'
import { navigate } from '../router'
import { thumbUrl } from '../api'
import AudioVisualizer, { VERDICT_UI } from '../AudioVisualizer'
import { SEC, PageIdentity, StatusPill, TypeTag, PipelineStrip, GATE_COLOR, RecoveryNote } from '../scaffold'
import { RadioDrawer, ClassChip } from './Radio'
import { ShareDrawer } from '../ShareDrawer'
import { pressable } from '../a11y'

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
  const [dismissing, setDismissing] = useState(false)
  const [clearingLog, setClearingLog] = useState(false)
  // Why unmuting produced no sound. Silence with no explanation is the single
  // worst thing this page can do: it is indistinguishable from a dead station,
  // a broken player and a muted laptop, and it sent a real operator hunting
  // through encoder logs for a fault that was in this component.
  const [playError, setPlayError] = useState<string | null>(null)
  // which OUTPUT PREVIEW is sounding ('MP3' | 'HLS' | 'DASH' | null). One at a
  // time, and never together with live monitoring: three streams of the same
  // station overlapping tells you nothing.
  const [preview, setPreview] = useState<string | null>(null)
  // Station artwork often comes from an ICY StreamUrl we do not control. If it
  // 404s we show the placeholder rather than a broken-image box.
  const [artBroken, setArtBroken] = useState(false)
  // MONITORING IS ONE DECISION, NOT TWO.
  //
  // There used to be a Listen button AND a mute button, which is two controls
  // for one question: do I want to hear this. Worse, they could disagree --
  // attached but muted looked and sounded exactly like not attached, so when
  // the page went silent there was no way to tell which control was at fault.
  //
  // So there is one state, and `muted` is it. Unmuted attaches and plays;
  // muted pauses and lets go of the stream, which also means a console left
  // open on a wall display is not pulling audio nobody is listening to.
  //
  // Muted is the default: a page that starts making noise on load is a page
  // people close. And because unmuting is a click, it is a user gesture, so
  // the browser's autoplay policy is satisfied by construction -- which the
  // old Listen button had to fight.
  //
  // NONE OF THIS TOUCHES THE BROADCAST OR THE WAVEFORM. The levels are
  // measured server-side by the packager and drawn whether anyone is listening
  // or not, which is what lets you see the station is working without hearing
  // it.
  const [muted, setMuted] = useState(true)
  /** Monitoring is on precisely when it is not muted. */
  const playing = !muted
  const [vol, setVol] = useState(0.9)
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const [mediaEl, setMediaEl] = useState<HTMLMediaElement | null>(null)

  /** Put down the give-up notice. See the route: it also stands the stream
   *  down, so auto connect does not restart a source that is still broken. */
  async function dismissRecovery() {
    setDismissing(true)
    try { await api.radioClearRecovery(id); await load() }
    catch (e: any) { setErr(e.message) }
    finally { setDismissing(false) }
  }

  /** Empty this station's log. Confirmed, because it cannot be undone, and the
   *  count is worth stating: "clear 8,000 entries" is a different decision from
   *  "clear 12". */
  async function clearLog() {
    const n = st?.log?.length ?? 0
    if (!window.confirm(
      `Clear this station's event log?\n\n${n} visible entr${n === 1 ? 'y' : 'ies'} will be removed, along with anything older that is not on screen. This cannot be undone. A single entry recording that you cleared it will remain.`
    )) return
    setClearingLog(true)
    try { await api.radioClearLog(id); await load() }
    catch (e: any) { setErr(e.message) }
    finally { setClearingLog(false) }
  }

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
  // SERVER LEVELS, POLLED UNCONDITIONALLY.
  //
  // This is the meter's only source and it has nothing to do with local
  // playback. The bars are measured by the packager on the broadcast output, so
  // they move whether you are listening, muted, or have the tab in the
  // background — which is the point, because muted is the normal state. An
  // operator watching a station is watching this; hearing it is occasional.
  //
  // POLLED IMMEDIATELY, THEN ON THE INTERVAL. setInterval alone does not fire
  // until the first period has elapsed, so the meter sat flat for four seconds
  // on every page load and every station switch. Four seconds of a dead-looking
  // meter is exactly the thing this component exists to disprove.
  useEffect(() => {
    const poll = () => {
      api.radioLevels(id, 8).then(setLevels).catch(() => {})
      api.radioStation(id).then(setSt).catch(() => {})
    }
    poll()
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
  const srcUrl = srcRow?.ingest_url || null

  // ---- playback: MP3 fan-out when enabled (native, same-origin), else HLS ----
  useEffect(() => {
    const a = audioRef.current
    if (!a) return
    setMediaEl(a)
    let hls: any = null
    let cancelled = false
    // FALL THROUGH ON FAILURE, AND SAY SO.
    //
    // This used to try MP3, swallow whatever happened with .catch(() => {}) and
    // return. On a machine with no Icecast relay that is total silence with no
    // message anywhere: the station is genuinely on air and producing good HLS,
    // and the page attaches to an MP3 URL with nothing behind it. The API no
    // longer offers an output the encoder dropped, but a URL can still fail for
    // reasons the API cannot see (the relay dying mid-run, a 404 mount), so the
    // player has to recover on its own rather than trust the list it was given.
    async function tryUrl(url: string): Promise<boolean> {
      if (!a) return false
      a.src = url
      try { await a.play(); return true } catch {
        // AUTOPLAY REFUSAL IS NOT A BROKEN OUTPUT, and the distinction matters:
        // falling back to HLS would fail for the same reason and the page would
        // blame the station for the browser's policy. If the element actually
        // took the media, the source is fine and only the gesture is missing.
        return !a.paused || a.readyState > 0
      }
    }
    async function attach() {
      if (!st || !live || !playing || !a) return
      setPlayError(null)
      if (st.outputs.mp3 && await tryUrl(st.outputs.mp3)) return
      if (cancelled) return
      if (st.outputs.mp3) console.warn('[radio] the MP3 output would not play; falling back to HLS')
      if (st.outputs.hls) {
        if (a.canPlayType('application/vnd.apple.mpegurl')) {
          if (await tryUrl(st.outputs.hls)) return
          setPlayError('The HLS output would not start in this browser.')
          return
        }
        const Hls = (await import('hls.js')).default
        if (cancelled) return
        if (Hls.isSupported()) {
          hls = new Hls({ liveDurationInfinity: true })
          hls.loadSource(st.outputs.hls!)
          hls.attachMedia(a)
          hls.on(Hls.Events.MANIFEST_PARSED, () => a.play().catch(
            (e: any) => setPlayError(String(e?.message ?? e))))
          hls.on(Hls.Events.ERROR, (_e: any, data: any) => {
            if (data?.fatal) setPlayError(`${data.details ?? data.type}`)
          })
          return
        }
        setPlayError('This browser cannot play HLS, and no MP3 output is available.')
        return
      }
      // NOTHING LEFT TO ATTACH TO. Previously this returned in silence, which
      // is how a station with its only listenable output dropped looked exactly
      // like a working one.
      const why = st.outputs.degraded?.mp3
      setPlayError(why
        ? `No output this player can use: ${why}`
        : 'The station is on air but is not producing an output this player can attach to.')
    }
    if (playing && live) attach()
    else { setPlayError(null); a.pause(); a.removeAttribute('src'); a.load() }
    return () => { cancelled = true; if (hls) hls.destroy() }
    /* eslint-disable-next-line */
  }, [playing, live, st?.outputs.mp3, st?.outputs.hls])
  // Volume only. `muted` is not pushed onto the element any more: silence is
  // achieved by not being attached, so the element is never both loaded and
  // silent -- the state that made a broken output indistinguishable from a
  // muted one.
  useEffect(() => { const a = audioRef.current; if (a) a.volume = vol }, [vol])
  useEffect(() => { if (!live) { setMuted(true); setPreview(null) } }, [live])
  useEffect(() => { if (playing) setPreview(null) }, [playing])

  async function startStop(action: 'start' | 'stop') {
    setBusy(true); setErr('')
    try { await api.radioStartStop(id, action); await load(); if (action === 'stop') setMuted(true) }
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
  useEffect(() => { setArtBroken(false) }, [art])

  const counts = log?.counts ?? {}
  const total = (counts.song ?? 0) + (counts.ad ?? 0) + (counts.content ?? 0)

  async function copy(text: string) {
    try { await navigator.clipboard.writeText(new URL(text, window.location.origin).toString()) } catch { /* */ }
  }

  if (!st) return <div className="loading">{err || 'Loading station…'}</div>

  // WHAT THE SOURCE CAN AND CANNOT TELL US, decided once.
  //
  // ICY metadata is an Icecast property. An HLS or SRT station has no metadata
  // channel to negotiate, so its now-playing panels will never fill, and both
  // used to say so as a CONDITION: "appears when the station runs against an
  // Icecast source". On an Icecast station that is a useful hint about a thing
  // not yet happening. On an HLS station it is a promise that can never be
  // kept, and it reads as a fault the operator should go and fix.
  //
  // The absence is a fact about the protocol, so it is stated as one.
  // Which outputs the OPERATOR asked for. An output missing because it was
  // never wanted and one missing because the encoder could not produce it are
  // different facts, and the row that shows them has to be able to tell them
  // apart. Defaults match resolveOutputs(): absent means on.
  const rcOuts = (st.radio_config?.outputs ?? {}) as Record<string, boolean | undefined>
  const cfgOutputs: Record<'mp3' | 'hls' | 'dash', boolean> = {
    mp3: rcOuts.mp3 !== false, hls: rcOuts.hls !== false, dash: rcOuts.dash !== false,
  }

  const srcProtocol = String(st.sources?.[0]?.protocol || 'icecast').toLowerCase()
  const icyCapable = srcProtocol === 'icecast'
  const PROTOCOL_LABEL: Record<string, string> = { hls: 'HLS', srt: 'SRT', icecast: 'Icecast' }
  const srcLabel = PROTOCOL_LABEL[srcProtocol] ?? srcProtocol.toUpperCase()

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
        {/* The embed lives on its own page rather than in the settings drawer:
            it has a preview, a snippet to copy and its own reporting, none of
            which fit a drawer, and it is a thing you send to a web developer
            rather than a station setting. */}
        <button className="btn ghost" onClick={() => navigate(`/radio/${id}/player`)}
          title="Style the embeddable player and copy the snippet for a website or app">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M8 5v14l11-7z" /></svg>Player
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

      {/* WHAT AUTO-CONNECT IS DOING, on the page rather than in a drawer. A
          station that is being retried used to say nothing at all, which is
          indistinguishable from a platform that is not trying. */}
      <RecoveryNote row={st} state={st.pipelineState ?? st.health?.overall}
        onDismiss={dismissRecovery} dismissing={dismissing} />

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

      {/* Same two-column proportions and gap as the channel page (.grid-2).
          LEFT is the live signal and what you can do with it: the player, then
          a preview of each packaged rendition. RIGHT is the context you consult
          while watching it: what the station says it is, whether QC is happy,
          and what the pipeline has been doing.
          minWidth:0 on both columns matters: without it a long monospace URL
          stretches its column and the page breaks out of its width. */}
      <div className="grid-2" style={{ alignItems: 'start' }}>
        <div style={{ display: 'grid', gap: 18, minWidth: 0 }}>
        {/* ---- player: visualiser instead of a 16:9 video ---- */}
        <div className="card" style={{ padding: 16, minWidth: 0 }}>
          {/* NOW PLAYING sits WITH the controls and the waveform, because they
              are one question: what is going out, and do I want to hear it.
              The row's geometry is fixed — 46px artwork, the monitor controls —
              so nothing resizes or shifts when the state changes. */}
          <div className="flex items-center gap-3" style={{ marginBottom: 12, minHeight: 46 }}>
            <div style={{
              width: 46, height: 46, borderRadius: 10, flex: 'none', overflow: 'hidden',
              background: 'var(--panel-3)', display: 'grid', placeItems: 'center',
            }}>
              {art && !artBroken
                ? <img src={art} alt="" onError={() => setArtBroken(true)}
                    style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                : <span style={{ fontSize: 'var(--fs-h3)', color: 'var(--faint)' }}>♪</span>}
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 min-w-0">
                <span style={{ fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {live ? (title || 'Untitled break') : 'Off air'}
                </span>
                <ClassChip cls={live ? titleClass : null} />
              </div>
              <div style={{ fontSize: 'var(--fs-sm)', color: 'var(--faint)' }}>
                {live
                  ? [np?.since ? `${fmtDur(Date.now() - np.since)} in` : 'on now',
                     st.pipeline.running ? `${np?.listeners ?? st.pipeline.listeners ?? 0} MP3 listeners` : null]
                    .filter(Boolean).join(' · ')
                  : 'Start the station to monitor the output'}
              </div>
            </div>
            {/* ONE CONTROL, and it is only about YOUR EARS. Muted is the normal
                state: an operator watching a station is watching the waveform,
                and only occasionally needs to hear it. Nothing here touches the
                broadcast, the recording, or the meter. */}
            <div className="icon-btn"
              title={!live ? 'Start the station to monitor it'
                     : muted ? 'Unmute: hear the output on this device'
                             : 'Mute: the station keeps broadcasting'}
              {...pressable(() => { if (live) setMuted(m => !m) },
                            { disabled: !live, pressed: !muted,
                              label: muted ? 'Unmute' : 'Mute' })}
              data-a11y-click="">
              {muted
                ? <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M11 5 6 9H2v6h4l5 4V5zM23 9l-6 6M17 9l6 6" /></svg>
                : <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M11 5 6 9H2v6h4l5 4V5zM15.5 8.5a5 5 0 0 1 0 7M19 5a9 9 0 0 1 0 14" /></svg>}
            </div>
            <input type="range" min={0} max={1} step={0.02} value={vol} onChange={e => setVol(Number(e.target.value))}
              style={{ width: 110, flex: 'none' }} />
          </div>
          {/* WHY YOU CAN HEAR NOTHING. Shown only while unmuted, when no
              audio could be attached. The alternative, which is what this page
              did before, is silence that looks identical to a muted laptop. */}
          {playing && playError && (
            <div className="banner warn" role="status" style={{ marginTop: 8 }}>
              <strong>No sound from this station.</strong> {playError}
              {st?.outputs?.degraded && Object.keys(st.outputs.degraded).length > 0 && (
                <div className="muted" style={{ marginTop: 4, fontSize: 12 }}>
                  The encoder dropped: {Object.entries(st.outputs.degraded)
                    .map(([k, v]) => `${k.toUpperCase()} (${v})`).join(', ')}
                </div>
              )}
            </div>
          )}
          {/* ONE waveform, and it is the BROADCAST OUTPUT: server-measured levels
              from the packager, drawn whether or not anyone is listening. Mute
              and Stop listening cannot change a single bar of it. */}
          <AudioVisualizer media={mediaEl} height={230}
            levels={levels?.samples} verdict={verdict} live={live}
            idleText="Station is off"
            /* SAME CALL TO ACTION AS A CHANNEL. On the channel page the idle
               video surface carries the big "▶ Start channel" button with
               the source URL under it; the audio surface is the same surface for
               radio, so it gets the same affordance rather than a flat caption.
               One primary start button on the page: this and the header button
               call the same startStop('start'). */
            idleOverlay={
              <div>
                <button className="btn primary" disabled={busy} onClick={() => startStop('start')}
                  style={{ transform: 'scale(1.05)' }}
                  title="Brings the audio pipeline up and starts receiving the source">
                  {busy ? 'Starting…' : '▶  Start station'}
                </button>
                {srcUrl && (
                  <div style={{ marginTop: 10, fontSize: 'var(--fs-label)', color: 'var(--faint)', maxWidth: 340, wordBreak: 'break-all' }}>
                    {srcUrl}
                  </div>
                )}
              </div>
            } />
          {live && (
            <div className="flex flex-wrap items-center gap-3" style={{ marginTop: 8, fontSize: 'var(--fs-xs)', color: 'var(--faint)' }}>
              <span>Measured from the broadcast output</span>
              {levels?.level && <span style={{ fontFamily: 'ui-monospace,monospace' }}>
                peak {levels.level.peakDb.toFixed(1)} dBFS · rms {levels.level.rmsDb.toFixed(1)} dBFS · crest {levels.level.crestDb.toFixed(1)} dB
              </span>}
              {levels?.lastSampleAt && <span>updated {Math.max(0, Math.round((Date.now() - levels.lastSampleAt) / 1000))}s ago</span>}
            </div>
          )}
          <audio ref={audioRef} crossOrigin="anonymous" style={{ display: 'none' }} />
        </div>

        {/* ---- OUTPUT PREVIEWS: verify each generated stream on its own ----
             This sits under the player, not in the metadata column, because it
             is playback: the operator checks MP3, then HLS, then DASH without
             leaving the surface that shows the signal. */}
        <div className="card" style={{ padding: 16, minWidth: 0 }}>
          <div className="sec-label">{onAir ? 'Output previews (public URLs)' : 'Output previews (private URLs)'}</div>
          <div className="hintxt" style={{ marginTop: -4, marginBottom: 8 }}>
            {onAir
              ? 'These URLs are open to the public. Each player below checks one packaged format independently.'
              : 'Private monitoring URLs. Go on air to open the public ones. Each player checks one packaged format independently.'}
          </div>
          {(onAir
            ? ([['MP3', st.publicUrls?.mp3, 'mp3'], ['HLS', st.publicUrls?.hls, 'hls'], ['DASH', st.publicUrls?.dash, 'dash']] as const)
            : ([['MP3', st.outputs.mp3, 'mp3'], ['HLS', st.outputs.hls, 'hls'], ['DASH', st.outputs.dash, 'dash']] as const)
          ).map(([label, url, kind]) => (
            <OutputPreview key={label} label={label} url={url || null} kind={kind}
              // WHY IT IS OFF, NOT JUST THAT IT IS OFF.
              //
              // This row said "disabled" for two completely different
              // situations: the operator turned MP3 off in Settings, and the
              // encoder DROPPED it at launch because the Icecast relay was not
              // reachable. The second is a fault in the environment, and
              // "disabled" reads as a decision somebody made on purpose, so
              // nobody goes looking for the relay.
              //
              // The reason is already in the payload — radio.py reports
              // output.degraded and the API returns it as outputs.degraded —
              // it simply was not being shown.
              reason={st.outputs.degraded?.[kind] || null}
              off={!cfgOutputs[kind]}
              playing={preview === label} onToggle={() => {
                // one sound at a time: a preview mutes live monitoring, and vice versa
                setPreview(cur => { const next = cur === label ? null : label; if (next) setMuted(true); return next })
              }}
              onCopy={() => url && copy(url)} />
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

        {/* ---- station metadata, QC and pipeline history ---- */}
        <div style={{ display: 'grid', gap: 18, minWidth: 0 }}>
          <div className="card" style={{ padding: 16, minWidth: 0 }}>
            <div className="sec-label">Station metadata</div>
            {st.icy?.station?.name || np?.station?.name ? (
              <div style={{ display: 'grid', gap: 6, fontSize: 'var(--fs-body)' }}>
                <MetaRow k="Station" v={np?.station?.name || st.icy?.station?.name} />
                <MetaRow k="Genre" v={np?.station?.genre || st.icy?.station?.genre} />
                <MetaRow k="Website" v={np?.station?.url || st.icy?.station?.url} />
                <MetaRow k="Source bitrate" v={(np?.station?.bitrateKbps || st.icy?.station?.bitrateKbps) ? `${np?.station?.bitrateKbps || st.icy?.station?.bitrateKbps} kbps` : undefined} />
                <MetaRow k="Content type" v={np?.station?.contentType || st.icy?.station?.contentType} />
                <MetaRow k="Title changes" v={st.icy ? String(st.icy.changes) : undefined} />
              </div>
            ) : <div style={{ fontSize: 'var(--fs-sm)', color: 'var(--faint)' }}>{icyCapable
                  ? 'ICY headers appear here once the source connects and announces itself.'
                  : `This station's source is ${srcLabel}, which carries no ICY metadata. Station name, genre and now-playing come from an Icecast mount; there is nothing here to wait for.`}</div>}
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

        {/* ---- event log: lifecycle, input/encoder errors and QC alarms.
                It lives in this column, not full width below, because it is read
                ALONGSIDE the gates and QC when something looks wrong. ---- */}
        <div className="card" style={{ padding: 16, minWidth: 0 }}>
          <div className="flex items-center" style={{ gap: 8 }}>
            <div className="sec-label" style={{ margin: 0 }}>Event log</div>
            <div style={{ flex: 1 }} />
            {!!st.log?.length && (
              <button className="btn ghost" disabled={clearingLog} onClick={clearLog}
                title="Remove this station's log entries. Other streams are untouched, and one entry recording the clear is kept."
                style={{ padding: '3px 9px', fontSize: 'var(--fs-xs)' }}>
                {clearingLog ? 'Clearing…' : 'Clear'}
              </button>
            )}
          </div>
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
                  <span title={e.detail} style={{ fontSize: 'var(--fs-sm)', color: 'var(--muted)', flex: 1, minWidth: 0, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{e.detail}</span>
                </div>
              ))}
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
              <div key={c} className={`chip ${cls === c ? 'active' : ''}`} style={{ padding: '3px 10px', fontSize: 'var(--fs-sm)' }} {...pressable((e: any) => { ((() => setCls(c)) as any)(e) })} data-a11y-click="">
                {c === 'all' ? `All ${total}` : `${CLASS_LABEL[c]} ${counts[c] ?? 0}`}
              </div>
            ))}
          </div>
          <input className="inp" style={{ width: 260, maxWidth: '100%', marginLeft: 'auto' }} value={q} onChange={e => setQ(e.target.value)}
            placeholder="Search titles…" />
        </div>
        {!log || log.entries.length === 0 ? (
          <div style={{ fontSize: 'var(--fs-sm)', color: 'var(--faint)', padding: '14px 4px' }}>
            {q.trim() ? 'No entries match.'
              : icyCapable
                ? 'Entries appear while the station runs with the metadata log enabled: every now-playing change is captured with its time, classified as song, ad or content, and becomes searchable here and in Recordings.'
                : `This station's source is ${srcLabel}. Now-playing titles arrive as ICY metadata on an Icecast mount, so this log stays empty for ${srcLabel} sources. Recording, clipping and QC are unaffected; only the title log depends on the source protocol.`}
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
    <div {...pressable((e: any) => { ((onClose) as any)(e) })} data-a11y-click="" style={{ position: 'fixed', inset: 0, background: 'rgba(2,6,14,.6)', zIndex: 60, display: 'grid', placeItems: 'center', padding: 20 }}>
      <div {...pressable((e: any) => { (((e: any) => e.stopPropagation()) as any)(e) })} data-a11y-click="" style={{ width: 'min(920px,96vw)', maxHeight: '92vh', overflow: 'auto', background: 'var(--panel,#0e1420)', border: '1px solid var(--border)', borderRadius: 14, padding: 20 }}>
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

/** The five-gate strip — same markup, sizing and arrows as the channel page,
 *  so a station and a channel read identically at a glance. */
/* ============================================================================
   OUTPUT PREVIEW — one packaged format, checked on its own.
   
   Deliberately NOT a waveform. The waveform above answers "is the signal
   good"; this answers a different question, "does THIS rendition actually
   play", so it is a play button, an elapsed clock and any error the player
   reported. MP3 plays natively, HLS via hls.js (native on Safari) and DASH via
   dash.js, all into one hidden element so nothing here can be heard twice.
   The URL and Copy stay on the row: verifying and sharing are the same errand.
   ========================================================================== */
function OutputPreview({ label, url, kind, playing, onToggle, onCopy, reason, off }: {
  label: string; url: string | null; kind: 'mp3' | 'hls' | 'dash'
  playing: boolean; onToggle: () => void; onCopy: () => void
  /** Why the encoder dropped this output at launch, when it did. */
  reason?: string | null
  /** Turned off in Settings, which is a decision rather than a fault. */
  off?: boolean
}) {
  const ref = useRef<HTMLAudioElement | null>(null)
  const [err, setErr] = useState('')
  const [secs, setSecs] = useState(0)

  useEffect(() => {
    const a = ref.current
    if (!a) return
    let killed = false
    let hls: any = null
    let dash: any = null
    setErr('')
    async function attach() {
      if (!playing || !url || !a) return
      // HLS and DASH here are fMP4/AAC. A browser without an AAC decoder (a
      // plain Chromium build, some Linux Firefox packages) fails deep inside
      // the player with a codec error that reads like a stream fault. Say what
      // it actually is, so nobody goes hunting for a packaging bug.
      if (kind !== 'mp3' && typeof MediaSource !== 'undefined'
          && !MediaSource.isTypeSupported('audio/mp4; codecs="mp4a.40.2"')
          && !a.canPlayType('application/vnd.apple.mpegurl')) {
        setErr('this browser cannot decode AAC'); return
      }
      try {
        if (kind === 'mp3' || a.canPlayType('application/vnd.apple.mpegurl')) {
          if (kind === 'mp3' || kind === 'hls') { a.src = url; await a.play(); return }
        }
        if (kind === 'hls') {
          const Hls = (await import('hls.js')).default
          if (killed) return
          if (!Hls.isSupported()) { setErr('HLS is not supported in this browser'); return }
          hls = new Hls({ liveDurationInfinity: true })
          hls.loadSource(url); hls.attachMedia(a)
          hls.on(Hls.Events.MANIFEST_PARSED, () => a.play().catch(() => {}))
          hls.on(Hls.Events.ERROR, (_e: any, d: any) => { if (d?.fatal) setErr(d.details || 'playback failed') })
          return
        }
        const dashjs: any = (await import('dashjs')).default
        if (killed) return
        dash = dashjs.MediaPlayer().create()
        dash.initialize(a, url, true)
        try { dash.on(dashjs.MediaPlayer.events.ERROR, (e: any) => setErr(e?.error?.message || 'playback failed')) } catch { /* ignore */ }
      } catch (e: any) { setErr(e?.message || 'playback failed') }
    }
    if (playing) attach()
    else { a.pause(); a.removeAttribute('src'); a.load(); setSecs(0) }
    return () => {
      killed = true
      if (hls) { try { hls.destroy() } catch { /* ignore */ } }
      if (dash) { try { dash.reset() } catch { /* ignore */ } }
    }
    /* eslint-disable-next-line */
  }, [playing, url, kind])

  useEffect(() => {
    if (!playing) return
    const t = setInterval(() => setSecs(Math.floor(ref.current?.currentTime || 0)), 1000)
    return () => clearInterval(t)
  }, [playing])

  const state = err ? err : playing ? `playing · ${fmtDur(secs * 1000)}` : ''
  return (
    <div className="flex items-center gap-2" style={{ padding: '7px 0', borderBottom: '1px solid var(--border)', minWidth: 0 }}>
      <button className="icon-btn" disabled={!url} onClick={onToggle} aria-label={playing ? `Stop ${label} preview` : `Play ${label} preview`}
        title={url ? (playing ? `Stop the ${label} preview` : `Play the ${label} output`) : `${label} output is disabled`}
        style={{ flex: 'none', opacity: url ? 1 : .4, cursor: url ? 'pointer' : 'default' }}>
        {playing
          ? <svg viewBox="0 0 24 24" fill="currentColor" stroke="none"><rect x="6" y="5" width="4" height="14" rx="1" /><rect x="14" y="5" width="4" height="14" rx="1" /></svg>
          : <svg viewBox="0 0 24 24" fill="currentColor" stroke="none"><path d="M8 5v14l11-7z" /></svg>}
      </button>
      <span style={{ width: 42, flex: 'none', fontSize: 'var(--fs-label)', fontWeight: 700, color: url ? 'var(--brand)' : 'var(--faint)' }}>{label}</span>
      <span title={url || undefined} style={{
        flex: 1, minWidth: 0, fontFamily: 'ui-monospace,monospace', fontSize: 'var(--fs-xs)',
        color: url ? 'var(--muted)' : 'var(--faint)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
      }}>{url || (off ? 'turned off in Settings'
                  : reason ? `unavailable — ${reason}`
                  : 'not available')}</span>
      {!url && !off && reason && (
        // Amber, not grey. A dropped output is a fault to go and fix, and it
        // sat next to the healthy ones in the same flat grey for weeks.
        <span style={{ flex: 'none', fontSize: 'var(--fs-micro)', color: 'var(--warn)', fontWeight: 700 }}>DEGRADED</span>
      )}
      {state && <span style={{ flex: 'none', fontSize: 'var(--fs-micro)', color: err ? '#fca5a5' : '#4ade80' }}>{state}</span>}
      {url && <button className="btn ghost" style={{ padding: '3px 10px', fontSize: 'var(--fs-sm)', flex: 'none' }} onClick={onCopy}>Copy</button>}
      <audio ref={ref} crossOrigin="anonymous" style={{ display: 'none' }} />
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
