import { useEffect, useState } from 'react'
import { apiRequest } from '../api'
import { PageHead } from '../scaffold'
import { pressable } from '../a11y'
import { useNotify, usePageNotice } from '../notices'
import { useAccess } from '../access'

/* ============================================================================
   ON-DEMAND ADS (Admin > Media setup). Where the ad breaks go in on-demand
   titles and who fills them (volt-app services/vodAds, SSAI.md section 5).

   One account default and, optionally, a rule per content type (a kids series
   with no ads, films with fewer breaks). Each rule: pre-roll, mid-rolls at the
   title's own cue points or every N minutes, post-roll, the ad server and the
   house spots that fill what it leaves, who plays ad-free, snapback, and how
   the ads reach the player (guided where the player can, stitched otherwise).
   A title can opt out in its metadata (adRule: none). The report at the top is
   the last seven days. Ad servers are shared with FAST channels.
   ========================================================================== */

interface Policy {
  preroll: { on: boolean; sec: number; minContentSec: number }
  midroll: { on: boolean; sec: number; everyMin: number; firstAfterMin: number; endGuardMin: number; minGapMin: number; useCues: boolean; maxBreaks: number }
  postroll: { on: boolean; sec: number; minContentSec: number }
  podMaxAds: number; maxAdSec: number
  adFreeFor: ('entitlement' | 'members')[]
  snapback: boolean; prerollOnResume: boolean
  delivery: 'auto' | 'stitched' | 'guided'
}
interface Rule { id: string | null; contentTypeId: string | null; contentTypeName?: string | null; mode: 'off' | 'on'; policy: Policy; adServerId: string | null; houseAds: { assetId: string; weight?: number }[] }
interface Server { id: string; name: string; vendor: string; enabled: boolean }
interface Spot { id: string; title: string; durationSec: number }
interface Report { sessions: number; impressions: number; completionRate: number | null; clicks: number; clickRate: number | null; fillRate: number | null; houseShare: number | null; timeouts: number }

const pct = (v: number | null) => (v == null ? '-' : `${Math.round(v * 1000) / 10}%`)
const dur = (s: number) => (s >= 60 ? `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}` : `${Math.round(s)} s`)

function Num({ label, value, onChange, min, max, step = 1, suffix }: { label: string; value: number; onChange: (v: number) => void; min: number; max: number; step?: number; suffix: string }) {
  return (
    <label className="field" style={{ marginBottom: 8 }}>
      <span style={{ display: 'block', fontSize: 'var(--fs-sm)', fontWeight: 600, marginBottom: 5 }}>{label}</span>
      <span style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
        <input className="inp" type="number" min={min} max={max} step={step} value={value} style={{ width: 96 }}
          onChange={e => onChange(Math.max(min, Math.min(max, Number(e.target.value) || 0)))} />
        <span className="hintxt">{suffix}</span>
      </span>
    </label>
  )
}

function Toggle({ on, label, onChange }: { on: boolean; label: string; onChange: (v: boolean) => void }) {
  return (
    <span style={{ display: 'inline-flex', gap: 8, alignItems: 'center', justifySelf: 'start' }}>
      <span className={`sw ${on ? '' : 'off'}`} style={{ marginLeft: 0 }} {...pressable(() => onChange(!on), { label })}><i /></span>
      <span style={{ fontWeight: 600 }}>{label}</span>
    </span>
  )
}

function RuleEditor({ rule, servers, spots, canEdit, onSave, onRemove }: {
  rule: Rule; servers: Server[]; spots: Spot[]; canEdit: boolean; onSave: (r: Rule) => Promise<void>; onRemove?: () => void
}) {
  const [r, setR] = useState<Rule>(rule)
  const [busy, setBusy] = useState(false)
  useEffect(() => setR(rule), [rule])
  const p = r.policy
  const set = (patch: Partial<Policy>) => setR({ ...r, policy: { ...p, ...patch } })
  const dirty = JSON.stringify(r) !== JSON.stringify(rule)
  const title = r.contentTypeId ? `Content type: ${r.contentTypeName ?? 'Unnamed'}` : 'Account default'
  return (
    <div className="card" style={{ marginTop: 14 }}>
      <div className="card-h">
        <h3>{title}</h3>
        <span className={`nt-pill ${r.mode === 'on' ? 'ok' : 'muted'}`}>{r.mode === 'on' ? 'Ads on' : 'No ads'}</span>
        <span className="spacer" />
        {onRemove && canEdit && <button className="btn ghost sm" onClick={onRemove}>Use the account default</button>}
        {canEdit && <button className="btn primary sm" disabled={!dirty || busy} onClick={async () => { setBusy(true); try { await onSave(r) } finally { setBusy(false) } }}>{busy ? 'Saving…' : 'Save'}</button>}
      </div>
      <div className="card-b" style={{ display: 'grid', gap: 14 }}>
        <Toggle on={r.mode === 'on'} label={r.contentTypeId ? 'Ads in this content type' : 'Ads in on-demand titles'} onChange={(v) => setR({ ...r, mode: v ? 'on' : 'off' })} />
        {r.mode === 'on' && <>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: 14 }}>
            <div>
              <Toggle on={p.preroll.on} label="Pre-roll" onChange={(on) => set({ preroll: { ...p.preroll, on } })} />
              {p.preroll.on && <div style={{ marginTop: 8 }}>
                <Num label="Length" value={p.preroll.sec} min={5} max={300} suffix="seconds" onChange={(sec) => set({ preroll: { ...p.preroll, sec } })} />
                <Num label="Only for titles of at least" value={p.preroll.minContentSec} min={0} max={7200} suffix="seconds" onChange={(minContentSec) => set({ preroll: { ...p.preroll, minContentSec } })} />
              </div>}
            </div>
            <div>
              <Toggle on={p.midroll.on} label="Mid-rolls" onChange={(on) => set({ midroll: { ...p.midroll, on } })} />
              {p.midroll.on && <div style={{ marginTop: 8 }}>
                <Num label="Length" value={p.midroll.sec} min={5} max={600} suffix="seconds" onChange={(sec) => set({ midroll: { ...p.midroll, sec } })} />
                <Num label="Every" value={p.midroll.everyMin} min={2} max={120} step={0.5} suffix="minutes" onChange={(everyMin) => set({ midroll: { ...p.midroll, everyMin } })} />
                <Num label="Not in the first" value={p.midroll.firstAfterMin} min={0} max={120} suffix="minutes" onChange={(firstAfterMin) => set({ midroll: { ...p.midroll, firstAfterMin } })} />
                <Num label="Not in the last" value={p.midroll.endGuardMin} min={0} max={60} suffix="minutes" onChange={(endGuardMin) => set({ midroll: { ...p.midroll, endGuardMin } })} />
                <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 'var(--fs-sm)' }}>
                  <input type="checkbox" checked={p.midroll.useCues} onChange={e => set({ midroll: { ...p.midroll, useCues: e.target.checked } })} />
                  Use a title's own cue points when it has them
                </label>
              </div>}
            </div>
            <div>
              <Toggle on={p.postroll.on} label="Post-roll" onChange={(on) => set({ postroll: { ...p.postroll, on } })} />
              {p.postroll.on && <div style={{ marginTop: 8 }}>
                <Num label="Length" value={p.postroll.sec} min={5} max={300} suffix="seconds" onChange={(sec) => set({ postroll: { ...p.postroll, sec } })} />
              </div>}
            </div>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: 14 }}>
            <div className="field" style={{ margin: 0 }}><label>Ad server</label>
              <select className="inp" value={r.adServerId ?? ''} onChange={e => setR({ ...r, adServerId: e.target.value || null })}>
                <option value="">None: house spots only</option>
                {servers.map(s => <option key={s.id} value={s.id}>{s.name}{s.enabled ? '' : ' (off)'}</option>)}
              </select>
              <div className="hintxt">Asked for each break. Whatever it does not fill, or if it is slow, plays your house spots.</div></div>
            <div className="field" style={{ margin: 0 }}><label>How ads reach the player</label>
              <select className="inp" value={p.delivery} onChange={e => set({ delivery: e.target.value as Policy['delivery'] })}>
                <option value="auto">Automatic: guided where the player supports it, stitched otherwise</option>
                <option value="stitched">Stitched into the stream, for every player</option>
                <option value="guided">Guided (HLS Interstitials) where supported</option>
              </select></div>
          </div>

          <div className="field" style={{ margin: 0 }}><label>House spots</label>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
              {r.houseAds.map(h => {
                const s = spots.find(x => x.id === h.assetId)
                return <span key={h.assetId} className="chip" style={{ display: 'inline-flex', gap: 6, alignItems: 'center', padding: '3px 10px' }}>
                  {s ? `${s.title} · ${dur(s.durationSec)}` : 'Missing item'}
                  {canEdit && <button className="xbtn" aria-label="Remove house spot" onClick={() => setR({ ...r, houseAds: r.houseAds.filter(x => x.assetId !== h.assetId) })}>✕</button>}
                </span>
              })}
              {canEdit && <select className="inp" style={{ width: 'auto' }} value="" aria-label="Add a house spot"
                onChange={e => { if (e.target.value) setR({ ...r, houseAds: [...r.houseAds, { assetId: e.target.value }] }) }}>
                <option value="">+ Add a promo or sponsor spot</option>
                {spots.filter(s => !r.houseAds.some(h => h.assetId === s.id)).map(s => <option key={s.id} value={s.id}>{s.title} · {dur(s.durationSec)}</option>)}
              </select>}
            </div></div>

          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 18, fontSize: 'var(--fs-sm)' }}>
            <label style={{ display: 'flex', gap: 8, alignItems: 'center' }}><input type="checkbox" checked={p.adFreeFor.includes('entitlement')}
              onChange={e => set({ adFreeFor: e.target.checked ? [...new Set([...p.adFreeFor, 'entitlement' as const])] : p.adFreeFor.filter(x => x !== 'entitlement') })} />No ads for viewers who paid</label>
            <label style={{ display: 'flex', gap: 8, alignItems: 'center' }}><input type="checkbox" checked={p.adFreeFor.includes('members')}
              onChange={e => set({ adFreeFor: e.target.checked ? [...new Set([...p.adFreeFor, 'members' as const])] : p.adFreeFor.filter(x => x !== 'members') })} />No ads for signed-in members</label>
            <label style={{ display: 'flex', gap: 8, alignItems: 'center' }}><input type="checkbox" checked={p.snapback} onChange={e => set({ snapback: e.target.checked })} />Snapback: a skipped break plays before the seek lands</label>
          </div>
        </>}
      </div>
    </div>
  )
}

export default function VodAdsPage() {
  const [rules, setRules] = useState<{ default: Rule; contentTypes: Rule[] } | null>(null)
  const [servers, setServers] = useState<Server[]>([])
  const [spots, setSpots] = useState<Spot[]>([])
  const [types, setTypes] = useState<{ id: string; name: string }[]>([])
  const [report, setReport] = useState<Report | null>(null)
  const [err, setErr] = useState('')
  const [adding, setAdding] = useState(false)
  const [srv, setSrv] = useState({ name: '', tagTemplate: '' })
  const notify = useNotify()
  const { can } = useAccess()
  const canEdit = can('vod', 'manage')

  const load = () => {
    apiRequest('/vod/ads/rules').then(setRules).catch(e => setErr(e.message))
    apiRequest('/vod/ads/ad-servers').then(r => setServers(r.items)).catch(() => {})
    apiRequest('/vod/ads/house-candidates').then(r => setSpots(r.items)).catch(() => {})
    apiRequest('/metadata-schemas?appliesTo=vod').then(r => setTypes((Array.isArray(r) ? r : r.items ?? []).map((t: any) => ({ id: t.id, name: t.name })))).catch(() => {})
    apiRequest('/vod/ads/report?days=7').then(setReport).catch(() => {})
  }
  useEffect(load, [])
  usePageNotice('load', err ? { kind: 'error', title: "Couldn't load on-demand ads.", message: err, actions: [{ label: 'Retry', onClick: () => { setErr(''); load() } }] } : null)

  const save = async (r: Rule) => {
    const path = r.contentTypeId ? `/vod/ads/rules/content-type/${r.contentTypeId}` : '/vod/ads/rules/default'
    try {
      await apiRequest(path, { method: 'PUT', body: JSON.stringify({ mode: r.mode, policy: r.policy, adServerId: r.adServerId, houseAds: r.houseAds }) })
      notify({ kind: 'ok', message: 'Saved. New plays follow it; plays already started keep their ads.' })
      load()
    } catch (e: any) { notify({ kind: 'error', message: e.message }) }
  }
  const remove = async (id: string) => {
    try { await apiRequest(`/vod/ads/rules/content-type/${id}`, { method: 'DELETE' }); load() } catch (e: any) { notify({ kind: 'error', message: e.message }) }
  }
  const addServer = async () => {
    try {
      await apiRequest('/vod/ads/ad-servers', { method: 'POST', body: JSON.stringify(srv) })
      setAdding(false); setSrv({ name: '', tagTemplate: '' }); load()
    } catch (e: any) { notify({ kind: 'error', message: e.message }) }
  }
  const unused = types.filter(t => !rules?.contentTypes.some(r => r.contentTypeId === t.id))

  return (
    <>
      <PageHead title="On-demand ads" sub="Where the ad breaks go in on-demand titles, and who fills them: your ad server, then your house spots. Viewers who paid can play ad-free." />
      {report && <div className="stats">
        <div className="card stat"><div className="lbl">Plays with ads, 7 days</div><div className="val">{report.sessions}</div><div className="meta">{report.impressions} ads seen</div></div>
        <div className="card stat"><div className="lbl">Fill rate</div><div className="val">{pct(report.fillRate)}</div><div className="meta">house spots {pct(report.houseShare)}</div></div>
        <div className="card stat"><div className="lbl">Watched to the end</div><div className="val">{pct(report.completionRate)}</div><div className="meta">of ads started</div></div>
        <div className="card stat"><div className="lbl">Clicks</div><div className="val">{report.clicks}</div><div className="meta">{pct(report.clickRate)} of ads seen</div></div>
      </div>}
      {!rules ? <div className="loading">Loading…</div> : <>
        <RuleEditor rule={rules.default} servers={servers} spots={spots} canEdit={canEdit} onSave={save} />
        {rules.contentTypes.map(r => <RuleEditor key={r.contentTypeId!} rule={r} servers={servers} spots={spots} canEdit={canEdit} onSave={save} onRemove={() => remove(r.contentTypeId!)} />)}
        {canEdit && unused.length > 0 && (
          <div style={{ marginTop: 14 }}>
            <select className="inp" style={{ width: 'auto' }} value="" aria-label="Add a rule for a content type" onChange={e => {
              const t = types.find(x => x.id === e.target.value)
              if (t) setRules({ ...rules, contentTypes: [...rules.contentTypes, { ...rules.default, id: null, contentTypeId: t.id, contentTypeName: t.name }] })
            }}>
              <option value="">+ A different rule for a content type</option>
              {unused.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
            </select>
          </div>
        )}
        <div className="card" style={{ marginTop: 14 }}>
          <div className="card-h"><h3>Ad servers</h3><span className="sub">shared with FAST channels</span><span className="spacer" />
            {canEdit && <button className="btn ghost sm" onClick={() => setAdding(a => !a)}>{adding ? 'Cancel' : '+ Add ad server'}</button>}</div>
          <div className="card-b">
            {servers.length === 0 && !adding && <div className="hintxt">No ad server yet. Breaks are filled with your house spots until you add one.</div>}
            {servers.map(s => <div key={s.id} style={{ padding: '4px 0' }}><strong>{s.name}</strong> <span className="hintxt">{s.vendor.toUpperCase()}{s.enabled ? '' : ', off'}</span></div>)}
            {adding && <div style={{ display: 'grid', gap: 8, marginTop: 8 }}>
              <input className="inp" placeholder="Name, e.g. Google Ad Manager" value={srv.name} onChange={e => setSrv({ ...srv, name: e.target.value })} aria-label="Ad server name" />
              <input className="inp" placeholder="VAST tag URL, with macros such as [CACHEBUSTING]" value={srv.tagTemplate} onChange={e => setSrv({ ...srv, tagTemplate: e.target.value })} aria-label="VAST tag URL" />
              <div><button className="btn primary sm" disabled={!srv.name.trim() || !/^https?:\/\//.test(srv.tagTemplate)} onClick={addServer}>Add</button></div>
            </div>}
          </div>
        </div>
      </>}
    </>
  )
}
