// ============================================================================
//  RuleEditor — one rung of the publishing ladder.
//
//  The ladder: account default < content type < channel / event / station <
//  asset. This editor is used at every rung. For each field it shows the
//  value the rung would INHERIT (from the rungs beneath it, greyed, with the
//  rung it comes from named) and a switch to override it here. A rung stores
//  only what it overrides, which is what keeps a station's rule to the two
//  lines that differ from the account default.
//
//  Targets are chosen from the client's own publishing points: the catalogue,
//  its registered apps, and the social accounts it has configured. Nothing
//  else is offered, and the API refuses anything else.
// ============================================================================
import { useEffect, useMemo, useState } from 'react'
import { api, type RuleSettings, type RuleKey, type ResolvedRules, type PublishingPoints, type PublishTarget, type Rung } from './api'
import { navigate } from './router'
import { AccessRulesEditor } from './AccessRulesEditor'

const RUNG_LABEL: Record<Rung, string> = {
  baseline: 'platform default', account: 'account default', schema: 'content type rule', owner: 'channel / event / station rule', asset: 'this item',
}
const KEY_LABEL: Record<RuleKey, string> = {
  targets: 'Publish to', autoPublish: 'Auto-publish', availableFrom: 'Available from', expire: 'Expires',
  geo: 'Geo access', access: 'Access', paywall: 'Paywall', gate: 'Publish gate', accessRules: 'Access rules',
}
const KEYS: RuleKey[] = ['targets', 'autoPublish', 'availableFrom', 'expire', 'accessRules', 'geo', 'access', 'paywall', 'gate']

function describe(k: RuleKey, v: any, points: PublishingPoints | null): string {
  if (v === undefined) return '—'
  switch (k) {
    case 'targets': {
      const t: PublishTarget[] = v ?? []
      if (!t.length) return 'nowhere (publishing is a no-op)'
      return t.map(x => x.kind === 'portal' ? 'Catalogue'
        : x.kind === 'app' ? `App: ${points?.apps.find(a => a.appId === x.appId)?.name ?? x.appId.slice(0, 8)}`
        : `${x.platform ?? 'social'}: ${points?.social.find(s => s.targetId === x.targetId)?.name ?? x.targetId.slice(0, 8)}`).join(', ')
    }
    case 'autoPublish': return v ? 'publish as soon as built and gated' : 'publish by hand'
    case 'availableFrom': return v.mode === 'at' ? `from ${new Date(v.at).toLocaleString()}` : 'when published'
    case 'expire': return v.mode === 'never' ? 'never' : v.mode === 'days' ? `${v.days} day${v.days === 1 ? '' : 's'} after it becomes available` : `on ${new Date(v.at).toLocaleString()}`
    case 'geo': return v.mode === 'worldwide' ? 'worldwide' : `${v.mode === 'allow' ? 'only in' : 'blocked in'} ${(v.countries ?? []).join(', ') || '(no countries)'}`
    case 'access': return v === 'free' ? 'free' : v === 'entitled' ? 'entitlement required' : 'paid (paywall)'
    case 'paywall': return v ? [v.tier, v.priceCents != null ? `${(v.priceCents / 100).toFixed(2)} ${v.currency ?? ''}` : ''].filter(Boolean).join(' · ') || 'set' : 'none'
    case 'gate': return `${v.requireReview ? 'review required' : 'no review needed'}, ${v.blockOnQcFail ? 'blocked on QC fail' : 'QC advisory'}`
    case 'accessRules': return !v?.length ? 'none (simple fields decide)' : `${v.length} rule${v.length === 1 ? '' : 's'}: ` + v.map((r: any) => `${r.for.scopes.join('+') || 'types'} ${r.if.geo === 'in' ? 'in' : 'not in'} ${r.if.countries.join(',')} → ${r.then.access}`).join('; ')
  }
}

export function RuleEditor({ scopeKind, scopeId, title, resolveQuery, compact, onSaved }: {
  scopeKind: 'account' | 'schema' | 'owner' | 'asset'
  /** For account: null. For asset: the asset id (saved through setVodAvailability). */
  scopeId: string | null
  title?: string
  /** How to ask the server what this rung inherits (the rungs beneath it). */
  resolveQuery: { assetId?: string; schemaId?: string | null; channelId?: string | null; eventId?: string | null }
  compact?: boolean
  onSaved?: () => void
}) {
  const [points, setPoints] = useState<PublishingPoints | null>(null)
  const [resolved, setResolved] = useState<ResolvedRules | null>(null)
  const [own, setOwn] = useState<RuleSettings>({})
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [msg, setMsg] = useState('')

  async function load() {
    try {
      const [p, r] = await Promise.all([api.publishingPoints(), api.resolvePublishing(resolveQuery)])
      setPoints(p); setResolved(r)
      if (scopeKind === 'asset') {
        const a = await api.vodAvailability(scopeId!)
        setOwn(a.override ?? {})
      } else {
        const rule = await api.publishingRule(scopeKind, scopeId)
        setOwn(rule.settings ?? {})
      }
    } catch (e: any) { setErr(e.message) }
  }
  useEffect(() => { load() /* eslint-disable-next-line */ }, [scopeKind, scopeId, JSON.stringify(resolveQuery)])

  // What this rung inherits = the resolution WITHOUT this rung's own values.
  const inherited = useMemo(() => {
    if (!resolved) return null
    const below = resolved.rungs.filter(r => r.rung !== scopeKind)
    const settings: any = {}; const sources: any = {}
    for (const k of KEYS) { settings[k] = (resolved.settings as any)[k]; sources[k] = resolved.sources[k] }
    // If the server's resolution included this rung's stored values, roll them back to the rung beneath.
    for (const k of KEYS) {
      if (resolved.sources[k] !== scopeKind) continue
      let v: any = undefined; let src: Rung = 'baseline'
      for (const r of below) { const s: any = r.settings ?? {}; if (s[k] !== undefined) { v = s[k]; src = r.rung } }
      if (v === undefined) { settings[k] = undefined; sources[k] = 'baseline' } else { settings[k] = v; sources[k] = src }
    }
    return { settings, sources }
  }, [resolved, scopeKind])

  const overriding = (k: RuleKey) => own[k] !== undefined
  const setKey = (k: RuleKey, v: any) => setOwn(o => { const n = { ...o }; if (v === undefined) delete n[k]; else (n as any)[k] = v; return n })
  const toggle = (k: RuleKey) => {
    if (overriding(k)) return setKey(k, undefined)
    const start = inherited?.settings[k]
    setKey(k, start === undefined ? DEFAULTS[k] : JSON.parse(JSON.stringify(start)))
  }

  async function save() {
    setBusy(true); setErr(''); setMsg('')
    try {
      if (scopeKind === 'asset') await api.setVodAvailability(scopeId!, own)
      else await api.putPublishingRule(scopeKind, scopeId, own)
      setMsg('Saved.'); await load(); onSaved?.()
    } catch (e: any) { setErr(e.message) } finally { setBusy(false) }
  }

  if (!inherited || !points) return <div className="loading">{err || 'Loading publishing rules…'}</div>
  const overrides = KEYS.filter(overriding).length
  return (
    <div>
      {title && <div className="sec-label">{title}</div>}
      <div style={{ fontSize: 'var(--fs-sm)', color: 'var(--muted)', marginBottom: 10 }}>
        {scopeKind === 'account'
          ? 'The account default. Every content type, channel, event and station inherits these unless it sets its own.'
          : `Grey values are inherited. Switch a field on to set it here${scopeKind === 'asset' ? ' for this item only' : ''}; anything left off follows the rung beneath.`}
        {overrides > 0 && <span> · {overrides} field{overrides === 1 ? '' : 's'} set here</span>}
      </div>
      <div style={{ display: 'grid', gap: 10 }}>
        {KEYS.map(k => {
          const on = overriding(k)
          const inhV = inherited.settings[k], inhSrc = inherited.sources[k]
          return (
            <div key={k} style={{ display: 'grid', gridTemplateColumns: k === 'accessRules' ? '1fr' : compact ? '150px 1fr' : '180px 1fr', gap: 10, alignItems: 'start', padding: '8px 10px', borderRadius: 8, background: on ? 'rgba(63,123,255,.06)' : 'transparent', border: `1px solid ${on ? 'rgba(63,123,255,.35)' : 'var(--border)'}` }}>
              <div>
                <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 'var(--fs-sm)', fontWeight: 600, cursor: scopeKind === 'account' ? 'default' : 'pointer' }}>
                  {scopeKind !== 'account' && <input type="checkbox" checked={on} onChange={() => toggle(k)} />}
                  {KEY_LABEL[k]}
                </label>
                {scopeKind !== 'account' && (
                  <div style={{ fontSize: 'var(--fs-micro)', color: 'var(--faint)', marginTop: 4 }}>
                    {on ? 'set here' : `inherits: ${RUNG_LABEL[inhSrc as Rung]}`}
                  </div>
                )}
              </div>
              <div>
                {(on || scopeKind === 'account') ? (
                  <FieldControl k={k} value={scopeKind === 'account' ? (own[k] ?? inhV ?? DEFAULTS[k]) : own[k]} points={points} scopeKind={scopeKind}
                    onChange={v => setKey(k, v)} />
                ) : (
                  <div style={{ fontSize: 'var(--fs-sm)', color: 'var(--faint)' }}>{describe(k, inhV, points)}</div>
                )}
              </div>
            </div>
          )
        })}
      </div>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 12 }}>
        <button className="btn primary" disabled={busy} onClick={save}>{busy ? 'Saving…' : 'Save publishing rule'}</button>
        {scopeKind !== 'account' && scopeKind !== 'asset' && overrides > 0 && (
          <button className="btn ghost" disabled={busy} onClick={async () => { setBusy(true); try { await api.deletePublishingRule(scopeKind, scopeId!); setOwn({}); await load(); onSaved?.() } catch (e: any) { setErr(e.message) } finally { setBusy(false) } }}>
            Remove this rule (inherit everything)
          </button>
        )}
        {msg && <span style={{ color: 'var(--ok,#4ade80)', fontSize: 'var(--fs-sm)' }}>{msg}</span>}
        {err && <span style={{ color: '#fca5a5', fontSize: 'var(--fs-sm)' }}>{err}</span>}
        <span style={{ flex: 1 }} />
        <button className="btn ghost" style={{ fontSize: 'var(--fs-xs)' }} onClick={() => navigate('/apikeys')} title="Publishing points are the apps registered here and the social accounts configured for this account">Manage apps</button>
      </div>
    </div>
  )
}

const DEFAULTS: Record<RuleKey, any> = {
  targets: [{ kind: 'portal' }], autoPublish: false, availableFrom: { mode: 'publish' }, expire: { mode: 'never' },
  geo: { mode: 'worldwide', countries: [] }, access: 'free', paywall: null, gate: { requireReview: false, blockOnQcFail: false }, accessRules: [],
}

function FieldControl({ k, value, points, onChange, scopeKind }: { k: RuleKey; value: any; points: PublishingPoints; onChange: (v: any) => void; scopeKind: 'account' | 'schema' | 'owner' | 'asset' }) {
  const inp = { className: 'inp', style: { fontSize: 'var(--fs-sm)', padding: '5px 8px' } as any }
  switch (k) {
    case 'accessRules':
      return <AccessRulesEditor value={value ?? []} onChange={onChange} scopeKind={scopeKind} />
    case 'targets': {
      const t: PublishTarget[] = value ?? []
      const has = (p: (x: PublishTarget) => boolean) => t.some(p)
      const flip = (on: boolean, target: PublishTarget, p: (x: PublishTarget) => boolean) => onChange(on ? [...t.filter(x => !p(x)), target] : t.filter(x => !p(x)))
      return (
        <div style={{ display: 'grid', gap: 4, fontSize: 'var(--fs-sm)' }}>
          <label style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <input type="checkbox" checked={has(x => x.kind === 'portal')} onChange={e => flip(e.target.checked, { kind: 'portal' }, x => x.kind === 'portal')} />Catalogue (portal)
          </label>
          {points.apps.length === 0 && <div style={{ color: 'var(--faint)' }}>No registered apps yet. Register one under API Keys & Apps to publish to it.</div>}
          {points.apps.map(a => (
            <label key={a.appId} style={{ display: 'flex', gap: 8, alignItems: 'center', opacity: a.enabled ? 1 : .6 }}>
              <input type="checkbox" checked={has(x => x.kind === 'app' && x.appId === a.appId)} onChange={e => flip(e.target.checked, { kind: 'app', appId: a.appId }, x => x.kind === 'app' && x.appId === a.appId)} />
              App: {a.name} <span style={{ color: 'var(--faint)' }}>({a.type}{a.enabled ? '' : ', disabled'})</span>
            </label>
          ))}
          {points.social.length === 0 && <div style={{ color: 'var(--faint)' }}>No social accounts configured for this account.</div>}
          {points.social.map(s => (
            <label key={s.targetId} style={{ display: 'flex', gap: 8, alignItems: 'center', opacity: s.enabled ? 1 : .6 }}>
              <input type="checkbox" checked={has(x => x.kind === 'social' && x.targetId === s.targetId)} onChange={e => flip(e.target.checked, { kind: 'social', targetId: s.targetId, platform: s.platform }, x => x.kind === 'social' && x.targetId === s.targetId)} />
              {s.platform}: {s.name} <span style={{ color: 'var(--faint)' }}>{s.account ? `(${s.account})` : ''}{(s as { off?: boolean }).off ? ' off: X is not on for this account' : s.enabled ? '' : ' disabled'}</span>
            </label>
          ))}
        </div>
      )
    }
    case 'autoPublish':
      return <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 'var(--fs-sm)' }}><input type="checkbox" checked={!!value} onChange={e => onChange(e.target.checked)} />Publish automatically once built and gated</label>
    case 'availableFrom':
      return (
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <select className="inp sel-sm" value={value?.mode ?? 'publish'} onChange={e => onChange(e.target.value === 'at' ? { mode: 'at', at: value?.at ?? new Date().toISOString() } : { mode: 'publish' })}>
            <option value="publish">When published</option><option value="at">At a set time</option>
          </select>
          {value?.mode === 'at' && <input {...inp} type="datetime-local" value={(value.at ?? '').slice(0, 16)} onChange={e => onChange({ mode: 'at', at: new Date(e.target.value).toISOString() })} />}
        </div>)
    case 'expire':
      return (
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <select className="inp sel-sm" value={value?.mode ?? 'never'} onChange={e => onChange(e.target.value === 'days' ? { mode: 'days', days: value?.days ?? 30 } : e.target.value === 'at' ? { mode: 'at', at: value?.at ?? new Date().toISOString() } : { mode: 'never' })}>
            <option value="never">Never</option><option value="days">After a number of days</option><option value="at">On a date</option>
          </select>
          {value?.mode === 'days' && <input {...inp} type="number" min={1} style={{ ...inp.style, width: 90 }} value={value.days} onChange={e => onChange({ mode: 'days', days: Math.max(1, Number(e.target.value) || 1) })} />}
          {value?.mode === 'at' && <input {...inp} type="datetime-local" value={(value.at ?? '').slice(0, 16)} onChange={e => onChange({ mode: 'at', at: new Date(e.target.value).toISOString() })} />}
        </div>)
    case 'geo':
      return (
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <select className="inp sel-sm" value={value?.mode ?? 'worldwide'} onChange={e => onChange({ mode: e.target.value, countries: value?.countries ?? [] })}>
            <option value="worldwide">Worldwide</option><option value="allow">Only in these countries</option><option value="block">Blocked in these countries</option>
          </select>
          {value?.mode !== 'worldwide' && <input {...inp} placeholder="AU, NZ, GB" value={(value?.countries ?? []).join(', ')}
            onChange={e => onChange({ mode: value.mode, countries: e.target.value.split(',').map(x => x.trim().toUpperCase()).filter(x => x.length === 2) })} />}
        </div>)
    case 'access':
      return (
        <select className="inp sel-sm" value={value ?? 'free'} onChange={e => onChange(e.target.value)}>
          <option value="free">Free</option><option value="entitled">Entitlement required</option><option value="paid">Paid (paywall)</option>
        </select>)
    case 'paywall':
      return (
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <label style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 'var(--fs-sm)' }}><input type="checkbox" checked={!!value} onChange={e => onChange(e.target.checked ? { tier: 'standard' } : null)} />Paywall</label>
          {value && <>
            <input {...inp} placeholder="tier" style={{ ...inp.style, width: 120 }} value={value.tier ?? ''} onChange={e => onChange({ ...value, tier: e.target.value })} />
            <input {...inp} type="number" placeholder="price (cents)" style={{ ...inp.style, width: 120 }} value={value.priceCents ?? ''} onChange={e => onChange({ ...value, priceCents: e.target.value === '' ? undefined : Number(e.target.value) })} />
            <input {...inp} placeholder="AUD" maxLength={3} style={{ ...inp.style, width: 70 }} value={value.currency ?? ''} onChange={e => onChange({ ...value, currency: e.target.value.toUpperCase() })} />
          </>}
        </div>)
    case 'gate':
      return (
        <div style={{ display: 'grid', gap: 4, fontSize: 'var(--fs-sm)' }}>
          <label style={{ display: 'flex', gap: 8, alignItems: 'center' }}><input type="checkbox" checked={!!value?.requireReview} onChange={e => onChange({ requireReview: e.target.checked, blockOnQcFail: !!value?.blockOnQcFail })} />Require an approved review before publishing</label>
          <label style={{ display: 'flex', gap: 8, alignItems: 'center' }}><input type="checkbox" checked={!!value?.blockOnQcFail} onChange={e => onChange({ requireReview: !!value?.requireReview, blockOnQcFail: e.target.checked })} />Block publishing while QC has failed</label>
        </div>)
  }
}
