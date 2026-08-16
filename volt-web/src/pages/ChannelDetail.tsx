import { useEffect, useMemo, useRef, useState } from 'react'
import { api, originUrl, thumbUrl, type ChannelDetail as CD, type ChannelSettingsPatch, type ShareLinkRow } from '../api'
import { navigate } from '../router'
import { subscribeLive } from '../liveStatus'
import { useProtocols, SourceInput, type SourceValue } from '../protocols'
import { ImagePicker } from '../ImagePicker'

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
  // ON AIR (green) ONLY when published AND the public stream is truly live (valid content).
  // Output ready but not published = READY (blue). Not live = IDLE. An error always wins.
  const trulyOnAir = published && d.onAir
  const stateLabel = errored ? `${perr!.label.toUpperCase()} ERROR`
    : trulyOnAir ? 'ON AIR'
    : outputReady ? 'READY'
    : sourceUp ? 'STARTING'
    : 'IDLE'
  const stateCls = errored ? 'down'
    : trulyOnAir ? 'live'
    : outputReady ? 'sched'   // READY = blue
    : sourceUp ? 'sched' : 'idle'
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
            <span className="dthumb" style={{ background: 'linear-gradient(135deg,#1d4ed8,#3b82f6)' }}>{d.name.split(/\s+/).slice(0, 2).map(w => w[0]).join('').toUpperCase()}</span>
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
          <button className="btn primary" disabled={busy} onClick={() => setConfirmStart(true)}>
            {busy ? 'Sending source…' : 'Send source'}
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
      <button className="btn ghost" onClick={onQc} style={{ alignSelf: 'center' }}>Diagnose</button>
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
  const [ttlSec, setTtlSec] = useState(7 * 86400)
  const [pin, setPin] = useState('')
  const [message, setMessage] = useState('')
  const [maxViews, setMaxViews] = useState('')
  const [busy, setBusy] = useState(false)
  const [created, setCreated] = useState<{ url: string; expiresAt: string } | null>(null)
  const [copied, setCopied] = useState(false)
  const [err, setErr] = useState('')
  const [links, setLinks] = useState<ShareLinkRow[]>([])

  async function loadLinks() {
    try { const all = await api.shareLinks(); setLinks(all.filter(l => l.resource_id === d.id)) } catch { /* ignore */ }
  }
  useEffect(() => { loadLinks() /* eslint-disable-next-line */ }, [d.id])

  async function create() {
    setBusy(true); setErr('')
    try {
      const out = await api.createShareLink({
        resourceKind: 'channel', resourceId: d.id, ttlSec,
        label: label || undefined, message: message || undefined,
        pin: pin.trim() ? pin.trim() : undefined,
        maxViews: maxViews.trim() ? Number(maxViews) : null,
      })
      setCreated({ url: absUrl(out.url), expiresAt: out.expiresAt })
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
          A private link to preview <b>{d.name}</b> for a client or reviewer to approve before go-live.
          Secured by an expiry and an optional PIN. This does not put the channel on air and ignores geo/access rules.
        </p>

        {!created ? (
          <>
            <div style={{ display: 'grid', gap: 12, margin: '12px 0' }}>
              <label style={{ display: 'grid', gap: 5 }}>
                <span style={{ fontSize: 12.5, color: 'var(--muted)' }}>Label (optional)</span>
                <input value={label} onChange={e => setLabel(e.target.value)} placeholder="e.g. Client approval — cooking show" />
              </label>
              <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
                <label style={{ display: 'grid', gap: 5, flex: '1 1 160px' }}>
                  <span style={{ fontSize: 12.5, color: 'var(--muted)' }}>Link expires after</span>
                  <select value={ttlSec} onChange={e => setTtlSec(Number(e.target.value))}>
                    {SHARE_PERIODS.map(p => <option key={p.sec} value={p.sec}>{p.label}</option>)}
                  </select>
                </label>
                <label style={{ display: 'grid', gap: 5, flex: '1 1 120px' }}>
                  <span style={{ fontSize: 12.5, color: 'var(--muted)' }}>PIN (optional)</span>
                  <input value={pin} onChange={e => setPin(e.target.value)} inputMode="numeric" placeholder="e.g. 4823" />
                </label>
                <label style={{ display: 'grid', gap: 5, flex: '1 1 120px' }}>
                  <span style={{ fontSize: 12.5, color: 'var(--muted)' }}>Max views (optional)</span>
                  <input value={maxViews} onChange={e => setMaxViews(e.target.value.replace(/[^0-9]/g, ''))} inputMode="numeric" placeholder="unlimited" />
                </label>
              </div>
              <label style={{ display: 'grid', gap: 5 }}>
                <span style={{ fontSize: 12.5, color: 'var(--muted)' }}>Note to recipient (optional)</span>
                <textarea value={message} onChange={e => setMessage(e.target.value)} rows={2} placeholder="Please review and let me know if we're good to go live." style={{ resize: 'vertical' }} />
              </label>
            </div>
            {err && <div className="err" style={{ marginBottom: 10 }}>{err}</div>}
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button className="btn ghost" onClick={onClose}>Cancel</button>
              <button className="btn primary" disabled={busy} onClick={create}>{busy ? 'Creating…' : 'Create share link'}</button>
            </div>
          </>
        ) : (
          <div style={{ margin: '12px 0' }}>
            <div style={{ padding: '12px 14px', borderRadius: 10, background: 'rgba(74,222,128,.10)', border: '1px solid rgba(74,222,128,.4)', marginBottom: 12 }}>
              <div style={{ fontWeight: 700, color: '#4ade80', marginBottom: 6 }}>Share link created</div>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <code style={{ flex: 1, fontSize: 12.5, wordBreak: 'break-all', background: 'rgba(148,163,184,.12)', padding: '8px 10px', borderRadius: 8 }}>{created.url}</code>
                <button className="btn primary" onClick={copy} style={{ whiteSpace: 'nowrap' }}>{copied ? 'Copied' : 'Copy'}</button>
              </div>
              <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 8 }}>Expires {new Date(created.expiresAt).toLocaleString()}{pin.trim() ? ' · PIN protected' : ''}. The full link is shown once here.</div>
            </div>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button className="btn ghost" onClick={() => { setCreated(null); setPin(''); setLabel(''); setMessage(''); setMaxViews('') }}>Create another</button>
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
          : <IdleOutput sourceUp={sourceUp} onGoLive={onGoLive} />}
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
function HlsVideo({ src, fallbackSrc }: { src: string; fallbackSrc?: string }) {
  const ref = useRef<HTMLVideoElement | null>(null)
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
          hls.loadSource(url); hls.attachMedia(v)
          hls.on(Hls.Events.MANIFEST_PARSED, () => { v.muted = true; v.play().catch(() => {}); setTimeout(snapLive, 400) })
          hls.on(Hls.Events.LEVEL_LOADED, snapLive)
          hls.on(Hls.Events.ERROR, (_e: any, data: any) => {
            if (!data.fatal) return
            if (data.type === Hls.ErrorTypes.MEDIA_ERROR) { try { hls.recoverMediaError() } catch {}; return }
            fails++
            if (!usingFallback && fallbackSrc && fails >= 2) { usingFallback = true; fails = 0; start(fallbackSrc); return }
            setTimeout(() => { try { hls.loadSource(url); hls.startLoad() } catch {} }, 1500) // not ready yet -> reload
          })
        } else if (v.canPlayType('application/vnd.apple.mpegurl')) { v.src = url; v.muted = true; v.play().catch(() => {}); v.addEventListener('loadeddata', snapLive, { once: true }) }
      }
      start(src)
    })()
    return () => { cancelled = true; try { hls?.destroy() } catch {} }
  }, [src, fallbackSrc])
  return <video ref={ref} playsInline muted style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover', background: '#000' }} />
}

function hostOf(url?: string | null) { try { return url ? new URL(url).host : '' } catch { return '' } }

function SourcePlayer({ d, sourceUp, onSendSource, busy }: { d: CD; sourceUp: boolean; onSendSource: () => void; busy: boolean }) {
  const configured = d.sources.find(s => s.role === 'primary' && s.ingest_url) || d.sources.find(s => s.ingest_url)
  const proto = (configured?.protocol || d.sources[0]?.protocol || 'SRT').toUpperCase()
  const ts = d.testStream
  const srcHost = hostOf(ts.sourceUrl || configured?.ingest_url)
  const sendLabel = configured ? `Send source (${proto})` : 'Send test source'
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
  const srcVideoSrc = directHls ?? `/origin/${d.id}/master.m3u8`
  const srcFallback = directHls ? `/origin/${d.id}/master.m3u8` : undefined
  return (
    <div className="player">
      <div className="video">
        {canPreview ? <HlsVideo src={srcVideoSrc} fallbackSrc={srcFallback} /> : <div className="grad" style={srcErrored ? { background: 'radial-gradient(120% 120% at 70% 20%,#2a1620 0%,#0b0f16 70%)' } : undefined} />}
        <div className="plabel"><span className="pt" style={{ color: srcErrored ? '#fca5a5' : '#a5b4fc' }}>SOURCE · {proto}</span></div>
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
                {busy ? 'Sending source…' : `▶  ${sendLabel}`}
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

function IdleOutput({ sourceUp, onGoLive }: { sourceUp: boolean; onGoLive: () => void }) {
  return (
    <div className="player">
      <div className="video">
        <div className="grad" style={{ background: 'radial-gradient(120% 120% at 70% 20%,#20304a 0%,#0b0f16 70%)' }} />
        <div className="plabel"><span className="pt" style={{ color: sourceUp ? '#38bdf8' : '#98a1b6' }}>OUTPUT · {sourceUp ? 'ready' : 'idle'}</span></div>
        <div className="badge-live" style={{ background: sourceUp ? 'rgba(56,189,248,.8)' : 'rgba(102,112,138,.7)' }}><span className="d" />{sourceUp ? 'READY' : 'IDLE'}</div>
        <div style={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center', textAlign: 'center', padding: 20 }}>
          {sourceUp ? (
            <div>
              <button className="btn primary" onClick={onGoLive} style={{ transform: 'scale(1.05)' }}>
                <span className="dot-s live" style={{ marginRight: 6 }} />Go live
              </button>
              <div style={{ marginTop: 12, fontSize: 12, color: 'var(--muted)' }}>Source is receiving — take the output live.</div>
            </div>
          ) : (
            <div style={{ color: 'var(--faint)', fontSize: 13, maxWidth: 300 }}>
              <div style={{ fontWeight: 600, color: 'var(--muted)', marginBottom: 4 }}>Waiting for source</div>
              Send a source first — the output can only go live once the source is arriving.
            </div>
          )}
        </div>
        <div className="ptime">{sourceUp ? 'ready to go live' : 'no source'}</div>
      </div>
      <div className="pfoot">
        <span className={`dot-s ${sourceUp ? 'sched' : 'idle'}`} /> {sourceUp ? 'Encoder warm · output held private until you go live' : 'Output disabled until a source is connected'}
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
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const hlsRef = useRef<any>(null)
  const dashRef = useRef<any>(null)
  const [fmt, setFmt] = useState<'hls' | 'dash'>(pkg === 'dash' ? 'dash' : 'hls')
  const [levels, setLevels] = useState<{ height: number; bitrate: number }[]>([])
  const [level, setLevel] = useState(-1) // -1 = auto (ABR)
  const [scrubbed, setScrubbed] = useState(false) // operator dragged into DVR (else live)
  const [behind, setBehind] = useState(0)          // seconds behind the live edge
  const [winSec, setWinSec] = useState(0)          // available DVR depth NOW (grows as it fills, capped at the window)
  const [cue, setCue] = useState('')
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
    // LIVE IS THE DEFAULT: jump to the live edge shortly after load (once).
    const snapSoon = () => {
      const snap = () => { try { const sk = video.seekable; if (sk.length && !didSnapRef.current) { video.currentTime = sk.end(sk.length - 1) - 0.5; didSnapRef.current = true } } catch {} }
      setTimeout(snap, 300); setTimeout(snap, 1200)
    }
    async function attachHls() {
      const Hls = (await import('hls.js')).default
      if (cancelled) return
      if (Hls.isSupported()) {
        const src = originUrl(`/origin/${d.id}/master.m3u8`)
        const hls = new Hls({ lowLatencyMode: false, backBufferLength: d.dvr.effective_sec, liveSyncDurationCount: 3, manifestLoadingMaxRetry: 12, manifestLoadingRetryDelay: 1000, levelLoadingMaxRetry: 12 })
        hlsRef.current = hls
        hls.loadSource(src); hls.attachMedia(video!)
        hls.on(Hls.Events.MANIFEST_PARSED, () => {
          setLevels(hls.levels.map((l: any) => ({ height: l.height, bitrate: l.bitrate })))
          video!.muted = true; video!.play().catch(() => {}); snapSoon()
        })
        hls.on(Hls.Events.ERROR, (_e: any, data: any) => {
          if (!data.fatal) return
          if (data.type === Hls.ErrorTypes.MEDIA_ERROR) { try { hls.recoverMediaError() } catch {} }
          else { setTimeout(() => { try { hls.loadSource(src); hls.startLoad() } catch {} }, 1500) } // not ready yet -> reload
        })
      } else if (video!.canPlayType('application/vnd.apple.mpegurl')) {
        video!.src = originUrl(`/origin/${d.id}/master.m3u8`); video!.muted = true; video!.play().catch(() => {}); snapSoon()
      }
    }
    async function attachDash() {
      const dashjs: any = (await import('dashjs')).default
      if (cancelled) return
      const url = originUrl(`/origin/${d.id}/manifest.mpd`)
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
        video.muted = true; video.play().catch(() => {}); snapSoon()
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
        if (!scrubbedRef.current && end - v.currentTime > 12) {
          try { v.currentTime = end - 0.5 } catch { /* ignore */ }
        }
        setBehind(Math.max(0, Math.round(end - v.currentTime)))
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
    scrubbedRef.current = true; setScrubbed(true)   // deliberate DVR scrub: release the live lock
    const end = v.seekable.end(v.seekable.length - 1)
    v.currentTime = Math.max(v.seekable.start(0), end - Math.max(0, sec))
  }
  function goLive() { const v = videoRef.current; scrubbedRef.current = false; setScrubbed(false); if (!v || !v.seekable.length) return; v.currentTime = v.seekable.end(v.seekable.length - 1) - 0.5 }

  // live is the default: we are LIVE unless the operator has scrubbed back into the DVR.
  const liveNow = !scrubbed
  // slider position: pinned to the RIGHT (live) while live so it never bounces as new
  // chunks append; only when scrubbed does the handle sit back at (window - behind).
  const sliderMax = Math.max(1, winSec)
  const sliderVal = liveNow ? sliderMax : Math.min(sliderMax, Math.max(0, winSec - behind))

  return (
    <div className="player">
      <div className="video">
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
        <div className="bug"><span className="lg">{BOLT}</span>{d.name.toUpperCase()}</div>
        {subOn && cue && (
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
        <span className="dot-s live" /> Playing {fmt.toUpperCase()}{d.captions?.enabled ? ' · live subtitles (WebVTT)' : ''}
        <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center', marginLeft: 'auto' }}>
          {/* HLS / DASH toggle — verify BOTH packagings play. Only shown when the
              channel produces both; otherwise there is only one output to preview. */}
          {hasHls && hasDash && (
            <span style={{ display: 'inline-flex', border: '1px solid var(--border)', borderRadius: 8, overflow: 'hidden' }}>
              <button className={`chip ${fmt === 'hls' ? 'active' : ''}`} style={{ padding: '5px 10px', borderRadius: 0 }} onClick={() => setFmt('hls')}>HLS</button>
              <button className={`chip ${fmt === 'dash' ? 'active' : ''}`} style={{ padding: '5px 10px', borderRadius: 0 }} onClick={() => setFmt('dash')}>DASH</button>
            </span>
          )}
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
  // filler on loss
  const [lossBehavior, setLossBehavior] = useState<'none' | 'slate' | 'vod_loop' | 'last_frame' | 'black'>(d.input_loss_behavior || 'none')
  const [slateRef, setSlateRef] = useState(d.filler_slate_ref || '')
  const [pickerOpen, setPickerOpen] = useState(false)
  const [loopPickerOpen, setLoopPickerOpen] = useState(false)
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
    patch.captions = { enabled: capOn, targets: capOn ? capLangs : [] }
    // filler on loss
    patch.inputLossBehavior = lossBehavior
    patch.fillerSlateRef = (lossBehavior === 'slate' || lossBehavior === 'vod_loop') && slateRef.trim() ? slateRef.trim() : null

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
          <SourceInput protocols={protocols} value={primary} onChange={setPrimary} label="Primary source" />
          <SourceInput protocols={protocols} value={backup} onChange={setBackup} label="Backup source (optional)" />

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
