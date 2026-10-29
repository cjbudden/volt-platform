// ============================================================================
//  PUBLISHING RULES — the ladder in one place.
//
//    account default  <  content type  <  channel / event / station  <  item
//
//  This page edits the bottom rung (the account default) and lists every rung
//  above it that has been set, with a way to open each. The type rung is also
//  editable from Content Types, the owner rung from each channel, station or
//  event's Settings, and the item rung from the Media Library: same editor,
//  same rules, four doors.
// ============================================================================
import { useEffect, useState } from 'react'
import { api, type PublishingRule, type PublishingPoints, type ContentType } from '../api'
import { PageHead } from '../scaffold'
import { RuleEditor } from '../RuleEditor'
import { navigate } from '../router'
import { usePageNotice } from '../notices'

export default function PublishingPage() {
  const [rules, setRules] = useState<PublishingRule[] | null>(null)
  const [points, setPoints] = useState<PublishingPoints | null>(null)
  const [err, setErr] = useState('')
  const [open, setOpen] = useState<{ kind: 'schema' | 'owner'; id: string; name: string } | null>(null)
  // The content types, to set a type's rule from this page as well as from
  // Content Types (build queue 1.14-G3a-4: the page said "or here" and had
  // no way to do it here).
  const [types, setTypes] = useState<ContentType[]>([])
  const [pick, setPick] = useState('')
  async function load() {
    try { const [r, p] = await Promise.all([api.publishingRules(), api.publishingPoints()]); setRules(r); setPoints(p); setErr('') }
    catch (e: any) { setErr(e.message) }
  }
  useEffect(() => { load(); api.contentTypes().then(setTypes).catch(() => setTypes([])) }, [])
  usePageNotice('load', err ? { kind: 'error', title: "Couldn't load publishing rules.", message: err, actions: [{ label: 'Retry', onClick: () => { load() } }] } : null)
  const typeRules = (rules ?? []).filter(r => r.scope_kind === 'schema')
  const ownerRules = (rules ?? []).filter(r => r.scope_kind === 'owner')
  const withoutRule = types.filter(t => !typeRules.some(r => r.scope_id === t.id))
  return (
    <>
      <PageHead title="Publishing Rules" sub="Where on-demand content goes when it is published, and how it stays available: geo, access, paywall, expiry. The account default applies to everything; a content type, a channel, an event or a station can override any part of it, and so can a single item." />

      <div className="card" style={{ padding: 18, marginBottom: 16 }}>
        <div className="sec-label">Publishing points</div>
        <div style={{ fontSize: 'var(--fs-sm)', color: 'var(--muted)', marginBottom: 8 }}>
          Content can only be published to the apps registered to this account and the social accounts configured for it.
        </div>
        {points && (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
            <span className="chip active" style={{ padding: '3px 10px', fontSize: 'var(--fs-xs)' }}>Catalogue</span>
            {points.apps.map(a => <span key={a.appId} className="chip" style={{ padding: '3px 10px', fontSize: 'var(--fs-xs)', opacity: a.enabled ? 1 : .6 }}>App: {a.name} ({a.type})</span>)}
            {points.social.map(s => <span key={s.targetId} className="chip" style={{ padding: '3px 10px', fontSize: 'var(--fs-xs)', opacity: s.enabled ? 1 : .6 }}>{s.platform}: {s.name}</span>)}
            {/* Apps are registered in API Keys & Apps; social accounts are
                added in Social accounts. One button sent both to API Keys. */}
            <button className="btn ghost" style={{ fontSize: 'var(--fs-xs)' }} onClick={() => navigate('/apikeys')}>Register an app</button>
            <button className="btn ghost" style={{ fontSize: 'var(--fs-xs)' }} onClick={() => navigate('/social')}>Add a social account</button>
          </div>
        )}
      </div>

      <div className="card" style={{ padding: 18, marginBottom: 16 }}>
        <RuleEditor scopeKind="account" scopeId={null} title="Account default" resolveQuery={{}} onSaved={load} />
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
        <div className="card" style={{ padding: 18 }}>
          <div className="sec-label">By content type</div>
          {typeRules.length === 0 ? <div style={{ color: 'var(--faint)', fontSize: 'var(--fs-sm)' }}>No type overrides. Set one below, or from Content Types.</div>
            : typeRules.map(r => <RuleRow key={r.id} r={r} onOpen={() => setOpen({ kind: 'schema', id: r.scope_id!, name: r.scope_name ?? 'type' })} />)}
          {withoutRule.length > 0 && (
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginTop: 8 }}>
              <select className="inp sel-sm" aria-label="Content type to set a rule for" value={pick} onChange={e => setPick(e.target.value)}>
                <option value="">Choose a content type…</option>
                {withoutRule.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
              </select>
              <button className="btn ghost" disabled={!pick} onClick={() => {
                const t = withoutRule.find(x => x.id === pick)
                if (t) { setOpen({ kind: 'schema', id: t.id, name: t.name }); setPick('') }
              }}>Set a rule for this type</button>
            </div>
          )}
          <button className="btn ghost" style={{ marginTop: 8 }} onClick={() => navigate('/content-types')}>Open Content Types</button>
        </div>
        <div className="card" style={{ padding: 18 }}>
          <div className="sec-label">By channel, event or station</div>
          {ownerRules.length === 0 ? <div style={{ color: 'var(--faint)', fontSize: 'var(--fs-sm)' }}>No overrides. Set one from a channel, station or event's Settings.</div>
            : ownerRules.map(r => <RuleRow key={r.id} r={r} onOpen={() => setOpen({ kind: 'owner', id: r.scope_id!, name: r.scope_name ?? 'owner' })} />)}
        </div>
      </div>

      {open && (
        <div className="card" style={{ padding: 18, marginTop: 16 }}>
          <div style={{ display: 'flex', alignItems: 'center' }}>
            <div className="sec-label" style={{ margin: 0 }}>Rule for {open.name}</div>
            <div style={{ flex: 1 }} />
            <button className="btn ghost" onClick={() => setOpen(null)}>Close</button>
          </div>
          <RuleEditor key={open.id} scopeKind={open.kind} scopeId={open.id}
            resolveQuery={open.kind === 'schema' ? { schemaId: open.id } : { channelId: open.id, eventId: open.id }} onSaved={load} />
        </div>
      )}
    </>
  )
}

function RuleRow({ r, onOpen }: { r: PublishingRule; onOpen: () => void }) {
  const keys = Object.keys(r.settings ?? {})
  return (
    <div onClick={onOpen} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 10px', borderRadius: 8, border: '1px solid var(--border)', marginBottom: 6, cursor: 'pointer' }}>
      <b style={{ fontSize: 'var(--fs-body)' }}>{r.scope_name}</b>
      <span style={{ fontSize: 'var(--fs-micro)', color: 'var(--faint)' }}>sets {keys.length ? keys.join(', ') : 'nothing'}</span>
      <span style={{ marginLeft: 'auto', fontSize: 'var(--fs-micro)', color: 'var(--faint)' }}>v{r.version}</span>
    </div>
  )
}
