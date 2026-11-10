// ============================================================================
//  TITLES IN THE LIBRARY. An episode's own title ("Episode 2") says little on
//  a card full of episodes, so items that belong to a series are shown with
//  what they belong to: the series and, in brackets, the season.
//
//    seriesLabel   "Caminandes (S1)"             the group line on cards and rows
//    longTitle     "Caminandes (S1) · Episode 2" the drawer header, anywhere one line
//
//  The series and season come from the type's fields mapped to schema.org
//  partOfSeries and partOfSeason (series_title and season_number on the list
//  rows, modules/vod.ts), so any type that is part of a series gets this.
// ============================================================================
import type { LibraryRow } from './libraryApi'

type Titled = Pick<LibraryRow, 'title'> & Partial<Pick<LibraryRow, 'series_title' | 'season_number'>>

export function seriesLabel(r: Titled | null | undefined): string | null {
  const series = String(r?.series_title ?? '').trim()
  if (!series) return null
  const season = String(r?.season_number ?? '').trim()
  return season ? `${series} (S${season})` : series
}

export function longTitle(r: Titled | null | undefined, fallback = 'Untitled'): string {
  const title = String(r?.title ?? '').trim() || fallback
  const group = seriesLabel(r)
  // A title that already starts with the series ("Caminandes Episode 2") is not repeated.
  if (!group || title.toLowerCase().startsWith(String(r?.series_title).trim().toLowerCase())) return title
  return `${group} · ${title}`
}
