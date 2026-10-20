// FAST channels: the console's calls (volt-app/src/modules/fast.ts).
import { apiRequest as apiReq } from '../api'

export interface FastChannelRow {
  id: string; name: string; status: string; group_id: string; origin: string
  lineup_id: string | null; lineup_name: string | null; version: number | null; applied_until: string | null; zone: string | null
  slot_count: number | null; on_air: string | null; ads_mode: 'off' | 'markers' | 'stitched'
}
export interface LibAsset {
  id: string; title: string; durationSec: number; series: string | null; season: number | null; episode: number | null
  availableFrom: string | null; availableUntil: string | null; ready: boolean; genre: string | null; breakCuesSec: number[]
}
export interface LibSeries { name: string; episodes: number; seasons: number[]; durationSec: number }
export type PoolRef = { assetId: string } | { skip: true }
export interface TitleSlot { id: string; kind: 'title'; pool: PoolRef[]; every?: number; phase?: number; label?: string }
export interface SeriesSlot { id: string; kind: 'series'; series: string; count: number; order: 'sequential' | 'shuffle'; atEnd?: 'loop' | 'stop'; every?: number; phase?: number; encoreOf?: string | null; label?: string }
export type Slot = TitleSlot | SeriesSlot
export interface LineupSettings { cycleShift?: number; anchor?: string | null; gridMin?: 0 | 5 | 15 | 30 | 60; backfill?: string[]; horizonDays?: number }
export interface Lineup {
  id: string; channel_id: string; name: string; version: number; status: 'draft' | 'active' | 'archived'
  epoch: string; zone: string; slots: Slot[]; settings: LineupSettings; applied_until: string | null; applied_at: string | null; updated_at: string
}
export interface PlannedBreak { start: string; durationSec: number; position: 'mid' | 'end'; atAssetSec: number; source: string }
export interface PlannedProgramme {
  key: string; cycle: number; slotId: string; assetId: string; title: string; start: string; end: string; contentEnd: string
  contentSec: number; padSec: number; note: 'rotation' | 'backfill' | 'encore' | null
  series: { name: string; season: number | null; episode: number | null; index: number; pass: number } | null
  warnings: string[]; breaks: PlannedBreak[]
}
export interface RepeatRow { assetId: string; title: string; plays: number; times: string[]; minGapHours: number | null; primetime: number; sameTimeRepeats: number }
export interface Preview {
  from: string; to: string; zone: string
  programmes: PlannedProgramme[]
  notices: { at: string; slotId: string | null; message: string }[]
  repeats: RepeatRow[]
  rotation: { lengthSec: number; passesPerWeek: number; dailyShiftMin: number; distinctClockTimes: string[]; warnings: string[]; everyFor4: number }
  ads: { minutesPerHour: number; breaks: number; adSec: number }
  series: { name: string; episodes: number }[]
}
export interface AdPolicy {
  enabled?: boolean; loadMinPerHour: number; breakSec: number; firstAfterMin: number; minGapMin: number; endGuardMin: number
  minProgrammeMin: number; betweenSec: number; useCues: boolean; slateAssetId?: string | null
}
export interface ChannelAds {
  mode: 'off' | 'markers' | 'stitched'; policy: AdPolicy; adServerId: string | null
  house: { assetId: string; title: string; durationSec: number; weight?: number }[]
  houseRefs: { assetId: string; weight?: number }[]; scope: 'channel' | 'session'
  servers?: { id: string; name: string; vendor: string; enabled: boolean }[]
}
export interface AdServer { id: string; name: string; vendor: string; tag_template: string; timeout_ms: number; max_wrappers: number; enabled: boolean }
export interface AdTest { request: string; elapsedMs: number; requests: number; problems: { code: number; message: string }[]; ads: { id: string; sequence: number | null; title: string | null; adSystem: string | null; durationSec: number; creativeKey: string; mediaFiles: number }[]; adSec: number }
export interface AdReport { decisions: number; fillRate: number | null; houseShare: number | null; slateShare: number | null; timeouts: number; errors: number; empty: number; notConditioned: number; p95Ms: number | null; creatives: { creative_key: string; title: string | null; ad_system: string | null; plays: number; status: string; last_seen_at: string }[] }

export interface Playout {
  launcher: string; status: 'starting' | 'running' | 'stopped' | 'failed'; started_at: string | null; last_seen_at: string | null
  last_pdt: string | null; media_sequence: number | null; restarts: number; error: string | null; unreadable: string[]; fresh: boolean
}
export interface ReadinessRow { assetId: string; title: string; role: 'content' | 'house' | 'slate'; state: 'ready' | 'preparing' | 'needs-prepare' | 'no-source'; why: string | null }

const J = (b: unknown) => ({ body: JSON.stringify(b) })

export const fastApi = {
  channels: (): Promise<{ items: FastChannelRow[] }> => apiReq('/fast/channels'),
  createChannel: (b: { name: string; groupId: string; zone: string }): Promise<{ channel: any; lineup: Lineup }> => apiReq('/fast/channels', { method: 'POST', ...J(b) }),
  channel: (id: string): Promise<{ channel: { id: string; name: string; status: string; origin: string; groupId: string; onAir: boolean }; lineups: Lineup[]; ads: ChannelAds; playout: Playout | null; urls?: { hls: string; dash: string; session: string } }> => apiReq(`/fast/channels/${id}`),
  library: (q = ''): Promise<{ assets: LibAsset[]; series: LibSeries[] }> => apiReq(`/fast/library${q ? `?q=${encodeURIComponent(q)}` : ''}`),
  newDraft: (channelId: string, copyFrom?: string): Promise<Lineup> => apiReq(`/fast/channels/${channelId}/lineups`, { method: 'POST', ...J(copyFrom ? { copyFrom } : {}) }),
  saveLineup: (id: string, b: Partial<Pick<Lineup, 'name' | 'zone' | 'slots' | 'settings'>>): Promise<Lineup> => apiReq(`/fast/lineups/${id}`, { method: 'PUT', ...J(b) }),
  deleteLineup: (id: string): Promise<null> => apiReq(`/fast/lineups/${id}`, { method: 'DELETE' }),
  preview: (id: string, b: { days?: number; from?: string; slots?: Slot[]; settings?: LineupSettings; zone?: string }): Promise<Preview> => apiReq(`/fast/lineups/${id}/preview`, { method: 'POST', ...J(b) }),
  activate: (id: string): Promise<{ epoch: string; applied: { inserted: number; replaced: number; breaks: number; conflicts: any[]; notices: any[] } }> => apiReq(`/fast/lineups/${id}/activate`, { method: 'POST', body: '{}' }),
  apply: (id: string, b: { days?: number; dryRun?: boolean } = {}): Promise<{ inserted: number; replaced: number; breaks: number; conflicts: any[]; until: string }> => apiReq(`/fast/lineups/${id}/apply`, { method: 'POST', ...J(b) }),
  ads: (channelId: string): Promise<ChannelAds> => apiReq(`/fast/channels/${channelId}/ads`),
  saveAds: (channelId: string, b: { mode?: string; policy?: Partial<AdPolicy>; adServerId?: string | null; houseAds?: { assetId: string; weight?: number }[]; scope?: string }): Promise<ChannelAds> => apiReq(`/fast/channels/${channelId}/ads`, { method: 'PUT', ...J(b) }),
  adServers: (): Promise<{ items: AdServer[] }> => apiReq('/fast/ad-servers'),
  addAdServer: (b: { name: string; vendor: string; tagTemplate: string; timeoutMs: number }): Promise<AdServer> => apiReq('/fast/ad-servers', { method: 'POST', ...J(b) }),
  testAdServer: (id: string, durationSec: number): Promise<AdTest> => apiReq(`/fast/ad-servers/${id}/test`, { method: 'POST', ...J({ durationSec }) }),
  readiness: (channelId: string): Promise<{ items: ReadinessRow[] }> => apiReq(`/fast/channels/${channelId}/readiness`),
  prepare: (channelId: string): Promise<{ queued: string[]; skipped: ReadinessRow[] }> => apiReq(`/fast/channels/${channelId}/prepare`, { method: 'POST', body: '{}' }),
  setOnAir: (channelId: string, on: boolean): Promise<{ onAir: boolean }> => apiReq(`/fast/channels/${channelId}/on-air`, { method: 'POST', ...J({ on }) }),
  adReport: (channelId: string, days = 7): Promise<AdReport> => apiReq(`/fast/channels/${channelId}/ad-report?days=${days}`),
}
