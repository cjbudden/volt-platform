// Reading Volt's global lists (countries, timezones, ...) in the console.
// Server: volt-app/src/modules/globalLists.ts (GET /api/global-lists/:key).
//
// One fetch per list per page load, shared by every caller; the server's
// ETag and Cache-Control make repeat loads cheap. Retired items are not
// offered here; resolve a stored code with globalListItem() to show it.
import { useEffect, useState } from 'react'
import { apiRequest as req } from '../api'

export interface GlobalListValue { [field: string]: any }
export interface GlobalListEntry { code: string; label: string; value: GlobalListValue; isDefault: boolean; position: number }
export interface GlobalListData { key: string; name: string; labelField: string; codeField: string | null; version: number; items: GlobalListEntry[] }

const cache = new Map<string, Promise<GlobalListData>>()

export function loadGlobalList(key: string, locale?: string): Promise<GlobalListData> {
  const id = `${key}|${locale ?? ''}`
  let p = cache.get(id)
  if (!p) {
    p = req(`/global-lists/${encodeURIComponent(key)}?limit=1000${locale ? `&locale=${encodeURIComponent(locale)}` : ''}`) as Promise<GlobalListData>
    p.catch(() => cache.delete(id))
    cache.set(id, p)
  }
  return p
}

/** One item by code (retired ones too), for showing what a record stores. */
export const globalListItem = (key: string, code: string): Promise<GlobalListEntry & { active: boolean }> =>
  req(`/global-lists/${encodeURIComponent(key)}/items/${encodeURIComponent(code)}`)

/** The list's items for a picker; null while loading, [] if it could not load. */
export function useGlobalList(key: string, locale?: string): GlobalListEntry[] | null {
  const [items, setItems] = useState<GlobalListEntry[] | null>(null)
  useEffect(() => {
    let live = true
    loadGlobalList(key, locale).then((d) => { if (live) setItems(d.items) }, () => { if (live) setItems([]) })
    return () => { live = false }
  }, [key, locale])
  return items
}

/** Forget cached lists (after a System Admin edits one in this session). */
export const clearGlobalListCache = () => cache.clear()
