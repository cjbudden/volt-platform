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
import { api, type RuleSettings, type RuleKey, type ResolvedRules, type PublishingPoints, type PublishTarget, type Rung, type ArchiveTarget } from './api'
import { useAccess } from './access'
import { navigate } from './router'
import { AccessRulesEditor } from './AccessRulesEditor'

const RUNG_LABEL: Record<Rung, string> = {
  baseline: 'platform default', account: 'account default', schema: 'content type rule', owner: 'channel / event / station rule', asset: 'this item',
}
const KEY_LABEL: Record<RuleKey, string> = {
  targets: 'Publish to', autoPublish: 'Auto-publish', availableFrom: 'Available from', expire: 'Expires',
  geo: 'Geo access', access: 'Access', paywall: 'Paywall', gate: 'Publish gate', accessRules: 'Access rules',
  archive: 'Archive copies',
}
// Every key a rung can hold. Archive copies (Mirror and Archive, build queue
// H3-6) are offered only to an account with the add-on (SHOWN below); the
// inheritance arithmetic still covers them, so a rung's stored copies are
// never lost when someone without the add-on view saves it.
const KEYS: RuleKey[] = ['targets', 'autoPublish', 'availableFrom', 'expire', 'accessRules', 'geo', 'access', 'paywall', 'gate', 'archive']

const ON_LABEL = { ingest: 'when it lands', publish: 'when it is published', recording: 'recordings as each programme or hour ends', schedule: 'nightly, what it does not hold yet' } as const
type CopyWhat = 'source' | 'sidecars'
const WHAT_LABEL: Record<CopyWhat, string> = { source: 'original', sidecars: 'sidecars' }
type CopyOn = keyof typeof ON_LABEL

function describe(k: RuleKey, v: any, points: PublishingPoints | null, archiveTargets: ArchiveTarget[] = []): string {
  if (v === undefined) return '—'
  switch (k) {
    case 'archive': {
      const copies: { targetId: string; on: CopyOn[]; what?: CopyWhat[] }[] = v?.copies ?? []
      if (!copies.length) return 'no copies'
      const list = copies.map(c => `${archiveTargets.find(t => t.id === c.targetId)?.name ?? c.targetId.slice(0, 8)}${c.what?.length ? ` (${c.what.map(w => WHAT_LABEL[w]).join(' and ')})` : ''} ${c.on.map(o => ON_LABEL[o]).join(' and ')}`).join('; ')
      return v.offPeak ? `${list}; only between ${v.offPeak.from} and ${v.offPeak.to}${v.offPeak.timeZone ? ` (${v.offPeak.timeZone})` : ' (UTC)'}` : list
    }
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
  // Archive copies need the Mirror and Archive add-on and an administrator
  // (the storage targets they name are read through /api/archive).
  const { isAdminTier, me } = useAccess()
  const archiveOn = isAdminTier && !!me?.account?.licences?.includes('mirror_archive')
  const [archiveTargets, setArchiveTargets] = useState<ArchiveTarget[]>([])
  useEffect(() => { if (archiveOn) api.archiveTargets().then(r => setArchiveTargets(r.items)).catch(() => setArchiveTargets([])) }, [archiveOn])
  const SHOWN = archiveOn ? KEYS : KEYS.filter(k => k !== 'archive')

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
  const overrides = SHOWN.filter(overriding).length
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
        {SHOWN.map(k => {
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
                    archiveTargets={archiveTargets} onChange={v => setKey(k, v)} />
                ) : (
                  <div style={{ fontSize: 'var(--fs-sm)', color: 'var(--faint)' }}>{describe(k, inhV, points, archiveTargets)}</div>
                )}
              </div>
            </div>
          )
        })}
      </div>
      {/* Wraps: in a stream's narrow settings drawer the buttons and the
          Saved line did not fit on one row. */}
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 12, flexWrap: 'wrap' }}>
        <button className="btn primary" disabled={busy} onClick={save}>{busy ? 'Saving…' : 'Save publishing rule'}</button>
        {scopeKind !== 'account' && scopeKind !== 'asset' && overrides > 0 && (
          <button className="btn ghost" disabled={busy} onClick={async () => { setBusy(true); try { await api.deletePublishingRule(scopeKind, scopeId!); setOwn({}); await load(); onSaved?.() } catch (e: any) { setErr(e.message) } finally { setBusy(false) } }}>
            Remove this rule (inherit everything)
          </button>
        )}
        {msg && <span style={{ color: 'var(--ok,#4ade80)', fontSize: 'var(--fs-sm)' }}>{msg}</span>}
        {err && <span style={{ color: '#fca5a5', fontSize: 'var(--fs-sm)' }}>{err}</span>}
        <span style={{ flex: 1 }} />
        <button className="btn ghost" style={{ fontSize: 'var(--fs-xs)' }} onClick={() => navigate('/apikeys')} title="Apps are registered in API Keys & Apps">Manage apps</button>
        <button className="btn ghost" style={{ fontSize: 'var(--fs-xs)' }} onClick={() => navigate('/social')} title="Social accounts are added in Social accounts">Social accounts</button>
      </div>
    </div>
  )
}

const DEFAULTS: Record<RuleKey, any> = {
  targets: [{ kind: 'portal' }], autoPublish: false, availableFrom: { mode: 'publish' }, expire: { mode: 'never' },
  geo: { mode: 'worldwide', countries: [] }, access: 'free', paywall: null, gate: { requireReview: false, blockOnQcFail: false }, accessRules: [],
  archive: { copies: [], offPeak: null },
}

function FieldControl({ k, value, points, onChange, scopeKind, archiveTargets = [] }: { k: RuleKey; value: any; points: PublishingPoints; onChange: (v: any) => void; scopeKind: 'account' | 'schema' | 'owner' | 'asset'; archiveTargets?: ArchiveTarget[] }) {
  const inp = { className: 'inp', style: { fontSize: 'var(--fs-sm)', padding: '5px 8px' } as any }
  switch (k) {
    case 'archive':
      return <ArchiveControl value={value} targets={archiveTargets} onChange={onChange} recordings={scopeKind === 'account' || scopeKind === 'owner'} />
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

/**
 * Archive copies (Mirror and Archive, build queue H3-3 rules, H3-6 console):
 * for each storage target, whether the original is copied there when it lands,
 * when it is published, or both, and optionally only inside an off-peak window
 * so copies never compete with live contribution. An empty list at this rung
 * switches copies off for everything beneath it that would otherwise inherit
 * them. On the account and a channel's or event's own rung, "Recordings" (H3-7)
 * archives the recording itself: one file per programme (or per hour without
 * a guide) as each ends; a content type or a single asset has no recording,
 * so the box is not offered there.
 */
function ArchiveControl({ value, targets, onChange, recordings = false }: { value: any; targets: ArchiveTarget[]; onChange: (v: any) => void; recordings?: boolean }) {
  const copies: { targetId: string; on: CopyOn[]; what?: CopyWhat[] }[] = value?.copies ?? []
  const offPeak: { from: string; to: string; timeZone?: string } | null = value?.offPeak ?? null
  const put = (c: typeof copies, o: typeof offPeak) => onChange({ copies: c, offPeak: o })
  const setOn = (targetId: string, when: CopyOn, yes: boolean) => {
    const cur = copies.find(c => c.targetId === targetId)
    const on = new Set(cur?.on ?? [])
    if (yes) on.add(when); else on.delete(when)
    const rest = copies.filter(c => c.targetId !== targetId)
    // Order kept as ingest, publish, recording, nightly, so the saved rule
    // reads the same way the form does; a target with none ticked is not
    // copied to. What it takes (H3-8) stays as it was.
    put(on.size ? [...rest, { targetId, on: (['ingest', 'publish', 'recording', 'schedule'] as const).filter(w => on.has(w)), ...(cur?.what ? { what: cur.what } : {}) }] : rest, offPeak)
  }
  // What an asset copy takes (H3-8): the original, its sidecars, or both.
  // Unsaid means the original alone, so that is what the boxes show then;
  // at least one stays ticked.
  const setWhat = (targetId: string, w: CopyWhat, yes: boolean) => {
    const cur = copies.find(c => c.targetId === targetId)
    if (!cur) return
    const set = new Set<CopyWhat>(cur.what?.length ? cur.what : ['source'])
    if (yes) set.add(w); else set.delete(w)
    if (!set.size) return
    const what = (['source', 'sidecars'] as const).filter(x => set.has(x))
    const next = { targetId, on: cur.on, ...(what.length === 1 && what[0] === 'source' ? {} : { what }) }
    put(copies.map(c => c.targetId === targetId ? next : c), offPeak)
  }
  const unknown = copies.filter(c => !targets.some(t => t.id === c.targetId))
  const zone = (() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone } catch { return 'UTC' } })()
  const small = { fontSize: 'var(--fs-sm)', padding: '5px 8px' }
  return (
    <div style={{ display: 'grid', gap: 6, fontSize: 'var(--fs-sm)' }} data-archive-control>
      {targets.length === 0 && (
        <div style={{ color: 'var(--faint)' }}>No storage targets yet. Add one on the{' '}
          <a href="/storage" onClick={e => { e.preventDefault(); navigate('/storage') }}>Storage</a> page, under Mirror and Archive.</div>
      )}
      {targets.map(t => {
        const cur = copies.find(c => c.targetId === t.id)
        return (
          <div key={t.id} style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap', opacity: t.status === 'active' ? 1 : .6 }} data-archive-target={t.name}>
            <b style={{ minWidth: 140 }}>{t.name}</b>
            <label style={{ display: 'flex', gap: 6, alignItems: 'center' }}><input type="checkbox" checked={!!cur?.on.includes('ingest')} onChange={e => setOn(t.id, 'ingest', e.target.checked)} />When it lands</label>
            <label style={{ display: 'flex', gap: 6, alignItems: 'center' }}><input type="checkbox" checked={!!cur?.on.includes('publish')} onChange={e => setOn(t.id, 'publish', e.target.checked)} />When it is published</label>
            {(recordings || cur?.on.includes('recording')) && <label style={{ display: 'flex', gap: 6, alignItems: 'center' }} title="One file per programme, or per hour without a guide, from the top rendition, with a metadata file beside it"><input type="checkbox" checked={!!cur?.on.includes('recording')} onChange={e => setOn(t.id, 'recording', e.target.checked)} />Recordings</label>}
            <label style={{ display: 'flex', gap: 6, alignItems: 'center' }} title="Once a day, copy anything this rule covers that the target does not hold yet, such as files from before the rule existed"><input type="checkbox" checked={!!cur?.on.includes('schedule')} onChange={e => setOn(t.id, 'schedule', e.target.checked)} />Nightly</label>
            {cur && cur.on.some(o => o !== 'recording') && <span style={{ display: 'flex', gap: 10, alignItems: 'center', color: 'var(--muted)' }} data-archive-what>
              Copy:
              <label style={{ display: 'flex', gap: 6, alignItems: 'center' }}><input type="checkbox" checked={!cur.what?.length || cur.what.includes('source')} onChange={e => setWhat(t.id, 'source', e.target.checked)} />Original</label>
              <label style={{ display: 'flex', gap: 6, alignItems: 'center' }} title="A metadata file, the caption files, any other files that came with it, and the poster, named after the original"><input type="checkbox" checked={!!cur.what?.includes('sidecars')} onChange={e => setWhat(t.id, 'sidecars', e.target.checked)} />Sidecars</label>
            </span>}
            <span style={{ color: 'var(--faint)' }}>{t.siteName ? `at ${t.siteName}` : ''}{t.status === 'active' ? '' : ', disabled: no new copies'}</span>
          </div>
        )
      })}
      {unknown.length > 0 && <div style={{ color: 'var(--warn)' }}>{unknown.length} storage target{unknown.length === 1 ? '' : 's'} in this rule no longer exist{unknown.length === 1 ? 's' : ''}; saving drops {unknown.length === 1 ? 'it' : 'them'}.
        <button className="btn ghost sm" style={{ marginLeft: 8 }} onClick={() => put(copies.filter(c => targets.some(t => t.id === c.targetId)), offPeak)}>Drop now</button></div>}
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginTop: 4 }}>
        <label style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          <input type="checkbox" checked={!!offPeak} onChange={e => put(copies, e.target.checked ? { from: '22:00', to: '06:00', timeZone: zone } : null)} />Copy only between
        </label>
        {offPeak && <>
          <input className="inp" type="time" aria-label="Copies start at" style={{ ...small, width: 110 }} value={offPeak.from} onChange={e => put(copies, { ...offPeak, from: e.target.value })} />
          <span>and</span>
          <input className="inp" type="time" aria-label="Copies stop at" style={{ ...small, width: 110 }} value={offPeak.to} onChange={e => put(copies, { ...offPeak, to: e.target.value })} />
          <input className="inp" aria-label="Time zone of the window" placeholder="Europe/London" style={{ ...small, width: 170 }} value={offPeak.timeZone ?? ''} onChange={e => put(copies, { ...offPeak, timeZone: e.target.value || undefined })} />
        </>}
      </div>
      <div style={{ color: 'var(--faint)', fontSize: 'var(--fs-micro)' }}>
        The original file is copied once per target. Sidecars are a metadata file, the caption files, other files that came with the asset, and its poster. Nightly copies anything the target does not hold yet.{recordings ? ' Recordings are copied as each programme ends (each hour without a guide), one file each with a metadata file beside it.' : ''} Outside the window a copy waits for it to open. A rung with no target ticked switches copies off beneath it.
      </div>
    </div>
  )
}
