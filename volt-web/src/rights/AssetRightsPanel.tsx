// ============================================================================
//  THE ASSET'S RIGHTS TAB (build queue R1).
//
//  Which profile the asset has (required), how it got it, and the title's own
//  narrowing: fewer territories, apps or uses, a shorter window. Only choices
//  inside the profile are offered, so a title can never be wider than its
//  profile (the server refuses that too). Underneath, what the rights alone
//  answer for each of the account's apps in each territory; collection
//  access and the publishing policy then decide inside that.
// ============================================================================
import { useEffect, useMemo, useState } from 'react'
import { api } from '../api'
import { useAccess } from '../access'
import { useNotify, FormStatus } from '../notices'
import { countryName } from '../lib/countries'
import {
  rightsApi, type AssetRights, type RightsProfile, type RightsNarrow, type RightsAppType, type Use,
  USE_LABEL, ACCESS_LABEL, APP_LABEL, appTypeOf, territorySummary, windowSummary, rightsDay,
} from './rightsApi'
import { AppTypeGlyph } from './RightsIcons'
import './rights.css'

interface App { id: string; name: string; type: RightsAppType }

/** The rights alone, for one app in one territory (the server's evaluateRights, for display). */
function answer(e: AssetRights['effective'], app: App, country: string | null): { ok: boolean; why: string } {
  if (!e.uses.includes('on_demand')) return { ok: false, why: 'Not cleared on demand' }
  const now = Date.now()
  if (e.from && now < Date.parse(e.from)) return { ok: false, why: 'Window not open' }
  if (e.until && now >= Date.parse(e.until)) return { ok: false, why: 'Window ended' }
  if (country) {
    if (e.territoryMode === 'allow' && !e.territories.includes(country)) return { ok: false, why: 'Territory' }
    if (e.territoryMode === 'block' && e.territories.includes(country)) return { ok: false, why: 'Territory' }
    if (e.blockTerritories.includes(country)) return { ok: false, why: 'Title territory' }
  } else if (e.territoryMode === 'allow') return { ok: false, why: 'Territory' }
  const named = e.appIds.includes(app.id)
  if (e.blockAppIds.includes(app.id)) return { ok: false, why: 'Title app' }
  if (e.appMode === 'allow' && !named && !e.appTypes.includes(app.type)) return { ok: false, why: 'App' }
  if (e.appMode === 'block' && (named || e.appTypes.includes(app.type))) return { ok: false, why: 'App' }
  return { ok: true, why: e.accessTypes.map(a => ACCESS_LABEL[a]).join(', ') || 'No access type' }
}

export default function AssetRightsPanel({ assetId }: { assetId: string }) {
  const access = useAccess()
  const canEdit = access.can('rights', 'manage')
  const notify = useNotify()
  const [r, setR] = useState<AssetRights | null>(null)
  const [profiles, setProfiles] = useState<RightsProfile[]>([])
  const [apps, setApps] = useState<App[]>([])
  const [profileId, setProfileId] = useState('')
  const [n, setN] = useState<RightsNarrow>({})
  const [narrowOn, setNarrowOn] = useState(false)
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)

  async function load() {
    try {
      const x = await rightsApi.asset(assetId)
      setR(x); setProfileId(x.profile?.id ?? ''); setN(x.narrow ?? {}); setNarrowOn(!!x.narrow); setErr('')
    } catch (e: any) { setErr(e.message) }
  }
  useEffect(() => {
    load()
    rightsApi.profiles().then(setProfiles).catch(() => {})
    api.apps().then(a => setApps(a.map((x: any) => ({ id: x.id, name: x.name, type: appTypeOf(x.type, x.surface) })))).catch(() => {})
  }, [assetId])

  const prof = profiles.find(p => p.id === profileId) ?? r?.profile ?? null
  const changedProfile = !!r && profileId !== (r.profile?.id ?? '')
  // Choices offered for narrowing: only what the chosen profile allows.
  const terrOptions = prof && prof.territoryMode === 'allow' ? prof.territories : []
  const appOptions: RightsAppType[] = !prof ? [] : prof.appMode === 'allow' ? prof.appTypes
    : prof.appMode === 'block' ? (Object.keys(APP_LABEL) as RightsAppType[]).filter(t => !prof.appTypes.includes(t)) : (Object.keys(APP_LABEL) as RightsAppType[])
  const useOptions: Use[] = prof?.uses ?? []
  const toggle = <T,>(list: T[] | undefined, v: T, all: T[]) => {
    const cur = list?.length ? list : all
    const next = cur.includes(v) ? cur.filter(x => x !== v) : [...cur, v]
    return next.length === all.length ? undefined : next
  }
  const dirty = !!r && (changedProfile || JSON.stringify(narrowOn ? n : null) !== JSON.stringify(r.narrow ?? null))

  async function save() {
    if (!profileId) return
    setBusy(true)
    try {
      const x = await rightsApi.setAsset(assetId, profileId, narrowOn ? n : null)
      setR(x); setN(x.narrow ?? {}); setNarrowOn(!!x.narrow)
      notify({ kind: 'ok', message: 'Rights saved. The play gate follows them at once.' })
    } catch (e: any) { setErr(e.message) } finally { setBusy(false) }
  }

  const cols = useMemo(() => {
    const e = r?.effective
    if (!e) return [] as { code: string | null; label: string }[]
    const listed = e.territoryMode === 'worldwide' ? [] : e.territories.slice(0, 5)
    return [...listed.map(c => ({ code: c, label: countryName(c) })), { code: e.territoryMode === 'block' ? null : 'ZZ', label: e.territoryMode === 'worldwide' ? 'Everywhere' : 'Everywhere else' }]
  }, [r])

  if (!r) return <div className="loading" style={{ padding: 16 }}>{err || 'Loading…'}</div>
  const e = r.effective
  return (
    <div className="rt-layout" style={{ marginTop: 12 }}>
      <div className="rt-side" style={{ maxWidth: 440 }}>
        <section className="card rt-sec">
          <h2>Rights profile</h2>
          <div className="field" style={{ margin: 0 }}>
            <label htmlFor="ar-prof">Profile (required)</label>
            <select id="ar-prof" className="inp" disabled={!canEdit} value={profileId} onChange={ev => { setProfileId(ev.target.value); setN({}); setNarrowOn(false) }}>
              {profiles.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </div>
          {prof && <div className="rt-tags" style={{ maxWidth: 'none' }}>
            <span className="rt-mini">{territorySummary(prof.territoryMode, prof.territories)}</span>
            <span className="rt-mini" style={{ display: 'inline-flex', gap: 4, alignItems: 'center' }}>
              {prof.appMode === 'all' ? 'All apps' : <>{prof.appMode === 'block' ? 'All except ' : ''}{prof.appTypes.map(t => <span key={t} role="img" aria-label={APP_LABEL[t].name} title={APP_LABEL[t].name}><AppTypeGlyph type={t} size={13} /></span>)}</>}
            </span>
            <span className="rt-mini">{prof.uses.map(u => USE_LABEL[u].name).join(', ') || 'No uses'}</span>
            <span className="rt-mini">{windowSummary(prof.window)}</span>
          </div>}
          <div className="rt-sub">{r.setBy ? `How it got this: ${r.setBy}` : ''}{r.setAt ? `, ${new Date(r.setAt).toLocaleDateString()}` : ''}{prof ? <> · <a href={`/rights/${prof.id}`}>Open profile</a></> : null}</div>
        </section>

        <section className="card rt-sec">
          <div className="rt-sec-h"><h2>Narrow for this title</h2>
            <label className="rt-sub" style={{ marginLeft: 'auto', display: 'flex', gap: 6, alignItems: 'center' }}>
              <input type="checkbox" disabled={!canEdit} checked={narrowOn} onChange={ev => setNarrowOn(ev.target.checked)} />On</label>
          </div>
          <p className="rt-help">Only choices inside the profile are offered. A title can be narrower than its profile, never wider.</p>
          {narrowOn && prof && <>
            {terrOptions.length > 0 && <div>
              <div className="rt-mhead" style={{ padding: '0 0 6px' }}>Territories</div>
              <div className="rt-checks">{terrOptions.map(c => (
                <label key={c} className="rt-check"><input type="checkbox" disabled={!canEdit} checked={(n.territories?.length ? n.territories : terrOptions).includes(c)}
                  onChange={() => setN(x => ({ ...x, territories: toggle(x.territories, c, terrOptions) }))} />{countryName(c)}</label>
              ))}</div>
            </div>}
            {appOptions.length > 0 && <div>
              <div className="rt-mhead" style={{ padding: '0 0 6px' }}>Apps</div>
              <div className="rt-checks">{appOptions.map(t => (
                <label key={t} className="rt-check"><input type="checkbox" disabled={!canEdit} checked={(n.appTypes?.length ? n.appTypes : appOptions).includes(t)}
                  onChange={() => setN(x => ({ ...x, appTypes: toggle(x.appTypes, t, appOptions) }))} /><AppTypeGlyph type={t} size={16} />{APP_LABEL[t].name}</label>
              ))}</div>
            </div>}
            {useOptions.length > 0 && <div>
              <div className="rt-mhead" style={{ padding: '0 0 6px' }}>Uses</div>
              <div className="rt-checks">{useOptions.map(u => (
                <label key={u} className="rt-check"><input type="checkbox" disabled={!canEdit} checked={(n.uses?.length ? n.uses : useOptions).includes(u)}
                  onChange={() => setN(x => ({ ...x, uses: toggle(x.uses, u, useOptions) }))} />{USE_LABEL[u].name}</label>
              ))}</div>
            </div>}
            <div className="field" style={{ margin: 0 }}>
              <label htmlFor="ar-until">Window ends{prof.window.kind === 'fixed' && prof.window.until ? ` (profile: ${rightsDay(prof.window.until)})` : ''}</label>
              <input id="ar-until" type="date" className="inp" disabled={!canEdit} value={n.until ? n.until.slice(0, 10) : ''}
                onChange={ev => setN(x => ({ ...x, until: ev.target.value ? new Date(`${ev.target.value}T23:59:59Z`).toISOString() : null }))} />
            </div>
          </>}
          {canEdit && <div className="rt-foot">
            <FormStatus error={err || undefined} />
            <button className="btn primary" disabled={!dirty || busy || !profileId} onClick={save}>{busy ? 'Saving…' : 'Save rights'}</button>
          </div>}
        </section>
      </div>

      <div className="rt-main">
        <section className="card rt-sec">
          <div className="rt-sec-h"><h2>Where the rights allow it</h2><span className="rt-sub" style={{ marginLeft: 'auto' }}>The rights alone, by app and territory. Collection access and the policy decide inside this.</span></div>
          {!apps.length ? <p className="rt-help">Register an app under API Keys and Apps to see it here.</p> : (
            <div style={{ overflowX: 'auto' }}>
              <div className="rt-matrix" style={{ gridTemplateColumns: `180px repeat(${cols.length}, minmax(120px, 1fr))` }}>
                <span />
                {cols.map(c => <span key={c.label} className="rt-mhead">{c.label}</span>)}
                {apps.map(a => <Row key={a.id} app={a} cols={cols} e={e} />)}
              </div>
            </div>
          )}
          <div className="rt-tags" style={{ maxWidth: 'none' }}>
            <span className="rt-mini">Window: {e.from || e.until ? `${e.from ? rightsDay(e.from) : 'now'} to ${e.until ? rightsDay(e.until) : 'open'}` : 'open'}</span>
            <span className="rt-mini">Uses: {e.uses.map(u => USE_LABEL[u].name).join(', ') || 'none'}</span>
            {e.narrowed && <span className="rt-mini brand">Narrowed for this title</span>}
          </div>
        </section>
      </div>
    </div>
  )
}

function Row({ app, cols, e }: { app: App; cols: { code: string | null; label: string }[]; e: AssetRights['effective'] }) {
  return <>
    <span className="rt-mrow"><span className="rt-appchip" aria-hidden><AppTypeGlyph type={app.type} size={15} /></span>{app.name}</span>
    {cols.map(c => {
      const x = answer(e, app, c.code === 'ZZ' ? 'ZZ' : c.code)
      return <span key={c.label} className="rt-mcell"><b><span className="rt-dot" style={{ background: x.ok ? 'var(--live)' : 'var(--down)' }} />{x.ok ? 'Allowed' : 'Blocked'}</b><span>{x.why}</span></span>
    })}
  </>
}
