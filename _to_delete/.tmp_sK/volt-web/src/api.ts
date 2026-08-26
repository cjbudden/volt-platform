// Typed client for the Volt control-plane API (same-origin via the Vite proxy).
let token = ''
export function setToken(t: string) { token = t }
export function getToken() { return token }

async function req(path: string, opts: RequestInit = {}) {
  const r = await fetch('/api' + path, {
    ...opts,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(opts.headers || {}),
    },
  })
  if (!r.ok) {
    let msg = `${r.status}`
    try { msg = (await r.json()).error || msg } catch { try { msg = await r.text() } catch {} }
    throw new Error(msg)
  }
  if (r.status === 204) return null
  return r.json()
}

export interface Group {
  id: string; name: string; profile_name: string | null
  workflow_type: 'transcode' | 'package_only' | null
  packaging: string | null; rungs: { height: number; bitrate_kbps: number }[] | null
  codec_backend: string | null; captions_provider: 'none' | 'whisper' | 'gladia'
  max_channels: number; channel_count: number
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
  kind: 'channel'
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
  sources: { id: string; role: string; protocol: string; ingest_url: string | null; status: string }[]
  viewers: { current: number; peak: number; peakAt: string; trendPct: number; series: { t: number; v: number }[] }
  epg: { now: any; next: { name: string; start: string } | null; lane: any[] }
  statusBoard: { output: string; activeSource: string; fallback: string; packager: string; inputs: any[] }
  log: { ts: string; level: string; title: string; detail: string }[]
  health: PipelineHealth
  billing: Billing
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

export interface ChannelSettingsPatch {
  name?: string
  recordingEnabled?: boolean
  recordingRetentionDays?: number | null
  dvrWindowSec?: number | null
  dvrMode?: 'sliding' | 'event_start'
  geoMode?: 'worldwide' | 'allow' | 'block'
  geoCountries?: string[]
  epgEnabled?: boolean
  sources?: { role: 'primary' | 'backup'; protocol: string; ingestUrl?: string; streamKey?: string }[]
  captions?: { enabled?: boolean; sourceLang?: string; targets?: string[]; offsetSec?: number }
  inputFailoverEnabled?: boolean
  autoFailback?: boolean
  inputLossBehavior?: 'none' | 'slate' | 'vod_loop' | 'last_frame' | 'black'
  fillerSlateRef?: string | null
  watermark?: WatermarkPatch
  brandRef?: string | null
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

export const api = {
  login: (email: string, password: string) =>
    req('/auth/login', { method: 'POST', body: JSON.stringify({ email, password }) }),
  groups: (): Promise<Group[]> => req('/groups'),
  // caption OUTPUT languages the pipeline can deliver (single source of truth for pickers)
  captionLanguages: (): Promise<{ languages: { code: string; label: string }[] }> => req('/caption-languages'),
  channels: (kind?: 'tv' | 'radio'): Promise<Channel[]> => req('/channels' + (kind ? `?kind=${kind}` : '')),
  createChannel: (b: {
    groupId: string; name: string; purchasingMode?: string
    resilienceTier?: string; recordingEnabled?: boolean
    recordingRetentionDays?: number | null; recordingRetentionSec?: number | null
    dvrWindowSec?: number | null; dvrMode?: 'sliding' | 'event_start'
    outputLadder?: { height: number; bitrateKbps: number }[]
    sources?: { role: 'primary' | 'backup'; protocol: string; ingestUrl?: string; streamKey?: string; renditionLabel?: string; renditionBitrateKbps?: number }[]
    inputFailoverEnabled?: boolean; autoFailback?: boolean
    inputLossBehavior?: 'none' | 'slate' | 'vod_loop' | 'last_frame' | 'black'
    fillerSlateRef?: string | null; fillerAssetId?: string | null
    fallbackTranscode?: boolean
    watermark?: WatermarkPatch
    brandRef?: string | null
    kind?: 'tv' | 'radio'
    radio?: RadioCfg
  }): Promise<Channel> => req('/channels', { method: 'POST', body: JSON.stringify(b) }),
  search: (q: string): Promise<{ results: SearchHit[] }> => req('/search?q=' + encodeURIComponent(q)),
  startStop: (id: string, action: 'start' | 'stop') =>
    req(`/channels/${id}/${action}`, { method: 'POST' }),
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
  updateChannel: (id: string, patch: ChannelSettingsPatch): Promise<any> =>
    req(`/channels/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }),
  testStreamStart: (id: string, opts: { langs?: string[]; dvrSec?: number; dash?: boolean } = {}): Promise<TestStreamStatus> =>
    req(`/channels/${id}/test-stream`, { method: 'POST', body: JSON.stringify({ action: 'start', ...opts }) }),
  testStreamStop: (id: string): Promise<{ running: boolean }> =>
    req(`/channels/${id}/test-stream`, { method: 'POST', body: JSON.stringify({ action: 'stop' }) }),
  ingestProtocols: (): Promise<{ protocols: IngestProtocol[] }> => req('/ingest-protocols'),

  // image library (file manager)
  files: (p: { folder?: string; kind?: string; q?: string; recursive?: boolean } = {}): Promise<MediaFile[]> => {
    const qs = new URLSearchParams()
    if (p.folder !== undefined) qs.set('folder', p.folder)
    if (p.kind) qs.set('kind', p.kind)
    if (p.q) qs.set('q', p.q)
    if (p.recursive) qs.set('recursive', '1')
    return req('/files' + (qs.toString() ? '?' + qs : ''))
  },
  // events — same core workflow as channels plus the scheduled window
  events: (): Promise<EventRow[]> => req('/events'),
  event: (id: string): Promise<EventRow> => req(`/events/${id}`),
  createEvent: (b: EventCreateBody): Promise<EventRow> =>
    req('/events', { method: 'POST', body: JSON.stringify(b) }),
  updateEvent: (id: string, patch: EventPatchBody): Promise<EventRow> =>
    req(`/events/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }),
  eventStartStop: (id: string, action: 'start' | 'stop'): Promise<EventRow> =>
    req(`/events/${id}/${action}`, { method: 'POST' }),
  deleteEvent: async (id: string): Promise<void> => {
    const r = await fetch('/api/events/' + id, { method: 'DELETE', headers: { authorization: `Bearer ${getToken()}` } })
    if (!r.ok && r.status !== 204) throw new Error(String(r.status))
  },

  // EPG — programme guides for channels and event-day schedules
  epgOwners: (): Promise<EpgOwnerRow[]> => req('/epg/owners'),
  epgProgrammes: (owner: EpgOwner, fromIso: string, toIso: string): Promise<ProgrammeRow[]> =>
    req(`/epg?${owner.kind === 'event' ? 'eventId' : 'channelId'}=${owner.id}&from=${encodeURIComponent(fromIso)}&to=${encodeURIComponent(toIso)}`),
  epgConflicts: (owner: EpgOwner, fromIso: string, toIso: string): Promise<ProgrammeConflict[]> =>
    req(`/epg/conflicts?${owner.kind === 'event' ? 'eventId' : 'channelId'}=${owner.id}&from=${encodeURIComponent(fromIso)}&to=${encodeURIComponent(toIso)}`),
  createProgramme: (owner: EpgOwner, b: ProgrammeBody): Promise<ProgrammeRow & { conflicts: { id: string; title: string }[] }> =>
    req('/epg', { method: 'POST', body: JSON.stringify({ ...(owner.kind === 'event' ? { eventId: owner.id } : { channelId: owner.id }), ...b }) }),
  patchProgramme: (id: string, b: Partial<ProgrammeBody>): Promise<ProgrammeRow> =>
    req(`/epg/${id}`, { method: 'PATCH', body: JSON.stringify(b) }),
  deleteProgramme: async (id: string): Promise<void> => {
    const r = await fetch('/api/epg/' + id, { method: 'DELETE', headers: { authorization: `Bearer ${getToken()}` } })
    if (!r.ok && r.status !== 204) throw new Error(String(r.status))
  },
  epgCopyDay: (owner: EpgOwner, fromStart: string, fromEnd: string, dayOffsets: number[]): Promise<{ copied: number; created: number }> =>
    req('/epg/copy-day', { method: 'POST', body: JSON.stringify({ ...(owner.kind === 'event' ? { eventId: owner.id } : { channelId: owner.id }), fromStart, fromEnd, dayOffsets }) }),
  epgClearDay: (owner: EpgOwner, fromStart: string, fromEnd: string): Promise<{ deleted: number }> =>
    req('/epg/clear-day', { method: 'POST', body: JSON.stringify({ ...(owner.kind === 'event' ? { eventId: owner.id } : { channelId: owner.id }), fromStart, fromEnd }) }),

  // recordings library + range playback + clip/VOD creation
  /** Sources roll-up: one row per channel / radio station / event that has
   *  recordings. Sorting and filtering are server-side because the counts and
   *  the available range are computed in SQL. */
  /** Ask a source URL what it is, before saving it. Nothing is written. */
  probeRadioSource: (url: string): Promise<IcyProbe> =>
    req('/radio/probe', { method: 'POST', body: JSON.stringify({ url }) }),
  /** The three lanes in one call, so they cannot disagree about a boundary. */
  channelTimeline: (id: string, from: number, to: number): Promise<TimelineFeed> =>
    req(`/channels/${id}/timeline?from=${Math.round(from)}&to=${Math.round(to)}`),
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
  clipRecording: (id: string, b: { title: string; startMs: number; endMs: number; outputKind?: 'manifest' | 'progressive' | 'both' }): Promise<VodAssetRow> =>
    req(`/recordings/${id}/clip`, { method: 'POST', body: JSON.stringify(b) }),
  publishRecording: (id: string, title?: string): Promise<VodAssetRow> =>
    req(`/recordings/${id}/publish`, { method: 'POST', body: JSON.stringify({ title }) }),
  recordingDownload: (id: string): Promise<{ status: 'exporting' | 'ready'; url?: string; message?: string }> =>
    req(`/recordings/${id}/download`),

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
  radioLog: (id: string, p: { from?: string; to?: string; q?: string; class?: RadioClass; limit?: number } = {}): Promise<RadioLog> => {
    const qs = new URLSearchParams()
    if (p.from) qs.set('from', p.from)
    if (p.to) qs.set('to', p.to)
    if (p.q) qs.set('q', p.q)
    if (p.class) qs.set('class', p.class)
    if (p.limit) qs.set('limit', String(p.limit))
    return req(`/radio/${id}/log` + (qs.toString() ? '?' + qs : ''))
  },

  // ---- admin: who am I + access model (drives nav/button gating) ----
  me: (): Promise<Me> => req('/auth/me'),

  // ---- admin: user management (admin+ only) ----
  users: (): Promise<UserRow[]> => req('/users'),
  createUser: (b: { email: string; password: string; role: TenantRole; userGroupId?: string | null }): Promise<UserRow> =>
    req('/users', { method: 'POST', body: JSON.stringify(b) }),
  patchUser: (id: string, b: { role?: TenantRole; status?: 'active' | 'disabled'; userGroupId?: string | null }): Promise<UserRow> =>
    req(`/users/${id}`, { method: 'PATCH', body: JSON.stringify(b) }),

  // ---- admin: user groups (per-feature access none/view/manage) ----
  userGroups: (): Promise<UserGroupRow[]> => req('/user-groups'),
  createUserGroup: (b: { name: string; description?: string; permissions: Record<string, AccessLevel> }): Promise<UserGroupRow> =>
    req('/user-groups', { method: 'POST', body: JSON.stringify(b) }),
  patchUserGroup: (id: string, b: { name?: string; description?: string | null; permissions?: Record<string, AccessLevel> }): Promise<UserGroupRow> =>
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
export interface RadioOutputs { mp3: string | null; hls: string | null; dash: string | null }
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
  kind: 'radio'; radio_config: RadioCfg | null
  recording_enabled?: boolean; recording_retention_sec?: number | string | null
  brand_ref?: string | null; on_air?: boolean; created_at: string; version: number
  pipeline: RadioPipelineState
  nowPlaying: string | null; nowPlayingClass: RadioClass | null
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
export interface RadioNowPlaying {
  running: boolean; listeners: number
  station: RadioIcyState['station'] | null
  title: string | null; class: RadioClass | null; since: number | null; streamUrl: string | null
  entry: { id: string; title: string; starts_at: string; metadata?: any } | null
}
export interface RadioLog {
  stationId: string; from: string; to: string
  counts: Partial<Record<RadioClass, number>>
  entries: RadioLogEntry[]
}

// ---- admin / access model types --------------------------------------------
export type TenantRole = 'viewer' | 'operator' | 'admin' | 'owner'
export type AccessLevel = 'none' | 'view' | 'manage'

export interface Me {
  id: string; email?: string; role: string; status?: string
  platformRole?: string | null
  userGroupId?: string | null; userGroupName?: string | null
  account?: { id: string; name: string; plan: string; status: string }
  features: Record<string, AccessLevel>
  model: { roles: string[]; features: string[]; levels: AccessLevel[]; notes: string[] }
}

export interface UserRow {
  id: string; email: string; role: TenantRole; status: 'active' | 'disabled' | 'invited'
  is_platform?: boolean
  user_group_id: string | null; user_group_name?: string | null
  created_at: string
}

export interface UserGroupRow {
  id: string; name: string; description: string | null
  permissions: Record<string, AccessLevel>
  member_count?: number
  created_at: string
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
}
export interface EventRow {
  id: string; group_id: string; name: string; status: string
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
  sources?: { role: 'primary' | 'backup'; protocol: string; ingestUrl?: string; streamKey?: string }[]
  inputFailoverEnabled?: boolean; autoFailback?: boolean
  inputLossBehavior?: 'none' | 'slate' | 'vod_loop' | 'last_frame' | 'black'
  fillerSlateRef?: string | null
}
export interface EventPatchBody extends Partial<Omit<EventCreateBody, 'groupId'>> { version?: number }

export interface EpgOwner { kind: 'channel' | 'event'; id: string }
export interface EpgOwnerRow {
  kind: 'channel' | 'event'; id: string; name: string; status: string
  programme_count: number; first_at: string | null; last_at: string | null
  auto_clip_count: number; next_title: string | null; next_at: string | null
}
export interface ProgrammeRow {
  id: string; channel_id: string | null; event_id: string | null
  title: string; starts_at: string; ends_at: string; status: string
  actual_start: string | null; actual_end: string | null
  auto_vod: boolean; geo_mode: 'worldwide' | 'allow' | 'block'; geo_countries: string[]
  replacement_kind: 'none' | 'slate' | 'loop' | 'vod'; replacement_ref: string | null
  clip_status: 'none' | 'firing' | 'created' | 'error'; clip_asset_id: string | null; clip_error: string | null
  metadata: Record<string, any>; series_id: string | null
}
export interface ProgrammeBody {
  title: string; startsAt: string; endsAt?: string
  autoVod?: boolean
  geoMode?: 'worldwide' | 'allow' | 'block'; geoCountries?: string[]
  replacementKind?: 'none' | 'slate' | 'loop' | 'vod'; replacementRef?: string | null
  metadata?: Record<string, any>
}
export interface ProgrammeConflict {
  a_id: string; a_title: string; b_id: string; b_title: string
  overlap_start: string; overlap_end: string
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
  buckets: (WaveBucket | null)[]
}

export interface RecordingTimeline {
  recordingId: string; streamId: string; kind: string; sourceName: string | null
  startMs: number; endMs: number | null; live: boolean; hasAudio: boolean
  audioOnly?: boolean   // radio recordings: player shows the audio visualiser
  spans: { runId: string; startMs: number; endMs: number; segments: number }[]
}

export interface VodAssetRow {
  id: string; kind: 'clip' | 'full_event' | string; title: string | null
  recording_id: string | null; start_epoch_ms: number | string; end_epoch_ms: number | string
  duration_ms: number | string | null; output_kind?: string | null
  thumb_status?: string | null; created_at: string
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
}

export interface IngestProtocol {
  id: string; label: string; ingest: 'push' | 'pull'
  urlLabel: string; urlPlaceholder: string; urlExample: string; urlPattern?: string
  streamKey: { show: boolean; label?: string; placeholder?: string }
  extraFields?: { key: string; label: string; type: string; required?: boolean; placeholder?: string; hint?: string }[]
  hint: string; packageFriendly: boolean
}

// origin URLs are same-origin under /origin (proxied by Vite to the API in dev)
export function originUrl(path: string) { return path.startsWith('/origin') ? path : `/origin${path}` }

// Resized preview via the image service: /img/<WxH>[,fit]/<store-key>. `url` is a
// library URL like '/library/<acct>/<path>'; the store key is that without the slash.
export function thumbUrl(libraryUrl: string, w: number, h: number, fit: 'cover' | 'inside' = 'cover') {
  const key = libraryUrl.replace(/^\//, '')
  if (!key.startsWith('library/')) return libraryUrl
  return `/img/${w}x${h},${fit}/${key}`
}
