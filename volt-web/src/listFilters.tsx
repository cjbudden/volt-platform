// ============================================================================
//  LIST FILTERS AND SORT: one toolbar for Channels, Radio and Events.
//
//    [Type: All | Transcode | Packaging]  [Status: All | Running | ...]
//                                       [Group ▾]  [Sort ▾]  [List | Calendar]
//
//  Chips filter by a fixed set (each shows its count); the group picker
//  narrows to one group; the sort picker orders the rows (Channels and Radio
//  default to name A to Z, Events to date). Choices are remembered per list in
//  this browser (localStorage, best effort) so coming back keeps them.
// ============================================================================
import { useEffect, useState, type ReactNode } from 'react'
import type { Group } from './api'
import { FChip } from './scaffold'

/** State remembered per list in this browser. Survives a reload; never shared. */
export function usePref<T extends string>(key: string, initial: T, allowed?: readonly T[]): [T, (v: T) => void] {
  const [v, setV] = useState<T>(() => {
    try {
      const s = localStorage.getItem(`volt.list.${key}`) as T | null
      if (s && (!allowed || allowed.includes(s))) return s
    } catch { /* storage unavailable: use the default */ }
    return initial
  })
  useEffect(() => { try { localStorage.setItem(`volt.list.${key}`, v) } catch { /* best effort */ } }, [key, v])
  return [v, setV]
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })
/** Natural, case-insensitive name order: "Channel 2" before "Channel 10". */
export const byName = (a: string, b: string) => collator.compare(a ?? '', b ?? '')

export interface ChipOption<T extends string> { value: T; label: string; n?: number }

/** A labelled set of filter chips. */
export function ChipGroup<T extends string>({ label, options, value, onChange }: {
  label: string; options: ChipOption<T>[]; value: T; onChange: (v: T) => void
}) {
  return (
    <div className="chip-group" role="group" aria-label={label}>
      <span className="chip-group-l">{label}</span>
      {options.map(o => <FChip key={o.value} label={o.label} n={o.n ?? 0} on={value === o.value} onClick={() => onChange(o.value)} />)}
    </div>
  )
}

/** "All groups" or one group. Hidden when there is only one group to pick. */
export function GroupFilter({ groups, value, onChange }: { groups: Group[]; value: string; onChange: (id: string) => void }) {
  if (groups.length < 2 && !value) return null
  return (
    <label className="tb-select">
      <span>Group</span>
      <select className="inp" value={value} onChange={e => onChange(e.target.value)} aria-label="Filter by group">
        <option value="">All groups</option>
        {groups.map(g => <option key={g.id} value={g.id}>{g.name}</option>)}
      </select>
    </label>
  )
}

export interface SortOption<T extends string> { value: T; label: string }

export function SortSelect<T extends string>({ options, value, onChange }: { options: SortOption<T>[]; value: T; onChange: (v: T) => void }) {
  return (
    <label className="tb-select">
      <span>Sort</span>
      <select className="inp" value={value} onChange={e => onChange(e.target.value as T)} aria-label="Sort by">
        {options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
    </label>
  )
}

/** A two-or-more way segmented switch (List | Calendar, Day | Week | Month | Year). */
export function Segmented<T extends string>({ label, options, value, onChange }: {
  label: string; options: { value: T; label: string; icon?: ReactNode }[]; value: T; onChange: (v: T) => void
}) {
  return (
    <div className="segmented" role="radiogroup" aria-label={label}>
      {options.map(o => (
        <button key={o.value} type="button" role="radio" aria-checked={value === o.value}
          className={value === o.value ? 'on' : ''} onClick={() => onChange(o.value)}>
          {o.icon}{o.label}
        </button>
      ))}
    </div>
  )
}

/** The toolbar row: filters on the left, pickers on the right; wraps on narrow screens. */
export function ListToolbar({ left, right }: { left: ReactNode; right?: ReactNode }) {
  return (
    <div className="list-toolbar">
      <div className="list-toolbar-l">{left}</div>
      {right && <div className="list-toolbar-r">{right}</div>}
    </div>
  )
}

/** Small "Clear filters" link, shown only when something is filtered. */
export function ClearFilters({ on, onClear }: { on: boolean; onClear: () => void }) {
  if (!on) return null
  return <button type="button" className="btn ghost sm" onClick={onClear}>Clear filters</button>
}

/** When filters hide every row: say so and offer to clear. */
export function NoMatches({ what, onClear }: { what: string; onClear: () => void }) {
  return (
    <div className="empty" style={{ padding: '28px 16px' }}>
      <h3>No {what} match these filters</h3>
      <button type="button" className="btn ghost" onClick={onClear} style={{ margin: '8px auto 0' }}>Clear filters</button>
    </div>
  )
}
