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
import { api, type PublishingRule, type PublishingPoints } from '../api'
import { PageHead } from '../scaffold'
import { RuleEditor } from '../RuleEditor'
import { navigate } from '../router'

export default function PublishingPage() {
  const [rules, setRules] = useState<PublishingRule[] | null>(null)
  const [points, setPoints] = useState<PublishingPoints | null>(null)
  const [err, setErr] = useState('')
  const [open, setOpen] = useState<{ kind: 'schema' | 'owner'; id: string; name: string } | null>(null)
  async function load() {
    try { const [r, p] = await Promise.all([api.publishingRules(), api.publishingPoints()]); setRules(r); setPoints(p) }
    catch (e: any) { setErr(e.message) }
  }
  useEffect(() => { load() }, [])
  const typeRules = (rules ?? []).filter(r => r.scope_kind === 'schema')
  const ownerRules = (rules ?? []).filter(r => r.scope_kind === 'owner')
  return (
    <>
      <PageHead title="Publishing Rules" sub="Where on-demand content goes when it is published, and how it stays available: geo, access, paywall, expiry. The account default applies to everything; a content type, a channel, an event or a station can override any part of it, and so can a single item." />
      {err && <div className="err">{err}</div>}

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
            <button className="btn ghost" style={{ fontSize: 'var(--fs-xs)' }} onClick={() => navigate('/apikeys')}>Register an app or add a social account</button>
          </div>
        )}
      </div>

      <div className="card" style={{ padding: 18, marginBottom: 16 }}>
        <RuleEditor scopeKind="account" scopeId={null} title="Account default" resolveQuery={{}} onSaved={load} />
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
        <div className="card" style={{ padding: 18 }}>
          <div className="sec-label">By content type</div>
          {typeRules.length === 0 ? <div style={{ color: 'var(--faint)', fontSize: 'var(--fs-sm)' }}>No type overrides. Set one from Content Types, or here.</div>
            : typeRules.map(r => <RuleRow key={r.id} r={r} onOpen={() => setOpen({ kind: 'schema', id: r.scope_id!, name: r.scope_name ?? 'type' })} />)}
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
