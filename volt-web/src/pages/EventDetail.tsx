// ============================================================================
//  THE EVENT PAGE (22 Oct 2026). An event used to have only its settings
//  drawer: there was nowhere to watch it, see its gates, its log or what it
//  recorded. This page is the channel page's counterpart, built from the SAME
//  parts so the two cannot drift: the five-gate strip, the source and output
//  players, the status board and event log, the viewers chart and the output
//  URLs come from ChannelDetail.tsx, fed by GET /events/:id/detail, which the
//  API builds with the same code as the channel page (buildStreamDetail).
//
//  What only an event has, and so lives here:
//    - the SCHEDULE: server window, scheduled window and public window on one
//      bar with a now marker, and where the event is in its life
//    - no on-air switch: an event is public while it is live inside its public
//      window, so the header offers Start and Stop, not Go on air
//    - the RECORDINGS this event made, linked to the clipping workbench
//
//  First version, meant for refining: panels are arranged with the same
//  Customise layout as channels (panelLayout.tsx, pageKey "event").
// ============================================================================
import { useEffect, useState } from 'react'
import { api, type EventDetailData, type Group, type ChannelDetail as CD } from '../api'
import { navigate } from '../router'
import { subscribeLive } from '../liveStatus'
import { PipelineStrip, RecoveryNote } from '../scaffold'
import { usePageNotice, useNotify, PageError } from '../notices'
import { useAccess, ReadOnlyBadge } from '../access'
import { ShareDrawer } from '../ShareDrawer'
import { EmbedDrawer } from '../EmbedDrawer'
import { pressable } from '../a11y'
import { OutputUrls } from '../OutputUrls'
import { PanelLayout } from '../panelLayout'
import { RightsPreview } from '../RightsPreview'
import { DualPlayers, StatusBoard, EventLog, ViewersCard, QcPanel, withMeters, EpgStrip } from './ChannelDetail'
import { EventDrawer } from './Events'
import { broadcastOf } from '../programmeGestures'
import { removalText } from '../programmeMedia'
import { LiveGraphicsButton } from '../graphics/LiveGraphicsButton'

const ms = (v: string | number | null | undefined) => (v == null ? null : typeof v === 'number' ? v : Date.parse(v))

function fmtDur(msv: number): string {
  const s = Math.max(0, Math.round(msv / 1000))
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60)
  if (d) return `${d}d ${h}h`
  if (h) return `${h}h ${String(m).padStart(2, '0')}m`
  if (m) return `${m}m`
  return `${s}s`
}
function fmtWhen(t: number, now: number): string {
  const d = new Date(t)
  const sameDay = new Date(now).toDateString() === d.toDateString()
  const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  return sameDay ? time : `${d.toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' })} ${time}`
}

/** Where the event is in its life, in words an operator acts on. */
function phase(ev: EventDetailData, now: number): { label: string; cls: string; sub: string } {
  const s = ms(ev.scheduled_start)!, e = ms(ev.scheduled_end)!
  if (ev.status === 'live') return { label: 'LIVE', cls: 'live', sub: now < e ? `${fmtDur(now - s)} in · ends in ${fmtDur(e - now)}` : `running ${fmtDur(now - e)} past its scheduled end` }
  if (now < s) return { label: 'UPCOMING', cls: 'sched', sub: `starts in ${fmtDur(s - now)}` }
  if (now < e) return { label: 'IN WINDOW', cls: 'warn', sub: `scheduled since ${fmtDur(now - s)} ago but not running` }
  return { label: 'ENDED', cls: 'idle', sub: `ended ${fmtDur(now - e)} ago` }
}

export default function EventDetail({ id, onBack }: { id: string; onBack: () => void }) {
  const { can } = useAccess()
  const canRun = can('events', 'operate')
  const canManage = can('events', 'manage')
  const notify = useNotify()
  const [d, setD] = useState<EventDetailData | null>(null)
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  const [now, setNow] = useState(Date.now())
  const [groups, setGroups] = useState<Group[]>([])
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [shareOpen, setShareOpen] = useState(false)
  const [embedOpen, setEmbedOpen] = useState(false)
  const [qcOpen, setQcOpen] = useState(false)
  const [resetBusy, setResetBusy] = useState(false)   // Clear QC in flight

  async function load() {
    try { setD(await api.eventDetail(id)); setErr('') } catch (e: any) { setErr(e.message) }
  }
  useEffect(() => { load(); api.groups().then(setGroups).catch(() => {}) /* eslint-disable-next-line */ }, [id])
  // Same live model as the channel page: SSE pushes a change, a slow reconcile
  // keeps continuous signals (output advancing, billing) fresh.
  useEffect(() => {
    let t: ReturnType<typeof setTimeout> | null = null
    const refetch = () => { if (t) return; t = setTimeout(() => { t = null; load() }, 350) }
    const unsub = subscribeLive(`event:${id}`, refetch)
    const iv = setInterval(load, 6000)
    return () => { if (t) clearTimeout(t); unsub(); clearInterval(iv) }
    // eslint-disable-next-line
  }, [id])
  useEffect(() => { const iv = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(iv) }, [])
  usePageNotice('action', err && d ? { kind: 'error', message: err, onDismiss: () => setErr('') } : null)

  if (err && !d) return <PageError message={err} onRetry={load} />
  if (!d) return <div className="loading">Loading event…</div>

  const cd = d as unknown as CD   // the shared panels read the channel-detail shape, which this is
  const health = d.health
  const perr = health?.primaryError || null
  const ph = phase(d, now)
  const sourceUp = d.status === 'live'
  const hasRunningInstance = Array.isArray(d.instances) && d.instances.length > 0
  const serverUp = sourceUp || hasRunningInstance || !!d.billing?.billable
  const hasSource = (d.sources ?? []).some((s: any) => !!s.ingest_url)
  const captionLangs = d.captions?.targets?.length ? d.captions.targets : ['en']
  const wt = d.profile?.workflow_type
  const ov = health?.overall || (sourceUp ? 'starting' : 'idle')
  const OV: Record<string, { label: string; cls: string }> = {
    onair: { label: 'ON AIR', cls: 'live' }, ready: { label: 'READY', cls: 'sched' }, starting: { label: 'STARTING', cls: 'sched' },
    degraded: { label: 'DEGRADED', cls: 'warn' }, error: { label: perr ? `${perr.label.toUpperCase()} ERROR` : 'ERROR', cls: 'down' },
    stopped: { label: 'STOPPED', cls: 'idle' }, idle: { label: 'IDLE', cls: 'idle' },
  }
  const st = OV[ov] || OV.idle

  async function startStop(action: 'start' | 'stop') {
    setBusy(true)
    try { await api.eventStartStop(id, action); await load() }
    catch (e: any) { setErr(e.message) } finally { setBusy(false) }
  }
  // CLEAR QC: a clean slate for the health model (POST /events/:id/health/reset),
  // the same as on the channel page; earlier faults stay in the event log.
  async function resetQc() {
    setResetBusy(true)
    try {
      const r = await api.resetEventHealth(id)
      await load()
      notify(r.primaryError
        ? { kind: 'warn', message: `QC cleared, but ${r.primaryError.label.toLowerCase()} is still failing now: ${r.primaryError.message}` }
        : { kind: 'ok', message: r.was === 'error' || r.was === 'degraded' ? 'QC cleared: the earlier errors are in the event log.' : 'QC cleared.' })
    } catch (e: any) { setErr(e.message) } finally { setResetBusy(false) }
  }
  async function remove() {
    if (!d) return
    if (!confirm(`Delete "${d.name}"? Its recordings and clips go with it. This can't be undone.`)) return
    try { await api.deleteEvent(id); notify({ kind: 'ok', message: `Deleted "${d.name}".` }); navigate('/events') }
    catch (e: any) { setErr(e.message) }
  }

  return (
    <>
      <div className="page-head">
        <div>
          <div className="crumb" style={{ marginBottom: 6 }}>
            <span className="lnk" style={{ cursor: 'pointer', color: 'var(--brand)' }} {...pressable(onBack)}>Events</span>
            &nbsp;/&nbsp; <b style={{ color: 'var(--text)' }}>{d.name}</b>
          </div>
          <h1 className="page-id">
            <span className="dthumb" style={{ background: 'linear-gradient(135deg,#b91c1c,#f87171)' }}>{d.name.split(/\s+/).slice(0, 2).map(w => w[0]).join('').toUpperCase()}</span>
            {d.name}
            <span className="tag type event">{wt === 'transcode' ? 'Transcode' : 'Packaging'}</span>
            <span className={`tag ${ph.cls}`}><span className={`dot-s ${ph.cls}`} />{ph.label}</span>
            {(serverUp || ov === 'error' || ov === 'degraded') && <span className={`tag ${st.cls}`}><span className={`dot-s ${st.cls}`} />{st.label}</span>}
            {d.billing?.billable && (
              <span className="ev-bill" title="Server up, live time metering">● billable · {fmtDur(now - (d.billing.since ?? now))}</span>
            )}
          </h1>
          <p>
            {fmtWhen(ms(d.scheduled_start)!, now)} → {fmtWhen(ms(d.scheduled_end)!, now)} · {ph.sub}
            {' · '}{((d.sources ?? [])[0]?.protocol || 'SRT').toUpperCase()} ingest · {d.profile?.packaging === 'both' ? 'HLS + DASH' : (d.profile?.packaging || 'HLS').toUpperCase()}
            {d.captions?.enabled ? ' · captions on' : ''}
            {d.recording_enabled === false ? ' · recording off' : ' · recording on'}
          </p>
        </div>
        <div className="spacer" />
        <div className="icon-actions">
          <button className={`btn ghost icon-btn${perr ? ' alert' : ''}`} onClick={() => setQcOpen(true)} data-tip="QC: diagnose the pipeline" aria-label="QC">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 3l7.5 3v5.5c0 4.6-3.2 8.4-7.5 9.5-4.3-1.1-7.5-4.9-7.5-9.5V6L12 3z" /><path d="M8.8 12l2.2 2.2 4.2-4.4" /></svg>
          </button>
          {canRun && (
            <button className="btn ghost icon-btn" onClick={resetQc} disabled={resetBusy}
              data-tip={resetBusy ? 'Clearing…' : 'Clear QC: reset errors and judge the event afresh'} aria-label="Clear QC">
              <svg className={resetBusy ? 'spin' : undefined} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 12a9 9 0 1 0 2.6-6.4L3 8" /><path d="M3 3v5h5" /></svg>
            </button>
          )}
          {can('sharing', 'manage') && (
            <button className="btn ghost icon-btn" onClick={() => setShareOpen(true)} data-tip="Share a private preview link" aria-label="Share">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M4 12v7a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-7" /><path d="M16 6l-4-4-4 4" /><path d="M12 2v14" /></svg>
            </button>
          )}
          {can('apps', 'view') && (
            <button className="btn ghost icon-btn" onClick={() => setEmbedOpen(true)} data-tip="Embed player: countdown, Buy when paid, then the live player" aria-label="Embed player">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="2.5" y="4.5" width="19" height="15" rx="2.5" /><path d="M10 9.2v5.6l4.6-2.8z" fill="currentColor" stroke="none" /></svg>
            </button>
          )}
          {/* Graphics enabled and in use on this event: one click to live control. */}
          <LiveGraphicsButton eventId={d.id} />
          <button className="btn ghost icon-btn" onClick={() => setSettingsOpen(true)} data-tip={canManage ? 'Settings' : 'View settings'} aria-label="Settings">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" /></svg>
          </button>
        </div>
        {!canRun ? <ReadOnlyBadge feature="events" /> : !serverUp ? (
          <button className="btn primary" disabled={busy || !hasSource} onClick={() => startStop('start')}
            title={hasSource ? 'Bring the encoder up now, ahead of the server window if need be' : 'No input source is configured. Set it in Settings first.'}>
            {busy ? 'Starting…' : hasSource ? 'Start event' : 'Start event (no source)'}
          </button>
        ) : (
          <button className="btn ghost" disabled={busy} onClick={() => startStop('stop')} style={{ color: '#fca5a5', borderColor: 'rgba(248,113,113,.5)' }}>
            {busy ? 'Stopping…' : 'Stop event'}
          </button>
        )}
      </div>

      <RecoveryNote row={d} state={health?.overall}
        onAutoConnect={canRun ? async (on) => { setBusy(true); try { await api.setAutoConnect('event', d.id, on); await load() } catch (e: any) { setErr(e.message) } finally { setBusy(false) } } : undefined}
        togglingAuto={busy} />

      {perr && (
        <div className="ev-err">
          <span style={{ fontSize: 'var(--fs-h2)' }}>⚠</span>
          <div style={{ flex: 1 }}>
            <div style={{ fontWeight: 700, color: '#fca5a5' }}>{perr.label} {health?.gates.find(g => g.gate === perr.gate)?.status === 'degraded' ? 'degraded' : 'failed'}</div>
            <div style={{ fontSize: 'var(--fs-body)', color: 'var(--muted)', wordBreak: 'break-word' }}>{perr.message}</div>
          </div>
        </div>
      )}

      <PipelineStrip gates={withMeters(cd)} />

      <PanelLayout pageKey="event" panels={[
        { id: 'schedule', label: 'Schedule', node: <ScheduleCard d={d} now={now} /> },
        // The event's programme guide, the same strip and flags as a channel.
        { id: 'epg', label: 'Programme guide', node: (
          <EpgStrip d={cd} broadcast={broadcastOf(ov, !!d.onAir)} ownerPath={`/epg/event/${encodeURIComponent(d.id)}`}
            onChanged={load} onAddEpg={() => navigate(`/epg/event/${encodeURIComponent(d.id)}`)} />) },
        { id: 'players', label: 'Source and output players', node: (
          <DualPlayers d={cd} captionLangs={captionLangs} sourceUp={sourceUp} onAir={!!d.onAir}
            onSendSource={() => startStop('start')} onGoLive={() => startStop('start')} busy={busy} />) },
        { id: 'outputs', label: 'Output URLs', node: (
          <OutputUrls id={d.id} packaging={d.profile?.packaging} captions={!!d.captions?.enabled} publicOpen={!!d.onAir} kindLabel="event" />) },
        { id: 'rights', label: 'Rights preview', node: <RightsPreview kind="event" id={d.id} /> },
        { id: 'viewers', label: 'Realtime viewers', node: <ViewersCard d={cd} live={!!d.onAir} /> },
        { id: 'status', label: 'Status board and event log', node: (
          <div className="grid-2">
            <StatusBoard d={cd} live={!!d.onAir} />
            <EventLog d={cd} />
          </div>) },
        { id: 'recordings', label: 'Recordings', node: <RecordingsCard d={d} now={now} /> },
      ]} />

      {canManage && d.status !== 'live' && (
        <div className="danger-zone">
          <div>
            <div className="dz-t">Delete this event</div>
            <div className="dz-d">Removes the event with its recordings and clips. A live event has to be stopped first.</div>
          </div>
          <button className="btn ghost" style={{ color: '#fca5a5', borderColor: 'rgba(248,113,113,.5)' }} onClick={remove}>Delete event</button>
        </div>
      )}

      {settingsOpen && <EventDrawer groups={groups} event={d as any} onClose={() => setSettingsOpen(false)} onDone={() => { setSettingsOpen(false); load() }} />}
      {shareOpen && <ShareDrawer target={{ kind: 'event', id: d.id, name: d.name }} onClose={() => setShareOpen(false)} />}
      {embedOpen && <EmbedDrawer target={{ kind: 'event', id: d.id, name: d.name, startsAt: d.public_start ?? d.scheduled_start ?? null }} onClose={() => setEmbedOpen(false)} />}
      {qcOpen && <QcPanel d={cd} onClose={() => setQcOpen(false)} onRefresh={load} />}
    </>
  )
}

/**
 * THE THREE WINDOWS ON ONE BAR. Server (when the encoder is up and billing),
 * scheduled (the event itself) and public (when viewers can play it), with a
 * now marker. They are different on purpose: the server comes up early to
 * warm up and the public window can open late or close early. Seeing them
 * together is how an operator spots a public window that misses the start.
 */
function ScheduleCard({ d, now }: { d: EventDetailData; now: number }) {
  const w = {
    server: [ms(d.server_start) ?? ms(d.scheduled_start)!, ms(d.server_stop) ?? ms(d.scheduled_end)!],
    sched: [ms(d.scheduled_start)!, ms(d.scheduled_end)!],
    pub: [ms(d.public_start) ?? ms(d.scheduled_start)!, ms(d.public_end) ?? ms(d.scheduled_end)!],
  }
  const lo = Math.min(w.server[0], w.sched[0], w.pub[0])
  const hi = Math.max(w.server[1], w.sched[1], w.pub[1])
  const pad = Math.max((hi - lo) * 0.08, 5 * 60_000)
  const a = lo - pad, b = hi + pad
  const x = (t: number) => `${Math.max(0, Math.min(100, ((t - a) / (b - a)) * 100))}%`
  const wid = (s: number, e: number) => `${Math.max(0.6, ((Math.min(e, b) - Math.max(s, a)) / (b - a)) * 100)}%`
  const showNow = now >= a && now <= b
  const rows: [string, string, number[], string][] = [
    ['Server', 'Encoder up and billing', w.server, 'srv'],
    ['Event', 'The scheduled window', w.sched, 'evt'],
    ['Public', 'Viewers can play it', w.pub, 'pub'],
  ]
  const lateOpen = w.pub[0] > w.sched[0], earlyClose = w.pub[1] < w.sched[1]
  return (
    <div className="card ev-sched">
      <div className="sec-label">Schedule</div>
      <div className="ev-lanes">
        {rows.map(([name, hint, [s, e], cls]) => (
          <div key={name} className="ev-lane">
            <div className="ev-lane-h"><b>{name}</b><span>{hint}</span></div>
            <div className="ev-track">
              <div className={`ev-win ${cls}`} style={{ left: x(s), width: wid(s, e) }} title={`${new Date(s).toLocaleString()} → ${new Date(e).toLocaleString()}`} />
              {showNow && <div className="ev-now" style={{ left: x(now) }} />}
            </div>
            <div className="ev-lane-t">{fmtWhen(s, now)} → {fmtWhen(e, now)} <span>· {fmtDur(e - s)}</span></div>
          </div>
        ))}
      </div>
      <div className="ev-facts">
        <span>Auto connect <b>{d.autoConnect === false ? 'off' : 'on'}</b></span>
        <span>Recording <b>{d.recording_enabled === false ? 'off' : 'on'}</b></span>
        <span>Auto-VOD <b>{d.auto_vod === false ? 'off' : 'on'}</b></span>
        <span>DVR <b>to event start</b></span>
        {(lateOpen || earlyClose) && <span className="ev-warn">Public window {lateOpen ? 'opens after the event starts' : ''}{lateOpen && earlyClose ? ' and ' : ''}{earlyClose ? 'closes before it ends' : ''}</span>}
      </div>
    </div>
  )
}

function RecordingsCard({ d, now }: { d: EventDetailData; now: number }) {
  const recs = d.recordings ?? []
  return (
    <div className="card ev-recs">
      <div className="sec-label">Recordings</div>
      {recs.length === 0 ? (
        <div className="ev-empty">{d.recording_enabled === false ? 'Recording is off for this event. Turn it on in Settings to keep what goes out.' : 'Nothing recorded yet. Recording starts when the event goes live.'}</div>
      ) : (
        <table>
          <thead><tr><th>Recording</th><th>Started</th><th>Length</th><th>Status</th><th title="When the recording is deleted by the keep period">Removed</th><th /></tr></thead>
          <tbody>
            {recs.map(r => {
              const s = Number(r.start_epoch_ms), e = r.end_epoch_ms != null ? Number(r.end_epoch_ms) : null
              const len = r.duration_ms != null ? Number(r.duration_ms) : (e ?? now) - s
              return (
                <tr key={r.id} style={{ cursor: 'pointer' }} onClick={() => navigate(`/recordings/${r.id}`)}>
                  <td><b>{r.title || d.name}</b></td>
                  <td style={{ color: 'var(--muted)' }}>{fmtWhen(s, now)}</td>
                  <td style={{ color: 'var(--muted)' }}>{fmtDur(len)}{e == null ? ' so far' : ''}</td>
                  <td><span className={`tag ${r.status === 'recording' ? 'live' : 'idle'}`}>{r.status}</span></td>
                  <td style={{ color: removalText((r as any).expires_at).warn ? '#fbbf24' : 'var(--muted)', whiteSpace: 'nowrap' }} title={removalText((r as any).expires_at).text}>
                    {removalText((r as any).expires_at).short === 'kept' ? 'kept' : removalText((r as any).expires_at).text.replace(/^Removed /, '')}</td>
                  <td style={{ textAlign: 'right' }}><button className="btn ghost" onClick={(ev) => { ev.stopPropagation(); navigate(`/recordings/${r.id}`) }}>Open in workbench</button></td>
                </tr>
              )
            })}
          </tbody>
        </table>
      )}
    </div>
  )
}
