// ============================================================================
//  MEDIA LIBRARY TOOLBAR AND FILTER PANEL.
//
//    [Search ...........] [Sort v] [Columns v] [List | Grid]
//    Content type  [Episode 12] [Movie 3] [Clip 40] ...
//    Availability  [Available 9] [Not published 40] ...   Source [Clip] [Upload] ...
//    Metadata      [Missing required 7]              [More filters v]
//      Resolution, codec, review, date range, duration, published copy is old
//
//  Every chip is a toggle button (aria-pressed) with the count it would show
//  with the other filters applied (GET /api/vod/facets). All of it lives in
//  the URL (libraryQuery.ts), so a filtered view can be shared.
// ============================================================================
import { useEffect, useState, type ReactNode } from 'react'
import { Segmented } from '../../listFilters'
import { LibIcon } from './icons'
import type { LibraryFacets } from './libraryApi'
import {
  OPT_COLUMNS, SORTS, codecLabel, isFiltered, resLabel,
  type LibraryFilters, type LibraryView, type OptColumn, type SortKey,
} from './libraryQuery'

const AVAIL_LABEL: Record<string, string> = {
  draft: 'Not published', scheduled: 'Scheduled', available: 'Available', expired: 'Expired', withdrawn: 'Access removed',
}
const ORIGIN_LABEL: Record<string, string> = { recording: 'Recording', clip: 'Clip', upload: 'Upload', watchfolder: 'Watch folder' }

function Toggle({ on, label, n, onClick, title }: { on: boolean; label: string; n?: number; onClick: () => void; title?: string }) {
  return (
    <button type="button" className={`chip lib-chip${on ? ' active' : ''}`} aria-pressed={on} onClick={onClick} title={title}>
      {label}{n != null && <span className="ct">{n}</span>}
    </button>
  )
}

function Group({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="chip-group lib-group" role="group" aria-label={label}>
      <span className="chip-group-l">{label}</span>
      {children}
    </div>
  )
}

const flip = <T,>(arr: T[], v: T) => (arr.includes(v) ? arr.filter((x) => x !== v) : [...arr, v])

export function LibraryToolbar({ filters, onChange, view, onView, columns, onColumns }: {
  filters: LibraryFilters; onChange: (f: LibraryFilters) => void
  view: LibraryView; onView: (v: LibraryView) => void
  columns: OptColumn[]; onColumns: (c: OptColumn[]) => void
}) {
  // Search commits after a pause so the server is not asked on every key.
  const [q, setQ] = useState(filters.q)
  useEffect(() => { setQ(filters.q) }, [filters.q])
  useEffect(() => {
    if (q === filters.q) return
    const t = setTimeout(() => onChange({ ...filters, q }), 300)
    return () => clearTimeout(t)
    // eslint-disable-next-line
  }, [q])
  return (
    <div className="list-toolbar lib-toolbar">
      <div className="list-toolbar-l">
        <label className="lib-search">
          <span className="lib-search-ic">{LibIcon.search}</span>
          <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search title, source or type"
            aria-label="Search the library" onKeyDown={(e) => { if (e.key === 'Enter') onChange({ ...filters, q }) }} />
        </label>
      </div>
      <div className="list-toolbar-r">
        <label className="tb-select">
          <span>Sort</span>
          <select className="inp" value={filters.sort} onChange={(e) => onChange({ ...filters, sort: e.target.value as SortKey })} aria-label="Sort by">
            {SORTS.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
          </select>
        </label>
        {view === 'list' && (
          <details className="lib-cols">
            <summary className="btn ghost">{LibIcon.columns}Columns</summary>
            <div className="lib-cols-menu" role="group" aria-label="Optional columns">
              {OPT_COLUMNS.map((c) => (
                <label key={c.key}>
                  <input type="checkbox" checked={columns.includes(c.key)} onChange={() => onColumns(flip(columns, c.key))} />
                  {c.label}
                </label>
              ))}
            </div>
          </details>
        )}
        <Segmented label="View" value={view} onChange={onView}
          options={[{ value: 'list', label: 'List', icon: LibIcon.list }, { value: 'grid', label: 'Grid', icon: LibIcon.grid }]} />
      </div>
    </div>
  )
}

export function LibraryFilterPanel({ filters, onChange, facets }: {
  filters: LibraryFilters; onChange: (f: LibraryFilters) => void; facets: LibraryFacets | null
}) {
  const fx = facets?.facets
  const more = filters.res.length > 0 || filters.codec.length > 0 || !!filters.review || filters.stale || !!filters.from || !!filters.to || filters.durMin != null || filters.durMax != null
  const [open, setOpen] = useState(more)
  useEffect(() => { if (more) setOpen(true) }, [more])
  const set = (p: Partial<LibraryFilters>) => onChange({ ...filters, ...p })
  const n = (list: { value: any; n: number }[] | undefined, v: any) => list?.find((x) => String(x.value) === String(v))?.n ?? 0

  // Content types: the ones in use (from the facet), plus any selected that are not.
  const types = (fx?.types ?? []).filter((t) => t.id)
  const missingN = n(fx?.metadata, true)
  const resolutions = (fx?.resolutions ?? []).filter((r) => r.value != null).sort((a, b) => b.value - a.value)
  const codecs = (fx?.codecs ?? []).filter((c) => c.value != null)
  const num = (v: string) => (v === '' ? null : Math.max(0, Number(v)))

  return (
    <div className="lib-filters" aria-label="Filters">
      <Group label="Content type">
        {types.length === 0 && <span className="lib-none">No assets yet</span>}
        {types.map((t) => (
          <Toggle key={t.id!} on={filters.types.includes(t.id!)} label={t.name ?? 'Untitled type'} n={t.n}
            title={t.schema_org_type ? `schema.org ${t.schema_org_type}` : undefined}
            onClick={() => set({ types: flip(filters.types, t.id!) })} />
        ))}
        {(fx?.types ?? []).some((t) => !t.id) && <span className="lib-none">{(fx?.types ?? []).find((t) => !t.id)?.n} with no type</span>}
      </Group>
      <div className="lib-filter-row">
        <Group label="Availability">
          {Object.keys(AVAIL_LABEL).filter((k) => n(fx?.availability, k) > 0 || filters.avail.includes(k)).map((k) => (
            <Toggle key={k} on={filters.avail.includes(k)} label={AVAIL_LABEL[k]} n={n(fx?.availability, k)} onClick={() => set({ avail: flip(filters.avail, k) })} />
          ))}
        </Group>
        <Group label="Source">
          {Object.keys(ORIGIN_LABEL).filter((k) => n(fx?.origins, k) > 0 || filters.origin.includes(k)).map((k) => (
            <Toggle key={k} on={filters.origin.includes(k)} label={ORIGIN_LABEL[k]} n={n(fx?.origins, k)} onClick={() => set({ origin: flip(filters.origin, k) })} />
          ))}
        </Group>
        <Group label="Metadata">
          <Toggle on={filters.missing} label="Missing required" n={missingN} onClick={() => set({ missing: !filters.missing })}
            title="A required target field for its content type is empty, or it has no content type" />
        </Group>
        <button type="button" className="btn ghost sm lib-more" aria-expanded={open} aria-controls="lib-more" onClick={() => setOpen(!open)}>
          {LibIcon.filter}{open ? 'Fewer filters' : 'More filters'}
        </button>
        {isFiltered(filters) && (
          <button type="button" className="btn ghost sm" onClick={() => onChange({ ...filters, types: [], avail: [], origin: [], review: '', stale: false, missing: false, res: [], codec: [], from: '', to: '', durMin: null, durMax: null, q: '' })}>
            Clear filters
          </button>
        )}
      </div>
      {open && (
        <div id="lib-more" className="lib-filter-row">
          <Group label="Top resolution">
            {resolutions.length === 0 && <span className="lib-none">Not known yet</span>}
            {resolutions.map((r) => (
              <Toggle key={r.value} on={filters.res.includes(r.value)} label={resLabel(r.value)} n={r.n} onClick={() => set({ res: flip(filters.res, r.value) })} />
            ))}
          </Group>
          <Group label="Codec">
            {codecs.map((c) => (
              <Toggle key={c.value} on={filters.codec.includes(c.value)} label={codecLabel(c.value)} n={c.n} onClick={() => set({ codec: flip(filters.codec, c.value) })} />
            ))}
          </Group>
          <Group label="Review">
            <Toggle on={filters.review === 'needs'} label="Needs review" onClick={() => set({ review: filters.review === 'needs' ? '' : 'needs' })} />
            <Toggle on={filters.review === 'approved'} label="Approved" onClick={() => set({ review: filters.review === 'approved' ? '' : 'approved' })} />
            <Toggle on={filters.stale} label="Published copy is old" onClick={() => set({ stale: !filters.stale })} />
          </Group>
          <div className="lib-range" role="group" aria-label="Date added">
            <span className="chip-group-l">Added</span>
            <input type="date" className="inp" value={filters.from} max={filters.to || undefined} onChange={(e) => set({ from: e.target.value })} aria-label="Added from" />
            <span className="lib-to">to</span>
            <input type="date" className="inp" value={filters.to} min={filters.from || undefined} onChange={(e) => set({ to: e.target.value })} aria-label="Added to" />
          </div>
          <div className="lib-range" role="group" aria-label="Duration in minutes">
            <span className="chip-group-l">Duration</span>
            <input type="number" min={0} className="inp lib-num" value={filters.durMin ?? ''} placeholder="min" onChange={(e) => set({ durMin: num(e.target.value) })} aria-label="Shortest, minutes" />
            <span className="lib-to">to</span>
            <input type="number" min={0} className="inp lib-num" value={filters.durMax ?? ''} placeholder="max" onChange={(e) => set({ durMax: num(e.target.value) })} aria-label="Longest, minutes" />
            <span className="lib-to">min</span>
          </div>
        </div>
      )}
    </div>
  )
}
