// ============================================================================
//  RULES ON A COLLECTION (build queue C1, volt-app services/collectionRules.ts).
//
//  "Add media by rules": Match all / any of the conditions below, each a
//  field, an operator that fits the field's type, and a value; a group can
//  hold its own all / any. The count of what the rules match updates as the
//  rules are written, with a few examples, so the effect is seen before it
//  is saved. Saving matches the whole library at once; after that the
//  collection keeps itself up to date as media changes, and every night.
//
//  What people add by hand stays whatever the rules say. What people take out
//  of a rule collection is left out until someone lets it back in.
// ============================================================================
import { useEffect, useMemo, useRef, useState } from 'react'
import { apiRequest } from '../../api'
import { useNotify } from '../../notices'

type FieldType = 'text' | 'number' | 'date' | 'list' | 'ref' | 'tags' | 'boolean'
interface Field { key: string; label: string; type: FieldType; group: string; values?: { value: string; label: string }[]; unit?: string }
interface Op { op: string; label: string; arity: 0 | 1 | 2 | 'list' | 'within' }
export interface Catalogue { fields: Field[]; operators: Record<FieldType, Op[]>; orders: { value: string; label: string }[] }
interface Cond { field: string; op: string; value?: any }
export interface Group { match: 'all' | 'any'; conditions: (Cond | Group)[] }
const isGroup = (x: any): x is Group => x && Array.isArray(x.conditions)
const J = (b: unknown) => ({ body: JSON.stringify(b) })

let catalogueCache: Promise<Catalogue> | null = null
export const rulesApi = {
  fields: (): Promise<Catalogue> => (catalogueCache ??= apiRequest('/collections/rules/fields').catch((e: any) => { catalogueCache = null; throw e })),
  preview: (rules: Group): Promise<{ count: number; sample: { id: string; title: string }[]; ms: number }> => apiRequest('/collections/rules/preview', { method: 'POST', ...J({ rules }) }),
  save: (id: string, b: { rules?: Group | null; orderBy?: string }): Promise<any> => apiRequest(`/collections/${id}`, { method: 'PATCH', ...J(b) }),
  recheck: (id: string): Promise<{ added: number; removed: number; members: number; ms: number }> => apiRequest(`/collections/${id}/recheck`, { method: 'POST' }),
  exclusions: (id: string): Promise<{ items: { id: string; title: string; excludedAt: string; excludedBy: string | null }[] }> => apiRequest(`/collections/${id}/exclusions`),
  letBackIn: (id: string, assetIds: string[]): Promise<{ letBackIn: number; matched: number }> => apiRequest(`/collections/${id}/exclusions/remove`, { method: 'POST', ...J({ assetIds }) }),
}
export function useCatalogue() {
  const [cat, setCat] = useState<Catalogue | null>(null)
  useEffect(() => { rulesApi.fields().then(setCat).catch(() => {}) }, [])
  return cat
}

/** A sensible first value when the field or operator changes. */
export function blankValue(f: Field | undefined, op: Op | undefined): any {
  if (!f || !op || op.arity === 0) return undefined
  if (op.arity === 'within') return { count: 7, unit: 'day' }
  if (op.arity === 'list') return []
  if (op.arity === 2) return ['', '']
  return ''
}
/** Is a condition filled in enough to ask the server about it? */
function complete(c: Cond, cat: Catalogue): boolean {
  const f = cat.fields.find((x) => x.key === c.field); if (!f) return false
  const op = cat.operators[f.type].find((o) => o.op === c.op); if (!op) return false
  if (op.arity === 0) return true
  if (op.arity === 'within') return Number(c.value?.count) > 0
  if (op.arity === 'list') return Array.isArray(c.value) && c.value.length > 0
  if (op.arity === 2) return Array.isArray(c.value) && c.value.every((v: any) => String(v ?? '').trim() !== '')
  return String(c.value ?? '').trim() !== ''
}
export function allComplete(g: Group, cat: Catalogue): boolean {
  return g.conditions.length > 0 && g.conditions.every((c) => (isGroup(c) ? allComplete(c, cat) : complete(c, cat)))
}

const Icon = {
  plus: <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.2" aria-hidden><path d="M12 5v14M5 12h14" /></svg>,
  group: <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M7 9h10M7 13h6" /></svg>,
  x: <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.2" aria-hidden><path d="M6 6l12 12M18 6 6 18" /></svg>,
  rule: <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden><path d="M4 6h16M7 12h10M10 18h4" /></svg>,
  refresh: <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden><path d="M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7" /></svg>,
}

// ---------------------------------------------------------------------------
//  One condition row
// ---------------------------------------------------------------------------
function ValueInput({ f, op, value, onChange, id }: { f: Field; op: Op; value: any; onChange: (v: any) => void; id: string }) {
  if (op.arity === 0) return null
  const type = f.type === 'number' ? 'number' : f.type === 'date' ? 'date' : 'text'
  const toDay = (v: any) => (v ? String(v).slice(0, 10) : '')
  if (op.arity === 'within') return (
    <span className="crb-val">
      <input className="inp" type="number" min={1} aria-label="How many" style={{ width: 80 }} value={value?.count ?? ''} onChange={(e) => onChange({ ...value, count: Number(e.target.value) })} />
      <select className="inp" aria-label="Unit" value={value?.unit ?? 'day'} onChange={(e) => onChange({ ...value, unit: e.target.value })}>
        <option value="day">days</option><option value="week">weeks</option><option value="month">months</option>
      </select>
    </span>)
  if (op.arity === 2) return (
    <span className="crb-val">
      <input className="inp" type={type} aria-label="From" value={type === 'date' ? toDay(value?.[0]) : value?.[0] ?? ''} onChange={(e) => onChange([e.target.value, value?.[1] ?? ''])} />
      <span className="crb-and">and</span>
      <input className="inp" type={type} aria-label="To" value={type === 'date' ? toDay(value?.[1]) : value?.[1] ?? ''} onChange={(e) => onChange([value?.[0] ?? '', e.target.value])} />
      {f.unit && <span className="crb-unit">{f.unit}</span>}
    </span>)
  if (op.arity === 'list') return <ListValue f={f} value={Array.isArray(value) ? value : []} onChange={onChange} id={id} />
  return (
    <span className="crb-val">
      <input className="inp" type={type} aria-label="Value" value={type === 'date' ? toDay(value) : value ?? ''} onChange={(e) => onChange(e.target.value)} placeholder={f.type === 'text' ? 'Type a value' : ''} />
      {f.unit && <span className="crb-unit">{f.unit}</span>}
    </span>)
}

/** Chips for lists, references and tags: choose from the list, or type tags. */
function ListValue({ f, value, onChange, id }: { f: Field; value: string[]; onChange: (v: string[]) => void; id: string }) {
  const [text, setText] = useState('')
  const opts = f.values ?? []
  const name = (v: string) => opts.find((o) => o.value === v)?.label ?? v
  const add = (v: string) => { const s = v.trim(); if (s && !value.includes(s)) onChange([...value, s]); setText('') }
  return (
    <span className="crb-val crb-chips">
      {value.map((v) => (
        <span key={v} className="crb-chip">{name(v)}<button type="button" aria-label={`Remove ${name(v)}`} onClick={() => onChange(value.filter((x) => x !== v))}>{Icon.x}</button></span>
      ))}
      {opts.length ? (
        <select className="inp" aria-label={`Add a ${f.label.toLowerCase()}`} value="" onChange={(e) => e.target.value && add(e.target.value)}>
          <option value="">{value.length ? 'Add another' : 'Choose'}</option>
          {opts.filter((o) => !value.includes(o.value)).map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
      ) : (
        <input className="inp" aria-label={`Add a ${f.label.toLowerCase()}`} list={`${id}-l`} placeholder={value.length ? 'Add another' : 'Type, then Enter'} value={text}
          onChange={(e) => setText(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); add(text) } }} onBlur={() => text && add(text)} />
      )}
    </span>)
}

function CondRow({ c, cat, onChange, onRemove, id }: { c: Cond; cat: Catalogue; onChange: (c: Cond) => void; onRemove: () => void; id: string }) {
  const f = cat.fields.find((x) => x.key === c.field)
  const ops = f ? cat.operators[f.type] : []
  const op = ops.find((o) => o.op === c.op)
  const groups = useMemo(() => [...new Set(cat.fields.map((x) => x.group))], [cat])
  return (
    <div className="crb-row">
      <select className="inp crb-field" aria-label="Field" value={c.field} onChange={(e) => {
        const nf = cat.fields.find((x) => x.key === e.target.value); const nop = nf ? cat.operators[nf.type][0] : undefined
        onChange({ field: e.target.value, op: nop?.op ?? '', value: blankValue(nf, nop) })
      }}>
        {groups.map((g) => <optgroup key={g} label={g}>{cat.fields.filter((x) => x.group === g).map((x) => <option key={x.key} value={x.key}>{x.label}</option>)}</optgroup>)}
      </select>
      <select className="inp crb-op" aria-label="Operator" value={c.op} onChange={(e) => { const no = ops.find((o) => o.op === e.target.value); onChange({ ...c, op: e.target.value, value: no?.arity === op?.arity ? c.value : blankValue(f, no) }) }}>
        {ops.map((o) => <option key={o.op} value={o.op}>{o.label}</option>)}
      </select>
      {f && op && <ValueInput f={f} op={op} value={c.value} onChange={(v) => onChange({ ...c, value: v })} id={id} />}
      <button type="button" className="fast-ico crb-del" aria-label="Remove this condition" onClick={onRemove}>{Icon.x}</button>
    </div>)
}

// Also the condition builder of publishing metadata rules (publishing/MetadataRules.tsx, P3-3).
export function GroupBox({ g, cat, depth, onChange, onRemove, path }: { g: Group; cat: Catalogue; depth: number; onChange: (g: Group) => void; onRemove?: () => void; path: string }) {
  const first = cat.fields[0]
  const newCond = (): Cond => ({ field: first.key, op: cat.operators[first.type][0].op, value: blankValue(first, cat.operators[first.type][0]) })
  const set = (i: number, c: Cond | Group) => onChange({ ...g, conditions: g.conditions.map((x, j) => (j === i ? c : x)) })
  const del = (i: number) => onChange({ ...g, conditions: g.conditions.filter((_, j) => j !== i) })
  return (
    <div className={`crb-group${depth > 1 ? ' nested' : ''}`} role="group" aria-label={depth > 1 ? 'Group of conditions' : 'Conditions'}>
      <div className="crb-match">
        <span>Match</span>
        <div className="seg-choice" role="radiogroup" aria-label="Match">
          <button type="button" role="radio" aria-checked={g.match === 'all'} className={g.match === 'all' ? 'sel' : ''} onClick={() => onChange({ ...g, match: 'all' })}>all</button>
          <button type="button" role="radio" aria-checked={g.match === 'any'} className={g.match === 'any' ? 'sel' : ''} onClick={() => onChange({ ...g, match: 'any' })}>any</button>
        </div>
        <span>of these</span>
        {onRemove && <button type="button" className="btn ghost sm" style={{ marginLeft: 'auto' }} onClick={onRemove}>Remove group</button>}
      </div>
      {g.conditions.map((c, i) => isGroup(c)
        ? <GroupBox key={i} g={c} cat={cat} depth={depth + 1} path={`${path}-${i}`} onChange={(x) => set(i, x)} onRemove={() => del(i)} />
        : <CondRow key={i} c={c} cat={cat} id={`${path}-${i}`} onChange={(x) => set(i, x)} onRemove={() => del(i)} />)}
      <div className="crb-adds">
        <button type="button" className="btn ghost sm" onClick={() => onChange({ ...g, conditions: [...g.conditions, newCond()] })}>{Icon.plus} Condition</button>
        {depth < 3 && <button type="button" className="btn ghost sm" onClick={() => onChange({ ...g, conditions: [...g.conditions, { match: g.match === 'all' ? 'any' : 'all', conditions: [newCond()] }] })}>{Icon.group} Group</button>}
      </div>
    </div>)
}

// ---------------------------------------------------------------------------
//  The card on a collection
// ---------------------------------------------------------------------------
export function CollectionRulesCard({ collectionId, rules, orderBy, checkedAt, counts, onSaved }: {
  collectionId: string; rules: Group | null; orderBy: string; checkedAt: string | null
  counts: { rule: number; manual: number; excluded: number }; onSaved: () => void
}) {
  const cat = useCatalogue()
  const notify = useNotify()
  const [on, setOn] = useState(!!rules)
  const [draft, setDraft] = useState<Group | null>(rules)
  const [pv, setPv] = useState<{ count: number; sample: { id: string; title: string }[]; ms: number } | null>(null)
  const [pvErr, setPvErr] = useState('')
  const [busy, setBusy] = useState(false)
  const [showOut, setShowOut] = useState(false)
  const [out, setOut] = useState<{ id: string; title: string; excludedAt: string; excludedBy: string | null }[] | null>(null)
  const seq = useRef(0)
  useEffect(() => { setOn(!!rules); setDraft(rules) }, [collectionId, JSON.stringify(rules)])
  // A first condition as soon as rules are switched on.
  useEffect(() => {
    if (on && !draft && cat) { const f = cat.fields[0]; const o = cat.operators[f.type][0]; setDraft({ match: 'all', conditions: [{ field: f.key, op: o.op, value: blankValue(f, o) }] }) }
  }, [on, cat])
  // THE LIVE COUNT, a moment after the rules stop changing.
  useEffect(() => {
    if (!on || !draft || !cat || !allComplete(draft, cat)) { setPv(null); setPvErr(''); return }
    const n = ++seq.current
    const t = setTimeout(() => rulesApi.preview(draft).then((r) => { if (n === seq.current) { setPv(r); setPvErr('') } })
      .catch((e: any) => { if (n === seq.current) { setPv(null); setPvErr(e.message) } }), 350)
    return () => clearTimeout(t)
  }, [on, JSON.stringify(draft), cat])
  useEffect(() => { if (showOut) rulesApi.exclusions(collectionId).then((r) => setOut(r.items)).catch(() => setOut([])) }, [showOut, collectionId, counts.excluded])

  const dirty = JSON.stringify(on ? draft : null) !== JSON.stringify(rules)
  const ready = !on || (!!draft && !!cat && allComplete(draft, cat))
  async function save() {
    setBusy(true)
    try {
      const r = await rulesApi.save(collectionId, { rules: on ? draft : null })
      onSaved()
      notify({ kind: 'ok', message: on
        ? `Rules saved. ${r.matched?.members ?? 0} item${r.matched?.members === 1 ? '' : 's'} match now, and the collection keeps itself up to date.`
        : `Rules turned off. ${r.matched?.removed ?? 0} item${r.matched?.removed === 1 ? '' : 's'} the rules had added came out. What people added stays.` })
    } catch (e: any) { notify({ kind: 'error', title: "Couldn't save the rules.", message: e.message }) } finally { setBusy(false) }
  }
  async function recheck() {
    try { const r = await rulesApi.recheck(collectionId); onSaved(); notify({ kind: 'ok', message: `Checked the whole library in ${(r.ms / 1000).toFixed(1)} s: ${r.added} added, ${r.removed} taken out.` }) }
    catch (e: any) { notify({ kind: 'error', message: e.message }) }
  }
  async function order(v: string) {
    try { await rulesApi.save(collectionId, { orderBy: v }); onSaved() } catch (e: any) { notify({ kind: 'error', message: e.message }) }
  }
  async function letBack(ids: string[]) {
    try { const r = await rulesApi.letBackIn(collectionId, ids); onSaved(); notify({ kind: 'ok', message: r.matched ? 'Back in: the rules match it.' : 'Let back in. The rules do not match it now, so add it by hand if you want it here.' }) }
    catch (e: any) { notify({ kind: 'error', message: e.message }) }
  }

  return (
    <div className="card">
      <div className="card-h" style={{ flexWrap: 'wrap', gap: 10 }}>
        <h3 style={{ display: 'flex', alignItems: 'center', gap: 8 }}>{Icon.rule} Rules</h3>
        <span className="sub">{rules ? `${counts.rule} from rules · ${counts.manual} added by hand${counts.excluded ? ` · ${counts.excluded} left out` : ''}` : 'Media is added by hand'}</span>
        <span className="spacer" />
        <label className="fast-mini"><input type="checkbox" checked={on} onChange={(e) => setOn(e.target.checked)} /> Add media by rules</label>
      </div>
      {on && (
        <div className="card-b">
          {!cat || !draft ? <div className="loading">Loading the fields…</div> : <>
            <GroupBox g={draft} cat={cat} depth={1} path={`r-${collectionId}`} onChange={setDraft} />
            <div className="crb-preview" aria-live="polite">
              {pvErr ? <span className="field-err">{pvErr}</span>
                : !allComplete(draft, cat) ? <span className="hintxt" style={{ margin: 0 }}>Fill in every condition to see what it matches.</span>
                : !pv ? <span className="hintxt" style={{ margin: 0 }}>Counting…</span>
                : <>
                  <b>{pv.count.toLocaleString()} item{pv.count === 1 ? '' : 's'} match now{rules && counts.excluded ? `, of which ${counts.excluded} ${counts.excluded === 1 ? 'is' : 'are'} left out by a person` : ''}</b>
                  {pv.sample.length > 0 && <span className="crb-sample">{pv.sample.slice(0, 6).map((s) => s.title || 'Untitled').join(', ')}{pv.count > 6 ? ', …' : ''}</span>}
                </>}
            </div>
          </>}
        </div>
      )}
      <div className="card-b crb-foot">
        <label htmlFor={`ord-${collectionId}`} className="hintxt" style={{ margin: 0 }}>Order</label>
        <select id={`ord-${collectionId}`} className="inp" style={{ maxWidth: 260 }} value={orderBy} onChange={(e) => order(e.target.value)}>
          {(cat?.orders ?? [{ value: 'manual', label: 'By hand' }]).map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
        <span className="spacer" />
        {rules && <span className="hintxt" style={{ margin: 0 }}>{checkedAt ? `Checked ${new Date(checkedAt).toLocaleString()}` : 'Check pending'}</span>}
        {rules && <button type="button" className="btn ghost sm" onClick={recheck}>{Icon.refresh} Check now</button>}
        {rules && counts.excluded > 0 && <button type="button" className="btn ghost sm" onClick={() => setShowOut((x) => !x)}>{showOut ? 'Hide' : 'Show'} left out ({counts.excluded})</button>}
        {(dirty || (on && !rules)) && <button type="button" className="btn primary sm" disabled={!ready || busy || !dirty} onClick={save}>{busy ? 'Saving…' : on ? 'Save rules' : 'Turn rules off'}</button>}
      </div>
      {showOut && (
        <div className="card-b" style={{ borderTop: '1px solid var(--border)' }}>
          <div className="hintxt" style={{ marginTop: 0 }}>Taken out by a person. The rules leave these out until you let them back in.</div>
          {!out ? <div className="loading">Loading…</div> : out.map((x) => (
            <div key={x.id} className="crb-out">
              <span className="t">{x.title || 'Untitled'}</span>
              <span className="hintxt" style={{ margin: 0 }}>{x.excludedBy ? `by ${x.excludedBy}, ` : ''}{new Date(x.excludedAt).toLocaleDateString()}</span>
              <button type="button" className="btn ghost sm" onClick={() => letBack([x.id])}>Let back in</button>
            </div>))}
        </div>
      )}
    </div>)
}
