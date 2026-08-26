import { useEffect, useMemo, useState } from 'react'
import { api, type AppReg, type AppType, type ApiKeyRow, type MintedKey, type AccountKeyRow } from '../api'
import { PageHead, NewButton, FChip, EntityCell, StatusTag, SEC } from '../scaffold'

/* ============================================================================
   API Keys & Apps — the admin surface for frontend application access.
   - Register an APP (web / mobile / TV / server): it gets a PUBLISHABLE key
     (pk_…) the player embeds; per-app restrictions (origin allow-list, IP
     allow-list) bound where the key works.
   - Account SECRET keys (sk_…, management scope) are server-to-server admin
     credentials.
   Raw key values are shown ONCE at mint time; only the prefix is stored.
   ========================================================================== */

const TYPE_LABEL: Record<AppType, string> = { web: 'Web', ios: 'iOS', android: 'Android', tv: 'Smart TV', roku: 'Roku', server: 'Server' }
const fmtDate = (iso?: string | null) => (iso ? new Date(iso).toLocaleDateString([], { day: '2-digit', month: 'short', year: 'numeric' }) : '—')
const fmtWhen = (iso?: string | null) => (iso ? new Date(iso).toLocaleString([], { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : 'never')

export default function ApiKeys() {
  const [apps, setApps] = useState<AppReg[] | null>(null)
  const [keys, setKeys] = useState<AccountKeyRow[]>([])
  const [err, setErr] = useState('')
  const [filter, setFilter] = useState<'all' | 'client' | 'server'>('all')
  const [createOpen, setCreateOpen] = useState(false)
  const [editing, setEditing] = useState<AppReg | null>(null)
  const [minted, setMinted] = useState<{ title: string; k: MintedKey } | null>(null)
  const [busySecret, setBusySecret] = useState(false)

  async function load() {
    try {
      const [a, k] = await Promise.all([api.apps(), api.allKeys()])
      setApps(a); setKeys(k)
    } catch (e: any) { setErr(e.message) }
  }
  useEffect(() => { load() }, [])

  const counts = useMemo(() => {
    const c = apps || []
    return { all: c.length, client: c.filter(a => a.type !== 'server').length, server: c.filter(a => a.type === 'server').length }
  }, [apps])
  const shown = useMemo(() => {
    if (!apps) return []
    if (filter === 'all') return apps
    return apps.filter(a => (filter === 'server' ? a.type === 'server' : a.type !== 'server'))
  }, [apps, filter])

  const keysForApp = (appId: string) => keys.filter(k => k.app_id === appId)
  const secretKeys = keys.filter(k => k.kind === 'secret' && !k.app_id)

  async function mintSecret() {
    setBusySecret(true); setErr('')
    try {
      const k = await api.createSecretKey()
      setMinted({ title: 'Account secret key created', k })
      await load()
    } catch (e: any) { setErr(e.message) } finally { setBusySecret(false) }
  }
  async function revoke(id: string) {
    if (!window.confirm('Revoke this key? Applications using it stop working immediately.')) return
    setErr('')
    try { await api.revokeApiKey(id); await load() } catch (e: any) { setErr(e.message) }
  }

  return (
    <>
      <PageHead title="API Keys & Apps" sub="Register frontend applications, view client keys, and manage the account's server-to-server secret keys."
        action={<NewButton label="Register app" onClick={() => setCreateOpen(true)} />} />
      {err && <div className="err">{err}</div>}
      {apps === null ? (
        <div className="loading">Loading apps…</div>
      ) : (
        <>
          {apps.length === 0 ? (
            <div className="empty">
              <div className="ic"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 2l-2 2m-7.6 7.6a5.5 5.5 0 11-7.8 7.8 5.5 5.5 0 017.8-7.8zm0 0L15 8m-2 2 4-4m0 0 3 3 3-3-3-3" /></svg></div>
              <h3>No apps registered yet</h3>
              <p>Register each frontend application (web player, mobile app, smart TV app). It gets a publishable key to embed, and its restrictions bound where that key works.</p>
              <button className="btn primary" onClick={() => setCreateOpen(true)} style={{ margin: '0 auto' }}>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4"><path d="M12 5v14M5 12h14" /></svg>
                Register your first app
              </button>
            </div>
          ) : (
            <>
              <div className="filters">
                <FChip label="All" n={counts.all} on={filter === 'all'} onClick={() => setFilter('all')} />
                <FChip label="Client apps" n={counts.client} on={filter === 'client'} onClick={() => setFilter('client')} />
                <FChip label="Server" n={counts.server} on={filter === 'server'} onClick={() => setFilter('server')} />
              </div>
              <div className="card">
                <table>
                  <thead><tr><th>App</th><th>Type</th><th>Keys</th><th>Requests</th><th>Status</th><th>Created</th><th></th></tr></thead>
                  <tbody>
                    {shown.map((a, i) => {
                      const ak = keysForApp(a.id)
                      const reqs = ak.reduce((s, k) => s + Number(k.request_count || 0), 0)
                      return (
                        <tr key={a.id} onClick={() => setEditing(a)} style={{ cursor: 'pointer' }}>
                          <td><EntityCell name={a.name} sub={restrictionSummary(a)} index={i} /></td>
                          <td><span className="tag type chan">{TYPE_LABEL[a.type] || a.type}</span></td>
                          <td style={{ color: 'var(--muted)', fontFamily: 'ui-monospace,monospace', fontSize: 'var(--fs-sm)' }}>
                            {ak.length ? ak.map(k => k.key_prefix + '…').join(', ') : '—'}
                          </td>
                          <td style={{ color: 'var(--muted)' }}>{reqs.toLocaleString()}</td>
                          <td>{a.enabled ? <StatusTag label="Enabled" cls="live" /> : <StatusTag label="Disabled" cls="idle" />}</td>
                          <td style={{ color: 'var(--muted)' }}>{fmtDate(a.created_at)}</td>
                          <td style={{ textAlign: 'right' }} onClick={e => e.stopPropagation()}>
                            <button className="btn primary" onClick={() => setEditing(a)}>Open</button>
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            </>
          )}

          {/* Account secret keys: server-to-server management credentials */}
          <div className="card" style={{ marginTop: 18, padding: 18 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <div>
                <div style={{ fontWeight: 700 }}>Account secret keys</div>
                <div style={{ fontSize: 'var(--fs-sm)', color: 'var(--faint)', marginTop: 3 }}>
                  Server-to-server credentials (sk_…, management scope) with the same access as an admin session. Keep them out of frontend code.
                </div>
              </div>
              <div style={{ marginLeft: 'auto' }}>
                <button className="btn ghost" disabled={busySecret} onClick={mintSecret}>{busySecret ? 'Creating…' : 'Generate secret key'}</button>
              </div>
            </div>
            {secretKeys.length > 0 && (
              <table style={{ marginTop: 12 }}>
                <thead><tr><th>Key</th><th>Scope</th><th>Last used</th><th>Requests</th><th></th></tr></thead>
                <tbody>
                  {secretKeys.map(k => (
                    <tr key={k.id}>
                      <td style={{ fontFamily: 'ui-monospace,monospace' }}>{k.key_prefix}…</td>
                      <td style={{ color: 'var(--muted)' }}>{(k.scopes || []).join(', ')}</td>
                      <td style={{ color: 'var(--muted)' }}>{fmtWhen(k.last_used_at)}</td>
                      <td style={{ color: 'var(--muted)' }}>{Number(k.request_count || 0).toLocaleString()}</td>
                      <td style={{ textAlign: 'right' }}>
                        <button className="btn ghost" style={{ color: 'var(--down,#f87171)' }} onClick={() => revoke(k.id)}>Revoke</button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </>
      )}

      {createOpen && <AppDrawer onClose={() => setCreateOpen(false)}
        onDone={(mk) => { setCreateOpen(false); if (mk) setMinted({ title: 'App registered: publishable key', k: mk }); load() }} />}
      {editing && <AppDrawer app={editing} onClose={() => setEditing(null)}
        onDone={(mk) => { setEditing(null); if (mk) setMinted({ title: 'New publishable key', k: mk }); load() }} />}
      {minted && <KeyOnceModal title={minted.title} k={minted.k} onClose={() => setMinted(null)} />}
    </>
  )
}

function restrictionSummary(a: AppReg): string {
  const r = a.restrictions || {}
  if (a.type === 'web') {
    const o: string[] = r.referrers || r.origins || []
    return o.length ? o.join(', ') : 'any origin'
  }
  if (a.type === 'server') {
    const ips: string[] = r.ipAllowlist || []
    return ips.length ? `IPs: ${ips.join(', ')}` : 'any IP'
  }
  return 'device attestation'
}

/* ------------------------------------------------ key shown once modal */
function KeyOnceModal({ title, k, onClose }: { title: string; k: MintedKey; onClose: () => void }) {
  const [copied, setCopied] = useState(false)
  return (
    <div className="drawer-scrim" onClick={onClose} style={{ display: 'grid', placeItems: 'center' }}>
      <div className="card" onClick={e => e.stopPropagation()} style={{ width: 520, padding: 22 }}>
        <div style={{ fontWeight: 700, fontSize: 'var(--fs-h2)' }}>{title}</div>
        <div style={{ fontSize: 'var(--fs-sm)', color: 'var(--warn,#fbbf24)', margin: '8px 0 12px' }}>
          Copy it now: for security only a fingerprint is stored, so this full key is shown once and cannot be retrieved again.
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <input className="inp" readOnly value={k.key} style={{ fontFamily: 'ui-monospace,monospace', fontSize: 'var(--fs-sm)' }}
            onFocus={e => e.currentTarget.select()} />
          <button className="btn primary" onClick={async () => { try { await navigator.clipboard.writeText(k.key) } catch {} setCopied(true); setTimeout(() => setCopied(false), 1500) }}>
            {copied ? 'Copied ✓' : 'Copy'}
          </button>
        </div>
        <div style={{ fontSize: 'var(--fs-sm)', color: 'var(--faint)', marginTop: 10 }}>
          Kind: {k.kind} · scopes: {(k.scopes || []).join(', ')} · prefix on record: <span style={{ fontFamily: 'ui-monospace,monospace' }}>{k.key_prefix}…</span>
        </div>
        <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 16 }}>
          <button className="btn ghost" onClick={onClose}>Done, I saved it</button>
        </div>
      </div>
    </div>
  )
}

/* ------------------------------------------------ app create / settings drawer */
function AppDrawer({ app, onClose, onDone }: { app?: AppReg; onClose: () => void; onDone: (minted?: MintedKey) => void }) {
  const isEdit = !!app
  const [name, setName] = useState(app?.name ?? '')
  const [type, setType] = useState<AppType>(app?.type ?? 'web')
  const [enabled, setEnabled] = useState(app?.enabled ?? true)
  const r = app?.restrictions || {}
  const [origins, setOrigins] = useState<string>(((r.referrers || r.origins || []) as string[]).join('\n'))
  const [ips, setIps] = useState<string>(((r.ipAllowlist || []) as string[]).join('\n'))
  const [keys, setKeys] = useState<ApiKeyRow[] | null>(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')

  useEffect(() => {
    if (app) api.app(app.id).then(d => setKeys(d.keys)).catch(() => setKeys([]))
  }, [app])

  function buildRestrictions(): Record<string, any> {
    if (type === 'web') {
      const list = origins.split(/\n+/).map(s => s.trim()).filter(Boolean)
      return list.length ? { referrers: list } : {}
    }
    if (type === 'server') {
      const list = ips.split(/\n+/).map(s => s.trim()).filter(Boolean)
      return list.length ? { ipAllowlist: list } : {}
    }
    return {}
  }

  async function submit() {
    setErr('')
    if (!name.trim()) { setErr('Give the app a name'); return }
    setBusy(true)
    try {
      if (isEdit) {
        await api.updateApp(app!.id, { name: name.trim(), restrictions: buildRestrictions(), enabled })
        onDone()
      } else {
        const created = await api.createApp({ name: name.trim(), type, restrictions: buildRestrictions() })
        onDone(created.publishableKey)
      }
    } catch (e: any) { setErr(e.message) } finally { setBusy(false) }
  }

  async function rotate() {
    if (!app) return
    setBusy(true); setErr('')
    try { const mk = await api.rotateAppKey(app.id); onDone(mk) }
    catch (e: any) { setErr(e.message); setBusy(false) }
  }
  async function revoke(id: string) {
    if (!window.confirm('Revoke this key? Players using it stop working immediately.')) return
    setErr('')
    try { await api.revokeApiKey(id); setKeys(k => (k || []).filter(x => x.id !== id)) }
    catch (e: any) { setErr(e.message) }
  }

  return (
    <div className="drawer-scrim" onClick={onClose}>
      <div className="drawer" onClick={e => e.stopPropagation()}>
        <div className="drawer-h"><div className="t">{isEdit ? 'App settings' : 'Register app'}</div><button className="xbtn" onClick={onClose}>✕</button></div>
        <div className="drawer-b">
          <div className="field"><label>App name</label>
            <input className="inp" value={name} onChange={e => setName(e.target.value)} placeholder="e.g. Web player, iOS app" />
          </div>
          <div className="field"><label>Platform</label>
            <select className="inp" value={type} disabled={isEdit} onChange={e => setType(e.target.value as AppType)}>
              <option value="web">Web</option>
              <option value="ios">iOS</option>
              <option value="android">Android</option>
              <option value="tv">Smart TV</option>
              <option value="roku">Roku</option>
              <option value="server">Server</option>
            </select>
            {isEdit && <div className="hintxt">The platform is fixed once registered; register a new app to change it.</div>}
          </div>

          <div style={SEC}>Restrictions</div>
          {type === 'web' ? (
            <div className="field"><label>Allowed origins <span style={{ color: 'var(--faint)' }}>— one per line, blank = any</span></label>
              <textarea className="inp" rows={3} value={origins} onChange={e => setOrigins(e.target.value)}
                placeholder={'https://watch.example.com\n*.example.com'} style={{ resize: 'vertical', fontFamily: 'ui-monospace,monospace', fontSize: 'var(--fs-sm)' }} />
              <div className="hintxt">The publishable key only answers requests whose Origin/Referer matches. Wildcards like *.example.com are supported.</div>
            </div>
          ) : type === 'server' ? (
            <div className="field"><label>IP allow-list <span style={{ color: 'var(--faint)' }}>— one per line, blank = any</span></label>
              <textarea className="inp" rows={3} value={ips} onChange={e => setIps(e.target.value)}
                placeholder={'203.0.113.10\n203.0.113.11'} style={{ resize: 'vertical', fontFamily: 'ui-monospace,monospace', fontSize: 'var(--fs-sm)' }} />
            </div>
          ) : (
            <div className="hintxt" style={{ marginBottom: 8 }}>Mobile and TV apps are bound by device attestation (App Attest / Play Integrity) handled by the client SDK; no manual restriction needed here.</div>
          )}

          {isEdit && (
            <>
              <div className="toggle-row">
                <div><div className="tt">App enabled</div><div className="td">Disabling blocks all of this app's keys without deleting them.</div></div>
                <div className={`sw ${enabled ? '' : 'off'}`} onClick={() => setEnabled(v => !v)}><i /></div>
              </div>

              <div style={SEC}>Keys</div>
              {keys === null ? <div className="loading">Loading keys…</div> : keys.length === 0 ? (
                <div className="hintxt">No keys. Issue one below.</div>
              ) : (
                <table>
                  <thead><tr><th>Key</th><th>Kind</th><th>Last used</th><th>Requests</th><th></th></tr></thead>
                  <tbody>
                    {keys.map(k => (
                      <tr key={k.id}>
                        <td style={{ fontFamily: 'ui-monospace,monospace' }}>{k.key_prefix}…</td>
                        <td style={{ color: 'var(--muted)' }}>{k.kind}</td>
                        <td style={{ color: 'var(--muted)' }}>{fmtWhen(k.last_used_at)}</td>
                        <td style={{ color: 'var(--muted)' }}>{Number(k.request_count || 0).toLocaleString()}</td>
                        <td style={{ textAlign: 'right' }}>
                          <button className="btn ghost" style={{ color: 'var(--down,#f87171)' }} onClick={() => revoke(k.id)}>Revoke</button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
              <button className="btn ghost" style={{ marginTop: 10 }} disabled={busy} onClick={rotate}>Issue new publishable key</button>
              <div className="hintxt">Rotation: issue the new key, roll it out, then revoke the old one. Old keys keep working until revoked.</div>
            </>
          )}

          {err && <div className="err">{err}</div>}
        </div>
        <div className="drawer-f">
          <button className="btn ghost" onClick={onClose}>Cancel</button>
          <button className="btn primary" disabled={busy} onClick={submit}>{busy ? 'Saving…' : isEdit ? 'Save changes' : 'Register app'}</button>
        </div>
      </div>
    </div>
  )
}
