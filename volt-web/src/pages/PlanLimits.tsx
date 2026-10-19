// ============================================================================
//  PLAN & LIMITS (Admin > Plan & limits, docs/PLAN_AND_GROUPS.md).
//
//  The account's plan: how many channels and stations it may have in all, and
//  how many may run at once; what is used; and how the channel groups share it
//  out. The plan is changed by a system administrator, or by the account owner
//  in a single-client deployment. Sharing it out between groups is done on
//  Channel groups by account administrators.
// ============================================================================
import { useEffect, useState } from 'react'
import { api, type PlanView } from '../api'
import { PageHead } from '../scaffold'
import { navigate } from '../router'
import { usePageNotice, useNotify, FormStatus, FieldError } from '../notices'

const TIERS = ['standard', 'pro', 'enterprise']
const tierLabel = (t: string) => t ? t.charAt(0).toUpperCase() + t.slice(1) : '—'

/** A meter: used (TV and radio), then given out, against the whole. */
export function Meter({ parts, total, label }: { parts: { n: number; cls: string; label: string }[]; total: number; label: string }) {
  const sum = parts.reduce((a, p) => a + p.n, 0)
  return (
    <div className="meter" role="img" aria-label={`${label}: ${parts.map(p => `${p.n} ${p.label}`).join(', ')} of ${total}`}>
      {parts.map(p => p.n > 0 && <span key={p.label} className={`meter-seg ${p.cls}`} style={{ width: `${Math.min(100, (p.n / Math.max(1, total)) * 100)}%` }} />)}
      {sum > total && <span className="meter-over" />}
    </div>
  )
}

export default function PlanLimits() {
  const [plan, setPlan] = useState<PlanView | null>(null)
  const [err, setErr] = useState('')
  const [editing, setEditing] = useState(false)
  const load = () => api.plan().then(p => { setPlan(p); setErr('') }).catch((e: any) => setErr(e?.message || 'Could not load the plan'))
  useEffect(() => { load() }, [])
  usePageNotice('load', err ? { kind: 'error', title: "Couldn't load the plan.", message: err, actions: [{ label: 'Retry', onClick: () => { load() } }] } : null)
  usePageNotice('who', plan && !plan.canEdit ? { kind: 'info', message: plan.editReason ?? 'You can see the plan but not change it.' } : null)
  usePageNotice('full', plan && plan.used.total >= plan.maxChannels
    ? { kind: 'warn', title: 'The plan is used up.', message: `All ${plan.maxChannels} channels and stations are in use, so new ones cannot be created until one is removed or the plan is raised.` }
    : null)

  if (!plan) return <><PageHead title="Plan & limits" sub="What this account is allowed, and how the channel groups share it." />{!err && <div className="loading">Loading the plan…</div>}</>
  const u = plan.used
  return (
    <>
      <PageHead title="Plan & limits" sub="What this account is allowed, and how the channel groups share it." />

      <div className="card plan-card">
        <div className="plan-head">
          <div>
            <div className="plan-k">Plan</div>
            <div className="plan-name">{tierLabel(plan.planTier)}</div>
            <div className="hintxt">{plan.deployment === 'single' ? 'Single-client deployment: the account owner sets the plan.' : 'Set by your platform provider.'}</div>
          </div>
          {plan.canEdit && <button className="btn primary" onClick={() => setEditing(true)}>Change plan</button>}
        </div>
        <div className="plan-tiles">
          <div className="plan-tile">
            <div className="plan-k">Channels and stations</div>
            <div className="plan-v"><b>{u.total}</b> of {plan.maxChannels} in use</div>
            <Meter total={plan.maxChannels} label="Channels and stations" parts={[{ n: u.tv, cls: 'tv', label: 'TV channels' }, { n: u.radio, cls: 'radio', label: 'radio stations' }]} />
            <div className="plan-legend"><span><i className="tv" />{u.tv} TV</span><span><i className="radio" />{u.radio} radio</span><span><i />{Math.max(0, plan.maxChannels - u.total)} free</span></div>
          </div>
          <div className="plan-tile">
            <div className="plan-k">Shared out to groups</div>
            <div className="plan-v"><b>{plan.allocated}</b> of {plan.maxChannels} given out</div>
            <Meter total={plan.maxChannels} label="Given out to groups" parts={[{ n: plan.allocated, cls: 'given', label: 'given to groups' }]} />
            <div className="plan-legend"><span><i className="given" />{plan.allocated} given</span><span><i />{plan.unallocated} not given out</span></div>
          </div>
          <div className="plan-tile">
            <div className="plan-k">Running at once</div>
            <div className="plan-v"><b>{u.running}</b> of {plan.maxConcurrent} running now</div>
            <Meter total={plan.maxConcurrent} label="Running at once" parts={[{ n: u.running, cls: 'live', label: 'running' }]} />
            <div className="plan-legend"><span><i className="live" />{u.running} running</span><span>{u.events} event{u.events === 1 ? '' : 's'} (not counted in the plan)</span></div>
          </div>
        </div>
      </div>

      <div className="sec-head">
        <h2>How the groups share the plan</h2>
        <button className="btn ghost" onClick={() => navigate('/groups')}>{plan.canManageGroups ? 'Manage groups' : 'View groups'}</button>
      </div>
      <div className="card">
        <table>
          <thead><tr><th>Group</th><th>Channels and stations</th><th style={{ width: '34%' }}>Use of its share</th><th>Running at once</th></tr></thead>
          <tbody>
            {plan.groups.map(g => (
              <tr key={g.id}>
                <td><b>{g.name}</b>{g.is_default && <span className="tag idle" style={{ marginLeft: 8 }}>Default</span>}</td>
                <td>{g.used} of {g.max_channels}{g.radio ? <span className="hintxt"> ({g.used - g.radio} TV, {g.radio} radio)</span> : null}</td>
                <td><Meter total={g.max_channels} label={`${g.name} use`} parts={[{ n: g.used - g.radio, cls: 'tv', label: 'TV' }, { n: g.radio, cls: 'radio', label: 'radio' }]} /></td>
                <td>{g.max_concurrent}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {editing && <PlanDrawer plan={plan} onClose={() => setEditing(false)} onSaved={p => { setPlan(p); setEditing(false) }} />}
    </>
  )
}

function PlanDrawer({ plan, onClose, onSaved }: { plan: PlanView; onClose: () => void; onSaved: (p: PlanView) => void }) {
  const notify = useNotify()
  const custom = !TIERS.includes(plan.planTier)
  const [tier, setTier] = useState(custom ? 'custom' : plan.planTier)
  const [customName, setCustomName] = useState(custom ? plan.planTier : '')
  const [max, setMax] = useState(String(plan.maxChannels))
  const [conc, setConc] = useState(String(plan.maxConcurrent))
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  const floor = Math.max(plan.used.total, plan.allocated)
  const concFloor = Math.max(1, ...plan.groups.map(g => g.max_concurrent))
  const maxN = Number(max), concN = Number(conc)
  const maxErr = !Number.isInteger(maxN) || maxN < 1 ? 'A whole number, 1 or more.'
    : maxN < floor ? `At least ${floor}: ${plan.used.total} exist and the groups are given ${plan.allocated}.` : ''
  const concErr = !Number.isInteger(concN) || concN < 1 ? 'A whole number, 1 or more.'
    : concN < concFloor ? `At least ${concFloor}: a group is allowed ${concFloor} running at once.` : ''
  const name = tier === 'custom' ? customName.trim() : tier

  async function save() {
    setErr('')
    if (maxErr || concErr || !name) { setErr('Check the highlighted fields.'); return }
    setBusy(true)
    try {
      const p = await api.patchPlan({ planTier: name, maxChannels: maxN, maxConcurrent: concN })
      notify({ kind: 'ok', message: `Plan saved: ${tierLabel(p.planTier)}, ${p.maxChannels} channels and stations, ${p.maxConcurrent} running at once.` })
      onSaved(p)
    } catch (e: any) { setErr(e?.message || 'The plan could not be saved.') } finally { setBusy(false) }
  }

  return (
    <div className="drawer-scrim" onClick={e => { if (e.target === e.currentTarget && !busy) onClose() }}>
      <div className="drawer" role="dialog" aria-modal="true" aria-labelledby="plan-t" onKeyDown={e => { if (e.key === 'Escape' && !busy) onClose() }}>
        <div className="drawer-h"><div className="t" id="plan-t">Change plan</div><button className="xbtn" onClick={onClose} aria-label="Close">✕</button></div>
        <div className="drawer-b">
          <div className="field"><label htmlFor="plan-tier">Plan</label>
            <select id="plan-tier" className="inp" value={tier} onChange={e => setTier(e.target.value)}>
              {TIERS.map(t => <option key={t} value={t}>{tierLabel(t)}</option>)}
              <option value="custom">Custom…</option>
            </select>
            {tier === 'custom' && <input className="inp" style={{ marginTop: 8 }} value={customName} maxLength={60} onChange={e => setCustomName(e.target.value)} placeholder="Plan name, e.g. Broadcast 30" aria-label="Custom plan name" />}
          </div>
          <div className={`field${maxErr ? ' has-err' : ''}`}><label htmlFor="plan-max">Channels and stations allowed <span className="req">*</span></label>
            <input id="plan-max" className="inp" type="number" min={floor} value={max} onChange={e => setMax(e.target.value)} />
            <FieldError>{maxErr}</FieldError>
            <div className="hintxt">TV channels and radio stations together. {plan.used.total} exist; the groups are given {plan.allocated} between them. Events are not counted.</div>
          </div>
          <div className={`field${concErr ? ' has-err' : ''}`}><label htmlFor="plan-conc">Running at once <span className="req">*</span></label>
            <input id="plan-conc" className="inp" type="number" min={concFloor} value={conc} onChange={e => setConc(e.target.value)} />
            <FieldError>{concErr}</FieldError>
            <div className="hintxt">How many channels and stations may run at the same time across the account.</div>
          </div>
        </div>
        <div className="drawer-f">
          <FormStatus error={err} />
          <button className="btn ghost" onClick={onClose} disabled={busy}>Cancel</button>
          <button className="btn primary" onClick={save} disabled={busy || !!maxErr || !!concErr || !name}>{busy ? 'Saving…' : 'Save plan'}</button>
        </div>
      </div>
    </div>
  )
}
