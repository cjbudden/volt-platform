// ============================================================================
//  GENRES (Admin > Media setup > Genres): the account's own genre list.
//
//  The genres a station, a channel, an event, a song, an episode or a movie
//  can be tagged with. Every content type field linked to the list (the
//  standard Genre and Category fields, and any enum field the client links in
//  Content Types) offers exactly this list, in this order.
//
//  Nothing already tagged is broken by an edit here:
//   - rename a genre in place: everything carrying it is renamed on save
//   - merge one genre into another: the same, then the first one goes
//   - retire: stays valid where it is set, no longer offered
//   - remove: only a genre nothing carries (the count says)
//  Reset brings back the platform list, keeping (retired) any genre in use.
//  Edits are local until Save, so a slip can be discarded.
// ============================================================================
import { useEffect, useMemo, useRef, useState } from 'react'
import { api, type MetadataList } from '../api'
import { PageHead } from '../scaffold'
import { navigate } from '../router'
import { useAccess } from '../access'
import { usePageNotice, useNotify, FormStatus } from '../notices'
import { ConfirmDialog } from '../listActions'

interface Row {
  id: number
  /** The value as saved; null for a genre added in this session. */
  orig: string | null
  value: string
  retired: boolean
  usage: number
  /** Merge this genre into another row's genre (by row id) on save. */
  mergeInto: number | null
}

let seq = 1
const toRows = (l: MetadataList): Row[] => l.items.map(i => ({ id: seq++, orig: i.value, value: i.value, retired: i.retired, usage: i.usage, mergeInto: null }))
const fold = (s: string) => s.trim().replace(/\s+/g, ' ').toLocaleLowerCase()
const plural = (n: number, one: string, many = one + 's') => `${n} ${n === 1 ? one : many}`

export default function GenresPage() {
  const access = useAccess()
  const canEdit = access.can('settings', 'manage')
  const [list, setList] = useState<MetadataList | null>(null)
  const [rows, setRows] = useState<Row[]>([])
  const [err, setErr] = useState('')
  const [saveErr, setSaveErr] = useState('')
  const [saved, setSaved] = useState('')
  const [busy, setBusy] = useState(false)
  const [adding, setAdding] = useState('')
  const [filter, setFilter] = useState('')
  const [confirmReset, setConfirmReset] = useState(false)
  const [dragId, setDragId] = useState<number | null>(null)
  const addRef = useRef<HTMLInputElement>(null)
  const notify = useNotify()

  async function load() {
    try { const l = await api.metadataList('genres'); setList(l); setRows(toRows(l)); setErr('') } catch (e: any) { setErr(e.message) }
  }
  useEffect(() => { load() }, [])
  usePageNotice('load', err ? { kind: 'error', title: "Couldn't load the genre list.", message: err, actions: [{ label: 'Retry', onClick: () => { load() } }] } : null)

  // ---- what changed, for the Save bar and the request ------------------------
  const live = rows.filter(r => r.mergeInto == null)
  const dirty = useMemo(() => {
    if (!list) return false
    const now = live.map(r => `${r.value.trim()}|${r.retired}`).join('\n')
    const was = list.items.map(i => `${i.value}|${i.retired}`).join('\n')
    return now !== was || rows.some(r => r.mergeInto != null)
  }, [rows, list])
  const dupes = useMemo(() => {
    const seen = new Map<string, number>(); const d = new Set<number>()
    for (const r of live) { const k = fold(r.value); if (!k) continue; if (seen.has(k)) { d.add(r.id); d.add(seen.get(k)!) } else seen.set(k, r.id) }
    return d
  }, [rows])
  const empties = live.some(r => !r.value.trim())
  const noneActive = !live.some(r => !r.retired)
  const renames = live.filter(r => r.orig && r.orig !== r.value.trim().replace(/\s+/g, ' '))
  const merges = rows.filter(r => r.mergeInto != null)
  const removals = list ? list.items.filter(i => !rows.some(r => r.orig === i.value)) : []
  const affected = renames.reduce((n, r) => n + r.usage, 0) + merges.reduce((n, r) => n + r.usage, 0)
  const problem = dupes.size ? 'Two genres have the same name. To combine them, use Merge on one of them.'
    : empties ? 'A genre has no name.' : noneActive ? 'Keep at least one genre that is not retired.' : ''

  const set = (id: number, patch: Partial<Row>) => setRows(rs => rs.map(r => r.id === id ? { ...r, ...patch } : r))
  function move(id: number, to: number) {
    setRows(rs => { const from = rs.findIndex(r => r.id === id); if (from < 0 || to < 0 || to >= rs.length) return rs; const c = [...rs]; const [x] = c.splice(from, 1); c.splice(to, 0, x); return c })
  }
  function add() {
    // Several at once: "Podcasts, True crime" or one per line.
    const vals = adding.split(/[,\n]/).map(v => v.trim().replace(/\s+/g, ' ')).filter(Boolean)
    if (!vals.length) return
    const have = new Set(live.map(r => fold(r.value)))
    const fresh = vals.filter(v => { const k = fold(v); if (have.has(k)) return false; have.add(k); return true })
    const skipped = vals.length - fresh.length
    setRows(rs => [...rs, ...fresh.map(v => ({ id: seq++, orig: null, value: v, retired: false, usage: 0, mergeInto: null }))])
    setAdding('')
    if (skipped) notify({ kind: 'info', message: `${plural(skipped, 'genre')} already on the list ${skipped === 1 ? 'was' : 'were'} skipped.` })
    addRef.current?.focus()
  }
  function remove(r: Row) {
    if (r.usage > 0) return
    setRows(rs => rs.filter(x => x.id !== r.id).map(x => x.mergeInto === r.id ? { ...x, mergeInto: null } : x))
  }
  function sortAZ() {
    setRows(rs => [...rs].sort((a, b) => a.value.localeCompare(b.value, undefined, { sensitivity: 'base' })))
  }
  function addUnlisted(value: string, usage: number) {
    setRows(rs => [...rs, { id: seq++, orig: null, value, retired: false, usage, mergeInto: null }])
  }

  async function save() {
    if (!list || problem) return
    setBusy(true); setSaveErr(''); setSaved('')
    try {
      const byId = new Map(rows.map(r => [r.id, r]))
      const body = {
        items: live.map(r => ({ value: r.value.trim(), ...(r.retired ? { retired: true } : {}) })),
        renames: [
          ...renames.map(r => ({ from: r.orig!, to: r.value.trim().replace(/\s+/g, ' ') })),
          ...merges.filter(r => r.orig).map(r => ({ from: r.orig!, to: byId.get(r.mergeInto!)!.value.trim().replace(/\s+/g, ' ') })),
        ],
        version: list.version,
      }
      const res = await api.saveMetadataList('genres', body)
      setList(res); setRows(toRows(res))
      const bits = ['Genre list saved.']
      if (res.saved.renamed) bits.push(`${plural(res.saved.renamed, 'item')} updated with the new names.`)
      if (res.saved.typesUpdated) bits.push(`${plural(res.saved.typesUpdated, 'content type')} now offer${res.saved.typesUpdated === 1 ? 's' : ''} it.`)
      setSaved(bits.join(' '))
    } catch (e: any) { setSaveErr(e.message) } finally { setBusy(false) }
  }
  async function reset() {
    setConfirmReset(false); setBusy(true); setSaveErr(''); setSaved('')
    try { const res = await api.resetMetadataList('genres'); setList(res); setRows(toRows(res)); setSaved('The platform genre list is back. Genres still in use were kept, retired.') }
    catch (e: any) { setSaveErr(e.message) } finally { setBusy(false) }
  }

  const q = fold(filter)
  const shown = rows.filter(r => !q || fold(r.value).includes(q) || (r.orig && fold(r.orig).includes(q)))
  const activeCount = live.filter(r => !r.retired).length
  const retiredCount = live.filter(r => r.retired).length

  return (
    <>
      <PageHead title="Genres" sub="The genre list your stations, channels, events and on-demand assets are tagged from. It fills the guide category and the schema.org genre." />
      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) 300px', gap: 16, alignItems: 'start' }} className="genres-grid">
        <div className="card" style={{ padding: 18 }}>
          {!list ? <div className="loading">Loading…</div> : <>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginBottom: 12 }}>
              <b>{plural(activeCount, 'genre')}</b>
              {retiredCount > 0 && <span className="tag">{retiredCount} retired</span>}
              {list.isDefault && <span className="tag">platform default</span>}
              <div style={{ flex: 1 }} />
              <input className="inp" style={{ maxWidth: 200 }} placeholder="Find a genre" value={filter} onChange={e => setFilter(e.target.value)} aria-label="Find a genre" />
              {canEdit && <button className="btn ghost" onClick={sortAZ} disabled={busy}>Sort A to Z</button>}
            </div>

            {canEdit && (
              <form onSubmit={e => { e.preventDefault(); add() }} style={{ display: 'flex', gap: 8, marginBottom: 14 }}>
                <input ref={addRef} className="inp" placeholder="Add a genre, or several separated by commas" value={adding} onChange={e => setAdding(e.target.value)} aria-label="New genre" />
                <button className="btn" type="submit" disabled={!adding.trim()}>Add</button>
              </form>
            )}

            <div role="list" aria-label="Genres">
              {shown.map(r => {
                const idx = rows.indexOf(r)
                const merging = r.mergeInto != null
                const target = merging ? rows.find(x => x.id === r.mergeInto) : null
                const renamed = r.orig && r.orig !== r.value.trim().replace(/\s+/g, ' ')
                return (
                  <div key={r.id} role="listitem"
                    draggable={canEdit && !q}
                    onDragStart={() => setDragId(r.id)}
                    onDragOver={e => { if (dragId != null && dragId !== r.id) { e.preventDefault() } }}
                    onDrop={e => { e.preventDefault(); if (dragId != null) move(dragId, idx); setDragId(null) }}
                    onDragEnd={() => setDragId(null)}
                    onKeyDown={e => { if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) { e.preventDefault(); move(r.id, idx + (e.key === 'ArrowUp' ? -1 : 1)) } }}
                    style={{ display: 'flex', gap: 8, alignItems: 'center', padding: '6px 8px', borderRadius: 6, marginBottom: 2,
                      background: dragId === r.id ? 'rgba(63,123,255,.10)' : dupes.has(r.id) ? 'rgba(248,113,113,.10)' : 'transparent',
                      opacity: merging ? 0.6 : 1 }}>
                    {canEdit && <span aria-hidden title="Drag to reorder (or Alt+Up / Alt+Down)" style={{ cursor: q ? 'default' : 'grab', color: 'var(--faint)', userSelect: 'none', width: 12 }}>⋮⋮</span>}
                    <input className="inp" value={r.value} disabled={!canEdit || merging} aria-label={`Genre ${r.orig ?? r.value}`}
                      onChange={e => set(r.id, { value: e.target.value })}
                      style={{ flex: 1, minWidth: 120, maxWidth: 320, fontSize: 'var(--fs-body)', padding: '4px 8px', textDecoration: merging ? 'line-through' : undefined, color: r.retired ? 'var(--faint)' : undefined }} />
                    <span style={{ fontSize: 'var(--fs-xs)', color: 'var(--faint)', minWidth: 74 }} title="Stations, channels, events and assets carrying this genre">
                      {r.usage ? `used by ${r.usage}` : r.orig ? 'not used' : 'new'}
                    </span>
                    {r.retired && !merging && <span className="tag">retired</span>}
                    {renamed && !merging && <span className="tag" title={`Was "${r.orig}"`}>renamed{r.usage ? `, ${r.usage} to update` : ''}</span>}
                    {merging && <span style={{ fontSize: 'var(--fs-xs)' }}>merges into <b>{target?.value}</b></span>}
                    <div style={{ flex: 1 }} />
                    {canEdit && (merging ? (
                      <button className="btn ghost" style={{ padding: '2px 8px' }} onClick={() => set(r.id, { mergeInto: null })}>Undo merge</button>
                    ) : <>
                      {r.orig && r.usage > 0 && (
                        <select className="inp sel-sm" value="" aria-label={`Merge ${r.value} into`} onChange={e => e.target.value && set(r.id, { mergeInto: Number(e.target.value) })}>
                          <option value="">Merge into…</option>
                          {live.filter(x => x.id !== r.id && x.value.trim()).map(x => <option key={x.id} value={x.id}>{x.value}</option>)}
                        </select>
                      )}
                      <button className="btn ghost" style={{ padding: '2px 8px' }} onClick={() => set(r.id, { retired: !r.retired })}
                        title={r.retired ? 'Offer it again' : 'Keep it where it is set, stop offering it'}>{r.retired ? 'Restore' : 'Retire'}</button>
                      <button className="btn ghost" style={{ padding: '2px 8px' }} disabled={r.usage > 0} onClick={() => remove(r)}
                        title={r.usage > 0 ? `In use by ${r.usage}. Retire it, or merge it into another genre.` : 'Remove from the list'} aria-label={`Remove ${r.value}`}>Remove</button>
                    </>)}
                  </div>
                )
              })}
              {shown.length === 0 && <div style={{ color: 'var(--faint)', padding: 8 }}>No genre matches “{filter}”.</div>}
            </div>

            {list.unlisted.length > 0 && (
              <div style={{ marginTop: 16 }}>
                <div className="sec-label">In use but not on the list</div>
                <div className="hintxt" style={{ marginBottom: 6 }}>Set before the list was linked, or by an import. They still validate on what carries them; add them to manage them here.</div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                  {list.unlisted.filter(u => !rows.some(r => fold(r.value) === fold(u.value))).map(u => (
                    <button key={u.value} className="chip" disabled={!canEdit} onClick={() => addUnlisted(u.value, u.usage)}>+ {u.value} <span style={{ color: 'var(--faint)' }}>({u.usage})</span></button>
                  ))}
                </div>
              </div>
            )}

            <div style={{ marginTop: 16 }}>
              <FormStatus error={saveErr || undefined} blocked={dirty && problem ? problem : undefined} success={saved || undefined} onDismiss={() => { setSaveErr(''); setSaved('') }} />
            </div>
            {canEdit && (
              <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 10, flexWrap: 'wrap' }}>
                <button className="btn primary" disabled={!dirty || !!problem || busy} onClick={save}>{busy ? 'Saving…' : 'Save genres'}</button>
                <button className="btn ghost" disabled={!dirty || busy} onClick={() => { if (list) { setRows(toRows(list)); setSaveErr('') } }}>Discard changes</button>
                {dirty && !problem && (
                  <span className="hintxt" style={{ display: 'inline' }}>
                    {[renames.length && plural(renames.length, 'rename'), merges.length && plural(merges.length, 'merge'), removals.length && plural(removals.length, 'removal')].filter(Boolean).join(', ')}
                    {affected ? `${renames.length || merges.length || removals.length ? '. ' : ''}${plural(affected, 'item')} will be updated.` : ''}
                  </span>
                )}
                <div style={{ flex: 1 }} />
                {!list.isDefault && <button className="btn ghost" disabled={busy} onClick={() => setConfirmReset(true)}>Reset to platform list</button>}
              </div>
            )}
            {!canEdit && <div className="hintxt" style={{ marginTop: 12 }}>You can see the list. Changing it needs manage access to account settings.</div>}
          </>}
        </div>

        <div className="card" style={{ padding: 16 }}>
          <div className="sec-label" style={{ marginTop: 0 }}>Where it is used</div>
          {!list ? null : list.usedBy.length === 0 ? (
            <div className="hintxt">No content type field takes its options from this list. Link one in Content Types: an enum field, Options set to the Genres list.</div>
          ) : (
            <ul style={{ margin: 0, paddingLeft: 18, fontSize: 'var(--fs-sm)' }}>
              {list.usedBy.map(u => <li key={u.schemaId + u.fieldKey}><a href="/content-types" onClick={e => { e.preventDefault(); navigate('/content-types') }}>{u.schemaName}</a> <span style={{ color: 'var(--faint)' }}>· {u.label}</span></li>)}
            </ul>
          )}
          <div className="sec-label">How changes land</div>
          <ul style={{ margin: 0, paddingLeft: 18, fontSize: 'var(--fs-sm)', color: 'var(--muted)', display: 'grid', gap: 4 }}>
            <li><b>Rename</b> in place: everything tagged with it is renamed on save.</li>
            <li><b>Merge</b> into another genre: the same, then it leaves the list.</li>
            <li><b>Retire</b>: stays on whatever has it, no longer offered.</li>
            <li><b>Remove</b>: only a genre nothing uses.</li>
            <li>Programmes already in the guide keep the category they were announced with.</li>
          </ul>
        </div>
      </div>

      {confirmReset && (
        <ConfirmDialog title="Reset to the platform genre list?" confirmLabel="Reset"
          body={<>The list goes back to the {list?.defaults.length} platform genres in their order. Your own genres that something still uses are kept, retired; the rest are removed. Nothing tagged is changed.</>}
          onCancel={() => setConfirmReset(false)} onConfirm={reset} />
      )}
    </>
  )
}
