import { useEffect, useMemo, useRef, useState } from 'react'
import { apiRequest as req } from '../api'
import { Notice } from '../notices'
import { GraphicStage } from '../graphics/GraphicStage'
import { StatusPill } from '../graphics/Graphics'
import { previewValues, KIND_LABEL, type Kind, type Template, type Version } from '../graphics/gfxApi'

/* ============================================================================
   System Admin > Graphics library. Volt's own graphics templates, the SETS they
   belong to (News, General, Sport scores, or any made here), and which client
   accounts each set is switched on for. No code deploy: upload a package, publish
   it, and every account with the set on can use it. Clients only ever see their own
   setups; turning a set off hides its templates from new use but never breaks a
   setup already made. Server: volt-app/src/modules/platformGraphics.ts.
   ========================================================================== */

export interface GfxSet {
  id: string; key: string; name: string; description: string | null; defaultEnabled: boolean; shipped: boolean; sort: number
  archived: boolean; templates: number; retired: number; accountsOn: number; accountsTotal: number; overridesOn: number; overridesOff: number
}
interface VoltTemplate extends Omit<Template, 'owner' | 'source'> {
  source: string; shipped: boolean; set: { id: string; key: string; name: string } | null; retired: boolean
  accountsUsing: number; setups: number
}
export interface AccountSet {
  id: string; key: string; name: string; description: string | null; defaultEnabled: boolean; archived: boolean
  override: boolean | null; enabled: boolean; templates: number; setupsInUse: number
}

const J = (b: unknown) => ({ body: JSON.stringify(b), headers: { 'content-type': 'application/json' } })
const qs = (o: Record<string, string | undefined>) => {
  const p = Object.entries(o).filter(([, v]) => v) as [string, string][]
  return p.length ? '?' + new URLSearchParams(p).toString() : ''
}
const pg = {
  sets: (): Promise<{ items: GfxSet[] }> => req('/platform/graphics/sets'),
  createSet: (b: { key: string; name: string; description?: string; defaultEnabled?: boolean }): Promise<GfxSet> => req('/platform/graphics/sets', { method: 'POST', ...J(b) }),
  patchSet: (id: string, b: Partial<{ name: string; description: string | null; defaultEnabled: boolean; archived: boolean; clearOverrides: boolean; sort: number }>): Promise<GfxSet> =>
    req(`/platform/graphics/sets/${id}`, { method: 'PATCH', ...J(b) }),
  templates: (retired: boolean): Promise<{ items: VoltTemplate[] }> => req('/platform/graphics/templates' + qs({ retired: retired ? '1' : undefined })),
  upload: (file: File, o: { setId?: string; kind?: string }): Promise<VoltTemplate> =>
    req('/platform/graphics/templates/import' + qs({ ...o, filename: file.name }), { method: 'POST', body: file, headers: { 'content-type': 'application/octet-stream' } }),
  patchTemplate: (id: string, b: Partial<{ name: string; kind: Kind; setId: string | null; retired: boolean }>): Promise<VoltTemplate> =>
    req(`/platform/graphics/templates/${id}`, { method: 'PATCH', ...J(b) }),
  putDraft: (id: string, file: File): Promise<Version> =>
    req(`/platform/graphics/templates/${id}/draft` + qs({ filename: file.name }), { method: 'PUT', body: file, headers: { 'content-type': 'application/octet-stream' } }),
  publish: (id: string): Promise<Version> => req(`/platform/graphics/templates/${id}/draft/publish`, { method: 'POST', ...J({}) }),
  discard: (id: string) => req(`/platform/graphics/templates/${id}/draft`, { method: 'DELETE' }),
  accountSets: (accountId: string): Promise<{ items: AccountSet[] }> => req(`/platform/graphics/accounts/${accountId}/sets`),
  setAccountSet: (accountId: string, setId: string, enabled: boolean | null): Promise<{ items: AccountSet[] }> =>
    req(`/platform/graphics/accounts/${accountId}/sets/${setId}`, { method: 'PUT', ...J({ enabled }) }),
}

const KINDS: Kind[] = ['scorebug', 'lower_third', 'ticker', 'bug', 'full_frame', 'other']

export function GraphicsLibraryAdmin() {
  const [sets, setSets] = useState<GfxSet[] | null>(null)
  const [templates, setTemplates] = useState<VoltTemplate[] | null>(null)
  const [filter, setFilter] = useState<string>('all')
  const [err, setErr] = useState('')
  const [info, setInfo] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [newSet, setNewSet] = useState<{ key: string; name: string; description: string; defaultEnabled: boolean } | null>(null)
  const [editSet, setEditSet] = useState<{ id: string; name: string; description: string } | null>(null)
  const [adding, setAdding] = useState<{ setId: string; kind: Kind }>({ setId: '', kind: 'other' })
  const fileFor = useRef<{ mode: 'new' } | { mode: 'version'; id: string } | null>(null)
  const fileInput = useRef<HTMLInputElement>(null)

  const load = async () => {
    try {
      const [s, t] = await Promise.all([pg.sets(), pg.templates(true)])
      setSets(s.items); setTemplates(t.items); setErr('')
    } catch (e: any) { setErr(e.message) }
  }
  useEffect(() => { load() }, [])

  const run = async (key: string, fn: () => Promise<unknown>, done?: string) => {
    setBusy(key); setErr(''); setInfo('')
    try { await fn(); if (done) setInfo(done); await load() } catch (e: any) { setErr(e.message) } finally { setBusy(null) }
  }

  const shown = useMemo(() => (templates ?? []).filter((t) =>
    filter === 'retired' ? t.retired : !t.retired && (filter === 'all' || (filter === 'none' ? !t.set : t.set?.id === filter))), [templates, filter])

  function pick(target: { mode: 'new' } | { mode: 'version'; id: string }) {
    fileFor.current = target
    if (fileInput.current) { fileInput.current.value = ''; fileInput.current.click() }
  }
  async function onFile(f: File | undefined) {
    const target = fileFor.current
    if (!f || !target) return
    if (target.mode === 'new') {
      await run('upload', () => pg.upload(f, { setId: adding.setId || undefined, kind: adding.kind }),
        `${f.name} added as a draft. Check it, then publish it to make it available.`)
    } else {
      await run(target.id, () => pg.putDraft(target.id, f), 'New draft uploaded. Publishing makes it the latest version; setups stay on their version until each account moves them.')
    }
  }

  if (!sets || !templates) return err ? <Notice kind="error" message={err} /> : <div className="loading">Loading the graphics library…</div>
  const liveSets = sets.filter((s) => !s.archived)

  return (
    <>
      {err && <div style={{ marginBottom: 12 }}><Notice kind="error" message={err} /></div>}
      {info && <div style={{ marginBottom: 12 }}><Notice kind="ok" variant="compact" message={info} /></div>}
      <input ref={fileInput} type="file" accept=".zip,.html,.htm,application/zip,text/html" hidden onChange={(e) => onFile(e.target.files?.[0])} />

      <div className="sec-label" style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <span style={{ flex: 1 }}>Sets</span>
        <button className="btn ghost sm" onClick={() => setNewSet({ key: '', name: '', description: '', defaultEnabled: false })}>New set</button>
      </div>
      <p className="hintxt" style={{ marginTop: 0 }}>A set is on or off for each client account. "On for all accounts" covers every account
        without a choice of its own, including accounts made later; switch one account on or off from its page under Client accounts.</p>
      <div className="card" style={{ marginBottom: 22 }}>
        <table>
          <thead><tr><th>Set</th><th>Templates</th><th>On for all accounts</th><th>Accounts with it on</th><th></th></tr></thead>
          <tbody>
            {newSet && (
              <tr>
                <td colSpan={5}>
                  <div style={{ display: 'grid', gridTemplateColumns: '160px 1fr 2fr auto auto', gap: 8, alignItems: 'center' }}>
                    <input className="inp" placeholder="key, e.g. esports" value={newSet.key} onChange={(e) => setNewSet({ ...newSet, key: e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '') })} aria-label="Set key" />
                    <input className="inp" placeholder="Name" value={newSet.name} onChange={(e) => setNewSet({ ...newSet, name: e.target.value })} aria-label="Set name" />
                    <input className="inp" placeholder="What is in it (shown to staff)" value={newSet.description} onChange={(e) => setNewSet({ ...newSet, description: e.target.value })} aria-label="Description" />
                    <label className="gfx-meta" style={{ display: 'flex', gap: 6, alignItems: 'center', whiteSpace: 'nowrap' }}>
                      <input type="checkbox" checked={newSet.defaultEnabled} onChange={(e) => setNewSet({ ...newSet, defaultEnabled: e.target.checked })} />On for all accounts</label>
                    <div style={{ display: 'flex', gap: 6 }}>
                      <button className="btn primary sm" disabled={busy === 'newset' || newSet.key.length < 2 || !newSet.name.trim()}
                        onClick={() => run('newset', async () => { await pg.createSet({ ...newSet, description: newSet.description || undefined }); setNewSet(null) }, 'Set created.')}>Create</button>
                      <button className="btn ghost sm" onClick={() => setNewSet(null)}>Cancel</button>
                    </div>
                  </div>
                </td>
              </tr>
            )}
            {sets.map((s) => (
              <tr key={s.id} style={s.archived ? { opacity: .55 } : undefined}>
                <td>
                  {editSet?.id === s.id ? (
                    <div style={{ display: 'grid', gap: 6 }}>
                      <input className="inp" value={editSet.name} onChange={(e) => setEditSet({ ...editSet, name: e.target.value })} aria-label="Set name" />
                      <input className="inp" value={editSet.description} onChange={(e) => setEditSet({ ...editSet, description: e.target.value })} aria-label="Description" />
                      <div style={{ display: 'flex', gap: 6 }}>
                        <button className="btn primary sm" onClick={() => run(s.id, async () => { await pg.patchSet(s.id, { name: editSet.name.trim(), description: editSet.description.trim() || null }); setEditSet(null) })}>Save</button>
                        <button className="btn ghost sm" onClick={() => setEditSet(null)}>Cancel</button>
                      </div>
                    </div>
                  ) : (
                    <>
                      <div style={{ fontWeight: 600 }}>{s.name} <span className="gfx-meta">· {s.key}{s.shipped ? ' · ships with Volt' : ''}{s.archived ? ' · archived' : ''}</span></div>
                      {s.description && <div className="gfx-meta">{s.description}</div>}
                    </>
                  )}
                </td>
                <td style={{ color: 'var(--muted)' }}>{s.templates}{s.retired ? ` (+${s.retired} retired)` : ''}</td>
                <td>
                  <div className={`sw ${s.defaultEnabled ? '' : 'off'}`} role="switch" aria-checked={s.defaultEnabled} aria-label={`${s.name} on for all accounts`} tabIndex={0}
                    onClick={() => !s.archived && run(s.id, () => pg.patchSet(s.id, { defaultEnabled: !s.defaultEnabled }))}
                    onKeyDown={(e) => { if ((e.key === ' ' || e.key === 'Enter') && !s.archived) { e.preventDefault(); run(s.id, () => pg.patchSet(s.id, { defaultEnabled: !s.defaultEnabled })) } }}><i /></div>
                </td>
                <td style={{ color: 'var(--muted)', fontSize: 'var(--fs-sm)' }}>
                  {s.archived ? 'None (archived)' : `${s.accountsOn} of ${s.accountsTotal}`}
                  {(s.overridesOn > 0 || s.overridesOff > 0) && <div className="gfx-meta">Set by hand: {s.overridesOn} on, {s.overridesOff} off</div>}
                </td>
                <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                  {(s.overridesOn > 0 || s.overridesOff > 0) && !s.archived && (
                    <button className="btn ghost sm" title="Drop every account's own choice so this set's default applies to all of them"
                      onClick={() => window.confirm(`Make "${s.name}" ${s.defaultEnabled ? 'on' : 'off'} for every account, dropping ${s.overridesOn + s.overridesOff} account choice${s.overridesOn + s.overridesOff === 1 ? '' : 's'}? Setups already made keep working.`)
                        && run(s.id, () => pg.patchSet(s.id, { clearOverrides: true }), 'Every account now follows the default.')}>Apply default to all</button>
                  )}
                  {!editSet && <button className="btn ghost sm" onClick={() => setEditSet({ id: s.id, name: s.name, description: s.description ?? '' })}>Edit</button>}
                  <button className="btn ghost sm" onClick={() => (s.archived || window.confirm(`Archive "${s.name}"? Its templates are hidden from new use in every account; setups already made keep working.`))
                    && run(s.id, () => pg.patchSet(s.id, { archived: !s.archived }))}>{s.archived ? 'Restore' : 'Archive'}</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="sec-label" style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <span style={{ flex: 1 }}>Templates</span>
        <select className="inp" style={{ width: 'auto' }} value={adding.setId} onChange={(e) => setAdding({ ...adding, setId: e.target.value })} aria-label="Set for the new template">
          <option value="">Into set…</option>{liveSets.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>
        <select className="inp" style={{ width: 'auto' }} value={adding.kind} onChange={(e) => setAdding({ ...adding, kind: e.target.value as Kind })} aria-label="Kind">
          {KINDS.map((k) => <option key={k} value={k}>{KIND_LABEL[k]}</option>)}
        </select>
        <button className="btn primary sm" disabled={!adding.setId || busy === 'upload'} onClick={() => pick({ mode: 'new' })}>
          {busy === 'upload' ? 'Uploading…' : 'Upload template (.zip or .html)'}</button>
      </div>
      <div className="chipset" style={{ margin: '4px 0 14px' }}>
        <button className={`selchip ${filter === 'all' ? 'sel' : ''}`} onClick={() => setFilter('all')}>All</button>
        {liveSets.map((s) => <button key={s.id} className={`selchip ${filter === s.id ? 'sel' : ''}`} onClick={() => setFilter(s.id)}>{s.name} <span className="gfx-meta">{s.templates}</span></button>)}
        {templates.some((t) => !t.set && !t.retired) && <button className={`selchip ${filter === 'none' ? 'sel' : ''}`} onClick={() => setFilter('none')}>No set</button>}
        {templates.some((t) => t.retired) && <button className={`selchip ${filter === 'retired' ? 'sel' : ''}`} onClick={() => setFilter('retired')}>Retired</button>}
      </div>

      {shown.length === 0 ? <div className="empty"><h3>Nothing here</h3><p>Upload a template into a set, or pick another filter.</p></div> : (
        <div className="gfx-grid">
          {shown.map((t) => {
            const v = t.latest ?? t.draft
            return (
              <div className="card gfx-card" key={t.id} style={t.retired ? { opacity: .7 } : undefined}>
                <GraphicStage compact autoFocus focus={v?.manifest.bbox} empty="No files yet"
                  badge={t.retired ? { text: 'Retired', tone: 'error' } : !t.latest ? { text: 'Not published', tone: 'dev' } : undefined}
                  layers={v ? [{ key: t.id, url: v.url, values: previewValues(v.manifest), onAir: true, canvas: v.manifest.canvas }] : []} />
                <div className="gfx-card-b">
                  <div className="gfx-card-t">{t.name}</div>
                  <div className="gfx-meta">{KIND_LABEL[t.kind]} · {t.latest ? `v${t.latest.version}` : 'not published'}{t.shipped ? ' · ships with Volt' : ''}</div>
                  <StatusPill t={t as unknown as Template} />
                  <label className="gfx-meta" style={{ display: 'flex', gap: 8, alignItems: 'center' }}>Set
                    <select className="inp" style={{ width: 'auto', flex: 1 }} value={t.set?.id ?? ''} disabled={busy === t.id}
                      onChange={(e) => run(t.id, () => pg.patchTemplate(t.id, { setId: e.target.value || null }))} aria-label={`Set for ${t.name}`}>
                      <option value="">No set (every account)</option>
                      {sets.filter((s) => !s.archived || s.id === t.set?.id).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                    </select></label>
                  <div className="gfx-meta"><span className={`gfx-dot ${t.setups ? 'live' : ''}`} />
                    {t.setups ? `${t.accountsUsing} account${t.accountsUsing === 1 ? '' : 's'} · ${t.setups} setup${t.setups === 1 ? '' : 's'}` : 'No account uses it yet'}</div>
                  {t.draft && (
                    <div className="gfx-meta">Draft waiting{t.draft.publishable ? ', passes its checks' : `: ${t.draft.checks.filter((c) => c.level === 'error').map((c) => c.title).join('; ')}`}</div>
                  )}
                  <div className="gfx-actions" style={{ flexWrap: 'wrap' }}>
                    {t.draft?.publishable && <button className="btn primary sm" disabled={busy === t.id}
                      onClick={() => run(t.id, () => pg.publish(t.id), `${t.name} published. Accounts with its set on see it now; existing setups are offered the update.`)}>Publish draft</button>}
                    {t.draft && <button className="btn ghost sm" disabled={busy === t.id} onClick={() => run(t.id, () => pg.discard(t.id))}>Discard draft</button>}
                    <button className="btn ghost sm" disabled={busy === t.id} onClick={() => pick({ mode: 'version', id: t.id })}>Upload new version</button>
                    <button className="btn ghost sm" disabled={busy === t.id}
                      onClick={() => (t.retired || window.confirm(`Retire "${t.name}"? No account can start a new setup from it. ${t.setups ? `The ${t.setups} setup${t.setups === 1 ? '' : 's'} already using it keep working.` : ''}`))
                        && run(t.id, () => pg.patchTemplate(t.id, { retired: !t.retired }))}>{t.retired ? 'Restore' : 'Retire'}</button>
                  </div>
                </div>
              </div>
            )
          })}
        </div>
      )}
    </>
  )
}

/* One client account: which graphics sets it has. Each set follows its default unless set here. */
export function AccountGraphicsSets({ accountId }: { accountId: string }) {
  const [items, setItems] = useState<AccountSet[] | null>(null)
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  useEffect(() => { pg.accountSets(accountId).then((r) => setItems(r.items)).catch((e) => setErr(e.message)) }, [accountId])
  async function choose(s: AccountSet, v: string) {
    setBusy(s.id); setErr('')
    try { setItems((await pg.setAccountSet(accountId, s.id, v === 'default' ? null : v === 'on')).items) }
    catch (e: any) { setErr(e.message) } finally { setBusy(null) }
  }
  return (
    <>
      <div className="sec-label">Graphics sets</div>
      <div className="hintxt" style={{ marginBottom: 8 }}>Which of Volt's graphics templates this client can use. Turning a set off hides it from new
        setups; setups the client already made keep working. The client only ever sees its own setups.</div>
      {err && <Notice kind="error" variant="compact" message={err} />}
      {!items ? <div className="loading">Loading…</div> : items.filter((s) => !s.archived).map((s) => (
        <div className="toggle-row" key={s.id}>
          <div>
            <div className="tt">{s.name} <span className="gfx-meta">· {s.templates} template{s.templates === 1 ? '' : 's'}</span></div>
            <div className="td">{s.enabled ? 'On' : 'Off'}{s.override === null ? ` (the default for all accounts)` : ' (set for this account)'}
              {s.setupsInUse > 0 && ` · ${s.setupsInUse} setup${s.setupsInUse === 1 ? '' : 's'} in use`}</div>
          </div>
          <select className="inp" style={{ width: 'auto' }} disabled={busy === s.id} aria-label={`${s.name} for this account`}
            value={s.override === null ? 'default' : s.override ? 'on' : 'off'} onChange={(e) => choose(s, e.target.value)}>
            <option value="default">Default ({s.defaultEnabled ? 'on' : 'off'})</option>
            <option value="on">On</option>
            <option value="off">Off</option>
          </select>
        </div>
      ))}
    </>
  )
}
