import { useEffect, useMemo, useState } from 'react'
import { api, type AppReg, type AppType, type ApiKeyRow, type MintedKey, type AccountKeyRow } from '../api'
import { PageHead, NewButton, FChip, EntityCell, StatusTag } from '../scaffold'
import { pressable } from '../a11y'
import { FormStatus, useNotify, usePageNotice } from '../notices'

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
      setApps(a); setKeys(k); setErr('')
    } catch (e: any) { setErr(e.message) }
  }
  useEffect(() => { load() }, [])
  const notify = useNotify()
  usePageNotice('load', err ? { kind: 'error', title: "Couldn't load apps and keys.", message: err, actions: [{ label: 'Retry', onClick: () => { load() } }] } : null)

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
    setBusySecret(true)
    try {
      const k = await api.createSecretKey()
      setMinted({ title: 'Account secret key created', k })
      await load()
    } catch (e: any) { notify({ kind: 'error', message: e.message }) } finally { setBusySecret(false) }
  }
  async function revoke(id: string) {
    if (!window.confirm('Revoke this key? Applications using it stop working immediately.')) return
    try { await api.revokeApiKey(id); await load() } catch (e: any) { notify({ kind: 'error', message: e.message }) }
  }

  return (
    <>
      <PageHead title="API Keys & Apps" sub="Register frontend applications, view client keys, and manage the account's server-to-server secret keys."
        action={<NewButton label="Register app" onClick={() => setCreateOpen(true)} />} />
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
              <div className="sec-label">Registered apps</div>
              <div className="filters">
                <FChip label="All" n={counts.all} on={filter === 'all'} onClick={() => setFilter('all')} />
                <FChip label="Client apps" n={counts.client} on={filter === 'client'} onClick={() => setFilter('client')} />
                <FChip label="Server" n={counts.server} on={filter === 'server'} onClick={() => setFilter('server')} />
              </div>
              <div className="card">
                <table>
                  <thead><tr><th>App</th><th>Platform</th><th>Keys</th><th>Requests</th><th>Status</th><th>Created</th><th></th></tr></thead>
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

          {/* ACCOUNT SECRET KEYS.
              Given its own labelled section rather than sitting as an unnamed
              card under the apps table, because it is a different kind of
              thing with a very different blast radius: a publishable key can
              play streams, a secret key can do everything an owner can. The
              two were previously separated only by whitespace. */}
          <div className="sec-label" style={{ marginTop: 26 }}>Server-to-server keys</div>
          <div className="card" style={{ padding: 18 }}>
            <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
              <div style={{ minWidth: 0 }}>
                <div style={{ fontWeight: 700 }}>Account secret keys</div>
                <div style={{ fontSize: 'var(--fs-sm)', color: 'var(--muted)', marginTop: 4 }}>
                  <b>Works:</b> from any backend that presents it. There is no origin or IP binding on these.
                </div>
                <div style={{ fontSize: 'var(--fs-sm)', color: 'var(--muted)', marginTop: 2 }}>
                  <b>Can do:</b> everything an owner session can, including creating channels, reading recordings and deleting media.
                </div>
                <div style={{ fontSize: 'var(--fs-sm)', color: 'var(--warn,#fbbf24)', marginTop: 6 }}>
                  Never ship one in frontend code or commit one to a repository. Use an app's publishable key for anything a browser or device touches.
                </div>
              </div>
              <div style={{ marginLeft: 'auto', flex: 'none' }}>
                <button className="btn ghost" disabled={busySecret} onClick={mintSecret}>{busySecret ? 'Creating…' : 'Create a secret key'}</button>
              </div>
            </div>
            {secretKeys.length === 0 && (
              <div className="hintxt" style={{ marginTop: 10 }}>
                None yet. Nothing outside this console can reach the API on your behalf.
              </div>
            )}
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
    <div className="drawer-scrim" {...pressable((e: any) => { ((onClose) as any)(e) })} data-a11y-click="" style={{ display: 'grid', placeItems: 'center' }}>
      <div className="card" {...pressable((e: any) => { (((e: any) => e.stopPropagation()) as any)(e) })} data-a11y-click="" style={{ width: 520, padding: 22 }}>
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

/* =============================================================== choice rows
   A CHOICE IS A ROW, NOT AN OPTION IN A DROPDOWN.

   Platform used to be a <select>. That is the wrong control for this decision
   and the reason is not aesthetics: the platform determines the entire
   SECURITY MODEL of the key that comes out. A web app gets a key bounded by
   origin; a server app gets one bounded by IP; a mobile or TV app gets one
   bounded by device attestation and no manual restriction at all. A dropdown
   hides all of that behind six words, so the operator picks "Web" without
   knowing they have just chosen origin-based binding.

   Rows carry the consequence next to the label, which is the pattern the
   share-form directions settled on for exactly this reason.
   ========================================================================= */
function ChoiceRow({ on, title, sub, onPick, disabled }: {
  on: boolean; title: string; sub: string; onPick: () => void; disabled?: boolean
}) {
  return (
    <div
      {...(disabled ? {} : pressable(onPick))}
      data-a11y-click=""
      aria-disabled={disabled || undefined}
      style={{
        display: 'flex', gap: 11, alignItems: 'flex-start', width: '100%',
        padding: '10px 12px', marginBottom: 6, borderRadius: 'var(--radius-ctl,10px)',
        border: `1px solid ${on ? 'var(--brand,#3f7bff)' : 'var(--border)'}`,
        background: on ? 'var(--brand-dim,rgba(63,123,255,.14))' : 'transparent',
        cursor: disabled ? 'default' : 'pointer', opacity: disabled && !on ? .45 : 1,
      }}>
      {/* A radio mark, drawn rather than an <input>, so the whole row is the
          hit target and the keyboard handler in pressable() owns activation. */}
      <span style={{
        width: 15, height: 15, borderRadius: 8, marginTop: 2, flex: 'none',
        border: `2px solid ${on ? 'var(--brand,#3f7bff)' : 'var(--border-2,rgba(255,255,255,.2))'}`,
        display: 'grid', placeItems: 'center',
      }}>
        {on && <span style={{ width: 7, height: 7, borderRadius: 4, background: 'var(--brand,#3f7bff)' }} />}
      </span>
      <span style={{ minWidth: 0 }}>
        <span style={{ display: 'block', fontWeight: 600 }}>{title}</span>
        <span style={{ display: 'block', fontSize: 'var(--fs-sm)', color: 'var(--muted)' }}>{sub}</span>
      </span>
    </div>
  )
}

/** A setting already answered, changeable in one click. */
function SettingChip({ on, label, onPick }: { on: boolean; label: string; onPick: () => void }) {
  return (
    <span {...pressable(onPick)} data-a11y-click="" style={{
      display: 'inline-block', padding: '4px 11px', borderRadius: 999, cursor: 'pointer',
      fontSize: 'var(--fs-sm)',
      border: `1px solid ${on ? 'var(--brand,#3f7bff)' : 'var(--border)'}`,
      background: on ? 'var(--brand-dim,rgba(63,123,255,.16))' : 'transparent',
      color: on ? 'var(--text)' : 'var(--muted)',
    }}>{label}</span>
  )
}

/** What each platform means for the key. The sub-lines are the whole point. */
const PLATFORMS: Array<{ v: AppType; title: string; sub: string }> = [
  { v: 'web',     title: 'Web player',   sub: 'Browser embed. The key is bound by the page origin it is called from.' },
  { v: 'ios',     title: 'iOS',          sub: 'Bound by App Attest through the client SDK. Nothing to configure here.' },
  { v: 'android', title: 'Android',      sub: 'Bound by Play Integrity through the client SDK. Nothing to configure here.' },
  { v: 'tv',      title: 'Smart TV',     sub: 'Tizen, webOS and similar. Device attestation through the SDK.' },
  { v: 'roku',    title: 'Roku',         sub: 'Roku channel. Device attestation through the SDK.' },
  { v: 'server',  title: 'Server',       sub: 'Backend integration. The key is bound by a list of source IP addresses.' },
]

/* ------------------------------------------------ app create / settings drawer */
/**
 * Register or configure one app.
 *
 * REBUILT ALONG DIRECTION C of the share-form study, with A's section labels
 * kept so it still reads as the same product:
 *
 *   - every choice is ANSWERED ALREADY with the safe common option, so the
 *     ordinary case is a name and a button;
 *   - the choices that matter are rows and chips carrying their consequence,
 *     not a dropdown and two textareas;
 *   - a PREVIEW shows what will actually be created — the key's shape, where
 *     it will work, and what it can do — before anything is minted. Nothing in
 *     this section used to answer "what am I about to hand out?";
 *   - anything rarer sits behind one disclosure;
 *   - the primary button states the OUTCOME rather than the verb.
 */
function AppDrawer({ app, onClose, onDone }: { app?: AppReg; onClose: () => void; onDone: (minted?: MintedKey) => void }) {
  const isEdit = !!app
  const [name, setName] = useState(app?.name ?? '')
  const [type, setType] = useState<AppType>(app?.type ?? 'web')
  const [enabled, setEnabled] = useState(app?.enabled ?? true)
  const r = app?.restrictions || {}
  const initialOrigins = ((r.referrers || r.origins || []) as string[]).join('\n')
  const initialIps = ((r.ipAllowlist || []) as string[]).join('\n')
  const [origins, setOrigins] = useState<string>(initialOrigins)
  const [ips, setIps] = useState<string>(initialIps)
  // The chip state. "Anywhere" is the DEFAULT for a new app and is the honest
  // default: an operator who has not yet decided which origins their player is
  // served from must not be handed a key that silently refuses every request.
  // It is also flagged in the preview, so the loose choice is never invisible.
  const [bounded, setBounded] = useState<boolean>(
    isEdit ? Boolean(initialOrigins || initialIps) : false
  )
  const [advanced, setAdvanced] = useState(false)
  const [keys, setKeys] = useState<ApiKeyRow[] | null>(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')

  useEffect(() => {
    if (app) api.app(app.id).then(d => setKeys(d.keys)).catch(() => setKeys([]))
  }, [app])

  const attested = type !== 'web' && type !== 'server'
  const list = (s: string) => s.split(/\n+/).map(x => x.trim()).filter(Boolean)

  function buildRestrictions(): Record<string, any> {
    if (!bounded) return {}
    if (type === 'web') { const l = list(origins); return l.length ? { referrers: l } : {} }
    if (type === 'server') { const l = list(ips); return l.length ? { ipAllowlist: l } : {} }
    return {}
  }

  /** Exactly what the preview panel states. Kept as one place so the words
   *  shown and the object submitted cannot drift apart. */
  const willWork = attested
    ? 'On devices that pass attestation through the client SDK.'
    : bounded
      ? (type === 'web'
          ? (list(origins).length
              ? `Only on pages served from ${list(origins).join(', ')}.`
              : 'Restricted, but no origin has been entered yet, so nothing would be allowed.')
          : (list(ips).length
              ? `Only from ${list(ips).join(', ')}.`
              : 'Restricted, but no address has been entered yet, so nothing would be allowed.'))
      : (type === 'web'
          ? 'On any page on the internet that embeds it.'
          : 'From any address on the internet.')

  const loose = !attested && !bounded
  const emptyBound = !attested && bounded && (type === 'web' ? !list(origins).length : !list(ips).length)

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
    <div className="drawer-scrim" {...pressable((e: any) => { ((onClose) as any)(e) })} data-a11y-click="">
      <div className="drawer" {...pressable((e: any) => { (((e: any) => e.stopPropagation()) as any)(e) })} data-a11y-click="">
        <div className="drawer-h">
          <div className="t">{isEdit ? name || 'App settings' : 'Register app'}</div>
          <button className="xbtn" onClick={onClose}>✕</button>
        </div>
        <div className="drawer-b">
          <div style={{ fontSize: 'var(--fs-sm)', color: 'var(--muted)', marginBottom: 14 }}>
            {isEdit
              ? 'This app holds a publishable key your player embeds. Changing where it works takes effect immediately.'
              : 'Registering an app mints a publishable key for it to embed. The key is safe to ship in client code; what bounds it is the platform and the restriction below.'}
          </div>

          <div className="field"><label>App name</label>
            <input className="inp" value={name} onChange={e => setName(e.target.value)} placeholder="e.g. Web player, iOS app" />
          </div>

          <div className="sec-label">Platform</div>
          {isEdit ? (
            <>
              <ChoiceRow on title={PLATFORMS.find(p => p.v === type)?.title ?? type}
                sub={PLATFORMS.find(p => p.v === type)?.sub ?? ''} onPick={() => {}} />
              <div className="hintxt">The platform is fixed once registered, because the key's binding follows from it. Register a new app to change it.</div>
            </>
          ) : (
            PLATFORMS.map(pf => (
              <ChoiceRow key={pf.v} on={type === pf.v} title={pf.title} sub={pf.sub}
                onPick={() => setType(pf.v)} />
            ))
          )}

          <div className="sec-label">Where the key works</div>
          {attested ? (
            <div className="hintxt" style={{ marginBottom: 8 }}>
              Nothing to set. A {PLATFORMS.find(p => p.v === type)?.title} app is bound by device attestation in the client SDK, which is stronger than anything that could be typed here.
            </div>
          ) : (
            <>
              <div className="flex" style={{ gap: 8, flexWrap: 'wrap', marginBottom: 8 }}>
                <SettingChip on={!bounded} label={type === 'web' ? 'Any origin' : 'Any address'} onPick={() => setBounded(false)} />
                <SettingChip on={bounded} label={type === 'web' ? 'Only my origins' : 'Only my addresses'} onPick={() => setBounded(true)} />
              </div>
              {bounded && (
                <div className="field">
                  <label>{type === 'web' ? 'Allowed origins' : 'Allowed addresses'} <span style={{ color: 'var(--faint)' }}>— one per line</span></label>
                  <textarea className="inp" rows={3}
                    value={type === 'web' ? origins : ips}
                    onChange={e => (type === 'web' ? setOrigins(e.target.value) : setIps(e.target.value))}
                    placeholder={type === 'web' ? 'https://watch.example.com\n*.example.com' : '203.0.113.10\n203.0.113.11'}
                    style={{ resize: 'vertical', fontFamily: 'ui-monospace,monospace', fontSize: 'var(--fs-sm)' }} />
                  {type === 'web' && <div className="hintxt">Matched against the request's Origin or Referer. Wildcards like *.example.com are supported.</div>}
                </div>
              )}
            </>
          )}

          {/* WHAT YOU ARE ABOUT TO CREATE.
              The share-form study's one genuinely new idea, and the thing this
              section most lacked: a key is an invisible object with real blast
              radius, and nothing here previously said in words where it would
              work or what it could do. */}
          <div style={{
            border: '1px solid var(--border)', borderRadius: 12, padding: 14, marginTop: 4,
            background: 'var(--panel-2,rgba(255,255,255,.02))',
          }}>
            <div style={{ fontSize: 'var(--fs-label,11px)', letterSpacing: 'var(--ls-label)', textTransform: 'uppercase', color: 'var(--faint)', fontWeight: 700, marginBottom: 8 }}>
              {isEdit ? 'This app’s key' : 'What will be created'}
            </div>
            <div style={{ fontFamily: 'ui-monospace,monospace', fontSize: 'var(--fs-sm)' }}>
              pk_live_<span style={{ color: 'var(--faint)' }}>••••••••••••••••</span>
            </div>
            <div style={{ fontSize: 'var(--fs-sm)', color: 'var(--muted)', marginTop: 8 }}>
              <b>Works:</b> {willWork}
            </div>
            <div style={{ fontSize: 'var(--fs-sm)', color: 'var(--muted)', marginTop: 4 }}>
              <b>Can do:</b> check availability and mint short-lived playback tokens. It cannot read or change anything in this console.
            </div>
            {loose && (
              <div style={{ fontSize: 'var(--fs-sm)', color: 'var(--warn,#fbbf24)', marginTop: 8 }}>
                {/* Worded per platform. "Copies it out of your page" is how a
                    web key leaks and is meaningless for a server key, where
                    the leak is a committed config file. A warning that
                    describes the wrong failure is one people learn to skip. */}
                {type === 'web'
                  ? 'Unrestricted. Anyone who copies this key out of your page can use it to play your streams. Add your origins once you know them.'
                  : 'Unrestricted. Anyone who obtains this key, from a committed config file or a log, can use it from anywhere. Add your server addresses once you know them.'}
              </div>
            )}
            {emptyBound && (
              <div style={{ fontSize: 'var(--fs-sm)', color: 'var(--down,#f87171)', marginTop: 8 }}>
                Restricted with an empty list, so every request would be refused, including your own player.
              </div>
            )}
          </div>

          {/* One disclosure for the rest, per the study: everything rarer than
              the two questions above lives behind a single toggle rather than
              lengthening the form for everybody. */}
          {isEdit && (
            <>
              <div {...pressable(() => setAdvanced(a => !a))} data-a11y-click=""
                   style={{ cursor: 'pointer', margin: '16px 0 6px', color: 'var(--muted)', fontSize: 'var(--fs-sm)' }}>
                {advanced ? '▾' : '▸'} Keys, rotation and availability
              </div>
              {advanced && (
                <>
                  <div className="toggle-row">
                    <div><div className="tt">App enabled</div><div className="td">Disabling blocks all of this app's keys at once without deleting them. Playback stops immediately.</div></div>
                    <div className={`sw ${enabled ? '' : 'off'}`} {...pressable((e: any) => { ((() => setEnabled(v => !v)) as any)(e) })} data-a11y-click=""><i /></div>
                  </div>

                  <div className="sec-label">Keys</div>
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
                  <button className="btn ghost" style={{ marginTop: 10 }} disabled={busy} onClick={rotate}>Issue a new key</button>
                  <div className="hintxt">Rotate in this order: issue the new key, roll it out to your app, then revoke the old one. Old keys keep working until revoked, so nothing breaks in between.</div>
                </>
              )}
            </>
          )}
        </div>
        <div className="drawer-f">
          <FormStatus error={err} />
          <button className="btn ghost" onClick={onClose}>Cancel</button>
          {/* The button states the OUTCOME. "Register app" does not tell you a
              key is about to be minted and shown once; this does. */}
          <button className="btn primary" disabled={busy} onClick={submit}>
            {busy ? 'Saving…' : isEdit ? 'Save changes' : 'Register and show me the key'}
          </button>
        </div>
      </div>
    </div>
  )
}
