// Unsaved edits in the asset panel (Vod.tsx AssetMetadata). The form registers
// itself while it differs from what is saved; switching tab, opening another
// asset or closing the drawer asks first instead of silently dropping the edits.
let pending: string | null = null

export function setUnsaved(what: string | null) { pending = what }
export function hasUnsaved() { return pending !== null }

/** True when it is fine to leave: nothing unsaved, or the person said to discard it. */
export function confirmLeave(): boolean {
  if (!pending) return true
  const ok = window.confirm(`You have unsaved changes to ${pending}.\n\nLeave without saving them?`)
  if (ok) pending = null
  return ok
}

/** Same value whatever order the keys were written in (so re-ordering is not a change). */
export function stable(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`
  if (v && typeof v === 'object') return `{${Object.keys(v as any).filter((k) => (v as any)[k] !== undefined && (v as any)[k] !== '' && (v as any)[k] !== null).sort().map((k) => `${JSON.stringify(k)}:${stable((v as any)[k])}`).join(',')}}`
  return JSON.stringify(v ?? null)
}
