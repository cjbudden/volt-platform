// Publishing policies in the console (build queue P3-2): the policy sections,
// locks, presets, conflicts and the impact of a save, from
// /api/publishing-rules (volt-app/src/modules/publishingRules.ts, P3).
// Kept in its own file so api.ts does not grow without end.
import { apiRequest as req, ApiError, type RuleSettings, type RuleScope, type Rung, type ResolvedRules } from '../api'

/** The three sections whose fields resolve one by one (services/publishingRules.ts SECTION_FIELDS). */
export interface PolicySections {
  protection?: { drm?: boolean; tokenLifetimeSec?: number | null; waf?: 'off' | 'standard' | 'rights_managed'; referrers?: string[]; concurrentStreams?: number | null; tokenFree?: boolean }
  distribution?: { mp4Download?: boolean; shareLinks?: boolean; fastEligible?: boolean; sitemap?: boolean }
  retention?: { keep?: 'forever' | 'days'; days?: number | null; anchor?: 'ingest' | 'available_from' | 'available_until'; legalHoldAllowed?: boolean; archiveTier?: 'infrequent' | 'glacier' | null }
}
export type PolicySettings = RuleSettings & PolicySections
export type SectionKey = keyof PolicySections
export const SECTION_KEYS: SectionKey[] = ['protection', 'distribution', 'retention']

export type PresetKey = 'open' | 'members' | 'geo_locked' | 'premium' | 'rights_managed'
export interface Preset { key: PresetKey; name: string; summary: string; settings: PolicySettings }

export type ConflictLevel = 'block' | 'warn' | 'confirm'
export interface Conflict { code: string; level: ConflictLevel; fields: string[]; message: string }
export interface ImpactEntry { code: string; message: string; count: number; titles: { id: string; title: string }[] }
/** publishedChanged and unavailableNow (build queue P3-4): published titles take up a save within about a minute. */
export interface Impact { assets: number; published: number; changed: number; repackage: number; publishedChanged?: number; unavailableNow?: number; blocks: ImpactEntry[]; warnings: ImpactEntry[] }
export interface DryRun { dryRun: true; saved: false; canSave: boolean; conflicts: Conflict[]; impact: Impact }

/** A rung as stored, with what P3 added beside its settings. */
export interface PolicyRule {
  id?: string; scope_kind: RuleScope; scope_id: string | null; settings: PolicySettings
  locked_fields?: string[]; name?: string | null; preset_key?: PresetKey | null; version?: number; missing?: boolean
}
/** /resolve with the P3 additions. */
export interface ResolvedPolicy extends ResolvedRules {
  settings: ResolvedRules['settings'] & Required<PolicySections>
  fieldSources?: Record<string, Rung>
  locks?: Record<string, Rung>
  ignored?: { rung: Rung; field: string; lockedBy: Rung }[]
  rungs: (ResolvedRules['rungs'][number] & { lockedFields?: string[]; presetKey?: string | null })[]
  conflicts?: Conflict[]
}

export interface PolicyBody { settings: PolicySettings; lockedFields: string[]; presetKey: PresetKey | null; confirm?: boolean }
/** The rungs a policy is saved on: the three of publishing_rules and a metadata rule (P3-3, by its id). */
export type PolicyScope = RuleScope | 'metadata'
const path = (kind: PolicyScope, id: string | null) => kind === 'metadata' ? `/publishing-rules/metadata-rules/${id}` : `/publishing-rules/${kind}${id ? '/' + id : ''}`

export const policyApi = {
  presets: (): Promise<Preset[]> => req('/publishing-rules/presets'),
  rule: (kind: PolicyScope, id: string | null): Promise<PolicyRule> => req(path(kind, id)),
  /** What saving would do, nothing saved. */
  dryRun: (kind: PolicyScope, id: string | null, b: PolicyBody): Promise<DryRun> =>
    req(path(kind, id) + '?dryRun=1', { method: 'PUT', body: JSON.stringify(b) }),
  save: (kind: PolicyScope, id: string | null, b: PolicyBody): Promise<PolicyRule & { warnings: Conflict[]; impact: Impact }> =>
    req(path(kind, id), { method: 'PUT', body: JSON.stringify(b) }),
  /** The asset rung (build queue P3-2b): the title's own override, checked like a rule. */
  assetDryRun: (assetId: string, override: PolicySettings): Promise<DryRun> =>
    req(`/vod/${assetId}/availability?dryRun=1`, { method: 'PATCH', body: JSON.stringify({ override }) }),
  assetSave: (assetId: string, override: PolicySettings, confirm = false): Promise<{ override: PolicySettings; reapplied: boolean; state: string; warnings?: Conflict[] }> =>
    req(`/vod/${assetId}/availability`, { method: 'PATCH', body: JSON.stringify({ override, ...(confirm ? { confirm: true } : {}) }) }),
}

/** A refusal the editor can act on: 422 policy_conflict or 409 confirm_repackage, with their details. */
export function policyRefusal(e: unknown): { code: 'policy_conflict' | 'confirm_repackage'; message: string; conflicts: Conflict[]; impact: Impact | null } | null {
  if (!(e instanceof ApiError) || !e.body) return null
  const code = e.body.code
  if (code !== 'policy_conflict' && code !== 'confirm_repackage') return null
  return { code, message: e.message, conflicts: e.body.details?.conflicts ?? [], impact: e.body.details?.impact ?? null }
}

// ---------------------------------------------------------------------------
//  Metadata rules (build queue P3-3): an ordered list of conditions, each
//  choosing a policy; the first a title meets applies.
// ---------------------------------------------------------------------------
export interface MetaCond { field: string; op: string; value?: any }
export interface MetaGroup { match: 'all' | 'any'; conditions: (MetaCond | MetaGroup)[] }
export interface MetadataRule {
  id: string; position: number; name: string; conditions: MetaGroup; settings: PolicySettings
  locked_fields: string[]; preset_key: PresetKey | null; enabled: boolean; version: number
  /** How many titles it governs now (the first rule they meet). */
  titles?: number
}
export interface MetaTest {
  asset: { id: string; title: string | null }
  matched: { id: string; name: string; position: number } | null
  rules: { id: string; name: string; enabled: boolean; matches: boolean }[]
  resolved: ResolvedPolicy
}
const MR = '/publishing-rules/metadata-rules'
export const metadataRulesApi = {
  list: (): Promise<{ items: MetadataRule[] }> => req(MR),
  fields: (): Promise<any> => req(`${MR}/fields`),
  create: (b: { name: string; conditions: MetaGroup }): Promise<MetadataRule> => req(MR, { method: 'POST', body: JSON.stringify(b) }),
  /** Name, conditions and on or off; the policy is saved through the editor (policyApi.save). */
  update: (id: string, b: { name?: string; conditions?: MetaGroup; enabled?: boolean }): Promise<MetadataRule> => req(`${MR}/${id}`, { method: 'PUT', body: JSON.stringify(b) }),
  remove: (id: string): Promise<void> => req(`${MR}/${id}`, { method: 'DELETE' }),
  order: (ids: string[]): Promise<{ items: MetadataRule[] }> => req(`${MR}/order`, { method: 'PUT', body: JSON.stringify({ ids }) }),
  test: (assetId: string): Promise<MetaTest> => req(`${MR}/test`, { method: 'POST', body: JSON.stringify({ assetId }) }),
}
