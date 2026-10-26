import { useEffect, useState } from 'react'
import { api, apiRequest, type SocialAccount, type SocialPlatformsStatus } from '../api'
import { PageHead } from '../scaffold'
import { navigate } from '../router'
import { pressable } from '../a11y'
import { useNotify, usePageNotice } from '../notices'
import { useAccess } from '../access'

/* ============================================================================
   SOCIAL ACCOUNTS (Admin). Link the YouTube channels, Facebook Pages,
   Instagram professional accounts, Threads profiles and X, TikTok and
   Dailymotion accounts clips (and, for Instagram and Threads, pictures) are
   published to.

   INSTAGRAM (build queue 1.14i) links two ways, each its own button: with
   Instagram Login, or with Facebook Login for an Instagram account tied to a
   Page. Each linked account shows its follower count and how it was linked.

   Connect sends the browser to the platform's own sign-in; the platform sends
   it back here with the outcome in the URL (?linked= or ?error=), which this
   page reads once, says out loud, and clears.

   A platform the deployment has no app credentials for says so and still
   offers a SANDBOX account. Whoever runs the deployment (access.seesServerSetup)
   is also shown the two settings and the callback URL to register; an account
   user is told their Volt provider sets it up, since they cannot act on the
   server's settings (and the API leaves them out for them). A SANDBOX account is one that behaves like the platform (progress, a post page, views)
   without sending anything anywhere, so the publishing flow can be tried now.

   X IS OFF BY DEFAULT (build queue 1.14h): X bills its API per post and per
   read. It shows here only when a system administrator has switched it on for
   the account, or the account added its own X developer app (X then bills the
   customer). Without either there is no X card; linked X accounts are kept and
   shown as Off, and the X panel below says how to get it. The secret of the
   account's own app is sent once and never shown again.
   ========================================================================== */
interface XState { enabled: boolean; allowed: boolean; ownApp: { clientId: string; hasSecret: boolean; updatedAt: string | null } | null
  canSwitch: boolean; switchReason: string | null; callbackUrl: string }
type Account = SocialAccount & { off?: boolean }

/** X: the platform switch (system administrators) and the account's own X app. */
function XPanel({ x, canManage, onChange }: { x: XState; canManage: boolean; onChange: (x: XState) => void }) {
  const [open, setOpen] = useState(false)
  const [id, setId] = useState('')
  const [secret, setSecret] = useState('')
  const [busy, setBusy] = useState(false)
  const notify = useNotify()
  const run = async (f: () => Promise<XState>) => {
    setBusy(true)
    try { onChange(await f()); setOpen(false); setId(''); setSecret('') } catch (e: any) { notify({ kind: 'error', message: e.message }) } finally { setBusy(false) }
  }
  const send = (method: string, path: string, body?: any) => apiRequest(path, { method, ...(body ? { body: JSON.stringify(body) } : {}) }) as Promise<XState>
  return (
    <div className="card" style={{ padding: 0, marginTop: 12 }}>
      <div className="nt-row">
        <span style={{ color: 'var(--muted)', display: 'grid', placeItems: 'center' }}><Glyph /></span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontWeight: 600 }}>X
            <span className={`nt-pill ${x.allowed ? 'ok' : 'muted'}`}>{x.ownApp ? 'On, with your own X app' : x.enabled ? 'On for this account' : 'Off'}</span>
          </div>
          <div className="hintxt" style={{ marginTop: 2 }}>
            {x.ownApp
              ? `Posts go through your X app (client id ${x.ownApp.clientId}), so X bills you directly.`
              : x.enabled
                ? 'Switched on by your Volt provider: posts go through their X app.'
                : 'X charges for every post and every read, so it is off unless your Volt provider switches it on for this account, or you add your own X developer app.'}
          </div>
        </div>
        {x.canSwitch && (
          <div className={`sw ${x.enabled ? '' : 'off'}`} title={x.enabled ? 'X is on for this account' : 'X is off for this account'}
            {...pressable(() => { if (!busy) run(() => send('PATCH', '/social/x', { enabled: !x.enabled })) }, { label: x.enabled ? 'Switch X off for this account' : 'Switch X on for this account' })}><i /></div>
        )}
        {canManage && !x.ownApp && <button className="btn ghost" onClick={() => setOpen(o => !o)}>Use your own X app</button>}
        {canManage && x.ownApp && <button className="btn ghost" onClick={() => setOpen(o => !o)}>Change X app</button>}
        {canManage && x.ownApp && <button className="btn ghost" disabled={busy} onClick={() => {
          if (window.confirm('Remove your own X app? Linked X accounts are kept, but X turns off unless your Volt provider has switched it on.')) run(() => send('DELETE', '/social/x/app'))
        }}>Remove X app</button>}
      </div>
      {open && (
        <div className="nt-setup">
          Create an app in the X developer portal with OAuth 2.0 turned on, add this callback address to it, and enter its client id and secret here. The secret is stored encrypted and never shown again.
          <div className="nt-kv"><span>Callback URL</span><code>{x.callbackUrl}</code></div>
          <div className="nt-kv"><span>Permissions</span><code>tweet.read tweet.write users.read media.write offline.access</code></div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 10 }}>
            <input className="inp" aria-label="X client id" placeholder="Client id" value={id} onChange={e => setId(e.target.value)} style={{ flex: 1, minWidth: 200 }} />
            <input className="inp" aria-label="X client secret" type="password" autoComplete="off" placeholder="Client secret" value={secret} onChange={e => setSecret(e.target.value)} style={{ flex: 1, minWidth: 200 }} />
            <button className="btn primary" disabled={busy || id.trim().length < 4 || secret.trim().length < 4}
              onClick={() => run(() => send('PUT', '/social/x/app', { clientId: id.trim(), clientSecret: secret.trim() }))}>{busy ? 'Saving…' : 'Save X app'}</button>
          </div>
        </div>
      )}
    </div>
  )
}
const STATUS: Record<string, { label: string; cls: string }> = {
  connected: { label: 'Connected', cls: 'ok' }, expired: { label: 'Reconnect needed', cls: 'bad' }, error: { label: 'Problem', cls: 'warn' },
}
const fmt = (iso: string | null) => iso ? new Date(iso).toLocaleDateString([], { day: '2-digit', month: 'short', year: 'numeric' }) : ''

/** A neutral glyph per platform kind: the name carries the identity, not a drawn logo. */
function Glyph() {
  return <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><rect x="3" y="5" width="18" height="14" rx="3" /><path d="M10 9.5v5l4.5-2.5z" fill="currentColor" stroke="none" /></svg>
}

export default function SocialAccountsPage() {
  const [st, setSt] = useState<SocialPlatformsStatus | null>(null)
  const [accounts, setAccounts] = useState<Account[] | null>(null)
  const [x, setX] = useState<XState | null>(null)
  const [err, setErr] = useState('')
  const [banner, setBanner] = useState<{ ok: boolean; text: string } | null>(null)
  const [busy, setBusy] = useState('')
  const [setupOpen, setSetupOpen] = useState<string | null>(null)
  const notify = useNotify()
  const { seesServerSetup, can } = useAccess()
  const fail = (e: any) => notify({ kind: 'error', message: e.message })

  const load = () => {
    api.socialPlatforms().then(setSt).catch(e => setErr(e.message))
    api.socialAccounts().then(setAccounts).catch(e => setErr(e.message))
    ;(apiRequest('/social/x') as Promise<XState>).then(setX).catch(e => setErr(e.message))
  }
  useEffect(() => {
    // The platform sent the browser back here: say what happened, then tidy the URL.
    const q = new URLSearchParams(window.location.search)
    const platform = q.get('platform')
    if (q.get('linked')) setBanner({ ok: true, text: `Linked ${q.get('linked')}${platform ? ` on ${platform}` : ''}.` })
    else if (q.get('error')) setBanner({ ok: false, text: q.get('error')! })
    if (platform) navigate('/social', { replace: true })
    load()
  }, [])

  async function connect(id: string, variant?: string | null) {
    setBusy(variant ? `${id}:${variant}` : id)
    try { const { url } = await api.socialConnect(id, variant ?? undefined); window.location.assign(url) }
    catch (e: any) { fail(e); setBusy('') }
  }
  async function sandbox(id: string) {
    setBusy(`sb-${id}`)
    try { await api.socialSandbox(id); load() } catch (e: any) { fail(e) } finally { setBusy('') }
  }
  usePageNotice('load', err ? { kind: 'error', title: "Couldn't load social accounts.", message: err, actions: [{ label: 'Retry', onClick: () => { setErr(''); load() } }] } : null)

  return (
    <>
      <PageHead title="Social accounts" sub="The channels, Pages and accounts clips can be published to. Each is linked by signing in on the platform; Volt never sees the password, and keeps only an access token, encrypted." />
      {banner && <div className={`nt-banner ${banner.ok ? 'ok' : 'bad'}`} role="status">{banner.text}<button className="xbtn" onClick={() => setBanner(null)} aria-label="Dismiss">✕</button></div>}
      {seesServerSetup && st && st.tokenKeyConfigured === false && (
        <div className="lock-note"><strong>Set SOCIAL_TOKEN_KEY before linking real accounts.</strong> Tokens are encrypted with a key derived from the sign-in secret until then, and rotating that secret would disconnect every account.</div>
      )}

      {!st || !accounts ? <div className="loading">Loading…</div> : st.platforms.map(p => {
        const mine = accounts.filter(a => a.platform === p.id)
        return (
          <div key={p.id} className="card" style={{ padding: 0, marginTop: 12 }}>
            <div className="nt-row">
              <span style={{ color: 'var(--muted)', display: 'grid', placeItems: 'center' }}><Glyph /></span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: 600 }}>{p.label}
                  <span className={`nt-pill ${p.configured ? 'ok' : 'muted'}`}>{p.configured ? 'Ready to connect' : 'Not set up'}</span>
                </div>
                <div className="hintxt" style={{ marginTop: 2 }}>
                  {p.configured ? `Publishes to ${/^[aeiou]/i.test(p.accountNoun) ? 'an' : 'a'} ${p.accountNoun}.` : seesServerSetup ? `Needs ${p.label} app credentials on this deployment.` : 'Your Volt provider sets this up.'}
                  {' '}{p.limits.title != null ? `Title up to ${p.limits.title} characters, description up to ${p.limits.description}.` : `Caption up to ${p.limits.description} characters, hashtags included${p.limits.hashtags === 1 ? ', one hashtag' : p.limits.hashtags != null ? `, at most ${p.limits.hashtags} hashtags` : ''}.`}
                  {p.images ? (p.id === 'threads' ? ' Clips and Image Library pictures go as posts with their text. Threads fetches them from this Volt\'s public address.' : ' Clips go as Reels, Image Library pictures as feed posts.') : ''}
                </div>
              </div>
              {!p.configured && seesServerSetup && p.env && <button className="btn ghost" onClick={() => setSetupOpen(o => o === p.id ? null : p.id)}>How to set up</button>}
              <button className="btn ghost" disabled={busy === `sb-${p.id}`} onClick={() => sandbox(p.id)}>Add sandbox account</button>
              {p.configured && !p.variants && <button className="btn primary" disabled={busy === p.id} onClick={() => connect(p.id)}>{busy === p.id ? 'Opening…' : `Connect ${p.label}`}</button>}
              {p.variants?.filter(v => v.configured).map((v, i) => (
                <button key={v.id} className={`btn ${i === 0 ? 'primary' : ''}`} disabled={busy === `${p.id}:${v.id}`} onClick={() => connect(p.id, v.id)}>
                  {busy === `${p.id}:${v.id}` ? 'Opening…' : v.id === 'facebook' ? 'Connect through a Facebook Page' : `Connect ${p.label}`}
                </button>
              ))}
              {p.configured && p.variants?.some(v => !v.configured) && seesServerSetup && <button className="btn ghost" onClick={() => setSetupOpen(o => o === p.id ? null : p.id)}>How to set up</button>}
            </div>
            {setupOpen === p.id && p.env && (
              <div className="nt-setup">
                Register an app with {p.label}, add this redirect URL to it, and set the two values on the server, then restart:
                <div className="nt-kv"><span>Redirect URL</span><code>{p.callbackUrl}</code></div>
                {p.variants ? p.variants.map(v => (
                  <div key={v.id}>
                    <div className="nt-kv"><span>{v.label}</span>{(v.env ?? []).map(e => <code key={e}>{e}</code>)}{v.configured && <span className="nt-pill ok">Set</span>}</div>
                    <div className="nt-kv"><span>Permissions</span><code>{(v.scopes ?? []).join(' ')}</code></div>
                  </div>
                )) : <>
                  <div className="nt-kv"><span>Settings</span><code>{p.env[0]}</code><code>{p.env[1]}</code></div>
                  <div className="nt-kv"><span>Permissions</span><code>{(p.scopes ?? []).join(' ')}</code></div>
                </>}
              </div>
            )}
            {mine.length > 0 && (
              <div style={{ borderTop: '1px solid var(--border)' }}>
                {mine.map((a, i) => {
                  const s = STATUS[a.link_status] ?? STATUS.connected
                  return (
                    <div key={a.id} className="nt-row" style={{ borderTop: i ? '1px solid var(--border)' : undefined, opacity: a.enabled ? 1 : 0.6 }}>
                      {a.avatar_url
                        ? <img src={a.avatar_url} alt="" style={{ width: 28, height: 28, borderRadius: '50%', objectFit: 'cover', flex: 'none' }} onError={e => { (e.currentTarget as HTMLImageElement).style.visibility = 'hidden' }} />
                        : <span className="nt-avatar" aria-hidden="true">{(a.account_label ?? a.name).replace('@', '').slice(0, 1).toUpperCase()}</span>}
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontWeight: 600 }}>{a.account_label ?? a.name}
                          {a.mode === 'sandbox' && <span className="nt-pill muted">Sandbox</span>}
                          <span className={`nt-pill ${s.cls}`}>{s.label}</span>
                          {!a.enabled && <span className="nt-pill muted">Disabled</span>}
                          {a.off && <span className="nt-pill muted">Off: X is not on for this account</span>}
                        </div>
                        <div className="hintxt" style={{ marginTop: 2 }}>
                          {a.followers != null ? `${a.followers.toLocaleString()} followers · ` : ''}{a.published} published{a.last_published_at ? `, last ${fmt(a.last_published_at)}` : ''}
                          {a.variant && p.variants ? ` · linked with ${p.variants.find(v => v.id === a.variant)?.id === 'facebook' ? 'a Facebook Page' : `${p.label} Login`}` : ''}
                          {a.linked_at ? ` · linked ${fmt(a.linked_at)}${a.linked_by_email ? ` by ${a.linked_by_email}` : ''}` : ''}
                        </div>
                        {a.link_detail && <div className="hintxt" style={{ marginTop: 2, color: 'var(--warn)' }}>{a.link_detail}</div>}
                      </div>
                      {a.link_status === 'expired' && a.mode === 'live' && <button className="btn" onClick={() => connect(p.id, a.variant)}>Reconnect</button>}
                      <div className={`sw ${a.enabled ? '' : 'off'}`} title={a.enabled ? 'Enabled: can be published to' : 'Disabled'}
                        {...pressable(() => { api.socialSetEnabled(a.id, !a.enabled).then(load).catch(fail) }, { label: a.enabled ? 'Disable account' : 'Enable account' })}><i /></div>
                      <button className="btn ghost" onClick={() => {
                        if (window.confirm(`Disconnect ${a.account_label ?? a.name}? Posts already published stay on ${p.label}; Volt stops publishing to it and forgets its token.`))
                          api.socialDisconnect(a.id).then(load).catch(fail)
                      }}>Disconnect</button>
                    </div>
                  )
                })}
              </div>
            )}
          </div>
        )
      })}
      {/* Someone who can neither switch X on nor add an app gets no X card at all. */}
      {x && st && accounts && (x.allowed || x.canSwitch || can('settings', 'manage')) && (
        <XPanel x={x} canManage={can('settings', 'manage')} onChange={(nx) => { setX(nx); api.socialPlatforms().then(setSt).catch(() => {}); api.socialAccounts().then(setAccounts).catch(() => {}) }} />
      )}
      {x && !x.allowed && accounts && accounts.some(a => a.platform === 'x') && (
        <div className="card" style={{ padding: 0, marginTop: 8 }}>
          {accounts.filter(a => a.platform === 'x').map((a, i) => (
            <div key={a.id} className="nt-row" style={{ borderTop: i ? '1px solid var(--border)' : undefined, opacity: 0.6 }}>
              <span className="nt-avatar" aria-hidden="true">{(a.account_label ?? a.name).replace('@', '').slice(0, 1).toUpperCase()}</span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: 600 }}>{a.account_label ?? a.name}{a.mode === 'sandbox' && <span className="nt-pill muted">Sandbox</span>}<span className="nt-pill muted">Off</span></div>
                <div className="hintxt" style={{ marginTop: 2 }}>Kept while X is off: {a.published} published. Nothing is posted to it or read from it until X is on again.</div>
              </div>
            </div>
          ))}
        </div>
      )}
      <div className="hintxt" style={{ marginTop: 12 }}>A sandbox account goes through every step of publishing, with progress and a post page, without sending anything to the platform. Put "[fail]" in a post's title to see how a rejected post looks.</div>
    </>
  )
}
