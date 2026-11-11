// "Find details" for content types without a specialist service (build queue
// F1): search Wikidata for the title, compare what each item would put in the
// type's fields with what the asset has, tick what to use, apply. Fields are
// matched by their schema.org names (modules/vodDetails.ts). Empty fields are
// ticked by default; a value already there changes only when ticked. Nothing
// is saved until Apply.
import { useMemo, useState } from 'react'
import { apiRequest } from '../../api'

const J = (b: unknown): RequestInit => ({ body: JSON.stringify(b), headers: { 'content-type': 'application/json' } })
const show = (v: unknown) => Array.isArray(v) ? v.join(', ') : v == null || v === '' ? '' : String(v)
const same = (a: unknown, b: unknown) => show(a).trim().toLowerCase() === show(b).trim().toLowerCase()
const EDITABLE = new Set(['string', 'text', 'number', 'url', 'date', 'tags'])

const ExtIcon = () => <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden><path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" /></svg>
export const SearchIcon = () => <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></svg>

interface Field { key: string; label: string; type: string; options: string[] | null; multiple: boolean; schemaOrg: string | null }

export function DetailsFinder({ id, term, typeName, onClose, onApplied }: {
  id: string
  term: string
  typeName: string
  onClose: () => void
  onApplied: (changed: string[]) => void
}) {
  const [q, setQ] = useState(term)
  const [busy, setBusy] = useState<'find' | 'use' | null>(null)
  const [err, setErr] = useState('')
  const [res, setRes] = useState<any | null>(null)
  const [pick, setPick] = useState<number | null>(null)
  const [found, setFound] = useState<Record<string, any>>({})
  const [ticks, setTicks] = useState<Record<string, boolean>>({})

  const find = async () => {
    setBusy('find'); setErr(''); setPick(null); setFound({}); setTicks({})
    try { setRes(await apiRequest(`/vod/${id}/details/find`, { method: 'POST', ...J({ q: q.trim() || undefined }) })) }
    catch (e: any) { setErr(e.message) } finally { setBusy(null) }
  }

  const fields: Field[] = res?.current?.fields ?? []
  const cur: Record<string, any> = res?.current?.metadata ?? {}
  const prov: Record<string, any> = res?.current?.provenance ?? {}

  const choose = (i: number) => {
    const r = res.results[i]
    setPick(i)
    setFound({ ...r.proposed })
    const t: Record<string, boolean> = {}
    // Empty fields ticked; a value already there needs a tick to change.
    for (const [k, v] of Object.entries(r.proposed)) if (!same(cur[k], v)) t[k] = !show(cur[k])
    setTicks(t)
  }
  const edit = (f: Field, text: string) => {
    const v = f.type === 'tags' ? text.split(',').map((s) => s.trim()).filter(Boolean) : text
    setFound((x) => ({ ...x, [f.key]: v }))
    setTicks((t) => ({ ...t, [f.key]: same(cur[f.key], v) ? false : t[f.key] ?? !show(cur[f.key]) }))
  }

  // The review rows in the type's own field order.
  const rows = useMemo(() => fields.filter((f) => f.key in found).map((f) => ({
    f, now: cur[f.key], value: found[f.key], same: same(cur[f.key], found[f.key]),
    personal: !!show(cur[f.key]) && !(prov[f.key]?.source && prov[f.key].source !== 'manual'),
  })), [found, res]) // eslint-disable-line react-hooks/exhaustive-deps
  const changes = rows.filter((r) => ticks[r.f.key] && !r.same)

  const apply = async () => {
    if (pick == null) return
    const item = res.results[pick]
    const values: Record<string, any> = {}
    for (const r of changes) {
      let v = r.value
      if (r.f.type === 'number') v = Number(v)
      if (r.f.type === 'tags' && !Array.isArray(v)) v = show(v).split(',').map((s) => s.trim()).filter(Boolean)
      values[r.f.key] = v
    }
    setBusy('use'); setErr('')
    try {
      const out: any = await apiRequest(`/vod/${id}/details/use`, { method: 'POST', ...J({ source: 'wikidata', itemId: item.id, link: item.link, values }) })
      onApplied(out.changed ?? Object.keys(values))
    } catch (e: any) { setErr(e.message) } finally { setBusy(null) }
  }

  return (
    <div className="songf" role="region" aria-label="Find details">
      <div className="songf-h">
        <div className="songf-t">Find details</div>
        <div className="lib-faint">Searches Wikidata (free, open data) and matches what it knows to the {typeName} fields. Nothing changes until you apply it.</div>
      </div>
      <form className="songf-q" onSubmit={(e) => { e.preventDefault(); find() }}>
        <label className="wide"><span>Search for</span>
          <input className="inp" value={q} placeholder="The title" onChange={(e) => setQ(e.target.value)} /></label>
        <button className="btn primary sm" disabled={!!busy || !q.trim()}><SearchIcon /> {busy === 'find' ? 'Searching…' : 'Search'}</button>
      </form>
      {err && <div className="asset-img-err">{err}</div>}
      {res?.error && <div className="asset-img-err">{res.error}. Try again in a moment.</div>}
      {res && !res.error && res.results.length === 0 && <div className="lib-faint" style={{ marginTop: 10 }}>Nothing found for “{res.term}”. Try fewer words, or the original title.</div>}

      {res?.results?.length > 0 && (
        <div className="songf-results">
          {res.results.map((r: any, i: number) => {
            const n = Object.keys(r.proposed).length
            return (
              <button key={r.id} type="button" className={`songf-r${pick === i ? ' sel' : ''}`} disabled={!!busy} onClick={() => choose(i)}>
                {r.imageUrl ? <img src={r.imageUrl} alt="" loading="lazy" /> : <span className="songf-noimg" />}
                <span className="songf-rb">
                  <span className="songf-main songf-src">{r.label}</span>
                  <span className="lib-faint">{r.description ?? r.kinds.join(', ') ?? ''}</span>
                  <span className="lib-faint">{n ? `${n} field${n === 1 ? '' : 's'} to compare` : 'Nothing for these fields'}{r.likely ? ` · a ${(r.kinds[0] ?? 'match')}` : ''}</span>
                </span>
              </button>
            )
          })}
        </div>
      )}

      {pick != null && res && (
        <div className="songf-review">
          <div className="songf-rh">Review: tick what to use · <a href={res.results[pick].link} target="_blank" rel="noreferrer">Wikidata item <ExtIcon /></a></div>
          {rows.length === 0 ? <div className="lib-faint">This item has nothing for the {typeName} fields.</div> : (
            <table className="songf-t">
              <thead><tr><th /><th>Field</th><th>Now</th><th>Found</th></tr></thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.f.key} className={r.same ? 'same' : ''}>
                    <td>{r.same ? <span className="lib-faint" title="Already the same">=</span>
                      : <input type="checkbox" aria-label={`Use ${r.f.label}`} checked={!!ticks[r.f.key]} onChange={(e) => setTicks({ ...ticks, [r.f.key]: e.target.checked })} />}</td>
                    <td>{r.f.label}</td>
                    <td>{r.f.type === 'image' && show(r.now) ? <span className="lib-faint">an image</span> : show(r.now) || <span className="lib-faint">empty</span>}
                      {r.personal && !r.same && <div className="songf-note">entered by a person</div>}</td>
                    <td>{r.f.type === 'image'
                      ? <><img className="songf-thumb" src={String(r.value)} alt={`${r.f.label} found`} />{ticks[r.f.key] && <div className="songf-note">Copied into the Image Library</div>}</>
                      : EDITABLE.has(r.f.type)
                        ? <input className="inp sm" value={show(r.value)} aria-label={`${r.f.label} found`} onChange={(e) => edit(r.f, e.target.value)} />
                        : show(r.value)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {res.unmapped?.length > 0 && <div className="lib-faint" style={{ marginTop: 8 }}>Not filled from Wikidata: {res.unmapped.join(', ')}.</div>}
          <div className="songf-act">
            <button type="button" className="btn primary sm" disabled={!!busy || !changes.length} onClick={apply}>
              {busy === 'use' ? 'Applying…' : `Apply ${changes.length} change${changes.length === 1 ? '' : 's'}`}</button>
            <span className="lib-faint">Each field you apply remembers that it came from Wikidata.</span>
          </div>
        </div>
      )}
      <div style={{ marginTop: 8 }}><button type="button" className="btn ghost sm" onClick={onClose}>Close</button></div>
    </div>
  )
}
