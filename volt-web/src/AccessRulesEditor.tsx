// ============================================================================
//  AccessRulesEditor — FOR / IF / THEN / TERMS, one row per rule, in order.
//
//  The rule model Christian built for controlling access, carried into the
//  ladder: each row says which content it governs (this item, linked live
//  content, linked on-demand content, and/or content types), where the viewer
//  has to be (located in / not located in these countries, or the world), and
//  what that gets them: free, members only (signed in, optionally in a user
//  group), or premium under TERMS (a period or the item's published dates,
//  with price, currency and tax). The first rule that matches decides, so
//  rows can be moved up and down.
//
//  Every premium TERM becomes a product the payment providers sell; the
//  provider ids for it are set under Admin → Payments.
// ============================================================================
import { useEffect, useState } from 'react'
import { api, type AccessRule, type AccessTerm, type ContentType, type ForScope } from './api'

const SCOPE_LABEL: Record<ForScope, string> = { this: 'This item', live: 'Linked live content (live streams carried by it)', ondemand: 'Linked on-demand content (VOD / AOD made from its recordings)' }
const newId = () => `r${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
const inp = { className: 'inp', style: { fontSize: 'var(--fs-sm)', padding: '4px 7px' } as any }

export function AccessRulesEditor({ value, onChange, scopeKind }: {
  value: AccessRule[]
  onChange: (rules: AccessRule[]) => void
  scopeKind: 'account' | 'schema' | 'owner' | 'asset'
}) {
  const [types, setTypes] = useState<ContentType[]>([])
  useEffect(() => { api.contentTypes().then(setTypes).catch(() => setTypes([])) }, [])
  const rules = value ?? []
  const set = (i: number, r: AccessRule) => onChange(rules.map((x, k) => k === i ? r : x))
  const move = (i: number, d: number) => { const j = i + d; if (j < 0 || j >= rules.length) return; const n = [...rules]; [n[i], n[j]] = [n[j], n[i]]; onChange(n) }
  const thisLabel = scopeKind === 'asset' ? 'This item' : scopeKind === 'owner' ? 'This channel / station / event itself' : 'The channel, event or station itself'
  return (
    <div style={{ display: 'grid', gap: 8 }}>
      {rules.length === 0 && <div style={{ fontSize: 'var(--fs-sm)', color: 'var(--faint)' }}>No rules: the simple geo / access / paywall fields decide.</div>}
      {rules.map((r, i) => (
        <div key={r.id} style={{ display: 'grid', gridTemplateColumns: 'minmax(180px, 1fr) minmax(220px, 1.2fr) minmax(260px, 2fr) 28px', gap: 10, padding: 10, borderRadius: 8, border: '1px solid var(--border)', background: 'rgba(255,255,255,.02)', alignItems: 'start' }}>
          {/* FOR */}
          <div>
            <div className="sec-label" style={{ margin: '0 0 6px' }}>For</div>
            {(['this', 'live', 'ondemand'] as ForScope[]).map(sc => (
              <label key={sc} style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 'var(--fs-sm)' }}>
                <input type="checkbox" checked={r.for.scopes.includes(sc)}
                  onChange={e => set(i, { ...r, for: { ...r.for, scopes: e.target.checked ? [...r.for.scopes, sc] : r.for.scopes.filter(x => x !== sc) } })} />
                {sc === 'this' ? thisLabel : SCOPE_LABEL[sc]}
              </label>
            ))}
            <div style={{ marginTop: 6 }}>
              <select className="inp sel-sm" value="" onChange={e => { const id = e.target.value; if (id && !(r.for.schemaIds ?? []).includes(id)) set(i, { ...r, for: { ...r.for, schemaIds: [...(r.for.schemaIds ?? []), id] } }) }}>
                <option value="">+ Add content type</option>
                {types.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
              </select>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginTop: 4 }}>
                {(r.for.schemaIds ?? []).map(id => (
                  <span key={id} className="chip active" style={{ padding: '2px 8px', fontSize: 'var(--fs-micro)' }}>
                    {types.find(t => t.id === id)?.name ?? id.slice(0, 8)}
                    <button className="xbtn" style={{ marginLeft: 4, fontSize: 10 }} onClick={() => set(i, { ...r, for: { ...r.for, schemaIds: (r.for.schemaIds ?? []).filter(x => x !== id) } })}>✕</button>
                  </span>
                ))}
              </div>
            </div>
          </div>
          {/* IF */}
          <div>
            <div className="sec-label" style={{ margin: '0 0 6px' }}>If</div>
            <label style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 'var(--fs-sm)' }}>
              <input type="radio" checked={r.if.geo === 'in'} onChange={() => set(i, { ...r, if: { ...r.if, geo: 'in' } })} />Viewer is located in
            </label>
            <label style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 'var(--fs-sm)' }}>
              <input type="radio" checked={r.if.geo === 'not_in'} onChange={() => set(i, { ...r, if: { ...r.if, geo: 'not_in' } })} />Viewer is not located in
            </label>
            <input {...inp} style={{ ...inp.style, marginTop: 6, width: '100%' }} placeholder="WORLD, or AU, NZ, GB"
              value={r.if.countries.join(', ')}
              onChange={e => set(i, { ...r, if: { ...r.if, countries: e.target.value.split(',').map(x => x.trim().toUpperCase()).filter(Boolean) } })} />
            <div style={{ fontSize: 'var(--fs-micro)', color: 'var(--faint)', marginTop: 4 }}>ISO country codes; WORLD means everywhere.</div>
          </div>
          {/* THEN */}
          <div>
            <div className="sec-label" style={{ margin: '0 0 6px' }}>Then</div>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
              <select className="inp sel-sm" value={r.then.access} onChange={e => set(i, { ...r, then: { ...r.then, access: e.target.value as any, terms: e.target.value === 'premium' ? (r.then.terms?.length ? r.then.terms : [defaultTerm()]) : r.then.terms } })}
                style={{ ...inp.style, fontWeight: 600, color: r.then.access === 'free' ? 'var(--ok,#4ade80)' : r.then.access === 'members' ? '#7dd3fc' : 'var(--brand,#3f7bff)' }}>
                <option value="free">Access is free</option>
                <option value="members">Access for members only</option>
                <option value="premium">Access is premium</option>
              </select>
              {r.then.access !== 'free' && (
                <input {...inp} placeholder="user groups: site-users, members" style={{ ...inp.style, minWidth: 200 }}
                  value={(r.then.userGroups ?? []).join(', ')}
                  onChange={e => set(i, { ...r, then: { ...r.then, userGroups: e.target.value.split(',').map(x => x.trim()).filter(Boolean) } })} />
              )}
            </div>
            {r.then.access === 'premium' && (
              <div style={{ marginTop: 8 }}>
                <div style={{ fontSize: 'var(--fs-micro)', color: 'var(--faint)', textTransform: 'uppercase', letterSpacing: '.04em', marginBottom: 4 }}>Terms · length and price of the access period</div>
                {(r.then.terms ?? []).map((t, k) => (
                  <TermRow key={k} t={t} onChange={nt => set(i, { ...r, then: { ...r.then, terms: (r.then.terms ?? []).map((x, q) => q === k ? nt : x) } })}
                    onRemove={() => set(i, { ...r, then: { ...r.then, terms: (r.then.terms ?? []).filter((_, q) => q !== k) } })} />
                ))}
                <button className="btn ghost" style={{ fontSize: 'var(--fs-xs)', padding: '2px 8px' }} onClick={() => set(i, { ...r, then: { ...r.then, terms: [...(r.then.terms ?? []), defaultTerm()] } })}>+ Add term</button>
              </div>
            )}
          </div>
          <div style={{ display: 'grid', gap: 2 }}>
            <button className="xbtn" title="Remove rule" onClick={() => onChange(rules.filter((_, k) => k !== i))}>✕</button>
            <button className="xbtn" title="Move up" disabled={i === 0} onClick={() => move(i, -1)}>↑</button>
            <button className="xbtn" title="Move down" disabled={i === rules.length - 1} onClick={() => move(i, 1)}>↓</button>
          </div>
        </div>
      ))}
      <button className="btn ghost" style={{ justifySelf: 'start' }} onClick={() => onChange([...rules, { id: newId(), for: { scopes: ['this'] }, if: { geo: 'in', countries: ['WORLD'] }, then: { access: 'free' } }])}>+ Add rule</button>
    </div>
  )
}

function defaultTerm(): AccessTerm {
  return { productKey: `term-${Date.now().toString(36)}`, kind: 'period', count: 1, unit: 'month', priceCents: 0, currency: 'AUD', taxPct: 0 }
}

function TermRow({ t, onChange, onRemove }: { t: AccessTerm; onChange: (t: AccessTerm) => void; onRemove: () => void }) {
  return (
    <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap', padding: '6px 8px', borderRadius: 999, background: 'rgba(63,123,255,.10)', border: '1px solid rgba(63,123,255,.35)', marginBottom: 4 }}>
      <select className="inp sel-sm" value={t.kind} onChange={e => onChange({ ...t, kind: e.target.value as any })}>
        <option value="period">Period</option><option value="published_dates">Published dates</option>
      </select>
      {t.kind === 'period' && <>
        <input {...inp} type="number" min={1} style={{ ...inp.style, width: 60 }} value={t.count ?? 1} onChange={e => onChange({ ...t, count: Math.max(1, Number(e.target.value) || 1) })} />
        <select className="inp sel-sm" value={t.unit ?? 'month'} onChange={e => onChange({ ...t, unit: e.target.value as any })}>
          <option value="day">day/s</option><option value="week">week/s</option><option value="month">month/s</option><option value="year">year/s</option>
        </select>
      </>}
      <span style={{ color: 'var(--faint)' }}>$</span>
      <input {...inp} type="number" min={0} step="0.01" style={{ ...inp.style, width: 90 }} placeholder="Price" value={t.priceCents ? (t.priceCents / 100).toFixed(2) : ''} onChange={e => onChange({ ...t, priceCents: Math.round((Number(e.target.value) || 0) * 100) })} />
      <input {...inp} maxLength={3} style={{ ...inp.style, width: 58 }} value={t.currency} onChange={e => onChange({ ...t, currency: e.target.value.toUpperCase() })} />
      <input {...inp} type="number" min={0} max={100} style={{ ...inp.style, width: 60 }} placeholder="tax" value={t.taxPct ?? ''} onChange={e => onChange({ ...t, taxPct: e.target.value === '' ? undefined : Number(e.target.value) })} />
      <span style={{ fontSize: 'var(--fs-micro)', color: 'var(--faint)' }}>% tax</span>
      <input {...inp} style={{ ...inp.style, width: 130, fontFamily: 'ui-monospace,monospace' }} title="Product key: the same product at every payment provider" value={t.productKey} onChange={e => onChange({ ...t, productKey: e.target.value.replace(/[^a-zA-Z0-9_-]/g, '') })} />
      <button className="xbtn" onClick={onRemove}>✕</button>
    </div>
  )
}
