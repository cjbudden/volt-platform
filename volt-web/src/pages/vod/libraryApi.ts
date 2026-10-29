// ============================================================================
//  MEDIA LIBRARY API CLIENT: the list with its paging headers, facet counts,
//  target metadata, encode details and EPG auto-fill. Kept beside the page
//  rather than in api.ts (see apiRequest there).
// ============================================================================
import { apiRequest, apiRequestWithHeaders, type VodAssetRow } from '../../api'

export interface LibraryRow extends VodAssetRow {
  source_kind?: string | null
  channel_id?: string | null
  event_id?: string | null
  poster_key?: string | null
  /** square: album cover or station artwork, drawn whole; wide: a video frame (docs/ASSET_IMAGES.md). */
  poster_shape?: 'wide' | 'square' | null
  poster_source?: string | null
  audio_only?: boolean
  /** The colour key when there is no image (KIND_COLOUR in LibraryCells.tsx). */
  media_kind?: 'video' | 'audio' | 'music'
  /** An MP3 file was made for it. */
  has_mp3?: boolean
  schema_name?: string | null
  schema_key?: string | null
  schema_org_type?: string | null
  origin?: 'recording' | 'clip' | 'upload' | 'watchfolder'
  metadata_completeness?: number | null
  metadata_missing_required?: boolean
  top_height?: number | null
  video_codec?: string | null
  rendition_count?: number | null
  encode_state?: string | null
  encode_pct?: number | null
  encode_result?: any
}

export interface LibraryPage {
  rows: LibraryRow[]
  total: number | null
  next: string | null
  prev: string | null
}

export interface FacetType { id: string | null; name: string | null; key: string | null; schema_org_type: string | null; n: number }
export interface FacetValue { value: any; n: number }
export interface LibraryFacets {
  total: number
  facets: { types: FacetType[]; availability: FacetValue[]; origins: FacetValue[]; sources?: FacetValue[]; media_types?: FacetValue[]; resolutions: FacetValue[]; codecs: FacetValue[]; metadata: FacetValue[]; usage?: FacetValue[] }
}

export interface TargetMetadata {
  type: { id: string; name: string; key: string | null; schemaOrgType: string | null } | null
  fields: { key: string; label: string; type: string; required: boolean; options?: string[]; multiple?: boolean; schemaOrg: string | null; epg: string | null }[]
  completeness: { pct: number | null; filled: number; total: number; missingRequired: string[]; missingRecommended: string[]; notOnType: string[] }
  provenance: Record<string, { source: string; programmeId?: string; programmeTitle?: string; at?: string; by?: string; token?: string | null; reason?: string | null; linked?: boolean }>
}

export type Prov = 'stored' | 'derived' | 'unknown'
export interface EncodeDetails {
  workflow: { value: string | null; source: Prov }
  ladder: { value: string | null; source: Prov }
  renditions: { value: { height: number; width: number | null; bitrateKbps: number | null; codec: string; profile: string | null; fps: number | null; level?: string | null }[]; source: Prov }
  dropped: { height: number; why: string }[]
  audio: { value: { codec: string; channels: number | null; bitrateKbps: number | null; sampleRate: number | null; language: string | null }[]; source: Prov }
  captions: { value: { language: string; kind: string; source: string }[]; source: Prov }
  segmentSeconds: { value: number | null; source: Prov }
  packaging: { value: string[]; source: Prov }
  container: { value: string | null; source: Prov }
  drm: { value: string[]; source: Prov }
  source: { width: number | null; height: number | null; fps: number | null; durationMs: number | null; hasAudio: boolean | null; bytes: number | null; filename: string | null; mime: string | null; origin: string
    videoCodec?: string | null; videoProfile?: string | null
    audioTracks?: { codec: string | null; channels: number | null; sampleRate: number | null; bitrateKbps: number | null; language: string | null }[] | null
    subtitleTracks?: { codec: string | null; language: string | null }[] | null }
  notes?: string[]
  summary: { topHeight: number | null; codec: string | null; renditions: number; label: string }
  gaps: string[]
  kind?: 'video' | 'audio'
  audioEncode?: { codec: string; bitrateKbps: number | null; sampleRate: number | null; channels: number | null; source: Prov; note: string | null } | null
  deliveries?: { format: string; label: string; state: 'ready' | 'making' | 'failed' | 'not_requested'; detail: string | null; key: string | null }[]
}

export interface EpgCandidate { programmeId: string; title: string; startsAt: string; endsAt: string; overlapMs: number; assetCoverage: number; programmeCoverage: number; linked: boolean }
export interface EpgSuggestion { field: string; label: string; value: any; current: any; action: 'fill' | 'same' | 'conflict'; required: boolean; programmeId: string }
export interface EpgPreview {
  match: { candidates: EpgCandidate[]; best: EpgCandidate | null; confident: boolean; reason: string | null }
  programme: { id: string; title: string; startsAt: string; endsAt: string } | null
  suggestions: EpgSuggestion[]
  suggestedType: { key: string; id: string; name: string; dropsFields: string[] } | null
  titleSuggestion: { value: string; current: string | null; action: 'fill' | 'same' | 'conflict' } | null
}
export interface EpgApplyResult { assetId: string; applied: string[]; skipped: { field: string; why: string }[]; programmeId: string | null; typeChanged: boolean; titleChanged: boolean; reason: string | null }

export const libraryApi = {
  page: async (qs: string): Promise<LibraryPage> => {
    const { body, headers } = await apiRequestWithHeaders(`/vod?${qs}`)
    const t = headers.get('X-Total-Count')
    return { rows: body as LibraryRow[], total: t == null ? null : Number(t), next: headers.get('X-Next-Cursor'), prev: headers.get('X-Prev-Cursor') }
  },
  facets: (qs: string): Promise<LibraryFacets> => apiRequest(`/vod/facets${qs ? `?${qs}` : ''}`),
  targetMetadata: (id: string): Promise<TargetMetadata> => apiRequest(`/vod/${id}/target-metadata`),
  encode: (id: string): Promise<EncodeDetails> => apiRequest(`/vod/${id}/encode`),
  epgPreview: (id: string, programmeId?: string | null): Promise<EpgPreview> =>
    apiRequest(`/vod/${id}/epg-fill${programmeId ? `?programmeId=${encodeURIComponent(programmeId)}` : ''}`),
  epgApply: (id: string, b: { programmeId?: string; fields?: string[]; overwrite?: string[]; applyType?: boolean; title?: boolean }): Promise<EpgApplyResult> =>
    apiRequest(`/vod/${id}/epg-fill`, { method: 'POST', body: JSON.stringify(b) }),
  epgBulk: (ids: string[], o: { title?: boolean } = {}): Promise<{ results: EpgApplyResult[]; filled: number; unchanged: number }> =>
    apiRequest('/vod/epg-fill', { method: 'POST', body: JSON.stringify({ ids, title: !!o.title }) }),
  // ---- content links (services/contentLinks.ts) ----
  links: (id: string): Promise<LinkedContent> => apiRequest(`/vod/${id}/links`),
  setLink: (id: string, field: string, b: { assetId: string } | { name: string }): Promise<LinkedContent> =>
    apiRequest(`/vod/${id}/links/${encodeURIComponent(field)}`, { method: 'PUT', body: JSON.stringify(b) }),
  removeLink: (id: string, field: string): Promise<LinkedContent> => apiRequest(`/vod/${id}/links/${encodeURIComponent(field)}`, { method: 'DELETE' }),
  linkCandidates: (q: string, o: { forId?: string | null; field?: string | null } = {}): Promise<{ items: LinkCandidate[] }> => {
    const p = new URLSearchParams({ q })
    if (o.forId) p.set('for', o.forId)
    if (o.forId && o.field) p.set('field', o.field)
    return apiRequest(`/vod/link-candidates?${p}`)
  },
  // ---- read from file name (services/ingest/filenameApply.ts) ----
  filenamePreview: (id: string): Promise<FilenamePreview> => apiRequest(`/vod/${id}/from-filename`),
  filenameApply: (id: string, b: { type?: boolean; title?: boolean; fields?: string[]; overwrite?: string[]; link?: string | 'auto' | null }): Promise<FilenameApplyResult> =>
    apiRequest(`/vod/${id}/from-filename`, { method: 'POST', body: JSON.stringify(b) }),
  filenameBulk: (ids: string[]): Promise<{ results: (FilenameApplyResult & { error?: string })[]; changed: number; unchanged: number }> =>
    apiRequest('/vod/from-filename', { method: 'POST', body: JSON.stringify({ ids }) }),
  /** The asset's downloadable files (Downloads: view). */
  downloads: (id: string): Promise<{ files: DownloadFile[] }> => apiRequest(`/downloads/vod/${id}`),
  /** A five-minute link for one file (Downloads: operate). */
  downloadLink: (id: string, format: DownloadFile['format']): Promise<{ url: string; filename: string; expiresAt: string }> =>
    apiRequest(`/downloads/vod/${id}/link`, { method: 'POST', body: JSON.stringify({ format }) }),
}
export interface DownloadFile { format: 'mp4' | 'mp3' | 'm4a'; label: string; filename: string; bytes: number | null }

// ---- content links ----------------------------------------------------------
export interface AssetSummary {
  id: string; title: string
  contentType: { id: string; name: string; key: string | null } | null
  durationMs: number | null; published: boolean; availabilityState: string | null; href: string
}
export interface LinkCandidate { id: string; title: string; score: number; reasons: string[]; asset: AssetSummary | null }
export interface OutgoingLink {
  field: string; fieldLabel: string; relation: string; relationLabel: string
  state: 'linked' | 'unresolved'; name: string; asset: AssetSummary | null
  source: 'person' | 'auto' | 'migration'; confidence: number | null; reasons: string[]
  candidates: { assetId: string; title: string; score: number; reasons: string[]; asset: AssetSummary | null }[]
  decidedBy: string | null; updatedAt: string | null
}
export interface IncomingLink { field: string; relation: string; relationLabel: string; asset: AssetSummary; source: string; confidence: number | null }
export interface LinkedContent { links: OutgoingLink[]; linkedFrom: IncomingLink[] }

// ---- read from file name ----------------------------------------------------
export interface FnSignal { kind: string; token: string; value: any; confidence: number; reason: string; inTitle?: boolean }
export interface FnVote { typeKey: string | null; typeId: string | null; kind: string | null; confidence: number; origin: 'builtin' | 'account'; reasons: string[] }
export interface FnClassification { best: FnVote | null; votes: FnVote[]; conflict: { between: FnVote[]; reason: string } | null; confident: boolean; summary: string }
export interface FnFieldPlan { field: string; label: string; value: any; token: string | null; reason: string; current: any; action: 'fill' | 'same' | 'conflict' | 'replace'; byPerson: boolean }
export interface FilenamePreview {
  file: string
  signals: FnSignal[]
  parsed: { title: string | null; series: string | null; episodeTitle: string | null; season: number | null; episode: number | null; year: number | null; date: string | null; resolution: string | null; fps: number | null; language: string | null; promo: { kind: string; token: string; confidence: number } | null }
  classification: FnClassification
  type: { current: { id: string; name: string } | null; suggested: { id: string; name: string; key: string | null } | null; action: 'set' | 'same' | 'conflict' | 'none'; byPerson: boolean; reasons: string[]; dropsFields: string[] }
  title: { current: string | null; value: string | null; action: FnFieldPlan['action']; byPerson: boolean } | null
  fields: FnFieldPlan[]
  link: null | { field: string; label: string; current: any; byPerson: boolean; query: { title: string; year?: number | null }
    decision?: { action: 'link' | 'suggest' | 'none'; reason: string; candidates: LinkCandidate[] } }
  mismatches: string[]
}
export interface FilenameApplyResult { assetId: string; typeChanged: boolean; titleChanged: boolean; applied: string[]; skipped: { field: string; reason: string }[]; link: { action: string; reason: string } | null }

// ---- file-name rules (modules/filenameRules.ts) ------------------------------
export interface FnRule {
  id: string; name: string; enabled: boolean; ordinal: number; origin: 'builtin' | 'account'; confidence: number
  when: { words?: string[]; signal?: string; pattern?: string }
  then: { typeKey?: string; typeId?: string; kind?: string }
  typeName?: string | null
}
export interface FnSettings { titleCase: 'every' | 'headline'; episodeTemplate: string; autoType: boolean; autoLink: boolean }
export const filenameRulesApi = {
  list: (): Promise<{ builtin: FnRule[]; rules: FnRule[]; settings: FnSettings; types: { id: string; name: string; key: string | null }[] }> => apiRequest('/ingest/filename-rules'),
  create: (b: Partial<FnRule>): Promise<FnRule> => apiRequest('/ingest/filename-rules', { method: 'POST', body: JSON.stringify(b) }),
  update: (id: string, b: Partial<FnRule>): Promise<FnRule> => apiRequest(`/ingest/filename-rules/${id}`, { method: 'PATCH', body: JSON.stringify(b) }),
  remove: (id: string): Promise<void> => apiRequest(`/ingest/filename-rules/${id}`, { method: 'DELETE' }),
  builtin: (id: string, enabled: boolean): Promise<{ id: string; enabled: boolean }> => apiRequest(`/ingest/filename-rules/builtin/${encodeURIComponent(id)}`, { method: 'PUT', body: JSON.stringify({ enabled }) }),
  settings: (b: Partial<FnSettings>): Promise<FnSettings> => apiRequest('/ingest/filename-rules/settings', { method: 'PUT', body: JSON.stringify(b) }),
  test: (filename: string): Promise<{ signals: FnSignal[]; parsed: FilenamePreview['parsed']; classification: FnClassification; suggestedType: { id: string; name: string; key: string | null } | null; fields: { field: string; label: string; value: any; reason: string }[]; lookFor: { title: string; year?: number | null } | null }> =>
    apiRequest('/ingest/filename-rules/test', { method: 'POST', body: JSON.stringify({ filename }) }),
}
