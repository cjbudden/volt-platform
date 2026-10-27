import { useEffect, useMemo, useState } from 'react'
import { apiRequest } from '../api'
import { PageError, usePageNotice } from '../notices'
import { AnalyticsViewSwitch } from './OperatingReports'

/* ============================================================================
   PLAYBACK EXPERIENCE  (QOE_REPORTING.md, build queue 1.14e, 1.14f and 1.14g)

   The third view under Analytics: what each viewer actually saw, from the
   Volt SDK's CMCD v2 reports. The reports on one page (playback success,
   startup, buffering, quality, rendering, access and DRM, live streams,
   advertising, delivery from the CDN's edge logs (build queue 2.9),
   engagement, telemetry health), every one filtered by the same
   bar, plus the worst segments of any dimension so a bad device or app
   release stands out instead of being averaged away, and the sessions behind
   the numbers: open one to see everything that happened to that viewer, in
   order (report 11). Journey to play (reports 28 and 29) joins the app's
   own events (app open, screens, the title picked and where from, paywall)
   to the plays, so the funnel from opening the app to the first frame and
   the entry points that lead to watching are on the same page.

   Everything comes from GET /api/analytics/qoe/* (modules/qoe.ts), which
   reads the separate analytics database. The definitions behind each number
   are one click away, as the design asks.
   ========================================================================== */

type Trio = { p50: number | null; p95: number | null; p99: number | null }
export interface QoeOverview {
  definitions: number; from: string; to: string
  success: { attempts: number; sessions: number; started: number; startupSuccess: number | null; startupFailures: number; startupFailureRate: number | null; failedSessions: number
    exitsBeforeFirstFrame: number; ebffRate: number | null; ebffByWait: Record<string, number>; fatalAfterStart: number; failureAfterStartRate: number | null; fatalAfterSessions: number
    errors: Array<{ phase: string; step: string | null; code: string | null; views: number; sessions: number }> }
  startup: { views: number; startup: Trio; slowSessions: number; breakdown: Array<Trio & { span: string; views: number; avg: number | null }> }
  buffering: { views: number; viewsWithStalls: number; viewsWithStallsRate: number | null; stalledSessions: number; stalls: number; rebufferRatio: number | null; stallsPerHour: number | null
    avgStallMs: number | null; timeToFirstStall: Trio; rebufferRatioPerView: Trio; seeks: number; avgSeekMs: number | null }
  quality: { views: number; timeWeightedKbps: number | null; perViewKbps: Record<string, number | null>; timeAtBitrate: Array<{ band: string; share: number }>; belowScreenShare: number | null
    switchesPerHour: number | null; oscillationsPerHour: number | null; avgBufferMs: number | null; avgThroughputKbps: number | null }
  engagement: { views: number; sessions: number; started: number; playingHours: number; avgPlayingMs: number | null; ebffRate: number | null; exitAfterStall: number; exitAfterError: number
    leftAfterStallShare: number | null; byContent: Array<{ contentId: string | null; name: string | null; views: number; started: number; playingHours: number; stalledShare: number | null; leftAfterProblem: number }> }
  telemetry: { views: number; reports: number; eventLoss: number | null; missingReports: number; viewsWithLoss: number; viewsWithoutSequence: number; lateReports: number; lateShare: number | null
    clockSkewMs: Trio; unknownKeys: Array<{ key: string; reports: number }>; collector: { accepted: number; rejected: number; rejectedShare: number | null; reasons: Record<string, number> }
    coverage?: { cdnSessions: number; withTelemetry: number; share: number | null } | null }
  rendering?: { views: number; viewsReportingFrames: number; droppedFrames: number; droppedPerMinute: number | null; perViewDroppedPerMinute: Trio; viewsWithDrops: number; dropSessions: number
    decodeErrors: number; viewsWithDecodeErrors: number; decodeFatal: number; hardwareDecode: { yes: number; no: number }; keySystems: Array<{ keySystem: string; views: number }>
    byDevice: Array<{ device: string | null; views: number; droppedPerMinute: number | null; decodeErrors: number }> }
  access?: { gate: { decisions: number; allowed: number; denied: number; sessions: number; deniedShare: number | null; timeMs: Trio; reasons: Array<{ reason: string; status: number; decisions: number; sessions: number }> }
    entitlementFailures: number; failures: Array<{ step: string; code: string | null; gateReason: string | null; phase: string; views: number; sessions: number }>
    licence: { views: number; requests: number; failures: number; viewsWithFailures: number; failedBeforeStart: number; failedAfterStart: number; startupSpanMs: Trio; slowestRequestMs: { p50: number | null; p95: number | null } }
    tokenErrors: { errors: number; views: number; sessions: number } }
  live?: { views: number; viewsWithLatency: number; latencyMs: Trio; highestLatencyMs: number | null; driftMs: { p50: number | null; p95: number | null; avg: number | null }
    viewsDriftedOver5s: number; driftedSessions: number; catchUpShare: number | null; rateChanges: number
    byDevice: Array<{ deviceClass: string | null; deviceModel: string | null; views: number; latencyAvgMs: number | null; latencyP95Ms: number | null; driftAvgMs: number | null; highestLatencyMs: number | null; catchUpShare: number | null }> }
  ads?: { views: number; sessions: number; breaks: number; breaksCompleted: number; breakCompletion: number | null; avgBreakMs: number | null; adStartupMs: { avg: number | null; p50: number | null; p95: number | null }
    adRebufferRatio: number | null; adStalls: number; viewsWithAdStalls: number; adErrors: number; returnToContentMs: { avg: number | null; p95: number | null }
    leftDuringAd: number; leftDuringAdSessions: number; adsStarted: number; adsEnded: number; adCompletion: number | null; server: null | { impressions: number; starts: number; firstQuartile: number; midpoint: number; thirdQuartile: number; complete: number; failed: number; sessions: number }
    serverCompletion: number | null }
  delivery?: { requests: number; sampledLines: number; errorRate: number | null; clientErrorRate: number | null; serverErrorRate: number | null; cacheHitRatio: number | null
    originShieldShareOfMisses: number | null; bytes: number; edgeTtfbMs: Trio; edgeTimeMs: Trio; originFirstByteMs: Trio; segmentKbps: { p5: number | null; p50: number | null; p95: number | null }; starvedShare: number | null
    cmcdShare: number | null; sessionIdShare: number | null; lastMileMs: Trio & { joinedRequests: number }
    byObjectType: Array<{ ot: string; requests: number; errorRate: number | null; edgeTtfbMs: Trio; edgeTimeMs: Trio }>
    worst: Array<{ contentId: string | null; country: string | null; requests: number; errorRate: number | null; edgeTtfbP95Ms: number | null }>
    audience: { sessions: number; withSessionId: number; withTelemetry: number; withoutTelemetry: number; withoutSessionId: number } }
}
interface SessionRow { sid: string; attempt: number; startedAt: string; endedAt: string; contentId: string | null; contentName: string | null; device: string | null; os: string | null; browser: string | null
  country: string | null; outcome: string; startupMs: number | null; errorCode: string | null; errorStep: string | null; fatalAfterStart: boolean; stalls: number; adBreaks: number; adsStarted?: number; leftInAd: boolean }
interface Timeline { sid: string; from: string; reports: number; duplicates: number; missingSequence: number[]; viewer: { userAgent: string | null; country: string | null } | null
  views: any[]; contentNames: Record<string, string>
  spans: Array<{ state: string; fromOffsetMs: number; toOffsetMs: number; ms: number }>
  events: Array<{ offsetMs: number; sn: number | null; kind: string; label: string; problem: boolean }>
  gate: Array<{ offsetMs: number; method: string; status: number; reason: string; ms: number; country: string | null }>
  beacons: Array<{ offsetMs: number; event: string; adId: string | null; ok: boolean | null; status: number | null }> }

/** The gate's reasons, in the words an operator uses. */
const GATE_REASON: Record<string, string> = {
  allowed: 'Allowed', replacement: 'Replacement shown', geo: 'Region (geo)', rights: 'Rights window of the programme', payment: 'Payment or entitlement',
  sign_in: 'Sign in needed', group: 'Not in the viewer group', rules: 'Access rule', availability: 'Not published or outside its window',
  app_restriction: 'The app\'s restrictions (origin, referrer, IP)', unknown_asset: 'Unknown asset', error: 'Server error', 'not in the gate log': 'Not in the gate log',
}
/** CMCD object types in plain words (the edge log's requests). */
const OBJECT: Record<string, string> = { m: 'Playlists and manifests', v: 'Video segments', a: 'Audio segments', av: 'Segments', i: 'Init segments', c: 'Captions', tt: 'Timed text', k: 'Keys', o: 'Other' }
const STEP: Record<string, string> = { entitlement: 'Entitlement (play gate)', drm: 'DRM licence', manifest: 'Manifest', segment: 'Segment', decode: 'Decode', playback: 'Playback' }
const SPAN_COLOUR: Record<string, string> = { starting: 'var(--brand-dim, var(--faint))', playing: 'var(--live)', stalled: 'var(--down)', seeking: 'var(--sched)', paused: 'var(--idle)', backgrounded: 'var(--faint)', ad: 'var(--warn)' }
const PROBLEMS = [{ key: 'all', label: 'All' }, { key: 'error', label: 'Ended by an error' }, { key: 'failed', label: 'Failed to start' }, { key: 'stalled', label: 'Stalled' }, { key: 'exited', label: 'Left before the first frame' }, { key: 'ad', label: 'Left during an ad' }]
interface Funnel { sessions: number; truncated: boolean; steps: Array<{ step: string; sessions: number; rate: number | null; fromPrevious: number | null; dropOff: number; msSinceOpen: { p50: number | null; p95: number | null; n: number } }>
  openToFirstFrame: { p50: number | null; p95: number | null; n: number }; paywall: { shown: number; purchased: number; abandoned: number }; refusedByGate: number }
interface Discovery { journeys: number; rows: Array<{ entry: string; detail: string | null; journeys: number; plays: number; started: number; playRate: number | null; startRate: number | null; views: number
  watchMs: number; watchMsPerJourney: number | null; completion: number | null; startupFailureRate: number | null; startupP50: number | null; rebufferRatio: number | null; depthP50: number | null; positionP50: number | null }>
  neverPlayed: Array<{ contentId: string; contentName: string | null; detailViews: number; sessions: number; playedIn: number; neverPlayed: number }> }
/** Funnel steps and entry points in the words an operator uses. */
const FUNNEL_LABEL: Record<string, string> = { open: 'Opened the app', browse: 'Browsed', detail: 'Opened a title', play: 'Pressed play', entitled: 'Allowed to watch', paid: 'Paid where needed', first_frame: 'First frame' }
const ENTRY_LABEL: Record<string, string> = { row: 'A row', search: 'Search', deeplink: 'Deep link', push: 'Push notification', epg: 'Guide (EPG)', continue: 'Continue watching', related: 'Related titles', other: 'Other' }
const entryLabel = (v: string | null) => (v == null ? 'Not reported' : ENTRY_LABEL[v] ?? v)
interface Series { bucketMs: number; ignoredFilters: string[]; points: Array<{ at: string; attempts: number; starts: number; failures: number; stalls: number; startupP50: number | null; startupP95: number | null; rebufferRatio: number | null }> }
interface Breakdown { label: string; rows: Array<{ value: string | null; name?: string | null; views: number; sessions: number; affected: number; measure: number | null }> }

// The filter bar: the dimensions people reach for first. The API takes all of section 6.
const FILTERS: Array<{ key: string; label: string }> = [
  { key: 'content_id', label: 'Content' }, { key: 'stream_type', label: 'Live or on demand' }, { key: 'device_class', label: 'Device class' },
  { key: 'device_model', label: 'Device model' }, { key: 'os', label: 'OS' }, { key: 'browser', label: 'Browser' },
  { key: 'app_name', label: 'App' }, { key: 'app_version', label: 'App version' }, { key: 'sdk_version', label: 'SDK version' },
  { key: 'codec', label: 'Codec' }, { key: 'cdn', label: 'CDN' }, { key: 'country', label: 'Country' }, { key: 'region', label: 'Region' },
  { key: 'asn', label: 'Network (ASN)' }, { key: 'network', label: 'Connection' },
  { key: 'entry_point', label: 'Came from' }, { key: 'session_depth', label: 'Screens before play' },
]
const MEASURES: Array<{ key: string; label: string; kind: 'rate' | 'ms' | 'kbps' }> = [
  { key: 'failure', label: 'Startup failure rate', kind: 'rate' }, { key: 'ebff', label: 'Exit before first frame', kind: 'rate' },
  { key: 'fatal', label: 'Failure after start', kind: 'rate' }, { key: 'stalls', label: 'Views with stalls', kind: 'rate' },
  { key: 'rebuffer', label: 'Rebuffer ratio', kind: 'rate' }, { key: 'startup_p95', label: 'Startup time p95', kind: 'ms' },
  { key: 'bitrate', label: 'Time-weighted bitrate', kind: 'kbps' },
]
const PERIODS = [{ h: 1, label: '1 hour' }, { h: 24, label: '24 hours' }, { h: 24 * 7, label: '7 days' }, { h: 24 * 30, label: '30 days' }]

const fmtInt = (n: number | null | undefined) => (n == null ? '–' : n.toLocaleString())
const fmtPct = (r: number | null | undefined, d = 1) => (r == null ? '–' : `${(r * 100).toFixed(r > 0 && r < 0.001 ? 3 : d)}%`)
const fmtMs = (ms: number | null | undefined) => (ms == null ? '–' : ms >= 10_000 ? `${(ms / 1000).toFixed(1)} s` : ms >= 1000 ? `${(ms / 1000).toFixed(2)} s` : `${Math.round(ms)} ms`)
const fmtKbps = (k: number | null | undefined) => (k == null ? '–' : k >= 1000 ? `${(k / 1000).toFixed(2)} Mbps` : `${Math.round(k)} kbps`)
const fmtRate = (x: number | null | undefined) => (x == null ? '–' : x.toFixed(x >= 10 ? 0 : 2))
const fmtMeasure = (kind: string, v: number | null) => (kind === 'rate' ? fmtPct(v, 2) : kind === 'ms' ? fmtMs(v) : fmtKbps(v))
const pl = (n: number, one: string, many = `${one}s`) => `${fmtInt(n)} ${n === 1 ? one : many}`
/** DRM systems by the names people know them by. */
const keySystemName = (k: string) => ({ 'com.widevine.alpha': 'Widevine', 'com.apple.fps': 'FairPlay', 'com.apple.fps.1_0': 'FairPlay', 'com.microsoft.playready': 'PlayReady', 'com.microsoft.playready.recommendation': 'PlayReady', 'org.w3.clearkey': 'ClearKey' } as Record<string, string>)[k] ?? k
const valueLabel = (v: string | null) => (v == null || v === '' ? 'Not reported' : v === 'l' ? 'Live' : v === 'll' ? 'Live (low latency)' : v === 'v' ? 'On demand' : v)

/** Small line icons beside each report's title (the house style: an icon with the text, never alone). */
const Ic = {
  play: <path d="M8 5v14l11-7z" />,
  clock: <><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></>,
  pause: <><path d="M3 12h3l3-8 4 16 3-8h5" /></>,
  layers: <><path d="m12 3 9 5-9 5-9-5z" /><path d="m3 13 9 5 9-5" /></>,
  users: <><circle cx="9" cy="8" r="3.5" /><path d="M2.5 20a6.5 6.5 0 0 1 13 0" /><path d="M16 4.5a3.5 3.5 0 0 1 0 7M21.5 20a6.5 6.5 0 0 0-4-6" /></>,
  pulse: <><path d="M4 12h4l2-5 4 10 2-5h4" /></>,
  filter: <path d="M4 5h16l-6 8v5l-4 2v-7z" />,
  bars: <><path d="M5 20V10M12 20V4M19 20v-7" /></>,
  monitor: <><rect x="3" y="4" width="18" height="12" rx="2" /><path d="M8 20h8M12 16v4" /></>,
  lock: <><rect x="5" y="11" width="14" height="9" rx="2" /><path d="M8 11V8a4 4 0 0 1 8 0v3" /></>,
  live: <><circle cx="12" cy="12" r="2" /><path d="M8.5 8.5a5 5 0 0 0 0 7M15.5 8.5a5 5 0 0 1 0 7M5.6 5.6a9 9 0 0 0 0 12.8M18.4 5.6a9 9 0 0 1 0 12.8" /></>,
  ad: <><rect x="3" y="6" width="18" height="12" rx="2" /><path d="M7 15l2-6 2 6M7.7 13h2.6M14 9v6h1.5a2 2 0 0 0 2-2v-2a2 2 0 0 0-2-2z" /></>,
  route: <><circle cx="6" cy="18" r="2" /><circle cx="18" cy="6" r="2" /><path d="M8 18h6a4 4 0 0 0 0-8H10a4 4 0 0 1 0-8h6" /></>,
  list: <><path d="M9 6h11M9 12h11M9 18h11" /><circle cx="4.5" cy="6" r="1" /><circle cx="4.5" cy="12" r="1" /><circle cx="4.5" cy="18" r="1" /></>,
  globe: <><circle cx="12" cy="12" r="9" /><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18" /></>,
}

/** One session's states as a strip (report 11), with a legend: what the viewer saw, second by second. */
function SpanStrip({ t }: { t: Timeline }) {
  const end = Math.max(1, ...t.spans.map((s) => s.toOffsetMs))
  const states = [...new Set(t.spans.map((s) => s.state))]
  return (
    <div>
      <div role="img" aria-label="The session's states over time" style={{ position: 'relative', height: 18, borderRadius: 4, background: 'var(--border)', overflow: 'hidden' }}>
        {t.spans.map((s, i) => (
          <span key={i} title={`${s.state}: ${fmtMs(s.ms)}`} style={{ position: 'absolute', top: 0, bottom: 0, left: `${(Math.max(0, s.fromOffsetMs) / end) * 100}%`, width: `${Math.max(0.3, (s.ms / end) * 100)}%`, background: SPAN_COLOUR[s.state] ?? 'var(--muted)' }} />
        ))}
      </div>
      <div className="flex flex-wrap gap-3" style={{ fontSize: 'var(--fs-micro)', color: 'var(--muted)', marginTop: 6 }}>
        {states.map((st) => (
          <span key={st}><span style={{ display: 'inline-block', width: 10, height: 10, borderRadius: 2, background: SPAN_COLOUR[st] ?? 'var(--muted)', verticalAlign: 'middle', marginRight: 6 }} />
            {st[0].toUpperCase() + st.slice(1)} {fmtMs(t.spans.filter((x) => x.state === st).reduce((n, x) => n + x.ms, 0))}</span>
        ))}
      </div>
    </div>
  )
}

/** Report 11: everything one session sent, in order, with the gate's decisions and the stitcher's beacons. */
function SessionTimeline({ t, onClose }: { t: Timeline; onClose: () => void }) {
  const v = t.views[t.views.length - 1]
  const at = (ms: number) => `${ms < 0 ? '-' : '+'}${fmtMs(Math.abs(ms))}`
  type Row = { at: number; what: React.ReactNode; tone?: string; source: string }
  const rows: Row[] = [
    ...t.gate.map((g) => ({ at: g.offsetMs, source: 'Play gate', what: <>Gate answered {g.status}: {GATE_REASON[g.reason] ?? g.reason} ({fmtMs(g.ms)} on the server{g.country ? `, ${g.country}` : ''})</>, tone: g.status >= 400 ? 'var(--down)' : undefined })),
    ...t.events.map((e) => ({ at: e.offsetMs, source: e.sn != null ? `Player #${e.sn}` : 'Player', what: e.label, tone: e.problem ? 'var(--down)' : undefined })),
    ...t.beacons.map((b) => ({ at: b.offsetMs, source: 'Ad server', what: <>Beacon {b.event}{b.adId ? ` for ${b.adId}` : ''}{b.ok === false ? ` failed (${b.status ?? 'no answer'})` : ''}</>, tone: b.ok === false ? 'var(--down)' : undefined })),
  ].sort((a, b) => a.at - b.at)
  return (
    <section id="qoe-timeline" className="card p-4" style={{ marginBottom: 16, minWidth: 0 }} aria-label="Session timeline">
      <div className="flex flex-wrap items-center gap-2" style={{ marginBottom: 8 }}>
        <Icon d={Ic.list} /><h3 style={{ margin: 0 }}>Session timeline</h3>
        <code style={{ fontSize: 'var(--fs-micro)', overflowWrap: 'anywhere' }}>{t.sid}</code>
        <div className="spacer" />
        <button className="btn ghost" style={{ padding: '3px 10px', fontSize: 'var(--fs-sm)' }} onClick={onClose}>Close</button>
      </div>
      <p style={{ margin: '0 0 12px', color: 'var(--muted)', fontSize: 'var(--fs-sm)' }}>
        {v ? <>{t.contentNames[v.content_id] ?? valueLabel(v.content_id)} · {[v.device_model ?? v.device_class, v.os, v.browser].filter(Boolean).join(', ') || 'Unknown device'} · {v.country ?? 'unknown country'} · {v.outcome === 'started' ? `started in ${fmtMs(v.startup_ms)}` : v.outcome === 'failed' ? `failed at ${STEP[v.error_step] ?? v.error_step ?? 'an unknown step'} (${v.error_code ?? 'no code'})` : 'left before the first frame'}</> : 'No view row: the session never reached play.'}
        {' '}· {fmtInt(t.reports)} reports from {new Date(t.from).toLocaleString()}
        {t.missingSequence.length > 0 && <> · <span style={{ color: 'var(--warn)' }}>{t.missingSequence.length} missing (#{t.missingSequence.slice(0, 5).join(', #')}{t.missingSequence.length > 5 ? ', ...' : ''})</span></>}
        {t.duplicates > 0 && <> · {t.duplicates} sent twice, counted once</>}
      </p>
      {t.spans.length > 0 && <SpanStrip t={t} />}
      <div style={{ overflowX: 'auto', marginTop: 14 }}>
        <table>
          <thead><tr><th>When</th><th>From</th><th>What happened</th></tr></thead>
          <tbody>{rows.map((r, i) => (
            <tr key={i}>
              <td style={{ fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>{at(r.at)}</td>
              <td style={{ whiteSpace: 'nowrap', color: 'var(--muted)' }}>{r.source}</td>
              <td style={{ color: r.tone ?? 'var(--text)', overflowWrap: 'anywhere' }}>{r.what}</td>
            </tr>
          ))}</tbody>
        </table>
      </div>
    </section>
  )
}
function Icon({ d }: { d: React.ReactNode }) {
  return <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ flex: 'none', color: 'var(--muted)' }}>{d}</svg>
}

function Stat({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: string }) {
  return (
    <div style={{ minWidth: 0 }}>
      <div style={{ fontSize: 'var(--fs-micro)', color: 'var(--faint)', textTransform: 'uppercase', letterSpacing: 'var(--ls-label)', marginBottom: 4 }}>{label}</div>
      <div style={{ fontSize: 'var(--fs-h2, 20px)', lineHeight: 1.15, color: tone ?? 'var(--text)', fontVariantNumeric: 'tabular-nums', overflowWrap: 'anywhere' }}>{value}</div>
      {sub && <div style={{ fontSize: 'var(--fs-micro)', color: 'var(--faint)', marginTop: 2 }}>{sub}</div>}
    </div>
  )
}
const statGrid: React.CSSProperties = { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(130px, 1fr))', gap: 16 }

function Report({ icon, title, question, children }: { icon: React.ReactNode; title: string; question: string; children: React.ReactNode }) {
  return (
    <section className="card p-4" style={{ marginBottom: 16, minWidth: 0 }} aria-label={title}>
      <div className="flex items-center gap-2" style={{ marginBottom: 4 }}><Icon d={icon} /><h3 style={{ margin: 0 }}>{title}</h3></div>
      <p style={{ margin: '0 0 14px', color: 'var(--muted)', fontSize: 'var(--fs-sm)' }}>{question}</p>
      {children}
    </section>
  )
}

function Bars({ data }: { data: Array<{ label: string; share: number }> }) {
  return (
    <div style={{ display: 'grid', gap: 6, marginTop: 14 }}>
      {data.map((d) => (
        <div key={d.label} style={{ display: 'grid', gridTemplateColumns: 'minmax(90px, 140px) 1fr 56px', gap: 8, alignItems: 'center', fontSize: 'var(--fs-sm)' }}>
          <span style={{ color: 'var(--muted)' }}>{d.label}</span>
          <span style={{ height: 8, borderRadius: 4, background: 'var(--border)', overflow: 'hidden' }}>
            <span style={{ display: 'block', height: '100%', width: `${Math.min(100, d.share * 100)}%`, background: 'var(--brand)' }} />
          </span>
          <span style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{fmtPct(d.share, 0)}</span>
        </div>
      ))}
    </div>
  )
}

/** Attempts per bucket with the startup p95 line: enough to see a spike, not a charting library. */
function Trend({ s }: { s: Series }) {
  const w = 640, h = 120, pts = s.points
  if (pts.length < 2) return <p style={{ color: 'var(--faint)', fontSize: 'var(--fs-sm)', margin: 0 }}>Not enough data for a trend in this period yet.</p>
  const maxA = Math.max(1, ...pts.map((p) => p.attempts)), maxS = Math.max(1, ...pts.map((p) => p.startupP95 ?? 0))
  const x = (i: number) => (i / (pts.length - 1)) * (w - 8) + 4
  const line = (vals: Array<number | null>, max: number) => vals.map((v, i) => (v == null ? '' : `${i === 0 || vals[i - 1] == null ? 'M' : 'L'}${x(i).toFixed(1)},${(h - 6 - (v / max) * (h - 16)).toFixed(1)}`)).join(' ')
  return (
    <div>
      <svg viewBox={`0 0 ${w} ${h}`} width="100%" height={h} preserveAspectRatio="none" role="img" aria-label="Attempts and startup time p95 over the period">
        <path d={line(pts.map((p) => p.attempts), maxA)} fill="none" stroke="var(--brand)" strokeWidth="2" vectorEffect="non-scaling-stroke" />
        <path d={line(pts.map((p) => p.startupP95), maxS)} fill="none" stroke="var(--warn)" strokeWidth="2" strokeDasharray="4 3" vectorEffect="non-scaling-stroke" />
      </svg>
      <div className="flex flex-wrap gap-3" style={{ fontSize: 'var(--fs-micro)', color: 'var(--muted)' }}>
        <span><span style={{ display: 'inline-block', width: 12, height: 2, background: 'var(--brand)', verticalAlign: 'middle', marginRight: 6 }} />Play attempts (peak {fmtInt(maxA)})</span>
        <span><span style={{ display: 'inline-block', width: 12, height: 2, background: 'var(--warn)', verticalAlign: 'middle', marginRight: 6 }} />Startup time p95 (peak {fmtMs(maxS)})</span>
        {s.ignoredFilters.length > 0 && <span>The trend is not filtered by {s.ignoredFilters.join(', ')}: minute data keeps content, live or on demand, country, device class and CDN.</span>}
      </div>
    </div>
  )
}

function Table({ head, rows }: { head: string[]; rows: Array<Array<React.ReactNode>> }) {
  return (
    <div style={{ overflowX: 'auto', marginTop: 14 }}>
      <table>
        <thead><tr>{head.map((x) => <th key={x}>{x}</th>)}</tr></thead>
        <tbody>{rows.map((r, i) => <tr key={i}>{r.map((c, j) => <td key={j} style={j ? { fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' } : undefined}>{c}</td>)}</tr>)}</tbody>
      </table>
    </div>
  )
}

export default function PlaybackReports() {
  const [hours, setHours] = useState(24)
  const [filters, setFilters] = useState<Record<string, string>>({})
  const [d, setD] = useState<QoeOverview | null>(null)
  const [series, setSeries] = useState<Series | null>(null)
  const [dims, setDims] = useState<Record<string, Array<{ value: string | null; views: number }>>>({})
  const [defs, setDefs] = useState<any>(null)
  const [by, setBy] = useState('device_model')
  const [measure, setMeasure] = useState('failure')
  const [minViews, setMinViews] = useState(20)
  const [bd, setBd] = useState<Breakdown | null>(null)
  const [problem, setProblem] = useState('error')
  const [sessions, setSessions] = useState<SessionRow[] | null>(null)
  const [timeline, setTimeline] = useState<Timeline | null>(null)
  const [openErr, setOpenErr] = useState('')
  const [err, setErr] = useState('')
  const [funnel, setFunnel] = useState<Funnel | null>(null)
  const [disc, setDisc] = useState<Discovery | null>(null)
  const [discBy, setDiscBy] = useState<'entry' | 'detail'>('entry')

  const qs = useMemo(() => {
    const p = new URLSearchParams({ hours: String(hours) })
    for (const [k, v] of Object.entries(filters)) if (v) p.set(k, v)
    return p.toString()
  }, [hours, filters])

  async function load() {
    try {
      const [o, s] = await Promise.all([apiRequest(`/analytics/qoe/overview?${qs}`), apiRequest(`/analytics/qoe/series?${qs}`)])
      setD(o); setSeries(s); setErr('')
    } catch (e: any) { setErr(e.message) }
  }
  useEffect(() => { load() /* eslint-disable-next-line */ }, [qs])
  useEffect(() => { apiRequest(`/analytics/qoe/dimensions?hours=${hours}`).then(setDims).catch(() => {}) }, [hours])
  useEffect(() => { apiRequest('/analytics/qoe/definitions').then(setDefs).catch(() => {}) }, [])
  useEffect(() => { apiRequest(`/analytics/qoe/journeys?${qs}`).then(setFunnel).catch(() => setFunnel(null)) }, [qs])
  useEffect(() => { apiRequest(`/analytics/qoe/discovery?${qs}&by=${discBy}`).then(setDisc).catch(() => setDisc(null)) }, [qs, discBy])
  useEffect(() => {
    apiRequest(`/analytics/qoe/breakdown?${qs}&by=${by}&measure=${measure}&minViews=${minViews}`).then(setBd).catch(() => setBd(null))
  }, [qs, by, measure, minViews])
  useEffect(() => {
    apiRequest(`/analytics/qoe/sessions?${qs}&problem=${problem}&limit=25`).then((r: any) => setSessions(r.items)).catch(() => setSessions(null))
  }, [qs, problem])
  async function openSession(sid: string) {
    try {
      setOpenErr(''); setTimeline(await apiRequest(`/analytics/qoe/sessions/${encodeURIComponent(sid)}`))
      setTimeout(() => document.getElementById('qoe-timeline')?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 50)
    }
    catch (e: any) { setOpenErr(e.message); setTimeline(null) }
  }

  usePageNotice('qoe', err && d ? { kind: 'error', title: "Couldn't load playback reports.", message: err, actions: [{ label: 'Retry', onClick: () => { load() } }] } : null)
  if (err && !d) return <PageError message={err} onRetry={() => load()} />
  if (!d) return <div className="loading">Loading playback reports…</div>

  const s = d.success, st = d.startup, b = d.buffering, q = d.quality, e = d.engagement, t = d.telemetry
  const rd = d.rendering, ac = d.access, lv = d.live, ad = d.ads, dl = d.delivery
  const m = MEASURES.find((x) => x.key === measure)!
  const active = Object.entries(filters).filter(([, v]) => v)
  // The CDN's edge logs count players that send no reports, so they alone can fill the page.
  const nothing = s.attempts === 0 && e.views === 0 && !(dl && dl.requests > 0)

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Analytics</h1>
          <p>What viewers actually saw, from the player's own reports. Counted per play attempt, from the moment play is pressed.</p>
        </div>
        <div className="spacer" />
        <div className="flex flex-wrap items-center gap-2">
          <AnalyticsViewSwitch view="playback" />
          {PERIODS.map((p) => (
            <button key={p.h} className={`btn ${hours === p.h ? 'primary' : 'ghost'}`} style={{ padding: '3px 10px', fontSize: 'var(--fs-sm)' }} onClick={() => setHours(p.h)}>{p.label}</button>
          ))}
          <button className="btn ghost" onClick={() => load()}>Refresh</button>
        </div>
      </div>

      <section className="card p-4" style={{ marginBottom: 16 }} aria-label="Filters">
        <div className="flex items-center gap-2" style={{ marginBottom: 10 }}><Icon d={Ic.filter} /><h3 style={{ margin: 0 }}>Filters</h3>
          <div className="spacer" />
          {active.length > 0 && <button className="btn ghost" style={{ padding: '3px 10px', fontSize: 'var(--fs-sm)' }} onClick={() => setFilters({})}>Clear filters</button>}
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))', gap: 10 }}>
          {FILTERS.map((f) => {
            const vals = dims[f.key] ?? []
            return (
              <label key={f.key} style={{ display: 'grid', gap: 4, fontSize: 'var(--fs-sm)', color: 'var(--muted)', minWidth: 0 }}>
                {f.label}
                <select value={filters[f.key] ?? ''} onChange={(ev) => setFilters({ ...filters, [f.key]: ev.target.value })} disabled={!vals.length && !filters[f.key]} style={{ minWidth: 0 }}>
                  <option value="">All</option>
                  {vals.map((v) => <option key={v.value ?? '__none'} value={v.value ?? '__none'}>{f.key === 'entry_point' ? entryLabel(v.value) : valueLabel(v.value == null ? null : String(v.value))} ({fmtInt(v.views)})</option>)}
                </select>
              </label>
            )
          })}
        </div>
      </section>

      {nothing ? (
        <div className="card p-4" style={{ marginBottom: 16 }}>
          <h3>No playback reports in this period{active.length ? ' for these filters' : ''}</h3>
          <p style={{ color: 'var(--muted)', margin: 0 }}>Players built on the Volt SDK with <code>cmcd</code> on send their reports to <code>POST /api/cmcd</code>. They appear here within a minute.</p>
        </div>
      ) : (
        <>
          {series && <section className="card p-4" style={{ marginBottom: 16 }} aria-label="Trend"><Trend s={series} /></section>}

          <Report icon={Ic.play} title="Playback success" question="Can viewers actually watch?">
            <div style={statGrid}>
              <Stat label="Play attempts" value={fmtInt(s.attempts)} sub={`${fmtInt(s.sessions)} sessions`} />
              <Stat label="Startup success" value={fmtPct(s.startupSuccess)} sub={`${fmtInt(s.started)} reached a first frame`} tone={s.startupSuccess != null && s.startupSuccess < 0.95 ? 'var(--warn)' : undefined} />
              <Stat label="Startup failures" value={fmtPct(s.startupFailureRate)} sub={`${fmtInt(s.startupFailures)} attempts, ${fmtInt(s.failedSessions)} sessions`} tone={s.startupFailures ? 'var(--down)' : undefined} />
              <Stat label="Exit before first frame" value={fmtPct(s.ebffRate)} sub={`${fmtInt(s.exitsBeforeFirstFrame)} left without an error`} />
              <Stat label="Failure after start" value={fmtPct(s.failureAfterStartRate)} sub={`${fmtInt(s.fatalAfterStart)} of the started views`} tone={s.fatalAfterStart ? 'var(--down)' : undefined} />
            </div>
            {s.exitsBeforeFirstFrame > 0 && <Bars data={[
              { label: 'Left within 2 s', share: s.ebffByWait.under2s / s.exitsBeforeFirstFrame }, { label: '2 to 5 s', share: s.ebffByWait.from2to5s / s.exitsBeforeFirstFrame },
              { label: '5 to 10 s', share: s.ebffByWait.from5to10s / s.exitsBeforeFirstFrame }, { label: 'After 10 s', share: s.ebffByWait.over10s / s.exitsBeforeFirstFrame },
            ]} />}
            {s.errors.length > 0 && <Table head={['When', 'Step', 'Code', 'Views', 'Sessions']} rows={s.errors.map((x) => [x.phase === 'before_start' ? 'Before the first frame' : 'After the start', x.step ?? '–', <code key="c">{x.code ?? '–'}</code>, fmtInt(x.views), fmtInt(x.sessions)])} />}
          </Report>

          <Report icon={Ic.clock} title="Startup" question="Why does playback start slowly? Play pressed to the first frame on screen, for the views that started.">
            <div style={statGrid}>
              <Stat label="p50" value={fmtMs(st.startup.p50)} sub={`${fmtInt(st.views)} views`} />
              <Stat label="p95" value={fmtMs(st.startup.p95)} />
              <Stat label="p99" value={fmtMs(st.startup.p99)} />
              <Stat label="Waited 2 s or more" value={fmtInt(st.slowSessions)} sub="sessions" />
            </div>
            <Table head={['Step', 'p50', 'p95', 'p99', 'Average', 'Views']} rows={st.breakdown.map((x) => [x.span === 'drm' ? 'DRM licence' : x.span === 'segment' ? 'First segment' : x.span[0].toUpperCase() + x.span.slice(1), fmtMs(x.p50), fmtMs(x.p95), fmtMs(x.p99), fmtMs(x.avg), fmtInt(x.views)])} />
          </Report>

          <Report icon={Ic.pause} title="Buffering and interruptions" question="How often is viewing interrupted? Startup, seeking, pauses and background time are left out.">
            <div style={statGrid}>
              <Stat label="Views with stalls" value={fmtPct(b.viewsWithStallsRate)} sub={`${fmtInt(b.viewsWithStalls)} views, ${fmtInt(b.stalledSessions)} sessions`} tone={b.viewsWithStalls ? 'var(--warn)' : undefined} />
              <Stat label="Rebuffer ratio" value={fmtPct(b.rebufferRatio, 2)} sub={`per view p95 ${fmtPct(b.rebufferRatioPerView.p95, 2)}`} />
              <Stat label="Stalls per hour" value={fmtRate(b.stallsPerHour)} sub={`${fmtInt(b.stalls)} stalls, average ${fmtMs(b.avgStallMs)}`} />
              <Stat label="Time to first stall" value={fmtMs(b.timeToFirstStall.p50)} sub={`p50; p95 ${fmtMs(b.timeToFirstStall.p95)}`} />
              <Stat label="Seek delay" value={fmtMs(b.avgSeekMs)} sub={`average over ${fmtInt(b.seeks)} seeks`} />
            </div>
          </Report>

          <Report icon={Ic.layers} title="Quality and adaptive bitrate" question="Is the player choosing a quality it can sustain?">
            <div style={statGrid}>
              <Stat label="Time-weighted bitrate" value={fmtKbps(q.timeWeightedKbps)} sub={`per view p50 ${fmtKbps(q.perViewKbps.p50)}`} />
              <Stat label="Below what the screen can use" value={fmtPct(q.belowScreenShare)} sub="of playing time" />
              <Stat label="Switches per hour" value={fmtRate(q.switchesPerHour)} sub={`oscillations ${fmtRate(q.oscillationsPerHour)} per hour`} />
              <Stat label="Buffer and throughput" value={q.avgBufferMs == null ? '–' : fmtMs(q.avgBufferMs)} sub={`average; throughput ${fmtKbps(q.avgThroughputKbps)}`} />
            </div>
            {q.timeAtBitrate.length > 0 && <Bars data={q.timeAtBitrate.map((x) => ({ label: x.band, share: x.share }))} />}
          </Report>

          {rd && (
            <Report icon={Ic.monitor} title="Rendering and devices" question="Does it look smooth even when delivery is fine? Dropped frames while playing, decoder errors, and how the device decodes.">
              <div style={statGrid}>
                <Stat label="Dropped frames" value={rd.droppedPerMinute == null ? '–' : `${fmtRate(rd.droppedPerMinute)} / min`} sub={`of playing time; per view p95 ${rd.perViewDroppedPerMinute.p95 == null ? '–' : fmtRate(rd.perViewDroppedPerMinute.p95)}`} tone={rd.droppedPerMinute != null && rd.droppedPerMinute > 30 ? 'var(--warn)' : undefined} />
                <Stat label="Views with dropped frames" value={fmtInt(rd.viewsWithDrops)} sub={`of ${fmtInt(rd.viewsReportingFrames)} reporting frames`} />
                <Stat label="Decoder errors" value={fmtInt(rd.decodeErrors)} sub={`in ${pl(rd.viewsWithDecodeErrors, 'view')}, ${fmtInt(rd.decodeFatal)} stopped playback`} tone={rd.decodeFatal ? 'var(--down)' : undefined} />
                <Stat label="Hardware decoding" value={rd.hardwareDecode.yes + rd.hardwareDecode.no ? fmtPct(rd.hardwareDecode.yes / (rd.hardwareDecode.yes + rd.hardwareDecode.no), 0) : '–'} sub={`${pl(rd.hardwareDecode.no, 'view')} decoded in software`} />
                <Stat label="DRM system" value={rd.keySystems[0] ? keySystemName(rd.keySystems[0].keySystem) : 'None'} sub={rd.keySystems.length ? rd.keySystems.map((k) => `${keySystemName(k.keySystem)} in ${pl(k.views, 'view')}`).join(', ') : 'no protected views'} />
              </div>
              {rd.byDevice.length > 0 && <Table head={['Device', 'Dropped per minute', 'Decoder errors', 'Views']} rows={rd.byDevice.map((x) => [x.device ?? 'Not reported', x.droppedPerMinute == null ? '–' : fmtRate(x.droppedPerMinute), fmtInt(x.decodeErrors), fmtInt(x.views)])} />}
            </Report>
          )}

          {ac && (
            <Report icon={Ic.lock} title="Access and DRM" question="Are access checks or DRM blocking playback? The play gate's decisions by session, and licence requests from the player.">
              <div style={statGrid}>
                <Stat label="Refused at the gate" value={fmtPct(ac.gate.deniedShare)} sub={`${fmtInt(ac.gate.denied)} of ${fmtInt(ac.gate.decisions)} decisions`} tone={ac.gate.denied ? 'var(--warn)' : undefined} />
                <Stat label="Gate time" value={fmtMs(ac.gate.timeMs.p50)} sub={`p50 on the server; p95 ${fmtMs(ac.gate.timeMs.p95)}`} />
                <Stat label="Licence time" value={fmtMs(ac.licence.startupSpanMs.p50)} sub={`p50 of the startup; p95 ${fmtMs(ac.licence.startupSpanMs.p95)}`} />
                <Stat label="Licence failures" value={fmtInt(ac.licence.failures)} sub={`of ${pl(ac.licence.requests, 'request')}; ${pl(ac.licence.failedBeforeStart, 'view')} never started`} tone={ac.licence.failures ? 'var(--down)' : undefined} />
                <Stat label="Token refused mid-view" value={fmtInt(ac.tokenErrors.views)} sub="views (401 or 403 after the start)" tone={ac.tokenErrors.views ? 'var(--warn)' : undefined} />
              </div>
              {ac.gate.reasons.length > 0 && <Table head={['Gate decision', 'Answer', 'Decisions', 'Sessions']} rows={ac.gate.reasons.map((x) => [GATE_REASON[x.reason] ?? x.reason, String(x.status), fmtInt(x.decisions), fmtInt(x.sessions)])} />}
              {ac.failures.length > 0 && <Table head={['Failed at', 'Code', 'Why, from the gate', 'When', 'Views']} rows={ac.failures.map((x) => [STEP[x.step] ?? x.step, <code key="c">{x.code ?? '–'}</code>, x.gateReason ? GATE_REASON[x.gateReason] ?? x.gateReason : '–', x.phase === 'before_start' ? 'Before the first frame' : 'After the start', fmtInt(x.views)])} />}
            </Report>
          )}

          {lv && lv.views > 0 && (
            <Report icon={Ic.live} title="Live streams" question="Are viewers live, stable and close to the live edge? Latency is how far behind live the player is; drift is how much that grew during a view.">
              <div style={statGrid}>
                <Stat label="Behind live" value={fmtMs(lv.latencyMs.p50)} sub={`p50; p95 ${fmtMs(lv.latencyMs.p95)}, highest ${fmtMs(lv.highestLatencyMs)}`} />
                <Stat label="Drift during a view" value={fmtMs(lv.driftMs.p95)} sub={`p95; average ${fmtMs(lv.driftMs.avg)}`} tone={lv.driftMs.p95 != null && lv.driftMs.p95 > 5000 ? 'var(--warn)' : undefined} />
                <Stat label="Drifted over 5 s" value={fmtInt(lv.viewsDriftedOver5s)} sub={`views, in ${pl(lv.driftedSessions, 'session')}`} />
                <Stat label="Catching up" value={fmtPct(lv.catchUpShare)} sub="of playing time faster than 1x" />
              </div>
              {lv.byDevice.length > 0 && <Table head={['Device', 'Behind live (average)', 'p95', 'Drift (average)', 'Catching up', 'Views']} rows={lv.byDevice.map((x) => [x.deviceModel ?? x.deviceClass ?? 'Not reported', fmtMs(x.latencyAvgMs), fmtMs(x.latencyP95Ms), fmtMs(x.driftAvgMs), fmtPct(x.catchUpShare), fmtInt(x.views)])} />}
            </Report>
          )}

          {ad && ad.breaks > 0 && (
            <Report icon={Ic.ad} title="Advertising" question="Are ads hurting playback or revenue? Time in a break is the ad's, so it is not in the buffering and quality figures above.">
              <div style={statGrid}>
                <Stat label="Ads played" value={fmtInt(ad.adsStarted)} sub={ad.adsStarted ? `${fmtInt(ad.adsEnded)} watched to the end (${fmtPct(ad.adCompletion)})` : 'none reported by a player yet'} />
                <Stat label="Breaks watched to the end" value={fmtPct(ad.breakCompletion)} sub={`${fmtInt(ad.breaksCompleted)} of ${fmtInt(ad.breaks)}; average ${fmtMs(ad.avgBreakMs)}`} />
                <Stat label="Ad startup" value={fmtMs(ad.adStartupMs.avg)} sub={`average; p95 ${fmtMs(ad.adStartupMs.p95)}`} />
                <Stat label="Ad buffering" value={fmtPct(ad.adRebufferRatio, 2)} sub={`${pl(ad.adStalls, 'stall')} in ${pl(ad.viewsWithAdStalls, 'view')}`} tone={ad.adStalls ? 'var(--warn)' : undefined} />
                <Stat label="Back to the programme" value={fmtMs(ad.returnToContentMs.avg)} sub={`average; p95 ${fmtMs(ad.returnToContentMs.p95)}`} />
                <Stat label="Left during an ad" value={fmtInt(ad.leftDuringAd)} sub={`views, in ${pl(ad.leftDuringAdSessions, 'session')}`} tone={ad.leftDuringAd ? 'var(--warn)' : undefined} />
              </div>
              {ad.server && ad.server.impressions + ad.server.failed > 0 && (
                <p style={{ margin: '14px 0 0', color: 'var(--muted)', fontSize: 'var(--fs-sm)' }}>
                  Server-side beacons sent by the stitcher: {fmtInt(ad.server.impressions)} impressions, {fmtInt(ad.server.firstQuartile)} first quartiles, {fmtInt(ad.server.midpoint)} midpoints, {fmtInt(ad.server.complete)} completes ({fmtPct(ad.serverCompletion, 0)}){ad.server.failed ? `, ${fmtInt(ad.server.failed)} failed to send` : ''}.
                </p>
              )}
            </Report>
          )}

          {dl && dl.requests > 0 && (
            <Report icon={Ic.globe} title="Delivery (CDN and origin)" question="Is delivery responsible? From the CDN's own logs of every request, sampled and counted as the whole, so players that send no reports are in it too. Filters other than content and country do not apply: the CDN does not know the device or app.">
              <div style={statGrid}>
                <Stat label="Requests" value={fmtInt(dl.requests)} sub={`from ${pl(dl.sampledLines, 'logged request')}`} />
                <Stat label="Errors" value={fmtPct(dl.errorRate, 2)} sub={`client ${fmtPct(dl.clientErrorRate, 2)}, server ${fmtPct(dl.serverErrorRate, 2)}`} tone={dl.errorRate != null && dl.errorRate > 0.01 ? 'var(--warn)' : undefined} />
                <Stat label="Cache hits" value={fmtPct(dl.cacheHitRatio)} sub={dl.originShieldShareOfMisses != null ? `Origin Shield answered ${fmtPct(dl.originShieldShareOfMisses, 0)} of the misses` : 'of requests answered from the edge'} />
                <Stat label="First byte at the edge" value={fmtMs(dl.edgeTtfbMs.p50)} sub={`p50; p95 ${fmtMs(dl.edgeTtfbMs.p95)}, p99 ${fmtMs(dl.edgeTtfbMs.p99)}`} />
                <Stat label="Origin on a miss" value={fmtMs(dl.originFirstByteMs.p50)} sub={`first byte p50; p95 ${fmtMs(dl.originFirstByteMs.p95)}`} />
                <Stat label="Segment delivery rate" value={fmtKbps(dl.segmentKbps.p50)} sub={`median; the slowest 5 % under ${fmtKbps(dl.segmentKbps.p5)}`} />
                <Stat label="Asked with an empty buffer" value={fmtPct(dl.starvedShare, 2)} sub="of requests from players that send CMCD" tone={dl.starvedShare != null && dl.starvedShare > 0.01 ? 'var(--warn)' : undefined} />
                {dl.lastMileMs.joinedRequests > 0 && <Stat label="Last mile" value={fmtMs(dl.lastMileMs.p50)} sub={`p50 of what the player waited beyond the edge; ${pl(dl.lastMileMs.joinedRequests, 'response')} matched`} />}
              </div>
              <p style={{ margin: '14px 0 0', color: 'var(--muted)', fontSize: 'var(--fs-sm)' }}>
                Seen at the CDN: {pl(dl.audience.sessions, 'session')}. {fmtInt(dl.audience.withTelemetry)} reported by their player; {fmtInt(dl.audience.withoutTelemetry)} sent no reports{dl.audience.withoutSessionId ? `, ${fmtInt(dl.audience.withoutSessionId)} of them without even a session id (a stream address opened in another player)` : ''}.
              </p>
              {dl.byObjectType.length > 0 && <Table head={['Requests for', 'Requests', 'Errors', 'First byte p50', 'p95', 'Time taken p95']} rows={dl.byObjectType.map((x) => [OBJECT[x.ot] ?? x.ot, fmtInt(x.requests), fmtPct(x.errorRate, 2), fmtMs(x.edgeTtfbMs.p50), fmtMs(x.edgeTtfbMs.p95), fmtMs(x.edgeTimeMs.p95)])} />}
              {dl.worst.length > 0 && <Table head={['Content', 'Country', 'Requests', 'Errors', 'First byte p95']} rows={dl.worst.map((x) => [x.contentId ? (e.byContent.find((c) => c.contentId === x.contentId)?.name ?? x.contentId) : 'Not known', x.country ?? 'Not known', fmtInt(x.requests), fmtPct(x.errorRate, 2), fmtMs(x.edgeTtfbP95Ms)])} />}
            </Report>
          )}

          <Report icon={Ic.users} title="Engagement and abandonment" question="How does quality relate to retention? Views counted by when they started.">
            <div style={statGrid}>
              <Stat label="Playing time" value={`${e.playingHours >= 10 ? Math.round(e.playingHours).toLocaleString() : e.playingHours.toFixed(2)} h`} sub={`average ${fmtMs(e.avgPlayingMs)} per started view`} />
              <Stat label="Left after a stall" value={fmtInt(e.exitAfterStall)} sub={`${fmtPct(e.leftAfterStallShare)} of the views that stalled`} tone={e.exitAfterStall ? 'var(--warn)' : undefined} />
              <Stat label="Left after an error" value={fmtInt(e.exitAfterError)} sub="within 30 s" />
              <Stat label="Exit before first frame" value={fmtPct(e.ebffRate)} />
            </div>
            {e.byContent.length > 0 && <Table head={['Content', 'Views', 'Playing hours', 'Stalled', 'Left after a problem']} rows={e.byContent.map((c) => [c.name ?? valueLabel(c.contentId), fmtInt(c.views), c.playingHours.toFixed(2), fmtPct(c.stalledShare), fmtInt(c.leftAfterProblem)])} />}
          </Report>

          <Report icon={Ic.route} title="Journey to play" question="Where do viewers give up between opening the app and the first frame? App sessions that opened in the period; a session counts at a step when it got there or further.">
            {!funnel || funnel.sessions === 0
              ? <p style={{ color: 'var(--faint)', fontSize: 'var(--fs-sm)', margin: 0 }}>No app sessions in this period. Apps built on the Volt SDK send them with <code>VoltJourney</code> (journey to play), once the viewer's consent allows it.</p>
              : <>
                  <div style={statGrid}>
                    <Stat label="App sessions" value={fmtInt(funnel.sessions)} sub={funnel.truncated ? 'the first 200,000 in the period' : undefined} />
                    <Stat label="Reached a first frame" value={fmtPct(funnel.steps[funnel.steps.length - 1].rate)} sub={`${fmtInt(funnel.steps[funnel.steps.length - 1].sessions)} sessions`} />
                    <Stat label="App open to first frame" value={fmtMs(funnel.openToFirstFrame.p50)} sub={`p50; p95 ${fmtMs(funnel.openToFirstFrame.p95)}`} />
                    <Stat label="Left at the paywall" value={fmtInt(funnel.paywall.abandoned)} sub={`of ${pl(funnel.paywall.shown, 'session')} shown one; ${fmtInt(funnel.paywall.purchased)} bought`} tone={funnel.paywall.abandoned ? 'var(--warn)' : undefined} />
                    <Stat label="Refused by the gate" value={fmtInt(funnel.refusedByGate)} sub="sessions (geo, rights, sign in, ...)" />
                  </div>
                  <Bars data={funnel.steps.map((x) => ({ label: FUNNEL_LABEL[x.step] ?? x.step, share: x.rate ?? 0 }))} />
                  <Table head={['Step', 'Sessions', 'Left here', 'Of the step before', 'Reached after (p50)', 'p95']} rows={funnel.steps.map((x, i) => [
                    FUNNEL_LABEL[x.step] ?? x.step, fmtInt(x.sessions), i ? fmtInt(x.dropOff) : '–', i ? fmtPct(x.fromPrevious) : '–', i ? fmtMs(x.msSinceOpen.p50) : '–', i ? fmtMs(x.msSinceOpen.p95) : '–'])} />
                </>}
          </Report>

          <Report icon={Ic.route} title="Where plays come from" question="Which rows, searches, links and notifications lead to watching, and how well those plays went. Journeys counted by when the viewer picked the title.">
            <div className="flex flex-wrap gap-2">
              <button className={`btn ${discBy === 'entry' ? 'primary' : 'ghost'}`} style={{ padding: '3px 10px', fontSize: 'var(--fs-sm)' }} onClick={() => setDiscBy('entry')}>By entry point</button>
              <button className={`btn ${discBy === 'detail' ? 'primary' : 'ghost'}`} style={{ padding: '3px 10px', fontSize: 'var(--fs-sm)' }} onClick={() => setDiscBy('detail')}>By row or campaign</button>
            </div>
            {disc && disc.rows.length > 0
              ? <Table head={['Came from', 'Journeys', 'Played', 'Started', 'Watch time', 'Completed', 'Startup p50', 'Rebuffer ratio']} rows={disc.rows.map((r) => [
                  discBy === 'detail' && r.detail ? `${entryLabel(r.entry)}: ${r.detail}` : entryLabel(r.entry), fmtInt(r.journeys), fmtPct(r.playRate), fmtPct(r.startRate),
                  fmtMs(r.watchMs), fmtPct(r.completion), fmtMs(r.startupP50), fmtPct(r.rebufferRatio, 2)])} />
              : <p style={{ color: 'var(--faint)', fontSize: 'var(--fs-sm)', margin: '12px 0 0' }}>No journeys in this period.</p>}
            {disc && disc.neverPlayed.some((x) => x.neverPlayed > 0) && <>
              <h4 style={{ margin: '18px 0 0' }}>Viewed, never played</h4>
              <Table head={['Title', 'Detail page views', 'App sessions', 'Played in', 'Not played']} rows={disc.neverPlayed.filter((x) => x.neverPlayed > 0).map((x) => [
                x.contentName ?? x.contentId, fmtInt(x.detailViews), fmtInt(x.sessions), fmtInt(x.playedIn), fmtInt(x.neverPlayed)])} />
            </>}
          </Report>

          <Report icon={Ic.bars} title="Worst segments" question="Which device, app release, network or place is worse than the rest? Only values with enough views to mean something are ranked.">
            <div className="flex flex-wrap items-end gap-3">
              <label style={{ display: 'grid', gap: 4, fontSize: 'var(--fs-sm)', color: 'var(--muted)' }}>By
                <select value={by} onChange={(ev) => setBy(ev.target.value)}>{FILTERS.map((f) => <option key={f.key} value={f.key}>{f.label}</option>)}</select>
              </label>
              <label style={{ display: 'grid', gap: 4, fontSize: 'var(--fs-sm)', color: 'var(--muted)' }}>Ranked by
                <select value={measure} onChange={(ev) => setMeasure(ev.target.value)}>{MEASURES.map((x) => <option key={x.key} value={x.key}>{x.label}</option>)}</select>
              </label>
              <label style={{ display: 'grid', gap: 4, fontSize: 'var(--fs-sm)', color: 'var(--muted)' }}>At least
                <select value={minViews} onChange={(ev) => setMinViews(Number(ev.target.value))}>{[1, 10, 20, 100, 1000].map((x) => <option key={x} value={x}>{x} views</option>)}</select>
              </label>
            </div>
            {bd && bd.rows.length > 0
              ? <Table head={[FILTERS.find((f) => f.key === by)?.label ?? by, m.label, 'Views', 'Sessions affected']} rows={bd.rows.map((r) => [r.name ?? valueLabel(r.value), fmtMeasure(m.kind, r.measure), fmtInt(r.views), fmtInt(r.affected)])} />
              : <p style={{ color: 'var(--faint)', fontSize: 'var(--fs-sm)', margin: '12px 0 0' }}>No value has {minViews} views or more in this period.</p>}
          </Report>

          <Report icon={Ic.list} title="Sessions" question="The views behind these numbers, newest first. Open one to see everything that happened to that viewer, in order.">
            <div className="flex flex-wrap gap-2">
              {PROBLEMS.map((x) => <button key={x.key} className={`btn ${problem === x.key ? 'primary' : 'ghost'}`} style={{ padding: '3px 10px', fontSize: 'var(--fs-sm)' }} onClick={() => setProblem(x.key)}>{x.label}</button>)}
            </div>
            {sessions && sessions.length > 0
              ? <Table head={['', 'What happened', 'Content', 'Device', 'Ended']} rows={sessions.map((x) => [
                  <button key="o" className="btn ghost" style={{ padding: '2px 10px', fontSize: 'var(--fs-sm)' }} onClick={() => openSession(x.sid)} aria-label={`Open the timeline of session ${x.sid}`}>
                    <span className="flex items-center gap-2"><Icon d={Ic.list} />Timeline</span></button>,
                  x.outcome === 'failed' ? `Failed at ${STEP[x.errorStep ?? ''] ?? x.errorStep ?? '?'} (${x.errorCode ?? 'no code'})` : x.outcome === 'exited' ? 'Left before the first frame'
                    : x.fatalAfterStart ? `Stopped by ${x.errorCode ?? 'an error'}` : x.leftInAd ? 'Left during an ad' : `${pl(x.stalls, 'stall')}, started in ${fmtMs(x.startupMs)}${x.adsStarted ? `, ${pl(x.adsStarted, 'ad')}` : ''}`,
                  x.contentName ?? valueLabel(x.contentId), [x.device, x.country].filter(Boolean).join(', ') || '–', new Date(x.endedAt).toLocaleString(),
                ])} />
              : <p style={{ color: 'var(--faint)', fontSize: 'var(--fs-sm)', margin: '12px 0 0' }}>No sessions like this in the period.</p>}
            {openErr && <p style={{ color: 'var(--down)', fontSize: 'var(--fs-sm)', margin: '12px 0 0' }}>Couldn't open that session: {openErr}</p>}
          </Report>

          {timeline && <SessionTimeline t={timeline} onClose={() => setTimeline(null)} />}

          <Report icon={Ic.pulse} title="Telemetry health" question="Can these numbers be trusted? Reports lost, late or refused, and keys the collector does not know.">
            <div style={statGrid}>
              <Stat label="Reports lost" value={fmtPct(t.eventLoss, 2)} sub={`${fmtInt(t.missingReports)} missing in ${fmtInt(t.viewsWithLoss)} views`} tone={t.eventLoss != null && t.eventLoss > 0.01 ? 'var(--warn)' : undefined} />
              <Stat label="Late reports" value={fmtPct(t.lateShare, 2)} sub={`${fmtInt(t.lateReports)} arrived over 60 s after they were made`} />
              <Stat label="Refused by the collector" value={fmtPct(t.collector.rejectedShare, 2)} sub={`${fmtInt(t.collector.rejected)} of ${fmtInt(t.collector.accepted + t.collector.rejected)} lines`} />
              <Stat label="Device clock skew" value={fmtMs(t.clockSkewMs.p50)} sub={`p50; p95 ${fmtMs(t.clockSkewMs.p95)}`} />
              <Stat label="Without a sequence" value={fmtInt(t.viewsWithoutSequence)} sub="views (players other than the Volt SDK)" />
              {t.coverage && <Stat label="Reporting coverage" value={fmtPct(t.coverage.share)} sub={`${fmtInt(t.coverage.withTelemetry)} of ${pl(t.coverage.cdnSessions, 'session')} seen at the CDN reported`} tone={t.coverage.share != null && t.coverage.share < 0.9 ? 'var(--warn)' : undefined} />}
            </div>
            {(Object.keys(t.collector.reasons).length > 0 || t.unknownKeys.length > 0) && (
              <Table head={['What', 'Count']} rows={[
                ...Object.entries(t.collector.reasons).map(([k, v]) => [`Refused: ${k}`, fmtInt(v)]),
                ...t.unknownKeys.map((k) => [<span key={k.key}>Unknown key <code>{k.key}</code></span>, fmtInt(k.reports)]),
              ]} />
            )}
          </Report>
        </>
      )}

      {defs && (
        <details className="card p-4" style={{ marginBottom: 16 }}>
          <summary style={{ cursor: 'pointer' }}>How these are measured (definitions version {defs.version})</summary>
          <p style={{ color: 'var(--muted)', fontSize: 'var(--fs-sm)' }}>{defs.view} {defs.windows} {defs.states}</p>
          <dl style={{ display: 'grid', gridTemplateColumns: 'minmax(0, max-content) minmax(0, 1fr)', gap: '6px 16px', fontSize: 'var(--fs-sm)', margin: 0 }}>
            {Object.entries(defs.measures as Record<string, string>).map(([k, v]) => (
              <div key={k} style={{ display: 'contents' }}><dt style={{ color: 'var(--text)' }}>{k.replace(/([A-Z])/g, ' $1').toLowerCase()}</dt><dd style={{ margin: 0, color: 'var(--muted)', overflowWrap: 'anywhere' }}>{v}</dd></div>
            ))}
          </dl>
        </details>
      )}
    </>
  )
}
