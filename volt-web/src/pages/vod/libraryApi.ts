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
  facets: { types: FacetType[]; availability: FacetValue[]; origins: FacetValue[]; resolutions: FacetValue[]; codecs: FacetValue[]; metadata: FacetValue[] }
}

export interface TargetMetadata {
  type: { id: string; name: string; key: string | null; schemaOrgType: string | null } | null
  fields: { key: string; label: string; type: string; required: boolean; options?: string[]; multiple?: boolean; schemaOrg: string | null; epg: string | null }[]
  completeness: { pct: number | null; filled: number; total: number; missingRequired: string[]; missingRecommended: string[]; notOnType: string[] }
  provenance: Record<string, { source: string; programmeId?: string; programmeTitle?: string; at?: string; by?: string }>
}

export type Prov = 'stored' | 'derived' | 'unknown'
export interface EncodeDetails {
  workflow: { value: string | null; source: Prov }
  ladder: { value: string | null; source: Prov }
  renditions: { value: { height: number; width: number | null; bitrateKbps: number | null; codec: string; profile: string | null; fps: number | null }[]; source: Prov }
  dropped: { height: number; why: string }[]
  audio: { value: { codec: string; channels: number | null; bitrateKbps: number | null; sampleRate: number | null; language: string | null }[]; source: Prov }
  captions: { value: { language: string; kind: string; source: string }[]; source: Prov }
  segmentSeconds: { value: number | null; source: Prov }
  packaging: { value: string[]; source: Prov }
  container: { value: string | null; source: Prov }
  drm: { value: string[]; source: Prov }
  source: { width: number | null; height: number | null; fps: number | null; durationMs: number | null; hasAudio: boolean | null; bytes: number | null; filename: string | null; mime: string | null; origin: string }
  summary: { topHeight: number | null; codec: string | null; renditions: number; label: string }
  gaps: string[]
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
}
