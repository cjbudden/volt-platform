// ============================================================================
//  MEDIA LIBRARY FILTERS: one state, two serialisations.
//
//  The page URL carries the filters in short, readable parameters so a view
//  can be shared or bookmarked (/vod?type=<id>,<id>&missing=1&res=1080), and
//  the API query uses the list standard's names (schema_id=...,
//  metadata_missing_required=true, top_height=1080). Both directions are pure
//  functions so the round trip is tested (volt-web/test/library.check.tsx).
//  Every filter is applied on the server: the page never holds the whole
//  library to filter it locally.
// ============================================================================

export type SortKey = 'newest' | 'oldest' | 'title' | 'longest' | 'shortest' | 'least_complete' | 'highest_res'

export interface LibraryFilters {
  /** content type ids (metadata_schemas.id), any of */
  types: string[]
  /** availability states, any of */
  avail: string[]
  /** how it was made: recording | clip | upload | watchfolder, any of */
  origin: string[]
  /** what it belongs to: channel | event | radio | upload | none, any of */
  source: string[]
  /** asset type: video | audio | song, any of */
  media: string[]
  /** usage status (can it be used): ready | unchecked | qc_failed | processing | failed | unplayable | no_media, any of */
  status: string[]
  /** review: needs (in review or changes requested) | approved */
  review: '' | 'needs' | 'approved'
  /** a published copy is older than the asset */
  stale: boolean
  /** a required target field is empty */
  missing: boolean
  /** top rendition heights, any of */
  res: number[]
  /** video codecs, any of */
  codec: string[]
  /** created on or after / on or before, YYYY-MM-DD */
  from: string
  to: string
  /** duration bounds in minutes */
  durMin: number | null
  durMax: number | null
  q: string
  sort: SortKey
  /** a collection id (collections.tsx); '' = the whole library */
  col: string
  /** include the collection's sub-collections (default on) */
  colDeep: boolean
}

export const EMPTY_FILTERS: LibraryFilters = {
  types: [], avail: [], origin: [], source: [], media: [], status: [], review: '', stale: false, missing: false, res: [], codec: [],
  from: '', to: '', durMin: null, durMax: null, q: '', sort: 'newest', col: '', colDeep: true,
}

export const SORTS: { value: SortKey; label: string; api: string }[] = [
  { value: 'newest', label: 'Newest first', api: '-created_at' },
  { value: 'oldest', label: 'Oldest first', api: 'created_at' },
  { value: 'title', label: 'Title A to Z', api: 'title' },
  { value: 'longest', label: 'Longest first', api: '-duration_ms' },
  { value: 'shortest', label: 'Shortest first', api: 'duration_ms' },
  { value: 'least_complete', label: 'Least complete metadata', api: 'metadata_completeness,-created_at' },
  { value: 'highest_res', label: 'Highest resolution', api: '-top_height,-created_at' },
]

const AVAIL = ['draft', 'scheduled', 'available', 'expired', 'withdrawn']
const ORIGIN = ['recording', 'clip', 'upload', 'watchfolder']
export const SOURCE_VALUES = ['channel', 'event', 'radio', 'upload', 'none']
export const MEDIA_VALUES = ['video', 'audio', 'song']
export const STATUS_VALUES = ['ready', 'unchecked', 'qc_failed', 'processing', 'failed', 'unplayable', 'no_media']
/** The statuses that need somebody: the "Problems" shortcut selects these. */
export const PROBLEM_STATUSES = ['failed', 'unplayable', 'no_media', 'qc_failed']
const isDate = (s: string | null) => !!s && /^\d{4}-\d{2}-\d{2}$/.test(s)
const list = (s: string | null) => (s ?? '').split(',').map((x) => x.trim()).filter(Boolean)
const posNum = (s: string | null): number | null => { if (s == null || s === '') return null; const n = Number(s); return Number.isFinite(n) && n >= 0 ? n : null }

/** Page URL -> filters. Unknown or malformed values are dropped, never thrown. */
export function parseFilters(search: string | URLSearchParams): LibraryFilters {
  const p = typeof search === 'string' ? new URLSearchParams(search) : search
  const sort = p.get('sort') as SortKey | null
  return {
    types: list(p.get('type')).filter((x) => /^[0-9a-f-]{36}$/i.test(x)),
    avail: list(p.get('avail')).filter((x) => AVAIL.includes(x)),
    origin: list(p.get('origin')).filter((x) => ORIGIN.includes(x)),
    source: list(p.get('src')).filter((x) => SOURCE_VALUES.includes(x)),
    media: list(p.get('media')).filter((x) => MEDIA_VALUES.includes(x)),
    status: list(p.get('status')).filter((x) => STATUS_VALUES.includes(x)),
    review: p.get('review') === 'needs' || p.get('review') === 'approved' ? p.get('review') as 'needs' | 'approved' : '',
    stale: p.get('stale') === '1',
    missing: p.get('missing') === '1',
    res: list(p.get('res')).map(Number).filter((n) => Number.isInteger(n) && n > 0),
    codec: list(p.get('codec')).filter((x) => /^[a-z0-9]{2,8}$/.test(x)),
    from: isDate(p.get('from')) ? p.get('from')! : '',
    to: isDate(p.get('to')) ? p.get('to')! : '',
    durMin: posNum(p.get('dmin')),
    durMax: posNum(p.get('dmax')),
    q: (p.get('q') ?? '').slice(0, 200),
    sort: SORTS.some((s) => s.value === sort) ? sort! : 'newest',
    col: /^[0-9a-f-]{36}$/i.test(p.get('col') ?? '') ? p.get('col')! : '',
    colDeep: p.get('coldeep') !== '0',
  }
}

/** Filters -> page URL query (only what differs from empty), stable order. */
export function filtersToSearch(f: LibraryFilters): string {
  const p = new URLSearchParams()
  if (f.q.trim()) p.set('q', f.q.trim())
  if (f.types.length) p.set('type', f.types.join(','))
  if (f.avail.length) p.set('avail', f.avail.join(','))
  if (f.origin.length) p.set('origin', f.origin.join(','))
  if (f.source.length) p.set('src', f.source.join(','))
  if (f.media.length) p.set('media', f.media.join(','))
  if (f.status.length) p.set('status', f.status.join(','))
  if (f.review) p.set('review', f.review)
  if (f.stale) p.set('stale', '1')
  if (f.missing) p.set('missing', '1')
  if (f.res.length) p.set('res', f.res.join(','))
  if (f.codec.length) p.set('codec', f.codec.join(','))
  if (f.from) p.set('from', f.from)
  if (f.to) p.set('to', f.to)
  if (f.durMin != null) p.set('dmin', String(f.durMin))
  if (f.durMax != null) p.set('dmax', String(f.durMax))
  if (f.sort !== 'newest') p.set('sort', f.sort)
  if (f.col) { p.set('col', f.col); if (!f.colDeep) p.set('coldeep', '0') }
  const s = p.toString()
  return s ? `?${s}` : ''
}

const nextDay = (d: string) => { const t = new Date(`${d}T00:00:00Z`); t.setUTCDate(t.getUTCDate() + 1); return t.toISOString().slice(0, 10) }

/** Filters -> the list standard's query for GET /api/vod (and /api/vod/facets). */
export function filtersToApi(f: LibraryFilters, opts: { limit?: number; cursor?: string | null; count?: boolean; facets?: boolean } = {}): string {
  const p = new URLSearchParams()
  if (f.q.trim()) p.set('q', f.q.trim())
  if (f.types.length) p.set('schema_id', f.types.join(','))
  if (f.avail.length) p.set('availability_state', f.avail.join(','))
  if (f.origin.length) p.set('origin', f.origin.join(','))
  if (f.source.length) p.set('source', f.source.join(','))
  if (f.media.length) p.set('media_type', f.media.join(','))
  if (f.status.length) p.set('usage_status', f.status.join(','))
  if (f.review === 'needs') p.set('review_state', 'in_review,changes_requested')
  if (f.review === 'approved') p.set('review_state', 'approved')
  if (f.stale) p.set('has_stale_publication', 'true')
  if (f.missing) p.set('metadata_missing_required', 'true')
  if (f.res.length) p.set('top_height', f.res.join(','))
  if (f.codec.length) p.set('video_codec', f.codec.join(','))
  // Dates are the viewer's calendar days, sent as UTC day bounds (the end is exclusive).
  if (f.from) p.set('created_at[gte]', f.from)
  if (f.to) p.set('created_at[lt]', nextDay(f.to))
  if (f.durMin != null) p.set('duration_ms[gte]', String(Math.round(f.durMin * 60000)))
  if (f.durMax != null) p.set('duration_ms[lte]', String(Math.round(f.durMax * 60000)))
  if (f.col) { p.set('collection', f.col); if (f.colDeep) p.set('collection_deep', 'true') }
  if (!opts.facets) {
    p.set('sort', SORTS.find((s) => s.value === f.sort)?.api ?? '-created_at')
    p.set('limit', String(opts.limit ?? 48))
    if (opts.count !== false) p.set('count', 'true')
    if (opts.cursor) p.set('cursor', opts.cursor)
  }
  return p.toString()
}

/** Anything filtered (sort does not count). */
export function isFiltered(f: LibraryFilters): boolean {
  return filtersToSearch({ ...f, sort: 'newest' }) !== ''
}

export type LibraryView = 'list' | 'grid'
export const VIEWS: readonly LibraryView[] = ['list', 'grid']

/** Optional table columns (the grid always shows its summary). */
export type OptColumn = 'type' | 'complete' | 'encode' | 'codec' | 'renditions' | 'blocks'
export const OPT_COLUMNS: { key: OptColumn; label: string }[] = [
  { key: 'type', label: 'Content type' },
  { key: 'complete', label: 'Metadata' },
  { key: 'encode', label: 'Top rendition' },
  { key: 'codec', label: 'Codec' },
  { key: 'renditions', label: 'Renditions' },
  { key: 'blocks', label: 'Source blocks' },
]
export const DEFAULT_COLUMNS: OptColumn[] = ['type', 'complete']

export function parseColumns(s: string | null): OptColumn[] {
  if (s == null) return DEFAULT_COLUMNS
  return list(s).filter((x): x is OptColumn => OPT_COLUMNS.some((c) => c.key === x))
}

/** "1080p", "2160p (4K)", "" */
export function resLabel(h: number | null | undefined): string {
  if (!h) return ''
  return h >= 2160 ? '2160p (4K)' : `${h}p`
}
export function codecLabel(c: string | null | undefined): string {
  if (!c) return ''
  return ({ h264: 'H.264', hevc: 'HEVC', av1: 'AV1', vp9: 'VP9' } as Record<string, string>)[c] ?? c.toUpperCase()
}
