// Typed client for the Volt control-plane API (same-origin via the Vite proxy).
import { setImageSigning, imageSigning, signImage } from './imageSigning'
import { showGlobal, dismissGlobal } from './notices'

/* ============================================================================
 *  THE SESSION, AND WHY IT USED TO END EVERY FIFTEEN MINUTES.
 *
 *  The control plane issues a short access token AND a fourteen-day refresh
 *  token, stores the refresh token's hash, and exposes POST /auth/refresh to
 *  exchange it. All of that worked. Nothing in the console ever called it: the
 *  sign-in screen read `r.access` and dropped `r.refresh` on the floor, and the
 *  only 401 handling anywhere was `token = ''` followed by a bounce to the
 *  login form.
 *
 *  So session length was ACCESS_TTL of WALL CLOCK, and nothing an operator did
 *  could extend it. Fifteen minutes into a broadcast, mid-edit, signed out.
 *
 *  WHAT REPLACES IT, and the three things that make it safe:
 *
 *  SINGLE FLIGHT. This console fires a lot of concurrent requests -- the level
 *  poll every four seconds, the live board, the station list. When the access
 *  token lapses they do not fail one at a time, they all fail at once, and a
 *  refresh per failure would be a stampede against an endpoint that ROTATES the
 *  token: the first response invalidates the credential the other nine are
 *  still holding, and the operator is signed out by the fix. One shared promise;
 *  everybody waits on the same exchange.
 *
 *  RETRY ONCE, NEVER LOOP. A 401 triggers at most one refresh-and-retry per
 *  request. If the retry is refused too then the session really is over, and
 *  saying so once beats a page that reloads itself forever.
 *
 *  THE REFRESH TOKEN LIVES IN MEMORY, exactly where the access token already
 *  lived. Persisting it would keep a session across a page reload, which is
 *  worth having and is a DIFFERENT decision with a different risk: anything in
 *  localStorage is readable by any script that gets onto the page. Not smuggled
 *  in under a bug fix.
 *
 *  IDLE IS NOT ACTIVITY, and that distinction matters here more than in most
 *  apps, because this console polls whether or not a human is present. A tab
 *  left open overnight generates constant traffic; treating that as "the
 *  operator is working" would renew the session until the fourteen-day cap. So
 *  the PROACTIVE refresh -- the one that keeps a working session from ever
 *  seeing a 401 -- is gated on real user input. The REACTIVE one is not:
 *  whatever a page was doing when the token lapsed, coming back and clicking
 *  must work rather than dump the operator at a login screen.
 * ========================================================================= */
let token = ''
let refreshToken = ''
/** Epoch ms when the current access token expires. 0 = unknown. */
let accessExpiresAt = 0
/** Last real user input. Deliberately NOT updated by API traffic. */
let lastInputAt = Date.now()

/** Renew this long before expiry, so a request never races the boundary. */
const REFRESH_LEAD_MS = 60_000
/** Proactive refresh only if the operator did something within this window. */
const ACTIVE_WINDOW_MS = 10 * 60_000

export function setToken(t: string) { token = t }
export function getToken() { return token }

/** Called by the sign-in screen with the whole login response. */
export function setSession(s: { access: string; refresh?: string; expiresIn?: number }) {
  token = s.access
  if (s.refresh) refreshToken = s.refresh
  accessExpiresAt = s.expiresIn ? Date.now() + s.expiresIn * 1000 : 0
  lastInputAt = Date.now()
}

/** Seconds left on the access token (0 when unknown). Used to hand the
 *  session to the graphics live-control window, which never holds a refresh token. */
export function accessExpiresIn(): number { return accessExpiresAt ? Math.max(0, Math.floor((accessExpiresAt - Date.now()) / 1000)) : 0 }
export function clearSession() { token = ''; refreshToken = ''; accessExpiresAt = 0; platformToken = ''; platformExpiresAt = 0; setImageSigning(null); signingLoad = null }

/** The refresh token, for the logout call that revokes it server-side. */
export function getRefreshToken() { return refreshToken }

/** Mark real operator input. Wired to pointer and key events in App.tsx. */
export function noteActivity() { lastInputAt = Date.now() }
const activeRecently = () => Date.now() - lastInputAt < ACTIVE_WINDOW_MS

/** The shared in-flight exchange. See SINGLE FLIGHT above. */
let refreshing: Promise<boolean> | null = null

async function refreshAccess(): Promise<boolean> {
  if (!refreshToken) return false
  if (refreshing) return refreshing
  refreshing = (async () => {
    try {
      const r = await fetch('/api/auth/refresh', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ refresh: refreshToken }),
      })
      if (!r.ok) {
        // The server has REFUSED this credential: expired, revoked, or the user
        // disabled. It will not start working again, so drop it and let the
        // caller's 401 reach the sign-out handler.
        refreshToken = ''
        return false
      }
      const d = await r.json()
      if (!d?.access) { refreshToken = ''; return false }
      token = d.access
      // The server ROTATES, so the reply carries the next refresh token and the
      // one just sent is already revoked. Dropping it here would sign the
      // operator out at the FOLLOWING refresh rather than this one, which is
      // the kind of bug that presents as intermittent.
      if (d.refresh) refreshToken = d.refresh
      accessExpiresAt = d.expiresIn ? Date.now() + d.expiresIn * 1000 : 0
      return true
    } catch {
      // A dropped packet is not an expired session, so the refresh token is
      // KEPT and the next request tries again. Returning false only means this
      // attempt failed; the caller surfaces its original error.
      return false
    } finally {
      refreshing = null
    }
  })()
  return refreshing
}

/** Renew before the token lapses, but only for a console someone is using. */
async function refreshIfDueSoon() {
  if (!refreshToken || !accessExpiresAt) return
  if (Date.now() < accessExpiresAt - REFRESH_LEAD_MS) return
  if (!activeRecently()) return
  await refreshAccess()
}

/**
 * An API failure that still knows what KIND of failure it was.
 *
 * Every caller used to receive `new Error(String(status))`, so no page could
 * tell "your session expired" from "you are not allowed to do that" from "the
 * server broke" — and every page rendered whichever it got as a bare number.
 * Now the status travels with the message and pages can react to it.
 */
export class ApiError extends Error {
  // Declared and assigned, not written as a constructor parameter property:
  // the build runs with `erasableSyntaxOnly`, which rejects the shorthand
  // because it is TypeScript that EMITS code rather than TypeScript that is
  // merely erased.
  status: number
  /** The response body, when it was JSON: routes that refuse with a reason the
   *  page can act on (a coverage gap, say) put the details here. */
  body: any
  constructor(status: number, message: string, body?: any) {
    super(message)
    this.status = status
    this.body = body ?? null
    this.name = 'ApiError'
  }
  /** The session is gone. Nothing the page can do about it. */
  get unauthorized() { return this.status === 401 }
  /** Authenticated, but this is not yours to see or do. */
  get forbidden() { return this.status === 403 }
}

/**
 * Called when the API says the session is over. App.tsx registers a handler
 * that returns the user to the sign-in screen; without one, an expired token
 * left every page showing the string "401" and the live status stream
 * reconnecting every three seconds with the same dead credential, forever.
 */
let onUnauthorized: (() => void) | null = null
export function setUnauthorizedHandler(fn: (() => void) | null) { onUnauthorized = fn }

/**
 * PLATFORM SESSION. /api/platform accepts only a session verified with the
 * authenticator code (ACCESS_CONTROL.md). System Admin obtains one by step-up
 * and it is sent for /platform/* calls only; it is never stored.
 */
let platformToken = ''
let platformExpiresAt = 0
export function setPlatformSession(t: string, expiresIn = 3600) { platformToken = t; platformExpiresAt = Date.now() + expiresIn * 1000 }
export function hasPlatformSession() { return !!platformToken && Date.now() < platformExpiresAt - 30_000 }
const bearerFor = (path: string) =>
  path.startsWith('/platform/') && !path.startsWith('/platform/auth/') && hasPlatformSession() ? platformToken : token

// CAN'T REACH THE SERVER is an app-wide state, not one page's error: it goes
// in the global notice region (notices.tsx) and clears on the next answer.
const send = async (path: string, opts: RequestInit) => {
  try {
    const r = await fetch('/api' + path, {
      ...opts,
      headers: {
        'content-type': 'application/json',
        ...(bearerFor(path) ? { authorization: `Bearer ${bearerFor(path)}` } : {}),
        ...(opts.headers || {}),
      },
    })
    if (r.status === 502 || r.status === 503 || r.status === 504) {
      showGlobal('offline', { kind: 'warn', title: 'The server is not answering.', message: 'Changes may not save. This clears by itself when it is back.' })
    } else dismissGlobal('offline')
    return r
  } catch (e) {
    if ((e as any)?.name !== 'AbortError') {
      showGlobal('offline', { kind: 'error', title: "Can't reach the server.", message: 'Check the connection. This clears by itself when it is back.' })
    }
    throw e
  }
}

async function req(path: string, opts: RequestInit = {}) {
  // The token is about to lapse and somebody is working: renew first, so this
  // request never sees the boundary at all.
  await refreshIfDueSoon()

  let r = await send(path, opts)

  // THE SESSION MIGHT NOT BE OVER. It used to be assumed to be. One exchange,
  // one retry; `refreshAccess` is single-flight, so ten simultaneous 401s cause
  // one refresh and ten retries rather than ten refreshes that revoke each
  // other. The retry cannot itself retry: there is no recursion here.
  if (r.status === 401 && token && refreshToken) {
    if (await refreshAccess()) r = await send(path, opts)
  }

  if (!r.ok) {
    let msg = `${r.status}`
    let body: any = null
    // Some routes answer with `message` rather than `error` (the 409 from a
    // download whose range has a hole, for one). A bare status code on screen
    // is the least useful thing the server could have said.
    try { body = await r.json(); msg = body.error || body.message || msg } catch { try { msg = await r.text() } catch { /* no body */ } }
    // Only now is it really over: either there was no refresh token, or the
    // exchange was refused, or the retry failed on its own merits.
    if (r.status === 401 && token) { clearSession(); onUnauthorized?.() }
    throw new ApiError(r.status, msg, body)
  }
  if (r.status === 204) return null
  return r.json()
}

export interface DeleteImpact {
  id: string; name: string; kind: 'tv' | 'radio'; group: string; status: string
  /** why the delete would be refused right now (live, encoder running), else null */
  blocker: string | null
  counts: { recordings: number; clips: number; published_clips: number; programmes: number; scheduled_clips: number; sources: number }
}
export interface AuditRow {
  id: string; created_at: string; action: string; entity_type: string | null; entity_id: string | null
  user_id: string | null; user_email: string | null; actor: string | null; name: string | null
  detail: Record<string, any> | null
}
export interface AuditQuery {
  action?: string; entityType?: string; userId?: string; q?: string; from?: string; to?: string; limit?: number; offset?: number
}
export interface AuditFacets {
  actions: { action: string; n: number }[]; entityTypes: { entity_type: string; n: number }[]
  users: { user_id: string; email: string; n: number }[]
}
function auditQs(f: AuditQuery): string {
  const p = new URLSearchParams()
  for (const [k, v] of Object.entries(f)) if (v !== undefined && v !== null && v !== '') p.set(k, String(v))
  const s = p.toString()
  return s ? `?${s}` : ''
}
export interface PlanView {
  accountId: string; accountName: string; planTier: string
  maxChannels: number; maxConcurrent: number
  used: { total: number; tv: number; radio: number; events: number; running: number }
  allocated: number; unallocated: number
  deployment: 'single' | 'saas'
  canEdit: boolean; editReason: string | null; canManageGroups: boolean
  groups: { id: string; name: string; is_default: boolean; max_channels: number; max_concurrent: number; used: number; radio: number }[]
}
export interface GroupUse {
  id: string; name: string; isDefault: boolean; inUse: boolean; blocker: string | null
  counts: { channels: number; stations: number; events: number; eventsUpcoming: number }
}
export interface Group {
  id: string; name: string; profile_name: string | null
  workflow_type: 'transcode' | 'package_only' | null
  packaging: string | null; rungs: { height: number; bitrate_kbps: number }[] | null
  codec_backend: string | null; captions_provider: 'none' | 'whisper' | 'gladia'
  max_channels: number; channel_count: number
  /** of channel_count, how many are radio stations (the limit counts both) */
  radio_count?: number
  /** new channels, stations and events start here; it cannot be removed */
  is_default?: boolean
  event_count?: number
  max_concurrent?: number; output_profile_id?: string | null
}
export interface Channel {
  id: string; name: string; status: string; group_id: string
  enabled?: boolean; recording_enabled?: boolean
  recording_retention_days: number | null; recording_retention_sec?: number | null
  created_at: string; version: number; group_name?: string
  dvr_window_sec: number | null; dvr_mode: 'sliding' | 'event_start'
  geo_mode: 'worldwide' | 'allow' | 'block'; geo_countries: string[]
  input_loss_behavior?: 'none' | 'slate' | 'vod_loop' | 'last_frame' | 'black'
  input_failover_enabled?: boolean
  auto_failback?: boolean
  filler_slate_ref?: string | null
  pipelineState?: 'idle' | 'starting' | 'ready' | 'onair' | 'degraded' | 'error' | 'stopped'
  billable?: boolean
  serverSince?: number | null
  on_air?: boolean
  brand_ref?: string | null
}

export interface SearchHit { kind: 'channel' | 'event' | 'recording'; id: string; name: string; href: string; sub?: string }

export interface Billing {
  billable: boolean
  since: number | null
  elapsedSec: number
  instance: string
  rateUsdPerHour: number
  estRunUsd: number
  indicative: true
  basis: string
}

export interface ChannelDetail extends Channel {
  schemaId?: string | null; metadata?: Record<string, any>
  kind: 'channel'
  /** Put this channel back on air after a control-plane restart. Default true. */
  autoConnect?: boolean
  /** Whether the channel is MEANT to be running. Survives a crash; `status` does not. */
  desiredState?: 'running' | 'stopped'
  /** An encoder instance is up, so the settings it reads at start are locked. */
  encoderRunning?: boolean
  /** Settings-patch keys locked while it runs. */
  lockedWhileRunning?: string[]
  /** Set only once auto-connect has stopped trying. Carries the reason. */
  resumeGaveUpAt?: string | null
  resumeLastError?: string | null
  /** Set once this run showed server, input, encoder and output all healthy;
   *  auto connect only puts back a stream that has this. */
  resumeArmedAt?: string | null
  resumeAttempts?: number
  group: { id: string; name: string } | null
  profile: {
    name: string; workflow_type: 'transcode' | 'package_only'; packaging: string
    rungs: { height: number; bitrate_kbps: number }[]; segment_dur: number
    dvr_window_sec: number
  } | null
  dvr: { effective_sec: number; max_sec: number; mode: string; source: 'channel' | 'profile'; capped: boolean }
  captions: { enabled: boolean; targets: string[]; source_lang: string; offset_sec?: number }
  epgEnabled: boolean
  ladder: { height: number; bitrate_kbps: number }[]
  /** CPU and bytes received for the run in progress (null when not running). */
  metrics?: {
    cpu: { pct: number; cores: number | null; source: 'encoder' | 'host'; tasksOnHost?: number | null; atMs: number } | null
    ingest: { key: string; role: string | null; label: string | null; bytes: number | null; bps: number | null }[]
    ingestAtMs: number | null
  } | null
  sources: { id: string; role: string; protocol: string; ingest_url: string | null; stream_key?: string | null; status: string; rendition_label?: string | null; rendition_bitrate_kbps?: number | null; params?: Record<string, string | number> | null }[]
  /** Packaging: the single fallback source is transcoded up to every rendition. */
  fallback_transcode?: boolean
  viewers: { current: number; peak: number; peakAt: string; trendPct: number; series: { t: number; v: number }[] }
  epg: { now: any; next: { name: string; start: string; startMs?: number } | null; lane: any[] }
  statusBoard: { output: string; activeSource: string; fallback: string; packager: string; inputs: any[] }
  log: { ts: string; level: string; title: string; detail: string }[]
  health: PipelineHealth
  billing: Billing
  /** Is there a server for it, and if anything is wrong, what to do. Sized and placed automatically. */
  server?: { state: 'running' | 'starting' | 'stopped'; headline: string; detail: string; sizedFrom: string; issue: { what: string; fix: string; ours: boolean } | null }
  testStream: TestStreamStatus
  onAir: boolean
  public: { url: string; dashUrl: string; available: boolean }
  watermark: WatermarkCfg
}

export interface WatermarkCfg {
  enabled: boolean
  ref: string | null
  position: 'tl' | 'tr' | 'bl' | 'br' | 'tc' | 'bc'
  offsetX: number
  offsetY: number
  opacity: number
  scale: number
}
export interface WatermarkPatch {
  enabled?: boolean; ref?: string | null
  position?: 'tl' | 'tr' | 'bl' | 'br' | 'tc' | 'bc'
  offsetX?: number; offsetY?: number; opacity?: number; scale?: number
}

export type GateStatus = 'idle' | 'starting' | 'ready' | 'healthy' | 'degraded' | 'failed' | 'stopped'
export interface Gate {
  gate: 'server' | 'input' | 'encoder' | 'output' | 'public'
  label: string
  status: GateStatus
  detail: string
  billable: boolean
}
export interface PipelineHealth {
  gates: Gate[]
  primaryError: { gate: string; label: string; message: string } | null
  onAir: boolean
  live: boolean
  overall: 'idle' | 'starting' | 'ready' | 'onair' | 'degraded' | 'error' | 'stopped'
  settling?: boolean
  settlingReason?: string | null
  /** What the platform thinks went wrong, when something did. */
  diagnosis?: FailureDiagnosis | null
}

/** The server's reading of a failure: a verdict, why, what to do, and the raw
 *  lines it was built from. See volt-app/src/services/failureDiagnosis.ts. */
export interface FailureDiagnosis {
  gate: string
  verdict: string
  reason: string
  nextStep: string
  confidence: 'high' | 'medium' | 'low'
  evidence: string[]
  retry: { willRetry: boolean; note: string }
}

export interface TestStreamStatus {
  available: boolean
  running: boolean
  producer?: 'test' | 'encoder' | null
  startedAt: number | null
  hls: string
  dash: string | null
  subtitles: Record<string, string>
  poster?: string | null
  thumbsVtt?: string | null
  options: { name: string; dvrSec: number; langs: string[]; dash: boolean; captionInterval: number } | null
  sourceKind: 'ingest' | 'testcard' | null
  sourceUrl: string | null
  sourceNote: string | null
}

export interface AccessCheck {
  country: string; viewer: string; allowed: boolean
  layer: 'account' | 'on_demand' | 'channel' | 'rules' | 'programme' | 'none'
  reason: string | null; via: string | null; ruleId: string | null
  products: { name: string; priceCents?: number; currency?: string }[]
  replacement: { id: string; title: string } | null
}
export interface AccountSettings {
  name: string; logo: string | null; primary: string; secondary: string
  custom: { primary: boolean; secondary: boolean }
  defaults: { primary: string; secondary: string }
  /** Where anything of the account may be watched; null = anywhere. */
  geoAccess: { mode: 'block' | 'allow'; countries: string[] } | null
  canEdit: boolean; editReason: string | null
}
export interface ChannelSettingsPatch {
  name?: string
  /** In-stream graphics overrides (Up next). See GraphicsSettings.tsx. */
  graphics?: { upNext?: { enabled?: boolean; leadSec?: number; durationSec?: number } }
  autoConnect?: boolean
  schemaId?: string
  metadata?: Record<string, any>
  recordingEnabled?: boolean
  recordingRetentionDays?: number | null
  /** Retention in SECONDS, which is what the settings form actually sends: the
   *  UI offers minutes, hours and days and converts. The API has accepted this
   *  since retention became sub-day; the client type had not caught up, so every
   *  save was an untyped property that happened to work. */
  recordingRetentionSec?: number | null
  /** Transcode rungs. Same story: sent, accepted, undeclared. */
  outputLadder?: { height: number; bitrateKbps: number }[] | null
  dvrWindowSec?: number | null
  dvrMode?: 'sliding' | 'event_start'
  geoMode?: 'worldwide' | 'allow' | 'block'
  geoCountries?: string[]
  epgEnabled?: boolean
  sources?: { role: 'primary' | 'backup'; protocol: string; ingestUrl?: string; streamKey?: string; renditionLabel?: string; renditionBitrateKbps?: number; params?: Record<string, string | number> }[]
  /** Packaging: the single fallback source is transcoded up to every rendition. */
  fallbackTranscode?: boolean
  captions?: { enabled?: boolean; sourceLang?: string; targets?: string[]; offsetSec?: number }
  inputFailoverEnabled?: boolean
  autoFailback?: boolean
  inputLossBehavior?: 'none' | 'slate' | 'vod_loop' | 'last_frame' | 'black'
  fillerSlateRef?: string | null
  watermark?: WatermarkPatch
  brandRef?: string | null
  /** Guide icon; null uses brandRef. */
  guideIconRef?: string | null
  radio?: RadioCfg
  version?: number
}

export type FailoverMode = 'auto' | 'primary_down' | 'backup' | 'slate' | 'loop'
export interface FailoverTestState {
  mode: FailoverMode
  realFailover: boolean
  workflowType: 'transcode' | 'package_only' | null
  autoFailback: boolean | null
  lossBehavior: string | null
  loopKind: 'uploaded' | 'motion_slate' | 'slate' | null  // what the loop filler will be
  hasSlate: boolean
  hasBackup: boolean
}


/** What a recording source IS (never `recordings.kind`, which is how the capture
 *  is sliced: a radio station's captures are 'channel_day' too). */
export type RecordingSourceType = 'channel' | 'radio' | 'event'
export interface RecordingSource {
  id: string
  name: string
  type: RecordingSourceType
  brandRef: string | null
  createdAt: string
  recordings: number
  firstStartMs: number | null
  lastEndMs: number | null
  lastStartMs: number | null
  totalDurationMs: number
  /** Truthful: something is capturing RIGHT NOW, asked of the pipeline. */
  capturing: boolean
  state: 'recording' | 'idle' | 'off'
  retentionDays: number | null
  nextExpiry: string | null
}
export interface RecordingSourcesFeed {
  sources: RecordingSource[]
  counts: { all: number; channel: number; radio: number; event: number; capturing: number }
}
export interface RecordingSourceQuery {
  type?: string; q?: string
  sort?: 'name' | 'recorded' | 'created' | 'count' | 'duration'
  dir?: 'asc' | 'desc'
  recordedFrom?: number; recordedTo?: number
  createdFrom?: number; createdTo?: number
  recordingNow?: '1' | '0'
}


/** What a source URL says about itself, read before anything is saved. */
export interface IcyProbe {
  ok: boolean
  url: string
  resolved: boolean
  error: string | null
  station: { name?: string; genre?: string; url?: string; bitrateKbps?: number; contentType?: string; description?: string; public?: boolean }
  nowPlaying: string | null
  streamUrl: string | null
  artworkUrl: string | null
  hasMetadata: boolean
  metaIntervalBytes: number | null
}


// ---- timeline, coverage and dayparts ---------------------------------------
export interface TimelineRun { runId: string; startMs: number; endMs: number; segments: number }
export interface TimelineGap { fromMs: number; toMs: number; ms: number; reason: string }
export interface BroadcastDayRow {
  day: string; startMs: number; endMs: number; hours: number
  /** 'forward' on a 23-hour day, 'back' on a 25-hour day, else null. */
  clockChange: 'forward' | 'back' | null
}
export interface ContainerRow {
  id: string; day: string; startMs: number; endMs: number
  recordings: number; recordedMs: number; coveragePct: number; state: 'open' | 'closed'
}
export interface DaypartStrip { name: string; startMs: number; endMs: number }
export interface TimelineProgramme {
  id: string; title: string; startMs: number; endMs: number
  asRun: boolean; status: string; class: string | null; source: string
}
export interface TimelineFeed {
  channelId: string; name: string
  window: { from: number; to: number; ms: number }
  clock: { tz: string; anchorHour: number; presetId: string | null }
  kind: 'video' | 'audio'
  media: { coveragePct: number; runs: TimelineRun[]; gaps: TimelineGap[] }
  days: BroadcastDayRow[]
  containers: ContainerRow[]
  dayparts: DaypartStrip[]
  programmes: TimelineProgramme[]
}
export interface CoverageFeed {
  channelId: string
  window: { from: number; to: number; ms: number }
  coveragePct: number; coveredMs: number
  effectiveFromMs: number | null; effectiveToMs: number | null
  runs: (TimelineRun & { rendition: string })[]
  gaps: TimelineGap[]
  segments: number
  clippable: boolean
  reason: { code: string; message: string } | null
  strategy: 'full-render' | 'copy'
}
export interface DaypartDef { name: string; startsLocal: string; daysMask?: number }
export interface DaypartPreset {
  id: string; label: string; market: string; appliesTo: string; dayparts: DaypartDef[]
}
export interface JobRow {
  id: string; type: string; state: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled'
  progress_pct: number; progress_note: string | null
  attempts: number; max_attempts: number
  last_error: string | null; error_code: string | null
  result?: any
  created_at: string; started_at: string | null; finished_at: string | null
  source_name?: string | null
}


export interface WaveBucket { t: number; peak: number; rms: number }
export interface ChannelWaveform {
  channelId: string
  from: number; to: number; bucketMs: number
  mode: 'exact' | 'sampled'
  complete: boolean; pending: number; priming: boolean
  buckets: (WaveBucket | null)[]
}

/* ---- fleet: servers and billable usage ---------------------------------- */

/** A reading that could not be taken is null, NEVER zero. The UI must show
 *  "no reading" rather than drawing an idle machine that is actually
 *  unreachable, which is the one wrong answer an operator would act on. */
export interface HostMetrics {
  at: string
  source: 'cloudwatch' | 'onbox' | 'task_stats'
  cpuPct: number | null
  memPct: number | null
  netInBps: number | null
  netOutBps: number | null
  tasksAtSample: number | null
}

export interface HostStream {
  instanceId: string
  id: string
  type: 'channel' | 'radio' | 'event'
  name: string | null
  taskKind: string | null
  role: string
  launchedAt: string | null
}

export interface FleetHost {
  id: string
  kind: 'ec2' | 'fargate' | 'local'
  externalId: string
  instanceType: string | null
  availabilityZone: string | null
  region: string | null
  lifecycle: 'spot' | 'on_demand' | null
  vcpus: number | null
  memoryMib: number | null
  firstSeenAt: string
  lastSeenAt: string
  /** The MACHINE's load, which is what capacity questions need. */
  tasksTotal: number
  streamsTotal: number
  /** This tenant's share of it. */
  tasksYours: number
  streamsYours: number
  taskKinds: string[]
  metrics: HostMetrics | null
  streams: HostStream[]
}

export interface UsageBucket {
  periodStart: string
  seconds: number
  serversUsed: number
  taskRuns: number
  streams: number
  byTaskKind: Record<string, number>
}

export interface StreamUsage {
  id: string
  kind: 'channel' | 'event'
  name: string | null
  channelKind: string | null
  allTimeSeconds: number
  todaySeconds: number
  monthSeconds: number
  /** Running but not yet settled by the meter. Shown apart from the rest. */
  pendingSeconds: number
  runs: number
  lastUsedAt: string | null
}

export interface UsageTotals {
  todaySeconds: number
  monthSeconds: number
  allTimeSeconds: number
  pendingSeconds: number
  serversToday: number
  serversMonth: number
  streamsToday: number
}

export interface FleetUsage {
  period: 'day' | 'week' | 'month' | 'year'
  generatedAt: string
  totals: UsageTotals
  series: UsageBucket[]
  streams: StreamUsage[]
  unit: 'seconds'
}

/* ---- the embeddable player ------------------------------------------------ */

export interface PlayerConfig {
  id: string | null
  name: string
  /** A station layout (card, bar, hero, stage) or a player SDK skin (video, audio_square, audio_wave, audio_nowplaying). */
  layout: string
  primaryColor: string
  secondaryColor: string
  options: Record<string, any>
  fallbackTitle: string | null
  fallbackText: string | null
  fallbackArtworkUrl: string | null
  /** Where this config came from: the station's own, the account default, or built in. */
  source: 'channel' | 'account' | 'default'
}

export interface PlayerLayout { id: string; name: string; detail: string; sdk?: boolean }

export interface PlayerConfigResponse {
  channel: { id: string; name: string }
  config: PlayerConfig
  layouts: PlayerLayout[]
}

export interface PlayerReport {
  hours: number
  totals: { event: string; events: number; sessions: number }[]
  byOrigin: { origin: string; sessions: number; errors: number }[]
  recentErrors: { at: string; event: string; origin: string | null; detail: any }[]
}


/* ------------------------------------------------------------- watchfolders */

export interface Watchfolder {
  id: string
  name: string
  kind: 'local' | 's3'
  config: { path?: string; min_age_ms?: number; library_folder?: string; delete_after_ingest?: boolean;
            max_ingest_bytes?: number; min_bytes?: number; max_bytes?: number; default_workflow?: string }
  default_target_kind: string | null
  quarantine_path: string
  /** The ladder every video file this folder accepts is encoded to. */
  ladder_group_id: string | null
  enabled: boolean
  last_scan_at: string | null
  last_scan_error: string | null
  rule_count?: number
  /** Items waiting for a person. The number the nav badge and the card show. */
  review_count?: number
  version: number
}

export interface WatchfolderRule {
  id: string
  ordinal: number
  name: string
  match_type: 'glob' | 'regex' | 'extension' | 'prefix' | 'suffix'
  pattern: string
  target_kind: string
  workflow: string | null
  action: 'accept' | 'reject'
  reject_reason: string | null
  enabled: boolean
}

/** Every state an object in a watched folder can be in. `seen` means classified
 *  and waiting for ingest; `failed` is a closed row an operator must look at. */
export type WatchfolderItemStatus =
  'seen' | 'ingested' | 'quarantined' | 'failed' | 'reprocessed' | 'removed'

export interface WatchfolderItem {
  id: string
  object_key: string
  checksum: string | null
  size_bytes: number | null
  status: WatchfolderItemStatus
  target_kind: string | null
  workflow: string | null
  media_file_id: string | null
  /** Why, in the words recorded AT THE DECISION. Not recomputed on read. */
  reason: string | null
  quarantine_key: string | null
  rule_name: string | null
  seen_at: string
  resolved_at: string | null
}

export interface WatchfolderDryRun {
  filename: string
  decision:
    | { decision: 'accept'; targetKind: string; workflow: string | null; ruleId: string | null }
    | { decision: 'quarantine'; reason: string; ruleId: string | null }
  quarantinePath: string
  rules: { id: string; ordinal: number; name: string; pattern: string; targetKind: string
           action: string; enabled: boolean; winner: boolean }[]
}

export interface WatchfolderScan {
  scanned: number
  accepted: { objectKey: string; targetKind?: string | null }[]
  quarantined: { objectKey: string; reason?: string | null; quarantineKey?: string | null }[]
  skippedTooNew: string[]
  skippedKnown: number
  errors: { objectKey: string; error: string }[]
  ingest: {
    ingested: number; deferred: number; failed: number
    /** Video accepted and handed to an encode job. Counted apart from
     *  `ingested`, because accepted is not yet playable. */
    queued?: number
    skipped?: number
  } | null
}


/* ---------------------------------------------------- encoding profiles */

/** One rendition: a height and a bitrate with a name on it. The rate control
 *  (preset, maxrate, bufsize, GOP) is NOT here and deliberately so — it is the
 *  same for live and for file and lives in the encoder, in one place. */
export interface EncodeProfile {
  id: string
  name: string
  height: number
  bitrate_kbps: number
  fps: number | null
  notes: string | null
  used_in?: number
  version: number
}

export interface LadderRung { height: number; bitrate_kbps: number; fps?: number | null }

export type LadderOrigin =
  | { kind: 'tracked'; outputProfileId: string; profileName?: string | null }
  | { kind: 'members' }

export interface LadderGroup {
  id: string
  name: string
  description: string | null
  /** Set means this ladder IS a live profile's ladder, read at encode time. */
  tracks_output_profile_id: string | null
  tracked_profile_name?: string | null
  segment_dur: number | string
  fps: number | string
  packaging: 'hls' | 'dash' | 'both'
  codec_backend: 'x264' | 'nvenc'
  cap_to_source: boolean
  is_default: boolean
  member_count?: number
  version: number
  /** RESOLVED by the server, so a tracking ladder shows the numbers it will
   *  actually encode rather than an empty list. */
  rungs: LadderRung[]
  segment_seconds: number | null
  effective_fps: number | null
  origin: LadderOrigin | null
  /** Set when the ladder cannot resolve at all, e.g. its live profile was
   *  deleted. Shown rather than hidden: this is the screen to fix it on. */
  problem: string | null
}

export interface LiveOutputProfile {
  id: string
  name: string
  rungs: LadderRung[]
  segment_dur: number | string
  workflow_type: string
  codec_backend: string
  packaging: string
}

export interface LadderFit {
  kept: LadderRung[]
  dropped: (LadderRung & { why: string; sourceHeight?: number | null })[]
  fps: number
  adapted: { from: number; to: number; reason: string } | null
  /** Distinct from "measured and everything fitted". */
  sourceUnmeasured: boolean
  notes: string[]
}

export interface LadderPreview {
  ladder: {
    id: string; name: string; origin: LadderOrigin
    rungs: LadderRung[]; segmentSeconds: number; fps: number; capToSource: boolean
  }
  source: { height: number | null; fps: number | null }
  fit: LadderFit
  summary: string
}


/** The encode of a file-sourced asset, joined onto the library row. */
export interface AssetEncodeState {
  encode_state?: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled' | null
  encode_pct?: number | null
  encode_note?: string | null
  encode_error?: string | null
  source_kind?: 'recording' | 'upload' | 'watchfolder'
  /** What the encode ACTUALLY produced: rungs kept, rungs dropped and why. */
  encode_result?: {
    summary?: string
    kept?: LadderRung[]
    dropped?: (LadderRung & { why: string; sourceHeight?: number | null })[]
    adapted?: { from: number; to: number } | null
    sourceUnmeasured?: boolean
    notes?: string[]
    ladder?: { name?: string; origin?: LadderOrigin }
  } | null
}


// ---- ingest framework (upload rules ladder, preview, held assets, webhooks) ----
export interface IngestWhen {
  extensions?: string[]; kinds?: ('video' | 'audio' | 'image' | 'other')[]; mimePrefixes?: string[]
  namePattern?: { type: 'glob' | 'regex'; pattern: string }; pathPrefix?: string
  minBytes?: number; maxBytes?: number; minDurationSec?: number; maxDurationSec?: number; minHeight?: number; hasTags?: boolean
}
export interface IngestThen {
  contentTypeId?: string | null; targetKind?: string | null
  naming?: 'honour' | 'guid' | 'guid_prefixed' | 'template'; structure?: 'flat' | 'honour' | 'minimal' | 'template'
  nameTemplate?: string | null; pathTemplate?: string | null; lowercase?: boolean
  duplicate?: 'skip' | 'replace' | 'version' | 'rename' | 'ask'; nameCheck?: boolean
  transfer?: 'auto' | 'local' | 'cloud'; metadataRequired?: 'none' | 'before_ingest' | 'before_upload'; autoUpload?: boolean
  sidecar?: 'none' | 'json' | 'xml'; webhooks?: string[]; ladderGroupId?: string | null; reject?: string | null
}
export interface IngestRule {
  id: string; rung: 'account' | 'type' | 'source'; scopeId: string | null; ordinal: number; name: string; enabled: boolean
  when: IngestWhen | null; then: IngestThen; metadataDefaults: Record<string, any>; createdAt: string; updatedAt: string
}
export interface IngestPreviewRow {
  name: string; key: string; sanitised: string; changed: boolean; settings: Required<IngestThen>
  sources: Record<string, string>; matched: { rung: string; ruleId: string; ruleName: string }[]; deferred: boolean
  duplicate: 'proceed' | 'skip' | 'replace' | 'version' | 'rename' | 'ask'; duplicateOf: { assetId: string; strength: string } | null; reject: string | null
}
export interface IngestHeld {
  id: string; title: string | null; originalFilename: string | null; bytes: number | null; mime: string | null; schemaId: string | null
  status: 'awaiting_metadata' | 'duplicate' | 'rejected'; awaitingMetadata: string[] | null
  duplicate: { outcome: string; ofAssetId: string | null; strength: string | null } | null; rules: { rung: string; ruleName: string }[]; createdAt: string
}
export interface IngestTransfer {
  id: string; provider: string; state: 'created' | 'running' | 'landed' | 'failed' | 'cancelled'; externalId: string | null
  files: { name: string; bytes?: number | null; relativePath?: string | null }[]
  launch: { kind: 'aspera_spec'; transferSpec: Record<string, any>; note: string } | { kind: 'portal'; url: string; note: string } | { kind: 'presigned'; uploads: { name: string; url: string; method: 'PUT' }[]; note: string } | { kind: 'none'; note: string } | null
  progress: { bytes?: number; pct?: number } | null; error: string | null; landedPaths: Record<string, string> | null; createdAt: string
}
export interface IngestWebhook { id: string; name: string; url: string; enabled: boolean; events: string[]; lastStatus: number | null; lastAt: string | null; lastError: string | null; secret?: string }

function libraryQs(p: LibraryQuery): string {
  const qs = new URLSearchParams()
  if (p.folder !== undefined) qs.set('folder', p.folder)
  if (p.kind) qs.set('kind', p.kind)
  if (p.q) qs.set('q', p.q)
  if (p.recursive) qs.set('recursive', '1')
  if (p.source) qs.set('source', p.source)
  if (p.channel) qs.set('channel', p.channel)
  if (p.from) qs.set('from', p.from)
  if (p.to) qs.set('to', p.to)
  if (p.hasLocation) qs.set('hasLocation', '1')
  if (p.near) qs.set('near', p.near)
  if (p.sort) qs.set('sort', p.sort)
  if (p.limit) qs.set('limit', String(p.limit))
  if (p.offset) qs.set('offset', String(p.offset))
  const t = qs.toString()
  return t ? '?' + t : ''
}

/** A text answer (WebVTT), with the session's credential. */
async function textReq(path: string): Promise<string> {
  await refreshIfDueSoon()
  const r = await fetch('/api' + path, { headers: { authorization: `Bearer ${getToken()}` } })
  if (!r.ok) throw new Error(String(r.status))
  return r.text()
}


// ---- Operating reports (modules/reports.ts, docs/REQ_stream_reporting.md) ----
// NULL MEANS NOT KNOWN, never zero: a peak outside the raw analytics window is
// null with peak_basis 'not_retained', and the page must say so.
export type OpStreamKind = 'channel' | 'radio' | 'event'
export type OpStop = 'operator' | 'schedule' | 'fault' | 'internal' | 'unknown'
export interface OpRun {
  instance_id: string; name_at_run: string; started_at: string; ended_at: string | null; running: boolean
  duration_seconds: number; seconds_in_period: number; on_air_seconds: number
  stop: OpStop | null; planned_stop: boolean | null; stop_detail: string | null
  task_kind: string | null; instance_type: string | null; lifecycle: string | null
  audience: { peak_concurrent: number | null; peak_at: string | null; peak_basis: 'exact' | 'not_retained' | 'no_viewers_recorded'
    day_peak_concurrent: number | null; views: number | null; unique_viewers: number | null; watch_seconds: number | null }
  listeners?: { sessions: number; listen_seconds: number; bytes: number; peak_concurrent: number; peak_at: string | null } | null
  cost_basis_usd?: number | null
}
export interface OpReport {
  stream: { id: string; kind: OpStreamKind; name: string; deleted: boolean }
  period: { from: string; to: string }
  air_basis: 'ledger' | 'public_window' | 'none'
  air_windows: { from: string; to: string }[]
  notes: string[]
  totals: {
    runs: number; run_seconds: number; on_air_seconds: number
    availability_pct: number | null; availability_window: 'period' | 'public_window' | 'scheduled_window' | null
    stops: { planned: number; unplanned: number; internal: number; unknown: number }
    mttr_seconds: number | null; unrecovered_faults: number
    peak_concurrent: number | null; peak_at: string | null; peak_basis: 'exact' | 'daily' | 'none'
    views: number | null; unique_viewers_daily_sum: number | null; watch_seconds: number | null
    cost_basis_usd?: number | null
  }
  runs: OpRun[]
}
export interface OpSummaryRow {
  stream_id: string; name: string; kind: OpStreamKind; deleted: boolean
  runs: number; hours_run: number; hours_on_air: number; availability_pct: number | null
  planned_stops: number; unplanned_stops: number; unknown_stops: number; mttr_seconds: number | null
  peak_concurrent: number | null; peak_basis: string; views: number | null; watch_hours: number | null
  cost_basis_usd?: number | null
}
export interface OpSummary {
  period: { from: string; to: string }
  totals: { streams: number; hours_run: number; hours_on_air: number; unplanned_stops: number; cost_basis_usd?: number }
  items: OpSummaryRow[]
}
export interface OpQuery { from: string; to: string; kind?: OpStreamKind | ''; q?: string; sort?: string }
const opQs = (f: OpQuery) => '?' + new URLSearchParams(Object.entries(f).filter(([, v]) => v != null && v !== '') as [string, string][]).toString()

export const api = {
  /** Either a session, or (two-step sign-in) a challenge to finish with mfaVerify / the setup calls. */
  login: (email: string, password: string): Promise<LoginResult> =>
    req('/auth/login', { method: 'POST', body: JSON.stringify({ email, password }) }),
  mfaSend: (challenge: string, method: 'email' | 'sms'): Promise<CodeSent> =>
    req('/auth/mfa/challenge/send', { method: 'POST', body: JSON.stringify({ challenge, method }) }),
  mfaVerify: (challenge: string, method: MfaMethod, code: string): Promise<Session & { backupCodesRemaining?: number }> =>
    req('/auth/mfa/challenge/verify', { method: 'POST', body: JSON.stringify({ challenge, method, code }) }),
  /** Set up a method. Signed in: pass the password. During sign-in setup: pass the challenge. */
  mfaStart: (method: 'totp' | 'email' | 'sms', b: { password?: string; challenge?: string; phone?: string }): Promise<CodeSent & { secret?: string; otpauthUri?: string }> =>
    req(`/auth/mfa/${method}/start`, { method: 'POST', body: JSON.stringify(b) }),
  mfaConfirm: (method: 'totp' | 'email' | 'sms', b: { code: string; challenge?: string }): Promise<{ ok: true; methods: MfaMethod[]; backupCodes?: string[] } & Partial<Session>> =>
    req(`/auth/mfa/${method}/confirm`, { method: 'POST', body: JSON.stringify(b) }),
  mfaRemove: (method: 'totp' | 'email' | 'sms', password: string): Promise<{ ok: true; methods: MfaMethod[] }> =>
    req(`/auth/mfa/${method}`, { method: 'DELETE', body: JSON.stringify({ password }) }),
  mfaBackupCodes: (password: string): Promise<{ backupCodes: string[] }> =>
    req('/auth/mfa/backup-codes', { method: 'POST', body: JSON.stringify({ password }) }),
  security: (): Promise<SecuritySummary> => req('/auth/security'),
  emailChange: (newEmail: string, password: string): Promise<CodeSent> =>
    req('/auth/email/change', { method: 'POST', body: JSON.stringify({ newEmail, password }) }),
  emailChangeConfirm: (code: string): Promise<{ ok: true; email: string }> =>
    req('/auth/email/change/confirm', { method: 'POST', body: JSON.stringify({ code }) }),
  emailVerify: (): Promise<CodeSent & { alreadyVerified?: boolean }> => req('/auth/email/verify', { method: 'POST', body: '{}' }),
  emailVerifyConfirm: (code: string): Promise<{ ok: true }> =>
    req('/auth/email/verify/confirm', { method: 'POST', body: JSON.stringify({ code }) }),
  phoneSet: (phone: string, password: string): Promise<CodeSent> =>
    req('/auth/phone', { method: 'POST', body: JSON.stringify({ phone, password }) }),
  phoneConfirm: (code: string): Promise<{ ok: true; phone: string }> =>
    req('/auth/phone/confirm', { method: 'POST', body: JSON.stringify({ code }) }),
  phoneRemove: (password: string): Promise<null> =>
    req('/auth/phone', { method: 'DELETE', body: JSON.stringify({ password }) }),
  patchMe: (b: { displayName: string | null }): Promise<{ ok: true }> =>
    req('/auth/me', { method: 'PATCH', body: JSON.stringify(b) }),
  securityPolicy: (): Promise<{ requireAdminMfa: boolean; activeUsers: number; usersWithMfa: number }> => req('/users/security-policy'),
  setSecurityPolicy: (requireAdminMfa: boolean): Promise<{ requireAdminMfa: boolean }> =>
    req('/users/security-policy', { method: 'PUT', body: JSON.stringify({ requireAdminMfa }) }),
  resetUserMfa: (id: string): Promise<null> => req(`/users/${id}/mfa/reset`, { method: 'POST', body: '{}' }),
  resetViewerMfa: (id: string): Promise<null> => req(`/viewers/${id}/mfa/reset`, { method: 'POST', body: '{}' }),
  outputProfiles: (): Promise<{ id: string; name: string; workflow_type?: string }[]> => req('/output-profiles'),
  // ---- plan and groups (docs/PLAN_AND_GROUPS.md) ----
  plan: (): Promise<PlanView> => req('/plan'),
  /** The account's logo and colours (Admin > Account settings; used by the share page). */
  accountSettings: (): Promise<AccountSettings> => req('/account-settings'),
  patchAccountSettings: (b: { logo?: string | null; primary?: string | null; secondary?: string | null; geoAccess?: { mode: 'block' | 'allow'; countries: string[] } | null }): Promise<AccountSettings> =>
    req('/account-settings', { method: 'PATCH', body: JSON.stringify(b) }),
  patchPlan: (b: { planTier?: string; maxChannels?: number; maxConcurrent?: number }): Promise<PlanView> =>
    req('/plan', { method: 'PATCH', body: JSON.stringify(b) }),
  createGroup: (b: { name: string; workflowType: 'transcode' | 'package_only'; outputProfileId?: string; maxChannels: number; maxConcurrent: number; makeDefault?: boolean }): Promise<Group> =>
    req('/groups', { method: 'POST', body: JSON.stringify(b) }),
  groupUsage: (id: string): Promise<GroupUse> => req(`/groups/${id}/usage`),
  deleteGroup: (id: string): Promise<void> => req(`/groups/${id}`, { method: 'DELETE' }),
  patchGroup: (id: string, b: { name?: string; outputProfileId?: string; maxChannels?: number; maxConcurrent?: number; isDefault?: true }): Promise<Group> =>
    req(`/groups/${id}`, { method: 'PATCH', body: JSON.stringify(b) }),
  /** Revoke the refresh token server-side. Signing out without this leaves a
   *  fourteen-day credential live for a session the operator believes is over. */
  logout: () =>
    req('/auth/logout', { method: 'POST', body: JSON.stringify({ refresh: getRefreshToken() }) }),
  groups: (): Promise<Group[]> => req('/groups'),
  /** A signed pass to the customer docs site (separate static site; see docsLink.tsx). */
  docsSession: (): Promise<{ url: string; signed: boolean; expiresAt: string | null }> => req('/docs/session'),
  // caption OUTPUT languages the pipeline can deliver (single source of truth for pickers)
  captionLanguages: (): Promise<{ languages: { code: string; label: string }[] }> => req('/caption-languages'),
  channels: (kind?: 'tv' | 'radio'): Promise<Channel[]> => req('/channels' + (kind ? `?kind=${kind}` : '')),
  createChannel: (b: {
    groupId: string; name: string; purchasingMode?: string
    resilienceTier?: string; recordingEnabled?: boolean
    recordingRetentionDays?: number | null; recordingRetentionSec?: number | null
    dvrWindowSec?: number | null; dvrMode?: 'sliding' | 'event_start'
    outputLadder?: { height: number; bitrateKbps: number }[]
    sources?: { role: 'primary' | 'backup'; protocol: string; ingestUrl?: string; streamKey?: string; renditionLabel?: string; renditionBitrateKbps?: number; params?: Record<string, string | number> }[]
    inputFailoverEnabled?: boolean; autoFailback?: boolean
    inputLossBehavior?: 'none' | 'slate' | 'vod_loop' | 'last_frame' | 'black'
    fillerSlateRef?: string | null; fillerAssetId?: string | null
    fallbackTranscode?: boolean
    watermark?: WatermarkPatch
    brandRef?: string | null
    guideIconRef?: string | null
    kind?: 'tv' | 'radio'
    radio?: RadioCfg
    schemaId?: string
    metadata?: Record<string, any>
  }): Promise<Channel> => req('/channels', { method: 'POST', body: JSON.stringify(b) }),
  search: (q: string): Promise<{ results: SearchHit[] }> => req('/search?q=' + encodeURIComponent(q)),

  /* ------------------------------------------------------------ watchfolders --
     Ingest folders, their ordered rules, and the review queue. The DRY RUN is
     the important one at the desk: it answers "which rule would win for this
     filename" against the SAME classify() the scanner runs, so an operator finds
     out that `*.png` outranks `slate_*.png` here rather than in the review
     folder tomorrow. */
  /* ------------------------------------------------------- encoding profiles --
     Renditions, ladders, and the preview that answers "what would a 720p file
     get" from the SAME fitToSource() the encode runs. */
  encodeProfiles: (): Promise<EncodeProfile[]> => req('/encode-profiles'),
  createEncodeProfile: (b: { name: string; height: number; bitrateKbps: number; fps?: number | null; notes?: string | null }): Promise<EncodeProfile> =>
    req('/encode-profiles', { method: 'POST', body: JSON.stringify(b) }),
  patchEncodeProfile: (id: string, b: Record<string, any>): Promise<EncodeProfile> =>
    req(`/encode-profiles/${id}`, { method: 'PATCH', body: JSON.stringify(b) }),
  deleteEncodeProfile: (id: string) => req(`/encode-profiles/${id}`, { method: 'DELETE' }),

  ladderGroups: (): Promise<LadderGroup[]> => req('/encode-profiles/ladders'),
  createLadderGroup: (b: Record<string, any>): Promise<LadderGroup> =>
    req('/encode-profiles/ladders', { method: 'POST', body: JSON.stringify(b) }),
  patchLadderGroup: (id: string, b: Record<string, any>): Promise<LadderGroup> =>
    req(`/encode-profiles/ladders/${id}`, { method: 'PATCH', body: JSON.stringify(b) }),
  deleteLadderGroup: (id: string) => req(`/encode-profiles/ladders/${id}`, { method: 'DELETE' }),
  setLadderMembers: (id: string, profileIds: string[]): Promise<LadderGroup> =>
    req(`/encode-profiles/ladders/${id}/members`, { method: 'PUT', body: JSON.stringify({ profileIds }) }),
  /** Create (or find) the ladder that TRACKS a live output profile. The one
   *  that cannot drift from the channels it was made from. */
  mirrorLiveProfile: (outputProfileId: string, name?: string, makeDefault?: boolean): Promise<LadderGroup> =>
    req('/encode-profiles/ladders/mirror', { method: 'POST', body: JSON.stringify({ outputProfileId, name, makeDefault }) }),
  liveOutputProfiles: (): Promise<LiveOutputProfile[]> => req('/encode-profiles/live-profiles'),
  ladderPreview: (id: string, height: number | null, fps?: number | null): Promise<LadderPreview> =>
    req(`/encode-profiles/ladders/${id}/preview?height=${height ?? ''}&fps=${fps ?? ''}`),

  watchfolders: (): Promise<Watchfolder[]> => req('/watchfolders'),
  watchfolder: (id: string): Promise<Watchfolder & { rules: WatchfolderRule[] }> =>
    req(`/watchfolders/${id}`),
  createWatchfolder: (b: {
    name: string; kind?: 'local' | 's3'; config?: Record<string, any>
    defaultTargetKind?: string | null; quarantinePath?: string
  }): Promise<Watchfolder> => req('/watchfolders', { method: 'POST', body: JSON.stringify(b) }),
  patchWatchfolder: (id: string, b: Record<string, any>): Promise<Watchfolder> =>
    req(`/watchfolders/${id}`, { method: 'PATCH', body: JSON.stringify(b) }),
  deleteWatchfolder: (id: string) => req(`/watchfolders/${id}`, { method: 'DELETE' }),

  watchfolderRules: (id: string): Promise<WatchfolderRule[]> => req(`/watchfolders/${id}/rules`),
  addWatchfolderRule: (id: string, b: {
    name: string; matchType?: string; pattern: string; targetKind: string
    workflow?: string | null; action?: 'accept' | 'reject'; rejectReason?: string | null
    ordinal?: number; enabled?: boolean
  }): Promise<WatchfolderRule> =>
    req(`/watchfolders/${id}/rules`, { method: 'POST', body: JSON.stringify(b) }),
  patchWatchfolderRule: (id: string, ruleId: string, b: Record<string, any>): Promise<WatchfolderRule> =>
    req(`/watchfolders/${id}/rules/${ruleId}`, { method: 'PATCH', body: JSON.stringify(b) }),
  deleteWatchfolderRule: (id: string, ruleId: string) =>
    req(`/watchfolders/${id}/rules/${ruleId}`, { method: 'DELETE' }),

  /** Ask what WOULD happen, without a file. Shares the scanner's classifier. */
  watchfolderDryRun: (id: string, filename: string, sizeBytes?: number | null): Promise<WatchfolderDryRun> =>
    req(`/watchfolders/${id}/dry-run`, { method: 'POST', body: JSON.stringify({ filename, sizeBytes }) }),
  /** Scan AND ingest. One action at the desk even though it is two in the code. */
  scanWatchfolder: (id: string): Promise<WatchfolderScan> =>
    req(`/watchfolders/${id}/scan`, { method: 'POST' }),
  watchfolderItems: (id: string, status?: string, limit = 200): Promise<{ items: WatchfolderItem[] }> =>
    req(`/watchfolders/${id}/items?limit=${limit}` + (status ? `&status=${encodeURIComponent(status)}` : '')),
  resolveWatchfolderItem: (id: string, itemId: string, resolution: 'reprocess' | 'remove', note?: string) =>
    req(`/watchfolders/${id}/items/${itemId}/resolve`,
      { method: 'POST', body: JSON.stringify({ resolution, note }) }),
  startStop: (id: string, action: 'start' | 'stop') =>
    req(`/channels/${id}/${action}`, { method: 'POST' }),
  /** Stop (or resume) auto connect by hand. Off halts retries and leaves the
   *  evidence untouched; on makes the stream eligible once seen healthy. */
  setAutoConnect: (kind: 'channel' | 'event' | 'radio', id: string, enabled: boolean) =>
    req(`/${kind === 'radio' ? 'radio' : kind + 's'}/${id}/auto-connect`, { method: 'POST', body: JSON.stringify({ enabled }) }),
  // Go on air / take off air — the PUBLIC publish toggle (opens/closes /live/:id/...).
  setAir: (id: string, on: boolean): Promise<Channel> =>
    req(`/channels/${id}/air`, { method: 'POST', body: JSON.stringify({ on }) }),
  // Pre-on-air failover test: force the encoder to slate/loop/backup (or simulate a
  // primary loss), then resume with mode 'auto'. `realFailover` is true only when the
  // encoder selector is actually running (redundancy-enabled package channel).
  failoverTest: (id: string, mode: FailoverMode): Promise<FailoverTestState> =>
    req(`/channels/${id}/failover-test`, { method: 'POST', body: JSON.stringify({ mode }) }),
  failoverTestStatus: (id: string): Promise<FailoverTestState> =>
    req(`/channels/${id}/failover-test`),
  // Share link — a private, PIN/expiry-secured preview of THIS channel's output, for
  // clients/reviewers to approve before go-live. Not on air, ignores geo/access rules.
  createShareLink: (b: {
    resourceKind: 'vod' | 'channel' | 'event'; resourceId: string
    accessPeriod?: string; ttlSec?: number; label?: string; message?: string
    pin?: string; maxViews?: number | null
    recipients?: string[]
    authMode?: 'none' | 'pin' | 'email_pin'
    sendEmail?: boolean
  }): Promise<{ id: string; url: string; token: string; expiresAt: string; emailed: number }> =>
    req('/share-links', { method: 'POST', body: JSON.stringify(b) }),
  shareLinks: (): Promise<ShareLinkRow[]> => req('/share-links'),
  revokeShareLink: (id: string): Promise<{ id: string; revoked: boolean }> =>
    req(`/share-links/${id}/revoke`, { method: 'POST' }),
  channel: (id: string): Promise<ChannelDetail> => req(`/channels/${id}`),
  /** What a viewer in `country` would get for this channel now: the play gate's decision and the layer that made it. */
  channelAccessCheck: (id: string, country: string, viewer: 'anonymous' | 'member' | 'entitled' = 'anonymous'): Promise<AccessCheck> =>
    req(`/channels/${id}/access-check?country=${encodeURIComponent(country)}&viewer=${viewer}`),
  /** Clear QC: a clean slate for the channel's health; earlier faults stay in the event log. */
  resetChannelHealth: (id: string): Promise<{ id: string; was: string | null; overall: string | null; primaryError: { gate: string; label: string; message: string } | null }> =>
    req(`/channels/${id}/reset-health`, { method: 'POST' }),
  /** A relayed preview address for one HLS input (for sources that block playback from other sites). */
  channelInputPreview: (id: string, inputId: string): Promise<{ url: string; expiresInSec: number }> => req(`/channels/${id}/inputs/${inputId}/preview`),
  updateChannel: (id: string, patch: ChannelSettingsPatch): Promise<any> =>
    req(`/channels/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }),
  testStreamStart: (id: string, opts: { langs?: string[]; dvrSec?: number; dash?: boolean } = {}): Promise<TestStreamStatus> =>
    req(`/channels/${id}/test-stream`, { method: 'POST', body: JSON.stringify({ action: 'start', ...opts }) }),
  testStreamStop: (id: string): Promise<{ running: boolean }> =>
    req(`/channels/${id}/test-stream`, { method: 'POST', body: JSON.stringify({ action: 'stop' }) }),
  ingestProtocols: (): Promise<{ protocols: IngestProtocol[] }> => req('/ingest-protocols'),

  // image library (file manager)
  files: (p: LibraryQuery = {}): Promise<MediaFile[]> => req('/files' + libraryQs(p)),
  /** One search box: matching folders and files. */
  searchLibrary: (p: LibraryQuery): Promise<{ folders: LibraryFolder[]; files: MediaFile[]; total: number }> =>
    req('/files/search' + libraryQs(p)),
  /** Children of one folder ('' = top level), for the lazy folder tree. */
  folderChildren: (parent: string): Promise<{ folders: LibraryFolder[] }> =>
    req('/files/folders?parent=' + encodeURIComponent(parent)),
  refreshFileMetadata: (id: string): Promise<MediaFile> => req(`/files/${id}/metadata/refresh`, { method: 'POST' }),
  backfillFileMetadata: (): Promise<{ refreshed: number; missing: number; remaining: number }> =>
    req('/files/metadata/backfill', { method: 'POST' }),
  // encoder thumbnails: sprite sheets for hover previews, and VTTs
  storyboard: (stream: string, from: number, to: number, prime = true): Promise<Storyboard> =>
    req(`/thumbnails/storyboard?stream=${stream}&from=${Math.floor(from)}&to=${Math.ceil(to)}${prime ? '&prime=1' : ''}`),
  vodThumbnailsVtt: (id: string): Promise<string> => textReq(`/thumbnails/vod/${id}.vtt`),
  recordingThumbnailsVtt: (id: string): Promise<string> => textReq(`/thumbnails/recordings/${id}.vtt`),
  buildThumbnails: (stream: string, from: number, to: number): Promise<{ started: boolean }> =>
    req('/thumbnails/build', { method: 'POST', body: JSON.stringify({ stream, from, to }) }),
  // events — same core workflow as channels plus the scheduled window
  events: (): Promise<EventRow[]> => req('/events'),
  event: (id: string): Promise<EventRow> => req(`/events/${id}`),
  createEvent: (b: EventCreateBody): Promise<EventRow> =>
    req('/events', { method: 'POST', body: JSON.stringify(b) }),
  updateEvent: (id: string, patch: EventPatchBody): Promise<EventRow> =>
    req(`/events/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }),
  eventStartStop: (id: string, action: 'start' | 'stop'): Promise<EventRow> =>
    req(`/events/${id}/${action}`, { method: 'POST' }),
  // ---- channel delete (administrators) and the audit log (modules/audit.ts) ----
  channelDeleteImpact: (id: string): Promise<DeleteImpact> => req(`/channels/${id}/delete-impact`),
  deleteChannel: (id: string): Promise<void> => req(`/channels/${id}`, { method: 'DELETE' }),
  audit: (f: AuditQuery = {}): Promise<{ total: number; limit: number; offset: number; items: AuditRow[] }> =>
    req(`/audit${auditQs(f)}`),
  auditFacets: (): Promise<AuditFacets> => req('/audit/facets'),
  // ---- Operating reports ----
  operatingSummary: (f: OpQuery): Promise<OpSummary> => req(`/reports/streams${opQs(f)}`),
  operatingReport: (id: string, f: OpQuery): Promise<OpReport> => req(`/reports/stream/${encodeURIComponent(id)}${opQs({ from: f.from, to: f.to })}`),
  /** Download a report as CSV: the per-stream one when `id` is given, otherwise the period summary. */
  downloadOperatingCsv: async (f: OpQuery, id?: string): Promise<void> => {
    await refreshIfDueSoon()
    const path = id ? `/api/reports/stream/${encodeURIComponent(id)}.csv${opQs({ from: f.from, to: f.to })}` : `/api/reports/streams.csv${opQs(f)}`
    const r = await fetch(path, { headers: { authorization: `Bearer ${getToken()}` } })
    if (!r.ok) {
      let msg = `${r.status}`
      try { const b = await r.json(); msg = b.error || msg } catch { /* not json */ }
      throw new ApiError(r.status, msg, null)
    }
    const blob = await r.blob()
    const name = /filename="([^"]+)"/.exec(r.headers.get('content-disposition') || '')?.[1] || 'operating-report.csv'
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a'); a.href = url; a.download = name
    document.body.appendChild(a); a.click(); a.remove()
    setTimeout(() => URL.revokeObjectURL(url), 2000)
  },
  /** Download the filtered audit log as CSV (same filters as the table). */
  downloadAuditCsv: async (f: AuditQuery = {}): Promise<void> => {
    await refreshIfDueSoon()
    const { limit: _l, offset: _o, ...rest } = f
    const r = await fetch(`/api/audit/export.csv${auditQs(rest)}`, { headers: { authorization: `Bearer ${getToken()}` } })
    if (!r.ok) {
      let msg = `${r.status}`
      try { const b = await r.json(); msg = b.error || msg } catch { /* not json */ }
      throw new ApiError(r.status, msg, null)
    }
    const blob = await r.blob()
    const name = /filename="([^"]+)"/.exec(r.headers.get('content-disposition') || '')?.[1] || 'audit-log.csv'
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a'); a.href = url; a.download = name
    document.body.appendChild(a); a.click(); a.remove()
    setTimeout(() => URL.revokeObjectURL(url), 2000)
  },
  // Through req(), so a refusal reads as the server's reason, not a bare status.
  deleteEvent: (id: string): Promise<void> => req(`/events/${id}`, { method: 'DELETE' }),

  // EPG — programme guides for channels and event-day schedules
  epgOwners: (): Promise<EpgOwnerRow[]> => req('/epg/owners'),
  // ---- XMLTV export (modules/xmltv.ts) ----
  guideChannels: (): Promise<GuideChannel[]> => req('/epg/channels'),
  setGuideIcon: (channelId: string, ref: string | null): Promise<{ id: string; guideIconRef: string | null; iconRef: string | null; iconFrom: GuideChannel['iconFrom']; icon: string | null }> =>
    req(`/epg/channels/${channelId}/guide-icon`, { method: 'PUT', body: JSON.stringify({ ref }) }),
  setXmltvId: (channelId: string, xmltvId: string | null): Promise<{ id: string; xmltvId: string; xmltvIdSet: boolean }> =>
    req(`/epg/channels/${channelId}/xmltv-id`, { method: 'PUT', body: JSON.stringify({ xmltvId }) }),
  xmltvFeeds: (): Promise<XmltvFeed[]> => req('/epg/xmltv/feeds'),
  createXmltvFeed: (b: Partial<XmltvFeedBody> & { name: string }): Promise<XmltvFeed & { url: string; gzipUrl: string }> =>
    req('/epg/xmltv/feeds', { method: 'POST', body: JSON.stringify(b) }),
  patchXmltvFeed: (id: string, b: Partial<XmltvFeedBody>): Promise<XmltvFeed> =>
    req(`/epg/xmltv/feeds/${id}`, { method: 'PATCH', body: JSON.stringify(b) }),
  rotateXmltvFeed: (id: string): Promise<XmltvFeed & { url: string; gzipUrl: string }> =>
    req(`/epg/xmltv/feeds/${id}/rotate`, { method: 'POST' }),
  deleteXmltvFeed: async (id: string): Promise<void> => {
    const r = await fetch('/api/epg/xmltv/feeds/' + id, { method: 'DELETE', headers: { authorization: `Bearer ${getToken()}` } })
    if (!r.ok && r.status !== 204) throw new ApiError(r.status, `${r.status}`, null)
  },
  /** The XMLTV document as a file the browser saves. Goes through fetch, not a
   *  link, because the export needs the session's bearer token. */
  downloadXmltv: async (q: { pastDays: number; futureDays: number; times: 'scheduled' | 'asrun'; tz: 'local' | 'utc'; includeEvents?: boolean; channelIds?: string[] }): Promise<{ bytes: number; programmes: string | null }> => {
    await refreshIfDueSoon()
    const qs = new URLSearchParams({ pastDays: String(q.pastDays), futureDays: String(q.futureDays), times: q.times, tz: q.tz })
    if (q.includeEvents) qs.set('includeEvents', 'true')
    if (q.channelIds?.length) qs.set('channelId', q.channelIds.join(','))
    const r = await fetch('/api/epg/xmltv?' + qs.toString(), { headers: { authorization: `Bearer ${getToken()}` } })
    if (!r.ok) {
      let msg = `${r.status}`
      try { const b = await r.json(); msg = b.error || msg } catch { /* not json */ }
      throw new ApiError(r.status, msg, null)
    }
    const blob = await r.blob()
    const name = /filename="([^"]+)"/.exec(r.headers.get('content-disposition') || '')?.[1] || 'volt-guide.xml'
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a'); a.href = url; a.download = name
    document.body.appendChild(a); a.click(); a.remove()
    setTimeout(() => URL.revokeObjectURL(url), 2000)
    return { bytes: blob.size, programmes: r.headers.get('x-volt-guide-counts') }
  },
  epgProgrammes: (owner: EpgOwner, fromIso: string, toIso: string): Promise<ProgrammeRow[]> =>
    req(`/epg?${owner.kind === 'event' ? 'eventId' : 'channelId'}=${owner.id}&from=${encodeURIComponent(fromIso)}&to=${encodeURIComponent(toIso)}`),
  /** The VoD lifecycle for a window, keyed by programme id. Measured against
   *  the archive on disk, so it is a separate read from the listing itself. */
  epgVodStatus: (owner: EpgOwner, fromIso: string, toIso: string): Promise<{ programmes: Record<string, ProgrammeVod> }> =>
    req(`/epg/vod-status?ownerKind=${owner.kind}&ownerId=${owner.id}&from=${encodeURIComponent(fromIso)}&to=${encodeURIComponent(toIso)}`),
  /** Convert an aired slot to a VOD now. Runs the same conversion the
   *  scheduler runs; 409 if it is already converted or in flight. */
  convertProgramme: (id: string): Promise<{ assetId: string }> =>
    req(`/epg/${encodeURIComponent(id)}/convert`, { method: 'POST' }),
  epgConflicts: (owner: EpgOwner, fromIso: string, toIso: string): Promise<ProgrammeConflict[]> =>
    req(`/epg/conflicts?${owner.kind === 'event' ? 'eventId' : 'channelId'}=${owner.id}&from=${encodeURIComponent(fromIso)}&to=${encodeURIComponent(toIso)}`),
  createProgramme: (owner: EpgOwner, b: ProgrammeBody): Promise<ProgrammeRow & { conflicts: { id: string; title: string }[] }> =>
    req('/epg', { method: 'POST', body: JSON.stringify({ ...(owner.kind === 'event' ? { eventId: owner.id } : { channelId: owner.id }), ...b }) }),
  patchProgramme: (id: string, b: Partial<ProgrammeBody>): Promise<ProgrammeRow> =>
    req(`/epg/${id}`, { method: 'PATCH', body: JSON.stringify(b) }),
  /** scope applies to a repeat occurrence: this one (default), this and following, or every repeat. */
  deleteProgramme: async (id: string, scope: EpgScope = 'this'): Promise<void> => {
    const r = await fetch('/api/epg/' + id + (scope !== 'this' ? `?scope=${scope}` : ''), { method: 'DELETE', headers: { authorization: `Bearer ${getToken()}` } })
    if (!r.ok && r.status !== 204) {
      let m = String(r.status)
      try { m = (await r.json()).error ?? m } catch { /* status only */ }
      throw new Error(m)
    }
  },
  epgCopyDay: (owner: EpgOwner, fromStart: string, fromEnd: string, dayOffsets: number[]): Promise<{ copied: number; created: number }> =>
    req('/epg/copy-day', { method: 'POST', body: JSON.stringify({ ...(owner.kind === 'event' ? { eventId: owner.id } : { channelId: owner.id }), fromStart, fromEnd, dayOffsets }) }),
  /** Copy a day onto dates, or repeat it on a rule. dryRun = the preview; nothing is written. */
  epgCopyDayV2: (owner: EpgOwner, b: { sourceDate: string; tz: string; dates?: string[]; repeat?: { rule: RepeatRule; until: string | null }; policy: RepeatPolicy; dryRun?: boolean }): Promise<PlaceResult> =>
    req('/epg/copy-day', { method: 'POST', body: JSON.stringify({ ...(owner.kind === 'event' ? { eventId: owner.id } : { channelId: owner.id }), ...b }) }),
  /** Repeat one programme (by id), or preview a repeat of one not yet saved (fields + dryRun). */
  epgRepeat: (b: { programmeId?: string; owner?: EpgOwner; title?: string; startsAt?: string; endsAt?: string; rule: RepeatRule; until: string | null; policy: RepeatPolicy; tz: string; dryRun?: boolean }): Promise<PlaceResult> => {
    const { owner, ...rest } = b
    return req('/epg/repeat', { method: 'POST', body: JSON.stringify({ ...rest, ...(owner ? (owner.kind === 'event' ? { eventId: owner.id } : { channelId: owner.id }) : {}) }) })
  },
  epgSeries: (id: string): Promise<EpgSeriesInfo> => req(`/epg/series/${encodeURIComponent(id)}`),
  epgEndSeries: (id: string, from: string): Promise<{ deleted: number }> =>
    req(`/epg/series/${encodeURIComponent(id)}/end`, { method: 'POST', body: JSON.stringify({ from }) }),
  epgUndo: (batchId: string): Promise<{ removed: number; restored: number; keptStarted: number }> =>
    req(`/epg/batches/${encodeURIComponent(batchId)}/undo`, { method: 'POST' }),
  epgClearDay: (owner: EpgOwner, fromStart: string, fromEnd: string): Promise<{ deleted: number; batchId?: string | null }> =>
    req('/epg/clear-day', { method: 'POST', body: JSON.stringify({ ...(owner.kind === 'event' ? { eventId: owner.id } : { channelId: owner.id }), fromStart, fromEnd }) }),

  // recordings library + range playback + clip/VOD creation
  /** Sources roll-up: one row per channel / radio station / event that has
   *  recordings. Sorting and filtering are server-side because the counts and
   *  the available range are computed in SQL. */
  /** Ask a source URL what it is, before saving it. Nothing is written. */
  /** ffprobe a channel or event source from the control plane (services/sourceProbe.ts). */
  // ---- XMLTV import (modules/xmltvImport.ts) ----
  importSources: (): Promise<ImportSource[]> => req('/epg/import/sources'),
  createImportSource: (b: Partial<ImportSourceBody> & { name: string; kind: 'url' | 'upload' }): Promise<ImportSource> =>
    req('/epg/import/sources', { method: 'POST', body: JSON.stringify(b) }),
  updateImportSource: (id: string, b: Partial<ImportSourceBody>): Promise<ImportSource & { reread?: { removedProgrammes: number; reimporting: boolean } }> =>
    req(`/epg/import/sources/${id}`, { method: 'PATCH', body: JSON.stringify(b) }),
  deleteImportSource: (id: string): Promise<{ deleted: boolean; removedProgrammes: number }> =>
    req(`/epg/import/sources/${id}`, { method: 'DELETE' }),
  runImportSource: (id: string): Promise<ImportRunResult> => req(`/epg/import/sources/${id}/run`, { method: 'POST' }),
  /** Fetch the source's first request and say what is in it, writing nothing. */
  testImportSource: (id: string): Promise<ImportTestResult> => req(`/epg/import/sources/${id}/test`, { method: 'POST' }),
  /** The file goes up as the request body, untouched (gzip stays gzip). */
  uploadImportFile: async (id: string, file: File): Promise<ImportRunResult> => {
    await refreshIfDueSoon()
    const gz = /\.gz$/i.test(file.name) || file.type === 'application/gzip'
    const r = await fetch(`/api/epg/import/sources/${id}/upload`, {
      method: 'POST', body: file,
      headers: { authorization: `Bearer ${getToken()}`, 'content-type': gz ? 'application/gzip' : 'application/xml' },
    })
    const b = await r.json().catch(() => null)
    if (!r.ok) throw new ApiError(r.status, b?.error || `${r.status}`, b)
    return b
  },
  importChannels: (id: string): Promise<ImportAlias[]> => req(`/epg/import/sources/${id}/channels`),
  mapImportChannel: (aliasId: string, channelId: string | null): Promise<{ id: string; channelId: string | null; removedFromPrevious: number }> =>
    req(`/epg/import/aliases/${aliasId}`, { method: 'PUT', body: JSON.stringify({ channelId }) }),
  /** Use a feed channel on a Volt channel, or mark it not used (ignored) / waiting. */
  setImportChannel: (aliasId: string, b: { channelId?: string | null; ignored?: boolean }): Promise<{ id: string; state: ImportAlias['state']; removedFromPrevious: number }> =>
    req(`/epg/import/aliases/${aliasId}`, { method: 'PUT', body: JSON.stringify(b) }),
  bulkImportChannels: (sourceId: string, b: { aliasIds: string[]; action: 'not_used' | 'waiting' | 'accept_suggestions' | 'create'; groupId?: string; kind?: 'tv' | 'radio'; tz?: string }):
    Promise<{ done: number; skipped: { id: string; reason: string }[] }> =>
    req(`/epg/import/sources/${sourceId}/channels/bulk`, { method: 'POST', body: JSON.stringify(b) }),
  /** Use their channel's icon as the linked Volt channel's logo (only when it has none). */
  useImportIcon: (sourceId: string, aliasId: string): Promise<{ channelId: string; brandRef: string }> =>
    req(`/epg/import/sources/${sourceId}/channels/${aliasId}/use-icon`, { method: 'POST' }),
  importRuns: (id: string): Promise<ImportRun[]> => req(`/epg/import/sources/${id}/runs`),
  // ---- social publishing (modules/social.ts) ----
  socialPlatforms: (): Promise<SocialPlatformsStatus> => req('/social/platforms'),
  socialAccounts: (): Promise<SocialAccount[]> => req('/social/accounts'),
  socialConnect: (platform: string): Promise<{ url: string }> => req(`/social/connect/${platform}`, { method: 'POST' }),
  socialSandbox: (platform: string, label?: string): Promise<SocialAccount> =>
    req(`/social/sandbox/${platform}`, { method: 'POST', body: JSON.stringify({ label }) }),
  socialSetEnabled: (id: string, enabled: boolean) => req(`/publish-targets/${id}`, { method: 'PATCH', body: JSON.stringify({ enabled }) }),
  socialDisconnect: async (id: string): Promise<void> => {
    const r = await fetch('/api/publish-targets/' + id, { method: 'DELETE', headers: { authorization: `Bearer ${getToken()}` } })
    if (!r.ok && r.status !== 204) throw new ApiError(r.status, `${r.status}`, null)
  },
  socialDefaults: (assetId: string): Promise<Record<string, SocialPost>> => req(`/social/publish/${assetId}/defaults`),
  socialPublish: (assetId: string, targets: { targetId: string; post: SocialPost }[]): Promise<{ publications: any[] }> =>
    req(`/social/publish/${assetId}`, { method: 'POST', body: JSON.stringify({ targets }) }),
  socialPublications: (assetId: string): Promise<SocialPublication[]> => req(`/social/publications?assetId=${encodeURIComponent(assetId)}`),
  socialRetry: (id: string, post?: SocialPost) => req(`/social/publications/${id}/retry`, { method: 'POST', body: JSON.stringify(post ? { post } : {}) }),
  socialTakeDown: (id: string) => req(`/social/publications/${id}/remove`, { method: 'POST' }),
  socialSyncViews: (): Promise<{ synced: number }> => req('/social/sync-views', { method: 'POST' }),
  // ---- workflows + add-ons (modules/workflows.ts, WORKFLOWS.md) ----
  workflowMap: (): Promise<WorkflowMap> => req('/workflows/map'),
  workflowRuns: (q: { state?: string; addonId?: string; subjectType?: string; subjectId?: string; open?: boolean; limit?: number } = {}): Promise<{ runs: AddonRun[] }> => {
    const p = new URLSearchParams()
    for (const [k, v] of Object.entries(q)) if (v !== undefined && v !== '' && v !== false) p.set(k, String(v === true ? 1 : v))
    return req('/workflows/runs' + (p.toString() ? `?${p}` : ''))
  },
  workflowRun: (id: string): Promise<AddonRunDetail> => req(`/workflows/runs/${id}`),
  startAddonRun: (b: { addonId: string; subjectType: 'recording' | 'vod_asset'; subjectId: string; options?: Record<string, unknown> }): Promise<AddonRun> =>
    req('/workflows/runs', { method: 'POST', body: JSON.stringify(b) }),
  cancelAddonRun: (id: string): Promise<AddonRun> => req(`/workflows/runs/${id}/cancel`, { method: 'POST' }),
  retryAddonRun: (id: string): Promise<AddonRun> => req(`/workflows/runs/${id}/retry`, { method: 'POST' }),
  workflowTrace: (subjectType: string, subjectId: string): Promise<WorkflowTrace> =>
    req(`/workflows/trace?subjectType=${encodeURIComponent(subjectType)}&subjectId=${encodeURIComponent(subjectId)}`),
  workflowEvents: (limit = 40): Promise<{ events: WorkflowEvent[] }> => req(`/workflows/events?limit=${limit}`),
  addons: (): Promise<{ addons: AddonService[] }> => req('/addons'),
  createAddon: (b: AddonInput): Promise<AddonService & { signingSecret: string }> => req('/addons', { method: 'POST', body: JSON.stringify(b) }),
  updateAddon: (id: string, b: Partial<AddonInput>): Promise<AddonService> => req(`/addons/${id}`, { method: 'PATCH', body: JSON.stringify(b) }),
  deleteAddon: (id: string) => req(`/addons/${id}`, { method: 'DELETE' }),
  rotateAddonSecret: (id: string): Promise<{ id: string; signingSecret: string }> => req(`/addons/${id}/rotate-secret`, { method: 'POST' }),
  testAddon: (id: string): Promise<{ ok: boolean; status: number | null; ms: number; message: string }> => req(`/addons/${id}/test`, { method: 'POST' }),
  addonTriggers: (): Promise<{ triggers: AddonTrigger[] }> => req('/addons/triggers'),
  createAddonTrigger: (b: { addonId: string; hook: string; filter?: { channelIds?: string[]; eventIds?: string[]; groupIds?: string[] }; options?: Record<string, unknown>; enabled?: boolean }): Promise<AddonTrigger> =>
    req('/addons/triggers', { method: 'POST', body: JSON.stringify(b) }),
  updateAddonTrigger: (id: string, b: { enabled?: boolean; filter?: any; options?: any }): Promise<AddonTrigger> =>
    req(`/addons/triggers/${id}`, { method: 'PATCH', body: JSON.stringify(b) }),
  deleteAddonTrigger: (id: string) => req(`/addons/triggers/${id}`, { method: 'DELETE' }),
  engines: (): Promise<{ engines: EngineDescriptor[] }> => req('/engines'),
  // ---- notifications (modules/notifications.ts) ----
  inbox: (): Promise<{ recipient: string; unread: number; items: InboxItem[] }> => req('/notifications/inbox'),
  markRead: (id: string) => req(`/notifications/inbox/${id}/read`, { method: 'POST' }),
  markAllRead: (): Promise<{ read: number }> => req('/notifications/inbox/read-all', { method: 'POST' }),
  notificationConfig: (): Promise<NotificationConfig> => req('/notifications/config'),
  notifications: (): Promise<NotificationRow[]> => req('/notifications'),
  notification: (id: string): Promise<NotificationRow & { deliveries: DeliveryRow[] }> => req(`/notifications/${id}`),
  retryDelivery: (id: string): Promise<DeliveryRow> => req(`/notifications/deliveries/${id}/retry`, { method: 'POST' }),
  retryAllDeliveries: (): Promise<{ retried: number }> => req('/notifications/retry', { method: 'POST', body: '{}' }),
  testNotification: (channel: 'email' | 'in_app' | 'push'): Promise<{ id: string; status: string; error: string | null; gaveUp: boolean }> =>
    req('/notifications/test', { method: 'POST', body: JSON.stringify({ channel }) }),
  notificationTemplates: (): Promise<NotificationTemplate[]> => req('/notification-templates'),
  createNotificationTemplate: (b: { key: string; subject: string; body: string }): Promise<NotificationTemplate> =>
    req('/notification-templates', { method: 'POST', body: JSON.stringify(b) }),
  updateNotificationTemplate: (id: string, b: { subject?: string; body?: string }): Promise<NotificationTemplate> =>
    req(`/notification-templates/${id}`, { method: 'PATCH', body: JSON.stringify(b) }),
  deleteNotificationTemplate: async (id: string): Promise<void> => {
    const r = await fetch('/api/notification-templates/' + id, { method: 'DELETE', headers: { authorization: `Bearer ${getToken()}` } })
    if (!r.ok && r.status !== 204) throw new ApiError(r.status, `${r.status}`, null)
  },
  myDevices: (): Promise<{ id: string; platform: string; label: string | null; created_at: string; last_seen_at: string; token_prefix: string }[]> => req('/notifications/devices'),
  removeDevice: async (id: string): Promise<void> => {
    const r = await fetch('/api/notifications/devices/' + id, { method: 'DELETE', headers: { authorization: `Bearer ${getToken()}` } })
    if (!r.ok && r.status !== 204) throw new ApiError(r.status, `${r.status}`, null)
  },
  /** Read an HLS playlist (master variants or media) without probing the stream. Quick. */
  inspectHls: (url: string): Promise<HlsInspection> => req('/sources/hls', { method: 'POST', body: JSON.stringify({ url }) }),
  probeSource: (url: string, protocol?: string): Promise<SourceProbe> =>
    req('/sources/probe', { method: 'POST', body: JSON.stringify({ url, protocol }) }),
  probeRadioSource: (url: string): Promise<IcyProbe> =>
    req('/radio/probe', { method: 'POST', body: JSON.stringify({ url }) }),
  /** The three lanes in one call, so they cannot disagree about a boundary. */
  channelTimeline: (id: string, from: number, to: number): Promise<TimelineFeed> =>
    req(`/channels/${id}/timeline?from=${Math.round(from)}&to=${Math.round(to)}`),
  /** The waveform for a window, at the caller's pixel resolution. */
  channelWaveform: (id: string, from: number, to: number, buckets: number, prime = true): Promise<ChannelWaveform> =>
    req(`/channels/${id}/waveform?from=${Math.round(from)}&to=${Math.round(to)}&buckets=${Math.round(buckets)}${prime ? '&prime=1' : ''}`),
  channelCoverage: (id: string, from: number, to: number): Promise<CoverageFeed> =>
    req(`/channels/${id}/coverage?from=${Math.round(from)}&to=${Math.round(to)}`),
  channelDayparts: (id: string): Promise<{ presetId: string | null; tz: string; anchorHour: number; dayparts: DaypartDef[] }> =>
    req(`/channels/${id}/dayparts`),
  setChannelDayparts: (id: string, body: { presetId?: string; dayparts?: DaypartDef[]; tz?: string; anchorHour?: number }) =>
    req(`/channels/${id}/dayparts`, { method: 'PUT', body: JSON.stringify(body) }),
  daypartPresets: (): Promise<{ presets: DaypartPreset[] }> => req('/daypart-presets'),
  job: (id: string): Promise<JobRow & { attempts: any[] }> => req(`/jobs/${id}`),
  jobs: (p: { type?: string; state?: string; channelId?: string } = {}): Promise<{ jobs: JobRow[] }> => {
    const qs = new URLSearchParams()
    for (const [k, v] of Object.entries(p)) if (v) qs.set(k, String(v))
    return req('/jobs' + (qs.toString() ? '?' + qs : ''))
  },
  retryJob: (id: string) => req(`/jobs/${id}/retry`, { method: 'POST' }),
  cancelJob: (id: string) => req(`/jobs/${id}/cancel`, { method: 'POST' }),
  recordingSources: (p: RecordingSourceQuery = {}): Promise<RecordingSourcesFeed> => {
    const qs = new URLSearchParams()
    for (const [k, v] of Object.entries(p)) if (v != null && v !== '') qs.set(k, String(v))
    return req('/recordings/sources' + (qs.toString() ? '?' + qs : ''))
  },
  recordings: (p: { kind?: string; channelId?: string; sourceId?: string; q?: string } = {}): Promise<RecordingRow[]> => {
    const qs = new URLSearchParams()
    if (p.kind) qs.set('kind', p.kind)
    if (p.channelId) qs.set('channelId', p.channelId)
    if (p.sourceId) qs.set('sourceId', p.sourceId)
    if (p.q) qs.set('q', p.q)
    return req('/recordings' + (qs.toString() ? '?' + qs : ''))
  },
  // transcript probe/search: no q = languages + entry count (add from/to for the
  // cues in that window); with q = timed matches across the whole recording
  recordingTranscript: (id: string, p: { q?: string; lang?: string; from?: number; to?: number } = {}): Promise<TranscriptSearch> => {
    const qs = new URLSearchParams()
    if (p.q) qs.set('q', p.q)
    if (p.lang) qs.set('lang', p.lang)
    if (p.from != null) qs.set('from', String(Math.round(p.from)))
    if (p.to != null) qs.set('to', String(Math.round(p.to)))
    return req(`/recordings/${id}/transcript` + (qs.toString() ? '?' + qs : ''))
  },
  recordingProgrammes: (id: string, p: { from?: number; to?: number; limit?: number } = {}): Promise<{ window?: { from: number; to: number }; programmes: RecordingProgramme[] }> => {
    const qs = new URLSearchParams()
    if (p.from != null) qs.set('from', String(Math.round(p.from)))
    if (p.to != null) qs.set('to', String(Math.round(p.to)))
    if (p.limit) qs.set('limit', String(p.limit))
    return req(`/recordings/${id}/programmes` + (qs.toString() ? '?' + qs : ''))
  },
  /** Audio envelope for the clipping timeline over [from..to] in `buckets` columns. */
  recordingWaveform: (id: string, from: number, to: number, buckets: number): Promise<Waveform> =>
    req(`/recordings/${id}/waveform?from=${Math.round(from)}&to=${Math.round(to)}&buckets=${Math.round(buckets)}`),
  recording: (id: string): Promise<RecordingRow & { vod_assets: VodAssetRow[] }> => req(`/recordings/${id}`),
  recordingTimeline: (id: string): Promise<RecordingTimeline> => req(`/recordings/${id}/timeline`),
  clipRecording: (id: string, b: { title: string; startMs: number; endMs: number; outputKind?: 'manifest' | 'progressive' | 'both'; acceptGapsMs?: number }): Promise<VodAssetRow> =>
    req(`/recordings/${id}/clip`, { method: 'POST', body: JSON.stringify(b) }),
  publishRecording: (id: string, title?: string): Promise<VodAssetRow> =>
    req(`/recordings/${id}/publish`, { method: 'POST', body: JSON.stringify({ title }) }),
  // ---- media lifecycle ----
  storageCapabilities: (): Promise<StorageCapabilities> => req('/storage/capabilities'),
  mediaObjects: (q: { limit?: number; state?: string; channelId?: string; recordingId?: string } = {}):
    Promise<{ objects: MediaObjectRow[]; count: number }> => {
    const p = new URLSearchParams()
    if (q.limit) p.set('limit', String(q.limit))
    if (q.state) p.set('state', q.state)
    if (q.channelId) p.set('channelId', q.channelId)
    if (q.recordingId) p.set('recordingId', q.recordingId)
    return req(`/storage/objects?${p.toString()}`)
  },
  mediaObject: (id: string): Promise<any> => req(`/storage/objects/${id}`),
  restoreMedia: (id: string, speed?: 'expedited' | 'standard' | 'bulk'): Promise<any> =>
    req(`/storage/objects/${id}/restore`, { method: 'POST', body: JSON.stringify({ speed }) }),
  holdMedia: (id: string, hold: boolean, reason?: string): Promise<MediaObjectRow> =>
    req(`/storage/objects/${id}/hold`, { method: 'POST', body: JSON.stringify({ hold, reason }) }),
  retentionRules: (): Promise<{ rules: RetentionRuleRow[]; capabilities: StorageCapabilities }> =>
    req('/storage/retention'),
  saveRetentionRule: (b: {
    ruleId?: string; name: string; channelId?: string; eventId?: string
    accountScope?: boolean; appliesTo?: 'recording' | 'asset' | 'both'
    stages: RetentionStageInput[]
  }): Promise<RetentionRuleRow> => req('/storage/retention', { method: 'PUT', body: JSON.stringify(b) }),
  previewSweep: (): Promise<SweepPreview> => req('/storage/retention/preview', { method: 'POST' }),

  /** Export the whole recording for download. Video comes back as MP4; an
   *  audio-only recording as MP3 with the M4A (AAC as broadcast) alongside. */
  recordingDownload: (id: string, acceptGapsMs?: number): Promise<{
    status: 'exporting' | 'ready'; kind?: 'audio' | 'video'; format?: 'mp3' | 'mp4'
    url?: string; message?: string; alternatives?: { format: string; label: string; url: string }[]
  }> =>
    req(`/recordings/${id}/download${acceptGapsMs != null ? `?acceptGaps=${Math.round(acceptGapsMs)}` : ''}`),
  // ---- content types (metadata schemas) ----
  contentTypes: (appliesTo?: 'radio' | 'tv' | 'event' | 'vod'): Promise<ContentType[]> =>
    req('/metadata-schemas' + (appliesTo ? `?appliesTo=${appliesTo}` : '')),
  contentType: (id: string): Promise<ContentType> => req(`/metadata-schemas/${id}`),
  contentTypeFields: (id: string): Promise<{ targetKind: string; fields: SchemaField[] }> => req(`/metadata-schemas/${id}/effective-fields`),
  createContentType: (b: ContentTypeBody): Promise<ContentType> => req('/metadata-schemas', { method: 'POST', body: JSON.stringify(b) }),
  patchContentType: (id: string, b: Partial<ContentTypeBody>): Promise<ContentType> => req(`/metadata-schemas/${id}`, { method: 'PATCH', body: JSON.stringify(b) }),
  deleteContentType: (id: string) => req(`/metadata-schemas/${id}`, { method: 'DELETE' }),
  ownerDefaults: (owner: { kind: 'channel' | 'event'; id: string }): Promise<OwnerBaseEntry> =>
    req(`/epg/owner-defaults?${owner.kind === 'event' ? 'eventId' : 'channelId'}=${owner.id}`),


  // ---- ingest framework ----
  ingestBaseline: (): Promise<{ baseline: Required<IngestThen>; keys: string[]; events: string[] }> => req('/ingest/baseline'),
  ingestRules: (): Promise<IngestRule[]> => req('/ingest/rules'),
  createIngestRule: (b: Partial<IngestRule>): Promise<IngestRule> => req('/ingest/rules', { method: 'POST', body: JSON.stringify(b) }),
  updateIngestRule: (id: string, b: Partial<IngestRule>): Promise<IngestRule> => req(`/ingest/rules/${id}`, { method: 'PATCH', body: JSON.stringify(b) }),
  deleteIngestRule: (id: string) => req(`/ingest/rules/${id}`, { method: 'DELETE' }),
  ingestPreview: (b: { files: { name: string; bytes?: number; relativePath?: string | null; mime?: string | null }[]; source?: string; contentTypeId?: string | null; item?: IngestThen }): Promise<IngestPreviewRow[]> =>
    req('/ingest/preview', { method: 'POST', body: JSON.stringify(b) }),
  ingestHeld: (): Promise<IngestHeld[]> => req('/ingest/held'),
  ingestSetMetadata: (assetId: string, metadata: Record<string, any>): Promise<{ missing: string[]; ingested: boolean }> =>
    req(`/ingest/assets/${assetId}/metadata`, { method: 'POST', body: JSON.stringify({ metadata }) }),
  ingestResolveDuplicate: (assetId: string, action: 'skip' | 'version' | 'replace'): Promise<{ status: string }> =>
    req(`/ingest/assets/${assetId}/duplicate`, { method: 'POST', body: JSON.stringify({ action }) }),
  ingestRemote: (b: { ref: { provider: 'url' | 'dropbox' | 'onedrive' | 'gdrive'; ref: string; token?: string | null; headers?: Record<string, string> }; name?: string; bytes?: number; relativePath?: string | null; schemaId?: string | null; metadata?: Record<string, any>; providerAccountId?: string | null }): Promise<{ sessionId: string; assetId: string | null; jobId: string; name: string; bytes: number | null; ranges: boolean; transfer: 'cloud' }> =>
    req('/ingest/remote', { method: 'POST', body: JSON.stringify(b) }),
  ingestLocate: (files: { name: string; bytes?: number; relativePath?: string | null }[]): Promise<{ name: string; hit: { ref: { provider: string; ref: string }; name: string; bytes: number | null; path?: string | null; strength: string; providerAccountId: string; label: string } | null }[]> =>
    req('/ingest/locate', { method: 'POST', body: JSON.stringify({ files }) }),
  ingestProviders: (): Promise<{ linked: { id: string; provider: string; label: string; expiresAt: string | null }[]; available: { provider: string; configured: boolean }[] }> => req('/ingest/providers'),
  ingestProviderAuthorize: (provider: string): Promise<{ url: string }> => req(`/ingest/providers/${provider}/authorize`),
  addIngestProvider: (b: { provider: 'aspera' | 'masv' | 'signiant'; label: string; config: Record<string, any> }): Promise<{ id: string }> => req('/ingest/providers', { method: 'POST', body: JSON.stringify(b) }),
  deleteIngestProvider: (id: string) => req(`/ingest/providers/${id}`, { method: 'DELETE' }),
  ingestTransfers: (): Promise<IngestTransfer[]> => req('/ingest/transfers'),
  createIngestTransfer: (b: { provider: 'aspera' | 'masv' | 'signiant' | 's3accel'; files: { name: string; bytes?: number | null; relativePath?: string | null }[]; providerAccountId?: string | null }): Promise<IngestTransfer> =>
    req('/ingest/transfers', { method: 'POST', body: JSON.stringify(b) }),
  ingestWebhooks: (): Promise<IngestWebhook[]> => req('/ingest/webhooks'),
  createIngestWebhook: (b: { name: string; url: string; events?: string[] }): Promise<IngestWebhook> => req('/ingest/webhooks', { method: 'POST', body: JSON.stringify(b) }),
  updateIngestWebhook: (id: string, b: Partial<IngestWebhook>): Promise<IngestWebhook> => req(`/ingest/webhooks/${id}`, { method: 'PATCH', body: JSON.stringify(b) }),
  deleteIngestWebhook: (id: string) => req(`/ingest/webhooks/${id}`, { method: 'DELETE' }),

  // ---- publishing rules (the ladder) + availability ----
  publishingRules: (): Promise<PublishingRule[]> => req('/publishing-rules'),
  publishingPoints: (): Promise<PublishingPoints> => req('/publishing-rules/points'),
  publishingRule: (scopeKind: RuleScope, scopeId?: string | null): Promise<PublishingRule & { missing?: boolean }> =>
    req(`/publishing-rules/${scopeKind}${scopeId ? '/' + scopeId : ''}`),
  putPublishingRule: (scopeKind: RuleScope, scopeId: string | null, settings: RuleSettings): Promise<PublishingRule> =>
    req(`/publishing-rules/${scopeKind}${scopeId ? '/' + scopeId : ''}`, { method: 'PUT', body: JSON.stringify({ settings }) }),
  deletePublishingRule: (scopeKind: RuleScope, scopeId: string) =>
    req(`/publishing-rules/${scopeKind}/${scopeId}`, { method: 'DELETE' }),
  resolvePublishing: (q: { assetId?: string; schemaId?: string | null; channelId?: string | null; eventId?: string | null }): Promise<ResolvedRules> => {
    const qs = new URLSearchParams()
    for (const [k, v] of Object.entries(q)) if (v) qs.set(k, v)
    return req('/publishing-rules/resolve?' + qs)
  },
  // ---- payments ----
  paymentProviders: (): Promise<{ providers: PaymentProviderRow[]; available: string[]; webhookBase: string }> => req('/payments/providers'),
  putPaymentProvider: (provider: string, b: { config: Record<string, any>; secretRef?: string | null; enabled: boolean }): Promise<PaymentProviderRow> =>
    req(`/payments/providers/${provider}`, { method: 'PUT', body: JSON.stringify(b) }),
  products: (): Promise<ProductRow[]> => req('/payments/products'),
  patchProduct: (id: string, b: { providerIds?: Record<string, string>; enabled?: boolean; name?: string }): Promise<ProductRow> =>
    req(`/payments/products/${id}`, { method: 'PATCH', body: JSON.stringify(b) }),
  viewerAccount: (externalId: string): Promise<{ viewer: any; purchases: any[]; entitlements: any[]; active: any[] }> =>
    req(`/payments/viewers/${encodeURIComponent(externalId)}`),
  grantEntitlement: (b: { viewerExternalId: string; productKey: string; validUntil?: string | null }) =>
    req('/payments/grants', { method: 'POST', body: JSON.stringify(b) }),
  recordManualPayment: (b: { viewerExternalId: string; productKey: string; reference?: string; amountCents?: number; currency?: string }) =>
    req('/payments/manual', { method: 'POST', body: JSON.stringify(b) }),
  vodAvailability: (id: string): Promise<AssetAvailability> => req(`/vod/${id}/availability`),
  setVodAvailability: (id: string, override: RuleSettings): Promise<{ override: RuleSettings; reapplied: boolean; state: string }> =>
    req(`/vod/${id}/availability`, { method: 'PATCH', body: JSON.stringify({ override }) }),
  publishVod: (id: string, targets?: PublishTarget[]): Promise<{ state: string; publications: any[] }> =>
    req(`/vod/${id}/publish`, { method: 'POST', body: JSON.stringify(targets ? { targets } : {}) }),
  withdrawVod: (id: string, reason?: string): Promise<VodAssetRow> =>
    req(`/vod/${id}/withdraw`, { method: 'POST', body: JSON.stringify({ reason }) }),

  // ---- VOD library ----
  vodAssets: (published?: boolean): Promise<VodAssetRow[]> =>
    req(`/vod${published === undefined ? '' : `?published=${published}`}`),
  vodAsset: (id: string): Promise<any> => req(`/vod/${id}`),
  // Skip markers (intro, recap, credits): editable any time, written into the
  // on-demand playlists when they are served.
  vodMarkers: (id: string): Promise<VodMarkersView> => req(`/vod/${id}/markers`),
  setVodMarker: (id: string, kind: VodMarkerKind, startMs: number, endMs: number): Promise<VodMarker> =>
    req(`/vod/${id}/markers/${kind}`, { method: 'PUT', body: JSON.stringify({ startMs, endMs }) }),
  acceptVodMarker: (id: string, kind: VodMarkerKind): Promise<VodMarker> =>
    req(`/vod/${id}/markers/${kind}/accept`, { method: 'POST' }),
  deleteVodMarker: (id: string, kind: VodMarkerKind): Promise<void> =>
    req(`/vod/${id}/markers/${kind}`, { method: 'DELETE' }),
  detectVodMarkers: (id: string): Promise<{ queued: boolean }> =>
    req(`/vod/${id}/markers/detect`, { method: 'POST' }),
  patchVodAsset: (id: string, b: { title?: string; published?: boolean; schemaId?: string | null; metadata?: Record<string, any> }): Promise<any> =>
    req(`/vod/${id}`, { method: 'PUT', body: JSON.stringify(b) }),
  publishToPortal: (id: string): Promise<any> =>
    req(`/publications/vod/${id}/publish`, { method: 'POST', body: JSON.stringify({ platform: 'portal' }) }),

  // ---- loops & fillers ----
  fillerAssets: (kind?: 'slate' | 'loop'): Promise<FillerAsset[]> =>
    req(`/filler-assets${kind ? `?kind=${kind}` : ''}`),
  patchFillerAsset: (id: string, b: { name?: string }): Promise<FillerAsset> =>
    req(`/filler-assets/${id}`, { method: 'PATCH', body: JSON.stringify(b) }),
  deleteFillerAsset: (id: string): Promise<null> =>
    req(`/filler-assets/${id}`, { method: 'DELETE' }),

  // ---- monitoring ----
  /** The whole live board in one request: the fan-out lives on the server. */
  liveBoard: (): Promise<LiveBoard> => req('/monitoring/live'),
  /** The Live Streams Timeline view: every visible stream on one clock, one
   *  page of up to 50 rows per call (TIMELINE_MODE.md). Follow `next` for more. */
  timelineSelection: (kind: TimelineGridKind, id: string, fromMs: number, toMs: number): Promise<TimelineSelection> =>
    req(`/timeline/selection?kind=${kind}&id=${encodeURIComponent(id)}&from=${Math.round(fromMs)}&to=${Math.round(toMs)}`),
  timelineGrid: (p: TimelineGridQuery): Promise<TimelineGrid> => {
    const q = new URLSearchParams({ from: p.from, to: p.to })
    if (p.kinds?.length) q.set('kinds', p.kinds.join(','))
    if (p.groupId) q.set('groupId', p.groupId)
    if (p.cursor) q.set('cursor', p.cursor)
    if (p.limit) q.set('limit', String(p.limit))
    return req(`/timeline/grid?${q.toString()}`)
  },
  /** Problems, ranked, across every subsystem that can quietly go wrong. */
  monitoringOverview: (): Promise<MonitoringOverview> => req('/monitoring/overview'),

  // ---- embeddable player ----
  /** The effective config for a station's player, plus the layouts on offer. */
  playerConfig: (channelId: string): Promise<PlayerConfigResponse> =>
    req(`/player-config/${encodeURIComponent(channelId)}`),
  savePlayerConfig: (channelId: string, body: Partial<PlayerConfig>): Promise<PlayerConfig> =>
    req(`/player-config/${encodeURIComponent(channelId)}`, { method: 'PUT', body: JSON.stringify(body) }),
  /** Player health: did it load, did it error, and on which site. */
  playerReport: (channelId: string, hours = 24): Promise<PlayerReport> =>
    req(`/player-config/${encodeURIComponent(channelId)}/report?hours=${Math.round(hours)}`),

  // ---- fleet ----
  /** Servers carrying this tenant's live work, with their latest readings. */
  fleetHosts: (): Promise<{ hosts: FleetHost[] }> => req('/fleet/hosts'),
  /** Billable TIME. Not money: the rate table is indicative and stays server side. */
  fleetUsage: (period: 'day' | 'week' | 'month' | 'year' = 'day', limit = 30): Promise<FleetUsage> =>
    req(`/fleet/usage?period=${period}&limit=${Math.round(limit)}`),
  /** One stream's usage, for the detail pages. */
  streamUsage: (id: string): Promise<StreamUsage> => req(`/fleet/usage/stream/${encodeURIComponent(id)}`),
  /** Recent telemetry for one host, oldest first, for a sparkline. */
  hostSamples: (id: string): Promise<{ samples: Array<HostMetrics & { tasks: number | null }> }> =>
    req(`/fleet/hosts/${encodeURIComponent(id)}/samples`),

  // ---- analytics ----
  /** The whole reporting page in one read, from rollups only. */
  analyticsOverview: (days = 30): Promise<AnalyticsOverview> =>
    req(`/analytics/overview?days=${Math.round(days)}`),
  /** Concurrency NOW. Goes stale in seconds, so the page polls it. */
  analyticsRealtime: (): Promise<{ total_concurrent: number; streams: LiveStreamRow[] }> =>
    req('/analytics/realtime'),

  // ---- analytics retention ----
  analyticsRetention: (): Promise<AnalyticsRetention> => req('/analytics/retention'),
  setAnalyticsRetention: (rawRetentionDays: number | null): Promise<AnalyticsRetention> =>
    req('/analytics/retention', { method: 'PUT', body: JSON.stringify({ rawRetentionDays }) }),
  sweepAnalyticsRetention: (): Promise<any> =>
    req('/analytics/retention/sweep', { method: 'POST' }),

  // ---- review and QC ----
  reviewQueue: (): Promise<{ queue: ReviewQueueRow[]; count: number }> => req('/vod/review/queue'),
  assetReview: (id: string): Promise<AssetReview> => req(`/vod/${id}/review`),
  decideReview: (id: string, to: ReviewStateId, note?: string): Promise<any> =>
    req(`/vod/${id}/review`, { method: 'POST', body: JSON.stringify({ to, note }) }),
  rerunQc: (id: string): Promise<{ jobId: string; state: string }> =>
    req(`/vod/${id}/qc`, { method: 'POST' }),

  /** Keyframe thumbnails across a window: the video half of the media lane. */
  channelThumbs: (id: string, from: number, to: number, count: number, prime = true): Promise<ThumbStrip> =>
    req(`/channels/${id}/thumbs?from=${Math.round(from)}&to=${Math.round(to)}&count=${count}${prime ? '&prime=1' : ''}`),
  /** What a finished clip was built from, back to the physical segments. */
  clipProvenance: (assetId: string): Promise<ClipProvenance> => req(`/vod/${assetId}/provenance`),
  /** The reverse: what a capture produced, and whether it is safe to prune. */
  recordingDerived: (id: string): Promise<DerivedAssets> => req(`/recordings/${id}/derived`),

  fileFolders: (): Promise<{ folders: { path: string; name: string; count: number }[] }> => req('/files/folders'),
  createFolder: (path: string): Promise<{ path: string }> => req('/files/folders', { method: 'POST', body: JSON.stringify({ path }) }),
  uploadFile: (b: { folder?: string; name: string; kind?: string; contentType?: string; tags?: string[]; dataBase64: string }): Promise<MediaFile> =>
    req('/files', { method: 'POST', body: JSON.stringify(b) }),
  patchFile: (id: string, b: { name?: string; folder?: string; kind?: string; tags?: string[]; version?: number }): Promise<MediaFile> =>
    req(`/files/${id}`, { method: 'PATCH', body: JSON.stringify(b) }),
  // ---- radio: audio-only stations (channels with kind='radio') ----
  radioStations: (): Promise<RadioStationRow[]> => req('/radio'),
  radioStation: (id: string): Promise<RadioStationDetail> => req(`/radio/${id}`),
  radioStartStop: (id: string, action: 'start' | 'stop') =>
    req(`/radio/${id}/${action}`, { method: 'POST' }),
  /** Put down a give-up notice without starting the station. Also stands the
   *  stream down, because clearing the give-up alone would re-arm auto connect
   *  against a source that is still broken. */
  radioClearRecovery: (id: string) =>
    req(`/radio/${id}/clear-recovery`, { method: 'POST' }),
  /** Empty this station's event log. The server writes one `log.cleared` entry
   *  straight afterwards, so a cleared log never reads as a log of nothing. */
  radioClearLog: (id: string): Promise<{ id: string; removed: number; log: any[] }> =>
    req(`/radio/${id}/events`, { method: 'DELETE' }),
  // second, explicit step: open/close PUBLIC delivery (same contract as channels)
  radioSetAir: (id: string, on: boolean): Promise<{ id: string; on_air: boolean; publicUrls: RadioOutputs | null }> =>
    req(`/radio/${id}/air`, { method: 'POST', body: JSON.stringify({ on }) }),
  // server-measured levels: the visualiser moves whether or not anyone listens
  radioLevels: (id: string, limit = 30): Promise<RadioLevelsFeed> => req(`/radio/${id}/levels?limit=${limit}`),
  radioQc: (id: string): Promise<{ stationId: string; health: PipelineHealth; qc: RadioQc; statusBoard: Record<string, string> }> =>
    req(`/radio/${id}/qc`),
  radioEvents: (id: string): Promise<{ stationId: string; entries: { ts: string; level: string; title: string; detail: string }[] }> =>
    req(`/radio/${id}/events`),
  radioNowPlaying: (id: string): Promise<RadioNowPlaying> => req(`/radio/${id}/nowplaying`),
  radioLog: (id: string, p: { from?: string; to?: string; q?: string; class?: RadioClass; limit?: number; offset?: number; minSec?: number; sort?: 'newest' | 'oldest' | 'longest' | 'title' } = {}): Promise<RadioLog> => {
    const qs = new URLSearchParams()
    if (p.from) qs.set('from', p.from)
    if (p.to) qs.set('to', p.to)
    if (p.q) qs.set('q', p.q)
    if (p.class) qs.set('class', p.class)
    if (p.limit) qs.set('limit', String(p.limit))
    if (p.offset) qs.set('offset', String(p.offset))
    if (p.minSec) qs.set('minSec', String(p.minSec))
    if (p.sort) qs.set('sort', p.sort)
    return req(`/radio/${id}/log` + (qs.toString() ? '?' + qs : ''))
  },

  // ---- admin: who am I + access model (drives nav/button gating) ----
  me: (): Promise<Me> => req('/auth/me'),

  // ---- admin: user management (admin+ only) ----
  users: (): Promise<UserRow[]> => req('/users'),
  user: (id: string): Promise<UserRow & { access: Record<string, AccessLevel>; manageable: boolean; security?: SecurityBrief | null }> => req(`/users/${id}`),
  createUser: (b: { email: string; password: string; role?: TenantRole; roleIds?: string[]; displayName?: string; userGroupId?: string | null }): Promise<UserRow> =>
    req('/users', { method: 'POST', body: JSON.stringify(b) }),
  patchUser: (id: string, b: { role?: TenantRole; status?: 'active' | 'disabled'; roleIds?: string[]; displayName?: string | null; userGroupId?: string | null }): Promise<UserRow> =>
    req(`/users/${id}`, { method: 'PATCH', body: JSON.stringify(b) }),
  setUserPassword: (id: string, password: string): Promise<null> =>
    req(`/users/${id}/password`, { method: 'POST', body: JSON.stringify({ password }) }),
  deleteUser: (id: string): Promise<null> => req(`/users/${id}`, { method: 'DELETE' }),
  changeMyPassword: (current: string, next: string): Promise<null> =>
    req('/auth/password', { method: 'POST', body: JSON.stringify({ current, next }) }),
  copyAccessRole: (id: string, name?: string): Promise<UserGroupRow> =>
    req(`/access-roles/${id}/copy`, { method: 'POST', body: JSON.stringify({ name }) }),

  // ---- admin: public users (viewers) ----
  viewers: (q = '', status = ''): Promise<{ total: number; items: ViewerRow[] }> =>
    req(`/viewers?limit=100${q ? '&q=' + encodeURIComponent(q) : ''}${status ? '&status=' + status : ''}`),
  viewer: (id: string): Promise<ViewerDetail> => req(`/viewers/${id}`),
  patchViewer: (id: string, b: { status?: 'active' | 'disabled'; groups?: string[]; displayName?: string | null }): Promise<ViewerRow> =>
    req(`/viewers/${id}`, { method: 'PATCH', body: JSON.stringify(b) }),
  signOutViewer: (id: string): Promise<null> => req(`/viewers/${id}/sign-out`, { method: 'POST' }),
  deleteViewer: (id: string): Promise<null> => req(`/viewers/${id}`, { method: 'DELETE' }),

  // ---- platform step-up (authenticator code) ----
  platformStepUp: (code?: string): Promise<{ enroll?: boolean; secret?: string; otpauthUri?: string; mfa_required?: boolean; accessToken?: string; expiresIn?: number }> =>
    req('/platform/auth/step-up', { method: 'POST', body: JSON.stringify(code ? { code } : {}) }),

  // ---- admin: user groups (per-feature access none/view/manage) ----
  userGroups: (): Promise<UserGroupRow[]> => req('/user-groups'),
  accessCatalogue: (): Promise<{ levels: AccessLevel[]; notes: string[]; catalogue: { key: string; label: string; area: 'content' | 'insight' | 'admin'; operate: string | null }[] }> =>
    req('/user-groups/catalogue'),
  createUserGroup: (b: { name: string; description?: string; tier?: 'operator' | 'viewer'; permissions: Record<string, AccessLevel> }): Promise<UserGroupRow> =>
    req('/user-groups', { method: 'POST', body: JSON.stringify(b) }),
  patchUserGroup: (id: string, b: { name?: string; description?: string | null; tier?: 'operator' | 'viewer'; permissions?: Record<string, AccessLevel> }): Promise<UserGroupRow> =>
    req(`/user-groups/${id}`, { method: 'PATCH', body: JSON.stringify(b) }),
  deleteUserGroup: async (id: string): Promise<void> => {
    const r = await fetch('/api/user-groups/' + id, { method: 'DELETE', headers: { authorization: `Bearer ${getToken()}` } })
    if (!r.ok && r.status !== 204) throw new Error(String(r.status))
  },

  // ---- admin: apps & API keys ----
  apps: (): Promise<AppReg[]> => req('/apps'),
  app: (id: string): Promise<AppReg & { keys: ApiKeyRow[] }> => req(`/apps/${id}`),
  createApp: (b: { name: string; type: AppType; restrictions?: Record<string, any> }): Promise<AppReg & { publishableKey: MintedKey }> =>
    req('/apps', { method: 'POST', body: JSON.stringify(b) }),
  updateApp: (id: string, b: { name?: string; restrictions?: Record<string, any>; enabled?: boolean }): Promise<AppReg> =>
    req(`/apps/${id}`, { method: 'PUT', body: JSON.stringify(b) }),
  rotateAppKey: (id: string): Promise<MintedKey> => req(`/apps/${id}/keys`, { method: 'POST' }),
  revokeApiKey: async (keyId: string): Promise<void> => {
    const r = await fetch('/api/apps/keys/' + keyId, { method: 'DELETE', headers: { authorization: `Bearer ${getToken()}` } })
    if (!r.ok && r.status !== 204) throw new Error(String(r.status))
  },
  createSecretKey: (): Promise<MintedKey> => req('/apps/secret-keys', { method: 'POST' }),
  allKeys: (): Promise<AccountKeyRow[]> => req('/apps/keys'),

  // ---- platform (system admin): client accounts ----
  platformAccounts: (): Promise<PlatformAccountRow[]> => req('/platform/accounts'),
  platformCreateAccount: (b: {
    name: string; planTier?: 'standard' | 'pro' | 'enterprise'
    maxChannels?: number; maxConcurrentSources?: number
    ownerEmail: string; ownerPassword: string
  }): Promise<{ account: PlatformAccountRow; owner: { id: string; email: string }; credentials: { email: string; password: string }; note: string }> =>
    req('/platform/accounts', { method: 'POST', body: JSON.stringify(b) }),
  platformPatchAccount: (id: string, b: {
    name?: string; planTier?: 'standard' | 'pro' | 'enterprise'
    maxChannels?: number; maxConcurrentSources?: number; status?: 'active' | 'suspended'
  }): Promise<PlatformAccountRow> => req(`/platform/accounts/${id}`, { method: 'PATCH', body: JSON.stringify(b) }),
  /** An account's groups: each ties channels to a transcode or packaging profile. */
  platformAccountGroups: (id: string): Promise<PlatformGroupRow[]> => req(`/platform/accounts/${id}/groups`),
  platformAddGroup: (id: string, b: { name: string; workflowType: 'transcode' | 'package_only'; maxChannels?: number; maxConcurrent?: number }): Promise<PlatformGroupRow> =>
    req(`/platform/accounts/${id}/groups`, { method: 'POST', body: JSON.stringify(b) }),
  platformEditGroup: (id: string, gid: string, b: { name?: string; maxChannels?: number; maxConcurrent?: number }): Promise<PlatformGroupRow> =>
    req(`/platform/accounts/${id}/groups/${gid}`, { method: 'PATCH', body: JSON.stringify(b) }),
  platformDeleteGroup: (id: string, gid: string): Promise<null> =>
    req(`/platform/accounts/${id}/groups/${gid}`, { method: 'DELETE' }),

  deleteFile: async (id: string, opts: { confirm?: boolean; force?: boolean } = {}): Promise<{ ok: boolean; status: number; body?: any }> => {
    const qs = new URLSearchParams()
    if (opts.confirm) qs.set('confirm', 'true')
    if (opts.force) qs.set('force', 'true')
    const r = await fetch('/api/files/' + id + (qs.toString() ? '?' + qs : ''), {
      method: 'DELETE', headers: { authorization: `Bearer ${getToken()}` },
    })
    if (r.status === 204) return { ok: true, status: 204 }
    let body: any = null; try { body = await r.json() } catch { /* */ }
    return { ok: false, status: r.status, body }
  },
}

// ---- radio types --------------------------------------------------------------
export type RadioClass = 'song' | 'ad' | 'content'
export interface RadioOutputsCfg { mp3?: boolean; hls?: boolean; dash?: boolean }
export interface RadioCfg {
  outputs?: RadioOutputsCfg
  bitrateKbps?: number
  metadataCapture?: boolean
  transcode?: boolean
  transcription?: boolean
}
export interface RadioPipelineState {
  running: boolean; runId?: string; startedAt?: number
  sourceCodec?: string | null; listeners?: number
  icy?: RadioIcyState | null
}
export interface RadioIcyState {
  connected: boolean
  station: { name?: string; genre?: string; url?: string; bitrateKbps?: number; contentType?: string }
  title: string | null; streamUrl: string | null
  class: RadioClass | null; since: number | null; changes: number; lastError: string | null
}
export type SignalVerdict = 'audio' | 'quiet' | 'silent' | 'static' | 'unknown'
export interface RadioOutputs {
  mp3: string | null; hls: string | null; dash: string | null
  /**
   * Outputs the RUNNING encoder dropped, as {output: reason}. A null URL above
   * together with an entry here means "asked for, not being produced, and here
   * is why", which is a different thing from "not configured" and has to read
   * differently to an operator. Optional because the public-URL response does
   * not carry it.
   */
  degraded?: Record<string, string>
}
export interface RadioLevelSample {
  t: number; peakDb: number; rmsDb: number; crestDb: number
  entropy: number; silence: boolean; verdict: SignalVerdict
  frames: number[]     // ~100ms momentary loudness (EBU R128 M, LUFS)
  peaks?: number[]     // ~100ms true peak (dBFS) — this is what the waveform draws
}
export interface RadioLevelsFeed {
  stationId: string; running: boolean; verdict: SignalVerdict; lastSampleAt: number | null
  level: { peakDb: number; rmsDb: number; crestDb: number; entropy: number } | null
  samples: RadioLevelSample[]
}
export interface RadioQc {
  verdict: SignalVerdict; lastSampleAt: number | null
  checks: { ok: number; failed: number }
  issues: { code: string; message: string; at: number }[]
  segments: number; outputFreshMs: number | null
  silenceSinceMs: number | null; staticSinceMs: number | null
  level: { peakDb: number; rmsDb: number; crestDb: number; entropy: number } | null
}
export interface RadioStationRow {
  id: string; name: string; status: string; group_id: string; group_name?: string
  schema_id?: string | null; metadata?: Record<string, any>
  kind: 'radio'; radio_config: RadioCfg | null
  recording_enabled?: boolean; recording_retention_sec?: number | string | null
  brand_ref?: string | null; on_air?: boolean; created_at: string; version: number
  pipeline: RadioPipelineState
  /** Everyone receiving the station, across delivery paths. */
  listeners?: ListenerCounts
  /** Whether the SOURCE protocol can send a now-playing title at all. Decided
   *  on the server so the console does not keep a weaker second copy of the
   *  rule. Absent on a payload from an older API. */
  carriesTitles?: boolean
  nowPlaying: string | null; nowPlayingClass: RadioClass | null
  nowPlayingView?: NowPlayingView
  outputs: RadioOutputs
  publicUrls?: RadioOutputs
  pipelineState?: PipelineHealth['overall']
  onAir?: boolean
  signal?: SignalVerdict
}
export interface RadioLogEntry {
  id: string; title: string; starts_at: string; ends_at: string; status: string
  class: RadioClass | null; stream_url: string | null
}
export interface RadioStationDetail extends RadioStationRow {
  sources: { id: string; role: string; protocol: string; ingest_url: string | null; stream_key: string | null; status?: string }[]
  icy: RadioIcyState | null
  openRecording: { id: string; start_epoch_ms: number | string; status: string } | null
  recentLog: (RadioLogEntry & { metadata?: any })[]
  health: PipelineHealth
  qc: RadioQc
  statusBoard: Record<string, string>
  log: { ts: string; level: string; title: string; detail: string }[]
  publicAvailable: boolean
}
/** The resolved now-playing line. The server makes the four-way decision (see
 *  services/radio/nowPlaying.ts); the console only paints it, so the list, the
 *  detail payload and this poll cannot drift apart the way they did when the
 *  render site did `title || 'Untitled break'`. */
export type NowKind = 'off' | 'icy' | 'epg' | 'gap' | 'no_metadata'
export interface NowPlayingView { kind: NowKind; text: string; note: string | null }
/** Everyone receiving the station. `total` is the only figure that carries the
 *  bare word "listeners"; `mp3` alone is what the console used to show. */
export interface ListenerCounts { mp3: number; players: number; total: number }
export interface RadioNowPlaying {
  running: boolean
  /** THE TOTAL across delivery paths, not just the MP3 clients. */
  listeners: number
  listenerCounts?: ListenerCounts
  nowPlayingView?: NowPlayingView
  station: RadioIcyState['station'] | null
  title: string | null; class: RadioClass | null; since: number | null; streamUrl: string | null
  entry: { id: string; title: string; starts_at: string; metadata?: any } | null
}
export interface RadioLog {
  stationId: string; from: string; to: string
  counts: Partial<Record<RadioClass, number>>
  total?: number; offset?: number; limit?: number
  entries: RadioLogEntry[]
}

// ---- admin / access model types --------------------------------------------
export type TenantRole = 'viewer' | 'operator' | 'admin' | 'owner'
export type AccessLevel = 'none' | 'view' | 'operate' | 'manage'

export interface AccessFeature { key: string; label: string; area: 'content' | 'insight' | 'admin'; operate: string | null }
export interface AccessModel { tiers: TenantRole[]; levels: AccessLevel[]; features: AccessFeature[]; notes: string[] }

export type MfaMethod = 'totp' | 'email' | 'sms' | 'backup'
export interface Session { access: string; refresh?: string; expiresIn?: number; amr?: string[] }
/** What sign-in answers when a second step is due (ACCESS_CONTROL.md section 12). */
export interface MfaStep {
  mfaRequired?: true; mfaSetupRequired?: true; challenge: string
  /** methods set up (mfaRequired) */ methods?: MfaMethod[]
  /** methods that can be set up (mfaSetupRequired) */ available?: MfaMethod[]
  email?: string | null; phone?: string | null
}
export type LoginResult = Session | MfaStep
export const isMfaStep = (r: LoginResult): r is MfaStep => 'challenge' in r
export interface CodeSent { ok?: true; sentTo?: string; devCode?: string }
export interface SecuritySummary {
  email: string | null; emailVerified: boolean; phone: string | null; phoneVerified: boolean
  methods: MfaMethod[]; totp: { enabled: boolean }
  emailCodes: { enabled: boolean; available: boolean }; smsCodes: { enabled: boolean; available: boolean }
  backupCodesRemaining: number; required: boolean
}

export interface Me {
  kind?: 'admin'
  id: string; email?: string; displayName?: string | null
  emailVerified?: boolean
  mfa?: { methods: MfaMethod[]; required: boolean }
  /** The tier (owner > admin > operator > viewer). */
  role: string; tier?: string; status?: string
  platformRole?: string | null
  roles?: { id: string; name: string; key: string | null }[]
  userGroupId?: string | null; userGroupName?: string | null
  account?: { id: string; name: string; plan: string; status: string }
  /** Effective level per feature: the contract the console gates on. */
  permissions?: Record<string, AccessLevel>
  /** Same map, original name. */
  features: Record<string, AccessLevel>
  model: AccessModel
}

export interface UserRow {
  id: string; email: string; displayName?: string | null
  role: TenantRole; tier?: TenantRole; status: 'active' | 'disabled' | 'invited'
  is_platform?: boolean; isPlatform?: boolean
  /** two-step sign-in on (list rows) */ mfa?: boolean; emailVerified?: boolean
  roles?: { id: string; name: string; key: string | null }[]
  user_group_id: string | null; user_group_name?: string | null
  created_at: string
}

export interface UserGroupRow {
  id: string; name: string; description: string | null
  key?: string | null; system?: boolean; tier?: TenantRole
  permissions: Record<string, AccessLevel>
  member_count?: number; memberCount?: number
  created_at: string
}

export interface ViewerRow {
  id: string; email: string | null; displayName: string | null; externalId: string
  source: 'hosted' | 'external'; status: 'active' | 'disabled' | 'deleted'
  groups: string[]; emailVerified: boolean; createdAt: string; lastSeenAt: string | null
  mfa?: boolean
}
/** Another person's sign-in security, as an admin sees it (numbers masked). */
export interface SecurityBrief { emailVerified: boolean; phone: string | null; phoneVerified: boolean; methods: MfaMethod[]; backupCodesRemaining: number }
export interface ViewerDetail extends ViewerRow {
  security?: SecurityBrief | null
  entitlements: { grants: any; validUntil: string | null; productKey: string | null }[]
  purchases: { id: string; status: string; amount_cents: number | null; currency: string | null; purchased_at: string; product: string | null }[]
  activeSessions: number
}

export type AppType = 'web' | 'ios' | 'android' | 'tv' | 'roku' | 'server'
export interface AppReg {
  id: string; name: string; type: AppType
  restrictions: Record<string, any>; enabled: boolean
  created_at: string; updated_at?: string
}
export interface ApiKeyRow {
  id: string; key_prefix: string; kind: 'secret' | 'publishable'
  scopes: string[]; enabled: boolean
  last_used_at: string | null; request_count: number | string
  created_at?: string
}
/** A freshly minted key: `key` is the RAW value, shown once, never retrievable again. */
export interface MintedKey extends Omit<ApiKeyRow, 'enabled' | 'last_used_at' | 'request_count'> {
  key: string
}
export interface AccountKeyRow extends ApiKeyRow {
  app_id: string | null; app_name: string | null
}

export interface PlatformGroupRow {
  id: string; name: string; max_channels: number; max_concurrent: number
  profile_name: string | null; workflow_type: 'transcode' | 'package_only' | null
  rungs: { height: number; bitrate_kbps: number }[] | null; channel_count: number
}
export interface PlatformAccountRow {
  id: string; name: string; plan_tier: string
  max_channels: number; max_concurrent_sources?: number
  status?: 'active' | 'suspended'
  channels?: number | string; users?: number | string
  created_at?: string
}

export interface EventSourceRow {
  id?: string; role: 'primary' | 'backup'; protocol: string
  ingest_url: string | null; stream_key: string | null; status?: string
  rendition_label?: string | null; rendition_bitrate_kbps?: number | null
  params?: Record<string, string | number> | null
}
export interface EventRow {
  id: string; group_id: string; name: string; status: string
  schema_id?: string | null; metadata?: Record<string, any>
  scheduled_start: string; scheduled_end: string
  server_start: string | null; server_stop: string | null
  public_start: string | null; public_end: string | null
  actual_start?: string | null; actual_end?: string | null
  recording_enabled?: boolean
  recording_retention_days: number | null; recording_retention_sec?: number | null
  auto_vod?: boolean
  input_failover_enabled?: boolean; auto_failback?: boolean
  input_loss_behavior?: string; filler_slate_ref?: string | null
  version: number; created_at: string
  inputs?: EventSourceRow[]
}
export interface EventCreateBody {
  groupId: string; name: string
  scheduledStart: string; scheduledEnd: string
  serverStart?: string; serverStop?: string
  publicStart?: string; publicEnd?: string
  purchasingMode?: 'on_demand' | 'reserved' | 'spot_fallback'
  recordingEnabled?: boolean; recordingRetentionSec?: number | null
  autoVod?: boolean
  /** Put this back on air after a control-plane restart. Default true. */
  autoConnect?: boolean
  sources?: { role: 'primary' | 'backup'; protocol: string; ingestUrl?: string; streamKey?: string; renditionLabel?: string; renditionBitrateKbps?: number; params?: Record<string, string | number> }[]
  inputFailoverEnabled?: boolean; autoFailback?: boolean
  inputLossBehavior?: 'none' | 'slate' | 'vod_loop' | 'last_frame' | 'black'
  fillerSlateRef?: string | null
  /** Content type (required in practice: omitted = the standard Broadcast event). */
  schemaId?: string
  metadata?: Record<string, any>
}
export interface EventPatchBody extends Partial<Omit<EventCreateBody, 'groupId'>> { version?: number }

/**
 * Whose guide this is.
 *
 * 'radio' is a third kind at the PRODUCT level and not at the data level: a
 * station's programmes hang off `channel_id` exactly as a television channel's
 * do, so every query below folds radio into the channel branch. That is why the
 * ternaries read `kind === 'event' ? ... : channel` rather than switching on
 * three values — the split is about which page and which filter, not which
 * column.
 */
export interface EpgOwner { kind: 'channel' | 'radio' | 'event'; id: string }
export interface EpgOwnerRow {
  /** 'radio' is its own kind. The server derives it from channels.kind rather
   *  than emitting a literal, which is what used to bury every station in the
   *  Channels filter. */
  kind: 'channel' | 'radio' | 'event'; id: string; name: string; status: string
  /** The image the guide shows for it; null for events and for channels with none. */
  icon_ref: string | null
  programme_count: number; first_at: string | null; last_at: string | null
  auto_clip_count: number; next_title: string | null; next_at: string | null
}
/* ---- XMLTV export ---------------------------------------------------------- */
export interface GuideChannel {
  id: string; xmltvId: string; xmltvIdSet: boolean; name: string; medium: 'tv' | 'radio'
  icon: string | null; brandRef: string | null; description: string | null; language: string | null
  /** The image the guide uses, and where it came from (see services/guideIcon.ts). */
  iconRef: string | null; iconFrom: 'guide' | 'brand' | 'feed' | 'metadata' | null
  guideIconRef: string | null; feedIcon: string | null
  tz: string; epgEnabled: boolean
}
export interface XmltvFeedBody {
  name: string; channelIds: string[] | null; includeEvents: boolean
  pastDays: number; futureDays: number; timeBasis: 'scheduled' | 'asrun'; tzMode: 'local' | 'utc'
  lang: string | null; enabled: boolean
}
export interface XmltvFeed extends XmltvFeedBody {
  id: string; tokenPrefix: string; lastPolledAt: string | null; pollCount: number
  createdAt: string; updatedAt: string
}

export interface ProgrammeRow {
  id: string; channel_id: string | null; event_id: string | null
  title: string; starts_at: string; ends_at: string; status: string
  actual_start: string | null; actual_end: string | null
  auto_vod: boolean; geo_mode: 'worldwide' | 'allow' | 'block'; geo_countries: string[]
  replacement_kind: 'none' | 'slate' | 'loop' | 'vod'; replacement_ref: string | null
  clip_status: 'none' | 'firing' | 'created' | 'error'; clip_asset_id: string | null; clip_error: string | null
  metadata: Record<string, any>; series_id: string | null
  series_key?: string | null; series_date?: string | null; series_detached?: boolean
  source_ref?: string | null
}
/* ---- EPG repeats, copy rules and undo (volt-app services/epgPlace.ts) ---- */
export type EpgScope = 'this' | 'following' | 'series'
export type RepeatPolicy = 'replace' | 'skip' | 'keep'
export type RepeatWeekday = 'MO' | 'TU' | 'WE' | 'TH' | 'FR' | 'SA' | 'SU'
export interface RepeatRule { freq: 'daily' | 'weekdays' | 'weekly'; interval?: number; byDay?: RepeatWeekday[] }
export interface PlaceOutcome {
  date: string; title: string; startsAt: string; endsAt: string
  result: 'add' | 'replace' | 'skip' | 'exists'
  replaces?: { id: string; title: string; startsAt: string; fromRepeat: boolean; same?: boolean }[]
  overlaps?: string[]; reason?: string
}
export interface PlaceResult {
  summary: { added: number; replaced: number; takenOver?: number; skipped: number; existing: number; overlapsKept: number; dates: number; firstDate: string | null; lastDate: string | null }
  outcomes: PlaceOutcome[]; batchId: string | null
  seriesId?: string; describe?: string; openEnded?: boolean; tz?: string; sourceCount?: number
}
export interface EpgSeriesInfo {
  id: string; kind: 'programme' | 'day'; title: string; rule: RepeatRule; tz: string
  startDate: string; untilDate: string | null; policy: RepeatPolicy; sourceDate: string | null
  items: number; exdates: number; description: string; openEnded: boolean; upcoming: number; lastScheduled: string | null
}
export interface ProgrammeBody {
  title: string; startsAt: string; endsAt?: string
  /** For a repeat occurrence: which occurrences the change applies to. */
  scope?: EpgScope
  autoVod?: boolean
  geoMode?: 'worldwide' | 'allow' | 'block'; geoCountries?: string[]
  replacementKind?: 'none' | 'slate' | 'loop' | 'vod'; replacementRef?: string | null
  metadata?: Record<string, any>
}
export interface ProgrammeConflict {
  a_id: string; a_title: string; b_id: string; b_title: string
  overlap_start: string; overlap_end: string
}

/* ---- the VoD lifecycle of a programme ------------------------------------ */

/**
 * Where a slot is between "will be recorded" and "is a VOD asset".
 *
 *   manual       has not aired, and will NOT auto-convert
 *   scheduled    has not aired, and WILL auto-convert when it ends
 *   converting   the scheduler has claimed it right now
 *   converted    there is an asset
 *   failed       the automatic attempt errored; carries the reason
 *   convertible  AIRED, media still covers it, no asset. Still convertible,
 *                and the only state with a deadline attached
 *   unavailable  aired, and nothing on disk covers it any more
 */
export type VodState =
  | 'manual' | 'scheduled' | 'converting' | 'converted'
  | 'failed' | 'convertible' | 'unavailable'

export interface ProgrammeVod {
  id: string
  state: VodState
  coveragePct: number
  coveredMs: number
  assetId: string | null
  assetTitle: string | null
  assetState: string | null
  error: string | null
  /** When the material behind a convertible slot is due to be swept. Null
   *  means the owner keeps recordings indefinitely. */
  expiresAt: string | null
  future: boolean
}

export interface RecordingRow {
  id: string; kind: 'event' | 'channel_day' | string
  channel_id: string | null; event_id: string | null; source_name: string | null
  title: string | null; status: 'recording' | 'complete' | 'error' | string
  /** Derived server-side from the source, not from `kind`. */
  source_type?: RecordingSourceType
  start_epoch_ms: number | string; end_epoch_ms: number | string | null
  duration_ms: number | string | null; expires_at: string | null
  vod_count?: number
  matched_by?: 'title' | 'programme' | 'transcript' | null
}

export interface TranscriptSearch {
  recordingId: string
  languages: string[]
  entries: number
  matches: { tMs: number; endMs: number; lang: string; text: string; approx: boolean }[]
}

export interface RecordingProgramme {
  id: string; title: string; startMs: number; endMs: number; asRun: boolean; status: string
  /** radio now-playing entries carry song/ad/content; EPG programmes do not */
  class?: 'song' | 'ad' | 'content' | null
  source?: string
}

export interface WaveBucket { t: number; peak: number; rms: number }
export interface Waveform {
  streamId: string; from: number; to: number; bucketMs: number
  mode: 'exact' | 'sampled'
  complete: boolean; pending: number
  priming?: boolean       // a background pass is still measuring the recording
  /** Whole-recording background measurement: segments measured vs present. */
  progress?: { measured: number; total: number }
  /** This window: segments served from the cache vs segments present. */
  coverage?: { measured: number; total: number }
  buckets: (WaveBucket | null)[]
}

export interface RecordingTimeline {
  recordingId: string; streamId: string; kind: string; sourceName: string | null
  startMs: number; endMs: number | null; live: boolean; hasAudio: boolean
  audioOnly?: boolean   // radio recordings: player shows the audio visualiser
  spans: { runId: string; startMs: number; endMs: number; segments: number }[]
  /** Where the recording has NO media, so marks can avoid it (or cross it knowingly). */
  gaps?: RecordingGap[]
  missingMs?: number
  /** Where viewers were shown the channel's loop/slate instead of the source. The loop is
   *  never in the recording, so these sit over holes: what was on air in the hole. */
  fallbacks?: RecordingFallback[]
  fallbackMs?: number
}
export interface RecordingGap {
  fromMs: number; toMs: number; ms: number
  reason: 'between-runs' | 'missing-media' | 'no-recording'
  /** set when the hole was covered on air by the channel's loop or slate */
  onAir?: 'loop' | 'slate'
  onAirReason?: 'source-lost' | 'forced'
}
export interface RecordingFallback {
  fromMs: number; toMs: number; ms: number
  filler: 'loop' | 'slate'
  reason: 'source-lost' | 'forced'
  open: boolean
}


// ---- media lifecycle: what exists, where it lives, what happens next -------
export type StorageTierId =
  | 'local' | 's3_standard' | 's3_ia' | 's3_glacier_ir'
  | 's3_glacier_flexible' | 's3_deep_archive'
export type RetentionActionId = 'keep' | 'to_cold' | 'to_archive' | 'delete'

export interface StorageCapabilities {
  driver: 'local' | 's3'
  tiers: StorageTierId[]
  archiveEnabled: boolean
  actions: RetentionActionId[]
  defaultColdTier: StorageTierId | null
  defaultArchiveTier: StorageTierId | null
  /** Why archiving is unavailable, when it is. Shown rather than left to guess. */
  archiveUnavailableReason: string | null
  defaultLadder: { afterDays: number; action: RetentionActionId; targetTier?: StorageTierId | null }[]
}

export interface MediaLocationRow {
  id?: string; tier: StorageTierId; uri: string
  bytes: number | string | null; verified_at?: string | null
}

export interface MediaObjectRow {
  id: string
  logical_key: string
  kind: string
  rendition: string | null
  /** Can it be read right now, and if not what is happening. Separate from the
   *  TIER, which says where the bytes are and what reading them costs. */
  state: 'pending' | 'writing' | 'available' | 'archiving' | 'archived'
       | 'restoring' | 'restored' | 'deleting' | 'deleted'
  bytes: number | string | null
  duration_ms: number | string | null
  segment_count: number | null
  hold: boolean
  hold_reason: string | null
  restore_expected_by: string | null
  restore_expires_at: string | null
  source_name: string | null
  recording_title: string | null
  locations: MediaLocationRow[] | null
}

export interface RetentionStageInput {
  afterDays: number; action: RetentionActionId; targetTier?: StorageTierId | string
}

export interface RetentionRuleRow {
  id: string
  account_id: string | null; channel_id: string | null; event_id: string | null
  name: string; applies_to: 'recording' | 'asset' | 'both'; enabled: boolean
  stages: { id?: string; afterDays: number; action: RetentionActionId; targetTier: StorageTierId | null }[]
}

export interface SweepPreview {
  dryRun: boolean; considered: number; cooled: number; archived: number
  deleted: number; skippedOnHold: number; failed: number; unavailable: number
}

/** One frame of the video media lane's filmstrip. */
export interface Thumb {
  /** The instant the frame is actually FROM, not the slot it was asked for. */
  t: number
  url: string
  runId: string
  seq: number
}
export interface ThumbStrip {
  streamId: string
  from: number; to: number
  slotMs: number
  width: number; height: number
  complete: boolean
  pending: number
  priming: boolean
  thumbs: (Thumb | null)[]
}

// ---- review and QC --------------------------------------------------------
export type ReviewStateId = 'draft' | 'in_review' | 'changes_requested' | 'approved' | 'rejected'

/** What a machine measured, not what anyone decided. */
export interface QcFinding {
  check_name: string
  severity: 'info' | 'warning' | 'error'
  from_ms: number | null
  to_ms: number | null
  measured: string | null
  expected: string | null
  message: string
  at: string
}

export interface ReviewDecisionRow {
  at: string
  actor_label: string
  from_state: ReviewStateId | null
  to_state: ReviewStateId
  note: string | null
  /** Set when the decision was taken with QC findings outstanding. The mark that
   *  makes a soft gate mean something. */
  overrode_qc: boolean
  qc_state_at_decision: string | null
}

export interface AssetReview {
  assetId: string
  state: ReviewStateId
  reviewedAt: string | null
  qc: { state: string | null; at: string | null; findings: QcFinding[] }
  history: ReviewDecisionRow[]
  gate: {
    allowed: boolean
    code: 'ok' | 'not_approved' | 'qc_failed'
    message: string
    reviewState: ReviewStateId
    qcState: string | null
    wouldOverride: boolean
  }
}

export interface ReviewQueueRow {
  id: string
  title: string | null
  kind: string
  review_state: ReviewStateId
  qc_state: string | null
  qc_errors: number
  qc_warnings: number
  created_at: string
  duration_ms: number | string | null
  start_epoch_ms: number | string
  end_epoch_ms: number | string
  source_name: string | null
  source_block_count: number | null
  source_coverage_pct: number | string | null
  recording_id?: string | null
}

/** What is kept, and for how long. Reports and raw events are not the same
 *  thing and do not have the same lifetime. */
export interface AnalyticsRetention {
  rawRetentionDays: number | null
  raw: { sessions: number; oldest: string | null; newest: string | null }
  reports: { days: number; sealed: number; oldest: string | null }
  note: string
}

/** One stream on the live board. The gates are the SAME five-gate health the
 *  detail pages compute, so the board can never disagree with the page. */
export interface LiveStream {
  id: string
  kind: 'tv' | 'radio' | 'event'
  name: string
  groupName: string | null
  status: string
  onAir: boolean
  overall: 'idle' | 'starting' | 'ready' | 'onair' | 'degraded' | 'error' | 'stopped'
  gates: Gate[]
  primaryError: { gate: string; label: string; message: string } | null
  /** Null unless the SERVER gate agrees something is up: an instance row
   *  outlives a crashed encoder, and reporting from it alone lies. */
  uptimeMs: number | null
  orphanedInstance: boolean
  concurrent: number
  activeSource: string | null
  fallbackInUse: boolean
  fillerInUse: boolean
  reportAgeMs: number | null
  /** Outputs the RUNNING encoder dropped, as {output: reason}. Empty when the
   *  stream is delivering everything it was asked for. A station can carry one
   *  of these with all five gates green: the pipeline is right, the delivery is
   *  incomplete, and they are different questions. */
  degradedOutputs: Record<string, string>
  href: string
  /** The ORIGIN manifest, not the public URL: multiview monitors what the
   *  encoder is producing, whether or not the stream has been published. */
  previewUrl: string
  audioOnly: boolean
}

export interface LiveBoard {
  streams: LiveStream[]
  counts: Record<string, number>
  /** Streams with a pipeline actually up. `counts` is keyed by the five-gate
   *  roll-up, which says what STATE things are in; this says how many encoders
   *  are running, which is the capacity question and a different one. */
  running: number
  onAir: number
  /** A failed or degraded GATE, or a dropped OUTPUT. Counted on the server so
   *  the console and the API cannot drift on what the word means. */
  degraded: number
  concurrent: number
}

export type AlertSeverity = 'critical' | 'serious' | 'warning'
export interface FleetAlert {
  id: string
  severity: AlertSeverity
  source: 'pipeline' | 'jobs' | 'media' | 'qc' | 'publishing' | 'uploads' | 'capacity'
  title: string
  detail: string
  href: string | null
  at: string | null
}

export interface FleetEvent {
  id: string
  ts: string
  type: string
  name: string | null
  kind: string
  ownerId: string | null
  detail: string
}

/** What needs attention, not what exists. Every entry is a problem. */
export interface MonitoringOverview {
  generatedAt: string
  fleet: {
    total: number; running: number; onAir: number
    error: number; degraded: number; concurrent: number
  }
  alerts: FleetAlert[]
  counts: { critical: number; serious: number; warning: number }
  feed: FleetEvent[]
}

/** One day of the account-scope rollup. `sealed` says the figures are final:
 *  an unsealed day is still moving and must not be read as a finished trend. */
export interface AnalyticsDay {
  day: string
  views: number
  uniques: number
  peakConcurrent: number
  watchSeconds: number
  blocked: number
  sealed: boolean
}

/** A stream carrying viewers right now. Live, not rolled up. */
export interface LiveStreamRow {
  asset_kind: string
  asset_id: string
  concurrent: number
  updated_at?: string
}

/** Everything the Analytics page draws, read entirely from rollups so it keeps
 *  answering after the raw sessions behind it have been pruned. */
export interface AnalyticsOverview {
  windowDays: number
  daily: AnalyticsDay[]
  totals: {
    views: number
    uniques: number
    watchHours: number
    blocked: number
    peakConcurrent: number
  }
  liveConcurrent: number
  liveStreams: LiveStreamRow[]
  top: Array<{
    kind: string
    id: string
    name: string
    views: number
    watchHours: number
    peakConcurrent: number
  }>
  byApp: Record<string, number>
  byDevice: Record<string, number>
  byGeo: Record<string, number>
}

/** A slate (a still) or a loop (a short video): what a channel falls back to
 *  when its input goes away. */
export interface FillerAsset {
  id: string
  kind: 'slate' | 'loop'
  name: string
  source_key: string | null
  width: number | null
  height: number | null
  duration_ms: number | string | null
  poster_key: string | null
  status: 'uploading' | 'processing' | 'ready' | 'error'
  bytes: number | string | null
  content_type: string | null
  filename: string | null
  uploaded_at: string | null
  error: string | null
  created_at: string
  updated_at: string
}

export interface VodAssetRow {
  id: string; kind: 'clip' | 'full_event' | string; title: string | null
  recording_id: string | null; start_epoch_ms: number | string; end_epoch_ms: number | string
  duration_ms: number | string | null; output_kind?: string | null
  thumb_status?: string | null; created_at: string
  /** Availability (publishing rules): state, window. */
  availability_state?: 'draft' | 'scheduled' | 'available' | 'expired' | 'withdrawn'
  available_from?: string | null; available_until?: string | null
  schema_id?: string | null; metadata?: Record<string, any>
  /** Audio-only sources: the MP3 and the AAC (.m4a) produced beside the clip. */
  export_mp3_key?: string | null; export_m4a_key?: string | null
  /** Written when the clip is built, from the same resolution that produced the
   *  media. Absent on assets made before provenance was recorded. */
  source_block_count?: number | null; source_run_count?: number | null
  source_container_count?: number | null; source_segment_count?: number | null
  source_coverage_pct?: number | string | null; build_strategy?: string | null
  /** Set on the list: an asset was re-cut after it was published, so the copy
   *  out there is older than the one here. */
  has_stale_publication?: boolean
  publication_count?: number
  published?: boolean
  review_state?: ReviewStateId
  qc_state?: string | null
  source_name?: string | null
}

/** One contiguous stretch of source media inside a finished clip. */
export interface ProvenanceBlock {
  ordinal: number
  runId: string
  blockIndex: number
  rendition: string
  segments: { first: number; last: number; count: number }
  source: { fromMs: number; toMs: number }
  clip: { offsetMs: number; durationMs: number }
  trimmed: { head: boolean; tail: boolean }
  recording: { id: string; title: string | null; status: string } | null
  container: { id: string; day: string; tz: string } | null
  /** False once retention has taken the source media away: the clip still plays,
   *  but it can no longer be re-cut at a different length. */
  sourceMediaPresent: boolean
}

export interface ClipProvenance {
  assetId: string
  title: string | null
  streamId: string | null
  requested: { fromMs: number; toMs: number; ms: number }
  counts: {
    blocks: number; runs: number; containers: number; segments: number
    recordingsLinked: number; recordingsGone: number
  }
  coveragePct: number | null
  gapMs: number | null
  buildStrategy: string | null
  builtAt: string | null
  spansBroadcastDays: boolean
  blocks: ProvenanceBlock[]
  /** False for assets produced before the chain was recorded, which is not the
   *  same as an asset with no sources. */
  recorded: boolean
  note: string | null
}

export interface DerivedAssets {
  recordingId: string
  assets: { assetId: string; title: string | null; published: boolean; fromMs: number; toMs: number; segments: number; blocks: number }[]
  counts: { total: number; published: number }
  safeToPrune: boolean
}

/** Authenticated range-playback master manifest for a recording (bearer goes via
 *  the player's xhrSetup for /api URLs; segments themselves are public /origin). */
export function recordingRangeUrl(recordingId: string, fromMs: number, toMs: number) {
  return `/api/recordings/${recordingId}/range/master.m3u8?from=${Math.round(fromMs)}&to=${Math.round(toMs)}`
}

export interface ShareLinkRow {
  id: string; resource_kind: 'vod' | 'channel' | 'event'; resource_id: string
  label: string | null; access_type: string; expires_at: string
  max_views: number | null; view_count: number; first_opened_at: string | null
  last_viewed_at: string | null; revoked: boolean; created_at: string; token_prefix: string
}

export interface MediaFile {
  id: string; account_id: string; kind: string; path: string; folder: string; name: string
  content_type: string | null; size_bytes: number | null; width: number | null; height: number | null
  tags: string[]; store_key: string; status: string; version: number; created_at: string; url: string
  /** Where it came from: an upload, a watchfolder, or the encoder (thumbnails). */
  source?: 'upload' | 'watchfolder' | 'encoder'
  channel_id?: string | null; captured_at?: string | null
  /** What the file says about itself (EXIF / GPS / IPTC / XMP), read at upload. */
  taken_at?: string | null; gps_lat?: number | null; gps_lng?: number | null; gps_alt?: number | null
  location?: string | null; camera?: string | null; title?: string | null; description?: string | null
  keywords?: string[]; creator?: string | null; copyright?: string | null; checksum?: string | null
  metadata?: Record<string, any>
  duplicateOf?: { id: string; path: string }[]
}

export interface LibraryFolder { path: string; name: string; count: number; total?: number; hasChildren?: boolean }
export interface LibraryQuery {
  folder?: string; kind?: string; q?: string; recursive?: boolean
  source?: string; channel?: string; from?: string; to?: string; hasLocation?: boolean
  near?: string; sort?: 'name' | 'newest' | 'oldest' | 'taken' | 'relevance'; limit?: number; offset?: number
}

/** Sprite sheets covering a span, for hover previews (GET /api/thumbnails/storyboard). */
export interface StoryboardSheet {
  url: string; startMs: number; endMs: number; intervalMs: number; cols: number; tileW: number; tileH: number; filled: number[]
}
export interface Storyboard {
  stream: string; from: number; to: number; tileW: number; tileH: number; intervalMs: number; priming: boolean
  units: { start: number; end: number; status: string; folder: string }[]
  sheets: StoryboardSheet[]
}

export interface ImportSourceBody {
  name: string; kind: 'url' | 'upload'; url: string | null; refreshHours: number | null; fallbackTz: string | null
  keepPastDays: number; lang: string | null; autoMap: boolean; enabled: boolean
  /** 'single': one request for the window. 'per_day': one per day, with {date} in the URL. */
  requestMode: 'single' | 'per_day'
  /** How far ahead the guide is kept, and the floor below which owners are alerted. */
  daysAhead: number; minDaysAhead: number
  dateFormat: 'YYYY-MM-DD' | 'YYYYMMDD' | 'DD/MM/YYYY' | 'unix'
  /** Write-only: a string sets that header, null removes it. Values are never read back. */
  headers?: Record<string, string | null>
  /** What a channel the feed has never listed before starts as. */
  newChannels: 'review' | 'ignore'
  /** 'offsets': times as stamped. 'local': offsets ignored, times are local in the source zone (fallbackTz). */
  timeMode: 'offsets' | 'local'
}
export interface ImportCounts {
  bytes: number; channelsInFile: number; programmesInFile: number; mappedChannels: number; unmappedChannels: number
  skippedUnmapped: number; droppedOld: number; droppedFar: number; badTime: number; noEnd: number
  inserted: number; updated: number; unchanged: number; removed: number; overlaps: number
  notModified?: number
}
export interface ImportRun { id: string; trigger: string; started_at: string; finished_at: string | null; status: 'running' | 'ok' | 'warnings' | 'failed'; counts: Partial<ImportCounts>; warnings: string[]; error: string | null }
export interface ImportSource extends ImportSourceBody {
  id: string; nextRunAt: string | null; running: boolean; lastRunAt: string | null; lastStatus: string | null; lastError: string | null
  mapped?: number; unmapped?: number; lastRun?: ImportRun | null
  headerNames: string[]; plannedRequests: { url: string; day: string | null }[]; consecutiveFailures: number
  coverageUntil: string | null; coverageDaysAhead: number | null; coverageLow: boolean
  notUsed?: number
}
export interface ImportRunResult { runId: string; status: string; counts: ImportCounts; warnings: string[]; error?: string }
export interface ImportTestResult {
  requests: { url: string; day: string | null }[]; tried: string; status: 'ok' | 'failed'; error?: string
  bytes?: number; channels?: number; programmes?: number; firstStart?: string | null; lastEnd?: string | null; daysAhead?: number | null
  sampleChannels?: { id: string; name: string | null }[]
  lineup?: { used: number; notUsed: number; waiting: number }
  offsets?: { offset: string; count: number }[]
  timeReading?: { zone: string | null; mode: 'offsets' | 'local' }
  samples?: { channel: string; title: string; raw: string; startsAt: string }[]
}
export interface ImportAlias {
  id: string; externalId: string; displayName: string | null; icon: string | null; channelId: string | null; channelName: string | null
  mappedBy: string | null; lastSeenAt: string; lastProgrammes: number
  guideUntil: string | null; guideDaysAhead: number | null
  /** used: on channelId. not_used: skipped quietly. waiting: new, nobody has decided. */
  state: 'used' | 'not_used' | 'waiting'
  lcn: string | null; channelKind: 'tv' | 'radio' | null; firstSeenAt: string
  programmesInFeed: number; feedFrom: string | null; feedTo: string | null
  /** Channel numbers (or ids) of same-named channels in this feed. */
  sameNameAs: string[]
  suggestion: { channelId: string; channelName: string } | null
  /** Other import sources that also write into this alias's Volt channel. */
  alsoFedBy: string[]
  /** The linked Volt channel's own image (guide icon, else logo). The guide uses this, not theirs. */
  channelIconRef: string | null
}
export type SocialPlatformId = 'youtube' | 'facebook' | 'x' | 'tiktok' | 'dailymotion'
export interface SocialPost { title: string; description: string; tags: string[]; privacy: 'public' | 'unlisted' | 'private' }
export interface SocialPlatformsStatus {
  tokenKeyConfigured: boolean; callbackBase: string
  platforms: { id: SocialPlatformId; label: string; accountNoun: string; configured: boolean; env: string[]; callbackUrl: string
    limits: { title: number | null; description: number; tags: boolean }; privacy: SocialPost['privacy'][]; scopes: string[] }[]
}
export interface SocialAccount {
  id: string; platform: SocialPlatformId; name: string; external_account: string | null; enabled: boolean; mode: 'live' | 'sandbox'
  account_label: string | null; avatar_url: string | null; link_status: 'connected' | 'expired' | 'error'; link_detail: string | null
  token_expires_at: string | null; linked_at: string | null; linked_by_email: string | null; published: number; last_published_at: string | null
}
export interface SocialPublication {
  id: string; platform: SocialPlatformId; status: 'pending' | 'published' | 'failed' | 'removed' | 'withdrawn'
  external_id: string | null; external_url: string | null; views: number; error: string | null; published_at: string | null
  last_synced_at: string | null; created_at: string; post: SocialPost | null; progress: number | null; stage: string | null
  attempts: number; stale: boolean; target_id: string; account_label: string | null; target_name: string; mode: 'live' | 'sandbox'; avatar_url: string | null
}
export interface InboxItem { id: string; status: string; read_at: string | null; created_at: string; topic: string; subject: string; body: string | null }
export interface NotificationConfig {
  channels: Record<'in_app' | 'email' | 'push', { configured: boolean; detail: string }>
  maxAttempts: number; backoffMinutes: number[]
}
export interface NotificationRow {
  id: string; topic: string; subject: string; body: string | null; created_at: string
  deliveries: number | any; sent: number; retrying: number; gave_up: number
}
export interface DeliveryRow {
  id: string; recipient: string; channel: 'email' | 'in_app' | 'push'; status: 'pending' | 'sent' | 'failed'
  attempts: number; last_error: string | null; sent_at: string | null; next_attempt_at: string | null; gave_up_at: string | null
}
export interface NotificationTemplate { id: string; key: string; subject: string; body: string; created_at: string }
export interface SourceProbe {
  ok: boolean; reachable: boolean
  container?: { format?: string; bitrate_kbps?: number | null }
  video?: { codec?: string; width?: number; height?: number; fps?: number | null; pix_fmt?: string; profile?: string; bitrate_kbps?: number | null }
  audio?: { codec?: string; channels?: number; sample_rate?: number; bitrate_kbps?: number | null; language?: string | null }[]
  other?: { kind: string; codec?: string; language?: string | null; note?: string }[]
  note?: string; error?: string
  /** For an HLS address: the playlist (master with variants, or media) and any redirect. */
  hls?: HlsInspection
  /** measured: segment sizes over time (HLS media playlist); stream: reported by the stream; declared: what an HLS master says (min..max). */
  bitrate?: { kbps: number | null; maxKbps?: number | null; how: 'measured' | 'stream' | 'declared'; note?: string }
}
export interface HlsVariant {
  uri: string; bandwidth: number | null; averageBandwidth: number | null; codecs: string[]; codecNames: string[]
  resolution: string | null; frameRate: number | null; audioGroup: string | null
  /** Audio is in a separate rendition playlist: this variant's own address has no sound. */
  externalAudio: boolean; audioOnly: boolean
}
export interface HlsRendition { type: string; groupId: string; name: string; language: string | null; default: boolean; channels: string | null; uri: string | null }
export interface HlsInspection {
  ok: boolean; error?: string; redirectedTo?: string | null; kind?: 'master' | 'media'
  variants?: HlsVariant[]; renditions?: HlsRendition[]; live?: boolean; targetDuration?: number | null
}
export interface ProtocolField {
  key: string; label: string; type: 'url' | 'string' | 'number' | 'password' | 'select' | 'text'
  required?: boolean; placeholder?: string; hint?: string; default?: string | number
  options?: { value: string; label: string }[]
  /** Shown only when another setting has one of these values ('*' = any value). */
  when?: { key: string; in: string[] }
  min?: number; max?: number
  /** Under "More settings". */
  advanced?: boolean
}
export interface IngestProtocol {
  id: string; label: string; ingest: 'push' | 'pull'
  urlLabel: string; urlPlaceholder: string; urlExample: string; urlPattern?: string
  streamKey: { show: boolean; label?: string; placeholder?: string; required?: boolean }
  fields?: ProtocolField[]
  hint: string
  /** video = channels and events; radio = stations. Icecast is radio only. */
  scopes?: ('video' | 'radio')[]
  packageFriendly: boolean
  /** Packaging copies the stream (remux) or encodes it once (NDI, ST 2110). */
  packaging?: 'remux' | 'encode'
  /** Can Check source reach it from the control plane? */
  checkable?: boolean
}

// origin URLs are same-origin under /origin (proxied by Vite to the API in dev)
export function originUrl(path: string) { return path.startsWith('/origin') ? path : `/origin${path}` }

// Resized preview via the image service: /img/<sig>/<WxH>,<fit>/<store-key>.
// `url` is a library URL like '/library/<acct>/<path>'; the store key is that
// without the slash. The image service renders SIGNED URLs only, so this signs
// with the account key (imageSigning.ts). Before the key has loaded, or for
// another account's image, it falls back to the original bytes.
export function thumbUrl(libraryUrl: string, w: number, h: number, fit: 'cover' | 'inside' = 'cover') {
  const key = libraryUrl.replace(/^\//, '')
  if (!key.startsWith('library/')) return libraryUrl
  const signed = signImage(`${w}x${h},${fit}`, key)
  if (signed) return signed
  void ensureImageSigning()
  return libraryUrl
}

export interface ImageSigningKey {
  accountId: string; key: string; baseUrl: string; consoleBaseUrl: string; algorithm: string; keyPrefixes: string[]
}

// One fetch per session, shared by every caller.
let signingLoad: Promise<void> | null = null
export function ensureImageSigning(): Promise<void> {
  if (imageSigning() || !token) return Promise.resolve()
  if (!signingLoad) {
    signingLoad = (req('/images/signing-key') as Promise<ImageSigningKey>)
      .then((k) => setImageSigning({ accountId: k.accountId, key: k.key, baseUrl: k.baseUrl, consoleBaseUrl: k.consoleBaseUrl ?? '' }))
      .catch(() => { signingLoad = null })   // previews keep the original; next call retries
  }
  return signingLoad
}

// ---- content types ---------------------------------------------------------
export interface SchemaField {
  key: string; label?: string
  type: 'string' | 'text' | 'number' | 'boolean' | 'date' | 'enum' | 'url' | 'tags' | 'reference'
  required?: boolean; options?: string[]; multiple?: boolean; refDomain?: string
  /** EPG slot: title | sub-title | description | category | episode | language | icon | credits.<role> | custom:<name> */
  epg?: string
  schemaOrg?: string
}
export interface ContentType {
  id: string; account_id: string; name: string; description: string | null
  fields: SchemaField[]; target_kind: 'vod' | 'event' | 'channel' | 'any'; domain: string | null
  extends_id: string | null; is_standard: boolean; standard_key: string | null
  schema_org_type: string | null; applies_to: ('radio' | 'tv' | 'event' | 'vod')[]
  version?: number; created_at: string; updated_at: string
}
export interface ContentTypeBody {
  name: string; description?: string; fields: SchemaField[]
  targetKind?: 'vod' | 'event' | 'channel' | 'any'; domain?: string; extendsId?: string
  appliesTo?: ('radio' | 'tv' | 'event' | 'vod')[]; schemaOrgType?: string
}
export interface OwnerBaseEntry {
  title: string; subTitle: string | null; description: string | null; categories: string[]
  episode: string | null; language: string | null; icon: string | null
  credits: { role: string; name: string }[]; custom: Record<string, any>; schemaId: string | null
}

// ---- publishing rules ------------------------------------------------------
export type RuleScope = 'account' | 'schema' | 'owner'
export type PublishTarget =
  | { kind: 'portal' }
  | { kind: 'app'; appId: string }
  | { kind: 'social'; targetId: string; platform?: string }
export interface RuleSettings {
  targets?: PublishTarget[]
  autoPublish?: boolean
  availableFrom?: { mode: 'publish' } | { mode: 'at'; at: string }
  expire?: { mode: 'never' } | { mode: 'days'; days: number } | { mode: 'at'; at: string }
  geo?: { mode: 'worldwide' | 'allow' | 'block'; countries: string[] }
  access?: 'free' | 'entitled' | 'paid'
  paywall?: { tier?: string; priceCents?: number; currency?: string } | null
  gate?: { requireReview: boolean; blockOnQcFail: boolean }
  /** FOR / IF / THEN / TERMS: decides access for the content it governs; the simple fields are the fallback. */
  accessRules?: AccessRule[]
}
export type ForScope = 'this' | 'live' | 'ondemand'
export interface AccessTerm {
  productKey: string; kind: 'period' | 'published_dates'
  count?: number; unit?: 'day' | 'week' | 'month' | 'year'
  priceCents: number; currency: string; taxPct?: number; name?: string
}
export interface AccessRule {
  id: string
  for: { scopes: ForScope[]; schemaIds?: string[] }
  if: { geo: 'in' | 'not_in'; countries: string[] }
  then: { access: 'free' | 'members' | 'premium'; userGroups?: string[]; terms?: AccessTerm[] }
}
export interface PaymentProviderRow { id: string; provider: 'stripe' | 'appstore' | 'googleplay' | 'manual'; config: Record<string, any>; enabled: boolean; has_secret: boolean; updated_at?: string }
export interface ProductRow { id: string; key: string; name: string; term: AccessTerm; grants: any; provider_ids: Record<string, string>; source_rule: string | null; enabled: boolean }
export type RuleKey = keyof RuleSettings
export type Rung = 'baseline' | 'account' | 'schema' | 'owner' | 'asset'
export interface PublishingRule {
  id: string; account_id: string; scope_kind: RuleScope; scope_id: string | null
  settings: RuleSettings; version: number; updated_at: string; scope_name?: string
}
export interface PublishingPoints {
  portal: { kind: 'portal'; name: string }
  apps: { kind: 'app'; appId: string; name: string; type: string; enabled: boolean }[]
  social: { kind: 'social'; targetId: string; platform: string; name: string; account: string | null; enabled: boolean }[]
}
export interface ResolvedRules {
  settings: Required<Omit<RuleSettings, 'paywall'>> & { paywall: RuleSettings['paywall'] }
  sources: Record<RuleKey, Rung>
  rungs: { rung: Rung; id: string | null; scopeId: string | null; settings: RuleSettings }[]
}
export type AvailabilityState = 'draft' | 'scheduled' | 'available' | 'expired' | 'withdrawn'
export interface AssetAvailability {
  state: AvailabilityState
  availableFrom: string | null; availableUntil: string | null
  withdrawnAt: string | null; withdrawnBy: string | null
  applied: ResolvedRules['settings'] | null; appliedSources: Record<RuleKey, Rung> | null
  override: RuleSettings
  plan: ResolvedRules
  publications: { id: string; platform: string; status: string; external_url: string | null; published_at: string | null; app_id: string | null; app_name: string | null; target_name: string | null }[]
}

// ---- workflows + add-ons ----------------------------------------------------
export type AddonRunState = 'queued' | 'dispatched' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'timed_out'
export type AddonCategory = 'ai_agent' | 'transcription' | 'qc' | 'metadata' | 'distribution' | 'other'
export interface WorkflowLane { id: string; label: string; description: string }
export interface WorkflowStage { id: string; label: string; lane: string; col: number; description: string; impl: string }
export interface WorkflowHookTrigger { id: string; hook: string; enabled: boolean; filter: any; addon_id: string; addon_name: string; category: AddonCategory; addon_enabled: boolean }
export interface WorkflowHook {
  id: string; label: string; stage: string; subject: string; live: boolean; description: string
  fired24h: number; lastFiredAt: string | null
  triggers: WorkflowHookTrigger[]
  runs24h: Partial<Record<AddonRunState, number>>
}
export interface WorkflowMap {
  lanes: WorkflowLane[]; stages: WorkflowStage[]; edges: [string, string][]; hooks: WorkflowHook[]
  manualRuns24h: Partial<Record<AddonRunState, number>>
}
export interface AddonRun {
  id: string; addon_id: string; addon_name: string; category: AddonCategory; addon_kind: 'webhook' | 'demo'
  trigger_id: string | null; hook: string
  subject_type: 'channel' | 'event' | 'recording' | 'vod_asset'; subject_id: string; subject_title: string | null
  channel_id: string | null; event_id: string | null
  state: AddonRunState; progress_pct: number; step: string | null; steps: string[]
  external_ref: string | null; error: string | null; created_by: string | null
  created_at: string; dispatched_at: string | null; updated_at: string; finished_at: string | null; deadline_at: string
  job_id?: string
}
export interface AddonRunEvent { id: number; ts: string; type: string; state: string | null; progress_pct: number | null; step: string | null; message: string | null }
export interface AddonRunDetail extends AddonRun { result: any; options: any; events: AddonRunEvent[] }
export interface WorkflowEvent { id: number; hook: string; subject_type: string; subject_id: string; title: string | null; channel_id?: string | null; event_id?: string | null; data: any; created_at: string }
export interface WorkflowTrace { subject: { type: string; id: string; title: string }; events: WorkflowEvent[]; runs: AddonRun[] }
export interface AddonService {
  id: string; name: string; description: string | null; category: AddonCategory; kind: 'webhook' | 'demo'
  endpoint_url: string | null; accepts: string[]; steps: string[]; timeout_sec: number; max_attempts: number; enabled: boolean
  created_at: string; updated_at: string; open_runs?: number; failed_24h?: number; last_run_at?: string | null
}
export interface AddonInput {
  name: string; description?: string | null; category?: AddonCategory; kind?: 'webhook' | 'demo'
  endpointUrl?: string | null; accepts?: string[]; steps?: string[]; timeoutSec?: number; maxAttempts?: number; enabled?: boolean
}
export interface AddonTrigger { id: string; addon_id: string; addon_name: string; hook: string; filter: any; options: any; enabled: boolean; created_at: string }
export interface EngineDescriptor {
  id: string; name: string; vendor: string; availability: 'installed' | 'planned'; defaultMode: 'encode_only' | 'full'
  summary: string; costNote?: string; todo?: string[]; caps: Record<string, any>
}

// ---- timeline grid (GET /api/timeline/grid, TIMELINE_MODE.md) ----
export type TimelineGridKind = 'channel' | 'radio' | 'event' | 'loop'
export interface TimelineGridQuery { from: string; to: string; kinds?: TimelineGridKind[]; groupId?: string; cursor?: string; limit?: number }
export interface TimelineGridBlock {
  id: string; title: string
  /** As-run when known, scheduled otherwise. */
  start: string; end: string
  scheduledStart: string; scheduledEnd: string
  asRun: boolean; status: string | null; vodState: VodState | null
  /** 'event' is the event's own window drawn as one block. */
  source: 'epg' | 'event'
}
export interface TimelineGridSpan { start: string; end: string }
export interface TimelineGridRow {
  kind: TimelineGridKind; id: string; name: string
  groupId: string; groupName: string
  /** The server's five-gate roll-up. Never computed in the console. */
  status: { state: string; label: string }
  onAir: boolean
  programmes: TimelineGridBlock[]
  /** Past part of the window only, measured from disk. */
  media: { runs: TimelineGridSpan[]; gaps: (TimelineGridSpan & { reason: string })[]; coveragePct: number | null }
  clips: (TimelineGridSpan & { id: string; title: string | null })[]
  recordings: { id: string; start: string; end: string | null }[]
  /** Phase 2: outages from the status event log (past only). end null = still going. */
  outages?: TimelineOutage[]
  /** Phase 3: overlapping programmes on this row, as /api/epg/conflicts reports them. */
  clashes?: TimelineClash[]
  links: { self: string; detail: string; workbench: string; epg: string; programmes: string; coverage?: string; timeline?: string }
}
export interface TimelineOutage { kind: 'source' | 'filler' | 'packager' | 'stopped'; start: string; end: string | null; label: string; reason: string | null }
export interface TimelineClash { start: string; end: string; a: { id: string; title: string }; b: { id: string; title: string } }
/** GET /api/timeline/selection: a dragged range, checked before it becomes a clip. */
export interface TimelineSelection {
  kind: TimelineGridKind; id: string; name: string
  range: { from: string; to: string; ms: number; clampedToNow: boolean }
  coveragePct: number; coveredMs: number
  gaps: { start: string; end: string; ms: number; reason: string }[]
  clippable: boolean
  reason: { code: string; message: string } | null
  recording: { id: string; start: string; end: string | null } | null
  recordingCount: number
  suggestedTitle: string
  programmes: { id: string; title: string; start: string; end: string }[]
  links: { clip: string | null; workbench: string }
}
export interface TimelineGrid {
  window: { from: string; to: string; now: string }
  kinds: TimelineGridKind[]
  rows: TimelineGridRow[]
  next: string | null
  links: { self: string; next: string | null; live: string; status: string }
}

export type VodMarkerKind = 'intro' | 'recap' | 'credits'
export interface VodMarker {
  kind: VodMarkerKind
  startMs: number
  endMs: number
  source: 'auto' | 'manual'
  status: 'active' | 'suggested'
  confidence: number | null
  detail: { comparedWith?: number; agreed?: number; peers?: string[]; at?: string }
  updatedAt: string
}
export interface VodMarkersView {
  markers: VodMarker[]
  durationMs: number
  detection: { group: string | null; at: string | null; note: string | null; running: boolean }
}

/** The authenticated request helper, for feature clients kept in their own
 *  files (graphics/gfxApi.ts) so this file does not grow without end. */
export const apiRequest = req

/** The same request, also returning the response headers, for lists that page
 *  in headers (Link, X-Next-Cursor, X-Prev-Cursor, X-Total-Count). Used by the
 *  Media Library (pages/vod/libraryApi.ts). */
export async function apiRequestWithHeaders(path: string, opts: RequestInit = {}): Promise<{ body: any; headers: Headers }> {
  await refreshIfDueSoon()
  let r = await send(path, opts)
  if (r.status === 401 && token && refreshToken) {
    if (await refreshAccess()) r = await send(path, opts)
  }
  if (!r.ok) {
    let msg = `${r.status}`
    let body: any = null
    try { body = await r.json(); msg = body.error || body.message || msg } catch { try { msg = await r.text() } catch { /* no body */ } }
    if (r.status === 401 && token) { clearSession(); onUnauthorized?.() }
    throw new ApiError(r.status, msg, body)
  }
  return { body: r.status === 204 ? null : await r.json(), headers: r.headers }
}
