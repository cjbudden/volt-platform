// Publishing policies in the console (build queue P3-2): the policy sections,
// locks, presets, conflicts and the impact of a save, from
// /api/publishing-rules (volt-app/src/modules/publishingRules.ts, P3).
// Kept in its own file so api.ts does not grow without end.
import { apiRequest as req, ApiError, type RuleSettings, type RuleScope, type Rung, type ResolvedRules } from '../api'

/** The three sections whose fields resolve one by one (services/publishingRules.ts SECTION_FIELDS). */
export interface PolicySections {
  protection?: { drm?: boolean; tokenLifetimeSec?: number | null; waf?: 'off' | 'standard' | 'rights_managed'; referrers?: string[]; concurrentStreams?: number | null }
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
export interface Impact { assets: number; published: number; changed: number; repackage: number; blocks: ImpactEntry[]; warnings: ImpactEntry[] }
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
const path = (kind: RuleScope, id: string | null) => `/publishing-rules/${kind}${id ? '/' + id : ''}`

export const policyApi = {
  presets: (): Promise<Preset[]> => req('/publishing-rules/presets'),
  rule: (kind: RuleScope, id: string | null): Promise<PolicyRule> => req(path(kind, id)),
  /** What saving would do, nothing saved. */
  dryRun: (kind: RuleScope, id: string | null, b: PolicyBody): Promise<DryRun> =>
    req(path(kind, id) + '?dryRun=1', { method: 'PUT', body: JSON.stringify(b) }),
  save: (kind: RuleScope, id: string | null, b: PolicyBody): Promise<PolicyRule & { warnings: Conflict[]; impact: Impact }> =>
    req(path(kind, id), { method: 'PUT', body: JSON.stringify(b) }),
}

/** A refusal the editor can act on: 422 policy_conflict or 409 confirm_repackage, with their details. */
export function policyRefusal(e: unknown): { code: 'policy_conflict' | 'confirm_repackage'; message: string; conflicts: Conflict[]; impact: Impact | null } | null {
  if (!(e instanceof ApiError) || !e.body) return null
  const code = e.body.code
  if (code !== 'policy_conflict' && code !== 'confirm_repackage') return null
  return { code, message: e.message, conflicts: e.body.details?.conflicts ?? [], impact: e.body.details?.impact ?? null }
}
