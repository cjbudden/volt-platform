// ============================================================================
//  RIGHTS (Admin > Media setup > Rights, build queue R1).
//
//  Every asset carries one rights profile: where it may be shown, on which
//  apps, for which uses, with which access types and inside which window.
//  Collection access and publishing policies only work inside it, and
//  nothing overrides it. Two profiles are built in (No restrictions, All
//  restricted); the account picks which one, or a provider profile, new
//  assets get.
//
//    /rights            the profiles, and the default for new assets
//    /rights/new        a new profile
//    /rights/<id>       one profile: settings, assets, agreement
// ============================================================================
import { useEffect, useMemo, useState } from 'react'
import { api } from '../api'
import { PageHead } from '../scaffold'
import { navigate } from '../router'
import { useAccess } from '../access'
import { usePageNotice, useNotify, FormStatus } from '../notices'
import { ConfirmDialog } from '../listActions'
import { COUNTRIES, countryName, toCountryCode } from '../lib/countries'
import {
  rightsApi, type RightsProfile, type RightsSettings, type ProfileInput, type RightsAppType, type Use, type AccessType, type RightsWindow,
  USE_LABEL, USES, ACCESS_LABEL, ACCESS_TYPES, APP_LABEL, APP_TYPES, appTypeOf, territorySummary, windowSummary, daysLeft,
} from '../rights/rightsApi'
import { AppChip, AppTypeGlyph } from '../rights/RightsIcons'
import '../rights/rights.css'

export default function RightsPage({ path }: { path: string }) {
  const id = path.split('/').filter(Boolean)[1] ?? null
  if (id) return <ProfileEditor key={id} id={id === 'new' ? null : decodeURIComponent(id)} />
  return <RightsList />
}

// ---------------------------------------------------------------------------
//  Where a title cannot play: the block message and Notify me (build queue P2-2)
// ---------------------------------------------------------------------------
function BlockMessageCard({ settings, canEdit, onSaved }: { settings: RightsSettings; canEdit: boolean; onSaved: (s: RightsSettings) => void }) {
  const [msg, setMsg] = useState(settings.blockMessage ?? '')
  const [busy, setBusy] = useState(false)
  const notify = useNotify()
  useEffect(() => { setMsg(settings.blockMessage ?? '') }, [settings.blockMessage])
  const shown = msg.trim() || settings.blockMessageDefault
  const dirty = (msg.trim() || null) !== (settings.blockMessage ?? null)
  async function save(b: { blockMessage?: string | null; notifyMe?: boolean }, done: string) {
    setBusy(true)
    try { onSaved(await rightsApi.setBlock(b)); notify({ kind: 'ok', message: done }) }
    catch (e: any) { notify({ kind: 'error', message: e.message }) }
    finally { setBusy(false) }
  }
  const waiting = settings.notifyRequests
  return (
    <div className="card rt-sec rt-block" style={{ marginTop: 16 }}>
      <div>
        <h2>Where a title cannot play</h2>
        <p className="rt-help">Viewers outside a title's territories, or outside its rights, see it locked with this message instead of a missing title or a broken player. Every Volt player and your own apps get the same words from the play gate.</p>
      </div>
      <div className="rt-block-grid">
        <div className="rt-block-form">
          <label className="rt-block-lbl" htmlFor="rt-block-msg">Message</label>
          <input id="rt-block-msg" className="inp" maxLength={200} disabled={!canEdit || busy} value={msg} placeholder={settings.blockMessageDefault}
            onChange={e => setMsg(e.target.value)} />
          <span className="rt-sub">{msg.trim() ? `${msg.trim().length} of 200 characters` : 'Empty: the default words'}</span>
          <label className="rt-check">
            <input type="checkbox" disabled={!canEdit || busy} checked={settings.notifyMe}
              onChange={e => save({ notifyMe: e.target.checked }, e.target.checked ? 'Players now offer Notify me.' : 'Players no longer offer Notify me.')} />
            <span><b>Offer "Notify me if it becomes available"</b><br /><span className="rt-sub">Viewers leave their email (or are known by their sign-in). They are kept per title below.</span></span>
          </label>
          {canEdit && (
            <div className="rt-block-actions">
              <button className="btn primary" disabled={!dirty || busy} onClick={() => save({ blockMessage: msg.trim() || null }, 'Viewers see the new message from now on.')}>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden><path d="M5 12l5 5L20 7" /></svg>Save message</button>
              {settings.blockMessage && <button className="btn" disabled={busy} onClick={() => save({ blockMessage: null }, 'Back to the default words.')}>Use the default</button>}
            </div>
          )}
        </div>
        <div className="rt-block-preview" aria-label="What a viewer sees">
          <span className="rt-sub">What a viewer sees</span>
          <div className="rt-block-screen">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden><rect x="5" y="11" width="14" height="10" rx="2" /><path d="M8 11V7a4 4 0 0 1 8 0v4" /></svg>
            <b>{shown}</b>
            {settings.notifyMe && <span className="rt-block-btn">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden><path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" /><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" /></svg>Notify me</span>}
          </div>
        </div>
      </div>
      {(settings.notifyMe || waiting.total > 0) && (
        <div className="rt-block-waiting">
          <h3>Waiting to be told <span className="rt-sub">{waiting.total.toLocaleString()} request{waiting.total === 1 ? '' : 's'}</span></h3>
          {waiting.titles.length ? (
            <ul>{waiting.titles.map(t => <li key={t.assetId}><span>{t.title ?? 'A title no longer in the library'}</span><b>{t.count.toLocaleString()}</b></li>)}</ul>
          ) : <p className="rt-help">Nobody yet.</p>}
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
//  The list
// ---------------------------------------------------------------------------
function statusOf(p: RightsProfile): { label: string; color: string } {
  if (p.builtin === 'closed') return { label: 'Held', color: 'var(--idle)' }
  const left = daysLeft(p.window)
  if (left != null && left <= 0) return { label: 'Ended', color: 'var(--down)' }
  if (left != null && left <= Math.max(p.warnDays, 1)) return { label: `Ends in ${left} day${left === 1 ? '' : 's'}`, color: 'var(--warn)' }
  if (!p.builtin && !p.agreement) return { label: 'Agreement missing', color: 'var(--warn)' }
  return { label: 'Active', color: 'var(--live)' }
}

function AppsCell({ p, apps }: { p: RightsProfile; apps: { id: string; name: string }[] }) {
  if (p.builtin === 'closed') return <span className="rt-sub">None</span>
  if (p.appMode === 'all') return <span>All apps</span>
  const named = p.appIds.map(id => apps.find(a => a.id === id)?.name ?? 'App')
  return (
    <div className="rt-apps">
      {p.appMode === 'block' && <span className="rt-sub" style={{ marginRight: 2 }}>All except</span>}
      {p.appTypes.map(t => <AppChip key={t} type={t} />)}
      {named.map((n, i) => <AppChip key={i} type="own" label={n} />)}
    </div>
  )
}

function RightsList() {
  const access = useAccess()
  const canEdit = access.can('rights', 'manage')
  const [list, setList] = useState<RightsProfile[] | null>(null)
  const [apps, setApps] = useState<{ id: string; name: string }[]>([])
  const [def, setDef] = useState<RightsSettings | null>(null)
  const [q, setQ] = useState('')
  const [err, setErr] = useState('')
  const notify = useNotify()

  async function load() {
    try {
      const [l, s] = await Promise.all([rightsApi.profiles(), rightsApi.settings()])
      setList(l); setDef(s); setErr('')
    } catch (e: any) { setErr(e.message) }
  }
  useEffect(() => { load(); api.apps().then(a => setApps(a.map((x: any) => ({ id: x.id, name: x.name })))).catch(() => {}) }, [])
  usePageNotice('load', err ? { kind: 'error', title: "Couldn't load the rights profiles.", message: err, actions: [{ label: 'Retry', onClick: () => { load() } }] } : null)

  const shown = useMemo(() => {
    const f = q.trim().toLowerCase()
    const rows = (list ?? []).filter(p => !f || p.name.toLowerCase().includes(f) || (p.provider ?? '').toLowerCase().includes(f))
    // Built-ins first, then by name.
    return rows.sort((a, b) => (a.builtin ? 0 : 1) - (b.builtin ? 0 : 1) || a.name.localeCompare(b.name))
  }, [list, q])
  const covered = (list ?? []).reduce((n, p) => n + (p.assetCount ?? 0), 0)
  const ending = (list ?? []).filter(p => { const d = daysLeft(p.window); return d != null && d > 0 && d <= 60 })
  const endingAssets = ending.reduce((n, p) => n + (p.assetCount ?? 0), 0)
  const missing = (list ?? []).filter(p => !p.builtin && !p.agreement).length

  async function chooseDefault(id: string) {
    try { await rightsApi.setDefault(id); await load(); notify({ kind: 'ok', message: 'New assets get this profile from now on. Existing assets keep theirs.' }) }
    catch (e: any) { notify({ kind: 'error', message: e.message }) }
  }
  const provider = (list ?? []).filter(p => !p.builtin)
  const defIsProvider = !!def && def.defaultProfileId !== def.builtins.open && def.defaultProfileId !== def.builtins.closed

  return (
    <>
      <PageHead title="Rights" sub="Every asset carries one rights profile. Rights cap everything else: collection access, publishing, FAST, social, clips and downloads only work inside them."
        action={canEdit ? <button className="btn primary" onClick={() => navigate('/rights/new')}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" aria-hidden><path d="M12 5v14M5 12h14" /></svg>New profile</button> : undefined} />

      <div className="rt-stats">
        <div className="card rt-stat"><span className="k">Profiles</span><span className="v">{list?.length ?? '–'}</span><span className="s">{provider.length} for providers, 2 built in</span></div>
        <div className="card rt-stat"><span className="k">Assets covered</span><span className="v">{covered.toLocaleString()}</span><span className="s">Every asset has a profile</span></div>
        <div className="card rt-stat"><span className="k">Ending in 60 days</span><span className={`v${endingAssets ? ' warn' : ''}`}>{endingAssets.toLocaleString()}</span><span className="s">assets, across {ending.length} profile{ending.length === 1 ? '' : 's'}</span></div>
        <div className="card rt-stat"><span className="k">Agreement missing</span><span className={`v${missing ? ' warn' : ''}`}>{missing}</span><span className="s">provider profile{missing === 1 ? '' : 's'} without the agreement</span></div>
      </div>

      {def && (
        <div className="card rt-sec" style={{ marginBottom: 16 }}>
          <div><h2>Default for new assets</h2><p className="rt-help">The profile an asset gets when its upload, watchfolder or API call names none. Changing it does not touch existing assets.</p></div>
          <div className="rt-defaults" role="radiogroup" aria-label="Default rights for new assets">
            <label className={`rt-default${def.defaultProfileId === def.builtins.open ? ' sel' : ''}`}>
              <b><input type="radio" name="rt-def" disabled={!canEdit} checked={def.defaultProfileId === def.builtins.open} onChange={() => chooseDefault(def.builtins.open)} />No restrictions</b>
              <span>Assets can be published anywhere once their policy allows. Narrow them later.</span>
            </label>
            <label className={`rt-default${def.defaultProfileId === def.builtins.closed ? ' sel' : ''}`}>
              <b><input type="radio" name="rt-def" disabled={!canEdit} checked={def.defaultProfileId === def.builtins.closed} onChange={() => chooseDefault(def.builtins.closed)} />All restricted</b>
              <span>Nothing goes public, into FAST or to social until someone sets its rights.</span>
            </label>
            <label className={`rt-default${defIsProvider ? ' sel' : ''}`}>
              <b><input type="radio" name="rt-def" disabled={!canEdit || !provider.length} checked={defIsProvider} onChange={() => provider[0] && chooseDefault(provider[0].id)} />A provider profile</b>
              <select className="inp" aria-label="Provider profile for new assets" disabled={!canEdit || !provider.length} value={defIsProvider ? def.defaultProfileId : ''}
                onChange={e => e.target.value && chooseDefault(e.target.value)} style={{ padding: '6px 10px' }}>
                <option value="">{provider.length ? 'Choose a profile' : 'No provider profiles yet'}</option>
                {provider.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
            </label>
          </div>
        </div>
      )}

      <div className="rt-bar">
        <input className="inp" type="search" placeholder="Search profiles or providers" aria-label="Search profiles" value={q} onChange={e => setQ(e.target.value)} style={{ maxWidth: 320 }} />
      </div>

      <div className="card rt-table-wrap">
        {!list ? <div className="loading" style={{ padding: 18 }}>Loading…</div> : (
          <table className="rt-table">
            <thead><tr>
              <th scope="col">Profile</th><th scope="col">Territories</th><th scope="col">Apps</th><th scope="col">Uses</th>
              <th scope="col">Access</th><th scope="col">Window</th><th scope="col" style={{ textAlign: 'right' }}>Assets</th><th scope="col">Agreement</th><th scope="col">Status</th>
            </tr></thead>
            <tbody>
              {shown.map(p => {
                const st = statusOf(p)
                return (
                  <tr key={p.id} className="rt-row" onClick={() => navigate(`/rights/${p.id}`)}>
                    <td>
                      <div className="rt-name">
                        <a href={`/rights/${p.id}`} onClick={e => { e.preventDefault(); e.stopPropagation(); navigate(`/rights/${p.id}`) }} style={{ color: 'inherit', textDecoration: 'none' }}>{p.name}</a>
                        {p.isDefault && <span className="rt-mini brand">Default</span>}
                        {p.builtin && <span className="rt-mini">Built in</span>}
                      </div>
                      <div className="rt-sub">{p.provider || (p.builtin ? 'Volt default' : 'No provider set')}</div>
                    </td>
                    <td style={{ maxWidth: 200 }}>{p.builtin === 'closed' ? 'None' : territorySummary(p.territoryMode, p.territories)}</td>
                    <td><AppsCell p={p} apps={apps} /></td>
                    <td><div className="rt-tags">{p.uses.length === USES.length ? <span className="rt-mini">All uses</span> : p.uses.length ? p.uses.map(u => <span key={u} className="rt-mini">{USE_LABEL[u].name}</span>) : <span className="rt-mini">None</span>}</div></td>
                    <td>{p.accessTypes.length === ACCESS_TYPES.length ? 'Any' : p.accessTypes.length ? p.accessTypes.map(a => ACCESS_LABEL[a]).join(', ') : 'None'}</td>
                    <td>{p.builtin === 'closed' ? 'Closed' : windowSummary(p.window)}</td>
                    <td className="num">{(p.assetCount ?? 0).toLocaleString()}</td>
                    <td className="rt-sub" style={{ marginTop: 0 }}>{p.builtin ? 'Not needed' : p.agreement?.name ?? 'Missing'}</td>
                    <td><span className="rt-status"><span className="rt-dot" style={{ background: st.color }} />{st.label}</span></td>
                  </tr>
                )
              })}
              {shown.length === 0 && <tr><td colSpan={9} className="rt-sub">No profile matches.</td></tr>}
            </tbody>
          </table>
        )}
      </div>
      <p className="rt-help" style={{ marginTop: 10 }}>Built-in profiles cannot be changed or deleted. A profile in use cannot be deleted: move its assets to another profile first.</p>

      {def && <BlockMessageCard settings={def} canEdit={canEdit} onSaved={setDef} />}
    </>
  )
}

// ---------------------------------------------------------------------------
//  One profile
// ---------------------------------------------------------------------------
const BLANK: ProfileInput = {
  name: '', provider: '', takedownContact: '', agreementRef: '',
  territoryMode: 'worldwide', territories: [], appMode: 'all', appTypes: [], appIds: [],
  uses: [...USES], accessTypes: [...ACCESS_TYPES], window: { kind: 'open' }, warnDays: 30,
}
const toInput = (p: RightsProfile): ProfileInput => ({
  name: p.name, provider: p.provider ?? '', takedownContact: p.takedownContact ?? '', agreementRef: p.agreementRef ?? '',
  territoryMode: p.territoryMode, territories: p.territories, appMode: p.appMode, appTypes: p.appTypes, appIds: p.appIds,
  uses: p.uses, accessTypes: p.accessTypes, window: p.window, warnDays: p.warnDays,
})
const isoDay = (s?: string | null) => (s ? new Date(s).toISOString().slice(0, 10) : '')
const fromDay = (d: string, end = false) => (d ? new Date(`${d}T${end ? '23:59:59' : '00:00:00'}Z`).toISOString() : null)

function ProfileEditor({ id }: { id: string | null }) {
  const access = useAccess()
  const canEdit = access.can('rights', 'manage')
  const [p, setP] = useState<RightsProfile | null>(null)
  const [f, setF] = useState<ProfileInput>(BLANK)
  const [apps, setApps] = useState<{ id: string; name: string; type: RightsAppType }[]>([])
  const [assets, setAssets] = useState<{ id: string; title: string; narrowed: boolean; setBy: string | null }[]>([])
  const [text, setText] = useState('')
  const [err, setErr] = useState('')
  const [saveErr, setSaveErr] = useState('')
  const [busy, setBusy] = useState(false)
  const [confirmDel, setConfirmDel] = useState(false)
  const notify = useNotify()
  const locked = !canEdit || !!p?.builtin

  async function load() {
    if (!id) return
    try { const x = await rightsApi.profile(id); setP(x); setF(toInput(x)); setErr('') } catch (e: any) { setErr(e.message) }
    rightsApi.assets(id).then(r => setAssets(r.items)).catch(() => {})
  }
  useEffect(() => { load(); api.apps().then(a => setApps(a.map((x: any) => ({ id: x.id, name: x.name, type: appTypeOf(x.type, x.surface) })))).catch(() => {}) }, [id])
  usePageNotice('load', err ? { kind: 'error', title: "Couldn't load this profile.", message: err } : null)

  const set = (patch: Partial<ProfileInput>) => setF(x => ({ ...x, ...patch }))
  const toggle = <T,>(list: T[], v: T) => (list.includes(v) ? list.filter(x => x !== v) : [...list, v])
  function addCountry(raw: string) {
    const c = toCountryCode(raw)
    if (!c) { setSaveErr(`"${raw}" is not a country Volt knows.`); return }
    if (!f.territories.includes(c)) set({ territories: [...f.territories, c] })
    setText(''); setSaveErr('')
  }
  const problem = !f.name.trim() ? 'Give the profile a name.'
    : f.territoryMode !== 'worldwide' && !f.territories.length ? 'Add at least one territory, or choose Worldwide.'
    : f.appMode !== 'all' && !f.appTypes.length && !f.appIds.length ? 'Choose at least one app type or app, or choose All apps.'
    : f.window.kind === 'fixed' && f.window.from && f.window.until && f.window.from >= f.window.until ? 'The window must start before it ends.'
    : ''
  const dirty = !p ? JSON.stringify(f) !== JSON.stringify(BLANK) : JSON.stringify(f) !== JSON.stringify(toInput(p))

  async function save() {
    if (problem) return
    setBusy(true); setSaveErr('')
    try {
      const body = { ...f, name: f.name.trim(), provider: f.provider?.trim() || null, takedownContact: f.takedownContact?.trim() || null, agreementRef: f.agreementRef?.trim() || null }
      if (!id) { const made = await rightsApi.create(body); notify({ kind: 'ok', message: `${made.name} created.` }); navigate(`/rights/${made.id}`, { replace: true }); return }
      const saved = await rightsApi.update(id, body)
      setP(x => ({ ...(x as RightsProfile), ...saved })); setF(toInput(saved))
      notify({ kind: 'ok', message: `Saved. The ${saved.assetCount ?? 0} asset${saved.assetCount === 1 ? '' : 's'} on this profile follow it from now.` })
    } catch (e: any) { setSaveErr(e.message) } finally { setBusy(false) }
  }
  async function del() {
    setConfirmDel(false)
    try { await rightsApi.remove(id!); notify({ kind: 'ok', message: 'Profile deleted.' }); navigate('/rights') } catch (e: any) { setSaveErr(e.message) }
  }
  async function upload(file: File | undefined) {
    if (!file || !id) return
    try { await rightsApi.uploadAgreement(id, file); await load(); notify({ kind: 'ok', message: `${file.name} attached. Only rights admins can open it.` }) }
    catch (e: any) { setSaveErr(e.message) }
  }

  const w = f.window
  const setWindow = (nw: RightsWindow) => set({ window: nw })
  const where = useMemo(() => {
    if (f.territoryMode === 'worldwide') return [{ where: 'Worldwide', ok: true }]
    if (f.territoryMode === 'allow') return [...f.territories.map(c => ({ where: countryName(c), ok: true })), { where: 'Everywhere else', ok: false }]
    return [...f.territories.map(c => ({ where: countryName(c), ok: false })), { where: 'Everywhere else', ok: true }]
  }, [f.territoryMode, f.territories])

  if (id && !p && !err) return <div className="loading">Loading…</div>
  return (
    <>
      <div className="crumb" style={{ marginBottom: 6 }}><a href="/rights" onClick={e => { e.preventDefault(); navigate('/rights') }}>Rights</a> / {p?.name ?? 'New profile'}</div>
      <PageHead title={p?.name ?? 'New rights profile'}
        sub={p ? `${(p.assetCount ?? 0).toLocaleString()} asset${p.assetCount === 1 ? '' : 's'} on this profile${p.builtin ? '. Built in: it cannot be changed.' : '.'}` : 'Set where, on which apps, for what and until when. Assets on it can never go wider.'}
        action={!locked ? <div className="rt-foot">
          <FormStatus blocked={dirty ? problem || undefined : undefined} error={saveErr || undefined} />
          <button className="btn primary" disabled={!dirty || !!problem || busy} onClick={save}>{busy ? 'Saving…' : id ? 'Save profile' : 'Create profile'}</button>
        </div> : undefined} />

      <div className="rt-layout">
        <div className="rt-main">
          <section className="card rt-sec" aria-labelledby="rt-owner">
            <h2 id="rt-owner">Owner</h2>
            <div className="rt-grid2">
              <div className="field" style={{ margin: 0 }}><label htmlFor="rt-name">Profile name</label><input id="rt-name" className="inp" disabled={locked} value={f.name} onChange={e => set({ name: e.target.value })} /></div>
              <div className="field" style={{ margin: 0 }}><label htmlFor="rt-prov">Provider or content owner</label><input id="rt-prov" className="inp" disabled={locked} value={f.provider ?? ''} onChange={e => set({ provider: e.target.value })} /></div>
              <div className="field" style={{ margin: 0 }}><label htmlFor="rt-td">Takedown contact</label><input id="rt-td" className="inp" type="email" disabled={locked} value={f.takedownContact ?? ''} onChange={e => set({ takedownContact: e.target.value })} /></div>
              <div className="field" style={{ margin: 0 }}><label htmlFor="rt-ref">Agreement reference</label><input id="rt-ref" className="inp mono" disabled={locked} value={f.agreementRef ?? ''} onChange={e => set({ agreementRef: e.target.value })} /></div>
            </div>
          </section>

          <section className="card rt-sec" aria-labelledby="rt-terr">
            <div className="rt-sec-h">
              <h2 id="rt-terr">Territories</h2>
              <div className="seg-choice" role="radiogroup" aria-label="Territory mode">
                {(['worldwide', 'allow', 'block'] as const).map(m => (
                  <button key={m} type="button" role="radio" aria-checked={f.territoryMode === m} className={f.territoryMode === m ? 'sel' : ''} disabled={locked}
                    onClick={() => set({ territoryMode: m })}>{m === 'worldwide' ? 'Worldwide' : m === 'allow' ? 'Allow only these' : 'Worldwide except these'}</button>
                ))}
              </div>
            </div>
            {f.territoryMode !== 'worldwide' && (
              <div className="rt-terr">
                {f.territories.map(c => (
                  <span key={c} className={`geo-chip ${f.territoryMode}`}>{countryName(c)} <span className="cc">{c}</span>
                    {!locked && <button type="button" aria-label={`Remove ${countryName(c)}`} onClick={() => set({ territories: f.territories.filter(x => x !== c) })}>✕</button>}
                  </span>
                ))}
                {!locked && <>
                  <input className="inp" list="rt-countries" placeholder="Add a country" aria-label="Add a country" value={text}
                    onChange={e => { setText(e.target.value); if (/\([A-Z]{2}\)$/.test(e.target.value)) addCountry(e.target.value) }}
                    onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); addCountry(text) } }} />
                  <datalist id="rt-countries">{COUNTRIES.map(c => <option key={c.code} value={`${c.name} (${c.code})`} />)}</datalist>
                </>}
              </div>
            )}
            <p className="rt-help">Viewers anywhere else get the block message, and each refusal is counted as a rights refusal in the playback reports. A viewer whose country cannot be told is not let in by an allow list.</p>
          </section>

          <section className="card rt-sec" aria-labelledby="rt-apps">
            <div className="rt-sec-h">
              <h2 id="rt-apps">Apps</h2>
              <div className="seg-choice" role="radiogroup" aria-label="App mode">
                {(['all', 'allow', 'block'] as const).map(m => (
                  <button key={m} type="button" role="radio" aria-checked={f.appMode === m} className={f.appMode === m ? 'sel' : ''} disabled={locked}
                    onClick={() => set({ appMode: m })}>{m === 'all' ? 'All apps' : m === 'allow' ? 'Allow only these' : 'All except these'}</button>
                ))}
              </div>
            </div>
            {f.appMode !== 'all' && <>
              <div className="rt-grid3">
                {APP_TYPES.map(t => (
                  <label key={t} className={`rt-card${locked ? ' off' : ''}`}>
                    <input type="checkbox" disabled={locked} checked={f.appTypes.includes(t)} onChange={() => set({ appTypes: toggle(f.appTypes, t) })} />
                    <span className="ic"><AppTypeGlyph type={t} size={20} /></span>
                    <span className="t"><b>{APP_LABEL[t].name}</b><span>{APP_LABEL[t].note}</span></span>
                  </label>
                ))}
              </div>
              {apps.length > 0 && (
                <div>
                  <div className="rt-sub" style={{ marginBottom: 6 }}>Or name registered apps</div>
                  <div className="rt-checks">
                    {apps.map(a => (
                      <label key={a.id} className={`rt-check${locked ? ' off' : ''}`}>
                        <input type="checkbox" disabled={locked} checked={f.appIds.includes(a.id)} onChange={() => set({ appIds: toggle(f.appIds, a.id) })} />
                        <AppTypeGlyph type={a.type} size={16} />{a.name}
                      </label>
                    ))}
                  </div>
                </div>
              )}
            </>}
            <p className="rt-help">Collections and assets set per-app rules only for the apps allowed here. A blocked app never lists or plays the asset.</p>
          </section>

          <section className="card rt-sec" aria-labelledby="rt-uses">
            <h2 id="rt-uses">Permitted uses</h2>
            <div className="rt-grid3">
              {USES.map(u => (
                <label key={u} className={`rt-card${locked ? ' off' : ''}`}>
                  <input type="checkbox" disabled={locked} checked={f.uses.includes(u)} onChange={() => set({ uses: toggle(f.uses, u) as Use[] })} />
                  <span className="t"><b>{USE_LABEL[u].name}</b><span>{USE_LABEL[u].note}</span></span>
                </label>
              ))}
            </div>
          </section>

          <section className="card rt-sec" aria-labelledby="rt-access">
            <h2 id="rt-access">Access types allowed</h2>
            <div className="rt-checks">
              {ACCESS_TYPES.map(a => (
                <label key={a} className={`rt-check${locked ? ' off' : ''}`}>
                  <input type="checkbox" disabled={locked} checked={f.accessTypes.includes(a)} onChange={() => set({ accessTypes: toggle(f.accessTypes, a) as AccessType[] })} />{ACCESS_LABEL[a]}
                </label>
              ))}
            </div>
            <p className="rt-help">A policy or collection rule that would let viewers in another way is refused, and a paywall only offers what these allow.</p>
          </section>

          <section className="card rt-sec" aria-labelledby="rt-win">
            <h2 id="rt-win">Window</h2>
            <div className="rt-checks" role="radiogroup" aria-label="Window">
              {(['fixed', 'relative', 'open'] as const).map(k => (
                <label key={k} className={`rt-check${locked ? ' off' : ''}`}>
                  <input type="radio" name="rt-win" disabled={locked} checked={w.kind === k}
                    onChange={() => setWindow(k === 'fixed' ? { kind: 'fixed', from: null, until: null } : k === 'relative' ? { kind: 'relative', count: 12, unit: 'month', from: 'first_air' } : { kind: 'open' })} />
                  {k === 'fixed' ? 'Fixed dates' : k === 'relative' ? 'Relative' : 'Open, no end'}
                </label>
              ))}
            </div>
            {w.kind === 'fixed' && (
              <div className="rt-grid2">
                <div className="field" style={{ margin: 0 }}><label htmlFor="rt-from">From</label><input id="rt-from" type="date" className="inp" disabled={locked} value={isoDay(w.from)} onChange={e => setWindow({ ...w, from: fromDay(e.target.value) })} /></div>
                <div className="field" style={{ margin: 0 }}><label htmlFor="rt-until">Until</label><input id="rt-until" type="date" className="inp" disabled={locked} value={isoDay(w.until)} onChange={e => setWindow({ ...w, until: fromDay(e.target.value, true) })} /></div>
              </div>
            )}
            {w.kind === 'relative' && (
              <div className="rt-foot">
                <label className="rt-sub" htmlFor="rt-count">Available for</label>
                <input id="rt-count" type="number" min={1} className="inp" style={{ width: 80 }} disabled={locked} value={w.count} onChange={e => setWindow({ ...w, count: Math.max(1, Number(e.target.value) || 1) })} />
                <select className="inp" aria-label="Unit" style={{ width: 120 }} disabled={locked} value={w.unit} onChange={e => setWindow({ ...w, unit: e.target.value as any })}>
                  <option value="day">days</option><option value="month">months</option><option value="year">years</option>
                </select>
                <select className="inp" aria-label="Starting from" style={{ width: 220 }} disabled={locked} value={w.from} onChange={e => setWindow({ ...w, from: e.target.value as any })}>
                  <option value="first_air">from first air</option><option value="ingest">from ingest</option>
                </select>
              </div>
            )}
            <div className="rt-foot">
              <label className="rt-sub" htmlFor="rt-warn">Warn rights admins</label>
              <select id="rt-warn" className="inp" style={{ width: 200 }} disabled={locked} value={f.warnDays} onChange={e => set({ warnDays: Number(e.target.value) })}>
                {[60, 30, 14, 7, 0].map(d => <option key={d} value={d}>{d ? `${d} days before the end` : 'Off'}</option>)}
              </select>
            </div>
            <p className="rt-help">When an asset's window ends it leaves every public path: play is refused and nothing new is published. It stays in the library.</p>
          </section>

          {id && !p?.builtin && (
            <section className="card rt-sec" aria-labelledby="rt-agree">
              <div className="rt-sec-h"><h2 id="rt-agree">Agreement</h2><span className="rt-sub">Rights admins only. Every read is in the audit log.</span></div>
              <div className="rt-file">
                <div className="n">
                  <b>{p?.agreement?.name ?? 'No agreement attached'}</b>
                  {p?.agreement && <span className="rt-sub">{p.agreement.size < 1024 ? 'Under 1 KB' : `${Math.round(p.agreement.size / 1024).toLocaleString()} KB`} · added {new Date(p.agreement.uploadedAt).toLocaleDateString()} by {p.agreement.uploadedBy}</span>}
                </div>
                {p?.agreement && <button className="btn ghost" onClick={() => rightsApi.openAgreement(id, p.agreement!.name).catch(e => setSaveErr(e.message))}>Open</button>}
                {canEdit && <label className="btn ghost" style={{ cursor: 'pointer' }}>{p?.agreement ? 'Replace' : 'Attach agreement'}
                  <input type="file" hidden accept=".pdf,.doc,.docx,image/*" onChange={e => { upload(e.target.files?.[0]); e.target.value = '' }} /></label>}
              </div>
            </section>
          )}
        </div>

        <aside className="rt-side">
          <section className="card rt-sec">
            <h2>Where it plays</h2>
            <div>
              {where.map(x => (
                <div key={x.where} className="rt-kv"><span>{x.where}</span><b style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><span className="rt-dot" style={{ background: x.ok ? 'var(--live)' : 'var(--down)' }} />{x.ok ? 'Allowed' : 'Blocked'}</b></div>
              ))}
              {f.appMode !== 'all' && (
                <div className="rt-kv"><span>Apps</span><span className="rt-apps">{f.appMode === 'block' && <span className="rt-sub">All except</span>}{f.appTypes.map(t => <AppChip key={t} type={t} />)}{f.appIds.map(a => <AppChip key={a} type="own" label={apps.find(x => x.id === a)?.name} />)}</span></div>
              )}
            </div>
          </section>
          {p && (
            <section className="card rt-sec">
              <h2>How assets got it</h2>
              <div>
                {(p.setBy ?? []).map(s => <div key={s.how} className="rt-kv"><span>{s.how}</span><b>{s.count.toLocaleString()}</b></div>)}
                {!(p.setBy ?? []).length && <p className="rt-help">No asset uses this profile yet.</p>}
              </div>
              {assets.length > 0 && <div className="rt-sub">Latest: {assets.slice(0, 5).map(a => a.title).join(', ')}</div>}
            </section>
          )}
          {id && canEdit && !p?.builtin && (
            <section className="card rt-sec">
              <h2>Delete</h2>
              <p className="rt-help">Only when no asset uses it and it is not the default for new assets.</p>
              <div><button className="btn ghost" disabled={!!p?.assetCount || !!p?.isDefault} onClick={() => setConfirmDel(true)}>Delete profile</button></div>
            </section>
          )}
        </aside>
      </div>
      {confirmDel && <ConfirmDialog title="Delete this rights profile?" body={`${p?.name} will be removed. This cannot be undone.`} confirmLabel="Delete" danger onConfirm={del} onCancel={() => setConfirmDel(false)} />}
    </>
  )
}
