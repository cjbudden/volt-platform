// FAST channels: the console's calls (volt-app/src/modules/fast.ts).
import { apiRequest as apiReq } from '../api'

export interface FastChannelRow {
  id: string; name: string; status: string; group_id: string; origin: string
  lineup_id: string | null; lineup_name: string | null; version: number | null; applied_until: string | null; zone: string | null
  slot_count: number | null; on_air: string | null; ads_mode: 'off' | 'markers' | 'stitched'; media: FastMedia
  /** The channel logo (Settings > Logo and artwork), shown in the list. */
  brand_ref?: string | null
}
/** A FAST channel carries video or audio; set when it is made, it decides what the library offers. */
export type FastMedia = 'video' | 'audio'
export interface LibAsset {
  id: string; title: string; durationSec: number; series: string | null; season: number | null; episode: number | null
  availableFrom: string | null; availableUntil: string | null; ready: boolean; genre: string | null; breakCuesSec: number[]
  media: FastMedia; sourceOk: boolean
  /** Against the channel's ladder: 'ok' fills its top rung, 'below' does not (listed only with "show all"), 'unmeasured' could not be checked. */
  fit?: 'ok' | 'below' | 'unmeasured'; fitWhy?: string | null
  quality?: { width: number | null; height: number | null; kbps: number | null }
}
/** A rung of a FAST channel's ladder: its 16:9 box and bitrate. */
export interface FastRung { height: number; width: number; bitrate_kbps: number }
/** The ladder every title on a FAST channel is packaged to (an encode ladder group). */
export interface FastLadder { groupId: string; groupName: string; rungs: FastRung[]; segmentSeconds: number; fps: number; inherited?: boolean; isDefault?: boolean }
/** The builder's library for one channel: only its media, only what can air. */
export interface ChannelLibrary {
  media: FastMedia | null; hidden: { otherMedia: number; noSource: number; notReady?: number; belowLadder?: number }; inUse: LibAsset[]; assets: LibAsset[]; series: LibSeries[]
  ladder?: { groupId: string; name: string; inherited: boolean; top: FastRung | null; rungs: FastRung[] } | null
  /** Titles left out because they cannot fill the ladder's top rendition, and why. */
  belowLadder?: { id: string; why: string | null }[]
}
export interface LibSeries { name: string; episodes: number; seasons: number[]; durationSec: number }
export type PoolRef = { assetId: string } | { skip: true }
export type AdRule = 'default' | 'none' | 'no_mid'
export interface TitleSlot { id: string; kind: 'title'; pool: PoolRef[]; every?: number; phase?: number; label?: string; adRule?: AdRule }
export interface SeriesSlot { id: string; kind: 'series'; series: string; count: number; order: 'sequential' | 'shuffle'; atEnd?: 'loop' | 'stop'; every?: number; phase?: number; encoreOf?: string | null; label?: string; adRule?: AdRule }
export type Slot = TitleSlot | SeriesSlot
export interface LineupSettings { cycleShift?: number; anchor?: string | null; gridMin?: 0 | 5 | 15 | 30 | 60; backfill?: string[]; horizonDays?: number }
export interface Lineup {
  id: string; channel_id: string; name: string; version: number; status: 'draft' | 'active' | 'archived'
  epoch: string; zone: string; slots: Slot[]; settings: LineupSettings; applied_until: string | null; applied_at: string | null; updated_at: string
}
export interface PlannedBreak { start: string; durationSec: number; position: 'mid' | 'end'; atAssetSec: number; source: string; fromPadSec?: number; capped?: boolean }
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
  placement?: 'both' | 'between' | 'mid'; betweenMode?: 'fixed' | 'earned'
  betweenMinSec?: number; betweenMaxSec?: number; betweenStepSec?: number; betweenEveryMin?: number
  maxPerHourMin?: number; padToAds?: boolean; padToAdsMinSec?: number; padToAdsMaxSec?: number
  podMaxAds?: number; maxAdSec?: number; dayparts?: Daypart[]
}
export interface Daypart {
  label?: string; from: string; to: string; days?: number[]
  loadMinPerHour?: number; breakSec?: number; betweenSec?: number; maxPerHourMin?: number; placement?: 'both' | 'between' | 'mid'
}
/** The channel's brand loop (volt-app services/fast/store.ts ChannelBrand). */
export type BrandMode = 'off' | 'pad' | 'between'
export interface ChannelBrand {
  mode: BrandMode; identIds: string[]; idents: { assetId: string; title: string; durationSec: number }[]
  loopAssetId: string | null; identBetweenSec: number
}
/** One line of the going-to-air rundown (GET /fast/channels/:id/rundown). */
export interface RundownRow {
  kind: 'programme' | 'break' | 'ident' | 'loop' | 'house' | 'slate'
  id: string; start: string; end: string; durationSec: number; title: string
  programmeId?: string; part?: 'starts' | 'resumes'
  /** The library asset that plays; `inSec` is where in it this row starts. */
  assetId?: string | null; inSec?: number
  fill?: { kind: string; title: string | null; durationSec: number }[]
}
export interface Rundown { now: string; from: string; to: string; adsMode: string; brandMode: BrandMode; items: RundownRow[] }
export interface ChannelAds {
  mode: 'off' | 'markers' | 'stitched'; policy: AdPolicy; adServerId: string | null; brand?: ChannelBrand
  /** Slate and loop picked from Loops & Fillers: library asset id -> filler asset id; breaksUseLoop plays the loop in unsold breaks too. */
  filler?: { sources: Record<string, string>; breaksUseLoop: boolean }
  house: { assetId: string; title: string; durationSec: number; weight?: number }[]
  houseRefs: { assetId: string; weight?: number }[]; scope: 'channel' | 'session'
  servers?: { id: string; name: string; vendor: string; enabled: boolean }[]
}
export interface AdServer { id: string; name: string; vendor: string; tag_template: string; timeout_ms: number; max_wrappers: number; enabled: boolean }
export interface AdTest { request: string; elapsedMs: number; requests: number; problems: { code: number; message: string }[]; ads: { id: string; sequence: number | null; title: string | null; adSystem: string | null; durationSec: number; creativeKey: string; mediaFiles: number }[]; adSec: number }
/** What the stitcher reported to the ad server (server-side beacons): per event, the ads that reached it and the pixels sent. */
export interface BeaconReport { impressions: number; completes: number; completionRate: number | null; failed: number; events: Record<string, { ads: number; sent: number; failed: number; pending: number }> }
export interface AdReport { decisions: number; fillRate: number | null; houseShare: number | null; slateShare: number | null; timeouts: number; errors: number; empty: number; notConditioned: number; p95Ms: number | null; beacons?: BeaconReport; creatives: { creative_key: string; title: string | null; ad_system: string | null; plays: number; status: string; last_seen_at: string }[] }

export interface Playout {
  launcher: string; status: 'starting' | 'running' | 'stopped' | 'failed'; started_at: string | null; last_seen_at: string | null
  last_pdt: string | null; media_sequence: number | null; restarts: number; error: string | null; unreadable: string[]; fresh: boolean
}
export interface ReadinessRow {
  assetId: string; title: string; role: 'content' | 'house' | 'slate' | 'ident' | 'loop'; state: 'ready' | 'preparing' | 'needs-prepare' | 'no-source'; why: string | null
  /** Ready from the asset's own encode, or from one made for the channel's ladder. */
  packaging?: 'main' | 'variant' | null; progress?: number | null; note?: string | null; failed?: boolean
}

const J = (b: unknown) => ({ body: JSON.stringify(b) })

export const fastApi = {
  channels: (): Promise<{ items: FastChannelRow[] }> => apiReq('/fast/channels'),
  createChannel: (b: { name: string; groupId: string; zone: string; media: FastMedia; ladderGroupId?: string | null }): Promise<{ channel: any; lineup: Lineup }> => apiReq('/fast/channels', { method: 'POST', ...J(b) }),
  channel: (id: string): Promise<{ channel: { id: string; name: string; status: string; origin: string; groupId: string; onAir: boolean; media: FastMedia; ladderGroupId?: string | null; ladder?: FastLadder | null }; settings: FastChannelSettings; lineups: Lineup[]; ads: ChannelAds; playout: Playout | null; urls?: { hls: string; dash: string; session: string } }> => apiReq(`/fast/channels/${id}`),
  library: (channelId?: string, q = '', all = false): Promise<ChannelLibrary> => {
    const p = new URLSearchParams(); if (channelId) p.set('channel', channelId); if (q) p.set('q', q); if (all) p.set('all', '1')
    const qs = p.toString(); return apiReq(`/fast/library${qs ? `?${qs}` : ''}`)
  },
  newDraft: (channelId: string, copyFrom?: string): Promise<Lineup> => apiReq(`/fast/channels/${channelId}/lineups`, { method: 'POST', ...J(copyFrom ? { copyFrom } : {}) }),
  saveLineup: (id: string, b: Partial<Pick<Lineup, 'name' | 'zone' | 'slots' | 'settings'>>): Promise<Lineup> => apiReq(`/fast/lineups/${id}`, { method: 'PUT', ...J(b) }),
  deleteLineup: (id: string): Promise<null> => apiReq(`/fast/lineups/${id}`, { method: 'DELETE' }),
  preview: (id: string, b: { days?: number; from?: string; slots?: Slot[]; settings?: LineupSettings; zone?: string }): Promise<Preview> => apiReq(`/fast/lineups/${id}/preview`, { method: 'POST', ...J(b) }),
  activate: (id: string): Promise<{ epoch: string; applied: { inserted: number; replaced: number; breaks: number; conflicts: any[]; notices: any[] } }> => apiReq(`/fast/lineups/${id}/activate`, { method: 'POST', body: '{}' }),
  apply: (id: string, b: { days?: number; dryRun?: boolean } = {}): Promise<{ inserted: number; replaced: number; breaks: number; conflicts: any[]; until: string }> => apiReq(`/fast/lineups/${id}/apply`, { method: 'POST', ...J(b) }),
  ads: (channelId: string): Promise<ChannelAds> => apiReq(`/fast/channels/${channelId}/ads`),
  saveAds: (channelId: string, b: { mode?: string; policy?: Partial<AdPolicy>; adServerId?: string | null; houseAds?: { assetId: string; weight?: number }[]; scope?: string; brand?: { mode: BrandMode; identIds: string[]; loopAssetId?: string | null } }): Promise<ChannelAds> => apiReq(`/fast/channels/${channelId}/ads`, { method: 'PUT', ...J(b) }),
  adServers: (): Promise<{ items: AdServer[] }> => apiReq('/fast/ad-servers'),
  addAdServer: (b: { name: string; vendor: string; tagTemplate: string; timeoutMs: number }): Promise<AdServer> => apiReq('/fast/ad-servers', { method: 'POST', ...J(b) }),
  testAdServer: (id: string, durationSec: number): Promise<AdTest> => apiReq(`/fast/ad-servers/${id}/test`, { method: 'POST', ...J({ durationSec }) }),
  readiness: (channelId: string): Promise<{ items: ReadinessRow[]; ladder?: FastLadder | null }> => apiReq(`/fast/channels/${channelId}/readiness`),
  /** The ladders a FAST channel can use. */
  ladders: (): Promise<{ items: FastLadder[] }> => apiReq('/fast/ladders'),
  /** Change the channel's ladder (null: the account default); everything on it is packaged to the new one behind the scenes. */
  setLadder: (channelId: string, ladderGroupId: string | null): Promise<{ ladder: FastLadder | null; prepared: { queued: string[]; skipped: ReadinessRow[] }; restartNeeded: boolean }> =>
    apiReq(`/fast/channels/${channelId}/ladder`, { method: 'PUT', ...J({ ladderGroupId }) }),
  prepare: (channelId: string): Promise<{ queued: string[]; skipped: ReadinessRow[] }> => apiReq(`/fast/channels/${channelId}/prepare`, { method: 'POST', body: '{}' }),
  /** Slate and gap loop from Loops & Fillers (null takes one off). */
  saveFiller: (channelId: string, b: { slateFillerId?: string | null; loopFillerId?: string | null; breaksUseLoop?: boolean }): Promise<ChannelAds & { prepared?: { queued: string[] } | null }> => apiReq(`/fast/channels/${channelId}/filler`, { method: 'PUT', ...J(b) }),
  /** Start, restart or stop the channel's playout by hand. */
  playout: (channelId: string, action: 'start' | 'restart' | 'stop'): Promise<{ playout: string }> => apiReq(`/fast/channels/${channelId}/playout`, { method: 'POST', ...J({ action }) }),
  setOnAir: (channelId: string, on: boolean): Promise<{ onAir: boolean }> => apiReq(`/fast/channels/${channelId}/on-air`, { method: 'POST', ...J({ on }) }),
  rundown: (channelId: string, hours = 3): Promise<Rundown> => apiReq(`/fast/channels/${channelId}/rundown?hours=${hours}`),
  adReport: (channelId: string, days = 7): Promise<AdReport> => apiReq(`/fast/channels/${channelId}/ad-report?days=${days}`),
}

/** A FAST channel's own settings (GET /fast/channels/:id), saved with api.updateChannel. */
export interface FastChannelSettings {
  version: number | null; schemaId: string | null; metadata: Record<string, any>; brandRef: string | null; guideIconRef: string | null
  graphics: { upNext?: { enabled?: boolean; leadSec?: number; durationSec?: number } }; epgEnabled: boolean
  watermark: { enabled: boolean; ref: string | null; position: 'tl' | 'tr' | 'bl' | 'br' | 'tc' | 'bc'; offsetX: number; offsetY: number; opacity: number; scale: number }
}
