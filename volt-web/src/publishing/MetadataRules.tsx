// ============================================================================
//  METADATA RULES (build queue P3-3, volt-app services/publishingMetadataRules.ts).
//
//    account < content type < channel / event / station < METADATA RULE < item
//
//  An ordered list: each rule is a set of conditions on a title's metadata,
//  tags, collections or source (the same builder as rule-based collections)
//  and the policy it chooses. The first rule a title meets applies; drag a
//  rule, or use its arrows, to change the order. The test box answers which
//  rule a title meets and what it then gets.
// ============================================================================
import { useEffect, useMemo, useRef, useState } from 'react'
import { RuleEditor } from '../RuleEditor'
import { GroupBox, allComplete, blankValue, type Catalogue, type Group } from '../pages/vod/CollectionRules'
import { metadataRulesApi, type MetadataRule, type MetaTest } from './policyApi'
import { statedIds, SECTION_FIELD_LABEL } from './PolicyFields'
import { useNotify } from '../notices'
import '../pages/vod/collections.css'
import './policy.css'

const Ico = {
  grip: <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden><circle cx="9" cy="6" r="1.6" /><circle cx="15" cy="6" r="1.6" /><circle cx="9" cy="12" r="1.6" /><circle cx="15" cy="12" r="1.6" /><circle cx="9" cy="18" r="1.6" /><circle cx="15" cy="18" r="1.6" /></svg>,
  up: <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.2" aria-hidden><path d="m6 15 6-6 6 6" /></svg>,
  down: <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.2" aria-hidden><path d="m6 9 6 6 6-6" /></svg>,
  plus: <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.2" aria-hidden><path d="M12 5v14M5 12h14" /></svg>,
  test: <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden><path d="M9 3h6M10 3v6l-5 9a2 2 0 0 0 1.8 3h10.4a2 2 0 0 0 1.8-3l-5-9V3" /></svg>,
  rules: <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden><path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01" /></svg>,
  yes: <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.4" aria-hidden><path d="m5 12 5 5 9-10" /></svg>,
  no: <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.2" aria-hidden><path d="M6 6l12 12M18 6 6 18" /></svg>,
}

const KEY_NAMES: Record<string, string> = {
  targets: 'Publish to', autoPublish: 'Auto-publish', availableFrom: 'Available from', expire: 'Expires', geo: 'Geo access', access: 'Access',
  paywall: 'Paywall', gate: 'Publish gate', accessRules: 'Access rules', archive: 'Archive copies',
}

/** One line for a rule's conditions, in the console's words. */
function summary(g: Group, cat: Catalogue | null): string {
  if (!cat) return ''
  const one = (c: any): string => {
    if (Array.isArray(c?.conditions)) return `(${summary(c, cat)})`
    const f = cat.fields.find(x => x.key === c.field)
    const op = f ? cat.operators[f.type].find(o => o.op === c.op) : undefined
    const name = (v: any) => f?.values?.find(o => o.value === v)?.label ?? String(v)
    const val = c.value === undefined ? '' : Array.isArray(c.value) ? ' ' + c.value.map(name).join(', ') : typeof c.value === 'object' ? ` ${c.value.count} ${c.value.unit}s` : ` ${name(c.value)}`
    return `${f?.label ?? c.field} ${op?.label ?? c.op}${val}`
  }
  return g.conditions.map(one).join(g.match === 'all' ? ' and ' : ' or ')
}

export function MetadataRulesCard() {
  const notify = useNotify()
  const [rules, setRules] = useState<MetadataRule[] | null>(null)
  const [cat, setCat] = useState<Catalogue | null>(null)
  const [err, setErr] = useState('')
  const [open, setOpen] = useState<string | null>(null)
  const [adding, setAdding] = useState(false)
  const dragFrom = useRef<number | null>(null)
  const [dragOver, setDragOver] = useState<number | null>(null)

  async function load() {
    try { setRules((await metadataRulesApi.list()).items); setErr('') } catch (e: any) { setErr(e.message) }
  }
  useEffect(() => { load(); metadataRulesApi.fields().then(setCat).catch(() => {}) }, [])

  async function move(from: number, to: number) {
    if (!rules || from === to || to < 0 || to >= rules.length) return
    const next = [...rules]; const [r] = next.splice(from, 1); next.splice(to, 0, r)
    setRules(next)
    try {
      const out = await metadataRulesApi.order(next.map(x => x.id))
      setRules(prev => out.items.map(x => ({ ...x, titles: prev?.find(p => p.id === x.id)?.titles })))
      notify({ kind: 'ok', message: `${r.name} is now rule ${to + 1}. Published titles take up the new order within a minute.` })
      load()
    } catch (e: any) { notify({ kind: 'error', title: "Couldn't change the order.", message: e.message }); load() }
  }

  return (
    <div className="card" data-metadata-rules style={{ marginBottom: 16 }}>
      <div className="card-h" style={{ flexWrap: 'wrap' }}>
        <h3 style={{ display: 'flex', alignItems: 'center', gap: 8 }}>{Ico.rules} Metadata rules</h3>
        <span className="sub">{rules ? `${rules.length} rule${rules.length === 1 ? '' : 's'}` : ''}</span>
        <span className="spacer" style={{ flex: 1 }} />
        <button className="btn ghost sm" onClick={() => { setAdding(true); setOpen(null) }} disabled={adding}>{Ico.plus} Add a rule</button>
      </div>
      <div style={{ padding: '12px 18px 18px' }}>
        <p className="mr-hint">
          A rule chooses a policy for every title whose metadata, tags, collections or source meet its conditions, for example <i>Competition is EPL</i>.
          The first rule a title meets applies, so the order matters: drag a rule, or use its arrows, to move it.
          A rule wins over the content type and over the channel, event or station a title came from; a title's own settings still win over the rule, and a field locked on the account default stays locked.
        </p>
        {err && <div className="pol-msg block">{err}</div>}
        {rules && rules.length === 0 && !adding && <div style={{ color: 'var(--faint)', fontSize: 'var(--fs-sm)' }}>No metadata rules yet. Titles get the account default, then their content type's rule, then their channel's, event's or station's.</div>}
        <ol className="mr-list" aria-label="Metadata rules, first checked first">
          {(rules ?? []).map((r, i) => {
            const said = statedIds(r.settings ?? {}).map(id => SECTION_FIELD_LABEL[id] ?? KEY_NAMES[id] ?? id)
            return (
              <li key={r.id} className={`mr-row${open === r.id ? ' open' : ''}${dragOver === i ? ' over' : ''}${r.enabled ? '' : ' off'}`} data-rule-name={r.name}
                draggable onDragStart={e => { dragFrom.current = i; e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', r.id) }}
                onDragOver={e => { e.preventDefault(); setDragOver(i) }} onDragLeave={() => setDragOver(d => (d === i ? null : d))}
                onDrop={e => { e.preventDefault(); setDragOver(null); if (dragFrom.current !== null) move(dragFrom.current, i); dragFrom.current = null }}
                onDragEnd={() => { setDragOver(null); dragFrom.current = null }}>
                <div className="mr-head">
                  <span className="mr-grip" title="Drag to change the order" aria-hidden>{Ico.grip}</span>
                  <span className="mr-pos" aria-label={`Rule ${i + 1}`}>{i + 1}</span>
                  <button type="button" className="mr-open" aria-expanded={open === r.id} onClick={() => { setOpen(o => (o === r.id ? null : r.id)); setAdding(false) }}>
                    <b>{r.name}</b>
                    <span className="mr-when">{summary(r.conditions, cat)}</span>
                    <span className="mr-sets">sets {said.length ? said.join(', ') : 'nothing yet'}{r.locked_fields?.length ? ` · ${r.locked_fields.length} locked` : ''}</span>
                  </button>
                  <span className="mr-meta">
                    {!r.enabled && <span className="mr-badge">Off</span>}
                    <span className="mr-count" title="Titles this rule governs now">{r.titles ?? 0} title{r.titles === 1 ? '' : 's'}</span>
                    <button type="button" className="fast-ico" aria-label={`Move ${r.name} up`} disabled={i === 0} onClick={() => move(i, i - 1)}>{Ico.up}</button>
                    <button type="button" className="fast-ico" aria-label={`Move ${r.name} down`} disabled={i === rules!.length - 1} onClick={() => move(i, i + 1)}>{Ico.down}</button>
                  </span>
                </div>
                {open === r.id && <RuleBody key={r.id} rule={r} cat={cat} onChanged={load} onRemoved={() => { setOpen(null); load() }} />}
              </li>)
          })}
        </ol>
        {adding && <NewRule cat={cat} onCancel={() => setAdding(false)} onCreated={(r) => { setAdding(false); setOpen(r.id); load() }} />}
        <TestBox rules={rules ?? []} />
      </div>
    </div>)
}

/** Name, conditions and on or off of one rule, then its policy. */
function RuleBody({ rule, cat, onChanged, onRemoved }: { rule: MetadataRule; cat: Catalogue | null; onChanged: () => void; onRemoved: () => void }) {
  const notify = useNotify()
  const [name, setName] = useState(rule.name)
  const [cond, setCond] = useState<Group>(rule.conditions as Group)
  const [enabled, setEnabled] = useState(rule.enabled)
  const [busy, setBusy] = useState(false)
  const [sure, setSure] = useState(false)
  const dirty = name !== rule.name || enabled !== rule.enabled || JSON.stringify(cond) !== JSON.stringify(rule.conditions)
  const ready = !!name.trim() && !!cat && allComplete(cond, cat)
  async function save() {
    setBusy(true)
    try { await metadataRulesApi.update(rule.id, { name: name.trim(), conditions: cond, enabled }); onChanged(); notify({ kind: 'ok', message: `${name.trim()} saved. Published titles take it up within a minute.` }) }
    catch (e: any) { notify({ kind: 'error', title: "Couldn't save the rule.", message: e.message }) } finally { setBusy(false) }
  }
  async function remove() {
    setBusy(true)
    try { await metadataRulesApi.remove(rule.id); notify({ kind: 'ok', message: `${rule.name} removed. Its titles go to the next rule they meet, or to the rules beneath.` }); onRemoved() }
    catch (e: any) { notify({ kind: 'error', title: "Couldn't remove the rule.", message: e.message }); setBusy(false) }
  }
  return (
    <div className="mr-body">
      <div className="mr-fields">
        <label className="mr-name">Name<input className="inp" value={name} maxLength={120} onChange={e => setName(e.target.value)} /></label>
        <label className="fast-mini"><input type="checkbox" checked={enabled} onChange={e => setEnabled(e.target.checked)} /> On</label>
      </div>
      <div className="sec-label" style={{ marginTop: 12 }}>When a title meets</div>
      {cat ? <GroupBox g={cond} cat={cat} depth={1} path={`mr-${rule.id}`} onChange={setCond} /> : <div className="loading">Loading fields…</div>}
      <div className="mr-foot">
        <button className="btn primary" disabled={!dirty || !ready || busy} onClick={save}>Save name and conditions</button>
        {sure
          ? <><span style={{ fontSize: 'var(--fs-sm)' }}>Remove {rule.name}?</span><button className="btn ghost sm" style={{ color: 'var(--down)', borderColor: 'var(--down)' }} disabled={busy} onClick={remove}>Remove</button><button className="btn ghost sm" onClick={() => setSure(false)}>Keep it</button></>
          : <button className="btn ghost" onClick={() => setSure(true)}>Remove this rule</button>}
      </div>
      <div className="sec-label" style={{ marginTop: 16 }}>It gets this policy</div>
      <RuleEditor scopeKind="metadata" scopeId={rule.id} resolveQuery={{}} compact onSaved={onChanged} />
    </div>)
}

function NewRule({ cat, onCancel, onCreated }: { cat: Catalogue | null; onCancel: () => void; onCreated: (r: MetadataRule) => void }) {
  const notify = useNotify()
  const [name, setName] = useState('')
  const [cond, setCond] = useState<Group | null>(null)
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    if (cat && !cond) {
      // Start on the first content type field when there is one: rules are mostly about metadata.
      const f = cat.fields.find(x => x.key.startsWith('meta:')) ?? cat.fields[0]; const o = cat.operators[f.type][0]
      setCond({ match: 'all', conditions: [{ field: f.key, op: o.op, value: blankValue(f, o) }] })
    }
  }, [cat])
  const ready = !!name.trim() && !!cat && !!cond && allComplete(cond, cat)
  async function create() {
    setBusy(true)
    try { const r = await metadataRulesApi.create({ name: name.trim(), conditions: cond! }); notify({ kind: 'ok', message: `${r.name} added as rule ${r.position + 1}. Now choose what it sets.` }); onCreated(r) }
    catch (e: any) { notify({ kind: 'error', title: "Couldn't add the rule.", message: e.message }) } finally { setBusy(false) }
  }
  return (
    <div className="mr-body mr-new" data-new-rule>
      <div className="sec-label">New rule</div>
      <label className="mr-name">Name<input className="inp" value={name} maxLength={120} placeholder="For example EPL matches" onChange={e => setName(e.target.value)} autoFocus /></label>
      <div className="sec-label" style={{ marginTop: 12 }}>When a title meets</div>
      {cat && cond ? <GroupBox g={cond} cat={cat} depth={1} path="mr-new" onChange={setCond} /> : <div className="loading">Loading fields…</div>}
      <div className="mr-foot">
        <button className="btn primary" disabled={!ready || busy} onClick={create}>{Ico.plus} Add the rule</button>
        <button className="btn ghost" onClick={onCancel}>Cancel</button>
        <span style={{ color: 'var(--muted)', fontSize: 'var(--fs-sm)' }}>It goes last; you choose its policy next.</span>
      </div>
    </div>)
}

/** Paste a title's id: which rule it meets first, and which others it meets too. */
function TestBox({ rules }: { rules: MetadataRule[] }) {
  const [id, setId] = useState('')
  const [out, setOut] = useState<MetaTest | null>(null)
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  const order = useMemo(() => rules.map(r => r.id).join(), [rules])
  useEffect(() => { setOut(null) }, [order])
  async function run() {
    setBusy(true); setErr('')
    try { setOut(await metadataRulesApi.test(id.trim())) } catch (e: any) { setOut(null); setErr(e.message) } finally { setBusy(false) }
  }
  const geo = out?.resolved.settings.geo
  return (
    <div className="mr-test" data-rule-test>
      <div className="sec-label" style={{ margin: 0 }}>Test a title</div>
      <form className="mr-test-row" onSubmit={e => { e.preventDefault(); if (id.trim()) run() }}>
        <input className="inp" aria-label="Title id" placeholder="Paste a title's id (from its page in the Media Library)" value={id} onChange={e => setId(e.target.value)} />
        <button className="btn ghost" type="submit" disabled={!id.trim() || busy}>{Ico.test} Test</button>
      </form>
      {err && <div className="pol-msg block">{err}</div>}
      {out && (
        <div className="mr-test-out" aria-live="polite" data-test-result={out.matched?.name ?? ''}>
          <div><b>{out.asset.title ?? out.asset.id}</b>{' '}
            {out.matched ? <>meets rule {out.matched.position}, <b>{out.matched.name}</b>: that rule applies.</> : <>meets no metadata rule: its content type and channel, event or station rules decide.</>}
          </div>
          {out.rules.length > 0 && <ul className="mr-test-list">
            {out.rules.map((r, i) => <li key={r.id} className={r.matches ? 'yes' : 'no'}>{r.matches ? Ico.yes : Ico.no}<span>{i + 1}. {r.name}{!r.enabled && ' (off)'}{r.matches && out.matched?.id !== r.id && r.enabled ? ': also met, but an earlier rule applies' : ''}</span></li>)}
          </ul>}
          <div className="mr-test-got">It gets: {geo?.mode === 'worldwide' ? 'worldwide' : `${geo?.mode === 'allow' ? 'only in' : 'not in'} ${(geo?.countries ?? []).join(', ')}`}, {({ free: 'free to watch', entitled: 'entitlement required', paid: 'paid' } as Record<string, string>)[out.resolved.settings.access] ?? out.resolved.settings.access}{out.resolved.settings.protection?.drm ? ', DRM' : ''}{out.resolved.settings.distribution?.shareLinks === false ? ', no share links' : ''}.</div>
        </div>)}
    </div>)
}
