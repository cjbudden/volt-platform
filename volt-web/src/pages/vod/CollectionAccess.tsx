// ============================================================================
//  ACCESS ON A COLLECTION (build queue C2-2; the model and the API are C2,
//  volt-app services/collectionAccess.ts and modules/collections.ts).
//
//    Access                                   [x] Set access here
//      From Sport (parent): premium in GB, IE
//      Apps         (o) All apps  ( ) Chosen apps   [Web] [Phone] [TV: rights keep all 4 out]
//      Territories  Everywhere | Only in ... | Everywhere except ...
//      Region rules GB, IE  Premium  products: Sport monthly 9.99 GBP (Phone: its own)
//                   Everywhere else  Free
//    View as                                  app, country, viewer
//      4 play · 2 locked · 1 blocked by rights, title by title, who decided
//      the matrix: apps down, regions across, what an anonymous viewer gets
//
//  A child shows what it inherits and can only tighten it: the API refuses a
//  looser save (422 looser_than_parent) and the reasons are shown as sent.
//  Apps the rights of every title here keep out are greyed with the reason.
// ============================================================================
import { useEffect, useMemo, useState } from 'react'
import { apiRequest } from '../../api'
import { useNotify } from '../../notices'

type Access = 'free' | 'members' | 'premium'
interface Term { productKey: string; kind: 'period' | 'published_dates'; count?: number; unit?: 'day' | 'week' | 'month' | 'year'; priceCents: number; currency: string; name?: string }
interface Rule { id?: string; countries: string[]; access: Access; terms?: Term[]; appTerms?: Record<string, Term[]> }
export interface AccessDef { apps: 'all' | string[]; territories: { mode: 'world' | 'allow' | 'block'; countries: string[] }; rules: Rule[] }
interface AppRow { id: string; name: string; type: string; ruledOut: { count: number; of: number; titles: string[] } }
interface AccessInfo { id: string; access: AccessDef | null; inherits: boolean; ancestors: { id: string; name: string; access: AccessDef }[]; default: AccessDef; apps: AppRow[]; items: number
  /** Countries the access governing the titles here names, their other collections' included (C2-3). */
  titleRegions?: string[] }
type Outcome = 'plays' | 'sign_in' | 'locked' | 'blocked_by_rights'
interface Pkg { id: string; name: string }
interface Decided { id: string; name: string; access: Access }
interface ViewItem { assetId: string; title: string | null; outcome: Outcome; access: Access; reason?: string; packages: Pkg[]; products?: Term[]; decidedBy: Decided[]
  /** Another collection locks it here more strictly than this one (C2-3); leftOut: the rules put it here, so it is left out for this app and region. */
  lockedBy?: { access: Access; packages: Pkg[]; decidedBy: Decided[] }; leftOut?: boolean }
interface ViewAs { counts: Partial<Record<Outcome, number>>; leftOut?: { count: number; reason: string | null }; items: ViewItem[] }
interface AssetAccess { assetId: string; apps: { id: string; name: string }[]; regions: string[]; packages: Pkg[]; result: ViewItem
  collections: { id: string; name: string; hasRules: boolean; source: 'rule' | 'manual'; asks: { id: string; name: string; rules: { countries: string[]; access: Access }[] }[] }[] }

const J = (b: unknown) => ({ body: JSON.stringify(b) })
const qs = (q: Record<string, string | undefined>) => new URLSearchParams(Object.entries(q).filter(([, v]) => v) as [string, string][]).toString()
export const accessApi = {
  get: (id: string): Promise<AccessInfo> => apiRequest(`/collections/${id}/access`),
  save: (id: string, access: AccessDef | null): Promise<{ products: number; queued: number }> => apiRequest(`/collections/${id}/access`, { method: 'PUT', ...J({ access }) }),
  viewAs: (id: string, q: { appId?: string; country?: string; viewer?: string; packageId?: string }): Promise<ViewAs> =>
    apiRequest(`/collections/${id}/access/view-as?${qs(q)}`),
  asset: (assetId: string, q: { appId?: string; country?: string; viewer?: string; packageId?: string }): Promise<AssetAccess> =>
    apiRequest(`/collections/asset-access/${assetId}?${qs(q)}`),
}

const ACCESS_LABEL: Record<Access, string> = { free: 'Free', members: 'Members (signed in)', premium: 'Premium (a package)' }
const OUTCOME: Record<Outcome, { label: string; cls: string }> = {
  plays: { label: 'Plays', cls: 'live' }, sign_in: { label: 'Sign in', cls: 'sched' }, locked: { label: 'Locked', cls: 'warn' }, blocked_by_rights: { label: 'Blocked by rights', cls: 'down' },
}
const Icon = {
  lock: <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><rect x="5" y="11" width="14" height="10" rx="2" /><path d="M8 11V7a4 4 0 0 1 8 0v4" /></svg>,
  eye: <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z" /><circle cx="12" cy="12" r="3" /></svg>,
  plus: <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.4" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg>,
  x: <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2.4" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18" /></svg>,
}
const money = (t: Term) => `${(t.priceCents / 100).toFixed(2)} ${t.currency}`
const per = (t: Term) => t.kind === 'published_dates' ? 'for the published dates' : `per ${t.count && t.count > 1 ? `${t.count} ${t.unit}s` : t.unit}`
const where = (cs: string[]) => cs.includes('WORLD') ? 'everywhere else' : cs.join(', ')

/** One line a person can read: what a collection's access asks, where. */
export function describeAccess(a: AccessDef | null, apps: { id: string; name: string }[]): string {
  if (!a) return 'All apps, Global, All access'
  const scope = [a.apps === 'all' ? 'all apps' : a.apps.map((id) => apps.find((x) => x.id === id)?.name ?? 'an app').join(', '),
    a.territories.mode === 'world' ? null : a.territories.mode === 'allow' ? `only in ${a.territories.countries.join(', ')}` : `not in ${a.territories.countries.join(', ')}`].filter(Boolean).join(', ')
  const rules = a.rules.length ? a.rules.map((r) => `${r.access} in ${where(r.countries)}`).join('; ') : 'free everywhere'
  return `${rules[0].toUpperCase()}${rules.slice(1)} (${scope})`
}

const blankTerm = (): Term => ({ productKey: '', name: '', kind: 'period', count: 1, unit: 'month', priceCents: 0, currency: 'GBP' })

export function CollectionAccessCard({ collectionId, collectionName }: { collectionId: string; collectionName: string }) {
  const notify = useNotify()
  const [info, setInfo] = useState<AccessInfo | null>(null)
  const [on, setOn] = useState(false)
  const [draft, setDraft] = useState<AccessDef | null>(null)
  const [problems, setProblems] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const [rev, setRev] = useState(0)
  const load = () => accessApi.get(collectionId).then((r) => {
    setInfo(r); setOn(!!r.access); setDraft(r.access ?? structuredClone(r.default)); setProblems([])
  }).catch((e: any) => notify({ kind: 'error', title: "Couldn't load the access.", message: e.message }))
  useEffect(() => { load() }, [collectionId])

  if (!info || !draft) return <div className="card"><div className="card-h"><h3 style={{ display: 'flex', alignItems: 'center', gap: 8 }}>{Icon.lock} Access</h3></div><div className="card-b loading">Loading…</div></div>
  const dirty = JSON.stringify(on ? draft : null) !== JSON.stringify(info.access)
  const set = (p: Partial<AccessDef>) => setDraft({ ...draft, ...p })
  const setRule = (i: number, r: Rule | null) => set({ rules: r ? draft.rules.map((x, k) => k === i ? r : x) : draft.rules.filter((_, k) => k !== i) })
  const appName = (id: string) => info.apps.find((a) => a.id === id)?.name ?? 'An app'
  const scopeApps = draft.apps === 'all' ? info.apps : info.apps.filter((a) => (draft.apps as string[]).includes(a.id))

  async function save() {
    setBusy(true); setProblems([])
    try {
      const r = await accessApi.save(collectionId, on ? draft : null)
      notify({ kind: 'ok', message: on ? `Access saved. ${r.queued} title${r.queued === 1 ? '' : 's'} here and in sub-collections follow it now.` : 'Access cleared. The collection asks nothing of its titles now (beyond what it inherits).' })
      await load(); setRev((x) => x + 1)
    } catch (e: any) {
      setProblems(e.body?.problems ?? [e.message])
      notify({ kind: 'error', title: "Couldn't save the access.", message: e.message })
    } finally { setBusy(false) }
  }

  return (
    <>
      <div className="card">
        <div className="card-h" style={{ flexWrap: 'wrap', gap: 10 }}>
          <h3 style={{ display: 'flex', alignItems: 'center', gap: 8 }}>{Icon.lock} Access</h3>
          <span className="sub">{info.access ? describeAccess(info.access, info.apps) : info.ancestors.length ? `Inherits from ${info.ancestors.map((a) => a.name).join(' / ')}` : 'All apps, Global, All access'}</span>
          <span className="spacer" />
          <label className="fast-mini"><input type="checkbox" checked={on} onChange={(e) => setOn(e.target.checked)} /> Set access here</label>
        </div>
        {info.ancestors.length > 0 && (
          <div className="card-b cax-inh">
            <div className="hintxt" style={{ margin: 0 }}>Inherited. What you set here can only ask more than this, never less.</div>
            {info.ancestors.map((a) => <div key={a.id} className="cax-inh-row"><b>From {a.name}</b><span>{describeAccess(a.access, info.apps)}</span></div>)}
          </div>
        )}
        {on && (
          <div className="card-b cax">
            <span className="cax-l">Apps</span>
            <div className="cax-f">
              <div className="cax-seg" role="radiogroup" aria-label="Apps">
                <label><input type="radio" name={`apps-${collectionId}`} checked={draft.apps === 'all'} onChange={() => set({ apps: 'all' })} /> All apps</label>
                <label><input type="radio" name={`apps-${collectionId}`} checked={draft.apps !== 'all'} onChange={() => set({ apps: info.apps.filter((a) => !(a.ruledOut.of && a.ruledOut.count === a.ruledOut.of)).map((a) => a.id).slice(0, 1) })} /> Chosen apps</label>
              </div>
              <div className="cax-apps">
                {info.apps.map((a) => {
                  const all = a.ruledOut.of > 0 && a.ruledOut.count === a.ruledOut.of
                  const chosen = draft.apps === 'all' || draft.apps.includes(a.id)
                  const why = all ? `The rights of ${a.ruledOut.of === 1 ? 'its one title' : `all ${a.ruledOut.of} titles`} here keep ${a.ruledOut.of === 1 ? 'it' : 'them'} out of this app.`
                    : a.ruledOut.count ? `The rights keep ${a.ruledOut.count} of ${a.ruledOut.of} titles out of this app (${a.ruledOut.titles.join(', ')}${a.ruledOut.count > a.ruledOut.titles.length ? ', …' : ''}). They stay blocked there.` : null
                  return (
                    <label key={a.id} className={`cax-app${all ? ' off' : ''}`} title={why ?? undefined}>
                      <input type="checkbox" disabled={draft.apps === 'all' || (all && !chosen)} checked={chosen}
                        onChange={(e) => { const cur = draft.apps === 'all' ? [] : draft.apps; set({ apps: e.target.checked ? [...cur, a.id] : cur.filter((x) => x !== a.id) }) }} />
                      <span><b>{a.name}</b> <span className="cax-dim">{a.type}</span>{why && <span className={`cax-why${all ? ' bad' : ''}`}>{why}</span>}</span>
                    </label>)
                })}
                {!info.apps.length && <span className="hintxt" style={{ margin: 0 }}>This account has no apps yet. Access applies to every app you add.</span>}
              </div>
            </div>

            <span className="cax-l">Territories</span>
            <div className="cax-f">
              <select className="inp" aria-label="Where it applies" style={{ maxWidth: 260 }} value={draft.territories.mode}
                onChange={(e) => set({ territories: { mode: e.target.value as any, countries: e.target.value === 'world' ? [] : draft.territories.countries } })}>
                <option value="world">Everywhere (Global)</option><option value="allow">Only in these territories</option><option value="block">Everywhere except these</option>
              </select>
              {draft.territories.mode !== 'world' && <Countries label="Territories" value={draft.territories.countries} onChange={(c) => set({ territories: { ...draft.territories, countries: c } })} />}
              <span className="hintxt" style={{ margin: 0 }}>Outside these apps and territories the collection asks nothing of its titles.</span>
            </div>

            <span className="cax-l">Region rules</span>
            <div className="cax-f">
              <span className="hintxt" style={{ margin: 0 }}>The first rule naming the viewer's country decides. With no rule, titles here are free.</span>
              {draft.rules.map((r, i) => (
                <div key={i} className="cax-rule">
                  <div className="cax-rule-h">
                    <span className="cax-n">{i + 1}</span>
                    <label className="fast-mini"><input type="checkbox" checked={r.countries.includes('WORLD')} onChange={(e) => setRule(i, { ...r, countries: e.target.checked ? ['WORLD'] : [] })} /> Everywhere else</label>
                    {!r.countries.includes('WORLD') && <Countries label={`Rule ${i + 1} countries`} value={r.countries} onChange={(c) => setRule(i, { ...r, countries: c })} />}
                    <select className="inp" aria-label={`Rule ${i + 1} access`} style={{ width: 'auto' }} value={r.access}
                      onChange={(e) => { const access = e.target.value as Access; setRule(i, access === 'premium' ? { ...r, access, terms: r.terms?.length ? r.terms : [blankTerm()] } : { id: r.id, countries: r.countries, access }) }}>
                      {(['free', 'members', 'premium'] as Access[]).map((x) => <option key={x} value={x}>{ACCESS_LABEL[x]}</option>)}
                    </select>
                    <span className="spacer" />
                    <button type="button" className="fast-ico" aria-label={`Remove rule ${i + 1}`} onClick={() => setRule(i, null)}>{Icon.x}</button>
                  </div>
                  {r.access === 'premium' && <>
                    <Terms label="Package products, in every app" terms={r.terms ?? []} onChange={(t) => setRule(i, { ...r, terms: t })} />
                    {Object.entries(r.appTerms ?? {}).map(([appId, t]) => (
                      <Terms key={appId} label={`${appName(appId)}: its own products and store prices`} terms={t}
                        onChange={(nt) => setRule(i, { ...r, appTerms: { ...r.appTerms, [appId]: nt } })}
                        onRemove={() => { const { [appId]: _, ...rest } = r.appTerms ?? {}; setRule(i, { ...r, appTerms: rest }) }} />))}
                    {scopeApps.some((a) => !r.appTerms?.[a.id]) && (
                      <select className="inp" aria-label="Own prices in an app" style={{ width: 'auto', alignSelf: 'flex-start' }} value=""
                        onChange={(e) => e.target.value && setRule(i, { ...r, appTerms: { ...r.appTerms, [e.target.value]: [blankTerm()] } })}>
                        <option value="">Own prices in an app…</option>
                        {scopeApps.filter((a) => !r.appTerms?.[a.id]).map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
                      </select>)}
                  </>}
                </div>))}
              <div><button type="button" className="btn ghost sm" onClick={() => set({ rules: [...draft.rules, { countries: draft.rules.some((r) => r.countries.includes('WORLD')) ? [] : ['WORLD'], access: 'members' }] })}>{Icon.plus} Region rule</button></div>
            </div>
          </div>
        )}
        {problems.length > 0 && <div className="card-b"><ul className="cax-problems" role="alert">{problems.map((p, i) => <li key={i}>{p}</li>)}</ul></div>}
        {(dirty || on !== !!info.access) && (
          <div className="card-b crb-foot">
            <span className="hintxt" style={{ margin: 0 }}>{info.items} title{info.items === 1 ? '' : 's'} here and in sub-collections follow{info.items === 1 ? 's' : ''} this when you save.</span>
            <span className="spacer" />
            <button type="button" className="btn ghost sm" onClick={() => { setOn(!!info.access); setDraft(info.access ?? structuredClone(info.default)); setProblems([]) }}>Cancel</button>
            <button type="button" className="btn primary sm" disabled={busy} onClick={save}>{busy ? 'Saving…' : on ? 'Save access' : 'Clear access'}</button>
          </div>)}
      </div>
      <ViewAsCard collectionId={collectionId} collectionName={collectionName} info={info} rev={rev} />
    </>)
}

/** Two-letter country codes as chips. */
function Countries({ value, onChange, label }: { value: string[]; onChange: (v: string[]) => void; label: string }) {
  const [text, setText] = useState('')
  const add = (raw: string) => {
    const codes = raw.toUpperCase().split(/[\s,]+/).filter((c) => /^[A-Z]{2}$/.test(c) && !value.includes(c))
    if (codes.length) onChange([...value, ...codes]); setText('')
  }
  return (
    <span className="crb-val crb-chips">
      {value.map((c) => <span key={c} className="crb-chip">{c}<button type="button" aria-label={`Remove ${c}`} onClick={() => onChange(value.filter((x) => x !== c))}>{Icon.x}</button></span>)}
      <input className="inp" aria-label={`Add to ${label}`} placeholder={value.length ? 'Add, e.g. FR' : 'Country codes, e.g. GB, IE'} style={{ width: 170, minWidth: 0 }} value={text}
        onChange={(e) => setText(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); add(text) } }} onBlur={() => text && add(text)} />
    </span>)
}

/** A package's products: name, key, period, price. */
function Terms({ label, terms, onChange, onRemove }: { label: string; terms: Term[]; onChange: (t: Term[]) => void; onRemove?: () => void }) {
  const up = (i: number, p: Partial<Term>) => onChange(terms.map((t, k) => k === i ? { ...t, ...p } : t))
  return (
    <div className="cax-terms">
      <div className="cax-terms-h"><span>{label}</span>{onRemove && <button type="button" className="btn ghost sm" onClick={onRemove}>Use the package's products</button>}</div>
      {terms.map((t, i) => (
        <div key={i} className="cax-term">
          <input className="inp" aria-label="Product name" placeholder="Name, e.g. Sport monthly" value={t.name ?? ''} onChange={(e) => up(i, { name: e.target.value })} />
          <input className="inp" aria-label="Product key" placeholder="Key, e.g. sport.monthly" value={t.productKey} onChange={(e) => up(i, { productKey: e.target.value.trim() })} />
          <select className="inp" aria-label="Period" value={t.kind === 'published_dates' ? 'dates' : t.unit} onChange={(e) => up(i, e.target.value === 'dates' ? { kind: 'published_dates', count: undefined, unit: undefined } : { kind: 'period', count: t.count ?? 1, unit: e.target.value as any })}>
            <option value="day">per day</option><option value="week">per week</option><option value="month">per month</option><option value="year">per year</option><option value="dates">for the published dates</option>
          </select>
          <input className="inp" aria-label="Price" type="number" min={0} step="0.01" style={{ width: 100 }} value={(t.priceCents / 100).toString()} onChange={(e) => up(i, { priceCents: Math.round(Number(e.target.value || 0) * 100) })} />
          <input className="inp" aria-label="Currency" maxLength={3} style={{ width: 70 }} value={t.currency} onChange={(e) => up(i, { currency: e.target.value.toUpperCase() })} />
          <button type="button" className="fast-ico" aria-label={`Remove product ${i + 1}`} disabled={terms.length === 1} onClick={() => onChange(terms.filter((_, k) => k !== i))}>{Icon.x}</button>
        </div>))}
      <div><button type="button" className="btn ghost sm" onClick={() => onChange([...terms, blankTerm()])}>{Icon.plus} Product</button></div>
    </div>)
}

/**
 * VIEW AS: what a viewer gets, title by title, in an app and a country, and
 * the matrix of apps by regions (an anonymous viewer, counts per cell). Both
 * read GET /collections/:id/access/view-as, the same answer the play gate gives.
 */
function ViewAsCard({ collectionId, collectionName, info, rev }: { collectionId: string; collectionName: string; info: AccessInfo; rev: number }) {
  const notify = useNotify()
  const packages = useMemo(() => [...info.ancestors.map((a) => ({ id: a.id, name: a.name, access: a.access })), ...(info.access ? [{ id: collectionId, name: collectionName, access: info.access }] : [])]
    .filter((p) => p.access.rules.some((r) => r.access === 'premium')), [info, collectionId, collectionName])
  const regions = useMemo(() => {
    const named = [...new Set([...[...info.ancestors.map((a) => a.access), ...(info.access ? [info.access] : [])].flatMap((a) => [...a.rules.flatMap((r) => r.countries), ...a.territories.countries]), ...(info.titleRegions ?? [])])].filter((c) => c !== 'WORLD')
    const elsewhere = ['US', 'FR', 'DE', 'JP', 'BR'].find((c) => !named.includes(c)) ?? 'US'
    return [...named.slice(0, 5), elsewhere]
  }, [info])
  const [appId, setAppId] = useState(info.apps[0]?.id ?? '')
  const [country, setCountry] = useState(regions[0] ?? 'GB')
  const [viewer, setViewer] = useState('anonymous')
  const [pkg, setPkg] = useState(packages[0]?.id ?? '')
  const [ans, setAns] = useState<ViewAs | null>(null)
  const [matrix, setMatrix] = useState<Record<string, ViewAs['counts'] & { left_out?: number }> | null>(null)
  useEffect(() => {
    if (!/^[A-Za-z]{2}$/.test(country)) return
    setAns(null)
    accessApi.viewAs(collectionId, { appId, country, viewer, packageId: viewer === 'package' ? pkg : undefined }).then(setAns).catch((e: any) => notify({ kind: 'error', message: e.message }))
  }, [collectionId, appId, country, viewer, pkg, rev])
  useEffect(() => {
    let live = true; setMatrix(null)
    const apps = info.apps.length ? info.apps : [{ id: '', name: 'Any app' } as AppRow]
    Promise.all(apps.flatMap((a) => regions.map((c) => accessApi.viewAs(collectionId, { appId: a.id, country: c }).then((r) => [`${a.id}|${c}`, { ...r.counts, left_out: r.leftOut?.count || undefined }] as const))))
      .then((cells) => { if (live) setMatrix(Object.fromEntries(cells)) }).catch(() => { if (live) setMatrix({}) })
    return () => { live = false }
  }, [collectionId, rev, regions.join(), info.apps.length])

  return (
    <div className="card">
      <div className="card-h" style={{ flexWrap: 'wrap', gap: 10 }}>
        <h3 style={{ display: 'flex', alignItems: 'center', gap: 8 }}>{Icon.eye} View as</h3>
        <span className="sub">What a viewer gets for each title here, by the same rules the player uses</span>
      </div>
      <div className="card-b cax-va">
        <select className="inp" aria-label="App" value={appId} onChange={(e) => setAppId(e.target.value)}>
          {!info.apps.length && <option value="">Any app</option>}
          {info.apps.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
        </select>
        <input className="inp" aria-label="Country" maxLength={2} style={{ width: 70 }} value={country} onChange={(e) => setCountry(e.target.value.toUpperCase())} />
        <select className="inp" aria-label="Viewer" value={viewer} onChange={(e) => setViewer(e.target.value)}>
          <option value="anonymous">Not signed in</option><option value="member">Signed in</option>
          {packages.length > 0 && <option value="package">Holding a package</option>}
        </select>
        {viewer === 'package' && <select className="inp" aria-label="Package" value={pkg} onChange={(e) => setPkg(e.target.value)}>{packages.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select>}
      </div>
      <div className="card-b" style={{ paddingTop: 0 }}>
        {!ans ? <div className="loading">Checking…</div> : <>
          <div className="cax-counts">{(Object.keys(OUTCOME) as Outcome[]).filter((o) => ans.counts[o]).map((o) => <span key={o} className={`tag ${OUTCOME[o].cls}`}>{ans.counts[o]} {OUTCOME[o].label.toLowerCase()}</span>)}
            {!!ans.leftOut?.count && <span className="tag">{ans.leftOut.count} left out</span>}
            {!ans.items.length && <span className="hintxt" style={{ margin: 0 }}>No titles here yet.</span>}</div>
          {ans.leftOut?.reason && <div className="cax-left">{Icon.lock}<span>{ans.leftOut.reason}</span></div>}
          {ans.items.map((it) => (
            <div key={it.assetId} className="cax-item">
              <span className="t">{it.title || 'Untitled'}</span>
              <span className="cax-tags">{it.leftOut && <span className="tag" title="The rules put it here, but a stricter collection locks it in this app and region">Left out</span>}
                <span className={`tag ${OUTCOME[it.outcome].cls}`}>{OUTCOME[it.outcome].label}</span></span>
              <span className="cax-dim cax-why2">
                {it.lockedBy && <span className="cax-gov">{Icon.lock} {it.leftOut ? 'Left out here: locked' : 'Kept here, locked'} by {it.lockedBy.packages.length ? it.lockedBy.packages.map((p) => p.name).join(' or ') : it.lockedBy.decidedBy.map((d) => d.name).join(', ')} ({it.lockedBy.access}).</span>}
                {it.outcome === 'blocked_by_rights' ? (it.reason ?? 'The rights do not allow the access a collection asks for here.')
                  : it.outcome === 'locked' ? `Unlocked by ${it.packages.map((p) => p.name).join(' or ')}${it.products?.length ? `: ${it.products.map((t) => `${t.name || t.productKey} ${money(t)} ${per(t)}`).join(', ')}` : ''}`
                  : it.decidedBy.length ? `Decided by ${it.decidedBy.map((d) => `${d.name} (${d.access})`).join(', ')}` : 'No collection asks anything of it here'}
              </span>
            </div>))}
        </>}
      </div>
      <div className="card-b" style={{ borderTop: '1px solid var(--border)' }}>
        <div className="hintxt" style={{ marginTop: 0 }}>Apps by region, for a viewer who is not signed in. {regions[regions.length - 1]} stands for everywhere no rule names.</div>
        {!matrix ? <div className="loading">Building…</div> : (
          <div className="cax-mx-wrap">
            <table className="cax-mx">
              <thead><tr><th scope="col">App</th>{regions.map((c) => <th key={c} scope="col">{c}</th>)}</tr></thead>
              <tbody>{(info.apps.length ? info.apps : [{ id: '', name: 'Any app' } as AppRow]).map((a) => (
                <tr key={a.id}><th scope="row">{a.name}</th>{regions.map((c) => {
                  const k = matrix[`${a.id}|${c}`] ?? {}
                  return <td key={c}><span className="cax-cell">{(Object.keys(OUTCOME) as Outcome[]).filter((o) => k[o]).map((o) => <span key={o} className={`tag ${OUTCOME[o].cls}`} title={OUTCOME[o].label}>{k[o]} {OUTCOME[o].label.toLowerCase()}</span>)}
                    {!!k.left_out && <span className="tag" title="Locked by a stricter collection, so this rule collection leaves them out here">{k.left_out} left out</span>}
                    {!Object.keys(k).length && <span className="cax-dim">none</span>}</span></td>
                })}</tr>))}</tbody>
            </table>
          </div>)}
      </div>
    </div>)
}

/**
 * THE ASSET PAGE'S BREAKDOWN (build queue C2-3): the collections a title is
 * in and what each asks, what a viewer gets in an app and a country, and the
 * matrix of apps by regions. Reads GET /collections/asset-access/:assetId,
 * the same evaluation as a collection's View as and the play gate.
 */
export function AssetCollectionAccess({ assetId }: { assetId: string }) {
  const notify = useNotify()
  const [base, setBase] = useState<AssetAccess | null>(null)
  const [appId, setAppId] = useState('')
  const [country, setCountry] = useState('')
  const [viewer, setViewer] = useState('anonymous')
  const [pkg, setPkg] = useState('')
  const [ans, setAns] = useState<AssetAccess | null>(null)
  const [matrix, setMatrix] = useState<Record<string, Outcome> | null>(null)
  useEffect(() => {
    let live = true; setBase(null); setMatrix(null)
    accessApi.asset(assetId, {}).then((b) => {
      if (!live) return
      setBase(b); setAppId(b.apps[0]?.id ?? ''); setCountry(b.regions[0] ?? 'GB'); setPkg(b.packages[0]?.id ?? '')
      const apps = b.apps.length ? b.apps : [{ id: '', name: 'Any app' }]
      Promise.all(apps.flatMap((a) => b.regions.map((c) => accessApi.asset(assetId, { appId: a.id, country: c }).then((r) => [`${a.id}|${c}`, r.result.outcome] as const))))
        .then((cells) => { if (live) setMatrix(Object.fromEntries(cells)) }).catch(() => { if (live) setMatrix({}) })
    }).catch((e: any) => notify({ kind: 'error', message: e.message }))
    return () => { live = false }
  }, [assetId])
  useEffect(() => {
    if (!base || !/^[A-Za-z]{2}$/.test(country)) return
    setAns(null)
    accessApi.asset(assetId, { appId, country, viewer, packageId: viewer === 'package' ? pkg : undefined }).then(setAns).catch((e: any) => notify({ kind: 'error', message: e.message }))
  }, [assetId, base, appId, country, viewer, pkg])

  if (!base) return <div className="card"><div className="card-b loading">Loading collection access…</div></div>
  const apps = base.apps.length ? base.apps : [{ id: '', name: 'Any app' }]
  const it = ans?.result
  return (
    <div className="card cax-asset">
      <div className="card-h" style={{ flexWrap: 'wrap', gap: 10 }}>
        <h3 style={{ display: 'flex', alignItems: 'center', gap: 8 }}>{Icon.lock} Collection access</h3>
        <span className="sub">What its collections ask, by app and region, the way the player decides</span>
      </div>
      <div className="card-b" style={{ paddingTop: 0 }}>
        {!base.collections.length ? <div className="hintxt" style={{ margin: 0 }}>It is in no collection, so no collection asks anything of it.</div> : (
          <div className="cax-cols">{base.collections.map((c) => (
            <div key={c.id} className="cax-col">
              <span className="t">{c.name}</span>
              <span className={`col-src${c.source === 'rule' ? ' rule' : ''}`}>{c.source === 'rule' ? 'Rule' : 'Added'}</span>
              <span className="cax-dim cax-why2">{c.asks.length
                ? c.asks.map((l) => `${l.name}: ${l.rules.length ? l.rules.map((r) => `${r.access} ${r.countries.includes('WORLD') ? 'everywhere else' : `in ${r.countries.join(', ')}`}`).join(', ') : 'free'}`).join(' · ')
                : 'Asks nothing (free)'}</span>
            </div>))}</div>)}
      </div>
      <div className="card-b cax-va" style={{ borderTop: '1px solid var(--border)' }}>
        <select className="inp" aria-label="App" value={appId} onChange={(e) => setAppId(e.target.value)}>
          {apps.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
        </select>
        <input className="inp" aria-label="Country" maxLength={2} style={{ width: 70 }} value={country} onChange={(e) => setCountry(e.target.value.toUpperCase())} />
        <select className="inp" aria-label="Viewer" value={viewer} onChange={(e) => setViewer(e.target.value)}>
          <option value="anonymous">Not signed in</option><option value="member">Signed in</option>
          {base.packages.length > 0 && <option value="package">Holding a package</option>}
        </select>
        {viewer === 'package' && <select className="inp" aria-label="Package" value={pkg} onChange={(e) => setPkg(e.target.value)}>{base.packages.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select>}
      </div>
      <div className="card-b" style={{ paddingTop: 0 }}>
        {!it ? <div className="loading">Checking…</div> : (
          <div className="cax-item" style={{ borderTop: 0 }}>
            <span className="t">{OUTCOME[it.outcome].label}</span>
            <span className={`tag ${OUTCOME[it.outcome].cls}`}>{it.access === 'free' ? 'Free' : ACCESS_LABEL[it.access]}</span>
            <span className="cax-dim cax-why2">
              {it.outcome === 'blocked_by_rights' ? (it.reason ?? 'The rights do not allow the access a collection asks for here.')
                : it.outcome === 'locked' ? `Unlocked by ${it.packages.map((p) => p.name).join(' or ')}${it.products?.length ? `: ${it.products.map((t) => `${t.name || t.productKey} ${money(t)} ${per(t)}`).join(', ')}` : ''}`
                : it.decidedBy.length ? `Decided by ${it.decidedBy.map((d) => `${d.name} (${d.access})`).join(', ')}` : 'No collection asks anything of it here'}
            </span>
          </div>)}
      </div>
      <div className="card-b" style={{ borderTop: '1px solid var(--border)' }}>
        <div className="hintxt" style={{ marginTop: 0 }}>Apps by region, for a viewer who is not signed in. {base.regions[base.regions.length - 1]} stands for everywhere no rule names.</div>
        {!matrix ? <div className="loading">Building…</div> : (
          <div className="cax-mx-wrap">
            <table className="cax-mx">
              <thead><tr><th scope="col">App</th>{base.regions.map((c) => <th key={c} scope="col">{c}</th>)}</tr></thead>
              <tbody>{apps.map((a) => (
                <tr key={a.id}><th scope="row">{a.name}</th>{base.regions.map((c) => {
                  const o = matrix[`${a.id}|${c}`]
                  return <td key={c}>{o ? <span className={`tag ${OUTCOME[o].cls}`}>{OUTCOME[o].label}</span> : <span className="cax-dim">none</span>}</td>
                })}</tr>))}</tbody>
            </table>
          </div>)}
      </div>
    </div>)
}
