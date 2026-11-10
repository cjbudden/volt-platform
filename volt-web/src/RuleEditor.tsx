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
//
//  A rung is shown as the five sections of a policy (build queue P3-2,
//  publishing/PolicyFields.tsx): Lifecycle, Access, Protection, Distribution
//  and Retention. Each field has a padlock: a locked field cannot be changed
//  by the rungs beneath, and a field locked beneath this one is shown with
//  the rung that locked it and cannot be set here. A preset copies its
//  fields onto the rung. As the form changes it is checked with a dry run of
//  the save (?dryRun=1): blocking conflicts stop Save, warnings are saved and
//  shown, and the impact says how many titles the save changes. A save that
//  changes DRM on published titles asks first (409 confirm_repackage).
// ============================================================================
import { useEffect, useMemo, useState } from 'react'
import { api, type RuleKey, type RuleScope, type PublishingPoints, type PublishTarget, type Rung, type ArchiveTarget } from './api'
import { useAccess } from './access'
import { navigate } from './router'
import { AccessRulesEditor } from './AccessRulesEditor'
import { policyApi, policyRefusal, type PolicySettings, type ResolvedPolicy, type Preset, type PresetKey, type DryRun, type Impact } from './publishing/policyApi'
import { SECTIONS, SECTION_FIELD_LABEL, isSectionField, getVal, withVal, statedIds, baselineOf, describeSection, SectionFieldControl, Padlock, SectionGlyph, type FieldId } from './publishing/PolicyFields'
import './publishing/policy.css'

const RUNG_ORDER: Rung[] = ['baseline', 'account', 'schema', 'owner', 'asset']
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
type CopyWhat = 'source' | 'sidecars' | 'clips' | 'packages'
const WHAT_LABEL: Record<CopyWhat, string> = { source: 'original', sidecars: 'sidecars', clips: 'clips', packages: 'HLS/DASH package' }
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
  const asset = scopeKind === 'asset'
  const [points, setPoints] = useState<PublishingPoints | null>(null)
  const [resolved, setResolved] = useState<ResolvedPolicy | null>(null)
  const [own, setOwn] = useState<PolicySettings>({})
  // What this rung says besides its settings (build queue P3): the fields it
  // locks for the rungs beneath, and the preset it started from. An asset is
  // the last rung, so it locks nothing and keeps no preset.
  const [locks, setLocks] = useState<string[]>([])
  const [presetKey, setPresetKey] = useState<PresetKey | null>(null)
  const [presets, setPresets] = useState<Preset[]>([])
  const [loaded, setLoaded] = useState(false)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [msg, setMsg] = useState('')
  // The dry run of the rung as it stands in the form: conflicts and impact.
  const [check, setCheck] = useState<DryRun | null>(null)
  const [checking, setChecking] = useState(false)
  const [checkErr, setCheckErr] = useState('')
  // A save that changes DRM on published titles waits for this confirmation.
  const [confirm, setConfirm] = useState<{ message: string; impact: Impact | null } | null>(null)
  // Archive copies need the Mirror and Archive add-on and an administrator
  // (the storage targets they name are read through /api/archive).
  const { isAdminTier, me } = useAccess()
  const archiveOn = isAdminTier && !!me?.account?.licences?.includes('mirror_archive')
  const [archiveTargets, setArchiveTargets] = useState<ArchiveTarget[]>([])
  useEffect(() => { if (archiveOn) api.archiveTargets().then(r => setArchiveTargets(r.items)).catch(() => setArchiveTargets([])) }, [archiveOn])
  useEffect(() => { if (!asset) policyApi.presets().then(setPresets).catch(() => setPresets([])) }, [asset])

  async function load() {
    try {
      const [p, r] = await Promise.all([api.publishingPoints(), api.resolvePublishing(resolveQuery)])
      setPoints(p); setResolved(r as ResolvedPolicy)
      if (asset) {
        const a = await api.vodAvailability(scopeId!)
        setOwn((a.override ?? {}) as PolicySettings)
      } else {
        const rule = await policyApi.rule(scopeKind, scopeId)
        setOwn(rule.settings ?? {}); setLocks(rule.locked_fields ?? []); setPresetKey(rule.preset_key ?? null)
      }
      setLoaded(true)
    } catch (e: any) { setErr(e.message) }
  }
  useEffect(() => { load() /* eslint-disable-next-line */ }, [scopeKind, scopeId, JSON.stringify(resolveQuery)])

  // The dry run, a moment after each change: blocks stop Save, warnings are
  // shown and saved, and the impact says what the save would do to titles.
  const body = JSON.stringify({ own, locks, presetKey })
  useEffect(() => {
    if (asset || !loaded) return
    let gone = false
    setChecking(true)
    const t = setTimeout(async () => {
      try {
        const r = await policyApi.dryRun(scopeKind as RuleScope, scopeId, { settings: own, lockedFields: locks, presetKey })
        if (!gone) { setCheck(r); setCheckErr('') }
      } catch (e: any) { if (!gone) { setCheck(null); setCheckErr(e.message) } }
      finally { if (!gone) setChecking(false) }
    }, 450)
    return () => { gone = true; clearTimeout(t) }
    // eslint-disable-next-line
  }, [body, loaded, asset, scopeKind, scopeId])

  const rank = (r: Rung) => RUNG_ORDER.indexOf(r)
  const myRank = rank(scopeKind)

  /** What this rung inherits for a field: its value and the rung it comes
   *  from, from the rungs beneath this one only (the server's resolution
   *  includes this rung's own values, which are rolled back here). */
  const inheritedOf = (id: FieldId): { value: any; src: Rung } => {
    if (!resolved) return { value: undefined, src: 'baseline' }
    const below = resolved.rungs.filter(r => rank(r.rung) < myRank)
    const src: Rung = isSectionField(id) ? (resolved.fieldSources?.[id] ?? 'baseline') : resolved.sources[id as RuleKey] ?? 'baseline'
    if (rank(src) < myRank) return { value: isSectionField(id) ? getVal(resolved.settings, id) : (resolved.settings as any)[id], src }
    let value: any = undefined; let from: Rung = 'baseline'
    for (const r of below) { const v = getVal(r.settings as PolicySettings, id); if (v !== undefined) { value = v; from = r.rung } }
    if (value === undefined) value = isSectionField(id) ? baselineOf(id) : DEFAULTS[id as RuleKey]
    return { value, src: from }
  }
  /** The rung beneath this one that locked a field, if any. */
  const lockedAbove = (id: FieldId): Rung | null => {
    const by = resolved?.locks?.[id] ?? (isSectionField(id) ? resolved?.locks?.[id.split('.')[0]] : undefined)
    return by && rank(by) < myRank ? by : null
  }

  const shownKeys = archiveOn ? KEYS : KEYS.filter(k => k !== 'archive')
  const shown = (id: FieldId) => isSectionField(id) || shownKeys.includes(id as RuleKey)
  const overriding = (id: FieldId) => getVal(own, id) !== undefined
  const setField = (id: FieldId, v: any) => setOwn(o => withVal(o, id, v))
  const toggle = (id: FieldId) => {
    if (overriding(id)) return setField(id, undefined)
    const start = inheritedOf(id).value
    setField(id, start === undefined ? (isSectionField(id) ? baselineOf(id) : DEFAULTS[id as RuleKey]) : JSON.parse(JSON.stringify(start)))
  }
  const flipLock = (id: FieldId) => setLocks(l => l.includes(id) ? l.filter(x => x !== id) : [...l, id])
  function applyPreset(key: string) {
    const p = presets.find(x => x.key === key)
    if (!p) return
    // A preset is a starting point: its fields are copied onto this rung and
    // can be edited; fields it does not name keep what the rung had.
    setOwn(o => { let n = o; for (const id of statedIds(p.settings)) n = withVal(n, id, JSON.parse(JSON.stringify(getVal(p.settings, id)))); return n })
    setPresetKey(p.key)
  }

  // Which fields the current conflicts name, for the rows to show it.
  const flagged = useMemo(() => {
    const m = new Map<string, 'block' | 'warn'>()
    for (const c of check?.conflicts ?? []) for (const f of c.fields) if (m.get(f) !== 'block') m.set(f, c.level === 'block' ? 'block' : 'warn')
    return m
  }, [check])

  async function save(confirmed = false) {
    setBusy(true); setErr(''); setMsg('')
    try {
      if (asset) { await api.setVodAvailability(scopeId!, own); setMsg('Saved.') }
      else {
        const r = await policyApi.save(scopeKind as RuleScope, scopeId, { settings: own, lockedFields: locks, presetKey, ...(confirmed ? { confirm: true } : {}) })
        setConfirm(null)
        setMsg(r.warnings?.length ? `Saved, with ${r.warnings.length} warning${r.warnings.length === 1 ? '' : 's'}.` : 'Saved.')
      }
      await load(); onSaved?.()
    } catch (e: any) {
      const refusal = policyRefusal(e)
      if (refusal?.code === 'confirm_repackage') setConfirm({ message: refusal.message, impact: refusal.impact })
      else {
        setErr(e.message)
        if (refusal?.impact) setCheck({ dryRun: true, saved: false, canSave: false, conflicts: refusal.conflicts, impact: refusal.impact })
      }
    } finally { setBusy(false) }
  }

  if (!resolved || !points) return <div className="loading">{err || 'Loading publishing rules…'}</div>
  const overrides = statedIds(own).filter(shown).length
  const blocked = !!check && !check.canSave
  const preset = presets.find(p => p.key === presetKey)

  const row = (id: FieldId) => {
    const on = overriding(id)
    const lockBy = lockedAbove(id)
    const inh = inheritedOf(id)
    const label = isSectionField(id) ? SECTION_FIELD_LABEL[id] : KEY_LABEL[id as RuleKey]
    const editable = !lockBy && (on || scopeKind === 'account')
    const mine = locks.includes(id)
    const flag = flagged.get(id)
    const value = scopeKind === 'account' ? (getVal(own, id) ?? inh.value) : getVal(own, id)
    const cls = ['pol-row', id === 'accessRules' ? 'wide' : '', on && !lockBy ? 'on' : '', lockBy ? 'locked' : '', flag ?? ''].filter(Boolean).join(' ')
    return (
      <div key={id} className={cls} data-policy-field={id} data-locked-by={lockBy ?? undefined} data-flag={flag}>
        <div className="pol-head">
          <label className="pol-name" style={{ cursor: scopeKind === 'account' || lockBy ? 'default' : 'pointer' }}>
            {scopeKind !== 'account' && <input type="checkbox" checked={on} disabled={!!lockBy && !on} onChange={() => toggle(id)} aria-label={`Set ${label} here`} />}
            {label}
          </label>
          {lockBy
            ? <div className="pol-src lock"><Padlock size={12} />Locked by the {RUNG_LABEL[lockBy]}</div>
            : scopeKind !== 'account' && <div className="pol-src">{on ? 'set here' : `inherits: ${RUNG_LABEL[inh.src]}`}</div>}
        </div>
        <div className="pol-val">
          {editable
            ? (isSectionField(id)
              ? <SectionFieldControl id={id} value={value} onChange={v => setField(id, v)} />
              : <FieldControl k={id as RuleKey} value={value} points={points} scopeKind={scopeKind} archiveTargets={archiveTargets} onChange={v => setField(id, v)} />)
            : <div>{isSectionField(id) ? describeSection(id, inh.value) : describe(id as RuleKey, inh.value, points, archiveTargets)}</div>}
          {lockBy && on && (
            <div className="pol-note">
              This rung still sets a value of its own, which the lock overrides.{!asset && ' Save is refused until it is cleared.'}
              <button type="button" className="btn ghost sm" onClick={() => setField(id, undefined)}>Clear it</button>
            </div>)}
        </div>
        {!asset && (
          <button type="button" className="pol-lock" aria-pressed={!!lockBy || mine} disabled={!!lockBy}
            data-lock={id}
            aria-label={lockBy ? `${label} is locked by the ${RUNG_LABEL[lockBy]}` : mine ? `Unlock ${label}` : `Lock ${label}`}
            title={lockBy ? `Locked by the ${RUNG_LABEL[lockBy]}` : mine ? 'Locked here: the rungs beneath cannot change it. Choose to unlock.' : 'Lock it, so the rungs beneath cannot change it'}
            onClick={() => flipLock(id)}>
            <Padlock open={!lockBy && !mine} />
          </button>)}
      </div>
    )
  }

  return (
    <div className={compact ? 'pol-compact' : undefined} data-rule-editor={scopeKind}>
      {title && <div className="sec-label">{title}</div>}
      <div style={{ fontSize: 'var(--fs-sm)', color: 'var(--muted)', marginBottom: 10 }}>
        {scopeKind === 'account'
          ? 'The account default. Every content type, channel, event and station inherits these unless it sets its own.'
          : `Grey values are inherited. Switch a field on to set it here${asset ? ' for this item only' : ''}; anything left off follows the rung beneath.`}
        {!asset && ' The padlock locks a field, so the rungs beneath cannot change it.'}
        {overrides > 0 && <span> · {overrides} field{overrides === 1 ? '' : 's'} set here</span>}
        {locks.length > 0 && <span> · {locks.length} locked</span>}
      </div>
      {!asset && presets.length > 0 && (
        <div className="pol-presets" data-policy-presets>
          <select className="inp sel-sm" aria-label="Start from a preset" value="" onChange={e => { if (e.target.value) applyPreset(e.target.value) }}>
            <option value="">Start from a preset…</option>
            {presets.map(p => <option key={p.key} value={p.key}>{p.name}: {p.summary}</option>)}
          </select>
          {preset && <span className="pol-preset-name" data-preset={preset.key}><SectionGlyph k="protection" size={13} />Started from {preset.name}</span>}
          {preset && <button type="button" className="btn ghost sm" onClick={() => setPresetKey(null)}>Forget the preset</button>}
          {preset && (preset.key === 'geo_locked' || preset.key === 'rights_managed') && !(own.geo?.countries ?? []).length &&
            <span style={{ color: 'var(--warn)' }}>Choose the countries under Geo access.</span>}
        </div>)}
      {SECTIONS.map(sec => {
        const ids = sec.fields.filter(shown)
        if (!ids.length) return null
        return (
          <section key={sec.key} className="pol-sec" data-policy-section={sec.key}>
            <h3 className="pol-sec-h"><SectionGlyph k={sec.key} />{sec.label}</h3>
            <p className="pol-sec-hint">{sec.hint}</p>
            {ids.map(row)}
          </section>)
      })}
      {!asset && (check || checkErr || checking) && (
        <div className="pol-check" data-policy-check aria-live="polite">
          <div className="pol-check-h">Before you save{checking && <span style={{ color: 'var(--faint)', fontWeight: 400 }}> · checking…</span>}</div>
          {checkErr && <div className="pol-msg block">{checkErr}</div>}
          {check && <>
            <div className="pol-impact" data-impact>
              <span>Governs <b>{check.impact.assets}</b> title{check.impact.assets === 1 ? '' : 's'}</span>
              <span><b>{check.impact.published}</b> published</span>
              <span>Saving changes <b>{check.impact.changed}</b></span>
              {check.impact.repackage > 0 && <span style={{ color: 'var(--warn)' }}><b>{check.impact.repackage}</b> published title{check.impact.repackage === 1 ? '' : 's'} to be packaged again</span>}
              {(check.impact.unavailableNow ?? 0) > 0 && <span style={{ color: 'var(--warn)' }} data-impact-unavailable><b>{check.impact.unavailableNow}</b> become{check.impact.unavailableNow === 1 ? 's' : ''} unavailable now</span>}
            </div>
            {/* Published titles take up a save within about a minute (build queue P3-4). */}
            {(check.impact.publishedChanged ?? 0) > 0 && <div style={{ color: 'var(--muted)' }} data-impact-published>
              <b>{check.impact.publishedChanged}</b> published title{check.impact.publishedChanged === 1 ? '' : 's'} take{check.impact.publishedChanged === 1 ? 's' : ''} this up within a minute, without posting to social accounts again.</div>}
            {check.conflicts.map((c, i) => <ConflictLine key={c.code + i} level={c.level} message={c.message} />)}
            {check.impact.blocks.map(b => <ConflictLine key={'ib' + b.code} level="block" message={`${b.count} title${b.count === 1 ? '' : 's'}: ${b.message}`} titles={b.titles} />)}
            {check.impact.warnings.map(w => <ConflictLine key={'iw' + w.code} level="warn" message={`${w.count} title${w.count === 1 ? '' : 's'}: ${w.message}`} titles={w.titles} />)}
            {!check.conflicts.length && !check.impact.blocks.length && !check.impact.warnings.length && <div style={{ color: 'var(--muted)' }}>No conflicts.</div>}
          </>}
        </div>)}
      {confirm && (
        <div className="pol-confirm" role="alertdialog" aria-label="Confirm packaging again" data-policy-confirm>
          <b>{confirm.impact?.repackage ?? ''} published title{confirm.impact?.repackage === 1 ? '' : 's'} to be packaged again</b>
          <div>{confirm.message}</div>
          <div className="pol-foot">
            <button className="btn primary" disabled={busy} onClick={() => save(true)}>Package again and save</button>
            <button className="btn ghost" disabled={busy} onClick={() => setConfirm(null)}>Cancel</button>
          </div>
        </div>)}
      {/* Wraps: in a stream's narrow settings drawer the buttons and the
          Saved line did not fit on one row. */}
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 12, flexWrap: 'wrap' }}>
        <button className="btn primary" disabled={busy || blocked || !!confirm} onClick={() => save()}
          title={blocked ? 'Fix the conflicts marked above to save' : undefined}>{busy ? 'Saving…' : 'Save publishing rule'}</button>
        {scopeKind !== 'account' && !asset && (overrides > 0 || locks.length > 0) && (
          <button className="btn ghost" disabled={busy} onClick={async () => { setBusy(true); try { await api.deletePublishingRule(scopeKind, scopeId!); setOwn({}); setLocks([]); setPresetKey(null); await load(); onSaved?.() } catch (e: any) { setErr(e.message) } finally { setBusy(false) } }}>
            Remove this rule (inherit everything)
          </button>
        )}
        {blocked && <span style={{ color: 'var(--down)', fontSize: 'var(--fs-sm)' }}>Fix the conflicts marked above to save.</span>}
        {msg && <span style={{ color: 'var(--ok,#4ade80)', fontSize: 'var(--fs-sm)' }}>{msg}</span>}
        {err && <span style={{ color: '#fca5a5', fontSize: 'var(--fs-sm)' }}>{err}</span>}
        <span style={{ flex: 1 }} />
        <button className="btn ghost" style={{ fontSize: 'var(--fs-xs)' }} onClick={() => navigate('/apikeys')} title="Apps are registered in API Keys & Apps">Manage apps</button>
        <button className="btn ghost" style={{ fontSize: 'var(--fs-xs)' }} onClick={() => navigate('/social')} title="Social accounts are added in Social accounts">Social accounts</button>
      </div>
    </div>
  )
}

/** One conflict, with a block or warning icon and, for per-title ones, up to five titles. */
function ConflictLine({ level, message, titles }: { level: 'block' | 'warn' | 'confirm'; message: string; titles?: { id: string; title: string }[] }) {
  const P = { fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const }
  return (
    <div className={`pol-msg ${level === 'block' ? 'block' : 'warn'}`} data-policy-conflict={level}>
      {level === 'block'
        ? <svg width="15" height="15" viewBox="0 0 24 24" role="img" aria-label="Blocks saving" {...P}><circle cx="12" cy="12" r="9" /><path d="M15 9l-6 6M9 9l6 6" /></svg>
        : <svg width="15" height="15" viewBox="0 0 24 24" role="img" aria-label="Warning" {...P}><path d="M12 3l9.5 17h-19z" /><path d="M12 10v4M12 17.5v.01" /></svg>}
      <span>{message}
        {titles?.length ? <span className="pol-titles">{titles.map(t => t.title).join(', ')}</span> : null}</span>
    </div>)
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
  // What an asset copy takes (H3-8): the original, its sidecars, or both;
  // (H3-9) the file of a clip cut from a recording, which has no original.
  // Unsaid means the original alone, so that is what the boxes show then;
  // at least one stays ticked.
  const setWhat = (targetId: string, w: CopyWhat, yes: boolean) => {
    const cur = copies.find(c => c.targetId === targetId)
    if (!cur) return
    const set = new Set<CopyWhat>(cur.what?.length ? cur.what : ['source'])
    if (yes) set.add(w); else set.delete(w)
    if (!set.size) return
    const what = (['source', 'sidecars', 'clips', 'packages'] as const).filter(x => set.has(x))
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
              <label style={{ display: 'flex', gap: 6, alignItems: 'center' }} title="For clips cut from a recording: the clip's file as made, with a metadata file beside it"><input type="checkbox" checked={!!cur.what?.includes('clips')} onChange={e => setWhat(t.id, 'clips', e.target.checked)} />Clips</label>
              {/* H3-11: the size a package means, measured, beside the box (services/archive/packages.ts). H3-12: offered on stores too, as a key prefix. */}
              <label style={{ display: 'flex', gap: 6, alignItems: 'center' }} title={t.kind === 's3' ? 'The HLS and DASH package under one folder in the store (<name>-package/): playlists, manifest and every segment' : 'The HLS and DASH package as a folder that plays as it is: playlists, manifest and every segment'}><input type="checkbox" checked={!!cur.what?.includes('packages')} onChange={e => setWhat(t.id, 'packages', e.target.checked)} />HLS/DASH package</label>
              {cur.what?.includes('packages') && <span style={{ color: 'var(--faint)' }} data-archive-package-size>usually about 1.7 times the original (0.1 to 6 times), a few hundred files{t.kind === 's3' ? ', each its own object in the store' : ''}</span>}
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
        The original file is copied once per target. Sidecars are a metadata file, the caption files, other files that came with the asset, and its poster. Clips are clips cut from a recording: the clip's file as made, named Title-Channel-date-time, with a metadata file beside it. The HLS/DASH package is every rendition and segment as a folder that plays as it is: on our test library about 1.7 times the size of the original (from 0.1 to 6 times), a few hundred files per asset, so tick it only where the room is there. Nightly copies anything the target does not hold yet.{recordings ? ' Recordings are copied as each programme ends (each hour without a guide), one file each with a metadata file beside it.' : ''} Outside the window a copy waits for it to open. A rung with no target ticked switches copies off beneath it.
      </div>
    </div>
  )
}
