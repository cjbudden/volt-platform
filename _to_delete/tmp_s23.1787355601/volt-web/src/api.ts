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

export const api = {
  login: (email: string, password: string) =>
    req('/auth/login', { method: 'POST', body: JSON.stringify({ email, password }) }),
  groups: (): Promise<Group[]> => req('/groups'),
  // caption OUTPUT languages the pipeline can deliver (single source of truth for pickers)
  captionLanguages: (): Promise<{ languages: { code: string; label: string }[] }> => req('/caption-languages'),
  channels: (): Promise<Channel[]> => req('/channels'),
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
  recordings: (p: { kind?: string; channelId?: string; q?: string } = {}): Promise<RecordingRow[]> => {
    const qs = new URLSearchParams()
    if (p.kind) qs.set('kind', p.kind)
    if (p.channelId) qs.set('channelId', p.channelId)
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
  recordingProgrammes: (id: string): Promise<{ programmes: RecordingProgramme[] }> =>
    req(`/recordings/${id}/programmes`),
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
  title: string | null; status: 'recording' | 'closed' | string
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
}

export interface RecordingTimeline {
  recordingId: string; streamId: string; kind: string; sourceName: string | null
  startMs: number; endMs: number | null; live: boolean; hasAudio: boolean
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
