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
  enabled?: boolean; recording_retention_days: number | null; recording_retention_sec?: number | null
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
  captions: { enabled: boolean; targets: string[]; source_lang: string }
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
  recordingRetentionDays?: number | null
  dvrWindowSec?: number | null
  dvrMode?: 'sliding' | 'event_start'
  geoMode?: 'worldwide' | 'allow' | 'block'
  geoCountries?: string[]
  epgEnabled?: boolean
  sources?: { role: 'primary' | 'backup'; protocol: string; ingestUrl?: string; streamKey?: string }[]
  captions?: { enabled?: boolean; sourceLang?: string; targets?: string[] }
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
    resilienceTier?: string; recordingRetentionDays?: number | null; recordingRetentionSec?: number | null
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
  }): Promise<{ id: string; url: string; token: string; expiresAt: string }> =>
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
