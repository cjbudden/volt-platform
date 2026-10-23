import { useEffect, useMemo, useRef, useState, type CSSProperties, type Dispatch, type ReactElement, type SetStateAction } from 'react'
import { api, originUrl, thumbUrl, type AccessCheck, type ChannelDetail as CD, type ChannelSettingsPatch, type WatermarkCfg, type FailoverMode, type FailoverTestState } from '../api'
import { navigate } from '../router'
import { TypePicker, MetadataForm } from '../ContentTypeFields'
import { RuleEditor } from '../RuleEditor'
import { subscribeLive } from '../liveStatus'
import { useRecordWatch, LiveEditNotice } from '../liveRecord'
import { useProtocols, SourceInput, hlsChoicePending, sourceFromRow, sourceProblem, sourceToApi, type SourceValue } from '../protocols'
import { COUNTRIES, countryName } from '../lib/countries'
import { useInputChecks, verdictOf, summaryOf, LevelDot, inputName, heightOf, type InputDef } from '../sourceInputs'
import { PackageRenditions, pkgFromSources, pkgToSources, type PkgRow, type PkgFallback } from '../PackageRenditions'
import { WatermarkFields } from '../WatermarkFields'
import { GraphicsSettings, type GraphicsValue } from '../GraphicsSettings'
import { ImageRefField, GuideIconField } from '../ImageRefField'
import { LangPicker, useCaptionLanguages } from '../LangPicker'
import { RecordingSection, RET_UNIT_SEC, splitDuration, PipelineStrip, type StripGate, GATE_COLOR, RecoveryNote, DiagnosisBlock, DrawerTabs, TabPane, type DrawerTab, type RetUnit } from '../scaffold'
import DeleteChannelDialog from '../DeleteChannelDialog'
import { usePageNotice, useNotify, PageError, FormStatus, Notice } from '../notices'
import { useAccess, ReadOnlyBadge } from '../access'
// The meter reads the SAME quantity as the radio waveform and the clipping
// workbench: linear peak amplitude. See audioLevel.ts.
import { analyserPeak } from '../audioLevel'
import { ShareDrawer } from '../ShareDrawer'
import { EmbedDrawer } from '../EmbedDrawer'
import { pressable } from '../a11y'
import { FillerField } from '../FillerField'
import { OutputUrls } from '../OutputUrls'
import { PanelLayout } from '../panelLayout'
import { useStatsPanel } from '../useStatsPanel'
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
  // ACCESS (access.tsx): view opens the page; operate = start/stop, on/off
  // air, auto connect, failover switching; manage = settings.
  const { can, isAdminTier } = useAccess()
  const [delOpen, setDelOpen] = useState(false)
  const canRun = can('channels', 'operate')
  const canManage = can('channels', 'manage')
  const [d, setD] = useState<CD | null>(null)
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  // "Edit settings" from a list row opens the page with ?settings: open the
  // drawer straight away, then drop the flag so a reload does not reopen it.
  const [settingsOpen, setSettingsOpen] = useState(() => new URLSearchParams(window.location.search).has('settings'))
  useEffect(() => {
    if (new URLSearchParams(window.location.search).has('settings')) window.history.replaceState(window.history.state, '', window.location.pathname)
  }, [])
  const [qcOpen, setQcOpen] = useState(false)
  const [shareOpen, setShareOpen] = useState(false)
  const [embedOpen, setEmbedOpen] = useState(false)
  const [confirmStart, setConfirmStart] = useState(false)
  const [nowMs, setNowMs] = useState(Date.now())

  async function load() {
    // Clearing `err` on success is half the fix; the other half is at the
    // render guard below. Between them, a transient failure no longer sticks.
    try { setD(await api.channel(id)); setErr('') } catch (e: any) { setErr(e.message) }
  }
  useEffect(() => { load(); /* eslint-disable-next-line */ }, [id])
  // A failure while the channel is on screen: in the page notice region
  // (notices.tsx), over the working page, never instead of it.
  usePageNotice('action', err && d ? { kind: 'error', message: err, onDismiss: () => setErr('') } : null)
  // LIVE STATUS via SSE (production path): the shared client pushes a change for this
  // channel (or a resync on (re)connect); we refetch the detail so gates/output/actions
  // reflect reality (Starting -> Available, Stop appears, errors surface). One socket
  // for the whole app, debounced refetch. No polling.
  useEffect(() => {
    let t: ReturnType<typeof setTimeout> | null = null
    const refetch = () => { if (t) return; t = setTimeout(() => { t = null; load() }, 350) }
    const unsub = subscribeLive(`channel:${id}`, refetch)
    return () => { if (t) clearTimeout(t); unsub() }
    // eslint-disable-next-line
  }, [id])
  // SSE pushes on state CHANGES; segment writes are not a change event, so a slow
  // reconcile keeps continuous signals fresh (output-advancing, billing) without a
  // per-second poll. 6s is gentle and steady.
  useEffect(() => {
    const iv = setInterval(() => { load() }, 6000)
    return () => clearInterval(iv)
    // eslint-disable-next-line
  }, [id])
  // tick the billing clock once a second while the server is up (metering)
  useEffect(() => {
    if (!d?.billing?.billable) return
    const iv = setInterval(() => setNowMs(Date.now()), 1000)
    return () => clearInterval(iv)
  }, [d?.billing?.billable])

  // "On air" is a REAL backend state now (channels.on_air), decoupled from the source:
  // you bring the SOURCE up, confirm the packaged output is valid (private preview), and
  // only THEN take it on air. Publishing opens the public URL /live/:id/...; the backend
  // refuses to go on air until the output has valid content. `published` is the operator
  // intent (button state); `d.onAir` is truly-live-to-public (published AND valid content).
  const published = !!(d as any)?.on_air
  const sourceUp = d?.status === 'live'
  const [pubBusy, setPubBusy] = useState(false)
  async function setAir(on: boolean) {
    if (!d) return
    setPubBusy(true)
    try { await api.setAir(d.id, on); await load() }
    catch (e: any) { setErr(e.message) }
    finally { setPubBusy(false) }
  }

  async function sendSource() {
    if (!d) return
    setBusy(true)
    try {
      await api.startStop(d.id, 'start')
      // give ffmpeg a moment to emit the first segments, then refresh a few times
      for (let i = 0; i < 4; i++) { await new Promise(r => setTimeout(r, 1500)); await load() }
    } catch (e: any) { setErr(e.message) } finally { setBusy(false) }
  }
  // CLEAR QC: a clean slate for the health model (POST /channels/:id/reset-health).
  const notify = useNotify()
  const [resetBusy, setResetBusy] = useState(false)
  async function resetQc() {
    if (!d) return
    setResetBusy(true)
    try {
      const r = await api.resetChannelHealth(d.id)
      await load()
      notify(r.primaryError
        ? { kind: 'warn', message: `QC cleared, but ${r.primaryError.label.toLowerCase()} is still failing now: ${r.primaryError.message}` }
        : { kind: 'ok', message: r.was === 'error' || r.was === 'degraded' ? 'QC cleared: the earlier errors are in the event log.' : 'QC cleared.' })
    } catch (e: any) { setErr(e.message) } finally { setResetBusy(false) }
  }
  async function dropSource() {
    if (!d) return
    setBusy(true)
    // stopping the encoder also takes the channel off air on the backend
    try { await api.startStop(d.id, 'stop'); await load() } catch (e: any) { setErr(e.message) } finally { setBusy(false) }
  }

  // ONLY when there is nothing to show. `err` is also written by Go on air,
  // by adding a source and by dropping one, so an unconditional guard here
  // meant a single rejected action — a 409 from the air gate, a blip on the
  // six-second poll — replaced the entire page, players and Stop button
  // included, with one line of red text, mid-broadcast, with no way back
  // except navigating away. A failure that happened while we already have the
  // channel loaded is shown as a banner over the working page instead.
  if (err && !d) return <PageError title="Couldn't load this channel." message={err} onRetry={() => { setErr(''); load() }} />
  if (!d) return <div className="loading">Loading channel…</div>

  const live = published && sourceUp
  // Badge + error now come from the five-gate health model — NOT from "output isn't
  // Available yet" (which was warm-up, wrongly shown as an error). A badge only turns
  // red when a gate is actually failed/degraded, and it names WHICH gate.
  const health = d.health
  const perr = health?.primaryError || null
  const errored = !!perr
  const outGate = health?.gates.find(g => g.gate === 'output')
  const outputReady = outGate?.status === 'healthy'   // output packaged + advancing
  // ONE consistent status: the header uses the SAME `overall` roll-up the list uses, so
  // they never disagree. error > degraded > on air > ready > starting > stopped/idle.
  const ov = d.health?.overall || (sourceUp ? 'starting' : 'idle')
  const OVMAP: Record<string, { label: string; cls: string }> = {
    onair: { label: 'ON AIR', cls: 'live' },
    ready: { label: 'READY', cls: 'sched' },
    starting: { label: 'STARTING', cls: 'sched' },
    degraded: { label: 'DEGRADED', cls: 'warn' },
    error: { label: perr ? `${perr.label.toUpperCase()} ERROR` : 'ERROR', cls: 'down' },
    stopped: { label: 'STOPPED', cls: 'idle' },
    idle: { label: 'IDLE', cls: 'idle' },
  }
  const stateLabel = (OVMAP[ov] || OVMAP.idle).label
  const stateCls = (OVMAP[ov] || OVMAP.idle).cls
  const isEvent = d.dvr_mode === 'event_start'
  const wt = d.profile?.workflow_type
  const captionLangs = d.captions.targets.length ? d.captions.targets : ['en']
  const billingElapsed = d.billing?.since ? Math.max(0, Math.round((nowMs - d.billing.since) / 1000)) : (d.billing?.elapsedSec || 0)
  // the encoder server is up (live, warming, or erroring-but-not-yet-ended) -> a Stop must
  // always be available. A running instance is the authoritative signal.
  const hasRunningInstance = Array.isArray((d as any).instances) && (d as any).instances.length > 0
  const serverUp = sourceUp || hasRunningInstance || !!d.billing?.billable || health?.gates.find(g => g.gate === 'server')?.status === 'healthy'
  // NO SOURCE, NO START. A start with nowhere to pull from cannot succeed; it
  // used to be allowed and then reported as a failure. The button says why.
  const hasSource = d.sources.some(s => !!s.ingest_url)
  const noSourceTitle = 'No input source is configured. Set the primary input in Settings first.'

  return (
    <>
      <div className="page-head">
        <div>
          <div className="crumb" style={{ marginBottom: 6 }}>
            <span className="lnk" style={{ cursor: 'pointer', color: 'var(--brand)' }} {...pressable((e: any) => { ((onBack) as any)(e) })} data-a11y-click="">Channels</span>
            &nbsp;/&nbsp; <b style={{ color: 'var(--text)' }}>{d.name}</b>
          </div>
          {/* identity row: same classes/tokens as every other detail page */}
          <h1 className="page-id">
            {(d as any).brand_ref
              ? <span className="dthumb" style={{ background: '#0b0f16', overflow: 'hidden', padding: 0 }}><img src={thumbUrl((d as any).brand_ref, 96, 96, 'inside')} alt="" style={{ width: '100%', height: '100%', objectFit: 'contain' }} /></span>
              : <span className="dthumb" style={{ background: 'linear-gradient(135deg,#1d4ed8,#3b82f6)' }}>{d.name.split(/\s+/).slice(0, 2).map(w => w[0]).join('').toUpperCase()}</span>}
            {d.name}
            <span className={`tag type ${wt === 'transcode' ? 'chan' : 'event'}`}>{wt === 'transcode' ? 'Transcode' : 'Packaging'}</span>
            <span className={`tag ${stateCls}`}><span className={`dot-s ${stateCls}`} />{stateLabel}</span>
            {d.billing?.billable && (
              <span title="Server up, live time metering"
                style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 'var(--fs-sm)', padding: '3px 9px', borderRadius: 999, background: 'rgba(251,191,36,.14)', border: '1px solid rgba(251,191,36,.4)', color: '#fbbf24' }}>
                ● billable · {fmtDur(billingElapsed)}
              </span>
            )}
          </h1>
          <p>
            {isEvent ? 'Event' : '24/7'} · DVR {isEvent ? 'to event start' : fmtWindow(d.dvr.effective_sec)}
            {d.dvr.capped && <span style={{ color: 'var(--warn)' }}> (capped 4h)</span>}
            {' · '}{(d.sources[0]?.protocol || 'SRT').toUpperCase()} ingest · {d.profile?.packaging === 'both' ? 'HLS + DASH' : (d.profile?.packaging || 'HLS').toUpperCase()}
            {d.captions.enabled ? ' · captions on' : ''}
            {d.watermark?.enabled && d.profile?.workflow_type === 'transcode' ? ' · Watermark on' : ''}
            {d.geo_mode !== 'worldwide' ? ` · geo ${d.geo_mode}` : ''}
          </p>
        </div>
        <div className="spacer" />
        {/* SECONDARY ACTIONS AS ICONS, named on hover (data-tip) and to screen
            readers (aria-label). Remove is not here: it is at the foot of the
            page, away from the buttons people press every day. */}
        <div className="icon-actions">
          <button className={`btn ghost icon-btn${errored ? ' alert' : ''}`} onClick={() => setQcOpen(true)}
            data-tip={errored ? 'QC: something failed, diagnose it' : 'QC: diagnose the pipeline'} aria-label="QC">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 3l7.5 3v5.5c0 4.6-3.2 8.4-7.5 9.5-4.3-1.1-7.5-4.9-7.5-9.5V6L12 3z" /><path d="M8.8 12.2l2.2 2.2 4.3-4.6" /></svg>
          </button>
          {canRun && (
            <button className="btn ghost icon-btn" onClick={resetQc} disabled={resetBusy}
              data-tip={resetBusy ? 'Clearing…' : 'Clear QC: reset errors and judge the channel afresh'} aria-label="Clear QC">
              <svg className={resetBusy ? 'spin' : undefined} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 12a9 9 0 1 0 2.6-6.4L3 8" /><path d="M3 3v5h5" /></svg>
            </button>
          )}
          {can('sharing', 'manage') && (
            <button className="btn ghost icon-btn" onClick={() => setShareOpen(true)} data-tip="Share a private preview link" aria-label="Share">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M4 12v7a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-7" /><path d="M16 6l-4-4-4 4" /><path d="M12 2v14" /></svg>
            </button>
          )}
          {can('apps', 'view') && (
            <button className="btn ghost icon-btn" onClick={() => setEmbedOpen(true)} data-tip="Embed player: a tag to put this channel on a website" aria-label="Embed player">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="2.5" y="4.5" width="19" height="15" rx="2.5" /><path d="M10 9.2v5.6l4.6-2.8z" fill="currentColor" stroke="none" /></svg>
            </button>
          )}
          {canManage && (
            <button className="btn ghost icon-btn" onClick={() => { setSettingsOpen(true); onOpenSettings?.() }} data-tip="Settings" aria-label="Settings">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" /></svg>
            </button>
          )}
        </div>
        {!canRun ? <ReadOnlyBadge feature="channels" /> : !serverUp ? (
          <button className="btn primary" disabled={busy || !hasSource} onClick={() => setConfirmStart(true)}
            title={hasSource ? 'Brings the encoder up and begins ingesting the configured source' : noSourceTitle}>
            {busy ? 'Starting…' : hasSource ? 'Start channel' : 'Start channel (no source)'}
          </button>
        ) : (
          <>
            {/* On air is an explicit operator action; Take off air stops publishing but
                keeps the encoder up. Stop channel brings the whole encoder down. You can
                only go on air once the output is producing valid content. */}
            {!published ? (
              <button className="btn primary" disabled={errored || !outputReady || pubBusy}
                onClick={() => setAir(true)}
                title={errored ? 'Resolve the error first' : !outputReady ? 'Output must be producing valid content first' : 'Open the public URL and go on air'}>
                <span className="dot-s live" style={{ marginRight: 6 }} />{pubBusy ? 'Going on air…' : 'Go on air'}
              </button>
            ) : (
              <button className="btn ghost" disabled={pubBusy} onClick={() => setAir(false)} title="Close the public URL (encoder stays up, preview keeps playing)">
                {pubBusy ? 'Taking off air…' : 'Take off air'}
              </button>
            )}
            {/* Stop is ALWAYS available while the server is up (live, warming, or erroring) */}
            <button className="btn ghost" disabled={busy} onClick={dropSource} style={{ color: '#fca5a5', borderColor: 'rgba(248,113,113,.5)' }}>
              {busy ? 'Stopping…' : 'Stop channel'}
            </button>
          </>
        )}
      </div>

      {/* WHAT AUTO-CONNECT IS DOING. The give-up notice lived in the Settings
          drawer and only appeared once it had already stopped trying, so the
          whole middle of the story -- being retried, and why -- was invisible.
          UNDER THE HEADER, not above the breadcrumb: it belongs with the other
          failure banners it sits beside, and a notice floating above the page's
          own title reads as if it were about something else. */}
      <RecoveryNote row={d} state={d.health?.overall}
        onAutoConnect={canRun ? async (on) => { setBusy(true); try { await api.setAutoConnect('channel', d.id, on); await load() } catch (e: any) { setErr(e.message) } finally { setBusy(false) } } : undefined}
        togglingAuto={busy} />

      {perr && (
        <div style={{
          margin: '0 0 14px', padding: '12px 14px', borderRadius: 10,
          background: 'rgba(248,113,113,.10)', border: '1px solid rgba(248,113,113,.4)',
          display: 'flex', alignItems: 'center', gap: 12,
        }}>
          <span style={{ fontSize: 'var(--fs-h2)' }}>⚠</span>
          <div style={{ flex: 1 }}>
            <div style={{ fontWeight: 700, color: '#fca5a5' }}>{perr.label} {health?.gates.find(g => g.gate === perr.gate)?.status === 'degraded' ? 'degraded' : 'failed'}</div>
            <div style={{ fontSize: 'var(--fs-body)', color: 'var(--muted)', wordBreak: 'break-word' }}>{perr.message}</div>
          </div>
          <button className="btn ghost" onClick={() => setQcOpen(true)} style={{ color: '#fca5a5', borderColor: 'rgba(248,113,113,.5)' }}>Diagnose →</button>
        </div>
      )}

      <PipelineStrip gates={withMeters(d)} />

      {published && d.public?.url && (
        <div style={{
          margin: '0 0 14px', padding: '10px 14px', borderRadius: 10, display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap',
          background: d.onAir ? 'rgba(74,222,128,.10)' : 'rgba(248,113,113,.10)',
          border: `1px solid ${d.onAir ? 'rgba(74,222,128,.4)' : 'rgba(248,113,113,.4)'}`,
        }}>
          <span className="dot-s" style={{ background: d.onAir ? '#4ade80' : '#f87171' }} />
          <b style={{ color: d.onAir ? '#4ade80' : '#fca5a5' }}>{d.onAir ? 'ON AIR · public URL open' : 'ON AIR · public stream has no valid content'}</b>
          <code style={{ fontSize: 'var(--fs-sm)', color: 'var(--muted)', background: 'rgba(148,163,184,.12)', padding: '3px 8px', borderRadius: 6 }}>{d.public.url}</code>
          <a className="btn ghost" href={d.public.url} target="_blank" rel="noreferrer" style={{ marginLeft: 'auto', padding: '5px 12px' }}>Open public HLS</a>
          <a className="btn ghost" href={d.public.dashUrl} target="_blank" rel="noreferrer" style={{ padding: '5px 12px' }}>Open public DASH</a>
        </div>
      )}

      {/* THE PANELS, in the order this person chose (panelLayout.tsx, saved in this
          browser). Default: players, failover, guide, then the output URLs under
          the guide, viewers, and status with the event log. The header, the
          pipeline strip and the banners above, and Remove below, never move. */}
      <PanelLayout pageKey="channel" panels={[
        { id: 'players', label: 'Source and output players', node: (
          <DualPlayers d={d} captionLangs={captionLangs} sourceUp={sourceUp} onAir={published}
            onSendSource={() => setConfirmStart(true)} onGoLive={() => setAir(true)} busy={busy} />) },
        { id: 'failover', label: 'Failover control', node: <FailoverTestPanel d={d} sourceUp={sourceUp} /> },
        { id: 'epg', label: 'Programme guide', node: (
          <EpgStrip d={d}
            // ABSOLUTE path. navigate('events') was relative, so the browser resolved it
            // against /channels/<id> and landed on /channels/events, a channel called
            // "events" that does not exist. The guide for THIS channel lives here.
            onAddEpg={() => navigate(`/epg/channel/${encodeURIComponent(d.id)}`)}
            onHideEpg={async () => { try { await api.updateChannel(d.id, { epgEnabled: false }); await load() } catch (e: any) { setErr(e.message) } }} />) },
        { id: 'outputs', label: 'Output URLs', node: (
          <OutputUrls id={d.id} packaging={d.profile?.packaging} captions={!!d.captions?.enabled}
            publicOpen={!!d.onAir} kindLabel="channel" />) },
        { id: 'viewers', label: 'Realtime viewers', node: <ViewersCard d={d} live={live} /> },
        { id: 'status', label: 'Status board and event log', node: (
          <div className="grid-2">
            <StatusBoard d={d} live={live} />
            <EventLog d={d} />
          </div>) },
      ]} />

      {/* REMOVE, at the foot of the page: never next to Start, QC or Settings,
          so it cannot be hit by accident. The dialog still shows what goes with
          the channel and asks for its name. */}
      {isAdminTier && (
        <div className="danger-zone">
          <div>
            <div className="dz-t">Remove this channel</div>
            <div className="dz-d">{serverUp ? 'Stop the channel first. ' : ''}Removes the channel with its recordings, clips and guide. You will see exactly what goes and type the name to confirm.</div>
          </div>
          <button className="btn ghost danger" disabled={serverUp} onClick={() => setDelOpen(true)}
            title={serverUp ? 'Stop the channel before removing it' : undefined}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14" /></svg>Remove channel
          </button>
        </div>
      )}

      {settingsOpen && (
        <SettingsDrawer d={d} onClose={() => setSettingsOpen(false)}
          onSaved={() => { setSettingsOpen(false); load() }} />
      )}

      {qcOpen && <QcPanel d={d} onClose={() => setQcOpen(false)} onRefresh={load} />}

      {shareOpen && <ShareDrawer target={{ kind: 'channel', id: d.id, name: d.name }} onClose={() => setShareOpen(false)} />}
      {embedOpen && <EmbedDrawer target={{ kind: 'channel', id: d.id, name: d.name }} onClose={() => setEmbedOpen(false)} />}
      {delOpen && <DeleteChannelDialog id={d.id} onClose={() => setDelOpen(false)} onDeleted={() => { setDelOpen(false); onBack() }} />}

      {confirmStart && (
        <StartConfirm d={d} onCancel={() => setConfirmStart(false)}
          onConfirm={() => { setConfirmStart(false); sendSource() }} />
      )}
    </>
  )
}

/* ------------------------------------------- live readings on the gate strip */
export const fmtBps = (b: number) => b >= 1e6 ? `${(b / 1e6).toFixed(1)} Mbps` : b >= 1e3 ? `${Math.round(b / 1e3)} kbps` : `${b} bps`
export const fmtBytes = (n: number) => n >= 1e12 ? `${(n / 1e12).toFixed(2)} TB` : n >= 1e9 ? `${(n / 1e9).toFixed(2)} GB` : n >= 1e6 ? `${(n / 1e6).toFixed(1)} MB` : n >= 1e3 ? `${Math.round(n / 1e3)} kB` : `${n} B`
/**
 * The CPU reading on the Server box and the data received on the Input box,
 * only while the run is up and only when there is a real reading (absent is
 * shown as nothing, never as 0). See services/channelDetail.ts streamMetrics.
 */
/** Shared with the event page (EventDetail.tsx). */
export function withMeters(d: CD): StripGate[] {
  const gates: StripGate[] = (d.health?.gates || []).map(g => ({ ...g }))
  const m = d.metrics
  if (!m || d.status !== 'live') return gates
  const srv = gates.find(g => g.gate === 'server')
  if (srv && m.cpu) {
    const pct = Math.round(m.cpu.pct)
    srv.meter = m.cpu.source === 'encoder'
      ? { text: `CPU ${pct}%`, warn: pct >= 85, title: `This encoder's CPU: ${m.cpu.pct}% of the ${m.cpu.cores ?? '?'} core${m.cpu.cores === 1 ? '' : 's'} it may use (its own processes, read every 10 s).` }
      : { text: `host CPU ${pct}%`, warn: pct >= 85, title: `The whole server's CPU, sampled ${Math.max(0, Math.round((Date.now() - m.cpu.atMs) / 1000))} s ago${m.cpu.tasksOnHost ? `; ${m.cpu.tasksOnHost} stream${m.cpu.tasksOnHost === 1 ? '' : 's'} on it` : ''}. This encoder cannot measure itself here.` }
  }
  const inp = gates.find(g => g.gate === 'input')
  if (inp && m.ingest.length) {
    const rate = m.ingest.reduce((a, x) => a + (x.bps ?? 0), 0)
    const total = m.ingest.reduce((a, x) => a + (x.bytes ?? 0), 0)
    const hasRate = m.ingest.some(x => x.bps != null)
    const whole = m.ingest.length === 1 && m.ingest[0].key === 'network'
    inp.meter = {
      text: `${hasRate ? fmtBps(rate) : '…'} · ${fmtBytes(total)}`,
      title: (whole ? 'Received over the network by the whole encoder (all inputs together)' : 'Received per input')
        + ', the rate over the last 10 s and the total since the run started:\n'
        + m.ingest.map(x => `${x.key === 'network' ? 'network in' : `${x.label ?? ''} ${x.role === 'backup' ? 'backup' : ''}`.trim()}: ${x.bps != null ? fmtBps(x.bps) : '…'}, ${x.bytes != null ? fmtBytes(x.bytes) : '…'}`).join('\n'),
    }
  }
  return gates
}

/* --------------------------------------------------------- billing helpers */
function fmtDur(sec: number): string {
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60
  return (h ? `${h}:${String(m).padStart(2, '0')}` : `${m}`) + ':' + String(s).padStart(2, '0')
}

/* Confirm that starting the encoder begins billing (the server is the meter). */
function StartConfirm({ d, onCancel, onConfirm }: { d: CD; onCancel: () => void; onConfirm: () => void }) {
  const b = d.billing
  return (
    <div {...pressable((e: any) => { ((onCancel) as any)(e) })} data-a11y-click="" style={{ position: 'fixed', inset: 0, background: 'rgba(2,6,14,.6)', zIndex: 60, display: 'grid', placeItems: 'center', padding: 20 }}>
      <div {...pressable((e: any) => { (((e: any) => e.stopPropagation()) as any)(e) })} data-a11y-click="" style={{ width: 'min(460px,94vw)', background: 'var(--panel,#0e1420)', border: '1px solid var(--border)', borderRadius: 14, padding: 20 }}>
        <h2 style={{ margin: '0 0 6px' }}>Bring the encoder up?</h2>
        <p style={{ color: 'var(--muted)', marginTop: 0 }}>
          This starts the encoder for <b>{d.name}</b> and begins the source ingest. The encoder
          is the billable unit, so metering starts now and runs until you stop the channel.
        </p>
        {b && (
          <div style={{ margin: '12px 0', padding: '10px 12px', borderRadius: 10, background: 'rgba(251,191,36,.10)', border: '1px solid rgba(251,191,36,.35)', fontSize: 'var(--fs-body)' }}>
            <div style={{ color: '#fbbf24', fontWeight: 700 }}>● live time metering starts now</div>
            <div style={{ color: 'var(--muted)' }}>{b.instance} · runs until you stop the channel</div>
          </div>
        )}
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 8 }}>
          <button className="btn ghost" onClick={onCancel}>Cancel</button>
          <button className="btn primary" onClick={onConfirm}>Start encoder</button>
        </div>
      </div>
    </div>
  )
}

/* Always-visible five-gate pipeline strip: the model as the primary status view.
   The public gate now comes straight from the backend: READY (blue) when the output
   is valid but private, HEALTHY (green) when published AND serving valid content — we
   relabel that as ON AIR — and FAILED (red) when published but the public stream is
   broken. `onAir` (published intent) is accepted for API stability but the status is
   authoritative from the backend. */
/* ------------------------------------------------------------- QC / diagnose */
const GATE_META: Record<string, { icon: string; hint: string }> = {
  server:  { icon: '▣', hint: 'Encoder compute (this is the billable unit)' },
  input:   { icon: '⬇', hint: 'Is the source arriving?' },
  encoder: { icon: '⚙', hint: 'Transcode/package running & keeping up?' },
  output:  { icon: '⬆', hint: 'Are packaged segments advancing?' },
  public:  { icon: '📡', hint: 'Is the output being served to viewers?' },
}
/** Live captions for this run: a side lane in QC. Failed captions never turn the channel red. */
function CaptionsLaneRow({ lane }: { lane?: { status: string; detail: string; engine: string | null; languages: string[]; hint: string | null; errors: number } | null }) {
  if (!lane) return null
  const c = GATE_COLOR[lane.status] || GATE_COLOR.idle
  return (
    <div style={{ margin: '-6px 0 18px', padding: '10px 12px', borderRadius: 10, border: `1px solid ${c}55`, background: `${c}12`, display: 'flex', gap: 14, alignItems: 'baseline', flexWrap: 'wrap' }}>
      <span style={{ fontSize: 'var(--fs-sm)', color: 'var(--muted)' }}>Captions{lane.engine ? ` · ${lane.engine}` : ''}</span>
      <b style={{ color: c, textTransform: 'uppercase', fontSize: 'var(--fs-body)' }}>{lane.status}</b>
      <span style={{ fontSize: 'var(--fs-sm)', color: 'var(--faint)', wordBreak: 'break-word', flex: '1 1 240px' }}>
        {lane.detail}{lane.errors ? ` · ${lane.errors} error${lane.errors === 1 ? '' : 's'}` : ''}
      </span>
      {lane.hint && lane.status === 'failed' && <span style={{ fontSize: 'var(--fs-sm)', color: 'var(--muted)', flexBasis: '100%' }}>How to fix: {lane.hint}</span>}
    </div>
  )
}

/** Shared with the event page (EventDetail.tsx). */
export function QcPanel({ d, onClose, onRefresh }: { d: CD; onClose: () => void; onRefresh: () => void }) {
  const h = d.health
  const gates = h?.gates || []
  return (
    <div {...pressable((e: any) => { ((onClose) as any)(e) })} data-a11y-click="" style={{ position: 'fixed', inset: 0, background: 'rgba(2,6,14,.6)', zIndex: 60, display: 'grid', placeItems: 'center', padding: 20 }}>
      <div {...pressable((e: any) => { (((e: any) => e.stopPropagation()) as any)(e) })} data-a11y-click="" style={{ width: 'min(920px,96vw)', maxHeight: '92vh', overflow: 'auto', background: 'var(--panel,#0e1420)', border: '1px solid var(--border)', borderRadius: 14, padding: 20 }}>
        <div style={{ display: 'flex', alignItems: 'center', marginBottom: 4 }}>
          <h2 style={{ margin: 0 }}>QC · pipeline diagnose</h2>
          <div style={{ flex: 1 }} />
          <button className="btn ghost" onClick={onRefresh} style={{ marginRight: 8 }}>Refresh</button>
          <button className="btn ghost" onClick={onClose}>Close</button>
        </div>
        <p style={{ color: 'var(--muted)', marginTop: 4 }}>
          Each stage is a gate — a later stage can only be healthy if the ones before it are.
          Red/amber shows exactly where the workflow is failing and why.
        </p>

        <DiagnosisBlock diag={h?.diagnosis} />
        {h?.primaryError && (
          <div style={{ margin: '10px 0 16px', padding: '12px 14px', borderRadius: 10, background: 'rgba(248,113,113,.10)', border: '1px solid rgba(248,113,113,.4)' }}>
            <div style={{ fontWeight: 700, color: '#fca5a5' }}>Primary issue — {h.primaryError.label}</div>
            <div style={{ fontSize: 'var(--fs-body)', color: 'var(--muted)' }}>{h.primaryError.message}</div>
          </div>
        )}

        {/* billing window (the server is the meter) */}
        {d.billing && (
          <div style={{ margin: '4px 0 14px', padding: '10px 12px', borderRadius: 10, border: '1px solid var(--border)', display: 'flex', gap: 18, flexWrap: 'wrap', fontSize: 'var(--fs-body)' }}>
            <span><span style={{ color: 'var(--faint)' }}>Billing </span>{d.billing.billable ? <b style={{ color: '#fbbf24' }}>● metering</b> : <b style={{ color: 'var(--muted)' }}>idle</b>}</span>
            <span><span style={{ color: 'var(--faint)' }}>Live time this run </span>{fmtDur(d.billing.elapsedSec)}</span>
            {d.server
              ? <span title={`${d.server.detail} Sized from ${d.server.sizedFrom}.`}><span style={{ color: 'var(--faint)' }}>Server </span>{d.server.headline}</span>
              : <span><span style={{ color: 'var(--faint)' }}>Server </span>assigned automatically</span>}
          </div>
        )}
        {/* capacity problems, in words, with the fix (services/fleet/serverStatus.ts) */}
        {d.server?.issue && (
          <div style={{ margin: '0 0 14px', padding: '12px 14px', borderRadius: 10, background: 'rgba(251,191,36,.10)', border: '1px solid rgba(251,191,36,.4)' }}>
            <div style={{ fontWeight: 700, color: '#fbbf24' }}>{d.server.issue.what}</div>
            <div style={{ fontSize: 'var(--fs-body)', color: 'var(--muted)', marginTop: 2 }}>{d.server.issue.ours ? '' : 'How to fix: '}{d.server.issue.fix}</div>
          </div>
        )}

        {/* the five gates, left to right */}
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', margin: '8px 0 18px' }}>
          {gates.map((g, i) => (
            <div key={g.gate} style={{ display: 'flex', alignItems: 'stretch', gap: 8, flex: '1 1 160px' }}>
              <div style={{ flex: 1, border: `1px solid ${GATE_COLOR[g.status]}55`, background: `${GATE_COLOR[g.status]}12`, borderRadius: 10, padding: '10px 12px' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 'var(--fs-sm)', color: 'var(--muted)' }}>
                  <span>{GATE_META[g.gate]?.icon}</span>{g.label}{g.billable && <span title="billable while up" style={{ marginLeft: 'auto', color: '#fbbf24', fontSize: 'var(--fs-micro)' }}>● billable</span>}
                </div>
                <div style={{ fontWeight: 700, color: GATE_COLOR[g.status], textTransform: 'uppercase', fontSize: 'var(--fs-body)', marginTop: 4 }}>{g.status}</div>
                <div style={{ fontSize: 'var(--fs-sm)', color: 'var(--faint)', marginTop: 2, wordBreak: 'break-word' }}>{g.detail}</div>
              </div>
              {i < gates.length - 1 && <div style={{ display: 'grid', placeItems: 'center', color: 'var(--faint)' }}>→</div>}
            </div>
          ))}
        </div>

        {/* the captions lane: beside the gates, never one of them (pipelineHealth.ts captionsLane) */}
        <CaptionsLaneRow lane={(h as any)?.captions} />

        {/* the real logs behind the gates */}
        <h3 style={{ margin: '10px 0 6px' }}>Real logs <span style={{ color: 'var(--faint)', fontWeight: 400, fontSize: 'var(--fs-sm)' }}>· encoder + pipeline events</span></h3>
        <div style={{ maxHeight: 320, overflowY: 'auto', overflowX: 'hidden', border: '1px solid var(--border)', borderRadius: 10 }}>
          {(d.log || []).length === 0 && <div style={{ padding: 14, color: 'var(--faint)' }}>No log lines yet.</div>}
          {(d.log || []).map((l, i) => (
            <div key={i} style={{ display: 'flex', gap: 10, padding: '7px 12px', borderTop: i ? '1px solid var(--border)' : undefined, fontSize: 'var(--fs-sm)', minWidth: 0 }}>
              <span className={`dot-s ${l.level}`} style={{ marginTop: 5, flexShrink: 0 }} />
              <span style={{ color: 'var(--faint)', width: 62, flexShrink: 0 }}>{l.ts}</span>
              <span title={l.title} style={{ fontWeight: 600, width: 96, flexShrink: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: l.level === 'down' ? '#fca5a5' : 'var(--muted)' }}>{l.title}</span>
              <LogDetail text={l.detail} style={{ color: 'var(--muted)' }} />
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

/* ------------------------------------------------------- share preview link */
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

// Live preview of the channel watermark, positioned to match the encoder overlay so
// brand / corner / offset can be validated in the player before (and without) burn-in.
// Offsets are output pixels; we approximate against a nominal 1080-high frame for preview.
/** Shared with the event page (EventDetail.tsx). */
export function DualPlayers({ d, captionLangs, sourceUp, onAir, onSendSource, onGoLive, busy }: {
  d: CD; captionLangs: string[]; sourceUp: boolean; onAir: boolean; onSendSource: () => void; onGoLive: () => void; busy: boolean
}) {
  const [subOn, setSubOn] = useState(true)
  const [subLang, setSubLang] = useState(captionLangs[0] || 'en')

  const outGate = d.health?.gates.find(g => g.gate === 'output')
  const outErr = outGate && (outGate.status === 'failed' || outGate.status === 'degraded')
  // Output is ready to watch (packaged + advancing) once its gate is healthy. We
  // preview the packaged DASH/HLS output as soon as it's ready — BEFORE going on air —
  // so the operator can confirm packaging works before publishing to the public.
  const outputReady = outGate?.status === 'healthy'
  return (
    <div className="player-grid" style={{ marginBottom: 18 }}>
      {/* SOURCE — shows the real incoming feed once a source is sent */}
      <SourcePlayer d={d} sourceUp={sourceUp} onSendSource={onSendSource} busy={busy} />

      {/* OUTPUT — an error panel wins over everything (never show a fake LIVE);
          otherwise preview the packaged output whenever it's ready (with a PREVIEW /
          ON AIR badge to say whether it's public), else the idle/go-live panel. */}
      {outErr
        ? <OutputError d={d} />
        : outputReady
          ? <HlsOutput d={d} onAir={onAir} captionLangs={captionLangs} subOn={subOn} setSubOn={setSubOn} subLang={subLang} setSubLang={setSubLang} />
          : <IdleOutput sourceUp={sourceUp} onGoLive={onGoLive}
              warming={d.health?.gates.find(g => g.gate === 'server')?.status === 'healthy'}
              sinceMs={d.billing?.since ?? null}
              captionsOn={!!d.captions?.enabled} isEvent={(d as any).kind === 'event'} />}
    </div>
  )
}

/* Output is failed/degraded: never show a green LIVE. Neutral panel + real reason. */
function OutputError({ d }: { d: CD }) {
  const g = d.health?.gates.find(x => x.gate === 'output')
  const degraded = g?.status === 'degraded'
  const col = degraded ? '#fbbf24' : '#f87171'
  return (
    <div className="player">
      <div className="video">
        <div className="grad" style={{ background: 'radial-gradient(120% 120% at 70% 20%,#2a1620 0%,#0b0f16 70%)' }} />
        <div className="plabel"><span className="pt" style={{ color: col }}>OUTPUT</span></div>
        {/* not LIVE: a neutral status badge that matches the real state */}
        <div className="badge-live" style={{ background: 'rgba(148,163,184,.25)', color: '#e5e7eb' }}><span className="d" style={{ background: col }} />{degraded ? 'DEGRADED' : 'NOT LIVE'}</div>
        <div style={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center', textAlign: 'center', padding: 20 }}>
          <div style={{ maxWidth: 360 }}>
            <div style={{ fontWeight: 700, color: col, marginBottom: 6 }}>{degraded ? 'Output degraded' : 'Output is not being produced'}</div>
            <div style={{ fontSize: 'var(--fs-body)', color: 'var(--muted)', wordBreak: 'break-word' }}>{g?.detail || 'the encoder is not delivering output'}</div>
          </div>
        </div>
        <div className="ptime">{degraded ? 'degraded' : 'no output'}</div>
      </div>
      <div className="pfoot">
        <span className="dot-s down" /> {d.health?.primaryError ? `${d.health.primaryError.label}: ${d.health.primaryError.message}` : 'output error'}
      </div>
    </div>
  )
}

// A minimal hls.js video element (used for the source preview). `src` may be an
// absolute URL (a real contribution feed) or an origin path. It ALWAYS plays at
// the live edge and re-snaps to live if it drifts back, so the preview shows now,
// not old content. If `fallbackSrc` is given and the primary source can't be
// played (e.g. the contribution CDN blocks cross-origin playback), it switches to
// the fallback so the pane is never dead.
type PreviewState = { s: 'loading' | 'playing' | 'fallback' | 'error'; detail?: string; /** which address is playing: 0 = src, 1.. = fallbacks in order */ via?: number }
function HlsVideo({ src, fallbackSrc, hostRef, kind = 'hls', preferHeight, onState }: {
  src: string
  /** Tried in order when the one before cannot play (always HLS). */
  fallbackSrc?: string | string[]
  hostRef: { current: HTMLElement | null }
  /** The source's own format: a DASH source plays through dash.js. The fallback is always our HLS origin. */
  kind?: 'hls' | 'dash'
  /** Pick the level of this height (a packaging rendition seen through the packaged origin). */
  preferHeight?: number
  /** What the player is doing, so the pane can say it honestly. */
  onState?: (st: PreviewState) => void
}) {
  const ref = useRef<HTMLVideoElement | null>(null)
  const hlsRef = useRef<any>(null)
  const onStateRef = useRef(onState); onStateRef.current = onState
  // Playback stats on the source preview: right-click or Shift+D (useStatsPanel).
  useStatsPanel(hostRef, ref, { hls: hlsRef })
  const eng = useAudioEngine(ref)
  const controlsShown = useControlsVisible(hostRef)
  const [audioTracks, setAudioTracks] = useState<AudioTrackOpt[]>([])
  const [audioTrack, setAudioTrackState] = useState(0)
  // element starts muted for autoplay; the audio engine unmutes it once armed and
  // carries audibility on its gain node, so we never re-mute after arming.
  const softMute = (v: HTMLVideoElement) => { if (!v.dataset.audioArmed) v.muted = true }
  useEffect(() => {
    let cancelled = false; let hls: any; let dash: any; let usingFallback = false; let fails = 0; let via = 0
    let start: (s: string) => void = () => {}
    const fallbacks = (Array.isArray(fallbackSrc) ? fallbackSrc : fallbackSrc ? [fallbackSrc] : []).filter(Boolean)
    const nextFallback = () => { if (via >= fallbacks.length) return false; via++; usingFallback = true; fails = 0; start(fallbacks[via - 1]); return true }
    const v = ref.current; if (!v || !src) return
    const report = (st: PreviewState) => { if (!cancelled) onStateRef.current?.(st) }
    report({ s: 'loading' })
    const onPlaying = () => report({ s: usingFallback ? 'fallback' : 'playing', via })
    v.addEventListener('playing', onPlaying)
    const resolve = (s: string) => /^https?:\/\//i.test(s) || s.startsWith('/api/') ? s : originUrl(s)
    // keep the preview near the live edge; if it falls >20s behind, jump forward to
    // hls.js's own live sync point (three segments back). It used to jump to 0.5s
    // behind the newest data, which ran the buffer dry at once: the preview stalled,
    // fell behind, jumped again, and the source panel looked jumpy (seen on the
    // 9 Oct demo capture).
    const snapLive = () => { try { const sk = v.seekable; if (sk.length) { const end = sk.end(sk.length - 1); if (end - v.currentTime > 20) { const sync = hls?.liveSyncPosition; v.currentTime = Number.isFinite(sync) && sync > 0 ? sync : Math.max(sk.start(0), end - 8) } } } catch {} }
    ;(async () => {
      const Hls = (await import('hls.js')).default
      if (cancelled) return
      start = (s: string) => {
        const url = resolve(s)
        if (Hls.isSupported()) {
          try { hls?.destroy() } catch {}
          // liveSyncDurationCount:3 keeps us ~3 segments off the edge (normal live
          // latency); NOT lowLatency because the origin is a standard LIVE playlist.
          // Our origin can be warming up, so keep retrying it; a source address
          // that refuses us will not change its mind, so move on quickly.
          const patient = url.includes('/origin/')
          hls = new Hls({ lowLatencyMode: false, liveSyncDurationCount: 3, backBufferLength: 30, manifestLoadingMaxRetry: patient ? 8 : 1, manifestLoadingRetryDelay: 1000, levelLoadingMaxRetry: patient ? 8 : 2 })
          hlsRef.current = hls
          hls.loadSource(url); hls.attachMedia(v)
          hls.on(Hls.Events.MANIFEST_PARSED, (_e: any, data: any) => {
            if (preferHeight && usingFallback) {
              const i = (data?.levels ?? []).findIndex((l: any) => l.height === preferHeight)
              if (i >= 0) { hls.currentLevel = i; hls.loadLevel = i }
            }
            softMute(v); v.play().catch(() => {}); setTimeout(snapLive, 400)
          })
          hls.on(Hls.Events.LEVEL_LOADED, snapLive)
          // surface the audio tracks the encoder put in the manifest so the operator
          // can switch between them (single track hides the selector).
          const readAudio = () => {
            setAudioTracks((hls.audioTracks || []).map((t: any, i: number) => ({ id: i, label: t.name || t.lang || `Audio ${i + 1}` })))
            if (typeof hls.audioTrack === 'number' && hls.audioTrack >= 0) setAudioTrackState(hls.audioTrack)
          }
          hls.on(Hls.Events.AUDIO_TRACKS_UPDATED, readAudio)
          hls.on(Hls.Events.AUDIO_TRACK_SWITCHED, readAudio)
          hls.on(Hls.Events.ERROR, (_e: any, data: any) => {
            if (!data.fatal) return
            if (data.type === Hls.ErrorTypes.MEDIA_ERROR) { try { hls.recoverMediaError() } catch {}; return }
            fails++
            const limit = url.includes('/origin/') ? 2 : 1
            if (fails >= limit && nextFallback()) return
            if (fails >= limit) report({ s: 'error', detail: data.response?.code ? `HTTP ${data.response.code}` : String(data.details || data.type || 'cannot play') })
            setTimeout(() => { try { hls.loadSource(url); hls.startLoad() } catch {} }, 1500) // not ready yet -> reload
          })
        } else if (v.canPlayType('application/vnd.apple.mpegurl')) { v.src = url; softMute(v); v.play().catch(() => {}); v.addEventListener('loadeddata', snapLive, { once: true }) }
      }
      if (kind === 'dash') {
        // A DASH source: play it with dash.js; if it cannot, go to the HLS fallback.
        const dashjs: any = (await import('dashjs')).default
        if (cancelled) return
        dash = dashjs.MediaPlayer().create()
        dash.updateSettings({ streaming: { retryAttempts: { MPD: 3 } } })
        dash.on(dashjs.MediaPlayer.events.ERROR, (e: any) => {
          try { dash.reset() } catch {}
          dash = null
          if (nextFallback()) return
          report({ s: 'error', detail: e?.error?.message || 'cannot play' })
        })
        dash.initialize(v, src, true); softMute(v)
        return
      }
      start(src)
    })()
    return () => { cancelled = true; v.removeEventListener('playing', onPlaying); try { hls?.destroy() } catch {}; try { dash?.reset() } catch {}; hlsRef.current = null }
  }, [src, JSON.stringify(fallbackSrc ?? null), kind, preferHeight])
  const selectAudio = (i: number) => { setAudioTrackState(i); try { if (hlsRef.current) hlsRef.current.audioTrack = i } catch { /* ignore */ } }
  return (
    <>
      <video ref={ref} playsInline muted style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover', background: '#000' }} />
      <AudioDock eng={eng} tracks={audioTracks} currentTrack={audioTrack} onSelectTrack={selectAudio} controlsShown={controlsShown} />
    </>
  )
}

function hostOf(url?: string | null) { try { return url ? new URL(url).host : '' } catch { return '' } }

/* ------------------------------------------------- audio: meter + controls */
// Metering that never touches playback. We tap the element with captureStream() ->
// MediaStreamAudioSource -> analyser (NOT connected to any destination), so the
// element keeps playing through its own native path — unmute is just element.muted,
// which is why audio actually plays. hls.js feeds the element through MSE (a
// same-origin blob), so the capture is not cross-origin tainted even for a CDN
// source. The meter reads the REAL level whenever the browser lets it. When it cannot
// (context not yet resumed, or a browser that mutes the capture) it reports NO
// MEASUREMENT and the bars sit flat and grey. It used to synthesise motion from
// playback progress instead, so the strip was "always alive": a meter that
// invents movement cannot answer the only question it exists to answer, which
// is whether audio is actually arriving. Audio is muted by default on this page.
type AudioTrackOpt = { id: number; label: string }
const AUDIO_BARS = 14      // analysis bands (drive the fallback motion)
const METER_MAX_CH = 8   // channel meter: up to 7.1
// speaker body for the muted-channel mark (24x24 box)
const SPK_PATH = typeof Path2D !== 'undefined' ? new Path2D('M2 9v6h4l5 5V4L6 9H2z') : (null as any)
const HIST_COLS = 16       // scrolling meter: 16 BARS x 250ms = ~4s of history
const SPK_HI = <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3a4.5 4.5 0 0 0-2.5-4v8a4.5 4.5 0 0 0 2.5-4zM14 3.2v2.1a7 7 0 0 1 0 13.4v2.1a9 9 0 0 0 0-17.6z" /></svg>
const SPK_LO = <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3a4.5 4.5 0 0 0-2.5-4v8a4.5 4.5 0 0 0 2.5-4z" /></svg>
const SPK_MUTE = <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M3 9v6h4l5 5V4L7 9H3zm18.6.4-1.4-1.4L17 11.2 13.8 8l-1.4 1.4L15.6 12.6 12.4 15.8l1.4 1.4L17 14l3.2 3.2 1.4-1.4-3.2-3.2 3.2-3.2z" /></svg>

function useAudioEngine(videoRef: { current: HTMLVideoElement | null }) {
  const [muted, setMuted] = useState(true)     // audio disabled by default on the page
  const [volume, setVolume] = useState(1)
  // SCROLLING LEVEL HISTORY: the meter is a right-to-left timeline. Every 100ms the
  // current overall level is appended on the RIGHT and the past scrolls LEFT, so the
  // strip shows ~7 seconds of level history (audio flowing over time), not just the
  // instantaneous spectrum. 10 samples/second is the sweet spot at this size: real
  // motion without smearing, and only 10 renders/second instead of one per frame.
  const [history, setHistory] = useState<number[]>(() => new Array(HIST_COLS).fill(0))
  const histRef = useRef<number[]>(new Array(HIST_COLS).fill(0))
  const lastPushRef = useRef(0)
  // Did the local capture actually yield a signal this tick? Drives the
  // difference between "silent" and "we cannot measure here".
  const measuringRef = useRef(false)
  const [measuring, setMeasuring] = useState(false)
  const ctxRef = useRef<AudioContext | null>(null)
  const anRef = useRef<AnalyserNode | null>(null)
  const dataRef = useRef<Uint8Array | null>(null)      // frequency bins (band display)
  const pcmRef = useRef<Uint8Array | null>(null)       // time domain (the LEVEL)
  const edgesRef = useRef<number[] | null>(null)
  const dispRef = useRef<number[]>(new Array(AUDIO_BARS).fill(0))  // smoothed bar heights
  const rafRef = useRef<number | null>(null)
  const triedRef = useRef(false)   // captureStream attempted (and failed) — stop retrying
  // CHANNEL METER: one analyser per audio channel behind a splitter (up to 8:
  // mono, stereo, 5.1, 7.1). levelsRef holds each channel's current linear
  // peak; the meter animates from it on its own frame loop, so it never
  // re-renders React. `channels` is how many carry sound: the highest channel
  // heard in the last few seconds, and two identical channels count as one
  // (a mono programme sent as stereo).
  const chRef = useRef<{ an: AnalyserNode[]; buf: Uint8Array[] } | null>(null)
  const levelsRef = useRef<number[]>([0])
  const heardRef = useRef<number[]>(new Array(METER_MAX_CH).fill(0))
  const sameRef = useRef({ same: 0, diff: 0 })
  const [channels, setChannels] = useState(2)
  const channelsRef = useRef(2)
  const lastTimeRef = useRef(-1)

  // EVERY CHANNEL, NOT A DOWNMIX. captureStream() hands Web Audio a STEREO
  // downmix (a 5.1 source arrives as two channels), so it can only ever meter
  // two. The element's own audio (createMediaElementSource) carries every
  // channel, but it is silent while the element is muted, and the page starts
  // muted so the preview can autoplay. So the meter starts on the capture and,
  // at the first click or tap on the page (when the browser allows sound),
  // moves to the element: the element is unmuted and its sound goes through a
  // gain node that does the muting from then on, with a splitter beside it
  // for the meter. Only for MSE playback (a blob: source), which is never
  // cross-origin tainted; a native-HLS element keeps the capture.
  const gainRef = useRef<GainNode | null>(null)
  const elemTriedRef = useRef(false)
  // per-channel mute (click a meter bar), and the routing it acts on
  const [chanMute, setChanMute] = useState<boolean[]>(() => new Array(METER_MAX_CH).fill(false))
  const chanMuteRef = useRef(chanMute); chanMuteRef.current = chanMute
  const chanGainRef = useRef<GainNode[]>([])
  const mergerRef = useRef<ChannelMergerNode | null>(null)
  const pendingOutRef = useRef<GainNode | null>(null)
  const routedRef = useRef(0)
  const routeRef = useRef<(n: number) => void>(() => {})
  const rawChRef = useRef(2)
  const [isoReady, setIsoReady] = useState(false)
  useEffect(() => { chanGainRef.current.forEach((g, i) => { g.gain.value = chanMute[i] ? 0 : 1 }) }, [chanMute])
  const mutedRef = useRef(true); mutedRef.current = muted
  const volRef = useRef(1); volRef.current = volume
  useEffect(() => {
    const v = videoRef.current
    if (!v) return
    v.dataset.audioArmed = '1'
    if (gainRef.current) { v.muted = false; v.volume = 1; gainRef.current.gain.value = muted ? 0 : volume }
    else { v.muted = muted; v.volume = volume }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [muted, volume])

  useEffect(() => {
    let stopped = false
    const resume = () => { try { if (ctxRef.current && ctxRef.current.state === 'suspended') ctxRef.current.resume() } catch { /* ignore */ } }
    const toElement = () => {
      const v = videoRef.current, ctx = ctxRef.current
      if (!v || !ctx || gainRef.current || elemTriedRef.current || !/^blob:/.test(v.currentSrc || '')) return
      elemTriedRef.current = true
      try {
        const src = ctx.createMediaElementSource(v)
        const gain = ctx.createGain()
        gain.gain.value = mutedRef.current ? 0 : volRef.current
        gain.connect(ctx.destination)
        if (anRef.current) src.connect(anRef.current)
        // element -> splitter -> one gain per channel (mute a channel to
        // isolate the others) -> merger -> master gain -> speakers. The meter
        // taps the splitter BEFORE the channel gains, so a muted channel still
        // shows its level.
        const split = ctx.createChannelSplitter(METER_MAX_CH)
        src.connect(split)
        const an: AnalyserNode[] = [], buf: Uint8Array[] = [], cg: GainNode[] = []
        for (let c = 0; c < METER_MAX_CH; c++) {
          const a = ctx.createAnalyser(); a.fftSize = 1024
          split.connect(a, c); an.push(a); buf.push(new Uint8Array(a.fftSize))
          const g = ctx.createGain(); g.gain.value = chanMuteRef.current[c] ? 0 : 1
          split.connect(g, c); cg.push(g)
        }
        chanGainRef.current = cg
        pendingOutRef.current = gain
        route(ctx, 2)
        chRef.current = { an, buf }
        heardRef.current.fill(0); sameRef.current = { same: 0, diff: 0 }
        gainRef.current = gain
        v.muted = false; v.volume = 1
        setIsoReady(true)
      } catch { /* keep the capture meter */ }
    }
    // The merger is sized to the channels the source carries, so the browser
    // downmixes it to the speakers the standard way (5.1 to stereo and so on).
    const route = (ctx: AudioContext, n: number) => {
      const cg = chanGainRef.current, out = gainRef.current ?? null
      if (!cg.length) return
      try { mergerRef.current?.disconnect() } catch { /* ignore */ }
      cg.forEach(g => { try { g.disconnect() } catch { /* ignore */ } })
      const size = n <= 1 ? 1 : n <= 2 ? 2 : n <= 4 ? 4 : n <= 6 ? 6 : 8
      const m = ctx.createChannelMerger(size)
      m.channelInterpretation = 'speakers'
      for (let c = 0; c < size; c++) cg[c].connect(m, 0, c)
      m.connect(out ?? pendingOutRef.current!)
      mergerRef.current = m; routedRef.current = size
    }
    routeRef.current = (n: number) => { if (ctxRef.current && n !== routedRef.current) route(ctxRef.current, n) }
    const onGesture = () => { resume(); toElement() }
    window.addEventListener('pointerdown', onGesture)

    const build = () => {
      const v = videoRef.current
      if (!v || anRef.current || triedRef.current) return
      try {
        const cap: MediaStream | undefined = (v as any).captureStream?.() || (v as any).mozCaptureStream?.()
        if (!cap || cap.getAudioTracks().length === 0) return  // not ready yet — retry next frame
        const AC: typeof AudioContext | undefined = window.AudioContext || (window as any).webkitAudioContext
        if (!AC) { triedRef.current = true; return }
        const ctx = new AC()
        const analyser = ctx.createAnalyser()
        // 256-point FFT (128 bins) gives enough resolution to spread energy across the
        // bars; moderate smoothing keeps it lively but not jittery.
        analyser.fftSize = 256; analyser.smoothingTimeConstant = 0.35  // low = snappy, tracks transients
        const srcNode = ctx.createMediaStreamSource(cap)
        srcNode.connect(analyser)  // analysis only — no destination
        try {
          const split = ctx.createChannelSplitter(METER_MAX_CH)
          srcNode.connect(split)
          const an: AnalyserNode[] = [], buf: Uint8Array[] = []
          for (let c = 0; c < METER_MAX_CH; c++) {
            const a = ctx.createAnalyser(); a.fftSize = 1024
            split.connect(a, c); an.push(a); buf.push(new Uint8Array(a.fftSize))
          }
          chRef.current = { an, buf }
        } catch { chRef.current = null }
        ctxRef.current = ctx; anRef.current = analyser
        dataRef.current = new Uint8Array(analyser.frequencyBinCount)
        pcmRef.current = new Uint8Array(analyser.fftSize)
        edgesRef.current = null
        resume()
      } catch { triedRef.current = true }  // tainted / unsupported — synthesized motion only
    }

    const loop = () => {
      if (stopped) return
      const v = videoRef.current
      if (v) {
        build()
        // the page has already had a click or tap (sticky activation): a newly
        // opened player can go straight to the full-channel meter
        if (!gainRef.current && ctxRef.current?.state === 'running' && (navigator as any).userActivation?.hasBeenActive) toElement()
        lastTimeRef.current = v.currentTime
        const an = anRef.current, data = dataRef.current
        const disp = dispRef.current
        let real = false
        if (an && data && ctxRef.current && ctxRef.current.state === 'running') {
          // The DOM lib now types this parameter as Uint8Array<ArrayBuffer>
          // while our buffer is Uint8Array<ArrayBufferLike>. Same bytes, and
          // an analyser never writes into a SharedArrayBuffer.
          an.getByteFrequencyData(data as Uint8Array<ArrayBuffer>)
          const bins = data.length
          // log-spaced band edges so each bar covers a musically meaningful range (low
          // bass dominates a linear split — that was the "single bar" look). Computed once.
          if (!edgesRef.current) {
            const top = Math.max(AUDIO_BARS + 1, Math.floor(bins * 0.78))
            const e: number[] = []
            for (let b = 0; b <= AUDIO_BARS; b++) e.push(Math.min(top, Math.max(1, Math.round(2 * Math.pow(top / 2, b / AUDIO_BARS)))))
            for (let b = 1; b < e.length; b++) if (e[b] <= e[b - 1]) e[b] = e[b - 1] + 1
            edgesRef.current = e
          }
          const edges = edgesRef.current
          let peak = 0
          for (let b = 0; b < AUDIO_BARS; b++) {
            let sum = 0, n = 0
            for (let i = edges[b]; i < edges[b + 1] && i < bins; i++) { sum += data[i]; n++ }
            const avg = n ? (sum / n) / 255 : 0
            // strong perceptual curve + gain so normal speech/music fills the meter,
            // with a small lift on higher bands (they carry less energy).
            const val = Math.min(1, Math.pow(avg, 0.5) * 1.7 * (1 + b * 0.05))
            // instant attack, fast release -> lively, clearly follows the audio
            disp[b] = val >= disp[b] ? val : disp[b] * 0.7 + val * 0.3
            peak = Math.max(peak, disp[b])
          }
          // "real" = the capture is delivering a decodable signal at all, which is
          // what separates NO MEASUREMENT from measured silence.
          real = peak > 0.02 || (!!pcmRef.current && analyserPeak(an, pcmRef.current) > 0.002)
        }
        // OVERALL LEVEL: linear PEAK AMPLITUDE from the time domain, the same
        // quantity the radio waveform and the clipping workbench plot.
        //
        // It used to be an RMS over getByteFrequencyData with a ^0.6 boost. Those
        // bytes are already a dB mapping (minDecibels..maxDecibels scaled to
        // 0..255), so that was an RMS over decibels, lifted further by the curve:
        // anything audible landed near the top and the strip read as a constant
        // wall. Peak amplitude has the dynamics — see audioLevel.ts.
        let lvl = 0
        if (real && anRef.current && pcmRef.current) {
          lvl = analyserPeak(anRef.current, pcmRef.current)
        } else {
          // No measurement (or measured silence): decay to flat rather than
          // inventing motion. `measuring` below tells the meter which it is.
          const h = histRef.current
          lvl = Math.max(0, (h[h.length - 1] || 0) * 0.7)
        }
        measuringRef.current = real
        // per-channel peaks for the meter
        const ch = chRef.current
        if (real && ch) {
          const now = performance.now()
          const lv = ch.an.map((a, i) => analyserPeak(a, ch.buf[i]))
          lv.forEach((v, i) => { if (v > 0.003) heardRef.current[i] = now })
          let n = 0
          heardRef.current.forEach((t, i) => { if (now - t < 4000) n = i + 1 })
          // two channels carrying the same signal are one (mono sent as stereo)
          if (n === 2 && Math.max(lv[0], lv[1]) > 0.02) {
            const m = sameRef.current
            if (Math.abs(lv[0] - lv[1]) < 0.004) m.same++; else m.diff++
            if (m.same + m.diff > 240) { m.same = Math.round(m.same / 2); m.diff = Math.round(m.diff / 2) }
          }
          const m = sameRef.current
          const count = n === 2 && m.same + m.diff > 60 && m.same > m.diff * 9 ? 1 : Math.max(1, n)
          levelsRef.current = count === 1 && n === 2 ? [Math.max(lv[0], lv[1])] : lv.slice(0, count)
          if (count !== channelsRef.current) { channelsRef.current = count; setChannels(count) }
          if (n !== rawChRef.current && n > 0) { rawChRef.current = n; routeRef.current(n) }
        } else {
          levelsRef.current = new Array(channelsRef.current).fill(real ? lvl : 0)
        }
        const nowMs = performance.now()
        if (nowMs - lastPushRef.current >= 250) {   // one bar per 250ms
          lastPushRef.current = nowMs
          const h = histRef.current
          h.shift(); h.push(Math.min(1, lvl))
          setHistory(h.slice())
          setMeasuring(measuringRef.current)
        }
      }
      rafRef.current = requestAnimationFrame(loop)
    }
    rafRef.current = requestAnimationFrame(loop)
    return () => {
      stopped = true
      window.removeEventListener('pointerdown', onGesture)
      if (rafRef.current) cancelAnimationFrame(rafRef.current)
      try { ctxRef.current?.close() } catch { /* ignore */ }
      ctxRef.current = null; anRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const toggleMute = () => { try { ctxRef.current?.resume() } catch { /* ignore */ }; setMuted(m => !m) }
  const setVol = (val: number) => { try { ctxRef.current?.resume() } catch { /* ignore */ }; setVolume(val); setMuted(val <= 0) }
  // A meter bar stands for one channel, or for both when a mono programme is
  // sent as stereo (two identical channels shown as one bar).
  const barChannels = (bar: number) => channels === 1 && rawChRef.current === 2 ? [0, 1] : [bar]
  const barMuted = (bar: number) => barChannels(bar).every(c => chanMute[c])
  /** Click: mute or unmute that channel. */
  const toggleChannel = (bar: number) => setChanMute(m => { const n = m.slice(); const on = !barChannels(bar).every(c => m[c]); barChannels(bar).forEach(c => { n[c] = on }); return n })
  /** Double-click: hear only that channel; again (or when it is already alone) to hear them all. */
  const soloChannel = (bar: number) => setChanMute(m => {
    const mine = barChannels(bar)
    const alone = mine.every(c => !m[c]) && m.every((x, c) => mine.includes(c) || c >= rawChRef.current || x)
    return m.map((_, c) => alone ? false : !mine.includes(c))
  })
  return { muted, volume, history, measuring, toggleMute, setVol, levelsRef, channels, barMuted, toggleChannel, soloChannel, canIsolate: isoReady }
}

type AudioEngine = ReturnType<typeof useAudioEngine>

// Show controls on hover; hide a few seconds after the pointer leaves. Touch devices
// (no hover) keep them shown, since there is no rollover there.
function useControlsVisible(hostRef: { current: HTMLElement | null }) {
  const [visible, setVisible] = useState(false)
  useEffect(() => {
    const noHover = typeof window !== 'undefined' && window.matchMedia?.('(hover: none)').matches
    if (noHover) { setVisible(true); return }
    const el = hostRef.current
    if (!el) return
    let t: ReturnType<typeof setTimeout> | undefined
    const show = () => { if (t) clearTimeout(t); setVisible(true) }
    const hideSoon = () => { if (t) clearTimeout(t); t = setTimeout(() => setVisible(false), 2600) }
    el.addEventListener('pointerenter', show)
    el.addEventListener('pointermove', show)
    el.addEventListener('pointerleave', hideSoon)
    return () => { if (t) clearTimeout(t); el.removeEventListener('pointerenter', show); el.removeEventListener('pointermove', show); el.removeEventListener('pointerleave', hideSoon) }
  }, [hostRef])
  return visible
}

// Bottom-right dock. The meter is ALWAYS visible (it shows audio is being received);
// the mute button, volume and track selector fade in on hover and out on roll-out.
function AudioDock({ eng, tracks, currentTrack, onSelectTrack, controlsShown }: {
  eng: AudioEngine; tracks: AudioTrackOpt[]; currentTrack: number; onSelectTrack: (i: number) => void; controlsShown: boolean
}) {
  const icon = eng.muted || eng.volume <= 0 ? SPK_MUTE : eng.volume < 0.5 ? SPK_LO : SPK_HI
  // Audio counts as present when the RECENT history carries real level. The
  // threshold is on LINEAR amplitude now, so 0.03 is roughly -30 dBFS: quiet
  // speech still registers, a dead line does not.
  const active = eng.history.slice(-15).some(b => b > 0.03)
  return (
    <div style={{ position: 'absolute', right: 12, bottom: 12, zIndex: 5, display: 'flex', alignItems: 'center', gap: 8, pointerEvents: 'none' }}>
      <div style={{
        display: 'flex', alignItems: 'center', gap: 8, padding: '5px 9px', borderRadius: 10,
        background: 'rgba(0,0,0,.5)', backdropFilter: 'blur(3px)', pointerEvents: 'auto',
        opacity: controlsShown ? 1 : 0, visibility: controlsShown ? 'visible' : 'hidden',
        transform: controlsShown ? 'none' : 'translateY(4px)', transition: 'opacity .22s ease, transform .22s ease',
      }}>
        <button className="chip" style={{ padding: '4px 7px', lineHeight: 0 }} title={eng.muted ? 'Unmute' : 'Mute'}
          aria-label={eng.muted ? 'Unmute' : 'Mute'} onClick={eng.toggleMute}>{icon}</button>
        <input type="range" min={0} max={1} step={0.02} value={eng.muted ? 0 : eng.volume}
          onChange={e => eng.setVol(Number(e.target.value))} aria-label="Volume"
          style={{ width: 64, accentColor: 'var(--brand)' }} />
        {tracks.length > 1 && (
          <select value={currentTrack} onChange={e => onSelectTrack(Number(e.target.value))}
            title="Audio track" aria-label="Audio track" style={{ fontSize: 'var(--fs-label)', padding: '2px 4px' }}>
            {tracks.map(t => <option key={t.id} value={t.id}>{t.label}</option>)}
          </select>
        )}
      </div>
      <div className="vu-wrap" title={!eng.measuring
        ? 'No local audio measurement: this browser will not let the page tap the stream'
        : `Audio level, ${eng.channels === 1 ? 'mono' : eng.channels === 2 ? 'stereo' : `${eng.channels} channels`}. ${eng.canIsolate ? 'Click a bar to mute that channel; double-click to hear only it.' : 'Click to enable muting single channels.'}`}>
        <ChannelMeter levelsRef={eng.levelsRef} channels={eng.channels} active={active && eng.measuring}
          isMuted={eng.barMuted} onToggle={eng.canIsolate ? eng.toggleChannel : undefined} onSolo={eng.canIsolate ? eng.soloChannel : undefined} />
      </div>
    </div>
  )
}

// CHANNEL LEVEL METER: one bar of lit segments per audio channel, bouncing
// with the audio: one for mono, two for stereo, six for 5.1, up to eight. No
// channel letters: with more than two channels they would be guesses about
// the layout. The scale is dBFS, as on a desk meter: -48 at the bottom, 0 at
// the top; green to -18, then yellow, amber from -9 and red from -3. Instant
// rise, a steady fall (about 26 dB a second) and a peak marker that holds for
// a second and a half, so a transient is readable. It draws on its own frame
// loop from levelsRef, so the bounce costs no React renders. Flat and grey
// when nothing is measured.
const VU_SEG = 16, VU_FLOOR = -48
function ChannelMeter({ levelsRef, channels, active, isMuted, onToggle, onSolo }: {
  levelsRef: { current: number[] }; channels: number; active: boolean
  /** Is this bar's channel muted (click a bar to mute it, double-click to hear only it). */
  isMuted?: (bar: number) => boolean
  onToggle?: (bar: number) => void
  onSolo?: (bar: number) => void
}) {
  const ref = useRef<HTMLCanvasElement | null>(null)
  const activeRef = useRef(active); activeRef.current = active
  const mutedRef = useRef(isMuted); mutedRef.current = isMuted
  const bars = Math.max(1, Math.min(METER_MAX_CH, channels))
  const BW = bars > 4 ? 9 : 11, GAP = bars > 4 ? 3 : 4, H = 62
  const W = bars * BW + (bars - 1) * GAP
  useEffect(() => {
    const cv = ref.current; if (!cv) return
    const dpr = window.devicePixelRatio || 1
    cv.width = W * dpr; cv.height = H * dpr
    const g = cv.getContext('2d'); if (!g) return
    g.setTransform(dpr, 0, 0, dpr, 0, 0)
    const disp = new Array(bars).fill(VU_FLOOR), peak = new Array(bars).fill(VU_FLOOR), peakAt = new Array(bars).fill(0)
    let last = performance.now(); let raf = 0
    const toDb = (a: number) => a > 0 ? Math.max(VU_FLOOR, 20 * Math.log10(a)) : VU_FLOOR
    const colour = (db: number) => db >= -3 ? '#ef4444' : db >= -9 ? '#f59e0b' : db >= -18 ? '#d9f99d' : '#22c55e'
    const segH = (H - (VU_SEG - 1) * 2) / VU_SEG
    const draw = (now: number) => {
      const dt = Math.min(0.1, (now - last) / 1000); last = now
      const on = activeRef.current
      const lv = levelsRef.current
      g.clearRect(0, 0, W, H)
      for (let c = 0; c < bars; c++) {
        const x0 = c * (BW + GAP)
        if (mutedRef.current?.(c)) {
          // A MUTED CHANNEL: a plain panel with a muted-speaker mark, no level.
          g.fillStyle = 'rgba(148,163,184,.28)'
          g.beginPath(); (g as any).roundRect ? (g as any).roundRect(x0, 0, BW, H, 2) : g.rect(x0, 0, BW, H); g.fill()
          const sc = (BW - 2) / 24, ix = x0 + 1, iy = H / 2 - 12 * sc
          g.save(); g.translate(ix, iy); g.scale(sc, sc)
          g.fillStyle = 'rgba(226,232,240,.75)'; g.fill(SPK_PATH)
          g.strokeStyle = 'rgba(226,232,240,.75)'; g.lineWidth = 2.2; g.lineCap = 'round'
          g.beginPath(); g.moveTo(16, 9); g.lineTo(22, 15); g.moveTo(22, 9); g.lineTo(16, 15); g.stroke()
          g.restore()
          disp[c] = VU_FLOOR; peak[c] = VU_FLOOR
          continue
        }
        const db = on ? toDb(lv[c] ?? 0) : VU_FLOOR
        disp[c] = db > disp[c] ? db : Math.max(db, disp[c] - 26 * dt)
        if (disp[c] >= peak[c]) { peak[c] = disp[c]; peakAt[c] = now }
        else if (now - peakAt[c] > 1500) peak[c] = Math.max(disp[c], peak[c] - 20 * dt)
        const x = c * (BW + GAP)
        const lit = Math.round(((disp[c] - VU_FLOOR) / -VU_FLOOR) * VU_SEG)
        const pk = Math.min(VU_SEG - 1, Math.round(((peak[c] - VU_FLOOR) / -VU_FLOOR) * VU_SEG) - 1)
        for (let i = 0; i < VU_SEG; i++) {
          const segDb = VU_FLOOR + ((i + 1) / VU_SEG) * -VU_FLOOR
          const y = H - (i + 1) * segH - i * 2
          const show = on && (i < lit || (i === pk && pk > 0 && pk >= lit))
          g.fillStyle = show ? colour(segDb) : 'rgba(255,255,255,.09)'
          g.fillRect(x, y, BW, segH)
        }
      }
      raf = requestAnimationFrame(draw)
    }
    raf = requestAnimationFrame(draw)
    return () => cancelAnimationFrame(raf)
  }, [bars, W, BW, GAP, levelsRef])
  const barAt = (e: React.MouseEvent) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
    return Math.max(0, Math.min(bars - 1, Math.floor((e.clientX - r.left) / (BW + GAP))))
  }
  return <canvas ref={ref} style={{ width: W, height: H, display: 'block', cursor: onToggle ? 'pointer' : undefined }}
    role={onToggle ? 'group' : 'img'}
    aria-label={`Audio level, ${bars === 1 ? 'mono' : bars === 2 ? 'stereo' : `${bars} channels`}`}
    onClick={onToggle ? (e) => onToggle(barAt(e)) : undefined}
    onDoubleClick={onSolo ? (e) => { e.preventDefault(); onSolo(barAt(e)) } : undefined} />
}


function SourcePlayer({ d, sourceUp, onSendSource, busy }: { d: CD; sourceUp: boolean; onSendSource: () => void; busy: boolean }) {
  // Shared with the event page: an event says "event" and has no test source.
  const isEvent = (d as any).kind === 'event'
  const noun = isEvent ? 'event' : 'channel'
  const canRun = useAccess().can(isEvent ? 'events' : 'channels', 'operate')
  const videoBoxRef = useRef<HTMLDivElement | null>(null)
  const ts = d.testStream
  const isPkg = d.profile?.workflow_type === 'package_only'
  // EVERY INPUT, in the order an operator reads them: primary renditions
  // highest first, then their backups. A transcode channel has a primary and
  // perhaps a backup; a packaging channel one of each per rendition.
  const inputs: InputDef[] = useMemo(() => {
    const live = (d.statusBoard?.inputs ?? []) as any[]
    const rows = d.sources.filter(s => s.ingest_url).map((s, i) => ({
      key: s.id || String(i), role: s.role, label: s.rendition_label ?? null, protocol: (s.protocol || '').toUpperCase(),
      url: s.ingest_url || '', kbps: s.rendition_bitrate_kbps ?? null,
      live: live.find(x => x.id === s.id) ?? live.find(x => x.role === s.role && (x.label ?? null) === (s.rendition_label ?? null)) ?? null,
    }))
    return rows.sort((a, b) => (a.role === b.role ? 0 : a.role === 'primary' ? -1 : 1) || (b.kbps ?? 0) - (a.kbps ?? 0))
  }, [d.sources, d.statusBoard])
  const { checks, checkOne, checkAll } = useInputChecks(inputs)
  const verdicts = inputs.map(i => verdictOf(i, checks[i.key], sourceUp))
  const summary = summaryOf(inputs, verdicts)
  const [selKey, setSelKey] = useState<string | null>(null)
  const sel = inputs.find(i => i.key === selKey) ?? inputs[0]
  const [showAll, setShowAll] = useState(false)

  const proto = (sel?.protocol || d.sources[0]?.protocol || 'SRT').toUpperCase()
  const srcHost = hostOf(ts.sourceUrl || sel?.url)
  const sendLabel = sel ? `Start ${noun}` : isEvent ? null : 'Start with test source'
  // Reflect the pipeline: when the channel runs, the input gate is the
  // observation of whether bytes arrive, so it decides RECEIVING (see the
  // note in git history: `sourceUp` alone is a claim, not an observation).
  const h = d.health
  const inGate = h?.gates.find(g => g.gate === 'input')
  const inputFailed = sourceUp && inGate?.status === 'failed'
  const encFailed = !!h?.primaryError && (h.primaryError.gate === 'encoder' || h.primaryError.gate === 'output')
  const inputArriving = inGate?.status === 'healthy' || inGate?.status === 'degraded'
  const receiving = sourceUp && inputArriving
  const viaOrigin = `/origin/${d.id}/live/master.m3u8`

  // WHAT THE PANE PLAYS. An HLS or DASH source is played DIRECTLY from its own
  // address, whether or not the channel runs: it is the exact input, and the
  // first thing to confirm before starting. If the browser cannot play it
  // (the source's CDN refuses cross-origin playback) and the channel is
  // receiving, it falls back to what our ingest received, and says so. SRT,
  // RTMP and the rest cannot play in a browser at all: once the channel is
  // receiving they are shown through our ingest (the packaged output before
  // it is public), labelled as such; before that there is nothing to show.
  const p = (sel?.protocol || '').toLowerCase()
  const direct = sel && /^https?:\/\//i.test(sel.url) && (p === 'hls' || p === 'dash') ? sel.url : null
  const throughIngest = !direct && receiving && !encFailed
  const playSrc = direct ?? (throughIngest ? viaOrigin : null)
  // The relay (HLS only): what to fall back to when the browser may not play
  // the source's own address. Asked for per input; the address is a token.
  const [relay, setRelay] = useState<{ key: string; url: string } | null>(null)
  useEffect(() => {
    if (!direct || p !== 'hls' || !sel) return
    let live = true
    ;(isEvent ? api.eventInputPreview : api.channelInputPreview)(d.id, sel.key).then(r => { if (live) setRelay({ key: sel.key, url: r.url }) }).catch(() => {})
    return () => { live = false }
  }, [direct, p, sel?.key, d.id, isEvent])
  const relayUrl = relay && sel && relay.key === sel.key ? relay.url : null
  const fallbacks = direct ? [relayUrl, receiving ? viaOrigin : null].filter((x): x is string => !!x) : []
  const [pv, setPv] = useState<PreviewState>({ s: 'loading' })
  useEffect(() => { setPv({ s: 'loading' }) }, [playSrc])
  const showGateError = inputFailed || (receiving && encFailed)
  const playing = pv.s === 'playing' || pv.s === 'fallback'
  const previewFailed = !!playSrc && pv.s === 'error'

  const selVerdict = sel ? verdicts[inputs.indexOf(sel)] : null
  const badge = showGateError ? { t: inputFailed ? 'SOURCE ERROR' : 'ENCODER FAILED', bg: 'rgba(248,113,113,.85)' }
    : previewFailed ? (selVerdict?.level === 'bad' ? { t: 'NOT REACHABLE', bg: 'rgba(248,113,113,.85)' } : { t: 'CANNOT PLAY HERE', bg: 'rgba(251,191,36,.85)' })
    : receiving ? { t: 'RECEIVING', bg: 'rgba(74,222,128,.85)' }
    : sourceUp ? { t: 'CONNECTING', bg: 'rgba(250,204,21,.85)' }
    : playing ? { t: 'SOURCE PREVIEW', bg: 'rgba(99,102,241,.85)' }
    : { t: proto, bg: 'rgba(99,102,241,.85)' }
  const viaUrl = pv.s === 'fallback' && pv.via ? fallbacks[pv.via - 1] : null
  const how = !playSrc ? null
    : pv.s === 'error' ? 'could not play'
    : pv.s === 'loading' ? 'connecting…'
    : !direct ? 'via Volt ingest'
    : pv.s !== 'fallback' ? 'direct from the source'
    : viaUrl === relayUrl ? 'relayed by Volt: the source blocks browser playback'
    : 'via Volt ingest: direct playback blocked'

  return (
    <div className="player">
      <div className="video" ref={videoBoxRef}>
        {playSrc && !showGateError
          ? <HlsVideo key={playSrc} src={playSrc} kind={direct && p === 'dash' ? 'dash' : 'hls'} hostRef={videoBoxRef}
              fallbackSrc={fallbacks}
              preferHeight={heightOf(sel?.label) || undefined} onState={setPv} />
          : <div className="grad" style={showGateError ? { background: 'radial-gradient(120% 120% at 70% 20%,#2a1620 0%,#0b0f16 70%)' } : undefined} />}
        <div className="plabel"><span className="pt" style={{ color: showGateError ? '#fca5a5' : '#a5b4fc' }}>
          SOURCE · {proto}{sel?.label ? ` · ${sel.label}` : ''}{sel?.role === 'backup' ? ' · backup' : ''}
        </span></div>
        <div className="badge-live" style={{ background: badge.bg }}><span className="d" />{badge.t}</div>
        {showGateError && (
          <div className="src-overlay">
            <div className="t" style={{ color: '#fca5a5' }}>{inputFailed ? 'Source error' : 'Source is valid, but the encoder has failed'}</div>
            <div className="d">{inputFailed ? (inGate?.detail || 'no signal') : 'nothing can be previewed until the encoder recovers'}</div>
          </div>
        )}
        {!showGateError && previewFailed && (
          <div className="src-overlay">
            {selVerdict?.level === 'bad' ? <>
              <div className="t" style={{ color: '#fca5a5' }}>The source is not reachable</div>
              <div className="d">{selVerdict.text.replace(/\.$/, '')}. Neither this browser nor Volt can read it: check the address with whoever sends it.</div>
            </> : <>
              <div className="t" style={{ color: '#fbbf24' }}>This browser cannot play the source</div>
              <div className="d">{pv.detail ? `${pv.detail}. ` : ''}It could not be played directly or relayed through Volt. {selVerdict ? <>Volt's check: <b>{selVerdict.text.replace(/\.$/, '')}</b>.</> : null}</div>
            </>}
          </div>
        )}
        {!showGateError && !playSrc && !sourceUp && (
          <div className="src-overlay">
            {canRun && sendLabel && (
              <button className="btn primary" onClick={onSendSource} disabled={busy} style={{ transform: 'scale(1.05)' }}>
                {busy ? 'Starting…' : `▶  ${sendLabel}`}
              </button>
            )}
            {!sel && isEvent && <div className="d">No input source is configured. Set one in Settings to start this event.</div>}
            {sel && !direct && <div className="d" style={{ marginTop: 10 }}>{proto} cannot play in a browser. Once the {noun} is receiving, this pane shows it through Volt's ingest.</div>}
          </div>
        )}
        {!showGateError && !playSrc && sourceUp && !receiving && (
          <div className="src-overlay"><div className="d">{inGate?.detail || `Waiting for ${proto}: nothing arriving yet`}</div></div>
        )}
        <div className="ptime">{showGateError ? '— error —' : how ?? (sourceUp ? `${srcHost || 'source'} · live` : '— no signal —')}</div>
      </div>

      {inputs.length > 1 && (
        <div className="src-pick" role="tablist" aria-label="Preview input">
          {inputs.map((i, k) => (
            <button key={i.key} type="button" role="tab" aria-selected={i === sel} className={`src-chip${i === sel ? ' sel' : ''}`}
              onClick={() => setSelKey(i.key)} title={`${inputName(i)} · ${verdicts[k].text}`}>
              <LevelDot level={verdicts[k].level} />
              <span>{i.label ?? (i.role === 'backup' ? 'Backup' : 'Primary')}{i.role === 'backup' && i.label ? <span className="src-chip-b"> backup</span> : null}</span>
            </button>
          ))}
        </div>
      )}

      <div className="pfoot">
        <LevelDot level={inputs.length ? summary.level : 'pending'} />
        <span style={{ flex: 1, minWidth: 0 }}>
          {!inputs.length ? 'No source: send one to enable output'
            : inputs.length === 1 ? (selVerdict?.text ?? '')
            : summary.text}
        </span>
        {inputs.length > 0 && <button type="button" className="btn ghost sm" onClick={() => setShowAll(v => !v)}>{showAll ? 'Hide inputs' : (isPkg || inputs.length > 1 ? 'All inputs' : 'Details')}</button>}
        {inputs.length > 0 && <button type="button" className="btn ghost sm" onClick={() => void checkAll()} disabled={Object.values(checks).some(c => c.busy)}>Check all</button>}
        {!sourceUp && playing && canRun && <button className="btn primary sm" onClick={onSendSource} disabled={busy}>{busy ? 'Starting…' : '▶ Start'}</button>}
      </div>

      {(showAll || summary.level === 'bad' || summary.level === 'warn') && inputs.length > 0 && (
        <div className="src-inputs">
          {inputs.map((i, k) => {
            const v = verdicts[k]
            if (!showAll && v.level !== 'bad' && v.level !== 'warn') return null
            return (
              <div className={`src-in ${v.level}`} key={i.key}>
                <LevelDot level={v.level} />
                <button type="button" className="nm" onClick={() => setSelKey(i.key)} title="Preview this input">{inputName(i)}</button>
                <span className="pr">{i.protocol}{i.kbps ? ` · ${(i.kbps / 1000).toFixed(1)} Mbps` : ''}</span>
                <span className="st">{v.text}<span className="host"> · {hostOf(i.url) || i.url}</span></span>
                <button type="button" className="btn ghost sm" onClick={() => void checkOne(i)} disabled={checks[i.key]?.busy}>{checks[i.key]?.busy ? 'Checking…' : 'Check'}</button>
              </div>
            )
          })}
        </div>
      )}
      {sourceUp && ts.sourceNote && (
        <div style={{ padding: '9px 12px', borderTop: '1px solid var(--border)', fontSize: 'var(--fs-sm)', color: 'var(--warn)', display: 'flex', gap: 8 }}>
          <span>⚠</span><span>{ts.sourceNote}</span>
        </div>
      )}
    </div>
  )
}

function IdleOutput({ sourceUp, onGoLive, warming, sinceMs, captionsOn, isEvent = false }: {
  sourceUp: boolean; onGoLive: () => void; warming?: boolean; sinceMs?: number | null; captionsOn?: boolean
  /** An event has no Go live: it is public while live inside its public window. */
  isEvent?: boolean
}) {
  const canRun = useAccess().can(isEvent ? 'events' : 'channels', 'operate')
  // Warm-up counter: while the encoder is up but the output is not yet packaged, show
  // how long the warm-up has been running and what wait is NORMAL, so the operator does
  // not read a healthy start as a fault. Live captions (whisper) add a transcription
  // offset before the first playable output: expect 10 to 20 seconds with captions on,
  // around 4 seconds with captions off.
  //
  // ANCHOR: the count starts when THIS warm-up began, never the billable session start.
  // billing.since spans the whole run, so anchoring there showed 8000+ seconds when a
  // long-running channel re-entered warm-up. Use billing.since only while it is fresh
  // (a genuine just-started run); otherwise count from when this panel saw the warm-up.
  const [nowT, setNowT] = useState(Date.now())
  const warmAnchorRef = useRef<number | null>(null)
  useEffect(() => {
    if (!warming) { warmAnchorRef.current = null; return }
    if (warmAnchorRef.current == null) {
      const fresh = sinceMs && Date.now() - sinceMs < 120_000
      warmAnchorRef.current = fresh ? sinceMs! : Date.now()
    }
    const iv = setInterval(() => setNowT(Date.now()), 1000)
    return () => clearInterval(iv)
  }, [warming, sinceMs])
  const warmSec = warming && warmAnchorRef.current ? Math.max(0, Math.floor((nowT - warmAnchorRef.current) / 1000)) : 0
  const expect = captionsOn ? 'usually 10 to 20 seconds while live captions warm up' : 'usually around 4 seconds'
  return (
    <div className="player">
      <div className="video">
        <div className="grad" style={{ background: 'radial-gradient(120% 120% at 70% 20%,#20304a 0%,#0b0f16 70%)' }} />
        <div className="plabel"><span className="pt" style={{ color: sourceUp ? '#38bdf8' : '#98a1b6' }}>OUTPUT · {warming ? 'warming up' : sourceUp ? 'ready' : 'idle'}</span></div>
        <div className="badge-live" style={{ background: sourceUp ? 'rgba(56,189,248,.8)' : 'rgba(102,112,138,.7)' }}><span className="d" />{warming ? 'STARTING' : sourceUp ? 'READY' : 'IDLE'}</div>
        <div style={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center', textAlign: 'center', padding: 20 }}>
          {warming ? (
            <div style={{ color: 'var(--muted)', fontSize: 'var(--fs-body)', maxWidth: 340 }}>
              <div style={{ fontSize: 26, fontWeight: 700, color: 'var(--text)', fontVariantNumeric: 'tabular-nums', marginBottom: 6 }}>{warmSec}s</div>
              <div style={{ fontWeight: 600, marginBottom: 4 }}>Preparing the output</div>
              First playable output takes a moment: {expect}. This is normal start-up, not a fault.
            </div>
          ) : sourceUp ? (
            <div>
              {canRun && !isEvent && (
              <button className="btn primary" onClick={onGoLive} style={{ transform: 'scale(1.05)' }}>
                <span className="dot-s live" style={{ marginRight: 6 }} />Go live
              </button>
              )}
              <div style={{ marginTop: 12, fontSize: 'var(--fs-sm)', color: 'var(--muted)' }}>{isEvent
                ? 'Source is receiving. The output shows here once it is packaged; viewers can play it inside the public window.'
                : 'Source is receiving. Take the output live.'}</div>
            </div>
          ) : (
            <div style={{ color: 'var(--faint)', fontSize: 'var(--fs-body)', maxWidth: 300 }}>
              <div style={{ fontWeight: 600, color: 'var(--muted)', marginBottom: 4 }}>Waiting for source</div>
              Send a source first: the output can only go live once the source is arriving.
            </div>
          )}
        </div>
        <div className="ptime">{warming ? `warming up · ${warmSec}s` : sourceUp ? 'ready to go live' : 'no source'}</div>
      </div>
      <div className="pfoot">
        <span className={`dot-s ${warming || sourceUp ? 'sched' : 'idle'}`} /> {warming ? (captionsOn ? 'Encoder starting · captions add 10 to 20 seconds before first output' : 'Encoder starting · first output in a few seconds') : sourceUp ? 'Encoder warm · output held private until you go live' : 'Output disabled until a source is connected'}
      </div>
    </div>
  )
}

function HlsOutput({ d, onAir, captionLangs, subOn, setSubOn, subLang, setSubLang }: {
  d: CD; onAir: boolean; captionLangs: string[]; subOn: boolean; setSubOn: (v: boolean) => void; subLang: string; setSubLang: (v: string) => void
}) {
  const ts = d.testStream
  // Which packagings the channel produces. Shaka emits master.m3u8 (HLS) and
  // manifest.mpd (DASH); the profile says which are intended. We let the operator
  // preview EITHER so both outputs can be verified before going on air.
  const pkg = (d.profile?.packaging || 'hls').toLowerCase()
  const hasHls = pkg === 'hls' || pkg === 'both'
  const hasDash = pkg === 'dash' || pkg === 'both'
  // CAPTION DELIVERY LATENCY: captions are produced ~12s after the audio, so when they
  // are on we hold the play point back by this much. "Live" then means the point where
  // the subtitles already exist and align, not the bleeding edge.
  const capHold = d.captions?.enabled ? 14 : 0
  // LIVE PLAY POINT with captions off. It used to be 0.5s behind the newest data, so the
  // player ran dry whenever a segment was a little late (every source hiccup, and every
  // splice to or from the loop): measured in a real Chrome, 5s frozen at the first splice
  // where hls.js' own start (3 segments back) played straight through. 12s is three 4s
  // segments, the same margin the libraries use.
  const liveHold = capHold || 12
  const langOpts = useCaptionLanguages()   // labels for the CC language selector
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const videoBoxRef = useRef<HTMLDivElement | null>(null)
  const hlsRef = useRef<any>(null)
  const dashRef = useRef<any>(null)
  const eng = useAudioEngine(videoRef)
  const controlsShown = useControlsVisible(videoBoxRef)
  // Playback stats on the output monitor (the SDK's panel): Stats button, right-click or Shift+D.
  const stats = useStatsPanel(videoBoxRef, videoRef, { hls: hlsRef, dash: dashRef })
  const [audioTracks, setAudioTracks] = useState<AudioTrackOpt[]>([])
  const [audioTrack, setAudioTrack] = useState(0)
  // element starts muted for autoplay; the audio engine unmutes it once armed and
  // carries audibility on its gain node, so we never re-mute after arming.
  const softMute = (v: HTMLVideoElement) => { if (!v.dataset.audioArmed) v.muted = true }
  const [fmt, setFmt] = useState<'hls' | 'dash'>(pkg === 'dash' ? 'dash' : 'hls')
  const [levels, setLevels] = useState<{ height: number; bitrate: number }[]>([])
  const [level, setLevel] = useState(-1) // -1 = auto (ABR)
  const [scrubbed, setScrubbed] = useState(false) // operator dragged into DVR (else live)
  const [behind, setBehind] = useState(0)          // seconds behind the live edge
  const [winSec, setWinSec] = useState(0)          // available DVR depth NOW (grows as it fills, capped at the window)
  const [cue, setCue] = useState('')
  const [subTracks, setSubTracks] = useState(0)   // subtitle tracks discovered in the manifest
  const [subLangs, setSubLangs] = useState<string[]>([])  // their languages
  // VIEW AS A VIEWER ELSEWHERE: pick a country (and who the viewer is) and the
  // play gate is asked what they would get (GET /channels/:id/access-check,
  // or /events/:id/access-check on the event page).
  const [geoAs, setGeoAs] = useState('')
  const [geoViewer, setGeoViewer] = useState<'anonymous' | 'member' | 'entitled'>('anonymous')
  const [geoRes, setGeoRes] = useState<AccessCheck | null>(null)
  const [geoErr, setGeoErr] = useState('')
  useEffect(() => {
    setGeoRes(null); setGeoErr('')
    if (!geoAs) return
    let live = true
    // The event page shares this panel: an event asks its own route.
    ;((d as any).kind === 'event' ? api.eventAccessCheck : api.channelAccessCheck)(d.id, geoAs, geoViewer).then(r => { if (live) setGeoRes(r) }).catch((e: any) => { if (live) setGeoErr(e?.message || 'Could not check') })
    return () => { live = false }
  }, [geoAs, geoViewer, d.id, d.version])
  const geoBlocked = !!geoRes && !geoRes.allowed
  useEffect(() => { const v = videoRef.current; if (v && geoBlocked) v.pause(); else if (v && geoRes && v.paused) v.play().catch(() => {}) }, [geoBlocked, geoRes])
  // INPUT->OUTPUT LATENCY estimate. Exact when the manifest carries PDT (the caption
  // companion stamps every segment with its real encoder write time): latency =
  // now - playingDate = encoder write to glass. Without PDT we fall back to a rough
  // buffer-based estimate and mark it approximate.
  const [latency, setLatency] = useState<{ sec: number; exact: boolean } | null>(null)
  // STALL DETECTION: 'healthy' must mean WATCHABLE. If the playhead stops advancing
  // while the player believes it is playing, say so on the picture (no silent freeze
  // with green gates) and try to recover: resume loading, then media-error recovery,
  // then snap back to the live edge.
  const [stalled, setStalled] = useState(false)
  const stallRef = useRef<{ t: number; at: number; tries: number; lastFix: number }>({ t: -1, at: 0, tries: 0, lastFix: 0 })
  useEffect(() => {
    const iv = setInterval(() => {
      const v = videoRef.current
      const s = stallRef.current
      const now = performance.now()
      if (!v || v.paused || v.ended || v.readyState < 2) { s.t = -1; s.at = now; setStalled(false); return }
      if (v.currentTime !== s.t) { s.t = v.currentTime; s.at = now; s.tries = 0; setStalled(false); return }
      if (now - s.at <= 6000) return
      setStalled(true)
      if (now - s.lastFix > 8000) {
        s.lastFix = now; s.tries++
        try {
          if (fmt === 'hls' && hlsRef.current) {
            if (s.tries === 1) hlsRef.current.startLoad()
            else if (s.tries === 2) hlsRef.current.recoverMediaError()
            else { const sk = v.seekable; if (sk.length) { v.currentTime = Math.max(sk.start(0), sk.end(sk.length - 1) - liveHold) ; v.play().catch(() => {}) } }
          } else if (dashRef.current) {
            dashRef.current.seekToOriginalLive?.()
          }
        } catch { /* keep trying on the next cycle */ }
      }
    }, 1000)
    return () => clearInterval(iv)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fmt])
  useEffect(() => {
    const iv = setInterval(() => {
      try {
        const v = videoRef.current
        if (!v || v.paused || !v.currentTime) { setLatency(null); return }
        if (fmt === 'dash' && dashRef.current) {
          const l = dashRef.current.getCurrentLiveLatency?.()
          setLatency(Number.isFinite(l) && l > 0 ? { sec: Math.round(l), exact: true } : null)
          return
        }
        const pd: Date | null = hlsRef.current?.playingDate ?? null
        if (pd && pd.getTime() > 0) {
          const sec = (Date.now() - pd.getTime()) / 1000
          if (sec > -5 && sec < 600) { setLatency({ sec: Math.max(0, Math.round(sec)), exact: true }); return }
        }
        // no PDT (plain master without captions): behind-edge + about 1.5 segments of
        // packaging/transfer as a coarse estimate
        const sk = v.seekable
        const behindEdge = sk.length ? Math.max(0, sk.end(sk.length - 1) - v.currentTime) : 0
        const segDur = d.profile?.segment_dur || 4
        setLatency({ sec: Math.round(behindEdge + segDur * 1.5), exact: false })
      } catch { setLatency(null) }
    }, 1000)
    return () => clearInterval(iv)
  }, [fmt, d.profile?.segment_dur])
  const cuesRef = useRef<Cue[]>([])
  const didSnapRef = useRef(false)   // snap to live edge once on initial load
  // LIVE LOCK: live is the default. We hold the live edge and auto-recover after any
  // stall/drift; the player only leaves live when the operator deliberately scrubs the
  // DVR timeline (set true by seekBehind), and re-locks on Go live.
  const scrubbedRef = useRef(false)

  // attach the playback engine for the chosen format. HLS -> hls.js on master.m3u8;
  // DASH -> dash.js on manifest.mpd. Both populate the ladder list, autoplay, and
  // snap to the live edge on load. Switching format tears down the previous engine.
  useEffect(() => {
    let cancelled = false
    const video = videoRef.current
    if (!video) return
    didSnapRef.current = false
    setLevels([]); setLevel(-1)
    // LIVE IS THE DEFAULT: jump to the play point shortly after load (once). With captions
    // on, the play point is held back by capHold so the subtitles already exist there.
    const snapSoon = () => {
      const snap = () => { try { const sk = video.seekable; if (sk.length && !didSnapRef.current) { const end = sk.end(sk.length - 1), start = sk.start(0); const hold = Math.min(liveHold, Math.max(0.5, (end - start) - 3)); video.currentTime = end - hold; didSnapRef.current = true } } catch {} }
      setTimeout(snap, 300); setTimeout(snap, 1200)
    }
    // Captions on: load the captions-aware companion manifest (subtitles + PDT in the
    // manifest). It appears a few seconds after start, so retry it rather than dropping
    // to the plain master permanently; only fall back after several misses.
    // the DELIVERED master (master_cc) carries subtitles AND the playout splice that
    // covers a lost source with the channel's loop, so a channel with either plays it
    const spliced = !!d.input_failover_enabled && ['slate', 'vod_loop'].includes(String(d.input_loss_behavior ?? ''))
    const cc = !!d.captions?.enabled || spliced
    async function attachHls() {
      const Hls = (await import('hls.js')).default
      if (cancelled) return
      if (Hls.isSupported()) {
        let src = originUrl(`/origin/${d.id}/live/${cc ? 'master_cc.m3u8' : 'master.m3u8'}`)
        let ccTries = 0
        // liveSyncDuration = the caption hold-back (or hls default when captions off).
        const cfg: any = { lowLatencyMode: false, backBufferLength: d.dvr.effective_sec, manifestLoadingMaxRetry: 12, manifestLoadingRetryDelay: 1000, levelLoadingMaxRetry: 12, subtitleDisplay: true, renderTextTracksNatively: true }
        if (capHold) cfg.liveSyncDuration = capHold; else cfg.liveSyncDurationCount = 3
        const hls = new Hls(cfg)
        hlsRef.current = hls
        hls.loadSource(src); hls.attachMedia(video!)
        hls.on(Hls.Events.MANIFEST_PARSED, () => {
          setLevels(hls.levels.map((l: any) => ({ height: l.height, bitrate: l.bitrate })))
          softMute(video!); video!.play().catch(() => {}); snapSoon()
        })
        hls.on(Hls.Events.SUBTITLE_TRACKS_UPDATED, () => {
          const tr = hls.subtitleTracks || []
          setSubTracks(tr.length)
          setSubLangs([...new Set(tr.map((t: any) => String(t.lang || t.name || '').toLowerCase()).filter(Boolean))] as string[])
        })
        // audio tracks the encoder assigned to the manifest (transcode makes a
        // separate audio track; multi-track sources expose one entry per language).
        const readAudio = () => {
          setAudioTracks((hls.audioTracks || []).map((t: any, i: number) => ({ id: i, label: t.name || t.lang || `Audio ${i + 1}` })))
          if (typeof hls.audioTrack === 'number' && hls.audioTrack >= 0) setAudioTrack(hls.audioTrack)
        }
        hls.on(Hls.Events.AUDIO_TRACKS_UPDATED, readAudio)
        hls.on(Hls.Events.AUDIO_TRACK_SWITCHED, readAudio)
        hls.on(Hls.Events.ERROR, (_e: any, data: any) => {
          if (!data.fatal) return
          if (data.type === Hls.ErrorTypes.MEDIA_ERROR) { try { hls.recoverMediaError() } catch {}; return }
          // keep retrying the companion (it appears ~12s in); only after MANY misses
          // fall back to the plain master so video still plays if captions never come.
          // The companion is normally reliable, so keep trying it for a good while
          // rather than dropping subtitles for the whole session on a transient error.
          if (cc && src.endsWith('master_cc.m3u8') && ++ccTries >= 20) { src = originUrl(`/origin/${d.id}/live/master.m3u8`) }
          setTimeout(() => { try { hls.loadSource(src); hls.startLoad() } catch {} }, 1500)
        })
      } else if (video!.canPlayType('application/vnd.apple.mpegurl')) {
        video!.src = originUrl(`/origin/${d.id}/live/${cc ? 'master_cc.m3u8' : 'master.m3u8'}`); softMute(video!); video!.play().catch(() => {}); snapSoon()
      }
    }
    async function attachDash() {
      const dashjs: any = (await import('dashjs')).default
      if (cancelled) return
      const url = originUrl(`/origin/${d.id}/live/${cc ? 'manifest_cc.mpd' : 'manifest.mpd'}`)
      const player = dashjs.MediaPlayer().create()
      dashRef.current = player
      // start on the live edge, ABR on by default
      player.updateSettings({ streaming: { abr: { autoSwitchBitrate: { video: true } }, retryAttempts: { MPD: 12 } } })
      player.initialize(video, url, true)
      const onInit = () => {
        try {
          const bs = player.getBitrateInfoListFor('video') || []
          setLevels(bs.map((b: any) => ({ height: b.height, bitrate: b.bitrate })))
        } catch { /* ignore */ }
        try {
          const tt = player.getTracksFor('text') || []
          setSubTracks(tt.length)
          setSubLangs([...new Set(tt.map((t: any) => String(t.lang || '').toLowerCase()).filter(Boolean))] as string[])
        } catch { /* ignore */ }
        try {
          const at = player.getTracksFor('audio') || []
          setAudioTracks(at.map((t: any, i: number) => ({ id: i, label: (t.labels && t.labels[0]?.text) || t.lang || `Audio ${i + 1}` })))
        } catch { /* ignore */ }
        // STREAM_INITIALIZED can arrive after the element has been torn down
        // (a fast format switch, or leaving the page mid-load).
        if (!video) return
        softMute(video); video.play().catch(() => {}); snapSoon()
      }
      try { player.on(dashjs.MediaPlayer.events.STREAM_INITIALIZED, onInit) } catch { /* ignore */ }
    }
    if (fmt === 'dash') attachDash(); else attachHls()
    return () => {
      cancelled = true
      try { hlsRef.current?.destroy(); hlsRef.current = null } catch { /* ignore */ }
      try { dashRef.current?.reset?.(); dashRef.current?.destroy?.(); dashRef.current = null } catch { /* ignore */ }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [d.id, fmt])

  // apply rendition selection (Auto = ABR, else pin a ladder rung) for either engine
  useEffect(() => {
    if (fmt === 'hls') { if (hlsRef.current) hlsRef.current.currentLevel = level; return }
    const p = dashRef.current; if (!p) return
    if (level < 0) { try { p.updateSettings({ streaming: { abr: { autoSwitchBitrate: { video: true } } } }) } catch { /* ignore */ } }
    else { try { p.updateSettings({ streaming: { abr: { autoSwitchBitrate: { video: false } } } }); p.setQualityFor('video', level) } catch { /* ignore */ } }
  }, [level, fmt])

  // apply audio-track selection (multi-language) for either engine
  useEffect(() => {
    if (fmt === 'hls') { try { if (hlsRef.current) hlsRef.current.audioTrack = audioTrack } catch { /* ignore */ } return }
    const p = dashRef.current; if (!p) return
    try { const at = p.getTracksFor('audio') || []; if (at[audioTrack]) p.setCurrentTrack(at[audioTrack]) } catch { /* ignore */ }
  }, [audioTrack, fmt])

  // subtitle selection: draw the manifest subtitle track in the PLAYER (native) for the
  // chosen language, toggled by CC — so captions can be judged for accuracy + sync.
  useEffect(() => {
    if (fmt === 'hls') {
      const hls = hlsRef.current; if (!hls) return
      try {
        hls.subtitleDisplay = subOn
        const tracks = hls.subtitleTracks || []
        if (!subOn) { hls.subtitleTrack = -1; return }
        if (!tracks.length) return
        const i = tracks.findIndex((t: any) => String(t.lang || t.name || '').toLowerCase().startsWith(subLang.toLowerCase()))
        hls.subtitleTrack = i >= 0 ? i : 0
      } catch { /* ignore */ }
      return
    }
    // DASH (dash.js native text)
    const p = dashRef.current; if (!p) return
    try {
      p.enableText(subOn)
      if (subOn) {
        p.setTextDefaultLanguage?.(subLang)
        const tt = (p.getTracksFor?.('text') || [])
        const t = tt.find((x: any) => String(x.lang || '').toLowerCase().startsWith(subLang.toLowerCase()))
        if (t) p.setCurrentTrack?.(t)
      }
    } catch { /* ignore */ }
  }, [subOn, subLang, fmt, subTracks, levels])

  // SELF-HEAL: hls.js can drop the selected subtitle track after a level switch,
  // recovery, or DVR seek, which is what made captions come and go. Re-assert the
  // chosen track + display on a slow interval so it stays on reliably for live and DVR.
  useEffect(() => {
    if (!subOn || fmt !== 'hls') return
    const iv = setInterval(() => {
      const hls = hlsRef.current; if (!hls) return
      try {
        const tracks = hls.subtitleTracks || []
        if (!tracks.length) return
        hls.subtitleDisplay = true
        const want = tracks.findIndex((t: any) => String(t.lang || t.name || '').toLowerCase().startsWith(subLang.toLowerCase()))
        const target = want >= 0 ? want : 0
        if (hls.subtitleTrack !== target) hls.subtitleTrack = target
      } catch { /* ignore */ }
    }, 3000)
    return () => clearInterval(iv)
  }, [subOn, subLang, fmt])

  // track live-edge vs DVR position
  useEffect(() => {
    const v = videoRef.current; if (!v) return
    const onT = () => {
      const sk = v.seekable
      if (sk.length) {
        const end = sk.end(sk.length - 1), start = sk.start(0)
        // available DVR depth right now (grows from ~0 up to the window cap). The live
        // edge is ALWAYS the right end of the bar; this is just how far left you can drag.
        setWinSec(Math.min(d.dvr.effective_sec, Math.max(1, Math.round(end - start))))
        // LIVE LOCK: if the operator hasn't scrubbed, keep pulling back to the live
        // edge. Messy source timing makes hls.js stall and resume behind; without this
        // it silently accumulates minutes of lag (the "-5:29 behind" we saw). Snapping
        // whenever we drift >12s keeps the preview honestly live and self-heals stalls.
        if (!scrubbedRef.current) {
          // Clamp the hold-back to what is actually buffered: early on, the seekable
          // window is shorter than capHold (18s), so seeking to end - 18 would land
          // before the buffer start and the player would jerk/shiver. Never target
          // past the start; grow toward capHold as the window fills.
          const depth = end - start
          const target = Math.min(liveHold, Math.max(0.5, depth - 3))
          const behindNow = end - v.currentTime
          // DON'T fight hls.js's own live sync (that caused the start jitter). Only step
          // in on a real problem: a big stall that left us far behind, or running up to
          // the bleeding edge where captions/subs would not exist yet. A wide deadband
          // in between lets the player hold a smooth position.
          if (behindNow > target + 30 || behindNow < 1.5) {
            try { v.currentTime = end - target } catch { /* ignore */ }
          }
        }
        setBehind(Math.max(0, Math.round(end - v.currentTime)))
      }
    }
    v.addEventListener('timeupdate', onT)
    return () => v.removeEventListener('timeupdate', onT)
  }, [])

  // poll the live subtitle track and pick the current cue. LEGACY: this drives the
  // DOM-overlay caption path used only by the test-stream side-VTT. Real channels render
  // captions NATIVELY from the manifest subtitle track, so skip this poll entirely when
  // captions are enabled (it would 404 on the non-existent /subs/<lang>.vtt).
  useEffect(() => {
    if (!subOn || d.captions?.enabled) { setCue(''); return }
    // An event's detail has no test stream, so no side subtitles (testStream is
    // { available: false }): reading into it blanked the live event page.
    const url = ts?.subtitles?.[subLang]; if (!url) return
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
  }, [subOn, subLang, ts?.subtitles, d.captions?.enabled])

  function seekBehind(sec: number) {
    const v = videoRef.current; if (!v || !v.seekable.length) return
    scrubbedRef.current = true; setScrubbed(true)   // deliberate DVR scrub: release the live lock
    const end = v.seekable.end(v.seekable.length - 1)
    v.currentTime = Math.max(v.seekable.start(0), end - Math.max(0, sec))
  }
  function goLive() { const v = videoRef.current; scrubbedRef.current = false; setScrubbed(false); if (!v || !v.seekable.length) return; const sk = v.seekable, end = sk.end(sk.length - 1), start = sk.start(0); const hold = Math.min(liveHold, Math.max(0.5, (end - start) - 3)); v.currentTime = end - hold }

  // Captions status from the latest caption.* telemetry so the operator can see the
  // estimated live offset AND why captions failed (not a roadblock, but worth knowing).
  const capStatus = useMemo(() => {
    if (!d.captions?.enabled) return null
    const ev = (d.log || []).find(l => l.title === 'caption.offset' || l.title === 'caption.error' || l.title === 'caption.status')
    if (!ev) return { kind: 'starting' as const }
    try {
      const j = JSON.parse(ev.detail || '{}')
      if (ev.title === 'caption.error') return { kind: 'error' as const, reason: j.reason || 'unknown', hint: j.hint as string | undefined }
      if (ev.title === 'caption.offset' && typeof j.est_offset_sec === 'number') return { kind: 'live' as const, sec: j.est_offset_sec as number, realtime: j.realtime !== false }
      return { kind: 'starting' as const }
    } catch { return { kind: 'starting' as const } }
  }, [d.log, d.captions?.enabled])

  // live is the default: we are LIVE unless the operator has scrubbed back into the DVR.
  const liveNow = !scrubbed
  // slider position: pinned to the RIGHT (live) while live so it never bounces as new
  // chunks append; only when scrubbed does the handle sit back at (window - behind).
  const sliderMax = Math.max(1, winSec)
  const sliderVal = liveNow ? sliderMax : Math.min(sliderMax, Math.max(0, winSec - behind))

  // the test stream's side captions exist only while it runs
  const sideSubs = !d.captions?.enabled && ts.running ? Object.keys(ts.subtitles ?? {}) : []
  const ccLangs = subTracks > 0
    ? (subLangs.length ? subLangs.map(l => captionLangs.find(c => l.startsWith(c.toLowerCase())) ?? l) : captionLangs)
    : sideSubs
  const layerName: Record<string, string> = { account: 'the account-wide geo rule (Account settings)', channel: "the channel's own geo setting", rules: 'an access rule', programme: 'the programme on air (blackout)', on_demand: 'on-demand availability', none: '' }
  return (
    <div className="player">
      <div className="video" ref={videoBoxRef}>
        <video ref={videoRef} playsInline muted style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover', background: '#000', visibility: geoBlocked ? 'hidden' : undefined }} />
        {geoRes && (geoBlocked || geoRes.replacement) && (
          <div className="geo-overlay">
            <div className="t">{geoBlocked ? `Blocked for a viewer in ${countryName(geoRes.country)}` : `Viewers in ${countryName(geoRes.country)} see a replacement`}</div>
            <div className="d">{geoBlocked
              ? <>{geoRes.reason || 'Not available'}. Decided by {layerName[geoRes.layer] || 'the access rules'}.{geoRes.products.length ? <> They are offered: {geoRes.products.map(p => p.name).join(', ')}.</> : null}</>
              : <>The programme on air is blacked out there; they get “{geoRes.replacement!.title}” instead.</>}</div>
          </div>
        )}
        <div className="plabel"><span className="pt" style={{ color: liveNow ? '#4ade80' : '#fbbf24' }}>OUTPUT · {fmt.toUpperCase()}{liveNow ? '' : ' · DVR'}</span></div>
        {/* On-air state: green ON AIR when published to the public, blue PREVIEW when the
            packaged output is playing but held private (verify DASH/HLS before going on air).
            Centered at the top so it never sits behind the OUTPUT label or the LIVE badge. */}
        <div style={{
          position: 'absolute', top: 10, left: '50%', transform: 'translateX(-50%)',
          display: 'inline-flex', alignItems: 'center', gap: 6, whiteSpace: 'nowrap',
          fontSize: 'var(--fs-label)', fontWeight: 700, letterSpacing: .4, padding: '4px 10px', borderRadius: 999,
          background: onAir ? 'rgba(74,222,128,.18)' : 'rgba(56,189,248,.18)',
          border: `1px solid ${onAir ? 'rgba(74,222,128,.55)' : 'rgba(56,189,248,.55)'}`,
          color: onAir ? '#4ade80' : '#38bdf8', backdropFilter: 'blur(2px)',
        }}><span className="dot-s" style={{ background: onAir ? '#4ade80' : '#38bdf8' }} />{onAir ? 'ON AIR' : 'PREVIEW · not on air'}</div>
        <div className="badge-live" style={liveNow ? undefined : { background: 'rgba(251,191,36,.9)' }}><span className="d" />{liveNow ? 'LIVE' : 'DVR'}</div>
        {/* The watermark is burned into the encoded output (transcode), so it is
            already in these pixels. We intentionally do NOT paint a DOM overlay. */}
        <AudioDock eng={eng} tracks={audioTracks} currentTrack={audioTrack} onSelectTrack={setAudioTrack} controlsShown={controlsShown} />
        {/* legacy overlay only for the test-stream side-VTT path; real channels render
            the subtitle track natively in the player (from the manifest), so we don't
            double up here. */}
        {subOn && cue && !d.captions?.enabled && (
          <div style={{
            position: 'absolute', left: '50%', bottom: 20, transform: 'translateX(-50%)',
            background: 'rgba(0,0,0,.72)', color: '#fff', padding: '6px 14px', borderRadius: 6,
            fontSize: 'var(--fs-h2)', fontWeight: 600, maxWidth: '88%', textAlign: 'center', lineHeight: 1.35, whiteSpace: 'pre-line',
          }}>{cue}</div>
        )}
        {stalled && (
          <div style={{
            position: 'absolute', inset: 0, display: 'grid', placeItems: 'center', zIndex: 6,
            background: 'rgba(2,6,14,.55)', backdropFilter: 'blur(1px)',
          }}>
            <div style={{ textAlign: 'center', color: '#fecaca' }}>
              <div style={{ fontWeight: 800, fontSize: 'var(--fs-h2)', letterSpacing: '.06em' }}>PLAYBACK STALLED</div>
              <div style={{ fontSize: 'var(--fs-sm)', color: 'var(--muted)', marginTop: 4 }}>The playhead stopped advancing. Recovering automatically…</div>
            </div>
          </div>
        )}
        <div className="ptime">{stalled ? 'stalled — recovering' : liveNow ? 'live edge' : `${fmtOffset(behind)} behind live`}</div>
      </div>

      {/* DVR scrubber — LIVE is the right end. The handle sits at the right (live) and you
          drag LEFT to go back into already-aired content. It does not bounce as new chunks
          append: while live the handle is pinned right; the bar just widens as the DVR fills
          (a couple of minutes at first, up to the full window after an hour). Dragging to a
          position plays that far back from live (e.g. halfway on a 1h window = 30m ago). */}
      <div style={{ padding: '10px 12px 4px', borderBottom: '1px solid var(--border)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 7 }}>
          <span className={`tag ${liveNow ? 'live' : 'warn'}`} style={{ minWidth: 74, justifyContent: 'center' }}>
            {liveNow ? <><span className="dot-s live" />LIVE</> : `−${fmtOffset(behind)}`}
          </span>
          <input type="range" min={0} max={sliderMax} step={1} value={sliderVal}
            onChange={e => seekBehind(sliderMax - Number(e.target.value))}
            style={{ flex: 1, accentColor: liveNow ? 'var(--live)' : 'var(--warn)' }} aria-label="DVR timeline — right is live, drag left to go back" />
          <button className="chip" style={{ padding: '5px 10px' }} disabled={liveNow} onClick={goLive}>Go live</button>
        </div>
        <div style={{ display: 'flex', gap: 6, justifyContent: 'space-between', fontSize: 'var(--fs-label)', color: 'var(--faint)' }}>
          <span>{d.dvr_mode === 'event_start' ? 'Event start' : `${fmtWindow(winSec)} DVR available`}</span>
          <span style={{ display: 'flex', gap: 6 }}>
            <button className="chip" style={{ padding: '3px 8px', fontSize: 'var(--fs-label)' }} onClick={() => seekBehind(behind + 15)}>« 15s</button>
            <button className="chip" style={{ padding: '3px 8px', fontSize: 'var(--fs-label)' }} onClick={() => seekBehind(behind + 60)}>« 1m</button>
          </span>
          <span style={{ color: liveNow ? 'var(--live)' : 'var(--faint)' }}>Live ▸</span>
        </div>
      </div>

      <div className="pfoot">
        <span className={`dot-s ${stalled ? 'down' : 'live'}`} /> {stalled ? 'Stalled — recovering' : `Playing ${fmt.toUpperCase()}`}
        {latency && (
          <span title={latency.exact
            ? 'Estimated latency from the encoder writing a segment to it playing here, measured from the manifest wall-clock stamps. Add a few seconds of ingest/encode ahead of that for full input to output.'
            : 'Approximate latency (no wall-clock stamps in this manifest): distance behind the newest buffered content plus packaging time.'}
            style={{ fontSize: 'var(--fs-label)', color: 'var(--faint)', marginLeft: 10 }}>
            latency {latency.exact ? '≈' : '~'}{latency.sec}s
          </span>
        )}
        <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center', marginLeft: 'auto' }}>
          {/* HLS / DASH toggle — verify BOTH packagings play. Only shown when the
              channel produces both; otherwise there is only one output to preview. */}
          {hasHls && hasDash && (
            <span style={{ display: 'inline-flex', border: '1px solid var(--border)', borderRadius: 8, overflow: 'hidden' }}>
              <button className={`chip ${fmt === 'hls' ? 'active' : ''}`} style={{ padding: '5px 10px', borderRadius: 0 }} onClick={() => setFmt('hls')}>HLS</button>
              <button className={`chip ${fmt === 'dash' ? 'active' : ''}`} style={{ padding: '5px 10px', borderRadius: 0 }} onClick={() => setFmt('dash')}>DASH</button>
            </span>
          )}
          <button className={`chip ${stats.open ? 'active' : ''}`} style={{ padding: '5px 10px' }} onClick={stats.toggle}
            title="Playback stats: resolution, dropped frames, codecs, bandwidth, buffer, latency, CDN (also right-click the picture, or Shift+D)">Stats</button>
          {capStatus && capStatus.kind === 'error' && (
            <span title={capStatus.hint || 'captions engine error — see the QC log'} style={{ fontSize: 'var(--fs-label)', color: '#fca5a5', maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              captions failed: {capStatus.reason}
            </span>
          )}
          {/* caption offset badge removed: it read as a fault indicator without helping
              diagnose anything. The per-chunk alignment story (chunk id, audio wall
              window, mapped video PTS) now lives in the QC event log instead. */}
          {capStatus && capStatus.kind === 'starting' && (
            <span style={{ fontSize: 'var(--fs-label)', color: 'var(--faint)' }}>captions starting…</span>
          )}
          {/* CC ONLY WHEN THERE IS A TRANSCRIPTION: subtitle tracks in the
              manifest (or the test stream's side captions). No button that
              switches nothing on. The languages are the ones actually there. */}
          {ccLangs.length > 0 && <>
            <button className={`chip ${subOn ? 'active' : ''}`} style={{ padding: '5px 10px' }} onClick={() => setSubOn(!subOn)} title="Subtitles from the live transcription">CC</button>
            {subOn && ccLangs.length > 1 && (
              <select value={subLang} onChange={e => setSubLang(e.target.value)}>
                {ccLangs.map(c => <option key={c} value={c}>{langOpts.find(l => l.code === c)?.label || c.toUpperCase()}</option>)}
              </select>
            )}
          </>}
          <select value={level} onChange={e => setLevel(Number(e.target.value))}>
            <option value={-1}>Auto (ABR)</option>
            {levels.map((l, i) => <option key={i} value={i}>{l.height}p · {(l.bitrate / 1e6).toFixed(1)} Mbps</option>)}
          </select>
        </span>
      </div>
      <div className="geo-check">
        <span className="gl">View as a viewer in</span>
        <select className="inp sel-sm" value={geoAs} onChange={e => setGeoAs(e.target.value)} aria-label="Country to check">
          <option value="">Choose a country…</option>
          {COUNTRIES.map(c => <option key={c.code} value={c.code}>{c.name} ({c.code})</option>)}
        </select>
        {geoAs && (
          <select className="inp sel-sm" value={geoViewer} onChange={e => setGeoViewer(e.target.value as any)} aria-label="Who the viewer is">
            <option value="anonymous">Not signed in</option>
            <option value="member">Signed in</option>
            <option value="entitled">Has paid for it</option>
          </select>
        )}
        {geoAs && (geoErr
          ? <span className="gv bad">{geoErr}</span>
          : !geoRes ? <span className="gv">Checking…</span>
          : geoRes.allowed && !geoRes.replacement
            ? <span className="gv ok"><span className="dot-s ok" />Can watch{geoRes.layer === 'rules' ? ' (an access rule allows it)' : ''}</span>
            : geoRes.allowed
              ? <span className="gv warn"><span className="dot-s warn" />Sees a replacement</span>
              : <span className="gv bad"><span className="dot-s down" />Blocked: {layerName[geoRes.layer] || 'access rules'}</span>)}
        {geoAs && <button type="button" className="chip" onClick={() => setGeoAs('')}>Clear</button>}
      </div>
    </div>
  )
}

/* ------------------------------------------------- pre-on-air failover test */
// Validate the failover paths BEFORE going on air: force the encoder to slate, loop,
// or backup (or simulate a primary loss) and watch the real output switch. On channels
// where the encoder selector is not running (transcode / no redundancy), the same
// controls drive a client-side PREVIEW of what each failover state looks like, so the
// sequence can still be demonstrated to a client.
const FAILOVER_STEPS: { m: FailoverMode; label: string; hue: string; note: string }[] = [
  { m: 'primary_down', label: 'Simulate primary loss', hue: '#fbbf24', note: 'Primary feed drops — selector picks the best remaining source' },
  { m: 'slate', label: 'Slate', hue: '#38bdf8', note: 'Static slate card covers the output' },
  { m: 'loop', label: 'Loop', hue: '#a78bfa', note: 'Loop / VOD filler plays' },
  { m: 'backup', label: 'Backup source', hue: '#4ade80', note: 'Switch to the backup input' },
]
function FailoverTestPanel({ d, sourceUp }: { d: CD; sourceUp: boolean }) {
  const canRun = useAccess().can('channels', 'operate')
  const [cap, setCap] = useState<FailoverTestState | null>(null)
  const [mode, setMode] = useState<FailoverMode>('auto')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  // Re-fetch the capability whenever the channel's failover-relevant settings change,
  // not just on channel id. Saving Settings reloads the parent `d` with the same id, so
  // keying on these fields lets the panel reflect a freshly enabled failover (or a
  // changed filler behaviour) without a manual page refresh.
  useEffect(() => {
    let ok = true
    api.failoverTestStatus(d.id).then(s => { if (ok) { setCap(s); setMode(s.mode) } }).catch(() => {})
    return () => { ok = false }
  }, [d.id, d.input_failover_enabled, d.auto_failback, d.input_loss_behavior, d.filler_slate_ref, d.filler_asset_id])
  const real = !!cap?.realFailover
  // Failover acts on the RUNNING encoder's source selector. Before the channel is
  // started there is nothing to switch, so the test/switch actions stay disabled
  // (and the API refuses them too). Once running, health-driven failover is armed
  // automatically: an invalid or lost source engages the backup/filler by itself
  // after the start-up grace; this panel is for forcing paths on purpose.
  const running = d.health?.gates.find(g => g.gate === 'server')?.status === 'healthy'
  const apply = async (m: FailoverMode) => {
    if (!real || !running) return   // no running selector to drive; nothing to force
    setErr(''); setBusy(true)
    try { const s = await api.failoverTest(d.id, m); setMode(s.mode); setCap(s) } catch (e: any) { setErr(e.message) } finally { setBusy(false) }
  }
  const active = FAILOVER_STEPS.find(s => s.m === mode)
  const loopDesc = cap?.lossBehavior === 'vod_loop'
    ? (cap?.loopKind === 'uploaded' ? 'a pre-selected loop video'
      : cap?.loopKind === 'motion_slate' ? 'a loop made from the slate image (gentle motion)'
      : 'a loop (no slate set yet, using the default)')
    : cap?.lossBehavior === 'slate' ? 'a static slate image'
    : cap?.lossBehavior === 'last_frame' ? 'the frozen last frame'
    : cap?.lossBehavior === 'black' ? 'black'
    : cap?.lossBehavior === 'none' ? 'nothing (output stops)'
    : 'not configured'
  // Only offer failover control once there is something to fail over TO: a backup source,
  // a filler (slate/loop), or input failover already enabled. Otherwise hide it entirely
  // (it belongs in setup, not the main view for a channel with no redundancy).
  const configured = !!cap && (real || cap.hasBackup || cap.hasSlate
    || (!!cap.lossBehavior && cap.lossBehavior !== 'none'))
  if (!configured) return null
  return (
    <div className="card" style={{ marginBottom: 18, padding: '14px 16px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 4 }}>
        <b style={{ fontSize: 'var(--fs-h3)' }}>Failover control</b>
        <span className={`tag ${real ? 'live' : 'idle'}`} style={{ fontSize: 'var(--fs-micro)' }}>
          <span className={`dot-s ${real ? 'live' : 'idle'}`} />{real ? 'ENABLED' : 'NOT ENABLED'}
        </span>
        {real && mode !== 'auto' && <span className="tag warn" style={{ fontSize: 'var(--fs-micro)' }}>ACTIVE: {active?.label || mode}</span>}
      </div>
      {real ? (
        <>
          <div style={{ fontSize: 'var(--fs-sm)', color: 'var(--muted)', marginBottom: 8 }}>
            On total input loss the filler is <b style={{ color: 'var(--text)' }}>{loopDesc}</b>. Set this in Settings, under Filler on total loss.
          </div>
          <div style={{ fontSize: 'var(--fs-sm)', color: 'var(--muted)', marginBottom: 12 }}>
            A pre-flight test and a live manual switch: force a path and the real output switches within a second or two, then Resume. You can also use it on purpose, to move off a primary or bring it back.
          </div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {FAILOVER_STEPS.map(s => (
              <button key={s.m} className={`btn ${mode === s.m ? 'primary' : 'ghost'}`} disabled={busy || !running || !canRun}
                title={running ? s.note : 'Start the channel first: failover acts on the running encoder'}
                onClick={() => apply(s.m)} style={{ padding: '7px 12px' }}>
                <span className="dot-s" style={{ background: s.hue, marginRight: 6 }} />{s.label}
              </button>
            ))}
            <button className={`btn ${mode === 'auto' ? 'primary' : 'ghost'}`} disabled={busy || !running || !canRun}
              onClick={() => apply('auto')} style={{ padding: '7px 12px', marginLeft: 'auto' }}>
              Resume normal
            </button>
          </div>
          {!running && (
            <div className="td" style={{ color: 'var(--muted)', marginTop: 10 }}>
              Controls arm once the channel is STARTED: failover acts on the running encoder, so there is nothing to switch before then. While running, automatic failover is always armed. If the source is invalid or lost, the encoder switches to the backup or filler by itself; these buttons force a path on purpose.
            </div>
          )}
          {mode !== 'auto' && sourceUp && (
            <div className="td" style={{ color: 'var(--muted)', marginTop: 10 }}>Watch the OUTPUT player above. Press Resume normal to return to health-driven behaviour.</div>
          )}
          {err && <div style={{ marginTop: 10 }}><Notice kind="error" variant="compact" message={err} /></div>}
        </>
      ) : (
        <div style={{ fontSize: 'var(--fs-sm)', color: 'var(--muted)' }}>
          Input failover is off for this channel, so there is nothing to switch yet. Turn on <b style={{ color: 'var(--text)' }}>Enable input failover</b> in Settings and add a backup source, then start the channel. This panel will then let you test each failover path and switch sources on purpose, with the result shown in the output player above.
        </div>
      )}
    </div>
  )
}

/* LOG LINES WRAP, AND LONG ONES FOLD. Encoder and pipeline lines carry URLs,
   paths and JSON with no spaces in them, which pushed the panel sideways. A
   line now breaks anywhere, shows at most three lines, and a click opens it. */
function LogDetail({ text, small, style }: { text?: string | null; small?: boolean; style?: CSSProperties }) {
  const [open, setOpen] = useState(false)
  if (!text) return null
  const long = text.length > 180
  const Tag = small ? 'small' : 'span'
  return (
    <Tag className={`log-detail${long && !open ? ' clamp' : ''}${long ? ' long' : ''}`} style={style}
      title={long && !open ? 'Click to show the whole line' : undefined}
      onClick={long ? () => setOpen((o) => !o) : undefined}>{text}</Tag>
  )
}

/* --------------------------------------------------------------------- EPG */
/* Durations in words, never "1:00 / 5:00", which reads as clock times.
   Seconds only while they matter (under 10 minutes). */
function fmtSpan(ms: number) {
  const t = Math.max(0, Math.round(ms / 1000))
  const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = t % 60
  if (h) return `${h} h${m ? ` ${m} min` : ''}`
  if (t >= 600) return `${m} min`
  return m ? `${m} min${s ? ` ${s} s` : ''}` : `${s} s`
}
/* A COUNTDOWN THAT DOES NOT MOVE THE TEXT AROUND IT. As the seconds tick,
   "9 s" becomes "10 s" and "1 min" becomes "1 min 5 s", so everything after a
   counter used to slide, and the right-aligned Up next line jumped as a whole.
   Each counter now sits in a slot as wide as the widest value its range can
   show (an invisible copy in the same grid cell), right-aligned, with the
   seconds padded to two digits and tabular figures. The slot only changes
   size when the range does (under 10 min, under an hour, hours), which is at
   most a couple of times a programme. */
function steady(ms: number): { text: string; ghost: string } {
  const t = Math.max(0, Math.round(ms / 1000))
  const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), sec = t % 60
  const p2 = (n: number) => String(n).padStart(2, '0')
  if (h) return { text: `${h} h ${p2(m)} min`, ghost: `${h >= 10 ? '00' : '0'} h 00 min` }
  if (t >= 600) return { text: `${m} min`, ghost: '00 min' }
  return { text: m ? `${m} min ${p2(sec)} s` : `${sec} s`, ghost: '0 min 00 s' }
}
function Count({ ms, strong }: { ms: number; strong?: boolean }) {
  const v = steady(ms)
  const Tag = strong ? 'b' : 'span'
  return (
    <Tag className="epg-count">
      <span aria-hidden className="ghost">{v.ghost}</span>
      <span>{v.text}</span>
    </Tag>
  )
}
const clockOf = (ms: number) => { const d = new Date(ms); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}` }

function EpgStrip({ d, onAddEpg, onHideEpg }: { d: CD; onAddEpg: () => void; onHideEpg: () => void }) {
  // The page refreshes every 6 s; the strip keeps its own second hand so the
  // marker, the progress and "left" move smoothly and the on-air card changes
  // the moment a programme ends, not at the next refresh.
  const [t, setT] = useState(Date.now())
  useEffect(() => { const iv = setInterval(() => setT(Date.now()), 1000); return () => clearInterval(iv) }, [])

  const raw: any[] = d.epg.lane ?? []
  const lane = raw.map((p: any) => {
    if (typeof p.startMs !== 'number' || typeof p.endMs !== 'number') return p   // an older server
    const state = p.endMs <= t ? 'past' : p.startMs <= t ? 'now' : ''
    return { ...p, state, progress: state === 'now' ? ((t - p.startMs) / (p.endMs - p.startMs)) * 100 : undefined }
  })
  const nowIdx = lane.findIndex((p: any) => p.state === 'now')
  const cur = nowIdx >= 0 ? lane[nowIdx] : null
  const next = lane.find((p: any) => typeof p.startMs === 'number' && p.startMs > t) ?? null

  // Keep the on-air card in view: one finished programme to its left for context.
  // Follows the change of programme, but leaves a viewer who scrolled alone until then.
  const laneRef = useRef<HTMLDivElement>(null)
  const anchor = nowIdx >= 0 ? nowIdx : lane.findIndex((p: any) => p.state !== 'past')
  useEffect(() => {
    const el = laneRef.current
    if (!el || anchor < 0) return
    const card = el.querySelectorAll<HTMLElement>('.epg-prog')[Math.max(0, anchor - 1)]
    if (card) el.scrollTo({ left: Math.max(0, el.scrollLeft + card.getBoundingClientRect().left - el.getBoundingClientRect().left - 16), behavior: 'smooth' })
  }, [anchor, raw.length])

  // Hidden entirely when the channel has the guide turned off (Settings).
  if (d.epgEnabled === false) return null
  const hasEpg = raw.length > 0

  // No programmes: don't show a dead "ON NOW —" strip. Offer a call to action to
  // add a guide, or to hide the panel for this channel.
  if (!hasEpg) {
    return (
      <div className="card" style={{ marginBottom: 18, display: 'flex', alignItems: 'center', gap: 14, padding: '14px 16px' }}>
        <span className="tag idle"><span className="dot-s idle" />NO EPG</span>
        <div style={{ flex: 1 }}>
          <div style={{ fontWeight: 600 }}>No programme guide for this channel</div>
          <div style={{ fontSize: 'var(--fs-sm)', color: 'var(--muted)' }}>Add programmes to show now/next and a schedule, or hide this panel.</div>
        </div>
        <button className="btn primary" onClick={onAddEpg}>Add EPG</button>
        <button className="btn ghost" onClick={onHideEpg}>Hide</button>
      </div>
    )
  }

  // Elapsed and remaining in words. Falls back to the server's minute figures.
  const now = cur ?? d.epg.now
  let timing: ReactElement | null = null
  if (now && typeof now.startMs === 'number') {
    const total = now.endMs - now.startMs, done = t - now.startMs
    timing = (
      <span className="epg-elapsed" title={`${now.start} to ${now.end}`}>
        <span className="epg-mini" aria-hidden><span style={{ width: `${Math.min(100, (done / total) * 100)}%` }} /></span>
        {/* Time left is the Up next countdown on the right, so it is not repeated here. */}
        <span className="epg-in"><Count ms={done} strong /> in, of {fmtSpan(total)}</span>
      </span>
    )
  } else if (now) {
    timing = <span className="epg-elapsed"><span className="epg-in"><b>{now.elapsedMin} min</b> in, of {now.mins} min</span></span>
  }
  const nx = next ?? d.epg.next

  return (
    <div className="card" style={{ marginBottom: 18 }}>
      <div className="epg-head">
        <span className="tag live"><span className="dot-s live" />ON NOW</span>
        <b>{now?.name || '—'}</b>
        {timing}
        <div className="spacer" />
        {nx && <span className="epg-next">Up next · <b>{nx.name}</b> · {nx.start}{typeof nx.startMs === 'number' && nx.startMs > t && <> · in <Count ms={nx.startMs - t} /></>}</span>}
      </div>
      <div className="epg-lane" ref={laneRef}>
        <div className="epg-track">
          {lane.map((p: any, i: number) => (
            <div key={p.startMs ?? i} className={`epg-prog ${p.state || ''}`} aria-current={p.state === 'now' ? 'true' : undefined}>
              {p.state === 'now' && <>
                <span className="fill" style={{ width: `${p.progress}%` }} />
                <span className="nowline" style={{ left: `${p.progress}%` }}><span className="nowlbl">Now {clockOf(t)}</span></span>
                <span className="epg-onair">ON AIR</span>
              </>}
              <div className="pnm">{p.name}</div>
              <div className="ptm">{p.start} – {p.end} · {p.mins} min</div>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

/* ----------------------------------------------------------------- viewers */
/** Shared with the event page (EventDetail.tsx). */
export function ViewersCard({ d, live }: { d: CD; live: boolean }) {
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
          <div style={{ color: 'var(--muted)', fontSize: 'var(--fs-body)' }}>
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
/** Shared with the event page (EventDetail.tsx). */
export function StatusBoard({ d, live }: { d: CD; live: boolean }) {
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
        <div style={{ fontSize: 'var(--fs-label)', letterSpacing: '.06em', textTransform: 'uppercase', color: 'var(--faint)', marginBottom: 8 }}>Inputs</div>
        <div className="src-lights" style={{ marginBottom: 16 }}>
          {d.statusBoard.inputs.map((s: any, i: number) => (
            <div className="src" key={i}><span className={`dot-s ${s.state}`} /><span className="nm">{s.label ? `${s.label} ` : ''}{s.role[0].toUpperCase() + s.role.slice(1)} · {s.protocol}</span><span className="st">{s.detail}{(() => {
              const r = d.metrics?.ingest.find(x => x.role === s.role && (x.label ?? null) === (s.label ?? null)) ?? (d.metrics?.ingest.length === 1 && s.role === 'primary' ? d.metrics.ingest[0] : undefined)
              return r && r.bps != null ? ` · ${fmtBps(r.bps)}, ${fmtBytes(r.bytes ?? 0)} so far` : ''
            })()}</span></div>
          ))}
        </div>
        {ladder.length > 0 && <>
          <div style={{ fontSize: 'var(--fs-label)', letterSpacing: '.06em', textTransform: 'uppercase', color: 'var(--faint)', marginBottom: 9 }}>Rendition ladder</div>
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
/** Shared with the event page (EventDetail.tsx). */
export function EventLog({ d }: { d: CD }) {
  return (
    <div className="card">
      <div className="card-h"><h3>Connection issues &amp; event log</h3><div className="spacer" /><span className="tag warn">{d.log.filter(l => l.level === 'warn' || l.level === 'down').length} today</span></div>
      <div className="card-b" style={{ padding: '8px 18px' }}>
        <div className="log">
          {d.log.map((l, i) => (
            <div className="logrow" key={i}><span className="ts">{l.ts}</span><span className="ic" style={{ background: LOG_COLOR[l.level] || 'var(--sched)' }} /><span className="tx">{l.title}<LogDetail text={l.detail} small /></span></div>
          ))}
        </div>
      </div>
    </div>
  )
}

/* ------------------------------------------------------------ settings drawer */
function SettingsDrawer({ d, onClose, onSaved }: { d: CD; onClose: () => void; onSaved: () => void }) {
  // WHILE THIS FORM IS OPEN, the record underneath it can move. The 409 on save
  // already catches that and is the wrong end of the problem: by then the
  // operator has retyped a form against a record they cannot see. This says so
  // while there is still time to do something about it. See liveRecord.tsx.
  const live = useRecordWatch('channel', d.id, d.version)
  // SETTINGS LOCK: while the encoder runs, what it read at start cannot change
  // (services/settingsLock.ts). The fields stay on screen and selectable, so a
  // URL can still be copied; their setters just do nothing, and save() leaves
  // them out so the rest of the form still saves.
  const locked = !!d.encoderRunning
  function lockSet<T>(f: Dispatch<SetStateAction<T>>): Dispatch<SetStateAction<T>> {
    return (v) => { if (!locked) f(v) }
  }
  const [name, setName] = useState(d.name)
  // retention as number + unit dropdown (minutes..months). Seed from seconds if set,
  // else from the legacy days field. Blank number = keep forever.
  const initRetSec = (d as any).recording_retention_sec != null
    ? Number((d as any).recording_retention_sec)
    : (d.recording_retention_days != null ? d.recording_retention_days * 86400 : null)
  const initRet = splitDuration(initRetSec)
  const initRecOn = (d as any).recording_enabled !== false
  const [recOn, setRecOn] = useState(initRecOn)
  const [retNum, setRetNum] = useState<string>(initRet.n)
  const [retUnit, setRetUnit] = useState<RetUnit>(initRet.unit)
  // DVR
  const [dvrMode, setDvrModeRaw] = useState<'sliding' | 'event_start'>(d.dvr_mode)
  const setDvrMode = lockSet(setDvrModeRaw)
  const [dvrMin, setDvrMinRaw] = useState<string>(String(Math.round((d.dvr_window_sec ?? d.dvr.effective_sec) / 60)))
  const setDvrMin = lockSet(setDvrMinRaw)
  // source (protocol-aware, per input)
  const protocols = useProtocols('video')
  const src0 = d.sources.find(s => s.role === 'primary') || d.sources[0]
  const src1 = d.sources.find(s => s.role === 'backup')
  // the stream key and the protocol's settings come back too (they were dropped before)
  const [primary, setPrimaryRaw] = useState<SourceValue>(sourceFromRow(src0))
  const setPrimary = lockSet(setPrimaryRaw)
  const [backup, setBackupRaw] = useState<SourceValue>(src1 ? sourceFromRow(src1) : { protocol: (src0?.protocol || 'srt').toLowerCase(), url: '' })
  const setBackup = lockSet(setBackupRaw)
  // PACKAGING: the sent ladder, one input per rendition (same form as New channel).
  const isPkg = d.profile?.workflow_type === 'package_only'
  const pkgInit = useMemo(() => pkgFromSources(d.sources, d.ladder || [], !!d.fallback_transcode), [d.id, d.version])
  const [pkgRows, setPkgRowsRaw] = useState<PkgRow[]>(pkgInit.rows)
  const setPkgRows = lockSet(setPkgRowsRaw)
  const [pkgMode, setPkgModeRaw] = useState<PkgFallback>(pkgInit.mode)
  const setPkgMode = lockSet(setPkgModeRaw)
  const [pkgFb, setPkgFbRaw] = useState<SourceValue>(pkgInit.fb)
  const setPkgFb = lockSet(setPkgFbRaw)
  // geo
  const [geoMode, setGeoMode] = useState(d.geo_mode)
  const [geoCountries, setGeoCountries] = useState(d.geo_countries.join(', '))
  // output ABR ladder (transcode rungs) — add / remove / edit bitrates
  const [rungs, setRungsRaw] = useState<{ height: number; bitrateKbps: number }[]>(
    (d.ladder || []).map(r => ({ height: r.height, bitrateKbps: r.bitrate_kbps })))
  const setRungs = lockSet(setRungsRaw)
  // programme guide (EPG) panel visibility
  const [epgOn, setEpgOn] = useState(d.epgEnabled !== false)
  const [gfx, setGfx] = useState<GraphicsValue>(((d as any).graphics as GraphicsValue) ?? {})
  const [autoConn, setAutoConn] = useState(d.autoConnect !== false)
  // CONTENT TYPE + the base metadata entry (what the guide shows with no programme on).
  const [tab, setTab] = useState<DrawerTab>('settings')
  const [typeId, setTypeId] = useState<string | null>(d.schemaId ?? null)
  const [meta, setMeta] = useState<Record<string, any>>(d.metadata ?? {})
  // subtitles
  const [capOn, setCapOnRaw] = useState(d.captions.enabled)
  const setCapOn = lockSet(setCapOnRaw)
  const [capLangs, setCapLangsRaw] = useState<string[]>(d.captions.targets.length ? d.captions.targets : ['en'])
  const setCapLangs = lockSet(setCapLangsRaw)
  const [capTrim, setCapTrimRaw] = useState(String(d.captions.offset_sec ?? 0))
  const setCapTrim = lockSet(setCapTrimRaw)
  const langOpts = useCaptionLanguages()
  // filler on loss
  const [lossBehavior, setLossBehaviorRaw] = useState<'none' | 'slate' | 'vod_loop' | 'last_frame' | 'black'>(d.input_loss_behavior || 'none')
  const setLossBehavior = lockSet(setLossBehaviorRaw)
  const [slateRef, setSlateRefRaw] = useState(d.filler_slate_ref || '')
  const setSlateRef = lockSet(setSlateRefRaw)
  const [fillerAssetId, setFillerAssetIdRaw] = useState<string | null>(d.filler_asset_id ?? null)
  const setFillerAssetId = lockSet(setFillerAssetIdRaw)
  const [failover, setFailoverRaw] = useState(!!d.input_failover_enabled)
  const setFailover = lockSet(setFailoverRaw)
  const [autoFailback, setAutoFailbackRaw] = useState(d.auto_failback !== false)
  const setAutoFailback = lockSet(setAutoFailbackRaw)
  // watermark / channel brand overlay
  const [wmEnabled, setWmEnabledRaw] = useState(d.watermark?.enabled ?? false)
  const setWmEnabled = lockSet(setWmEnabledRaw)
  const [wmRef, setWmRefRaw] = useState(d.watermark?.ref || '')
  const setWmRef = lockSet(setWmRefRaw)
  const [wmPos, setWmPosRaw] = useState<WatermarkCfg['position']>(d.watermark?.position || 'br')
  const setWmPos = lockSet(setWmPosRaw)
  const [wmX, setWmXRaw] = useState(String(d.watermark?.offsetX ?? 24))
  const setWmX = lockSet(setWmXRaw)
  const [wmY, setWmYRaw] = useState(String(d.watermark?.offsetY ?? 24))
  const setWmY = lockSet(setWmYRaw)
  const [wmOpacity, setWmOpacityRaw] = useState(d.watermark?.opacity ?? 100)
  const setWmOpacity = lockSet(setWmOpacityRaw)
  const [wmScale, setWmScaleRaw] = useState(d.watermark?.scale ?? 12)
  const setWmScale = lockSet(setWmScaleRaw)
  // channel brand image (identity logo, replaces the initials box)
  const [brandRef, setBrandRef] = useState((d as any).brand_ref || '')
  const [guideIcon, setGuideIcon] = useState((d as any).guide_icon_ref || '')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')

  const DVR_MAX_MIN = 240 // 4h
  const dvrMinNum = Math.max(0, Math.min(DVR_MAX_MIN, Number(dvrMin) || 0))

  async function save() {
    setErr('')
    if (!name.trim()) { setTab('settings'); setErr('Give the channel a name'); return }
    let pkgOut: ReturnType<typeof pkgToSources> | null = null
    if (isPkg) {
      pkgOut = pkgToSources(pkgRows, pkgMode, pkgFb, protocols)
      if ('error' in pkgOut && !locked) { setTab('settings'); setErr(pkgOut.error); return }
      const orig = (u: string) => d.sources.some(x => (x.ingest_url ?? '') === u.trim()) ? u : null
      const hlsWait = await hlsChoicePending([
        ...pkgRows.map(r => ({ url: r.url, protocol: r.protocol, original: orig(r.url) })),
        ...(pkgMode === 'matching' ? pkgRows.map(r => ({ url: r.backupUrl, protocol: r.protocol, original: orig(r.backupUrl) })) : []),
        ...(pkgMode === 'single' ? [{ url: pkgFb.url, protocol: pkgFb.protocol, original: pkgInit.fb.url }] : []),
      ])
      if (hlsWait) { setErr(hlsWait); return }
    } else {
      const hlsWait = await hlsChoicePending([{ url: primary.url, protocol: primary.protocol, original: src0?.ingest_url }, { url: backup.url, protocol: backup.protocol, original: src1?.ingest_url }]); if (hlsWait) { setErr(hlsWait); return }
    }
    const patch: ChannelSettingsPatch = { version: d.version }
    if (name.trim() && name.trim() !== d.name) patch.name = name.trim()
    patch.dvrMode = dvrMode
    if (dvrMode === 'sliding') patch.dvrWindowSec = Math.max(30, dvrMinNum * 60)
    // recording switch + retention: number × unit -> seconds; never below the DVR
    // window while DVR is on. Applies from the next channel start.
    if (recOn !== initRecOn) patch.recordingEnabled = recOn
    let retSec = retNum ? Number(retNum) * RET_UNIT_SEC[retUnit] : null
    if (retSec != null && dvrMode === 'sliding') retSec = Math.max(retSec, dvrMinNum * 60)
    if (retSec !== initRetSec) patch.recordingRetentionSec = retSec
    patch.geoMode = geoMode
    if (geoMode !== 'worldwide') patch.geoCountries = geoCountries.split(',').map(s => s.trim().toUpperCase()).filter(s => s.length === 2)
    else patch.geoCountries = []
    // sources
    const origLadder = JSON.stringify((d.ladder || []).map(r => ({ height: r.height, bitrateKbps: r.bitrate_kbps })))
    if (isPkg && pkgOut && !('error' in pkgOut)) {
      // packaging: every rendition input, its backup, and the ladder that mirrors them
      patch.sources = pkgOut.sources
      if (JSON.stringify(pkgOut.outputLadder) !== origLadder) patch.outputLadder = pkgOut.outputLadder
      if (pkgOut.fallbackTranscode !== !!d.fallback_transcode) patch.fallbackTranscode = pkgOut.fallbackTranscode
    } else if (!isPkg) {
      const sources: ChannelSettingsPatch['sources'] = []
      const why = (primary.url.trim() ? sourceProblem(protocols, primary) : null) ?? (backup.url.trim() ? sourceProblem(protocols, backup) : null)
      if (why) { setErr(`${primary.url.trim() && sourceProblem(protocols, primary) ? 'Primary' : 'Backup'} source: ${why}`); return }
      if (primary.url.trim()) sources.push({ role: 'primary', ...sourceToApi(primary, protocols) })
      if (backup.url.trim()) sources.push({ role: 'backup', ...sourceToApi(backup, protocols) })
      if (sources.length) patch.sources = sources
      // output ladder (transcode): only send when changed
      const cleanRungs = rungs.filter(r => r.height > 0 && r.bitrateKbps > 0).sort((a, b) => b.height - a.height)
      if (JSON.stringify(cleanRungs) !== origLadder) patch.outputLadder = cleanRungs
    }
    // programme guide panel
    if (epgOn !== (d.epgEnabled !== false)) patch.epgEnabled = epgOn
    if (JSON.stringify(gfx) !== JSON.stringify((d as any).graphics ?? {})) patch.graphics = gfx
    if (autoConn !== (d.autoConnect !== false)) patch.autoConnect = autoConn
    if (typeId && (typeId !== d.schemaId || JSON.stringify(meta) !== JSON.stringify(d.metadata ?? {}))) { patch.schemaId = typeId; patch.metadata = meta }
    // captions
    patch.captions = { enabled: capOn, targets: capOn ? capLangs : [],
      offsetSec: Math.max(-30, Math.min(30, Number(capTrim) || 0)) }
    // filler on loss
    patch.inputFailoverEnabled = failover
    patch.autoFailback = autoFailback
    patch.inputLossBehavior = lossBehavior
    patch.fillerAssetId = (lossBehavior === 'slate' || lossBehavior === 'vod_loop') && fillerAssetId ? fillerAssetId : null
    patch.fillerSlateRef = (lossBehavior === 'slate' || lossBehavior === 'vod_loop') && !fillerAssetId && slateRef.trim() ? slateRef.trim() : null
    // watermark / brand overlay
    patch.watermark = {
      enabled: wmEnabled,
      ref: wmEnabled && wmRef.trim() ? wmRef.trim() : null,
      position: wmPos,
      offsetX: Math.max(0, Number(wmX) || 0),
      offsetY: Math.max(0, Number(wmY) || 0),
      opacity: wmOpacity,
      scale: wmScale,
    }
    patch.brandRef = brandRef.trim() ? brandRef.trim() : null
    patch.guideIconRef = guideIcon.trim() ? guideIcon.trim() : null

    if (locked) for (const k of d.lockedWhileRunning ?? []) delete (patch as any)[k]
    setBusy(true)
    try { await api.updateChannel(d.id, patch); onSaved() }
    catch (e: any) {
      if (String(e.message).includes('409') || /version|match/i.test(e.message)) setErr('This channel changed since you opened it. Reopen settings and retry.')
      else setErr(e.message)
    } finally { setBusy(false) }
  }

  return (
    <div className="drawer-scrim" {...pressable((e: any) => { ((onClose) as any)(e) })} data-a11y-click="">
      <div className="drawer" {...pressable((e: any) => { (((e: any) => e.stopPropagation()) as any)(e) })} data-a11y-click="">
        <div className="drawer-h"><div className="t">Channel settings</div><button className="xbtn" onClick={onClose}>✕</button></div>
        <div className="drawer-b">
          {/* Reload here means "close and reopen against the current record",
              which is the only honest offer: the form cannot merge somebody
              else's change into half-typed fields without lying about which
              values are whose. */}
          <LiveEditNotice change={live.change} onReload={() => { onSaved(); onClose() }} onDismiss={live.clear} />
          <DrawerTabs tab={tab} setTab={setTab} />
          <TabPane active={tab === 'metadata'}>
            <TypePicker appliesTo="tv" value={typeId} onChange={(id) => setTypeId(id)}
              hint="The channel's identity. Its metadata is what the guide and now/next show when no programme is scheduled." />
            <MetadataForm typeId={typeId} value={meta} onChange={setMeta} entityName={{ value: name, where: 'channel' }} hide={['logo']} />
            <GuideIconField value={guideIcon} onChange={setGuideIcon} brandRef={brandRef} />
          </TabPane>
          <TabPane active={tab === 'access'}>
            <RuleEditor scopeKind="owner" scopeId={d.id} compact resolveQuery={{ channelId: d.id, schemaId: typeId }} />
          </TabPane>
          <TabPane active={tab === 'settings'}>
          <div className="field"><label>Channel name <span className="req">*</span></label><input className="inp" value={name} onChange={e => setName(e.target.value)} /></div>

          <ImageRefField label="Channel logo" hint="shown in lists, on the channel page and in the guide"
            value={brandRef} onChange={setBrandRef} pickerTitle="Choose or upload the channel logo" kinds={['brand', 'poster', 'slate', 'other']} />

          {locked && (
            <div className="lock-note" role="note">
              <strong>The channel is running.</strong> Sources, failover, filler, DVR, the output ladder, subtitles and the watermark are read by the encoder when it starts, so they are locked until you stop it. You can still select and copy them. Everything else saves as normal.
            </div>
          )}
          <div className={locked ? 'locked-zone' : undefined} aria-disabled={locked || undefined}>
          {isPkg ? (
            <PackageRenditions protocols={protocols} rows={pkgRows} onRows={setPkgRows} locked={locked}
              mode={pkgMode} onMode={(m) => { setPkgMode(m); if (m !== 'none') setFailover(true) }} fb={pkgFb} onFb={setPkgFb} />
          ) : (<>
            <div className="sec-label">Source</div>
            <SourceInput protocols={protocols} value={primary} onChange={setPrimary} label="Primary source" ladderTop={rungs.length ? Math.max(...rungs.map(r => r.height)) : undefined} />
            <SourceInput protocols={protocols} value={backup} onChange={setBackup} label="Backup source (optional)" ladderTop={rungs.length ? Math.max(...rungs.map(r => r.height)) : undefined} />
          </>)}

          <div className="sec-label">Failover</div>
          <div className="toggle-row">
            <div><div className="tt">Enable input failover</div><div className="td">If the primary source fails, switch to the backup, then to the filler, to keep the output live. Works on transcode and packaged channels.</div></div>
            <div className={`sw ${failover ? '' : 'off'}`} {...pressable((e: any) => { ((() => setFailover(v => !v)) as any)(e) })} data-a11y-click=""><i /></div>
          </div>
          {failover && (
            <div className="toggle-row">
              <div><div className="tt">Auto failback to primary</div><div className="td">Return to the primary automatically once it has been healthy for a short hold. Off keeps the output on the backup until you intervene.</div></div>
              <div className={`sw ${autoFailback ? '' : 'off'}`} {...pressable((e: any) => { ((() => setAutoFailback(v => !v)) as any)(e) })} data-a11y-click=""><i /></div>
            </div>
          )}

          <div className="sec-label">Filler on total loss</div>
          <div className="field"><label>When no source is available</label>
            <select className="inp" value={lossBehavior} onChange={e => setLossBehavior(e.target.value as any)}>
              <option value="none">None (output stops)</option>
              <option value="slate">Slate image</option>
              <option value="vod_loop">Loop video</option>
              <option value="last_frame">Freeze last frame</option>
              <option value="black">Black</option>
            </select>
          </div>
          {(lossBehavior === 'slate' || lossBehavior === 'vod_loop') && (
            <FillerField behavior={lossBehavior} assetId={fillerAssetId} onAssetId={setFillerAssetId}
              legacyRef={slateRef} onLegacyRef={setSlateRef} />
          )}

          <div className="sec-label">DVR / catch-up</div>
          <div className="field"><label>DVR mode</label>
            <div className="presets">
              <div className={`preset ${dvrMode === 'sliding' ? 'sel' : ''}`} {...pressable((e: any) => { ((() => setDvrMode('sliding')) as any)(e) })} data-a11y-click="">
                <div className="pt">Sliding window</div><div className="px">24×7 — rolling catch-up up to 4h behind live.</div>
              </div>
              <div className={`preset ${dvrMode === 'event_start' ? 'sel' : ''}`} {...pressable((e: any) => { ((() => setDvrMode('event_start')) as any)(e) })} data-a11y-click="">
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

          </div>

          <div className="sec-label">Source geo rules</div>
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

          <div className={locked ? 'locked-zone' : undefined} aria-disabled={locked || undefined}>
          {d.profile?.workflow_type === 'transcode' && (
            <>
              <div className="sec-label">Output bitrates (ABR ladder)</div>
              <div className="td" style={{ marginBottom: 8 }}>Rungs the encoder produces. Keep the top rung at or below the source resolution — don’t upscale.</div>
              {rungs.map((r, i) => (
                <div key={i} style={{ display: 'flex', gap: 8, marginBottom: 8, alignItems: 'center' }}>
                  <input className="inp" style={{ width: 90 }} type="number" value={r.height}
                    onChange={e => setRungs(rs => rs.map((x, j) => j === i ? { ...x, height: Number(e.target.value) } : x))} />
                  <span style={{ color: 'var(--faint)' }}>p ·</span>
                  <input className="inp" style={{ width: 110 }} type="number" value={r.bitrateKbps}
                    onChange={e => setRungs(rs => rs.map((x, j) => j === i ? { ...x, bitrateKbps: Number(e.target.value) } : x))} />
                  <span style={{ color: 'var(--faint)' }}>kbps</span>
                  <div style={{ flex: 1 }} />
                  <button className="btn ghost" onClick={() => setRungs(rs => rs.filter((_, j) => j !== i))}>Remove</button>
                </div>
              ))}
              {rungs.length === 0 && <div className="td" style={{ marginBottom: 8, color: 'var(--warn)' }}>No rungs — add at least one, or the channel has no output.</div>}
              <button className="btn ghost" onClick={() => setRungs(rs => [...rs, { height: 720, bitrateKbps: 2800 }])}>+ Add rung</button>
            </>
          )}

          </div>

          <div className="sec-label">Availability</div>
          <div className="toggle-row">
            <div>
              <div className="tt">Reconnect automatically after a restart</div>
              {/* The wording says what it does and, just as importantly, what it
                  does NOT do. The commonest worry about a setting like this is
                  that it will switch a channel back on after you deliberately
                  switched it off, so that is answered in the sentence rather
                  than left to be discovered. */}
              <div className="td">
                If the control plane restarts while this channel is on air, it is put back:
                re-attached to its encoder if that is still running, otherwise started again.
                A channel you stopped yourself stays stopped.
              </div>
            </div>
            <div className={`sw ${autoConn ? '' : 'off'}`} {...pressable((e: any) => { ((() => setAutoConn(v => !v)) as any)(e) })} data-a11y-click=""><i /></div>
          </div>
          {/* Auto-connect stops after five failed attempts and records why. If
              that has happened the operator has to be told, or the channel is
              simply off with no explanation anywhere. Pressing Start clears it. */}
          {d.resumeGaveUpAt && (
            <div style={{ marginTop: 6 }}><Notice kind="warn" variant="compact"
              message={`Auto reconnect gave up on ${new Date(d.resumeGaveUpAt).toLocaleString()} after repeated failures${d.resumeLastError ? `: ${d.resumeLastError}` : '.'} Starting the channel clears this.`} /></div>
          )}

          <div className="sec-label">Programme guide (EPG)</div>
          <div className="toggle-row">
            <div><div className="tt">Show programme guide panel</div><div className="td">Off hides the EPG / now-next panel for this channel.</div></div>
            <div className={`sw ${epgOn ? '' : 'off'}`} {...pressable((e: any) => { ((() => setEpgOn(v => !v)) as any)(e) })} data-a11y-click=""><i /></div>
          </div>

          <GraphicsSettings value={gfx} onChange={setGfx} hasGuide={epgOn} />
          <div className="toggle-row">
            <div><div className="tt">HTML graphics</div><div className="td">Scorebugs, lower thirds, tickers and bugs on this channel: always on, by rule or on a trigger.</div></div>
            <button type="button" className="btn ghost sm" style={{ marginLeft: 'auto' }} onClick={() => navigate(`/graphics/channel/${d.id}`)}>Open</button>
          </div>

          <div className={locked ? 'locked-zone' : undefined} aria-disabled={locked || undefined}>
          <div className="sec-label">Subtitles</div>
          <div className="toggle-row">
            <div><div className="tt">Live captions / subtitles</div><div className="td">Applies to this channel’s output profile.</div></div>
            <div className={`sw ${capOn ? '' : 'off'}`} {...pressable((e: any) => { ((() => setCapOn(v => !v)) as any)(e) })} data-a11y-click=""><i /></div>
          </div>
          {capOn && (
            <>
              <div className="field"><label>Output languages <span style={{ color: 'var(--faint)' }}>— the spoken language is detected automatically and translated into each of these</span></label>
                <LangPicker value={capLangs} onChange={setCapLangs} options={langOpts} />
              </div>
              <div className="field"><label>Subtitle offset <span style={{ color: 'var(--faint)' }}>— seconds. Use this to adjust the timing of subtitles if they are appearing too fast or slow: positive shows them later, negative earlier. Applies from the next restart.</span></label>
                <input className="inp" style={{ width: 110 }} inputMode="decimal" value={capTrim}
                  onChange={e => setCapTrim(e.target.value.replace(/[^0-9.-]/g, ''))} placeholder="0" />
              </div>
            </>
          )}

          </div>

          <RecordingSection ctx="channel" recOn={recOn} setRecOn={setRecOn}
            retNum={retNum} setRetNum={setRetNum} retUnit={retUnit} setRetUnit={setRetUnit}
            retWarn={dvrMode === 'sliding' && retNum && Number(retNum) * RET_UNIT_SEC[retUnit] < dvrMinNum * 60
              ? `Will be raised to the DVR window (${fmtWindow(dvrMinNum * 60)}) — retention can’t be shorter than DVR.` : null} />

          <div className={locked ? 'locked-zone' : undefined} aria-disabled={locked || undefined}>
          {d.profile?.workflow_type === 'transcode' && (<>
          <div className="sec-label">Watermark <span style={{ color: 'var(--faint)', fontWeight: 400 }}>: burned into the transcode output</span></div>
          <WatermarkFields hint="Burned into every rendition of this transcode channel."
            value={{ enabled: wmEnabled, ref: wmRef, position: wmPos, x: wmX, y: wmY, opacity: wmOpacity, scale: wmScale }}
            onChange={(p) => {
              if (p.enabled !== undefined) setWmEnabled(p.enabled)
              if (p.ref !== undefined) setWmRef(p.ref)
              if (p.position !== undefined) setWmPos(p.position)
              if (p.x !== undefined) setWmX(p.x)
              if (p.y !== undefined) setWmY(p.y)
              if (p.opacity !== undefined) setWmOpacity(p.opacity)
              if (p.scale !== undefined) setWmScale(p.scale)
            }} />
          </>)}
          </div>
          </TabPane>

        </div>
        <div className="drawer-f">
          <FormStatus error={err} />
          <button className="btn ghost" onClick={onClose}>Cancel</button>
          <button className="btn primary" disabled={busy} onClick={save}>{busy ? 'Saving…' : 'Save changes'}</button>
        </div>
      </div>
    </div>
  )
}

