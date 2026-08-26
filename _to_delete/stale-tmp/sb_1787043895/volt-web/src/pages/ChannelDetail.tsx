import { useEffect, useMemo, useRef, useState } from 'react'
import { api, originUrl, thumbUrl, type ChannelDetail as CD, type ChannelSettingsPatch, type ShareLinkRow, type WatermarkCfg, type FailoverMode, type FailoverTestState } from '../api'
import { navigate } from '../router'
import { subscribeLive } from '../liveStatus'
import { useProtocols, SourceInput, type SourceValue } from '../protocols'
import { ImagePicker } from '../ImagePicker'
import { LangPicker, useCaptionLanguages } from '../LangPicker'
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
  const [qcOpen, setQcOpen] = useState(false)
  const [shareOpen, setShareOpen] = useState(false)
  const [confirmStart, setConfirmStart] = useState(false)
  const [nowMs, setNowMs] = useState(Date.now())

  async function load() {
    try { setD(await api.channel(id)) } catch (e: any) { setErr(e.message) }
  }
  useEffect(() => { load(); /* eslint-disable-next-line */ }, [id])
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
  async function dropSource() {
    if (!d) return
    setBusy(true)
    // stopping the encoder also takes the channel off air on the backend
    try { await api.startStop(d.id, 'stop'); await load() } catch (e: any) { setErr(e.message) } finally { setBusy(false) }
  }

  if (err) return <div className="err" style={{ margin: 20 }}>Couldn’t load channel: {err}</div>
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
  const trulyOnAir = published && d.onAir
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

  return (
    <>
      <div className="page-head">
        <div>
          <div className="crumb" style={{ marginBottom: 6 }}>
            <span className="lnk" style={{ cursor: 'pointer', color: 'var(--brand)' }} onClick={onBack}>Channels</span>
            &nbsp;/&nbsp; <b style={{ color: 'var(--text)' }}>{d.name}</b>
          </div>
          <h1 style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            {(d as any).brand_ref
              ? <span className="dthumb" style={{ background: '#0b0f16', overflow: 'hidden', padding: 0 }}><img src={thumbUrl((d as any).brand_ref, 96, 96, 'inside')} alt="" style={{ width: '100%', height: '100%', objectFit: 'contain' }} /></span>
              : <span className="dthumb" style={{ background: 'linear-gradient(135deg,#1d4ed8,#3b82f6)' }}>{d.name.split(/\s+/).slice(0, 2).map(w => w[0]).join('').toUpperCase()}</span>}
            {d.name}
            <span className={`tag type ${wt === 'transcode' ? 'chan' : 'event'}`}>{wt === 'transcode' ? 'TRANSCODE' : 'PACKAGING'}</span>
            <span className={`tag ${stateCls}`}><span className={`dot-s ${stateCls}`} />{stateLabel}</span>
            {d.billing?.billable && (
              <span title={`Encoder up (${d.billing.instance}) — live time metering`}
                style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, padding: '3px 9px', borderRadius: 999, background: 'rgba(251,191,36,.14)', border: '1px solid rgba(251,191,36,.4)', color: '#fbbf24' }}>
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
        <button className="btn ghost" onClick={() => setQcOpen(true)} title="Diagnose the pipeline (server → input → encoder → output)"
          style={errored ? { color: '#fca5a5', borderColor: 'rgba(248,113,113,.5)' } : undefined}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M9 12l2 2 4-4" /><circle cx="12" cy="12" r="9" /></svg>QC
        </button>
        <button className="btn ghost" onClick={() => setShareOpen(true)} title="Create a private, PIN/expiry-secured preview link for a client or reviewer (not on air)">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M4 12v7a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-7" /><path d="M16 6l-4-4-4 4" /><path d="M12 2v14" /></svg>Share preview
        </button>
        <button className="btn ghost" onClick={() => { setSettingsOpen(true); onOpenSettings?.() }}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="3" /><path d="M12 3v3M12 18v3M3 12h3M18 12h3" /></svg>Settings
        </button>
        {!serverUp ? (
          <button className="btn primary" disabled={busy} onClick={() => setConfirmStart(true)}
            title="Brings the encoder up and begins ingesting the configured source">
            {busy ? 'Starting…' : 'Start channel'}
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

      {perr && (
        <div style={{
          margin: '0 0 14px', padding: '12px 14px', borderRadius: 10,
          background: 'rgba(248,113,113,.10)', border: '1px solid rgba(248,113,113,.4)',
          display: 'flex', alignItems: 'center', gap: 12,
        }}>
          <span style={{ fontSize: 18 }}>⚠</span>
          <div style={{ flex: 1 }}>
            <div style={{ fontWeight: 700, color: '#fca5a5' }}>{perr.label} {perr.gate === 'output' && outGate?.status === 'degraded' ? 'degraded' : 'failed'}</div>
            <div style={{ fontSize: 13, color: 'var(--muted)', wordBreak: 'break-word' }}>{perr.message}</div>
          </div>
          <button className="btn ghost" onClick={() => setQcOpen(true)} style={{ color: '#fca5a5', borderColor: 'rgba(248,113,113,.5)' }}>Diagnose →</button>
        </div>
      )}

      <PipelineStrip d={d} onQc={() => setQcOpen(true)} onAir={published} />

      {published && d.public?.url && (
        <div style={{
          margin: '0 0 14px', padding: '10px 14px', borderRadius: 10, display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap',
          background: d.onAir ? 'rgba(74,222,128,.10)' : 'rgba(248,113,113,.10)',
          border: `1px solid ${d.onAir ? 'rgba(74,222,128,.4)' : 'rgba(248,113,113,.4)'}`,
        }}>
          <span className="dot-s" style={{ background: d.onAir ? '#4ade80' : '#f87171' }} />
          <b style={{ color: d.onAir ? '#4ade80' : '#fca5a5' }}>{d.onAir ? 'ON AIR · public URL open' : 'ON AIR · public stream has no valid content'}</b>
          <code style={{ fontSize: 12.5, color: 'var(--muted)', background: 'rgba(148,163,184,.12)', padding: '3px 8px', borderRadius: 6 }}>{d.public.url}</code>
          <a className="btn ghost" href={d.public.url} target="_blank" rel="noreferrer" style={{ marginLeft: 'auto', padding: '5px 12px' }}>Open public HLS</a>
          <a className="btn ghost" href={d.public.dashUrl} target="_blank" rel="noreferrer" style={{ padding: '5px 12px' }}>Open public DASH</a>
        </div>
      )}

      <DualPlayers d={d} captionLangs={captionLangs} sourceUp={sourceUp} onAir={published}
        onSendSource={() => setConfirmStart(true)} onGoLive={() => setAir(true)} busy={busy} />

      <FailoverTestPanel d={d} sourceUp={sourceUp} />

      <EpgStrip d={d}
        onAddEpg={() => navigate('events')}
        onHideEpg={async () => { try { await api.updateChannel(d.id, { epgEnabled: false }); await load() } catch (e: any) { setErr(e.message) } }} />

      <ViewersCard d={d} live={live} />

      <div className="grid-2">
        <StatusBoard d={d} live={live} />
        <EventLog d={d} />
      </div>

      {settingsOpen && (
        <SettingsDrawer d={d} onClose={() => setSettingsOpen(false)}
          onSaved={() => { setSettingsOpen(false); load() }} />
      )}

      {qcOpen && <QcPanel d={d} onClose={() => setQcOpen(false)} onRefresh={load} />}

      {shareOpen && <ShareDrawer d={d} onClose={() => setShareOpen(false)} />}

      {confirmStart && (
        <StartConfirm d={d} onCancel={() => setConfirmStart(false)}
          onConfirm={() => { setConfirmStart(false); sendSource() }} />
      )}
    </>
  )
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
    <div onClick={onCancel} style={{ position: 'fixed', inset: 0, background: 'rgba(2,6,14,.6)', zIndex: 60, display: 'grid', placeItems: 'center', padding: 20 }}>
      <div onClick={e => e.stopPropagation()} style={{ width: 'min(460px,94vw)', background: 'var(--panel,#0e1420)', border: '1px solid var(--border)', borderRadius: 14, padding: 20 }}>
        <h2 style={{ margin: '0 0 6px' }}>Bring the encoder up?</h2>
        <p style={{ color: 'var(--muted)', marginTop: 0 }}>
          This starts the encoder for <b>{d.name}</b> and begins the source ingest. The encoder
          is the billable unit, so metering starts now and runs until you stop the channel.
        </p>
        {b && (
          <div style={{ margin: '12px 0', padding: '10px 12px', borderRadius: 10, background: 'rgba(251,191,36,.10)', border: '1px solid rgba(251,191,36,.35)', fontSize: 13 }}>
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
function PipelineStrip({ d, onQc }: { d: CD; onQc: () => void; onAir?: boolean }) {
  const gates = d.health?.gates || []
  if (!gates.length) return null
  return (
    <div style={{ display: 'flex', alignItems: 'stretch', gap: 6, margin: '0 0 14px', flexWrap: 'wrap' }}>
      {gates.map((g, i) => {
        // public gate: a green (healthy) public gate means we are truly on air.
        const status = g.status
        const label = (g.gate === 'public' && g.status === 'healthy') ? 'ON AIR' : g.status
        const detail = g.detail
        const color = GATE_COLOR[status]
        return (
        <div key={g.gate} style={{ display: 'flex', alignItems: 'stretch', gap: 6, flex: '1 1 130px' }}>
          <div title={detail} style={{ flex: 1, border: `1px solid ${color}55`, background: `${color}12`, borderRadius: 9, padding: '7px 10px', minWidth: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 11, color: 'var(--muted)' }}>
              <span className="dot-s" style={{ background: color }} />{g.label}
              {g.billable && <span style={{ marginLeft: 'auto', color: '#fbbf24', fontSize: 9 }}>●</span>}
            </div>
            <div style={{ fontWeight: 700, fontSize: 11.5, color, textTransform: 'uppercase' }}>{label}</div>
            <div style={{ fontSize: 10.5, color: 'var(--faint)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{detail}</div>
          </div>
          {i < gates.length - 1 && <div style={{ display: 'grid', placeItems: 'center', color: 'var(--faint)', fontSize: 12 }}>→</div>}
        </div>
        )
      })}
    </div>
  )
}

/* ------------------------------------------------------------- QC / diagnose */
const GATE_META: Record<string, { icon: string; hint: string }> = {
  server:  { icon: '▣', hint: 'Encoder compute (this is the billable unit)' },
  input:   { icon: '⬇', hint: 'Is the source arriving?' },
  encoder: { icon: '⚙', hint: 'Transcode/package running & keeping up?' },
  output:  { icon: '⬆', hint: 'Are packaged segments advancing?' },
  public:  { icon: '📡', hint: 'Is the output being served to viewers?' },
}
const GATE_COLOR: Record<string, string> = {
  healthy: '#4ade80', degraded: '#fbbf24', failed: '#f87171',
  ready: '#38bdf8', starting: '#60a5fa', stopped: '#94a3b8', idle: '#64748b',
}
function QcPanel({ d, onClose, onRefresh }: { d: CD; onClose: () => void; onRefresh: () => void }) {
  const h = d.health
  const gates = h?.gates || []
  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(2,6,14,.6)', zIndex: 60, display: 'grid', placeItems: 'center', padding: 20 }}>
      <div onClick={e => e.stopPropagation()} style={{ width: 'min(920px,96vw)', maxHeight: '92vh', overflow: 'auto', background: 'var(--panel,#0e1420)', border: '1px solid var(--border)', borderRadius: 14, padding: 20 }}>
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

        {h?.primaryError && (
          <div style={{ margin: '10px 0 16px', padding: '12px 14px', borderRadius: 10, background: 'rgba(248,113,113,.10)', border: '1px solid rgba(248,113,113,.4)' }}>
            <div style={{ fontWeight: 700, color: '#fca5a5' }}>Primary issue — {h.primaryError.label}</div>
            <div style={{ fontSize: 13, color: 'var(--muted)' }}>{h.primaryError.message}</div>
          </div>
        )}

        {/* billing window (the server is the meter) */}
        {d.billing && (
          <div style={{ margin: '4px 0 14px', padding: '10px 12px', borderRadius: 10, border: '1px solid var(--border)', display: 'flex', gap: 18, flexWrap: 'wrap', fontSize: 13 }}>
            <span><span style={{ color: 'var(--faint)' }}>Billing </span>{d.billing.billable ? <b style={{ color: '#fbbf24' }}>● metering</b> : <b style={{ color: 'var(--muted)' }}>idle</b>}</span>
            <span><span style={{ color: 'var(--faint)' }}>Live time this run </span>{fmtDur(d.billing.elapsedSec)}</span>
            <span><span style={{ color: 'var(--faint)' }}>Instance </span>{d.billing.instance}</span>
          </div>
        )}

        {/* the five gates, left to right */}
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', margin: '8px 0 18px' }}>
          {gates.map((g, i) => (
            <div key={g.gate} style={{ display: 'flex', alignItems: 'stretch', gap: 8, flex: '1 1 160px' }}>
              <div style={{ flex: 1, border: `1px solid ${GATE_COLOR[g.status]}55`, background: `${GATE_COLOR[g.status]}12`, borderRadius: 10, padding: '10px 12px' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--muted)' }}>
                  <span>{GATE_META[g.gate]?.icon}</span>{g.label}{g.billable && <span title="billable while up" style={{ marginLeft: 'auto', color: '#fbbf24', fontSize: 10 }}>● billable</span>}
                </div>
                <div style={{ fontWeight: 700, color: GATE_COLOR[g.status], textTransform: 'uppercase', fontSize: 13, marginTop: 4 }}>{g.status}</div>
                <div style={{ fontSize: 12, color: 'var(--faint)', marginTop: 2, wordBreak: 'break-word' }}>{g.detail}</div>
              </div>
              {i < gates.length - 1 && <div style={{ display: 'grid', placeItems: 'center', color: 'var(--faint)' }}>→</div>}
            </div>
          ))}
        </div>

        {/* the real logs behind the gates */}
        <h3 style={{ margin: '10px 0 6px' }}>Real logs <span style={{ color: 'var(--faint)', fontWeight: 400, fontSize: 12 }}>· encoder + pipeline events</span></h3>
        <div style={{ maxHeight: 320, overflow: 'auto', border: '1px solid var(--border)', borderRadius: 10 }}>
          {(d.log || []).length === 0 && <div style={{ padding: 14, color: 'var(--faint)' }}>No log lines yet.</div>}
          {(d.log || []).map((l, i) => (
            <div key={i} style={{ display: 'flex', gap: 10, padding: '7px 12px', borderTop: i ? '1px solid var(--border)' : undefined, fontSize: 12.5 }}>
              <span className={`dot-s ${l.level}`} style={{ marginTop: 5 }} />
              <span style={{ color: 'var(--faint)', width: 62, flexShrink: 0 }}>{l.ts}</span>
              <span style={{ fontWeight: 600, width: 96, flexShrink: 0, color: l.level === 'down' ? '#fca5a5' : 'var(--muted)' }}>{l.title}</span>
              <span style={{ color: 'var(--muted)', wordBreak: 'break-word' }}>{l.detail}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

/* ------------------------------------------------------- share preview link */
/* A PRIVATE preview link for a client/reviewer to approve before go-live. This is a
   SEPARATE workflow from on air / public playback: it is secured only by an optional
   PIN + an expiry (and an optional view cap), ignores geo/access rules, and plays the
   packaged output whenever the source is active — it does NOT publish the channel. */
const SHARE_PERIODS: { label: string; sec: number }[] = [
  { label: '1 day', sec: 86400 }, { label: '3 days', sec: 3 * 86400 },
  { label: '7 days', sec: 7 * 86400 }, { label: '14 days', sec: 14 * 86400 },
  { label: '30 days', sec: 30 * 86400 },
]
function ShareDrawer({ d, onClose }: { d: CD; onClose: () => void }) {
  const [label, setLabel] = useState('')
  // DELIVERY: 'link' = create a URL you copy into your own email/WhatsApp;
  //           'email' = the SYSTEM emails the link + your message + instructions.
  const [delivery, setDelivery] = useState<'link' | 'email'>('link')
  const [recipients, setRecipients] = useState('')
  const [message, setMessage] = useState('')
  // EXPIRY: by TIME (dropdown) or by VIEW COUNT (expires after N opens; 30-day backstop)
  const [expiryMode, setExpiryMode] = useState<'time' | 'views'>('time')
  const [ttlSec, setTtlSec] = useState(7 * 86400)
  const [maxViews, setMaxViews] = useState('1')
  // SECURITY: none | pin (you set it, share it separately) | email_pin (viewer confirms
  // the recipient email; a one-time PIN is emailed to them)
  const [authMode, setAuthMode] = useState<'none' | 'pin' | 'email_pin'>('none')
  const [pin, setPin] = useState('')
  const [busy, setBusy] = useState(false)
  const [created, setCreated] = useState<{ url: string; expiresAt: string; emailed: number } | null>(null)
  const [copied, setCopied] = useState(false)
  const [err, setErr] = useState('')
  const [links, setLinks] = useState<ShareLinkRow[]>([])

  const recipientList = recipients.split(/[\s,;]+/).map(s => s.trim()).filter(s => /.+@.+\..+/.test(s))
  const needRecipients = delivery === 'email' || authMode === 'email_pin'

  async function loadLinks() {
    try { const all = await api.shareLinks(); setLinks(all.filter(l => l.resource_id === d.id)) } catch { /* ignore */ }
  }
  useEffect(() => { loadLinks() /* eslint-disable-next-line */ }, [d.id])

  async function create() {
    setErr('')
    if (needRecipients && recipientList.length === 0) { setErr('Add at least one recipient email address.'); return }
    if (authMode === 'pin' && pin.trim().length < 3) { setErr('Set a PIN of at least 3 characters, or choose a different security option.'); return }
    setBusy(true)
    try {
      const out = await api.createShareLink({
        resourceKind: 'channel', resourceId: d.id,
        ttlSec: expiryMode === 'time' ? ttlSec : 30 * 86400,   // view-capped links keep a 30-day backstop
        label: label || undefined, message: message || undefined,
        pin: authMode === 'pin' ? pin.trim() : undefined,
        maxViews: expiryMode === 'views' ? Math.max(1, Number(maxViews) || 1) : null,
        recipients: recipientList.length ? recipientList : undefined,
        authMode, sendEmail: delivery === 'email',
      })
      setCreated({ url: absUrl(out.url), expiresAt: out.expiresAt, emailed: out.emailed || 0 })
      await loadLinks()
    } catch (e: any) { setErr(e.message) } finally { setBusy(false) }
  }
  function absUrl(u: string) { return /^https?:\/\//i.test(u) ? u : `${location.origin}${u}` }
  async function copy() { if (!created) return; try { await navigator.clipboard.writeText(created.url); setCopied(true); setTimeout(() => setCopied(false), 1500) } catch { /* ignore */ } }
  async function revoke(id: string) { try { await api.revokeShareLink(id); await loadLinks() } catch (e: any) { setErr(e.message) } }

  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(2,6,14,.6)', zIndex: 60, display: 'grid', placeItems: 'center', padding: 20 }}>
      <div onClick={e => e.stopPropagation()} style={{ width: 'min(560px,96vw)', maxHeight: '92vh', overflow: 'auto', background: 'var(--panel,#0e1420)', border: '1px solid var(--border)', borderRadius: 14, padding: 20 }}>
        <div style={{ display: 'flex', alignItems: 'center', marginBottom: 4 }}>
          <h2 style={{ margin: 0 }}>Share a preview</h2>
          <div style={{ flex: 1 }} />
          <button className="btn ghost" onClick={onClose}>Close</button>
        </div>
        <p style={{ color: 'var(--muted)', marginTop: 4 }}>
          A private preview of <b>{d.name}</b> for a client or reviewer to approve before go-live.
          This does not put the channel on air and ignores geo/access rules.
        </p>

        {!created ? (
          <>
            <div style={{ display: 'grid', gap: 14, margin: '12px 0' }}>
              {/* 1 — delivery */}
              <div>
                <div style={{ fontSize: 12.5, color: 'var(--muted)', marginBottom: 6 }}>How do you want to share it?</div>
                <div style={{ display: 'flex', gap: 8 }}>
                  <button className={`btn ${delivery === 'link' ? 'primary' : 'ghost'}`} onClick={() => setDelivery('link')} style={{ flex: 1 }}
                    title="Create a URL you copy into your own email, WhatsApp or any app">Create a share URL</button>
                  <button className={`btn ${delivery === 'email' ? 'primary' : 'ghost'}`} onClick={() => setDelivery('email')} style={{ flex: 1 }}
                    title="The system emails the link, your message and viewing instructions to each recipient">Send by email</button>
                </div>
              </div>
              {(needRecipients) && (
                <label style={{ display: 'grid', gap: 5 }}>
                  <span style={{ fontSize: 12.5, color: 'var(--muted)' }}>
                    Recipient email{delivery === 'email' ? 's (the system sends the invitation to each)' : ' (needed for email verification)'} — separate with commas
                  </span>
                  <input value={recipients} onChange={e => setRecipients(e.target.value)} placeholder="client@example.com, reviewer@example.com" />
                </label>
              )}
              <label style={{ display: 'grid', gap: 5 }}>
                <span style={{ fontSize: 12.5, color: 'var(--muted)' }}>Message to recipient (optional{delivery === 'email' ? ', included in the email' : ''})</span>
                <textarea value={message} onChange={e => setMessage(e.target.value)} rows={2} placeholder="Please review and let me know if we're good to go live." style={{ resize: 'vertical' }} />
              </label>

              {/* 2 — expiry */}
              <div>
                <div style={{ fontSize: 12.5, color: 'var(--muted)', marginBottom: 6 }}>When does the link expire?</div>
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                  <button className={`btn ${expiryMode === 'time' ? 'primary' : 'ghost'}`} onClick={() => setExpiryMode('time')}>After a period</button>
                  <button className={`btn ${expiryMode === 'views' ? 'primary' : 'ghost'}`} onClick={() => setExpiryMode('views')}>After a number of views</button>
                  {expiryMode === 'time' ? (
                    <select value={ttlSec} onChange={e => setTtlSec(Number(e.target.value))} style={{ flex: '1 1 130px' }}>
                      {SHARE_PERIODS.map(p => <option key={p.sec} value={p.sec}>{p.label}</option>)}
                    </select>
                  ) : (
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                      <input value={maxViews} onChange={e => setMaxViews(e.target.value.replace(/[^0-9]/g, ''))} inputMode="numeric" style={{ width: 64 }} />
                      <span style={{ fontSize: 12.5, color: 'var(--muted)' }}>view{Number(maxViews) === 1 ? '' : 's'} (1 = single open; 30-day backstop)</span>
                    </span>
                  )}
                </div>
              </div>

              {/* 3 — security */}
              <div>
                <div style={{ fontSize: 12.5, color: 'var(--muted)', marginBottom: 6 }}>Who can open it?</div>
                <div style={{ display: 'grid', gap: 6 }}>
                  <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 13 }}>
                    <input type="radio" checked={authMode === 'none'} onChange={() => setAuthMode('none')} />
                    Anyone with the link
                  </label>
                  <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 13 }}>
                    <input type="radio" checked={authMode === 'pin'} onChange={() => setAuthMode('pin')} />
                    Anyone with the link and a PIN you set
                    {authMode === 'pin' && <input value={pin} onChange={e => setPin(e.target.value)} inputMode="numeric" placeholder="e.g. 4823" style={{ width: 90 }} />}
                  </label>
                  <label style={{ display: 'flex', gap: 8, alignItems: 'flex-start', fontSize: 13 }}>
                    <input type="radio" checked={authMode === 'email_pin'} onChange={() => setAuthMode('email_pin')} style={{ marginTop: 3 }} />
                    <span>Verified recipients only (most secure): the viewer confirms the email the link was sent to, receives a one-time code by email, and enters it to watch.</span>
                  </label>
                </div>
              </div>

              <label style={{ display: 'grid', gap: 5 }}>
                <span style={{ fontSize: 12.5, color: 'var(--muted)' }}>Internal label (optional, only you see it)</span>
                <input value={label} onChange={e => setLabel(e.target.value)} placeholder="e.g. Client approval — cooking show" />
              </label>
            </div>
            {err && <div className="err" style={{ marginBottom: 10 }}>{err}</div>}
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button className="btn ghost" onClick={onClose}>Cancel</button>
              <button className="btn primary" disabled={busy} onClick={create}>
                {busy ? (delivery === 'email' ? 'Sending…' : 'Creating…') : delivery === 'email' ? 'Create and send email' : 'Create share URL'}
              </button>
            </div>
          </>
        ) : (
          <div style={{ margin: '12px 0' }}>
            <div style={{ padding: '12px 14px', borderRadius: 10, background: 'rgba(74,222,128,.10)', border: '1px solid rgba(74,222,128,.4)', marginBottom: 12 }}>
              <div style={{ fontWeight: 700, color: '#4ade80', marginBottom: 6 }}>
                {created.emailed > 0 ? `Invitation emailed to ${created.emailed} recipient${created.emailed === 1 ? '' : 's'}` : 'Share URL created'}
              </div>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <code style={{ flex: 1, fontSize: 12.5, wordBreak: 'break-all', background: 'rgba(148,163,184,.12)', padding: '8px 10px', borderRadius: 8 }}>{created.url}</code>
                <button className="btn primary" onClick={copy} style={{ whiteSpace: 'nowrap' }}>{copied ? 'Copied' : 'Copy'}</button>
              </div>
              <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 8 }}>
                Expires {new Date(created.expiresAt).toLocaleString()}
                {expiryMode === 'views' ? ` or after ${Math.max(1, Number(maxViews) || 1)} view${Number(maxViews) === 1 ? '' : 's'}, whichever comes first` : ''}
                {authMode === 'pin' ? ' · PIN protected (share the PIN separately)' : authMode === 'email_pin' ? ' · verified recipients only' : ''}. The full link is shown once here.
              </div>
            </div>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button className="btn ghost" onClick={() => { setCreated(null); setPin(''); setLabel(''); setMessage(''); setMaxViews('1'); setRecipients('') }}>Create another</button>
              <button className="btn primary" onClick={onClose}>Done</button>
            </div>
          </div>
        )}

        {links.length > 0 && (
          <div style={{ marginTop: 8, borderTop: '1px solid var(--border)', paddingTop: 12 }}>
            <h3 style={{ margin: '0 0 8px', fontSize: 14 }}>Existing links for this channel</h3>
            {links.map(l => (
              <div key={l.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 0', borderTop: '1px solid var(--border)', fontSize: 12.5 }}>
                <span className={`dot-s ${l.revoked ? 'idle' : new Date(l.expires_at).getTime() < Date.now() ? 'warn' : 'live'}`} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{l.label || l.token_prefix + '…'}</div>
                  <div style={{ color: 'var(--faint)' }}>{l.revoked ? 'revoked' : `expires ${new Date(l.expires_at).toLocaleDateString()}`} · {l.view_count} view{l.view_count === 1 ? '' : 's'}</div>
                </div>
                {!l.revoked && <button className="btn ghost" style={{ padding: '4px 10px', color: '#fca5a5', borderColor: 'rgba(248,113,113,.5)' }} onClick={() => revoke(l.id)}>Revoke</button>}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
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

// Live preview of the channel watermark, positioned to match the encoder overlay so
// brand / corner / offset can be validated in the player before (and without) burn-in.
// Offsets are output pixels; we approximate against a nominal 1080-high frame for preview.
function DualPlayers({ d, captionLangs, sourceUp, onAir, onSendSource, onGoLive, busy }: {
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
              captionsOn={!!d.captions?.enabled} />}
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
            <div style={{ fontSize: 13, color: 'var(--muted)', wordBreak: 'break-word' }}>{g?.detail || 'the encoder is not delivering output'}</div>
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
function HlsVideo({ src, fallbackSrc, hostRef }: { src: string; fallbackSrc?: string; hostRef: { current: HTMLElement | null } }) {
  const ref = useRef<HTMLVideoElement | null>(null)
  const hlsRef = useRef<any>(null)
  const eng = useAudioEngine(ref)
  const controlsShown = useControlsVisible(hostRef)
  const [audioTracks, setAudioTracks] = useState<AudioTrackOpt[]>([])
  const [audioTrack, setAudioTrackState] = useState(0)
  // element starts muted for autoplay; the audio engine unmutes it once armed and
  // carries audibility on its gain node, so we never re-mute after arming.
  const softMute = (v: HTMLVideoElement) => { if (!v.dataset.audioArmed) v.muted = true }
  useEffect(() => {
    let cancelled = false; let hls: any; let usingFallback = false; let fails = 0
    const v = ref.current; if (!v || !src) return
    const resolve = (s: string) => /^https?:\/\//i.test(s) ? s : originUrl(s)
    // keep the preview pinned to the live edge; if it falls >20s behind, jump forward
    const snapLive = () => { try { const sk = v.seekable; if (sk.length) { const end = sk.end(sk.length - 1); if (end - v.currentTime > 20) v.currentTime = end - 0.5 } } catch {} }
    ;(async () => {
      const Hls = (await import('hls.js')).default
      if (cancelled) return
      const start = (s: string) => {
        const url = resolve(s)
        if (Hls.isSupported()) {
          try { hls?.destroy() } catch {}
          // liveSyncDurationCount:3 keeps us ~3 segments off the edge (normal live
          // latency); NOT lowLatency because the origin is a standard LIVE playlist.
          hls = new Hls({ lowLatencyMode: false, liveSyncDurationCount: 3, backBufferLength: 30, manifestLoadingMaxRetry: 8, manifestLoadingRetryDelay: 1000, levelLoadingMaxRetry: 8 })
          hlsRef.current = hls
          hls.loadSource(url); hls.attachMedia(v)
          hls.on(Hls.Events.MANIFEST_PARSED, () => { softMute(v); v.play().catch(() => {}); setTimeout(snapLive, 400) })
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
            if (!usingFallback && fallbackSrc && fails >= 2) { usingFallback = true; fails = 0; start(fallbackSrc); return }
            setTimeout(() => { try { hls.loadSource(url); hls.startLoad() } catch {} }, 1500) // not ready yet -> reload
          })
        } else if (v.canPlayType('application/vnd.apple.mpegurl')) { v.src = url; softMute(v); v.play().catch(() => {}); v.addEventListener('loadeddata', snapLive, { once: true }) }
      }
      start(src)
    })()
    return () => { cancelled = true; try { hls?.destroy() } catch {}; hlsRef.current = null }
  }, [src, fallbackSrc])
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
// source. The meter reads the REAL level whenever the browser lets it; when it
// cannot (context not yet resumed, or a browser that mutes the capture), it falls
// back to a motion driven by playback progress so the bars are ALWAYS alive while
// audio is flowing, muted or not. Audio is muted by default on this page.
type AudioTrackOpt = { id: number; label: string }
const AUDIO_BARS = 14      // analysis bands (level is computed across these)
const HIST_COLS = 72       // scrolling meter: 72 columns x 100ms = ~7s of history
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
  const ctxRef = useRef<AudioContext | null>(null)
  const anRef = useRef<AnalyserNode | null>(null)
  const dataRef = useRef<Uint8Array | null>(null)
  const edgesRef = useRef<number[] | null>(null)
  const dispRef = useRef<number[]>(new Array(AUDIO_BARS).fill(0))  // smoothed bar heights
  const rafRef = useRef<number | null>(null)
  const triedRef = useRef(false)   // captureStream attempted (and failed) — stop retrying
  const lastTimeRef = useRef(-1)
  const phaseRef = useRef(0)

  // AUDIBILITY is the native element only (reliable). We never route the element
  // through Web Audio, so unmuting simply un-mutes the element and it plays.
  useEffect(() => {
    const v = videoRef.current
    if (v) { v.dataset.audioArmed = '1'; v.muted = muted; v.volume = volume }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [muted, volume])

  useEffect(() => {
    let stopped = false
    const resume = () => { try { if (ctxRef.current && ctxRef.current.state === 'suspended') ctxRef.current.resume() } catch { /* ignore */ } }
    const onGesture = () => resume()
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
        ctx.createMediaStreamSource(cap).connect(analyser)  // analysis only — no destination
        ctxRef.current = ctx; anRef.current = analyser
        dataRef.current = new Uint8Array(analyser.frequencyBinCount)
        edgesRef.current = null
        resume()
      } catch { triedRef.current = true }  // tainted / unsupported — synthesized motion only
    }

    const loop = () => {
      if (stopped) return
      const v = videoRef.current
      if (v) {
        build()
        const playing = !v.paused && !v.ended && v.readyState >= 2 && v.currentTime !== lastTimeRef.current
        lastTimeRef.current = v.currentTime
        const an = anRef.current, data = dataRef.current
        const disp = dispRef.current
        let real = false
        if (an && data && ctxRef.current && ctxRef.current.state === 'running') {
          an.getByteFrequencyData(data)
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
          real = peak > 0.02
        }
        // overall level for the scrolling history: peak of the perceptual bands when the
        // analyser reads real audio; a gentle synthetic pulse while audio is flowing but
        // the capture cannot be read yet; decay to zero when nothing plays.
        let lvl = 0
        if (real) {
          for (let b = 0; b < AUDIO_BARS; b++) lvl = Math.max(lvl, disp[b])
        } else if (playing) {
          phaseRef.current += 0.09
          lvl = 0.25 + 0.28 * Math.abs(Math.sin(phaseRef.current)) * (0.6 + 0.4 * Math.sin(phaseRef.current * 0.37))
        } else {
          const h = histRef.current
          lvl = Math.max(0, (h[h.length - 1] || 0) * 0.7)
        }
        const nowMs = performance.now()
        if (nowMs - lastPushRef.current >= 100) {
          lastPushRef.current = nowMs
          const h = histRef.current
          h.shift(); h.push(Math.min(1, lvl))
          setHistory(h.slice())
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
  return { muted, volume, history, toggleMute, setVol }
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
  // audio counts as present when the RECENT history (last ~1.5s) carries real level
  const active = eng.history.slice(-15).some(b => b > 0.12)
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
            title="Audio track" aria-label="Audio track" style={{ fontSize: 11, padding: '2px 4px' }}>
            {tracks.map(t => <option key={t.id} value={t.id}>{t.label}</option>)}
          </select>
        )}
      </div>
      <div title="Audio level (last ~7 seconds, newest on the right)" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: 32, padding: '5px 8px', borderRadius: 9, background: 'rgba(0,0,0,.45)', backdropFilter: 'blur(2px)' }}>
        <ScrollMeter history={eng.history} active={active} />
      </div>
    </div>
  )
}

// Right-to-left scrolling level meter: each column is 100ms of overall level, newest on
// the RIGHT, sliding LEFT over ~7s. Drawn on a canvas (one paint per new sample), with
// columns mirrored around the vertical centre like a waveform so quiet reads thin and
// loud reads tall.
function ScrollMeter({ history, active }: { history: number[]; active: boolean }) {
  const ref = useRef<HTMLCanvasElement | null>(null)
  const W = HIST_COLS, H = 22
  useEffect(() => {
    const cv = ref.current
    if (!cv) return
    const dpr = window.devicePixelRatio || 1
    if (cv.width !== W * dpr) { cv.width = W * dpr; cv.height = H * dpr }
    const g = cv.getContext('2d')
    if (!g) return
    g.setTransform(dpr, 0, 0, dpr, 0, 0)
    g.clearRect(0, 0, W, H)
    // faint centre baseline so the strip reads as a waveform even in silence
    g.fillStyle = 'rgba(148,163,184,.22)'
    g.fillRect(0, H / 2 - 0.5, W, 1)
    for (let i = 0; i < history.length; i++) {
      const lvl = history[i]
      const h = Math.max(1.6, lvl * H)
      const y = (H - h) / 2
      // ONE colour: green. Loudness reads through bar HEIGHT and brightness, and the
      // history fades as it scrolls left. (No amber/red: a level meter going red read
      // as an error, which it is not.) Idle/no-audio renders neutral slate.
      const age = (history.length - 1 - i) / history.length
      const bright = 0.35 + lvl * 0.6          // louder = brighter, same hue
      const a = (active ? bright : 0.4) * (1 - age * 0.6)
      g.fillStyle = active ? `rgba(74,222,128,${a})` : `rgba(148,163,184,${a})`
      g.fillRect(i, y, 1, h)
    }
    // soft glow on the newest columns so the live edge of the meter reads as "now"
    if (active) {
      const lvl = history[history.length - 1] || 0
      const h = Math.max(1.6, lvl * H)
      g.save()
      g.shadowColor = 'rgba(74,222,128,.8)'
      g.shadowBlur = 4
      g.fillStyle = 'rgba(190,255,210,.95)'
      g.fillRect(W - 2, (H - h) / 2, 1.6, h)
      g.restore()
    }
  }, [history, active])
  return <canvas ref={ref} style={{ width: W, height: H, display: 'block' }} aria-label="Audio level history" />
}

function SourcePlayer({ d, sourceUp, onSendSource, busy }: { d: CD; sourceUp: boolean; onSendSource: () => void; busy: boolean }) {
  const videoBoxRef = useRef<HTMLDivElement | null>(null)
  const configured = d.sources.find(s => s.role === 'primary' && s.ingest_url) || d.sources.find(s => s.ingest_url)
  const proto = (configured?.protocol || d.sources[0]?.protocol || 'SRT').toUpperCase()
  const ts = d.testStream
  const srcHost = hostOf(ts.sourceUrl || configured?.ingest_url)
  const sendLabel = configured ? `Start channel (${proto})` : 'Start with test source'
  // Reflect the pipeline: the source can only be previewed via the encoder output,
  // so if the input gate failed, or the source is valid but the ENCODER failed, we
  // must NOT show a green RECEIVING. Show the real error instead.
  const h = d.health
  const inGate = h?.gates.find(g => g.gate === 'input')
  const inputFailed = inGate?.status === 'failed'
  const encFailed = !!h?.primaryError && (h.primaryError.gate === 'encoder' || h.primaryError.gate === 'output')
  const srcErrored = inputFailed || (sourceUp && encFailed)
  const badgeText = inputFailed ? 'SOURCE ERROR' : (sourceUp && encFailed) ? 'ENCODER FAILED' : sourceUp ? 'RECEIVING' : proto
  const badgeBg = srcErrored ? 'rgba(248,113,113,.85)' : sourceUp ? 'rgba(74,222,128,.85)' : 'rgba(99,102,241,.85)'
  const canPreview = sourceUp && !srcErrored
  // If the contribution feed is a browser-playable HLS URL, preview the REAL source
  // directly (so this pane is the true source, not our packaged output) and fall back
  // to the packaged origin if the CDN blocks cross-origin playback. For SRT/RTMP the
  // raw feed can't play in a browser, so we show the packaged origin as a proxy.
  const directHls = (configured?.protocol || '').toLowerCase() === 'hls' && configured?.ingest_url ? configured.ingest_url : undefined
  const srcVideoSrc = directHls ?? `/origin/${d.id}/live/master.m3u8`
  const srcFallback = directHls ? `/origin/${d.id}/live/master.m3u8` : undefined
  return (
    <div className="player">
      <div className="video" ref={videoBoxRef}>
        {canPreview ? <HlsVideo src={srcVideoSrc} fallbackSrc={srcFallback} hostRef={videoBoxRef} /> : <div className="grad" style={srcErrored ? { background: 'radial-gradient(120% 120% at 70% 20%,#2a1620 0%,#0b0f16 70%)' } : undefined} />}
        <div className="plabel"><span className="pt" style={{ color: srcErrored ? '#fca5a5' : '#a5b4fc' }}>SOURCE · {proto}</span></div>
        {/* No DOM watermark here: on transcode the logo is BURNED INTO the encoded
            picture by the encoder, so it is already in the video pixels. Painting a
            second overlay would double it up and hide whether the burn-in works. */}
        <div className="badge-live" style={{ background: badgeBg }}><span className="d" />{badgeText}</div>
        {srcErrored && (
          <div style={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center', textAlign: 'center', padding: 20 }}>
            <div style={{ maxWidth: 360 }}>
              <div style={{ fontWeight: 700, color: '#fca5a5', marginBottom: 6 }}>
                {inputFailed ? 'Source error' : 'Source is valid, but the encoder has failed'}
              </div>
              <div style={{ fontSize: 12.5, color: 'var(--muted)', wordBreak: 'break-word' }}>
                {inputFailed ? (inGate?.detail || 'no signal') : 'nothing can be previewed until the encoder recovers'}
              </div>
            </div>
          </div>
        )}
        {!sourceUp && (
          <div style={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center', textAlign: 'center' }}>
            <div>
              <button className="btn primary" onClick={onSendSource} disabled={busy} style={{ transform: 'scale(1.05)' }}>
                {busy ? 'Starting…' : `▶  ${sendLabel}`}
              </button>
              {configured?.ingest_url && <div style={{ marginTop: 10, fontSize: 11, color: 'var(--faint)', maxWidth: 340, wordBreak: 'break-all' }}>{configured.ingest_url}</div>}
            </div>
          </div>
        )}
        <div className="ptime">{srcErrored ? '— error —' : sourceUp ? `${srcHost || 'source'} · live` : '— no signal —'}</div>
      </div>
      <div className="pfoot">
        <span className={`dot-s ${srcErrored ? 'down' : sourceUp ? 'live' : 'idle'}`} /> {srcErrored ? (inputFailed ? 'Source not arriving' : 'Source OK · encoder failed downstream') : sourceUp ? `Ingesting ${srcHost || proto} · repackaging` : configured ? `Source configured · ${proto} · ${srcHost || 'ingest'}` : 'No source — send one to enable output'}
      </div>
      {sourceUp && ts.sourceNote && (
        <div style={{ padding: '9px 12px', borderTop: '1px solid var(--border)', fontSize: 12, color: 'var(--warn)', display: 'flex', gap: 8 }}>
          <span>⚠</span><span>{ts.sourceNote}</span>
        </div>
      )}
    </div>
  )
}

function IdleOutput({ sourceUp, onGoLive, warming, sinceMs, captionsOn }: {
  sourceUp: boolean; onGoLive: () => void; warming?: boolean; sinceMs?: number | null; captionsOn?: boolean
}) {
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
            <div style={{ color: 'var(--muted)', fontSize: 13, maxWidth: 340 }}>
              <div style={{ fontSize: 26, fontWeight: 700, color: 'var(--text)', fontVariantNumeric: 'tabular-nums', marginBottom: 6 }}>{warmSec}s</div>
              <div style={{ fontWeight: 600, marginBottom: 4 }}>Preparing the output</div>
              First playable output takes a moment: {expect}. This is normal start-up, not a fault.
            </div>
          ) : sourceUp ? (
            <div>
              <button className="btn primary" onClick={onGoLive} style={{ transform: 'scale(1.05)' }}>
                <span className="dot-s live" style={{ marginRight: 6 }} />Go live
              </button>
              <div style={{ marginTop: 12, fontSize: 12, color: 'var(--muted)' }}>Source is receiving. Take the output live.</div>
            </div>
          ) : (
            <div style={{ color: 'var(--faint)', fontSize: 13, maxWidth: 300 }}>
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
  const langOpts = useCaptionLanguages()   // labels for the CC language selector
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const videoBoxRef = useRef<HTMLDivElement | null>(null)
  const hlsRef = useRef<any>(null)
  const dashRef = useRef<any>(null)
  const eng = useAudioEngine(videoRef)
  const controlsShown = useControlsVisible(videoBoxRef)
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
  // INPUT->OUTPUT LATENCY estimate. Exact when the manifest carries PDT (the caption
  // companion stamps every segment with its real encoder write time): latency =
  // now - playingDate = encoder write to glass. Without PDT we fall back to a rough
  // buffer-based estimate and mark it approximate.
  const [latency, setLatency] = useState<{ sec: number; exact: boolean } | null>(null)
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
      const snap = () => { try { const sk = video.seekable; if (sk.length && !didSnapRef.current) { const end = sk.end(sk.length - 1), start = sk.start(0); const hold = Math.min(capHold || 0.5, Math.max(0.5, (end - start) - 3)); video.currentTime = end - hold; didSnapRef.current = true } } catch {} }
      setTimeout(snap, 300); setTimeout(snap, 1200)
    }
    // Captions on: load the captions-aware companion manifest (subtitles + PDT in the
    // manifest). It appears a few seconds after start, so retry it rather than dropping
    // to the plain master permanently; only fall back after several misses.
    const cc = !!d.captions?.enabled
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
        hls.on(Hls.Events.SUBTITLE_TRACKS_UPDATED, () => setSubTracks((hls.subtitleTracks || []).length))
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
          const at = player.getTracksFor('audio') || []
          setAudioTracks(at.map((t: any, i: number) => ({ id: i, label: (t.labels && t.labels[0]?.text) || t.lang || `Audio ${i + 1}` })))
        } catch { /* ignore */ }
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
          const target = Math.min(capHold || 0.5, Math.max(0.5, depth - 3))
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
  }, [subOn, subLang, ts.subtitles, d.captions?.enabled])

  function seekBehind(sec: number) {
    const v = videoRef.current; if (!v || !v.seekable.length) return
    scrubbedRef.current = true; setScrubbed(true)   // deliberate DVR scrub: release the live lock
    const end = v.seekable.end(v.seekable.length - 1)
    v.currentTime = Math.max(v.seekable.start(0), end - Math.max(0, sec))
  }
  function goLive() { const v = videoRef.current; scrubbedRef.current = false; setScrubbed(false); if (!v || !v.seekable.length) return; const sk = v.seekable, end = sk.end(sk.length - 1), start = sk.start(0); const hold = Math.min(capHold || 0.5, Math.max(0.5, (end - start) - 3)); v.currentTime = end - hold }

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

  return (
    <div className="player">
      <div className="video" ref={videoBoxRef}>
        <video ref={videoRef} playsInline muted style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover', background: '#000' }} />
        <div className="plabel"><span className="pt" style={{ color: liveNow ? '#4ade80' : '#fbbf24' }}>OUTPUT · {fmt.toUpperCase()}{liveNow ? '' : ' · DVR'}</span></div>
        {/* On-air state: green ON AIR when published to the public, blue PREVIEW when the
            packaged output is playing but held private (verify DASH/HLS before going on air).
            Centered at the top so it never sits behind the OUTPUT label or the LIVE badge. */}
        <div style={{
          position: 'absolute', top: 10, left: '50%', transform: 'translateX(-50%)',
          display: 'inline-flex', alignItems: 'center', gap: 6, whiteSpace: 'nowrap',
          fontSize: 11, fontWeight: 700, letterSpacing: .4, padding: '4px 10px', borderRadius: 999,
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
            fontSize: 15, fontWeight: 600, maxWidth: '88%', textAlign: 'center', lineHeight: 1.35, whiteSpace: 'pre-line',
          }}>{cue}</div>
        )}
        <div className="ptime">{liveNow ? 'live edge' : `${fmtOffset(behind)} behind live`}</div>
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
        <div style={{ display: 'flex', gap: 6, justifyContent: 'space-between', fontSize: 11, color: 'var(--faint)' }}>
          <span>{d.dvr_mode === 'event_start' ? 'Event start' : `${fmtWindow(winSec)} DVR available`}</span>
          <span style={{ display: 'flex', gap: 6 }}>
            <button className="chip" style={{ padding: '3px 8px', fontSize: 11 }} onClick={() => seekBehind(behind + 15)}>« 15s</button>
            <button className="chip" style={{ padding: '3px 8px', fontSize: 11 }} onClick={() => seekBehind(behind + 60)}>« 1m</button>
          </span>
          <span style={{ color: liveNow ? 'var(--live)' : 'var(--faint)' }}>Live ▸</span>
        </div>
      </div>

      <div className="pfoot">
        <span className="dot-s live" /> Playing {fmt.toUpperCase()}
        {latency && (
          <span title={latency.exact
            ? 'Estimated latency from the encoder writing a segment to it playing here, measured from the manifest wall-clock stamps. Add a few seconds of ingest/encode ahead of that for full input to output.'
            : 'Approximate latency (no wall-clock stamps in this manifest): distance behind the newest buffered content plus packaging time.'}
            style={{ fontSize: 11, color: 'var(--faint)', marginLeft: 10 }}>
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
          {capStatus && capStatus.kind === 'error' && (
            <span title={capStatus.hint || 'captions engine error — see the QC log'} style={{ fontSize: 11, color: '#fca5a5', maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              captions failed: {capStatus.reason}
            </span>
          )}
          {capStatus && capStatus.kind === 'live' && (
            <span title="Estimated live offset: chunk length + measured transcribe/translate time. Captions lag live by about this much; if not real-time the model can't keep up." style={{ fontSize: 11, color: capStatus.realtime ? 'var(--faint)' : '#fbbf24' }}>
              captions ~{capStatus.sec}s{capStatus.realtime ? '' : ' (behind)'}
            </span>
          )}
          {capStatus && capStatus.kind === 'starting' && (
            <span style={{ fontSize: 11, color: 'var(--faint)' }}>captions starting…</span>
          )}
          <button className={`chip ${subOn ? 'active' : ''}`} style={{ padding: '5px 10px' }} onClick={() => setSubOn(!subOn)}>CC</button>
          {subOn && (
            <select value={subLang} onChange={e => setSubLang(e.target.value)}>
              {captionLangs.map(c => <option key={c} value={c}>{langOpts.find(l => l.code === c)?.label || c.toUpperCase()}</option>)}
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
  }, [d.id, d.input_failover_enabled, d.auto_failback, d.input_loss_behavior, d.filler_slate_ref])
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
        <b style={{ fontSize: 14 }}>Failover control</b>
        <span className={`tag ${real ? 'live' : 'idle'}`} style={{ fontSize: 10.5 }}>
          <span className={`dot-s ${real ? 'live' : 'idle'}`} />{real ? 'ENABLED' : 'NOT ENABLED'}
        </span>
        {real && mode !== 'auto' && <span className="tag warn" style={{ fontSize: 10.5 }}>ACTIVE: {active?.label || mode}</span>}
      </div>
      {real ? (
        <>
          <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 8 }}>
            On total input loss the filler is <b style={{ color: 'var(--text)' }}>{loopDesc}</b>. Set this in Settings, under Filler on total loss.
          </div>
          <div style={{ fontSize: 12.5, color: 'var(--muted)', marginBottom: 12 }}>
            A pre-flight test and a live manual switch: force a path and the real output switches within a second or two, then Resume. You can also use it on purpose, to move off a primary or bring it back.
          </div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {FAILOVER_STEPS.map(s => (
              <button key={s.m} className={`btn ${mode === s.m ? 'primary' : 'ghost'}`} disabled={busy || !running}
                title={running ? s.note : 'Start the channel first: failover acts on the running encoder'}
                onClick={() => apply(s.m)} style={{ padding: '7px 12px' }}>
                <span className="dot-s" style={{ background: s.hue, marginRight: 6 }} />{s.label}
              </button>
            ))}
            <button className={`btn ${mode === 'auto' ? 'primary' : 'ghost'}`} disabled={busy || !running}
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
          {err && <div className="err" style={{ marginTop: 10 }}>{err}</div>}
        </>
      ) : (
        <div style={{ fontSize: 12.5, color: 'var(--muted)' }}>
          Input failover is off for this channel, so there is nothing to switch yet. Turn on <b style={{ color: 'var(--text)' }}>Enable input failover</b> in Settings and add a backup source, then start the channel. This panel will then let you test each failover path and switch sources on purpose, with the result shown in the output player above.
        </div>
      )}
    </div>
  )
}

/* --------------------------------------------------------------------- EPG */
function EpgStrip({ d, onAddEpg, onHideEpg }: { d: CD; onAddEpg: () => void; onHideEpg: () => void }) {
  // Hidden entirely when the channel has the guide turned off (Settings).
  if (d.epgEnabled === false) return null

  const now = d.epg.now
  const hasEpg = (d.epg.lane?.length ?? 0) > 0

  // No programmes: don't show a dead "ON NOW —" strip. Offer a call to action to
  // add a guide, or to hide the panel for this channel.
  if (!hasEpg) {
    return (
      <div className="card" style={{ marginBottom: 18, display: 'flex', alignItems: 'center', gap: 14, padding: '14px 16px' }}>
        <span className="tag idle"><span className="dot-s idle" />NO EPG</span>
        <div style={{ flex: 1 }}>
          <div style={{ fontWeight: 600 }}>No programme guide for this channel</div>
          <div style={{ fontSize: 12.5, color: 'var(--muted)' }}>Add programmes to show now/next and a schedule, or hide this panel.</div>
        </div>
        <button className="btn primary" onClick={onAddEpg}>Add EPG</button>
        <button className="btn ghost" onClick={onHideEpg}>Hide</button>
      </div>
    )
  }

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

/* -------------------------------------------------------- retention units */
type RetUnit = 'minutes' | 'hours' | 'days' | 'weeks' | 'months'
const RET_UNIT_SEC: Record<RetUnit, number> = { minutes: 60, hours: 3600, days: 86400, weeks: 604800, months: 2592000 }
/** Seconds -> {number, unit} picking the largest whole unit (minutes and up). */
function splitDuration(sec: number | null): { n: string; unit: RetUnit } {
  if (sec == null || sec <= 0) return { n: '', unit: 'days' }
  const order: RetUnit[] = ['months', 'weeks', 'days', 'hours', 'minutes']
  for (const u of order) { const s = RET_UNIT_SEC[u]; if (sec % s === 0 && sec >= s) return { n: String(sec / s), unit: u } }
  return { n: String(Math.max(1, Math.round(sec / 60))), unit: 'minutes' }
}

/* ------------------------------------------------------------ settings drawer */
function SettingsDrawer({ d, onClose, onSaved }: { d: CD; onClose: () => void; onSaved: () => void }) {
  const [name, setName] = useState(d.name)
  // retention as number + unit dropdown (minutes..months). Seed from seconds if set,
  // else from the legacy days field. Blank number = keep forever.
  const initRetSec = (d as any).recording_retention_sec != null
    ? Number((d as any).recording_retention_sec)
    : (d.recording_retention_days != null ? d.recording_retention_days * 86400 : null)
  const initRet = splitDuration(initRetSec)
  const [retNum, setRetNum] = useState<string>(initRet.n)
  const [retUnit, setRetUnit] = useState<RetUnit>(initRet.unit)
  // DVR
  const [dvrMode, setDvrMode] = useState<'sliding' | 'event_start'>(d.dvr_mode)
  const [dvrMin, setDvrMin] = useState<string>(String(Math.round((d.dvr_window_sec ?? d.dvr.effective_sec) / 60)))
  // source (protocol-aware, per input)
  const protocols = useProtocols()
  const src0 = d.sources.find(s => s.role === 'primary') || d.sources[0]
  const src1 = d.sources.find(s => s.role === 'backup')
  const [primary, setPrimary] = useState<SourceValue>({ protocol: (src0?.protocol || 'srt').toLowerCase(), url: src0?.ingest_url || '' })
  const [backup, setBackup] = useState<SourceValue>({ protocol: (src1?.protocol || src0?.protocol || 'srt').toLowerCase(), url: src1?.ingest_url || '' })
  // geo
  const [geoMode, setGeoMode] = useState(d.geo_mode)
  const [geoCountries, setGeoCountries] = useState(d.geo_countries.join(', '))
  // output ABR ladder (transcode rungs) — add / remove / edit bitrates
  const [rungs, setRungs] = useState<{ height: number; bitrateKbps: number }[]>(
    (d.ladder || []).map(r => ({ height: r.height, bitrateKbps: r.bitrate_kbps })))
  // programme guide (EPG) panel visibility
  const [epgOn, setEpgOn] = useState(d.epgEnabled !== false)
  // subtitles
  const [capOn, setCapOn] = useState(d.captions.enabled)
  const [capLangs, setCapLangs] = useState<string[]>(d.captions.targets.length ? d.captions.targets : ['en'])
  const [capTrim, setCapTrim] = useState(String(d.captions.offset_sec ?? 0))
  const langOpts = useCaptionLanguages()
  // filler on loss
  const [lossBehavior, setLossBehavior] = useState<'none' | 'slate' | 'vod_loop' | 'last_frame' | 'black'>(d.input_loss_behavior || 'none')
  const [slateRef, setSlateRef] = useState(d.filler_slate_ref || '')
  const [failover, setFailover] = useState(!!d.input_failover_enabled)
  const [autoFailback, setAutoFailback] = useState(d.auto_failback !== false)
  const [pickerOpen, setPickerOpen] = useState(false)
  const [loopPickerOpen, setLoopPickerOpen] = useState(false)
  // watermark / channel brand overlay
  const [wmEnabled, setWmEnabled] = useState(d.watermark?.enabled ?? false)
  const [wmRef, setWmRef] = useState(d.watermark?.ref || '')
  const [wmPos, setWmPos] = useState<WatermarkCfg['position']>(d.watermark?.position || 'br')
  const [wmX, setWmX] = useState(String(d.watermark?.offsetX ?? 24))
  const [wmY, setWmY] = useState(String(d.watermark?.offsetY ?? 24))
  const [wmOpacity, setWmOpacity] = useState(d.watermark?.opacity ?? 100)
  const [wmScale, setWmScale] = useState(d.watermark?.scale ?? 12)
  const [wmPickerOpen, setWmPickerOpen] = useState(false)
  // channel brand image (identity logo, replaces the initials box)
  const [brandRef, setBrandRef] = useState((d as any).brand_ref || '')
  const [brandPickerOpen, setBrandPickerOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')

  const DVR_MAX_MIN = 240 // 4h
  const dvrMinNum = Math.max(0, Math.min(DVR_MAX_MIN, Number(dvrMin) || 0))

  async function save() {
    setErr('')
    const patch: ChannelSettingsPatch = { version: d.version }
    if (name.trim() && name.trim() !== d.name) patch.name = name.trim()
    patch.dvrMode = dvrMode
    if (dvrMode === 'sliding') patch.dvrWindowSec = Math.max(30, dvrMinNum * 60)
    // retention: number × unit -> seconds; never below the DVR window while DVR is on
    let retSec = retNum ? Number(retNum) * RET_UNIT_SEC[retUnit] : null
    if (retSec != null && dvrMode === 'sliding') retSec = Math.max(retSec, dvrMinNum * 60)
    if (retSec !== initRetSec) patch.recordingRetentionSec = retSec
    patch.geoMode = geoMode
    if (geoMode !== 'worldwide') patch.geoCountries = geoCountries.split(',').map(s => s.trim().toUpperCase()).filter(s => s.length === 2)
    else patch.geoCountries = []
    // sources
    const sources: ChannelSettingsPatch['sources'] = []
    if (primary.url.trim()) sources.push({ role: 'primary', protocol: primary.protocol, ingestUrl: primary.url.trim(), streamKey: primary.streamKey?.trim() || undefined })
    if (backup.url.trim()) sources.push({ role: 'backup', protocol: backup.protocol, ingestUrl: backup.url.trim(), streamKey: backup.streamKey?.trim() || undefined })
    if (sources.length) patch.sources = sources
    // output ladder (transcode): only send when changed
    const origLadder = JSON.stringify((d.ladder || []).map(r => ({ height: r.height, bitrateKbps: r.bitrate_kbps })))
    const cleanRungs = rungs.filter(r => r.height > 0 && r.bitrateKbps > 0).sort((a, b) => b.height - a.height)
    if (JSON.stringify(cleanRungs) !== origLadder) patch.outputLadder = cleanRungs
    // programme guide panel
    if (epgOn !== (d.epgEnabled !== false)) patch.epgEnabled = epgOn
    // captions
    patch.captions = { enabled: capOn, targets: capOn ? capLangs : [],
      offsetSec: Math.max(-30, Math.min(30, Number(capTrim) || 0)) }
    // filler on loss
    patch.inputFailoverEnabled = failover
    patch.autoFailback = autoFailback
    patch.inputLossBehavior = lossBehavior
    patch.fillerSlateRef = (lossBehavior === 'slate' || lossBehavior === 'vod_loop') && slateRef.trim() ? slateRef.trim() : null
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

    setBusy(true)
    try { await api.updateChannel(d.id, patch); onSaved() }
    catch (e: any) {
      if (String(e.message).includes('409') || /version|match/i.test(e.message)) setErr('This channel changed since you opened it. Reopen settings and retry.')
      else setErr(e.message)
    } finally { setBusy(false) }
  }

  return (
    <div className="drawer-scrim" onClick={onClose}>
      <div className="drawer" onClick={e => e.stopPropagation()}>
        <div className="drawer-h"><div className="t">Channel settings</div><button className="xbtn" onClick={onClose}>✕</button></div>
        <div className="drawer-b">
          <div className="field"><label>Channel name</label><input className="inp" value={name} onChange={e => setName(e.target.value)} /></div>

          <div className="field"><label>Channel brand image <span style={{ color: 'var(--faint)' }}>— shown in place of the initials box</span></label>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <span style={{ width: 44, height: 44, borderRadius: 10, background: '#0b0f16', border: '1px solid var(--border)', display: 'grid', placeItems: 'center', overflow: 'hidden', flex: 'none' }}>
                {brandRef
                  ? <img src={thumbUrl(brandRef, 88, 88, 'inside')} alt="" style={{ width: '100%', height: '100%', objectFit: 'contain' }} />
                  : <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="var(--faint)" strokeWidth="2"><rect x="2" y="7" width="20" height="13" rx="2" /><path d="m17 2-5 5-5-5" /></svg>}
              </span>
              <input className="inp" value={brandRef} onChange={e => setBrandRef(e.target.value)} placeholder="Pick a channel logo, upload, or paste a URL" />
              <button type="button" className="btn ghost" onClick={() => setBrandPickerOpen(true)}>Browse / upload…</button>
              {brandRef && <button type="button" className="btn ghost" onClick={() => setBrandRef('')}>Clear</button>}
            </div>
          </div>
          <ImagePicker open={brandPickerOpen} kinds={['brand', 'poster', 'slate', 'other']} title="Choose or upload a channel brand image"
            uploadKind="brand" uploadFolder="brands"
            onClose={() => setBrandPickerOpen(false)} onPick={(url) => { setBrandRef(url); setBrandPickerOpen(false) }} />

          <div style={SEC}>Source</div>
          <SourceInput protocols={protocols} value={primary} onChange={setPrimary} label="Primary source" />
          <SourceInput protocols={protocols} value={backup} onChange={setBackup} label="Backup source (optional)" />

          <div style={SEC}>Failover</div>
          <div className="toggle-row">
            <div><div className="tt">Enable input failover</div><div className="td">If the primary source fails, switch to the backup, then to the filler, to keep the output live. Works on transcode and packaged channels.</div></div>
            <div className={`sw ${failover ? '' : 'off'}`} onClick={() => setFailover(v => !v)}><i /></div>
          </div>
          {failover && (
            <div className="toggle-row">
              <div><div className="tt">Auto failback to primary</div><div className="td">Return to the primary automatically once it has been healthy for a short hold. Off keeps the output on the backup until you intervene.</div></div>
              <div className={`sw ${autoFailback ? '' : 'off'}`} onClick={() => setAutoFailback(v => !v)}><i /></div>
            </div>
          )}

          <div style={SEC}>Filler on total loss</div>
          <div className="field"><label>When no source is available</label>
            <select className="inp" value={lossBehavior} onChange={e => setLossBehavior(e.target.value as any)}>
              <option value="none">None (output stops)</option>
              <option value="slate">Slate image</option>
              <option value="vod_loop">Loop video</option>
              <option value="last_frame">Freeze last frame</option>
              <option value="black">Black</option>
            </select>
          </div>
          {lossBehavior === 'slate' && (
            <div className="field"><label>Slate image</label>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                {slateRef && <img src={thumbUrl(slateRef, 92, 68)} alt="" style={{ width: 46, height: 34, objectFit: 'cover', borderRadius: 6, background: '#000', flex: 'none' }} />}
                <input className="inp" value={slateRef} onChange={e => setSlateRef(e.target.value)} placeholder="Pick from library, upload, or paste a URL" />
                <button type="button" className="btn ghost" onClick={() => setPickerOpen(true)}>Browse / upload…</button>
              </div>
            </div>
          )}
          {lossBehavior === 'vod_loop' && (
            <div className="field"><label>Loop video</label>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <input className="inp" value={slateRef} onChange={e => setSlateRef(e.target.value)} placeholder="Pick an existing loop asset or paste a URL" />
                <button type="button" className="btn ghost" onClick={() => setLoopPickerOpen(true)}>Browse…</button>
              </div>
              <div className="td" style={{ marginTop: 6 }}>No loop video? Leave this empty and set a Slate image: the loop is then made from the slate with a gentle scale in/out so it is not a still frame.</div>
            </div>
          )}
          <ImagePicker open={pickerOpen} kinds={['slate', 'brand', 'other']} title="Choose or upload a slate image"
            uploadKind="slate" uploadFolder="slates"
            onClose={() => setPickerOpen(false)} onPick={(url) => { setSlateRef(url); setPickerOpen(false) }} />
          <ImagePicker open={loopPickerOpen} kinds={['loop', 'clip', 'vod', 'other']} title="Choose a loop video"
            allowUpload={false} uploadHint="Uploading video loops arrives with Broadcast videos; pick an existing asset for now"
            onClose={() => setLoopPickerOpen(false)} onPick={(url) => { setSlateRef(url); setLoopPickerOpen(false) }} />

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

          {d.profile?.workflow_type === 'transcode' && (
            <>
              <div style={SEC}>Output bitrates (ABR ladder)</div>
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

          <div style={SEC}>Programme guide (EPG)</div>
          <div className="toggle-row">
            <div><div className="tt">Show programme guide panel</div><div className="td">Off hides the EPG / now-next panel for this channel.</div></div>
            <div className={`sw ${epgOn ? '' : 'off'}`} onClick={() => setEpgOn(v => !v)}><i /></div>
          </div>

          <div style={SEC}>Subtitles</div>
          <div className="toggle-row">
            <div><div className="tt">Live captions / subtitles</div><div className="td">Applies to this channel’s output profile.</div></div>
            <div className={`sw ${capOn ? '' : 'off'}`} onClick={() => setCapOn(v => !v)}><i /></div>
          </div>
          {capOn && (
            <>
              <div className="field"><label>Output languages <span style={{ color: 'var(--faint)' }}>— the spoken language is detected automatically and translated into each of these</span></label>
                <LangPicker value={capLangs} onChange={setCapLangs} options={langOpts} />
              </div>
              <div className="field"><label>Caption timing trim <span style={{ color: 'var(--faint)' }}>— seconds; positive shows words LATER, negative earlier. Watch the output and adjust in 0.5s steps until speech and captions line up. Applies from the next restart.</span></label>
                <input className="inp" style={{ width: 110 }} inputMode="decimal" value={capTrim}
                  onChange={e => setCapTrim(e.target.value.replace(/[^0-9.-]/g, ''))} placeholder="0" />
              </div>
            </>
          )}

          <div style={SEC}>Recording</div>
          <div className="field">
            <label>Retention <span style={{ color: 'var(--faint)' }}>— blank number = keep forever</span></label>
            <div style={{ display: 'flex', gap: 8 }}>
              <input className="inp" style={{ width: 110 }} inputMode="numeric" placeholder="keep forever"
                value={retNum} onChange={e => setRetNum(e.target.value.replace(/[^0-9]/g, ''))} />
              <select className="inp" value={retUnit} onChange={e => setRetUnit(e.target.value as RetUnit)}>
                <option value="minutes">minutes</option>
                <option value="hours">hours</option>
                <option value="days">days</option>
                <option value="weeks">weeks</option>
                <option value="months">months</option>
              </select>
            </div>
            {dvrMode === 'sliding' && retNum && Number(retNum) * RET_UNIT_SEC[retUnit] < dvrMinNum * 60 && (
              <div className="td" style={{ color: 'var(--warn)', marginTop: 6 }}>Will be raised to the DVR window ({fmtWindow(dvrMinNum * 60)}) — retention can’t be shorter than DVR.</div>
            )}
          </div>

          {d.profile?.workflow_type === 'transcode' && (<>
          <div style={SEC}>Watermark <span style={{ color: 'var(--faint)', fontWeight: 400 }}>: burned into the transcode output</span></div>
          <div className="toggle-row">
            <div><div className="tt">Overlay a brand watermark</div><div className="td">Burned into the output for this transcode channel.</div></div>
            <div className={`sw ${wmEnabled ? '' : 'off'}`} onClick={() => setWmEnabled(v => !v)}><i /></div>
          </div>
          {wmEnabled && (
            <>
              <div className="field"><label>Watermark image</label>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                  {wmRef && <img src={thumbUrl(wmRef, 92, 68)} alt="" style={{ width: 46, height: 34, objectFit: 'contain', borderRadius: 6, background: '#0b0f16', flex: 'none' }} />}
                  <input className="inp" value={wmRef} onChange={e => setWmRef(e.target.value)} placeholder="Pick a brand/logo, upload, or paste a URL" />
                  <button type="button" className="btn ghost" onClick={() => setWmPickerOpen(true)}>Browse / upload…</button>
                </div>
              </div>
              <div className="field"><label>Position</label>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 6, maxWidth: 260 }}>
                  {([['tl','Top L'],['tc','Top C'],['tr','Top R'],['bl','Bot L'],['bc','Bot C'],['br','Bot R']] as const).map(([p, lbl]) => (
                    <button key={p} type="button" className={`btn ${wmPos === p ? 'primary' : 'ghost'}`} style={{ padding: '6px 4px', fontSize: 12 }} onClick={() => setWmPos(p)}>{lbl}</button>
                  ))}
                </div>
              </div>
              <div className="field"><label>Offsets (px from the edge)</label>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                  <span style={{ color: 'var(--faint)', fontSize: 12 }}>X</span>
                  <input className="inp" style={{ width: 90 }} inputMode="numeric" value={wmX} onChange={e => setWmX(e.target.value.replace(/[^0-9]/g, ''))} />
                  <span style={{ color: 'var(--faint)', fontSize: 12 }}>Y</span>
                  <input className="inp" style={{ width: 90 }} inputMode="numeric" value={wmY} onChange={e => setWmY(e.target.value.replace(/[^0-9]/g, ''))} />
                </div>
              </div>
              <div className="field"><label>Size — {wmScale}% of frame height</label>
                <input type="range" min={2} max={40} step={1} value={wmScale} onChange={e => setWmScale(Number(e.target.value))} style={{ width: '100%', accentColor: 'var(--brand)' }} />
              </div>
              <div className="field"><label>Opacity — {wmOpacity}%</label>
                <input type="range" min={10} max={100} step={5} value={wmOpacity} onChange={e => setWmOpacity(Number(e.target.value))} style={{ width: '100%', accentColor: 'var(--brand)' }} />
              </div>
            </>
          )}
          <ImagePicker open={wmPickerOpen} kinds={['brand', 'slate', 'other']} title="Choose or upload a brand watermark"
            uploadKind="brand" uploadFolder="brands"
            onClose={() => setWmPickerOpen(false)} onPick={(url) => { setWmRef(url); setWmPickerOpen(false) }} />
          </>)}

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
