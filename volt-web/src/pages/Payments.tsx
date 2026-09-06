// ============================================================================
//  PAYMENTS — the providers that take the money, the products the rules
//  created, and the viewers who bought them.
//
//  Providers take payment; the platform decides what it buys and for how long
//  (the TERMS on the access rules). So there is nothing here about prices:
//  a product's price lives on its term. What lives here is the connection to
//  each provider (public config + where its secret is), the provider's own id
//  for each product (a Stripe price, an App Store product id, a Play SKU), and
//  a lookup of a viewer's purchases and entitlements, with the ability to
//  grant one by hand or record a payment taken elsewhere.
// ============================================================================
import { useEffect, useState } from 'react'
import { api, type PaymentProviderRow, type ProductRow } from '../api'
import { PageHead } from '../scaffold'

const PROVIDERS: { key: 'stripe' | 'appstore' | 'googleplay' | 'manual'; name: string; fields: { key: string; label: string; hint?: string }[]; secretHint: string }[] = [
  { key: 'stripe', name: 'Stripe', secretHint: 'webhook signing secret (whsec_…) and the secret key, in the secrets store', fields: [
    { key: 'publishableKey', label: 'Publishable key' }, { key: 'accountId', label: 'Stripe account id', hint: 'acct_… for Connect' }] },
  { key: 'appstore', name: 'Apple App Store', secretHint: 'App Store Server API key (.p8) and issuer id, in the secrets store', fields: [
    { key: 'bundleId', label: 'Bundle id' }, { key: 'environment', label: 'Environment', hint: 'Sandbox or Production' }] },
  { key: 'googleplay', name: 'Google Play', secretHint: 'service account JSON for the Play Developer API, in the secrets store', fields: [
    { key: 'packageName', label: 'Package name' }, { key: 'pubsubTopic', label: 'Pub/Sub topic', hint: 'for Real-time Developer Notifications' }] },
  { key: 'manual', name: 'Manual (invoiced / comp)', secretHint: 'no secret: recorded by an operator', fields: [] },
]

export default function PaymentsPage() {
  const [prov, setProv] = useState<{ providers: PaymentProviderRow[]; webhookBase: string } | null>(null)
  const [products, setProducts] = useState<ProductRow[] | null>(null)
  const [err, setErr] = useState('')
  async function load() {
    try { const [p, pr] = await Promise.all([api.paymentProviders(), api.products()]); setProv(p); setProducts(pr) } catch (e: any) { setErr(e.message) }
  }
  useEffect(() => { load() }, [])
  return (
    <>
      <PageHead title="Payments" sub="Providers take the payment; the access rules decide what it buys and for how long. Connect the providers this account uses, map each product to the provider's own id, and look up what a viewer holds." />
      {err && <div className="err">{err}</div>}

      <div className="card" style={{ padding: 18, marginBottom: 16 }}>
        <div className="sec-label">Providers</div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: 12 }}>
          {PROVIDERS.map(P => <ProviderCard key={P.key} P={P} row={prov?.providers.find(r => r.provider === P.key) ?? null} webhookBase={prov?.webhookBase ?? ''} onSaved={load} />)}
        </div>
        <div style={{ fontSize: 'var(--fs-micro)', color: 'var(--faint)', marginTop: 10 }}>
          Nothing is granted on an unverified event: Stripe webhooks are signature-checked; App Store and Google Play events are recorded as pending until the server-side confirmation is wired to their APIs.
        </div>
      </div>

      <div className="card" style={{ padding: 18, marginBottom: 16 }}>
        <div className="sec-label">Products (from the premium terms on your access rules)</div>
        {!products ? <div className="loading">Loading…</div> : products.length === 0 ? (
          <div style={{ fontSize: 'var(--fs-sm)', color: 'var(--faint)' }}>No products yet. Add a premium rule with a term under Publishing Rules, a content type, a channel, a station, an event or a library item.</div>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table>
              <thead><tr><th>Product</th><th>Key</th><th>Term</th><th>Stripe price</th><th>App Store id</th><th>Play SKU</th><th>Enabled</th></tr></thead>
              <tbody>{products.map(p => <ProductRowEdit key={p.id} p={p} onSaved={load} />)}</tbody>
            </table>
          </div>
        )}
      </div>

      <ViewerLookup products={products ?? []} />
    </>
  )
}

function ProviderCard({ P, row, webhookBase, onSaved }: { P: typeof PROVIDERS[number]; row: PaymentProviderRow | null; webhookBase: string; onSaved: () => void }) {
  const [config, setConfig] = useState<Record<string, any>>(row?.config ?? {})
  const [secretRef, setSecretRef] = useState('')
  const [enabled, setEnabled] = useState(row?.enabled ?? false)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState('')
  useEffect(() => { setConfig(row?.config ?? {}); setEnabled(row?.enabled ?? false) }, [row?.id])
  const connected = !!row
  return (
    <div style={{ padding: 12, borderRadius: 8, border: `1px solid ${connected && enabled ? 'rgba(74,222,128,.4)' : 'var(--border)'}` }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <b>{P.name}</b>
        <span style={{ fontSize: 'var(--fs-micro)', color: connected && enabled ? 'var(--ok,#4ade80)' : 'var(--faint)' }}>{connected ? (enabled ? 'connected' : 'disabled') : 'not connected'}</span>
        <label style={{ marginLeft: 'auto', fontSize: 'var(--fs-sm)', display: 'flex', gap: 6, alignItems: 'center' }}><input type="checkbox" checked={enabled} onChange={e => setEnabled(e.target.checked)} />enabled</label>
      </div>
      {P.fields.map(f => (
        <div key={f.key} className="field" style={{ marginBottom: 8 }}><label style={{ fontSize: 'var(--fs-xs)' }}>{f.label}</label>
          <input className="inp" style={{ fontSize: 'var(--fs-sm)', padding: '4px 7px' }} value={config[f.key] ?? ''} placeholder={f.hint} onChange={e => setConfig(c => ({ ...c, [f.key]: e.target.value }))} /></div>
      ))}
      {P.key !== 'manual' && (
        <div className="field" style={{ marginBottom: 8 }}><label style={{ fontSize: 'var(--fs-xs)' }}>Secret reference {row?.has_secret && <span style={{ color: 'var(--ok,#4ade80)' }}>· set</span>}</label>
          <input className="inp" style={{ fontSize: 'var(--fs-sm)', padding: '4px 7px' }} value={secretRef} placeholder={P.secretHint} onChange={e => setSecretRef(e.target.value)} /></div>
      )}
      {P.key !== 'manual' && webhookBase && (
        <div style={{ fontSize: 'var(--fs-micro)', color: 'var(--faint)', fontFamily: 'ui-monospace,monospace', wordBreak: 'break-all' }}>webhook: {webhookBase.replace('{provider}', P.key)}</div>
      )}
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 8 }}>
        <button className="btn primary" disabled={busy} style={{ padding: '4px 10px', fontSize: 'var(--fs-sm)' }} onClick={async () => {
          setBusy(true); setMsg('')
          try { await api.putPaymentProvider(P.key, { config, secretRef: secretRef || null, enabled }); setMsg('Saved.'); setSecretRef(''); onSaved() } catch (e: any) { setMsg(e.message) } finally { setBusy(false) }
        }}>{busy ? 'Saving…' : connected ? 'Save' : 'Connect'}</button>
        {msg && <span style={{ fontSize: 'var(--fs-sm)', color: msg === 'Saved.' ? 'var(--ok,#4ade80)' : '#fca5a5' }}>{msg}</span>}
      </div>
    </div>
  )
}

function ProductRowEdit({ p, onSaved }: { p: ProductRow; onSaved: () => void }) {
  const [ids, setIds] = useState<Record<string, string>>(p.provider_ids ?? {})
  const [dirty, setDirty] = useState(false)
  const t = p.term
  const term = t.kind === 'period' ? `${t.count} ${t.unit}${(t.count ?? 1) === 1 ? '' : 's'}` : 'published dates'
  const price = `${(t.priceCents / 100).toFixed(2)} ${t.currency}${t.taxPct ? ` +${t.taxPct}%` : ''}`
  const cell = (k: string, ph: string) => (
    <td><input className="inp" style={{ fontSize: 'var(--fs-sm)', padding: '3px 6px', width: 150, fontFamily: 'ui-monospace,monospace' }} placeholder={ph} value={ids[k] ?? ''}
      onChange={e => { setIds(s => ({ ...s, [k]: e.target.value })); setDirty(true) }} /></td>
  )
  return (
    <tr>
      <td><b>{p.name}</b></td>
      <td style={{ fontFamily: 'ui-monospace,monospace', color: 'var(--muted)' }}>{p.key}</td>
      <td style={{ color: 'var(--muted)' }}>{term} · {price}</td>
      {cell('stripe', 'price_…')}{cell('appstore', 'com.app.product')}{cell('googleplay', 'sku')}
      <td>
        <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          <input type="checkbox" checked={p.enabled} onChange={async e => { await api.patchProduct(p.id, { enabled: e.target.checked }); onSaved() }} />
          {dirty && <button className="btn primary" style={{ padding: '2px 8px', fontSize: 'var(--fs-xs)' }} onClick={async () => { await api.patchProduct(p.id, { providerIds: ids }); setDirty(false); onSaved() }}>Save ids</button>}
        </div>
      </td>
    </tr>
  )
}

function ViewerLookup({ products }: { products: ProductRow[] }) {
  const [q, setQ] = useState('')
  const [data, setData] = useState<any>(null)
  const [err, setErr] = useState('')
  const [grantKey, setGrantKey] = useState('')
  const [msg, setMsg] = useState('')
  async function find() { setErr(''); setData(null); try { setData(await api.viewerAccount(q.trim())) } catch (e: any) { setErr(e.message) } }
  return (
    <div className="card" style={{ padding: 18 }}>
      <div className="sec-label">Viewers</div>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 10 }}>
        <input className="inp" style={{ maxWidth: 360 }} placeholder="viewer id as your app knows it" value={q} onChange={e => setQ(e.target.value)} onKeyDown={e => e.key === 'Enter' && find()} />
        <button className="btn ghost" onClick={find} disabled={!q.trim()}>Look up</button>
        {err && <span style={{ color: '#fca5a5', fontSize: 'var(--fs-sm)' }}>{err}</span>}
      </div>
      {data && (
        <div>
          <div style={{ fontSize: 'var(--fs-sm)', color: 'var(--muted)' }}>
            {data.viewer.external_id}{data.viewer.email ? ` · ${data.viewer.email}` : ''} · groups: {(data.viewer.groups ?? []).join(', ') || 'none'} · {data.active.length} active entitlement{data.active.length === 1 ? '' : 's'}
          </div>
          <table style={{ marginTop: 8 }}>
            <thead><tr><th>Product</th><th>Provider</th><th>Status</th><th>Period</th><th>Amount</th></tr></thead>
            <tbody>
              {data.purchases.map((p: any) => (
                <tr key={p.id}><td>{p.product_name}</td><td style={{ color: 'var(--muted)' }}>{p.provider}</td>
                  <td style={{ color: p.status === 'paid' ? 'var(--ok,#4ade80)' : p.status === 'pending' ? 'var(--warn,#fbbf24)' : 'var(--faint)' }}>{p.status}</td>
                  <td style={{ color: 'var(--muted)', fontSize: 'var(--fs-sm)' }}>{p.period_start ? new Date(p.period_start).toLocaleDateString() : '—'} → {p.period_end ? new Date(p.period_end).toLocaleDateString() : 'open'}</td>
                  <td style={{ color: 'var(--muted)' }}>{p.amount_cents != null ? `${(p.amount_cents / 100).toFixed(2)} ${p.currency ?? ''}` : '—'}</td></tr>
              ))}
              {data.entitlements.filter((e: any) => !e.purchase_id).map((e: any) => (
                <tr key={e.id}><td>{e.product_name ?? 'grant'}</td><td style={{ color: 'var(--muted)' }}>manual grant</td>
                  <td style={{ color: e.revoked_at ? 'var(--faint)' : 'var(--ok,#4ade80)' }}>{e.revoked_at ? 'revoked' : 'active'}</td>
                  <td style={{ color: 'var(--muted)', fontSize: 'var(--fs-sm)' }}>{new Date(e.valid_from).toLocaleDateString()} → {e.valid_until ? new Date(e.valid_until).toLocaleDateString() : 'open'}</td>
                  <td style={{ color: 'var(--faint)', fontSize: 'var(--fs-sm)' }}>{e.note}</td></tr>
              ))}
            </tbody>
          </table>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 10 }}>
            <select className="inp" style={{ maxWidth: 320, fontSize: 'var(--fs-sm)' }} value={grantKey} onChange={e => setGrantKey(e.target.value)}>
              <option value="">Grant a product by hand…</option>
              {products.map(p => <option key={p.id} value={p.key}>{p.name}</option>)}
            </select>
            <button className="btn ghost" disabled={!grantKey} onClick={async () => { try { await api.grantEntitlement({ viewerExternalId: data.viewer.external_id, productKey: grantKey }); setMsg('Granted.'); find() } catch (e: any) { setMsg(e.message) } }}>Grant</button>
            <button className="btn ghost" disabled={!grantKey} onClick={async () => { try { await api.recordManualPayment({ viewerExternalId: data.viewer.external_id, productKey: grantKey, reference: `manual-${Date.now()}` }); setMsg('Payment recorded.'); find() } catch (e: any) { setMsg(e.message) } }}>Record a payment taken elsewhere</button>
            {msg && <span style={{ fontSize: 'var(--fs-sm)', color: 'var(--muted)' }}>{msg}</span>}
          </div>
        </div>
      )}
    </div>
  )
}
