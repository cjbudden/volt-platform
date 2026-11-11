// ============================================================================
//  SYSTEM ADMIN > BILLING (build queue B1-3; server: modules/billing.ts,
//  /api/platform/billing).
//
//  The SaaS provider's side of billing: how each account settles its invoices
//  and at what tax rate, the invoices still open (mark a contract invoice paid
//  with the payment's reference), charges and credits added by hand, the price
//  list for server time, and closing a month by hand (the scheduler closes the
//  month before on the 1st by itself; the button is for a re-run or a single
//  account). Every change is in the audit log on the server.
//
//  Prices are only ever added: a new price with a later effective date
//  replaces the old one from that date, so an invoice already issued is never
//  re-priced.
//
//  The add-on catalogue (build queue B2-2) is in BillingAddons.tsx.
// ============================================================================
import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { apiRequest as req } from '../api'
import { StatusTag } from '../scaffold'
import { FormStatus, Notice, useNotify, FieldError } from '../notices'
import { usd, unitPrice, pct, monthLabel, dayLabel, InvoiceStatus, InvoiceDrawer, DownloadButtons, useEscape, type Invoice } from './Billing'
import { AddonCatalogue, AccountAddonsList } from './BillingAddons'

interface Acc { id: string; name: string; status: string; plan: string; handling: 'automated' | 'contract'; storedHandling: string; taxRate: number | null; ownFeeUsd: number | null; openInvoices: number; openUsd: number }
interface Overview { mode: 'off' | 'contract' | 'automated'; taxRate: number; currency: string; openMonth: string; lastClosable: string; accounts: Acc[] }
type AdminInvoice = Invoice & { accountName: string; stripeInvoiceId: string | null; stripeError: string | null; stripeAttempts: number }
interface Price { id: string; unitKey: 'server_hour' | 'gb_delivered'; instanceType: string | null; name: string; unit: string; unitUsd: number; effectiveFrom: string }

const P = '/platform/billing'
const J = (b: unknown) => ({ method: 'POST', body: JSON.stringify(b) })
const MODE_LABEL = { off: 'Off: nothing is charged or invoiced', contract: 'Contract: invoices are issued and settled outside Volt', automated: 'Automated: invoices are charged through Stripe' }

export function BillingAdmin() {
  const [ov, setOv] = useState<Overview | null>(null)
  const [invoices, setInvoices] = useState<AdminInvoice[]>([])
  const [prices, setPrices] = useState<Price[]>([])
  const [err, setErr] = useState('')
  const [invFilter, setInvFilter] = useState<'open' | 'all'>('open')
  const [editAcc, setEditAcc] = useState<Acc | null>(null)
  const [charge, setCharge] = useState(false)
  const [paying, setPaying] = useState<AdminInvoice | null>(null)
  const [priceOpen, setPriceOpen] = useState(false)
  const [closeOpen, setCloseOpen] = useState(false)
  const [viewing, setViewing] = useState<AdminInvoice | null>(null)

  const load = async () => {
    try {
      const [o, i, p] = await Promise.all([req(P), req(`${P}/invoices`), req(`${P}/prices`)])
      setOv(o); setInvoices(i); setPrices(p); setErr('')
    } catch (e: any) { setErr(e?.message || 'Could not load billing') }
  }
  useEffect(() => { load() }, [])
  const shownInv = useMemo(() => invFilter === 'open' ? invoices.filter(i => i.status === 'issued' || i.status === 'failed') : invoices, [invoices, invFilter])

  if (err) return <Notice kind="error" title="Couldn't load billing." message={err} actions={[{ label: 'Retry', onClick: () => { load() } }]} />
  if (!ov) return <div className="loading">Loading billing…</div>
  const off = ov.mode === 'off'
  return (
    <>
      <div className="card plan-card">
        <div className="plan-head">
          <div>
            <div className="plan-k">Billing on this deployment</div>
            <div className="plan-name" style={{ fontSize: 18 }}>{MODE_LABEL[ov.mode]}</div>
            <div className="hintxt">Set by the deployment (VOLT_BILLING). Default tax rate {pct(ov.taxRate)}. Amounts in {ov.currency}. The scheduler closes {monthLabel(ov.lastClosable)} on the 1st by itself.</div>
          </div>
          <div className="bill-actions">
            <button className="btn ghost" disabled={off} onClick={() => setCharge(true)}>Add charge or credit</button>
            <button className="btn primary" disabled={off} onClick={() => setCloseOpen(true)}>Close a month</button>
          </div>
        </div>
        {off && <Notice kind="info" variant="compact" message="Billing is off, so nothing can be charged or closed. Accounts, invoices issued earlier and the price list can still be seen and set." />}
      </div>

      <div className="sec-head"><h2>Accounts</h2></div>
      <div className="card">
        <table>
          <thead><tr><th>Account</th><th>Paid by</th><th>Tax rate</th><th>Plan fee</th><th>Open invoices</th><th></th></tr></thead>
          <tbody>
            {ov.accounts.map(a => (
              <tr key={a.id}>
                <td><b>{a.name}</b><div className="hintxt" style={{ textTransform: 'capitalize' }}>{a.plan}{a.status === 'suspended' ? ', suspended' : ''}</div></td>
                <td>{a.handling === 'automated' ? 'Card (Stripe)' : 'Contract'}{a.handling !== a.storedHandling && <div className="hintxt">Contract deployment</div>}</td>
                <td>{a.taxRate == null ? <span className="hintxt">Default ({pct(ov.taxRate)})</span> : pct(a.taxRate)}</td>
                <td>{a.ownFeeUsd != null ? `${usd(a.ownFeeUsd)} agreed` : <span className="hintxt">From the plan</span>}</td>
                <td>{a.openInvoices ? <>{a.openInvoices}, {usd(a.openUsd)}</> : <span className="hintxt">None</span>}</td>
                <td style={{ textAlign: 'right' }}><button className="btn ghost" onClick={() => setEditAcc(a)}>Edit</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="sec-head">
        <h2>Invoices</h2>
        <div className="chipset" role="tablist">
          <button role="tab" aria-selected={invFilter === 'open'} className={`selchip ${invFilter === 'open' ? 'sel' : ''}`} onClick={() => setInvFilter('open')}>Open</button>
          <button role="tab" aria-selected={invFilter === 'all'} className={`selchip ${invFilter === 'all' ? 'sel' : ''}`} onClick={() => setInvFilter('all')}>All</button>
        </div>
      </div>
      {shownInv.length === 0 ? (
        <div className="empty"><h3>{invFilter === 'open' ? 'No open invoices' : 'No invoices yet'}</h3><p>{invFilter === 'open' ? 'Every issued invoice is paid.' : 'Invoices appear when a month is closed.'}</p></div>
      ) : (
        <div className="card">
          <table>
            <thead><tr><th>Invoice</th><th>Account</th><th>Period</th><th>Status</th><th className="num">Total</th><th></th></tr></thead>
            <tbody>
              {shownInv.map(i => (
                <tr key={i.id} onClick={() => setViewing(i)} style={{ cursor: 'pointer' }}>
                  <td><b>{i.number}</b><div className="hintxt">{i.handling === 'contract' ? 'Contract' : i.stripeInvoiceId ? 'Sent to Stripe' : i.stripeError ? `Not sent yet: ${i.stripeError}` : 'Waiting to go to Stripe'}</div></td>
                  <td>{i.accountName}</td>
                  <td>{monthLabel(i.period)}</td>
                  <td><InvoiceStatus inv={i} /></td>
                  <td className="num">{usd(i.totalUsd)}</td>
                  <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }} onClick={e => e.stopPropagation()}>
                    {i.handling === 'contract' && (i.status === 'issued' || i.status === 'failed') && <button className="btn" onClick={() => setPaying(i)}>Mark paid</button>}
                    <DownloadButtons inv={i} base={P} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="sec-head">
        <h2>Price list</h2>
        <button className="btn ghost" onClick={() => setPriceOpen(true)}>Add a price</button>
      </div>
      {prices.length === 0 ? (
        <div className="empty"><h3>No prices yet</h3><p>Server time is not charged until a price is added. Unpriced time is listed at each close, never charged.</p></div>
      ) : (
        <div className="card">
          <table>
            <thead><tr><th>Price</th><th>Applies to</th><th className="num">Unit price</th><th>From</th><th></th></tr></thead>
            <tbody>
              {prices.map(p => {
                const later = prices.find(q => q !== p && q.unitKey === p.unitKey && q.instanceType === p.instanceType && q.effectiveFrom > p.effectiveFrom && new Date(q.effectiveFrom) <= new Date())
                const future = new Date(p.effectiveFrom) > new Date()
                return (
                  <tr key={p.id}>
                    <td><b>{p.name}</b></td>
                    <td>{p.unitKey === 'gb_delivered' ? 'GB delivered' : p.instanceType ? `Server time, ${p.instanceType}` : 'Server time, any type'}</td>
                    <td className="num">{unitPrice(p.unitUsd)} per {p.unit}</td>
                    <td>{dayLabel(p.effectiveFrom)}</td>
                    <td>{future ? <StatusTag label="Starts later" cls="sched" /> : later ? <StatusTag label="Replaced" cls="idle" /> : <StatusTag label="In force" cls="live" />}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      <AddonCatalogue />

      {editAcc && <AccountBillingDrawer acc={editAcc} defaultRate={ov.taxRate} contractDeployment={ov.mode === 'contract'} onClose={() => setEditAcc(null)} onDone={() => { setEditAcc(null); load() }} />}
      {charge && <ChargeDrawer accounts={ov.accounts} openMonth={ov.openMonth} onClose={() => setCharge(false)} onDone={() => { setCharge(false); load() }} />}
      {paying && <MarkPaidDrawer inv={paying} onClose={() => setPaying(null)} onDone={() => { setPaying(null); load() }} />}
      {priceOpen && <PriceDrawer onClose={() => setPriceOpen(false)} onDone={() => { setPriceOpen(false); load() }} />}
      {closeOpen && <CloseDrawer ov={ov} onClose={() => setCloseOpen(false)} onDone={() => { setCloseOpen(false); load() }} />}
      {viewing && <InvoiceDrawer id={viewing.id} base={P} accountName={viewing.accountName} onClose={() => setViewing(null)} />}
    </>
  )
}

/** The drawer frame every form here uses: title, body, status and two buttons. */
export function Drawer({ title, children, err, busy, okLabel, okDisabled, onOk, onClose, danger }: {
  title: string; children: ReactNode; err: string; busy: boolean; okLabel: string; okDisabled?: boolean; onOk: () => void; onClose: () => void; danger?: boolean
}) {
  useEscape(onClose, !busy)
  return (
    <div className="drawer-scrim" onClick={e => { if (e.target === e.currentTarget && !busy) onClose() }}>
      <div className="drawer" role="dialog" aria-modal="true" aria-labelledby="bd-t">
        <div className="drawer-h"><div className="t" id="bd-t">{title}</div><button className="xbtn" onClick={onClose} aria-label="Close">✕</button></div>
        <div className="drawer-b">{children}</div>
        <div className="drawer-f">
          <FormStatus error={err} />
          <button className="btn ghost" onClick={onClose} disabled={busy}>Cancel</button>
          <button className={`btn primary${danger ? ' danger' : ''}`} onClick={onOk} disabled={busy || okDisabled}>{busy ? 'Saving…' : okLabel}</button>
        </div>
      </div>
    </div>
  )
}

export function useSubmit(onDone: () => void) {
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  const notify = useNotify()
  const run = async (fn: () => Promise<string>) => {
    setErr(''); setBusy(true)
    try { const msg = await fn(); notify({ kind: 'ok', message: msg }); onDone() }
    catch (e: any) { setErr(e?.message || 'It could not be saved.') } finally { setBusy(false) }
  }
  return { err, busy, run }
}

function AccountBillingDrawer({ acc, defaultRate, contractDeployment, onClose, onDone }: { acc: Acc; defaultRate: number; contractDeployment: boolean; onClose: () => void; onDone: () => void }) {
  const [handling, setHandling] = useState(acc.storedHandling || 'automated')
  const [rate, setRate] = useState(acc.taxRate == null ? '' : String(Number((acc.taxRate * 100).toFixed(4))))
  const n = Number(rate)
  const rateErr = rate.trim() === '' ? '' : !Number.isFinite(n) || n < 0 || n >= 100 ? 'A percentage from 0 up to 99.' : ''
  const s = useSubmit(onDone)
  return (
    <Drawer title={`Billing: ${acc.name}`} err={s.err} busy={s.busy} okLabel="Save" okDisabled={!!rateErr}
      onClose={onClose} onOk={() => s.run(async () => {
        await req(`${P}/accounts/${acc.id}`, { method: 'PATCH', body: JSON.stringify({ handling, taxRate: rate.trim() === '' ? null : Number((n / 100).toFixed(6)) }) })
        return `Billing saved for ${acc.name}.`
      })}>
      <div className="field"><label htmlFor="bd-h">Invoices are paid by</label>
        <select id="bd-h" className="inp" value={handling} onChange={e => setHandling(e.target.value)}>
          <option value="automated">Card, charged through Stripe</option>
          <option value="contract">Contract: issued for the customer's accounts team, marked paid by hand</option>
        </select>
        {contractDeployment && <div className="hintxt">This deployment bills under contract, so every account is treated as contract whatever is chosen here.</div>}
      </div>
      <div className={`field${rateErr ? ' has-err' : ''}`}><label htmlFor="bd-r">Tax rate (%)</label>
        <input id="bd-r" className="inp" inputMode="decimal" value={rate} onChange={e => setRate(e.target.value)} placeholder={`Default: ${pct(defaultRate)}`} />
        <FieldError>{rateErr}</FieldError>
        <div className="hintxt">Leave empty to use the deployment's default. Applies to invoices issued from now on; issued invoices keep their rate.</div>
      </div>
      <AccountAddonsList accountId={acc.id} />
    </Drawer>
  )
}

function ChargeDrawer({ accounts, openMonth, onClose, onDone }: { accounts: Acc[]; openMonth: string; onClose: () => void; onDone: () => void }) {
  const [accountId, setAccountId] = useState(accounts[0]?.id ?? '')
  const [kind, setKind] = useState<'charge' | 'credit'>('charge')
  const [amount, setAmount] = useState('')
  const [description, setDescription] = useState('')
  const [reference, setReference] = useState('')
  const a = Number(amount)
  const amountErr = amount.trim() === '' ? '' : !Number.isFinite(a) || a <= 0 ? 'An amount above zero; choose Credit to take money off.' : ''
  const ok = !!accountId && a > 0 && !amountErr && description.trim().length > 0
  const s = useSubmit(onDone)
  return (
    <Drawer title="Add a charge or credit" err={s.err} busy={s.busy} okLabel={kind === 'credit' ? 'Add credit' : 'Add charge'} okDisabled={!ok}
      onClose={onClose} onOk={() => s.run(async () => {
        await req(`${P}/charges`, J({ accountId, amountUsd: kind === 'credit' ? -a : a, description: description.trim(), reference: reference.trim() || undefined }))
        return `${kind === 'credit' ? 'Credit' : 'Charge'} of ${usd(a)} added to ${monthLabel(openMonth)}.`
      })}>
      <div className="field"><label htmlFor="ch-a">Account</label>
        <select id="ch-a" className="inp" value={accountId} onChange={e => setAccountId(e.target.value)}>{accounts.map(x => <option key={x.id} value={x.id}>{x.name}</option>)}</select>
      </div>
      <div className="field"><label>Type</label>
        <div className="chipset">
          <button type="button" className={`selchip ${kind === 'charge' ? 'sel' : ''}`} aria-pressed={kind === 'charge'} onClick={() => setKind('charge')}>Charge</button>
          <button type="button" className={`selchip ${kind === 'credit' ? 'sel' : ''}`} aria-pressed={kind === 'credit'} onClick={() => setKind('credit')}>Credit</button>
        </div>
      </div>
      <div className={`field${amountErr ? ' has-err' : ''}`}><label htmlFor="ch-n">Amount (USD) <span className="req">*</span></label>
        <input id="ch-n" className="inp" inputMode="decimal" value={amount} onChange={e => setAmount(e.target.value)} placeholder="250.00" />
        <FieldError>{amountErr}</FieldError>
      </div>
      <div className="field"><label htmlFor="ch-d">Description <span className="req">*</span></label>
        <input id="ch-d" className="inp" maxLength={300} value={description} onChange={e => setDescription(e.target.value)} placeholder="Onboarding workshop" />
        <div className="hintxt">Shown on the customer's invoice as written.</div>
      </div>
      <div className="field"><label htmlFor="ch-r">Reference</label>
        <input id="ch-r" className="inp" maxLength={200} value={reference} onChange={e => setReference(e.target.value)} placeholder="Order or ticket number" />
      </div>
      <p className="hintxt">It goes on the open month, {monthLabel(openMonth)}, and appears on the invoice issued on the 1st. A charge cannot be changed once added: correct it with a credit.</p>
    </Drawer>
  )
}

function MarkPaidDrawer({ inv, onClose, onDone }: { inv: AdminInvoice; onClose: () => void; onDone: () => void }) {
  const [reference, setReference] = useState('')
  const s = useSubmit(onDone)
  return (
    <Drawer title={`Mark ${inv.number} paid`} err={s.err} busy={s.busy} okLabel="Mark paid" okDisabled={!reference.trim()}
      onClose={onClose} onOk={() => s.run(async () => { await req(`${P}/invoices/${inv.id}/paid`, J({ reference: reference.trim() })); return `${inv.number} marked paid.` })}>
      <p>{inv.accountName}, {monthLabel(inv.period)}: <b>{usd(inv.totalUsd)}</b></p>
      <div className="field"><label htmlFor="mp-r">Payment reference <span className="req">*</span></label>
        <input id="mp-r" className="inp" maxLength={200} value={reference} onChange={e => setReference(e.target.value)} placeholder="Bank transfer 2026-11-04, ref. 88213" />
        <div className="hintxt">Shown to the customer on the invoice and its PDF. Paid cannot be undone.</div>
      </div>
    </Drawer>
  )
}

function PriceDrawer({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [unitKey, setUnitKey] = useState<'server_hour' | 'gb_delivered'>('server_hour')
  const [instanceType, setInstanceType] = useState('')
  const [name, setName] = useState('')
  const [unitUsd, setUnitUsd] = useState('')
  const [from, setFrom] = useState('')
  const u = Number(unitUsd)
  const ok = name.trim().length > 0 && unitUsd.trim() !== '' && Number.isFinite(u) && u >= 0
  const s = useSubmit(onDone)
  return (
    <Drawer title="Add a price" err={s.err} busy={s.busy} okLabel="Add price" okDisabled={!ok}
      onClose={onClose} onOk={() => s.run(async () => {
        await req(`${P}/prices`, J({ unitKey, instanceType: unitKey === 'server_hour' && instanceType.trim() ? instanceType.trim() : null, name: name.trim(),
          unit: unitKey === 'server_hour' ? 'hour' : 'GB', unitUsd: u, effectiveFrom: from ? new Date(`${from}T00:00:00Z`).toISOString() : undefined }))
        return `Price added: ${name.trim()}.`
      })}>
      <div className="field"><label htmlFor="pr-k">What it prices</label>
        <select id="pr-k" className="inp" value={unitKey} onChange={e => setUnitKey(e.target.value as any)}>
          <option value="server_hour">Server time, per hour</option>
          <option value="gb_delivered">Data delivered, per GB</option>
        </select>
        {unitKey === 'gb_delivered' && <div className="hintxt">Nothing feeds this meter yet, so a GB price is kept for later and charges nothing today.</div>}
      </div>
      {unitKey === 'server_hour' && <div className="field"><label htmlFor="pr-t">Instance type</label>
        <input id="pr-t" className="inp" value={instanceType} onChange={e => setInstanceType(e.target.value)} placeholder="c7i.xlarge (empty: every type without its own price)" />
      </div>}
      <div className="field"><label htmlFor="pr-n">Name on the invoice <span className="req">*</span></label>
        <input id="pr-n" className="inp" maxLength={120} value={name} onChange={e => setName(e.target.value)} placeholder="Encoding server, standard" />
      </div>
      <div className="field"><label htmlFor="pr-u">Price (USD) <span className="req">*</span></label>
        <input id="pr-u" className="inp" inputMode="decimal" value={unitUsd} onChange={e => setUnitUsd(e.target.value)} placeholder="0.42" />
      </div>
      <div className="field"><label htmlFor="pr-f">In force from</label>
        <input id="pr-f" className="inp" type="date" value={from} onChange={e => setFrom(e.target.value)} />
        <div className="hintxt">Empty: from now. Each month is charged at the price in force when it started, so a new price counts from the next whole month it covers. Prices are never edited; add a new one to change it.</div>
      </div>
    </Drawer>
  )
}

function CloseDrawer({ ov, onClose, onDone }: { ov: Overview; onClose: () => void; onDone: () => void }) {
  const [month, setMonth] = useState(ov.lastClosable)
  const [accountId, setAccountId] = useState('')
  const s = useSubmit(onDone)
  const valid = /^\d{4}-\d{2}$/.test(month) && month < ov.openMonth
  return (
    <Drawer title="Close a month" err={s.err} busy={s.busy} okLabel="Close month" okDisabled={!valid}
      onClose={onClose} onOk={() => s.run(async () => {
        const r = await req(`${P}/close`, J({ month, accountId: accountId || undefined }))
        return `${monthLabel(r.month)}: ${r.issued.length} invoice${r.issued.length === 1 ? '' : 's'} issued, ${r.existing} already invoiced, ${r.nothingToBill} with nothing to bill${r.unpriced.length ? `, ${r.unpriced.length} with server time that has no price` : ''}.`
      })}>
      <div className="field"><label htmlFor="cl-m">Month</label>
        <input id="cl-m" className="inp" type="month" value={month} max={ov.lastClosable} onChange={e => setMonth(e.target.value)} />
        {!valid && <FieldError>Only a month that has finished, up to {monthLabel(ov.lastClosable)}.</FieldError>}
      </div>
      <div className="field"><label htmlFor="cl-a">Accounts</label>
        <select id="cl-a" className="inp" value={accountId} onChange={e => setAccountId(e.target.value)}>
          <option value="">Every account</option>
          {ov.accounts.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
        </select>
      </div>
      <p className="hintxt">Each account gets one numbered invoice for the month. An account already invoiced for it is left alone, so closing again is safe. {ov.mode === 'automated' ? 'Card invoices then go to Stripe and are charged.' : ''}</p>
    </Drawer>
  )
}
