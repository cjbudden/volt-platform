// Rights profiles (build queue R1): the console's view of /api/rights.
import { apiRequest as req, getToken } from '../api'

export type TerritoryMode = 'worldwide' | 'allow' | 'block'
export type AppMode = 'all' | 'allow' | 'block'
export type RightsAppType = 'web' | 'mobile' | 'smart_tv' | 'embed' | 'partner' | 'venue'
export type Use = 'on_demand' | 'fast' | 'clips' | 'social' | 'downloads' | 'ads'
export type AccessType = 'free' | 'members' | 'subscription' | 'ppv'
export type RightsWindow =
  | { kind: 'open' }
  | { kind: 'fixed'; from?: string | null; until?: string | null }
  | { kind: 'relative'; count: number; unit: 'day' | 'month' | 'year'; from: 'first_air' | 'ingest' }

export interface RightsProfile {
  id: string
  name: string
  builtin: 'open' | 'closed' | null
  provider: string | null
  takedownContact: string | null
  agreementRef: string | null
  territoryMode: TerritoryMode
  territories: string[]
  appMode: AppMode
  appTypes: RightsAppType[]
  appIds: string[]
  uses: Use[]
  accessTypes: AccessType[]
  window: RightsWindow
  warnDays: number
  agreement: { name: string; size: number; type: string; uploadedBy: string; uploadedAt: string } | null
  assetCount?: number
  isDefault?: boolean
  setBy?: { how: string; count: number }[]
  createdAt?: string
  updatedAt?: string
}
export type ProfileInput = Omit<RightsProfile, 'id' | 'builtin' | 'agreement' | 'assetCount' | 'isDefault' | 'setBy' | 'createdAt' | 'updatedAt'>

export interface RightsNarrow {
  territories?: string[]
  blockTerritories?: string[]
  appTypes?: RightsAppType[]
  blockAppIds?: string[]
  uses?: Use[]
  from?: string | null
  until?: string | null
}
export interface AssetRights {
  assetId: string
  profile: RightsProfile | null
  narrow: RightsNarrow | null
  setBy: string | null
  setAt: string | null
  effective: {
    territoryMode: TerritoryMode; territories: string[]; blockTerritories: string[]
    appMode: AppMode; appTypes: RightsAppType[]; appIds: string[]; blockAppIds: string[]
    uses: Use[]; accessTypes: AccessType[]; from: string | null; until: string | null; narrowed: boolean
  }
}

const json = (body: unknown) => ({ body: JSON.stringify(body) })

export const rightsApi = {
  profiles: (): Promise<RightsProfile[]> => req('/rights/profiles'),
  profile: (id: string): Promise<RightsProfile> => req(`/rights/profiles/${id}`),
  create: (p: ProfileInput): Promise<RightsProfile> => req('/rights/profiles', { method: 'POST', ...json(p) }),
  update: (id: string, p: ProfileInput): Promise<RightsProfile> => req(`/rights/profiles/${id}`, { method: 'PUT', ...json(p) }),
  remove: (id: string): Promise<void> => req(`/rights/profiles/${id}`, { method: 'DELETE' }),
  assets: (id: string): Promise<{ items: { id: string; title: string; state: string | null; narrowed: boolean; setBy: string | null }[]; hasMore: boolean }> =>
    req(`/rights/profiles/${id}/assets?limit=50`),
  settings: (): Promise<RightsSettings> => req('/rights/settings'),
  setDefault: (defaultProfileId: string) => req('/rights/settings', { method: 'PUT', ...json({ defaultProfileId }) }),
  /** The block message (null: the default words) and Notify me (build queue P2-2). */
  setBlock: (b: { blockMessage?: string | null; notifyMe?: boolean }): Promise<RightsSettings> => req('/rights/settings', { method: 'PUT', ...json(b) }),
  asset: (id: string): Promise<AssetRights> => req(`/rights/assets/${id}`),
  setAsset: (id: string, profileId: string, narrow: RightsNarrow | null): Promise<AssetRights> =>
    req(`/rights/assets/${id}`, { method: 'PUT', ...json({ profileId, narrow }) }),
  assign: (profileId: string, assetIds: string[]) => req('/rights/assign', { method: 'POST', ...json({ profileId, assetIds }) }),
  check: (b: { assetId: string; country?: string; appId?: string; appType?: RightsAppType; use?: Use }): Promise<{ allowed: boolean; code?: string; reason?: string }> =>
    req('/rights/check', { method: 'POST', ...json(b) }),
  /** The agreement goes up as the file's own bytes. */
  async uploadAgreement(id: string, file: File) {
    const r = await fetch(`/api/rights/agreements/${id}?name=${encodeURIComponent(file.name)}`, {
      method: 'PUT', headers: { authorization: `Bearer ${getToken()}`, 'content-type': file.type || 'application/octet-stream' }, body: file,
    })
    const body = await r.json().catch(() => ({}))
    if (!r.ok) throw new Error(body?.error || `Upload failed (${r.status})`)
    return body
  },
  /** Opened through a fetch so the session token goes with it; every read is audited. */
  async openAgreement(id: string, name: string) {
    const r = await fetch(`/api/rights/agreements/${id}`, { headers: { authorization: `Bearer ${getToken()}` } })
    if (!r.ok) { const b = await r.json().catch(() => ({})); throw new Error(b?.error || `Could not open it (${r.status})`) }
    const url = URL.createObjectURL(await r.blob())
    const a = document.createElement('a'); a.href = url; a.download = name; a.click()
    setTimeout(() => URL.revokeObjectURL(url), 30_000)
  },
}

export const USE_LABEL: Record<Use, { name: string; note: string }> = {
  on_demand: { name: 'On demand', note: 'Catalogue, apps, embeds' },
  fast: { name: 'FAST and linear', note: 'Pools, lineups, channels' },
  clips: { name: 'Clips', note: 'Highlights cut from it' },
  social: { name: 'Social', note: 'Posting to social accounts' },
  downloads: { name: 'Downloads', note: 'Offline viewing in apps' },
  ads: { name: 'Ads', note: 'Ad breaks around and in it' },
}
export const USES = Object.keys(USE_LABEL) as Use[]
export const ACCESS_LABEL: Record<AccessType, string> = { free: 'Free', members: 'Members', subscription: 'Subscription', ppv: 'Pay per view' }
export const ACCESS_TYPES = Object.keys(ACCESS_LABEL) as AccessType[]
export const APP_LABEL: Record<RightsAppType, { name: string; note: string }> = {
  web: { name: 'Web', note: 'Browsers' },
  mobile: { name: 'Mobile', note: 'iOS, Android' },
  smart_tv: { name: 'Smart TV', note: 'tvOS, Android TV, Roku' },
  embed: { name: 'Embeds', note: 'Players on other sites' },
  partner: { name: 'Partner apps', note: 'Server apps using your API' },
  venue: { name: 'In-venue', note: 'Kiosks, venue screens' },
}
export const APP_TYPES = Object.keys(APP_LABEL) as RightsAppType[]

/** A registered app's type as the rights see it (the server's appTypeOf). */
export function appTypeOf(type: string, surface?: string | null): RightsAppType {
  if (surface === 'embed' || surface === 'venue') return surface
  if (type === 'ios' || type === 'android') return 'mobile'
  if (type === 'tv' || type === 'roku') return 'smart_tv'
  if (type === 'server') return 'partner'
  return 'web'
}

const regionNames = (() => { try { return new Intl.DisplayNames(['en'], { type: 'region' }) } catch { return null } })()
export const countryName = (code: string) => { try { return regionNames?.of(code) ?? code } catch { return code } }

export function territorySummary(mode: TerritoryMode, list: string[]): string {
  if (mode === 'worldwide') return 'Worldwide'
  if (mode === 'allow') return list.length ? list.join(', ') : 'None'
  return `Worldwide except ${list.join(', ')}`
}

export function windowSummary(w: RightsWindow): string {
  // Rights dates are whole days in UTC (a window ends at 23:59:59Z), so they are shown in UTC.
  const d = (s?: string | null) => (s ? new Date(s).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }) : '')
  if (w.kind === 'fixed') {
    if (w.from && w.until) return `${d(w.from)} to ${d(w.until)}`
    if (w.until) return `Until ${d(w.until)}`
    if (w.from) return `From ${d(w.from)}`
    return 'Open'
  }
  if (w.kind === 'relative') return `${w.count} ${w.unit}${w.count === 1 ? '' : 's'} from ${w.from === 'ingest' ? 'ingest' : 'first air'}`
  return 'Open'
}

/** Days until a fixed window ends, or null. */
export function daysLeft(w: RightsWindow): number | null {
  if (w.kind !== 'fixed' || !w.until) return null
  return Math.ceil((new Date(w.until).getTime() - Date.now()) / 86400_000)
}

/** A rights date as a day, in UTC like the window itself. */
export const rightsDay = (s: string) => new Date(s).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' })

/** GET /api/rights/settings */
export interface RightsSettings {
  defaultProfileId: string
  builtins: { open: string; closed: string }
  /** What a viewer is told where a title cannot play; null means the default words. */
  blockMessage: string | null
  blockMessageDefault: string
  notifyMe: boolean
  notifyRequests: { total: number; titles: Array<{ assetId: string; title: string | null; count: number }> }
}
