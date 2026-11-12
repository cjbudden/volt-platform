// "Find details" for content types without a specialist service (build queue
// F1): search Wikidata for the title, compare what each item would put in the
// type's fields with what the asset has, tick what to use, apply. Fields are
// matched by their schema.org names (modules/vodDetails.ts). Empty fields are
// ticked by default; a value already there changes only when ticked. Nothing
// is saved until Apply.
// Paste a link (build queue F2): one page a person names is read for its
// schema.org data and Open Graph tags and shown first among the results, to
// review and tick the same way.
// Search the web (build queue F3): opens a web search for the term in a new
// tab; the person pastes a result's link into the field below (webSearch.ts).
// Read with AI (build queue F4): with the AI Find details add-on on, the same
// pasted page is read by an AI model, for pages that publish no structured
// details; each value comes with the sentence of the page it came from, shown
// in the review. A lookup is counted against the month's allowance; when it is
// used up the panel says so and names the next pack (Admin, Billing).
import { useEffect, useMemo, useRef, useState } from 'react'
import { apiRequest, ApiError } from '../../api'
import { navigate } from '../../router'
import { webSearchUrl } from './webSearch'

const J = (b: unknown): RequestInit => ({ body: JSON.stringify(b), headers: { 'content-type': 'application/json' } })
const show = (v: unknown) => Array.isArray(v) ? v.join(', ') : v == null || v === '' ? '' : String(v)
const same = (a: unknown, b: unknown) => show(a).trim().toLowerCase() === show(b).trim().toLowerCase()
const EDITABLE = new Set(['string', 'text', 'number', 'url', 'date', 'tags'])

const LinkIcon = () => <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden><path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1" /></svg>
const ExtIcon = () => <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden><path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" /></svg>
const SparkIcon = () => <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden><path d="M12 3v4M12 17v4M3 12h4M17 12h4M6.3 6.3l2.5 2.5M15.2 15.2l2.5 2.5M6.3 17.7l2.5-2.5M15.2 8.8l2.5-2.5" /></svg>
export const SearchIcon = () => <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></svg>

/** AI Find details for this account (GET /vod/:id/finder `ai`, refreshed by each AI answer). */
export interface AiState {
  offered: boolean; on: boolean; name?: string; unit?: string
  allowance?: { included: number; used: number; left: number; resets: string } | null
  biggerPack?: { name: string; extraQuantity: number; monthlyUsd: number } | null
}
const usd = (n: number) => `$${Number.isInteger(n) ? n : n.toFixed(2)}`
const num = (n: number) => n.toLocaleString('en')

interface Field { key: string; label: string; type: string; options: string[] | null; multiple: boolean; schemaOrg: string | null }

export function DetailsFinder({ id, term, typeName, ai: aiIn, onClose, onApplied }: {
  id: string
  term: string
  typeName: string
  ai?: AiState | null
  onClose: () => void
  onApplied: (changed: string[]) => void
}) {
  const [q, setQ] = useState(term)
  const [url, setUrl] = useState('')
  const [busy, setBusy] = useState<'find' | 'page' | 'ai' | 'use' | null>(null)
  const [ai, setAi] = useState<AiState | null>(aiIn ?? null)
  const [aiRes, setAiRes] = useState<any | null>(null)
  // Set when the month's lookups are used up: what to say and the pack to offer.
  const [usedUp, setUsedUp] = useState<string | null>(null)
  const [err, setErr] = useState('')
  const [res, setRes] = useState<any | null>(null)
  const [page, setPage] = useState<any | null>(null)
  const [pick, setPick] = useState<string | null>(null)
  const [found, setFound] = useState<Record<string, any>>({})
  const [ticks, setTicks] = useState<Record<string, boolean>>({})
  // The term a web search was opened for, to say where to paste the result.
  const [searched, setSearched] = useState<string | null>(null)
  const linkRef = useRef<HTMLInputElement>(null)

  // A plain new tab in the person's browser: Volt sends the term nowhere itself.
  const searchWeb = () => {
    const to = webSearchUrl(q)
    if (!to) return
    window.open(to, '_blank', 'noopener,noreferrer')
    setSearched(q.trim())
    linkRef.current?.focus()
  }

  const find = async () => {
    setBusy('find'); setErr(''); setPick(null); setFound({}); setTicks({})
    try { setRes(await apiRequest(`/vod/${id}/details/find`, { method: 'POST', ...J({ q: q.trim() || undefined }) })) }
    catch (e: any) { setErr(e.message) } finally { setBusy(null) }
  }
  const read = async () => {
    setBusy('page'); setErr(''); setPick(null); setFound({}); setTicks({})
    try { setPage(await apiRequest(`/vod/${id}/details/page`, { method: 'POST', ...J({ url: url.trim() }) })) }
    catch (e: any) { setErr(e.message); setPage(null) } finally { setBusy(null) }
  }
  const readAi = async () => {
    setBusy('ai'); setErr(''); setUsedUp(null); setPick(null); setFound({}); setTicks({})
    try {
      const out: any = await apiRequest(`/vod/${id}/details/ai`, { method: 'POST', ...J({ url: url.trim() }) })
      setAiRes(out)
      if (out.ai) setAi(out.ai)
    } catch (e: any) {
      if (e instanceof ApiError && e.body?.code === 'allowance_exceeded') { setUsedUp(e.message); if (e.body.ai) setAi(e.body.ai) }
      else setErr(e.message)
      setAiRes(null)
    } finally { setBusy(null) }
  }

  // Whichever answered carries the asset's current values; both carry the same.
  const ctx = aiRes ?? page ?? res
  const fields: Field[] = ctx?.current?.fields ?? []
  const cur: Record<string, any> = ctx?.current?.metadata ?? {}
  const prov: Record<string, any> = ctx?.current?.provenance ?? {}
  // The pasted page first, then what the search found.
  const items: any[] = [
    ...(aiRes?.result ? [{ ...aiRes.result, key: `ai:${aiRes.result.link}`, source: 'ai' }] : []),
    ...(page?.result ? [{ ...page.result, key: `page:${page.result.link}`, source: 'page' }] : []),
    ...(res?.results ?? []).map((r: any) => ({ ...r, key: `wd:${r.id}`, source: 'wikidata' })),
  ]
  const picked = items.find((x) => x.key === pick) ?? null
  const unmapped: string[] = picked?.source === 'ai' ? (aiRes?.unmapped ?? []) : picked?.source === 'page' ? (page?.unmapped ?? []) : (res?.unmapped ?? [])

  const choose = (key: string) => {
    const r = items.find((x) => x.key === key)
    if (!r) return
    setPick(key)
    setFound({ ...r.proposed })
    const t: Record<string, boolean> = {}
    // Empty fields ticked; a value already there needs a tick to change.
    for (const [k, v] of Object.entries(r.proposed)) if (!same(cur[k], v)) t[k] = !show(cur[k])
    setTicks(t)
  }
  // An AI answer opens straight into its review: it is the one thing just asked for.
  useEffect(() => { if (aiRes?.result) choose(`ai:${aiRes.result.link}`) }, [aiRes]) // eslint-disable-line react-hooks/exhaustive-deps
  const edit = (f: Field, text: string) => {
    const v = f.type === 'tags' ? text.split(',').map((s) => s.trim()).filter(Boolean) : text
    setFound((x) => ({ ...x, [f.key]: v }))
    setTicks((t) => ({ ...t, [f.key]: same(cur[f.key], v) ? false : t[f.key] ?? !show(cur[f.key]) }))
  }

  // The review rows in the type's own field order.
  const rows = useMemo(() => fields.filter((f) => f.key in found).map((f) => ({
    f, now: cur[f.key], value: found[f.key], same: same(cur[f.key], found[f.key]),
    personal: !!show(cur[f.key]) && !(prov[f.key]?.source && prov[f.key].source !== 'manual'),
  })), [found, res, page, aiRes]) // eslint-disable-line react-hooks/exhaustive-deps
  const changes = rows.filter((r) => ticks[r.f.key] && !r.same)

  const apply = async () => {
    if (!picked) return
    const item = picked
    const values: Record<string, any> = {}
    for (const r of changes) {
      let v = r.value
      if (r.f.type === 'number') v = Number(v)
      if (r.f.type === 'tags' && !Array.isArray(v)) v = show(v).split(',').map((s) => s.trim()).filter(Boolean)
      values[r.f.key] = v
    }
    setBusy('use'); setErr('')
    try {
      const body = item.source === 'ai' ? { source: 'ai', link: item.link, lookupId: item.lookupId, values }
        : item.source === 'page' ? { source: 'page', link: item.link, values } : { source: 'wikidata', itemId: item.id, link: item.link, values }
      const out: any = await apiRequest(`/vod/${id}/details/use`, { method: 'POST', ...J(body) })
      onApplied(out.changed ?? Object.keys(values))
    } catch (e: any) { setErr(e.message) } finally { setBusy(null) }
  }

  return (
    <div className="songf" role="region" aria-label="Find details">
      <div className="songf-h">
        <div className="songf-t">Find details</div>
        <div className="lib-faint">Searches Wikidata (free, open data), or reads a page you paste (Search the web helps you find one), and matches what it finds to the {typeName} fields. Nothing changes until you apply it.</div>
      </div>
      <form className="songf-q" onSubmit={(e) => { e.preventDefault(); find() }}>
        <label className="wide"><span>Search for</span>
          <input className="inp" value={q} placeholder="The title" onChange={(e) => setQ(e.target.value)} /></label>
        <div className="songf-btns">
          <button className="btn primary sm" disabled={!!busy || !q.trim()}><SearchIcon /> {busy === 'find' ? 'Searching…' : 'Search'}</button>
          <button type="button" className="btn sm" disabled={!webSearchUrl(q)} onClick={searchWeb} title="Opens a web search for this in a new tab"><ExtIcon /> Search the web</button>
        </div>
      </form>
      <form className="songf-q songf-link" onSubmit={(e) => { e.preventDefault(); read() }}>
        <label className="wide"><span>Or paste a link to a page about it <em>(its own page on a studio, broadcaster, news or podcast site)</em></span>
          <input ref={linkRef} className="inp" type="url" inputMode="url" value={url} placeholder="https://" onChange={(e) => setUrl(e.target.value)} /></label>
        {searched && <div className="lib-faint wide songf-websearch" role="status">A web search for “{searched}” opened in a new tab. Open the result that is this title’s own page, copy its address and paste it here.</div>}
        <div className="songf-btns">
          <button className="btn sm" disabled={!!busy || !url.trim()}><LinkIcon /> {busy === 'page' ? 'Reading…' : 'Read page'}</button>
          {ai?.offered && ai.on && (
            <button type="button" className="btn sm" disabled={!!busy || !url.trim()} onClick={readAi}
              title="An AI model reads the page's text and suggests values, each with the sentence it came from. Counts one lookup."><SparkIcon /> {busy === 'ai' ? 'Reading with AI…' : 'Read with AI'}</button>
          )}
        </div>
        {ai?.offered && ai.on && ai.allowance && (
          <div className="lib-faint wide songf-ai-left">{num(ai.allowance.left)} of {num(ai.allowance.included)} AI lookups left this month. Each page read with AI counts one; reading the same page again today does not.</div>
        )}
        {ai?.offered && !ai.on && (
          <div className="lib-faint wide songf-ai-left">For pages that publish no details, the <strong>{ai.name ?? 'AI Find details'}</strong> add-on reads the page with an AI model. An account administrator can turn it on in <a href="/billing" onClick={(e) => { e.preventDefault(); navigate('/billing') }}>Billing</a>.</div>
        )}
      </form>
      {usedUp && (
        <div className="asset-img-err" role="alert">{usedUp}{ai?.biggerPack ? <> The next pack, {ai.biggerPack.name}, is {usd(ai.biggerPack.monthlyUsd)} a month.</> : null}{' '}
          <a href="/billing" onClick={(e) => { e.preventDefault(); navigate('/billing') }}>Choose a bigger pack in Billing</a>.</div>
      )}
      {err && <div className="asset-img-err">{err}</div>}
      {res?.error && <div className="asset-img-err">{res.error}. Try again in a moment.</div>}
      {page?.error && <div className="asset-img-err">{page.error}{ai?.on && !page.blocked && !aiRes ? ' Read with AI can read its text instead.' : ''}</div>}
      {aiRes?.error && <div className="asset-img-err">{aiRes.error}</div>}
      {res && !res.error && res.results.length === 0 && <div className="lib-faint" style={{ marginTop: 10 }}>Nothing found for “{res.term}”. Try fewer words, or the original title.</div>}

      {items.length > 0 && (
        <div className="songf-results">
          {items.map((r: any) => {
            const n = Object.keys(r.proposed).length
            return (
              <button key={r.key} type="button" className={`songf-r${pick === r.key ? ' sel' : ''}`} disabled={!!busy} onClick={() => choose(r.key)}>
                {r.imageUrl ? <img src={r.imageUrl} alt="" loading="lazy" /> : <span className="songf-noimg" />}
                <span className="songf-rb">
                  <span className="songf-main songf-src">{r.label}</span>
                  {r.source === 'page' && <span className="lib-faint">From the page on {r.site}{r.kinds[0] ? ` (${r.kinds[0]})` : ''}</span>}
                  {r.source === 'ai' && <span className="lib-faint"><SparkIcon /> Read by AI from the page on {r.site}{aiRes?.reused ? ' (read earlier today, not counted again)' : ''}</span>}
                  <span className="lib-faint">{r.description ?? r.kinds.join(', ') ?? ''}</span>
                  <span className="lib-faint">{n ? `${n} field${n === 1 ? '' : 's'} to compare` : 'Nothing for these fields'}{r.source !== 'page' && r.likely ? ` · a ${(r.kinds[0] ?? 'match')}` : ''}</span>
                </span>
              </button>
            )
          })}
        </div>
      )}

      {picked && (
        <div className="songf-review">
          <div className="songf-rh">Review: tick what to use · <a href={picked.link} target="_blank" rel="noreferrer">{picked.source !== 'wikidata' ? `The page on ${picked.site}` : 'Wikidata item'} <ExtIcon /></a></div>
          {picked.source === 'ai' && <div className="lib-faint songf-ai-why">Suggested by an AI model. Each value shows the sentence of the page it came from: check it before you apply.{picked.dropped?.unquoted ? ` ${picked.dropped.unquoted} suggestion${picked.dropped.unquoted === 1 ? ' was' : 's were'} left out because the sentence given is not on the page.` : ''}</div>}
          {rows.length === 0 ? <div className="lib-faint">{picked.source !== 'wikidata' ? 'This page has' : 'This item has'} nothing for the {typeName} fields.</div> : (
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
                        : show(r.value)}
                      {picked.source === 'ai' && picked.from?.[r.f.key] && <blockquote className="songf-quote">{picked.from[r.f.key]}</blockquote>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {unmapped.length > 0 && <div className="lib-faint" style={{ marginTop: 8 }}>{picked.source === 'ai' ? 'Never filled by an AI reading' : picked.source === 'page' ? 'No schema.org name, so never filled from a page' : 'Not filled from Wikidata'}: {unmapped.join(', ')}.</div>}
          <div className="songf-act">
            <button type="button" className="btn primary sm" disabled={!!busy || !changes.length} onClick={apply}>
              {busy === 'use' ? 'Applying…' : `Apply ${changes.length} change${changes.length === 1 ? '' : 's'}`}</button>
            <span className="lib-faint">Each field you apply remembers that it came from {picked.source === 'ai' ? `an AI reading of ${picked.site}, with its sentence` : picked.source === 'page' ? picked.site : 'Wikidata'}.</span>
          </div>
        </div>
      )}
      <div style={{ marginTop: 8 }}><button type="button" className="btn ghost sm" onClick={onClose}>Close</button></div>
    </div>
  )
}
