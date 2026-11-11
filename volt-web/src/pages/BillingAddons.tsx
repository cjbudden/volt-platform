// ============================================================================
//  ADD-ONS ON THE BILLING PAGES (build queue B2-2; server: services/invoicing/
//  addons.ts, /api/billing/addons and /api/platform/billing/addons).
//
//  The account's side (AddonsSection, on Admin > Billing): what is offered,
//  what the account has on, how much of each allowance is used this month,
//  and turning on, changing the pack and turning off. Before each change the
//  drawer says exactly what it costs, from the same facts the server charges
//  by: the full month for an add-on or a bigger pack not yet paid this month,
//  nothing for one already paid, and no refund for a smaller pack or off.
//
//  The System Admin's side (AddonCatalogue, on the Billing tab): the
//  catalogue (add-ons, packs, price, included quantity, the licence an add-on
//  opens, whether it is offered) and how many accounts have each.
// ============================================================================
import { useEffect, useState } from 'react'
import { apiRequest as req } from '../api'
import { StatusTag } from '../scaffold'
import { Notice, FieldError } from '../notices'
import { Meter } from './PlanLimits'
import { usd, dayLabel, monthLabel } from './Billing'
import { Drawer, useSubmit } from './SystemBilling'

export interface Pack { key: string; name: string; extraQuantity: number; monthlyUsd: number; active: boolean; paidThisMonth?: boolean }
export interface AccountAddon {
  key: string; name: string; description: string | null; monthlyUsd: number; includedQuantity: number; unit: string; licence: string | null; offered: boolean
  packs: Pack[]; on: boolean; pack: string | null; since: string | null; paidThisMonth: boolean
  allowance: { period: string; included: number; used: number; left: number; resets: string } | null
}
interface CatalogueAddon { key: string; name: string; description: string | null; monthlyUsd: number; includedQuantity: number; unit: string; licence: string | null; active: boolean; packs: Pack[]; accounts: number }

export const LICENCE_LABEL: Record<string, string> = { hybrid_sites: 'Hybrid Sites', mirror_archive: 'Mirror and Archive' }
const n = (x: number) => Number(x.toFixed(3)).toLocaleString('en-US')
const thisMonth = () => monthLabel(new Date().toISOString().slice(0, 7))

const PlugIcon = () => <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d="M9 2v6M15 2v6M6 8h12v4a6 6 0 01-12 0zM12 18v4" /></svg>
const PowerIcon = () => <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d="M12 3v9M6.4 6.4a8 8 0 1011.2 0" /></svg>
const SwapIcon = () => <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d="M7 4L3 8l4 4M3 8h14M17 20l4-4-4-4M21 16H7" /></svg>
const PlusIcon = () => <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg>

// ---- the account's side ------------------------------------------------------

export function AddonsSection({ mode, canManage }: { mode: 'off' | 'contract' | 'automated'; canManage: boolean }) {
  const [list, setList] = useState<AccountAddon[] | null>(null)
  const [err, setErr] = useState('')
  const [open, setOpen] = useState<{ a: AccountAddon; kind: 'on' | 'change' | 'off' } | null>(null)
  const load = () => req('/billing/addons').then((v: any) => { setList(v.addons); setErr('') }, (e: any) => setErr(e?.message || 'Could not load the add-ons'))
  useEffect(() => { load() }, [])
  if (err) return <><div className="sec-head"><h2>Add-ons</h2></div><Notice kind="error" variant="compact" message={err} actions={[{ label: 'Retry', onClick: () => { load() } }]} /></>
  if (!list) return null
  if (!list.length && mode === 'off') return null
  const off = mode === 'off'
  return (
    <>
      <div className="sec-head"><h2>Add-ons</h2></div>
      {off && <div style={{ marginBottom: 12 }}><Notice kind="info" variant="compact" message="On this deployment add-ons are switched on by your Volt provider." /></div>}
      {list.length === 0 ? (
        <div className="empty"><div className="ic"><PlugIcon /></div><h3>No add-ons offered</h3><p>Your Volt provider has no add-ons on offer yet.</p></div>
      ) : (
        <div className="addon-list">
          {list.map(a => {
            const pack = a.packs.find(p => p.key === a.pack) ?? null
            return (
              <div className="card addon-card" key={a.key}>
                <div className="addon-head">
                  <span className="bill-pay-ic"><PlugIcon /></span>
                  <div className="addon-t">
                    <div className="addon-name"><b>{a.name}</b>{a.on ? <StatusTag label="On" cls="live" sub={pack ? pack.name : undefined} /> : <StatusTag label="Off" cls="idle" />}</div>
                    {a.description && <div className="hintxt">{a.description}</div>}
                    <div className="hintxt">{usd(a.monthlyUsd)} a month, includes {n(a.includedQuantity)} {a.unit}{a.packs.length ? `. Packs from ${usd(Math.min(...a.packs.map(p => p.monthlyUsd)))} a month add more.` : '.'}</div>
                  </div>
                  {!off && canManage && (
                    <div className="bill-actions addon-actions">
                      {a.on ? <>
                        {a.packs.length > 0 && <button className="btn ghost" onClick={() => setOpen({ a, kind: 'change' })}><SwapIcon />Change pack</button>}
                        <button className="btn ghost" onClick={() => setOpen({ a, kind: 'off' })}><PowerIcon />Turn off</button>
                      </> : a.offered && <button className="btn" onClick={() => setOpen({ a, kind: 'on' })}><PowerIcon />Turn on</button>}
                    </div>
                  )}
                </div>
                {a.on && a.allowance && (
                  <div className="addon-use">
                    <Meter total={a.allowance.included} label={`${a.name} used this month`} parts={[{ n: a.allowance.used, cls: a.allowance.left <= 0 ? 'given' : 'tv', label: `${a.unit} used` }]} />
                    <div className="hintxt">
                      {n(a.allowance.used)} of {n(a.allowance.included)} {a.unit} used this month, {n(a.allowance.left)} left. Starts again on {dayLabel(a.allowance.resets)}; what is left does not carry over.
                    </div>
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}
      {!off && !canManage && list.length > 0 && <p className="hintxt">Turning add-ons on or off needs Account settings: Manage.</p>}
      {open && <AddonDrawer a={open.a} kind={open.kind} onClose={() => setOpen(null)} onDone={() => { setOpen(null); load() }} />}
    </>
  )
}

/** What a choice costs now, in the server's own terms (services/invoicing/addons.ts). */
export function effectOf(a: AccountAddon, kind: 'on' | 'change', choice: string | null): string {
  const month = thisMonth()
  const to = a.packs.find(p => p.key === choice) ?? null
  if (kind === 'on') {
    const parts: string[] = []
    let now = 0
    if (!a.paidThisMonth) now += a.monthlyUsd; else parts.push(`${a.name} is already paid for ${month}`)
    if (to) { if (!to.paidThisMonth) now += to.monthlyUsd; else parts.push(`${to.name} is already paid for ${month}`) }
    const head = now > 0 ? `${usd(now)} is charged now for ${month} (the full month).` : `Nothing more to pay for ${month}.`
    return `${head}${parts.length ? ` ${parts.join('; ')}.` : ''} From the 1st it is ${usd(a.monthlyUsd + (to?.monthlyUsd ?? 0))} a month until you turn it off.`
  }
  const from = a.packs.find(p => p.key === a.pack) ?? null
  if ((from?.key ?? null) === (to?.key ?? null)) return 'This is the pack you have.'
  const bigger = (to?.extraQuantity ?? 0) > (from?.extraQuantity ?? 0)
  if (bigger) return to!.paidThisMonth
    ? `${to!.name} is already paid for ${month}, so nothing more is charged now. The bigger allowance starts at once.`
    : `${usd(to!.monthlyUsd)} is charged now for ${month} (the full month). The bigger allowance starts at once.`
  return `The smaller allowance starts at once. Nothing is refunded for the rest of ${month}. From the 1st it is ${usd(a.monthlyUsd + (to?.monthlyUsd ?? 0))} a month.`
}

function AddonDrawer({ a, kind, onClose, onDone }: { a: AccountAddon; kind: 'on' | 'change' | 'off'; onClose: () => void; onDone: () => void }) {
  const [choice, setChoice] = useState<string | null>(kind === 'change' ? a.pack : null)
  const s = useSubmit(onDone)
  const offered = a.packs.filter(p => p.active || p.key === a.pack)
  if (kind === 'off') {
    return (
      <Drawer title={`Turn off ${a.name}`} err={s.err} busy={s.busy} okLabel="Turn off" danger
        onClose={onClose} onOk={() => s.run(async () => { await req(`/billing/addons/${a.key}`, { method: 'DELETE' }); return `${a.name} is off.` })}>
        <p>{a.name} stops at once. Nothing is refunded for the rest of {thisMonth()}, and it is not charged again from the 1st.</p>
        {a.licence && <p className="hintxt">{LICENCE_LABEL[a.licence] ?? a.licence} closes with it, unless your account has it under its own agreement.</p>}
        {a.allowance && a.allowance.used > 0 && <p className="hintxt">{n(a.allowance.used)} {a.unit} used this month.</p>}
      </Drawer>
    )
  }
  const effect = effectOf(a, kind, choice)
  const same = kind === 'change' && (choice ?? null) === (a.pack ?? null)
  return (
    <Drawer title={kind === 'on' ? `Turn on ${a.name}` : `Change the ${a.name} pack`} err={s.err} busy={s.busy}
      okLabel={kind === 'on' ? 'Turn on' : 'Change pack'} okDisabled={same}
      onClose={onClose} onOk={() => s.run(async () => {
        const r = await req(`/billing/addons/${a.key}`, { method: 'PUT', body: JSON.stringify({ pack: choice }) })
        const paid = (r.charged ?? []).reduce((t: number, c: any) => t + Number(c.amountUsd), 0)
        return kind === 'on' ? `${a.name} is on.${paid ? ` ${usd(paid)} charged for ${thisMonth()}.` : ''}` : `Pack changed.${paid ? ` ${usd(paid)} charged for ${thisMonth()}.` : ''}`
      })}>
      {a.description && <p className="hintxt" style={{ marginTop: 0 }}>{a.description}</p>}
      <div role="radiogroup" aria-label="Pack" style={{ display: 'grid', gap: 8 }}>
        <label className="toggle-row addon-opt" data-sel={choice === null || undefined}>
          <input type="radio" name="addon-pack" checked={choice === null} onChange={() => setChoice(null)} />
          <div><div className="tt">{kind === 'on' ? `${a.name} on its own` : 'No pack'}{kind === 'change' && a.pack === null && <span className="tag type" style={{ marginLeft: 8 }}>current</span>}</div>
            <div className="td">Includes {n(a.includedQuantity)} {a.unit} a month{kind === 'on' ? `, ${usd(a.monthlyUsd)} a month` : ''}</div></div>
        </label>
        {offered.map(p => (
          <label key={p.key} className="toggle-row addon-opt" data-sel={choice === p.key || undefined}>
            <input type="radio" name="addon-pack" checked={choice === p.key} onChange={() => setChoice(p.key)} />
            <div><div className="tt">{p.name}{kind === 'change' && a.pack === p.key && <span className="tag type" style={{ marginLeft: 8 }}>current</span>}</div>
              <div className="td">{n(a.includedQuantity + p.extraQuantity)} {a.unit} a month in all (+{n(p.extraQuantity)}), {usd(p.monthlyUsd)} a month on top</div></div>
          </label>
        ))}
      </div>
      <div className="addon-effect" role="status">{effect}</div>
      <p className="hintxt">The included quantity starts again on the 1st of each month; what is left does not carry over. Charges appear on the monthly invoice.</p>
    </Drawer>
  )
}

// ---- the System Admin's side ------------------------------------------------------

const P = '/platform/billing'

export function AddonCatalogue() {
  const [cat, setCat] = useState<CatalogueAddon[] | null>(null)
  const [err, setErr] = useState('')
  const [edit, setEdit] = useState<CatalogueAddon | 'new' | null>(null)
  const [pack, setPack] = useState<{ a: CatalogueAddon; p: Pack | null } | null>(null)
  const load = () => req(`${P}/addons`).then((v: CatalogueAddon[]) => { setCat(v); setErr('') }, (e: any) => setErr(e?.message || 'Could not load the add-ons'))
  useEffect(() => { load() }, [])
  return (
    <>
      <div className="sec-head">
        <h2>Add-ons</h2>
        <button className="btn ghost" onClick={() => setEdit('new')}><PlusIcon />Add an add-on</button>
      </div>
      {err && <Notice kind="error" variant="compact" message={err} actions={[{ label: 'Retry', onClick: () => { load() } }]} />}
      {cat && cat.length === 0 && <div className="empty"><h3>No add-ons yet</h3><p>Add one to offer it to accounts. Each has a monthly price, an included quantity and optional packs that add more.</p></div>}
      {cat && cat.length > 0 && (
        <div className="card">
          <table>
            <thead><tr><th>Add-on</th><th className="num">Per month</th><th>Includes</th><th>Packs</th><th>Accounts</th><th></th></tr></thead>
            <tbody>
              {cat.map(a => (
                <tr key={a.key}>
                  <td><b>{a.name}</b><div className="hintxt">{a.key}{a.licence ? `, opens ${LICENCE_LABEL[a.licence] ?? a.licence}` : ''}</div>{!a.active && <StatusTag label="Not offered" cls="idle" />}</td>
                  <td className="num">{usd(a.monthlyUsd)}</td>
                  <td>{n(a.includedQuantity)} {a.unit}</td>
                  <td>
                    <div className="addon-packs">
                      {a.packs.map(p => <button key={p.key} className="btn ghost sm" onClick={() => setPack({ a, p })} aria-label={`Edit pack ${p.name}`}>{p.name}: +{n(p.extraQuantity)}, {usd(p.monthlyUsd)}{!p.active ? ' (not offered)' : ''}</button>)}
                      <button className="btn ghost sm" onClick={() => setPack({ a, p: null })}><PlusIcon />Pack</button>
                    </div>
                  </td>
                  <td>{a.accounts}</td>
                  <td style={{ textAlign: 'right' }}><button className="btn ghost" onClick={() => setEdit(a)}>Edit</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {edit && <AddonEditDrawer a={edit === 'new' ? null : edit} onClose={() => setEdit(null)} onDone={() => { setEdit(null); load() }} />}
      {pack && <PackDrawer a={pack.a} p={pack.p} onClose={() => setPack(null)} onDone={() => { setPack(null); load() }} />}
    </>
  )
}

function AddonEditDrawer({ a, onClose, onDone }: { a: CatalogueAddon | null; onClose: () => void; onDone: () => void }) {
  const [key, setKey] = useState(a?.key ?? '')
  const [name, setName] = useState(a?.name ?? '')
  const [description, setDescription] = useState(a?.description ?? '')
  const [price, setPrice] = useState(a ? String(a.monthlyUsd) : '')
  const [included, setIncluded] = useState(a ? String(a.includedQuantity) : '')
  const [unit, setUnit] = useState(a?.unit ?? '')
  const [licence, setLicence] = useState(a?.licence ?? '')
  const [active, setActive] = useState(a?.active ?? true)
  const s = useSubmit(onDone)
  const keyErr = a || key === '' || /^[a-z0-9_]{2,40}$/.test(key) ? '' : '2 to 40 lower-case letters, digits or _.'
  const p = Number(price), q = Number(included)
  const ok = !keyErr && (a || key) && name.trim() && unit.trim() && price.trim() !== '' && p >= 0 && included.trim() !== '' && q >= 0
  return (
    <Drawer title={a ? `Edit ${a.name}` : 'Add an add-on'} err={s.err} busy={s.busy} okLabel={a ? 'Save' : 'Add add-on'} okDisabled={!ok}
      onClose={onClose} onOk={() => s.run(async () => {
        const body = { name: name.trim(), description: description.trim() || null, monthlyUsd: p, includedQuantity: q, unit: unit.trim(), licence: licence || null, active }
        if (a) await req(`${P}/addons/${a.key}`, { method: 'PATCH', body: JSON.stringify(body) })
        else await req(`${P}/addons`, { method: 'POST', body: JSON.stringify({ key, ...body }) })
        return a ? `${name.trim()} saved.` : `${name.trim()} added.`
      })}>
      {!a && <div className={`field${keyErr ? ' has-err' : ''}`}><label htmlFor="ad-k">Key <span className="req">*</span></label>
        <input id="ad-k" className="inp" value={key} onChange={e => setKey(e.target.value)} placeholder="archive_storage" />
        <FieldError>{keyErr}</FieldError><div className="hintxt">Used by the API. It cannot be changed later.</div></div>}
      <div className="field"><label htmlFor="ad-n">Name <span className="req">*</span></label><input id="ad-n" className="inp" maxLength={120} value={name} onChange={e => setName(e.target.value)} placeholder="Archive storage" /></div>
      <div className="field"><label htmlFor="ad-d">Description</label><input id="ad-d" className="inp" maxLength={500} value={description} onChange={e => setDescription(e.target.value)} placeholder="Copies of your media kept in your own store" /></div>
      <div className="field"><label htmlFor="ad-p">Price per month (USD) <span className="req">*</span></label><input id="ad-p" className="inp" inputMode="decimal" value={price} onChange={e => setPrice(e.target.value)} placeholder="50.00" /></div>
      <div className="field"><label htmlFor="ad-q">Included each month <span className="req">*</span></label><input id="ad-q" className="inp" inputMode="decimal" value={included} onChange={e => setIncluded(e.target.value)} placeholder="100" /></div>
      <div className="field"><label htmlFor="ad-u">Unit <span className="req">*</span></label><input id="ad-u" className="inp" maxLength={40} value={unit} onChange={e => setUnit(e.target.value)} placeholder="GB" /></div>
      <div className="field"><label htmlFor="ad-l">Opens</label>
        <select id="ad-l" className="inp" value={licence} onChange={e => setLicence(e.target.value)}>
          <option value="">Nothing (charge only)</option>
          {Object.entries(LICENCE_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
        <div className="hintxt">Turning the add-on on gives the account this feature; turning it off takes it away, unless you had already given it to the account.</div>
      </div>
      <label className="toggle-row"><input type="checkbox" checked={active} onChange={e => setActive(e.target.checked)} /><div><div className="tt">Offered to accounts</div><div className="td">Not offered: no new account can turn it on. Accounts that have it keep it, and it renews, until they turn it off.</div></div></label>
      {a && <p className="hintxt">A new price applies from the next charge (a turn-on, a bigger pack or the next 1st). Charges already made keep their price.</p>}
    </Drawer>
  )
}

function PackDrawer({ a, p, onClose, onDone }: { a: CatalogueAddon; p: Pack | null; onClose: () => void; onDone: () => void }) {
  const [key, setKey] = useState(p?.key ?? '')
  const [name, setName] = useState(p?.name ?? '')
  const [extra, setExtra] = useState(p ? String(p.extraQuantity) : '')
  const [price, setPrice] = useState(p ? String(p.monthlyUsd) : '')
  const [active, setActive] = useState(p?.active ?? true)
  const s = useSubmit(onDone)
  const keyErr = p || key === '' || /^[a-z0-9_]{1,40}$/.test(key) ? '' : 'Lower-case letters, digits or _.'
  const x = Number(extra), pr = Number(price)
  const ok = !keyErr && (p || key) && name.trim() && x > 0 && price.trim() !== '' && pr >= 0
  return (
    <Drawer title={p ? `Edit ${p.name}` : `Add a pack to ${a.name}`} err={s.err} busy={s.busy} okLabel={p ? 'Save' : 'Add pack'} okDisabled={!ok}
      onClose={onClose} onOk={() => s.run(async () => {
        const body = { name: name.trim(), extraQuantity: x, monthlyUsd: pr, active }
        if (p) await req(`${P}/addons/${a.key}/packs/${p.key}`, { method: 'PATCH', body: JSON.stringify(body) })
        else await req(`${P}/addons/${a.key}/packs`, { method: 'POST', body: JSON.stringify({ key, ...body }) })
        return p ? `${name.trim()} saved.` : `${name.trim()} added.`
      })}>
      {!p && <div className={`field${keyErr ? ' has-err' : ''}`}><label htmlFor="pk-k">Key <span className="req">*</span></label>
        <input id="pk-k" className="inp" value={key} onChange={e => setKey(e.target.value)} placeholder="large" /><FieldError>{keyErr}</FieldError></div>}
      <div className="field"><label htmlFor="pk-n">Name <span className="req">*</span></label><input id="pk-n" className="inp" maxLength={120} value={name} onChange={e => setName(e.target.value)} placeholder="Large pack" /></div>
      <div className="field"><label htmlFor="pk-x">Adds each month ({a.unit}) <span className="req">*</span></label><input id="pk-x" className="inp" inputMode="decimal" value={extra} onChange={e => setExtra(e.target.value)} placeholder="500" /></div>
      <div className="field"><label htmlFor="pk-p">Price per month (USD) <span className="req">*</span></label><input id="pk-p" className="inp" inputMode="decimal" value={price} onChange={e => setPrice(e.target.value)} placeholder="60.00" /></div>
      <label className="toggle-row"><input type="checkbox" checked={active} onChange={e => setActive(e.target.checked)} /><div><div className="tt">Offered to accounts</div><div className="td">Not offered: no one new can choose it; whoever has it keeps it.</div></div></label>
      <p className="hintxt">Packs are ordered by what they add: moving to one that adds more charges its full month; moving to one that adds less is at once with no refund.</p>
    </Drawer>
  )
}

/** The add-ons one account has on, for the System Admin's account drawer. */
export function AccountAddonsList({ accountId }: { accountId: string }) {
  const [list, setList] = useState<AccountAddon[] | null>(null)
  useEffect(() => { req(`${P}/accounts/${accountId}/addons`).then(setList, () => setList([])) }, [accountId])
  if (!list) return null
  const on = list.filter(a => a.on)
  return (
    <div className="field"><label>Add-ons on</label>
      {on.length === 0 ? <div className="hintxt">None.</div> : on.map(a => (
        <div key={a.key} className="hintxt">{a.name}{a.pack ? `, ${a.packs.find(p => p.key === a.pack)?.name ?? a.pack}` : ''}: {n(a.allowance?.used ?? 0)} of {n(a.allowance?.included ?? 0)} {a.unit} used this month</div>
      ))}
    </div>
  )
}
