// ============================================================================
//  Console client for HTML graphics (volt-app/src/modules/graphics.ts).
// ============================================================================
import { apiRequest as req } from '../api'

export type Kind = 'scorebug' | 'lower_third' | 'ticker' | 'bug' | 'full_frame' | 'other'
export const KIND_LABEL: Record<Kind, string> = {
  scorebug: 'Scorebug', lower_third: 'Lower third', ticker: 'Ticker', bug: 'Bug', full_frame: 'Full frame', other: 'Other',
}
export type FieldType = 'text' | 'number' | 'image' | 'list' | 'color' | 'boolean'
export interface TField { id: string; type: FieldType; label: string; hidden?: boolean; options?: { value: string | number; label: string }[] }
export interface OgrafInfo { manifestPath: string; id: string; version?: string; author?: string; main: string; stepCount: number; customActions: { id: string; name: string }[] }
export interface Check { id: string; level: 'ok' | 'warn' | 'error'; title: string; detail: string }
export interface Manifest { name?: string; canvas: [number, number]; fps?: number; bbox?: [number, number, number, number]; snap?: boolean; fields: TField[]; sample: Record<string, any>; contract: string; manifestFrom: string; ograf?: OgrafInfo }
export interface Version {
  id: string; version: number | null; status: 'draft' | 'published'; manifest: Manifest; checks: Check[]; publishable: boolean
  sizeBytes: number; fileCount: number; note: string | null; createdAt: string; publishedAt: string | null; url: string
}
export type TemplateState = 'ready' | 'in_development' | 'incomplete' | 'empty'
export interface TemplateStatus { state: TemplateState; label: string; detail: string; draft?: { publishable: boolean; errors: number; warnings: number } }

/**
 * Values for a preview: the template's own sample, and a generated value for
 * every field the sample leaves out, so a template never previews empty just
 * because its author shipped no sample data. Image fields stay empty.
 */
export function previewValues(m: Manifest | undefined | null): Record<string, any> {
  const out: Record<string, any> = { ...(m?.sample ?? {}) }
  for (const f of m?.fields ?? []) {
    if (out[f.id] !== undefined && out[f.id] !== '') continue
    if (f.options?.length) { out[f.id] = f.options[0].value; continue }
    switch (f.type) {
      case 'number': out[f.id] = 0; break
      case 'boolean': out[f.id] = true; break
      case 'color': out[f.id] = '#1f6feb'; break
      case 'list': out[f.id] = [1, 2, 3].map((n) => `${f.label} ${n}`); break
      case 'image': break
      default: out[f.id] = f.label || f.id
    }
  }
  return out
}

export interface StyleToken { id: string; kind: 'color' | 'font'; via: 'var' | 'literal'; label: string; value: string; uses: number; files: string[] }
export interface StyleReport { versionId: string; tokens: StyleToken[]; fonts: { family: string; bundled: boolean; file?: string }[] }

export interface Template {
  id: string; name: string; kind: Kind; source: 'volt' | 'upload' | 'paste' | 'duplicate'; owner: 'volt' | 'account'
  status?: TemplateStatus
  /** Volt templates: the set it is in (News, General, Sport scores...). */
  set?: { id: string; key: string; name: string } | null
  /** false: a Volt template whose set is off for this account (or retired), listed because setups use it. */
  available?: boolean; retired?: boolean
  latest: Version | null; draft: Version | null; setups?: number; assignments?: number; createdAt: string; updatedAt: string
}
export interface TemplateDetail extends Template {
  versions: Version[]
  usedBy: { setupId: string; setupName: string; versionId: string; version: number | null; assignments: { id: string; name: string; onAir: boolean; runMode: string; channelId: string | null; eventId: string | null }[] }[]
}
export type SourceKind = 'text' | 'image' | 'feed' | 'guide' | 'operator' | 'api'
export interface Binding { source: SourceKind; value?: any; imageId?: string; sourceId?: string; path?: string; guide?: string }
export interface Placement { anchor?: string; x?: number; y?: number; scale?: number; layer?: number }
export interface Setup {
  id: string; name: string; note: string | null; templateId: string; templateName: string; templateKind: Kind
  versionId: string; version: number | null; versionStatus: string; latestVersion: number | null; latestVersionId: string | null; upgradeAvailable: boolean
  fields: Record<string, Binding>; placement: Placement; templateFields: TField[]; canvas: [number, number]; sources: SourceKind[]
  /** The template's drawn box, and whether the anchor places it (Manifest.snap). */
  bbox?: [number, number, number, number] | null; snap?: boolean
  /** The Image Library items its image fields use (GET/POST/PATCH of one setup). */
  images?: Record<string, { url: string; still: string; name: string; video: boolean }>
  assignments: { id: string; name: string; channelId: string | null; eventId: string | null; runMode: string; targets: string; onAir: boolean }[]
  templateUrl: string; updatedAt: string
}
export interface DataSource {
  id: string; name: string; kind: 'json' | 'rss' | 'push'; url: string | null; everySec: number; onStale: 'hold' | 'hide'; staleAfterSec: number
  lastOkAt: string | null; lastError: string | null; payload: any; status: 'ok' | 'stale' | 'error' | 'waiting'
}
export type RunMode = 'always' | 'rule' | 'trigger' | 'manual'
export interface Rule { genre?: string | string[]; titleContains?: string; days?: number[]; from?: string; to?: string; tz?: string; at?: 'programme_start' | 'programme_end'; offsetSec?: number; durationSec?: number }
export interface Assignment {
  id: string; setupId: string; setupName: string; templateName: string; version: number | null
  channelId: string | null; eventId: string | null; targetName: string; targets: 'player' | 'burn' | 'both'
  runMode: RunMode; rule: Rule; clearInAds: boolean; enabled: boolean; describe: string; onAir: boolean
  /** Times it came on screen in viewers' players in the last 24 h; null when it is burned in only. */
  impressions24h?: number | null
}
export interface LiveItem {
  id: string; setupId: string; setupName: string; templateName: string; templateKind: Kind; versionId: string; version: number | null
  canvas: [number, number]; fields: TField[]; templateUrl: string; placement: Placement
  targets: string; runMode: RunMode; rule: Rule; clearInAds: boolean; enabled: boolean
  onAir: boolean; reason: string; takenByHand: boolean; values: Record<string, any>; origin: Record<string, string>
  overrides: string[]; staleFeeds: string[]; rundownItemId: string | null; offAt: string | null; updatedAt: string | null; updatedBy: string | null
}
export interface Live { target: { kind: 'channel' | 'event'; id: string; name: string; live: boolean; workflow: string | null }; at: string; items: LiveItem[] }
export interface Cue { kind: 'manual' | 'time' | 'offset' | 'feed' | 'repeat'; at?: string; fromStartSec?: number; sourceId?: string; path?: string; equals?: string; everySec?: number }
export interface RundownItem {
  id: string; position: number; segment: string; title: string; setupId: string; setupName: string; templateName: string
  values: Record<string, any>; cue: Cue; staysSec: number | null; status: 'ready' | 'on_air' | 'done' | 'skipped'; takenAt: string | null; needsContent: boolean
}
export interface Rundown {
  event: { id: string; name: string; live: boolean; start: string | null; end: string | null; workflow: string | null }
  items: RundownItem[]; nextId: string | null; onAir: string[]
}
export interface LogRow { at: string; actor: string; action: string; field: string | null; old: any; new: any; assignmentId: string | null; setupName: string | null }
export interface Plan {
  from: string; to: string
  programmes: { id: string; title: string; startsAt: string; endsAt: string; kind: string; genres: string[] }[]
  assignments: { id: string; setupName: string; runMode: RunMode; windows: { start: string; end: string; reason: string }[] }[]
}

const J = (body: unknown): RequestInit => ({ body: JSON.stringify(body) })
const qs = (o: Record<string, string | undefined | null>) => {
  const p = Object.entries(o).filter(([, v]) => v != null && v !== '') as [string, string][]
  return p.length ? '?' + new URLSearchParams(p).toString() : ''
}

export const gfx = {
  templates: (q: { kind?: string; source?: string; q?: string } = {}): Promise<{ items: Template[] }> => req('/graphics/templates' + qs(q)),
  template: (id: string): Promise<TemplateDetail> => req(`/graphics/templates/${id}`),
  paste: (b: { name?: string; kind?: Kind; html: string; files?: Record<string, string | { base64: string }> }): Promise<Template> => req('/graphics/templates', { method: 'POST', ...J(b) }),
  upload: (file: Blob, o: { name?: string; kind?: Kind; filename?: string }): Promise<Template> =>
    req('/graphics/templates/import' + qs(o as any), { method: 'POST', body: file, headers: { 'content-type': 'application/octet-stream' } }),
  patchTemplate: (id: string, b: { name?: string; kind?: Kind }): Promise<Template> => req(`/graphics/templates/${id}`, { method: 'PATCH', ...J(b) }),
  archiveTemplate: (id: string) => req(`/graphics/templates/${id}`, { method: 'DELETE' }),
  style: (id: string, vid: string): Promise<StyleReport> => req(`/graphics/templates/${id}/versions/${vid}/style`),
  saveStyle: (id: string, b: { versionId: string; changes: Record<string, string>; addFonts?: { family: string; filename: string; base64: string }[] }): Promise<Version> =>
    req(`/graphics/templates/${id}/style`, { method: 'POST', ...J(b) }),
  duplicate: (id: string, name?: string): Promise<Template> => req(`/graphics/templates/${id}/duplicate`, { method: 'POST', ...J({ name }) }),
  putDraftPaste: (id: string, b: { html: string; path?: string; keep?: boolean; files?: Record<string, any> }): Promise<Version> => req(`/graphics/templates/${id}/draft`, { method: 'PUT', ...J(b) }),
  putDraftUpload: (id: string, file: Blob, filename: string): Promise<Version> =>
    req(`/graphics/templates/${id}/draft` + qs({ filename }), { method: 'PUT', body: file, headers: { 'content-type': 'application/octet-stream' } }),
  discardDraft: (id: string) => req(`/graphics/templates/${id}/draft`, { method: 'DELETE' }),
  publish: (id: string, note?: string): Promise<Version> => req(`/graphics/templates/${id}/draft/publish`, { method: 'POST', ...J({ note }) }),
  source: (id: string, vid: string): Promise<{ html: string; path?: string }> => req(`/graphics/templates/${id}/versions/${vid}/source`),
  downloadUrl: (id: string, vid: string) => `/api/graphics/templates/${id}/versions/${vid}/download`,

  setups: (templateId?: string): Promise<{ items: Setup[] }> => req('/graphics/setups' + qs({ template_id: templateId })),
  setup: (id: string): Promise<Setup> => req(`/graphics/setups/${id}`),
  createSetup: (b: { name: string; note?: string | null; versionId: string; fields: Record<string, Binding>; placement: Placement }): Promise<Setup> => req('/graphics/setups', { method: 'POST', ...J(b) }),
  patchSetup: (id: string, b: Partial<{ name: string; note: string | null; versionId: string; fields: Record<string, Binding>; placement: Placement }>): Promise<Setup & { droppedFields?: string[]; carriedFields?: string[] }> =>
    req(`/graphics/setups/${id}`, { method: 'PATCH', ...J(b) }),
  deleteSetup: (id: string) => req(`/graphics/setups/${id}`, { method: 'DELETE' }),

  sources: (): Promise<{ items: DataSource[] }> => req('/graphics/sources'),
  createSource: (b: { name: string; kind: DataSource['kind']; url?: string | null; everySec?: number; onStale?: 'hold' | 'hide'; staleAfterSec?: number }): Promise<DataSource> =>
    req('/graphics/sources', { method: 'POST', ...J(b) }),
  patchSource: (id: string, b: Partial<{ name: string; url: string; everySec: number; onStale: 'hold' | 'hide'; staleAfterSec: number }>): Promise<DataSource> =>
    req(`/graphics/sources/${id}`, { method: 'PATCH', ...J(b) }),
  deleteSource: (id: string) => req(`/graphics/sources/${id}`, { method: 'DELETE' }),
  testSource: (id: string): Promise<{ ok: boolean; payload?: any; error?: string; note?: string }> => req(`/graphics/sources/${id}/test`, { method: 'POST' }),

  assignments: (q: { channel_id?: string; event_id?: string; setup_id?: string } = {}): Promise<{ items: Assignment[] }> => req('/graphics/assignments' + qs(q)),
  assign: (b: { setupId: string; channelId?: string | null; eventId?: string | null; targets: string; runMode: RunMode; rule?: Rule; clearInAds?: boolean }): Promise<Assignment> =>
    req('/graphics/assignments', { method: 'POST', ...J(b) }),
  patchAssignment: (id: string, b: Partial<{ targets: string; runMode: RunMode; rule: Rule; clearInAds: boolean; enabled: boolean }>): Promise<Assignment> =>
    req(`/graphics/assignments/${id}`, { method: 'PATCH', ...J(b) }),
  unassign: (id: string) => req(`/graphics/assignments/${id}`, { method: 'DELETE' }),
  live: (t: { channel_id?: string; event_id?: string }): Promise<Live> => req('/graphics/live' + qs(t)),
  plan: (t: { channel_id?: string; event_id?: string; from?: string; to?: string }): Promise<Plan> => req('/graphics/plan' + qs(t)),
  setValues: (id: string, values: Record<string, any>, release: string[] = []): Promise<{ changed: number; state: LiveItem }> =>
    req(`/graphics/assignments/${id}/state`, { method: 'PATCH', ...J({ values, release }) }),
  air: (id: string, on: boolean, forSec?: number): Promise<{ changed: number; state: LiveItem }> => req(`/graphics/assignments/${id}/air`, { method: 'POST', ...J({ on, forSec }) }),
  log: (q: { assignment_id?: string; event_id?: string; channel_id?: string; limit?: string }): Promise<{ items: LogRow[] }> => req('/graphics/log' + qs(q)),

  rundown: (eventId: string): Promise<Rundown> => req(`/graphics/rundowns/${eventId}`),
  addItem: (eventId: string, b: { segment?: string; title: string; setupId: string; values?: Record<string, any>; cue?: Cue; staysSec?: number | null; position?: number }): Promise<Rundown> =>
    req(`/graphics/rundowns/${eventId}/items`, { method: 'POST', ...J(b) }),
  patchItem: (eventId: string, itemId: string, b: Partial<{ segment: string; title: string; setupId: string; values: Record<string, any>; cue: Cue; staysSec: number | null }>): Promise<Rundown> =>
    req(`/graphics/rundowns/${eventId}/items/${itemId}`, { method: 'PATCH', ...J(b) }),
  deleteItem: (eventId: string, itemId: string): Promise<Rundown> => req(`/graphics/rundowns/${eventId}/items/${itemId}`, { method: 'DELETE' }),
  reorder: (eventId: string, ids: string[], segments?: Record<string, string>): Promise<Rundown> => req(`/graphics/rundowns/${eventId}/reorder`, { method: 'POST', ...J({ ids, segments }) }),
  copyFrom: (eventId: string, from: string): Promise<Rundown & { copied: number; note: string }> => req(`/graphics/rundowns/${eventId}/copy-from`, { method: 'POST', ...J({ eventId: from }) }),
  importCsv: (eventId: string, csv: string, tz: string): Promise<Rundown & { imported: number }> =>
    req(`/graphics/rundowns/${eventId}/import-csv` + qs({ tz }), { method: 'POST', body: csv, headers: { 'content-type': 'text/csv' } }),
  take: (eventId: string, itemId?: string): Promise<Rundown> => req(`/graphics/rundowns/${eventId}/take`, { method: 'POST', ...J({ itemId }) }),
  takeOff: (eventId: string, itemId?: string): Promise<Rundown> => req(`/graphics/rundowns/${eventId}/take-off`, { method: 'POST', ...J({ itemId }) }),
  skip: (eventId: string, itemId: string, restore = false): Promise<Rundown> => req(`/graphics/rundowns/${eventId}/items/${itemId}/${restore ? 'restore' : 'skip'}`, { method: 'POST' }),
}

/** Seconds as the console says them: "8 s", "2 min", "1 h 30 min". */
export function fmtSec(n: number | null | undefined): string {
  if (n == null) return 'until taken off'
  if (n < 60) return `${n} s`
  if (n < 3600) return n % 60 ? `${Math.floor(n / 60)} min ${n % 60} s` : `${n / 60} min`
  const h = Math.floor(n / 3600), m = Math.round((n % 3600) / 60)
  return m ? `${h} h ${m} min` : `${h} h`
}
export function cueText(c: Cue, sources: DataSource[] = []): string {
  switch (c.kind) {
    case 'manual': return 'Manual'
    case 'time': return c.at ? `At ${new Date(c.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : 'At a time'
    case 'offset': return `${fmtSec(c.fromStartSec ?? 0)} after the start`
    case 'feed': {
      const s = sources.find((x) => x.id === c.sourceId)
      return `On feed${s ? ` ${s.name}` : ''}: ${c.path}${c.equals ? ` = ${c.equals}` : ' changes'}`
    }
    case 'repeat': return `Every ${fmtSec(c.everySec ?? 600)}`
  }
}
export const SOURCE_LABEL: Record<SourceKind, string> = {
  text: 'Fixed text', image: 'Image Library', feed: 'Data feed', guide: 'Channel guide', operator: 'Operator', api: 'API',
}
