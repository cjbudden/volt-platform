// ============================================================================
//  TAGS ON SLATES AND LOOPS (Christian, 11 Nov; migration 0161).
//
//  A simple grouping: a person tags slates and loops ("christmas", "sport",
//  "brand A") and filters Loops & Fillers by them, without the weight of a
//  collection. The editor sits on the item's page; the chips on the list.
// ============================================================================
import { useEffect, useState } from 'react'
import { api } from '../api'
import { useNotify } from '../notices'

const TAG_IC = <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="13" height="13" aria-hidden="true"><path d="M20.6 13.4l-7.2 7.2a2 2 0 01-2.8 0L2 12V2h10l8.6 8.6a2 2 0 010 2.8z" /><circle cx="7" cy="7" r="1.5" /></svg>

/** Read-only chips, for the list. */
export function TagChips({ tags, onPick }: { tags?: string[] | null; onPick?: (t: string) => void }) {
  if (!tags?.length) return null
  return (
    <span style={{ display: 'inline-flex', flexWrap: 'wrap', gap: 4 }}>
      {tags.map((t) => (
        <button key={t} type="button" className="chip" style={{ padding: '1px 8px', fontSize: 'var(--fs-micro)' }}
          onClick={onPick ? (e) => { e.stopPropagation(); onPick(t) } : undefined} title={onPick ? `Show only "${t}"` : undefined}>{TAG_IC}{t}</button>
      ))}
    </span>
  )
}

/** Add and remove tags on one slate or loop. */
export function TagEditor({ id, tags, onChanged }: { id: string; tags: string[]; onChanged: () => void }) {
  const notify = useNotify()
  const [val, setVal] = useState('')
  const [known, setKnown] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  useEffect(() => { api.fillerTags().then((r) => setKnown(r.map((x) => x.tag))).catch(() => {}) }, [])
  async function save(next: string[]) {
    setBusy(true)
    try { await api.setFillerTags(id, next); onChanged() }
    catch (e: any) { notify({ kind: 'error', message: e.message }) } finally { setBusy(false) }
  }
  const add = () => {
    const v = val.trim()
    if (!v) return
    setVal('')
    if (!tags.some((t) => t.toLowerCase() === v.toLowerCase())) void save([...tags, v])
  }
  const listId = `filler-tags-${id}`
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 6 }}>
      <span style={{ color: 'var(--faint)', fontSize: 'var(--fs-sm)', display: 'inline-flex', alignItems: 'center', gap: 4 }}>{TAG_IC}Tags</span>
      {tags.map((t) => (
        <span key={t} className="chip" style={{ padding: '1px 4px 1px 8px', fontSize: 'var(--fs-sm)' }}>
          {t}
          <button type="button" className="xbtn" aria-label={`Remove tag ${t}`} disabled={busy}
            style={{ marginLeft: 4, width: 18, height: 18, fontSize: 11 }} onClick={() => save(tags.filter((x) => x !== t))}>✕</button>
        </span>
      ))}
      <input className="inp" list={listId} value={val} disabled={busy} placeholder="Add a tag"
        style={{ width: 140, padding: '3px 8px', fontSize: 'var(--fs-sm)' }}
        onChange={(e) => setVal(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); add() } }}
        onBlur={add} />
      <datalist id={listId}>{known.filter((k) => !tags.includes(k)).map((k) => <option key={k} value={k} />)}</datalist>
    </div>
  )
}
