// ============================================================================
//  BILLING (Admin > Billing, build queue B1-3; server: modules/billing.ts).
//
//  What Volt charges this account: the open month worked out so far, the
//  invoices issued on the 1st for the month before (with their PDF and CSV for
//  the customer's accounts team), and how they are paid. Account settings:
//  View reads it; changing the card needs Manage, and the card itself lives in
//  Stripe's customer portal, never in Volt.
//
//  When the deployment does not bill (VOLT_BILLING off) the page says so
//  plainly instead of showing an empty month: a customer on a plain Mac run
//  should not wonder whether a bill is coming.
// ============================================================================
import { useEffect, useState } from 'react'
import { apiRequest as req, downloadFile } from '../api'
import { PageHead, StatusTag } from '../scaffold'
import { navigate } from '../router'
import { useAccess } from '../access'
import { usePageNotice, useNotify, Notice } from '../notices'
import { AddonsSection } from './BillingAddons'

export interface BillLine { source: string; itemKey?: string; description: string; quantity: number; unit: string; unitUsd: number; amountUsd: number; reference?: string | null; sofar?: boolean }
export interface Invoice {
  id: string; accountId: string; number: string; period: string; status: 'issued' | 'paid' | 'failed' | 'void'; handling: 'automated' | 'contract'
  currency: string; subtotalUsd: number; taxRate: number; taxUsd: number; totalUsd: number
  issuedAt: string; paidAt: string | null; paidReference: string | null; failedAt: string | null
  lines?: BillLine[]
}
export interface Draft {
  period: string; handling: string; currency: string; subtotalUsd: number; taxRate: number; taxUsd: number; totalUsd: number
  lines: BillLine[]; unpriced: { unitKey: string; instanceType: string | null; quantity: number; unit: string }[]; notes: string[]
}
interface BillingView {
  mode: 'off' | 'contract' | 'automated'; handling: 'automated' | 'contract'; currency: string
  paymentMethod: { portal: boolean; reason: string | null }
  currentMonth: Draft | null; invoices: Invoice[]
}

export const usd = (n: number) => `${n < 0 ? '-' : ''}$${Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
export const unitPrice = (n: number) => `${n < 0 ? '-' : ''}$${Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 6 })}`
export const pct = (r: number) => `${(r * 100).toFixed(2).replace(/\.?0+$/, '')}%`
export const monthLabel = (p: string) => { const [y, m] = p.split('-').map(Number); return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' }) }
export const dayLabel = (d: string | null) => d ? new Date(d).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : ''
const qty = (l: BillLine) => `${Number(l.quantity.toFixed(3)).toLocaleString('en-US')} ${l.unit}`

export function InvoiceStatus({ inv }: { inv: Invoice }) {
  if (inv.status === 'paid') return <StatusTag label="Paid" cls="live" sub={inv.paidAt ? dayLabel(inv.paidAt) : undefined} />
  if (inv.status === 'failed') return <StatusTag label="Payment failed" cls="down" sub="Being retried" />
  if (inv.status === 'void') return <StatusTag label="Void" cls="idle" />
  return <StatusTag label="Issued" cls="sched" sub={inv.handling === 'contract' ? 'Awaiting payment' : 'Being charged'} />
}

/** The lines of a month or an invoice, then subtotal, tax and total. */
export function LinesTable({ lines, subtotalUsd, taxRate, taxUsd, totalUsd, open }: { lines: BillLine[]; subtotalUsd: number; taxRate: number; taxUsd: number; totalUsd: number; open?: boolean }) {
  return (
    <table className="bill-lines">
      <thead><tr><th>Item</th><th>Quantity</th><th className="num">Unit price</th><th className="num">Amount</th></tr></thead>
      <tbody>
        {lines.length === 0 && <tr><td colSpan={4} className="hintxt">Nothing charged{open ? ' so far this month' : ''}.</td></tr>}
        {lines.map((l, i) => (
          <tr key={i}>
            <td>{l.description}{l.sofar && <span className="tag idle bill-sofar">So far</span>}{l.reference && <div className="hintxt">Ref. {l.reference}</div>}</td>
            <td>{qty(l)}</td>
            <td className="num">{unitPrice(l.unitUsd)}</td>
            <td className="num">{usd(l.amountUsd)}</td>
          </tr>
        ))}
      </tbody>
      <tfoot>
        <tr><td colSpan={3}>Subtotal</td><td className="num">{usd(subtotalUsd)}</td></tr>
        <tr><td colSpan={3}>Tax ({pct(taxRate)})</td><td className="num">{usd(taxUsd)}</td></tr>
        <tr className="bill-total"><td colSpan={3}>{open ? 'Total so far (USD)' : 'Total (USD)'}</td><td className="num">{usd(totalUsd)}</td></tr>
      </tfoot>
    </table>
  )
}

/** Escape closes a drawer wherever the focus is: after a click on a table row
 *  the focus stays on the page, so a keydown on the drawer itself never fires. */
export function useEscape(onClose: () => void, enabled = true) {
  useEffect(() => {
    if (!enabled) return
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }, [onClose, enabled])
}

/** One invoice with its lines, and its downloads. `base` is /billing or /platform/billing. */
export function InvoiceDrawer({ id, base, onClose, accountName }: { id: string; base: string; onClose: () => void; accountName?: string }) {
  const [inv, setInv] = useState<Invoice | null>(null)
  const [err, setErr] = useState('')
  useEscape(onClose)
  useEffect(() => { req(`${base}/invoices/${id}`).then(setInv, (e: any) => setErr(e?.message || 'Could not load the invoice')) }, [id, base])
  return (
    <div className="drawer-scrim" onClick={e => { if (e.target === e.currentTarget) onClose() }}>
      <div className="drawer" role="dialog" aria-modal="true" aria-labelledby="inv-t">
        <div className="drawer-h"><div className="t" id="inv-t">{inv ? `Invoice ${inv.number}` : 'Invoice'}</div><button className="xbtn" onClick={onClose} aria-label="Close">✕</button></div>
        <div className="drawer-b">
          {err && <Notice kind="error" variant="compact" message={err} />}
          {!inv && !err && <div className="loading">Loading the invoice…</div>}
          {inv && <>
            <div className="bill-facts">
              {accountName && <div><span className="plan-k">Account</span><div>{accountName}</div></div>}
              <div><span className="plan-k">Period</span><div>{monthLabel(inv.period)}</div></div>
              <div><span className="plan-k">Issued</span><div>{dayLabel(inv.issuedAt)}</div></div>
              <div><span className="plan-k">Paid by</span><div>{inv.handling === 'contract' ? 'Contract' : 'Card'}</div></div>
              <div><span className="plan-k">Status</span><div><InvoiceStatus inv={inv} /></div></div>
            </div>
            {inv.paidReference && <p className="hintxt">Payment reference: {inv.paidReference}</p>}
            <div className="card bill-card-flat"><LinesTable lines={inv.lines ?? []} subtotalUsd={inv.subtotalUsd} taxRate={inv.taxRate} taxUsd={inv.taxUsd} totalUsd={inv.totalUsd} /></div>
          </>}
        </div>
        <div className="drawer-f">
          {inv && <DownloadButtons inv={inv} base={base} />}
          <button className="btn ghost" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  )
}

export function DownloadButtons({ inv, base }: { inv: Invoice; base: string }) {
  const notify = useNotify()
  const get = (kind: 'pdf' | 'csv') => downloadFile(`${base}/invoices/${inv.id}/${kind}`, `${inv.number}.${kind}`)
    .catch((e: any) => notify({ kind: 'error', message: `The ${kind.toUpperCase()} could not be downloaded: ${e?.message || 'unknown error'}` }))
  return (
    <span className="bill-dl">
      <button className="btn ghost" onClick={() => get('pdf')} aria-label={`Download invoice ${inv.number} as PDF`}><DlIcon />PDF</button>
      <button className="btn ghost" onClick={() => get('csv')} aria-label={`Download invoice ${inv.number} as CSV`}><DlIcon />CSV</button>
    </span>
  )
}

const DlIcon = () => <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d="M12 3v12m0 0l-5-5m5 5l5-5M4 19h16" /></svg>
const CardIcon = () => <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><rect x="2" y="5" width="20" height="14" rx="2" /><path d="M2 10h20" /></svg>
const DocIcon = () => <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d="M14 3H6a2 2 0 00-2 2v14a2 2 0 002 2h12a2 2 0 002-2V9z" /><path d="M14 3v6h6M8 13h8M8 17h5" /></svg>

export default function BillingPage() {
  const access = useAccess()
  const canManage = access.can('settings', 'manage')
  const [b, setB] = useState<BillingView | null>(null)
  const [err, setErr] = useState('')
  const [open, setOpen] = useState<string | null>(null)
  const [portalBusy, setPortalBusy] = useState(false)
  const notify = useNotify()
  const load = () => req('/billing').then((v: BillingView) => { setB(v); setErr('') }, (e: any) => setErr(e?.message || 'Could not load billing'))
  useEffect(() => { load() }, [])
  usePageNotice('load', err ? { kind: 'error', title: "Couldn't load billing.", message: err, actions: [{ label: 'Retry', onClick: () => { load() } }] } : null)
  const failed = b?.invoices.filter(i => i.status === 'failed') ?? []
  usePageNotice('failed', failed.length ? { kind: 'warn', title: 'A card payment failed.', message: `Invoice ${failed.map(i => i.number).join(', ')} could not be charged. It is tried again automatically; the service carries on meanwhile.${b?.paymentMethod.portal && canManage ? ' Change the card if it has expired.' : ''}` } : null)

  async function changeCard() {
    setPortalBusy(true)
    try { const r = await req('/billing/portal', { method: 'POST', body: '{}' }); window.location.assign(r.url) }
    catch (e: any) { notify({ kind: 'error', message: e?.message || 'The card page could not be opened.' }); setPortalBusy(false) }
  }

  const sub = 'What Volt charges this account: this month so far, past invoices, and how they are paid.'
  if (!b) return <><PageHead title="Billing" sub={sub} />{!err && <div className="loading">Loading billing…</div>}</>
  const m = b.currentMonth
  return (
    <>
      <PageHead title="Billing" sub={sub} action={<button className="btn ghost" onClick={() => navigate('/plan')}>Plan & limits</button>} />

      {b.mode === 'off' && (
        <div style={{ marginBottom: 18 }}>
          <Notice kind="info" title="Billing is not used on this deployment." message={b.invoices.length ? 'Nothing is charged or invoiced. Earlier invoices are listed below.' : 'Nothing is charged or invoiced, so there is no bill to show.'} />
        </div>
      )}

      {m && (
        <>
          <div className="sec-head"><h2>This month so far: {monthLabel(m.period)}</h2></div>
          <div className="card bill-card">
            <LinesTable lines={m.lines} subtotalUsd={m.subtotalUsd} taxRate={m.taxRate} taxUsd={m.taxUsd} totalUsd={m.totalUsd} open />
            <div className="bill-foot hintxt">
              Server time is counted as it runs, so the amounts marked So far grow until the month ends. The invoice is issued on the 1st.
              {m.notes.map((n, i) => <div key={i}>{n}</div>)}
            </div>
          </div>
        </>
      )}

      {b.mode !== 'off' && (
        <>
          <div className="sec-head"><h2>How invoices are paid</h2></div>
          <div className="card bill-pay">
            <span className="bill-pay-ic">{b.handling === 'automated' ? <CardIcon /> : <DocIcon />}</span>
            <div className="bill-pay-t">
              {b.handling === 'automated'
                ? <><b>Charged to the card on file</b><div className="hintxt">Each invoice is charged when it is issued. A failed payment is tried again automatically and your owners and administrators are told.{!b.paymentMethod.portal && b.paymentMethod.reason ? ` ${b.paymentMethod.reason}` : ''}</div></>
                : <><b>Paid under your contract</b><div className="hintxt">Invoices are issued for your accounts team to pay as agreed, and marked paid when the payment arrives. Download each one as PDF or CSV below.</div></>}
            </div>
            {b.handling === 'automated' && b.paymentMethod.portal && (
              canManage
                ? <button className="btn" onClick={changeCard} disabled={portalBusy}><CardIcon />{portalBusy ? 'Opening…' : 'Change card'}</button>
                : <span className="hintxt">Changing the card needs Account settings: Manage.</span>
            )}
          </div>
        </>
      )}

      <AddonsSection mode={b.mode} canManage={canManage} />

      <div className="sec-head"><h2>Invoices</h2></div>
      {b.invoices.length === 0 ? (
        <div className="empty"><div className="ic"><DocIcon /></div><h3>No invoices yet</h3><p>{b.mode === 'off' ? 'This deployment does not issue invoices.' : 'The first invoice is issued on the 1st, for the month before.'}</p></div>
      ) : (
        <div className="card">
          <table>
            <thead><tr><th>Invoice</th><th>Period</th><th>Status</th><th className="num">Total</th><th></th></tr></thead>
            <tbody>
              {b.invoices.map(inv => (
                <tr key={inv.id} onClick={() => setOpen(inv.id)} style={{ cursor: 'pointer' }}>
                  <td><b>{inv.number}</b><div className="hintxt">Issued {dayLabel(inv.issuedAt)}</div></td>
                  <td>{monthLabel(inv.period)}</td>
                  <td><InvoiceStatus inv={inv} /></td>
                  <td className="num">{usd(inv.totalUsd)}</td>
                  <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }} onClick={e => e.stopPropagation()}><DownloadButtons inv={inv} base="/billing" /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {open && <InvoiceDrawer id={open} base="/billing" onClose={() => setOpen(null)} />}
    </>
  )
}
