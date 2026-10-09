import { useEffect, useState } from 'react'
import { api, type SocialAccount, type SocialPlatformsStatus } from '../api'
import { PageHead } from '../scaffold'
import { navigate } from '../router'
import { pressable } from '../a11y'

/* ============================================================================
   SOCIAL ACCOUNTS (Admin). Link the YouTube channels, Facebook Pages and X,
   TikTok and Dailymotion accounts clips are published to.

   Connect sends the browser to the platform's own sign-in; the platform sends
   it back here with the outcome in the URL (?linked= or ?error=), which this
   page reads once, says out loud, and clears.

   A platform the deployment has no app credentials for says so, names the two
   settings and the callback URL to register, and still offers a SANDBOX
   account: one that behaves like the platform (progress, a post page, views)
   without sending anything anywhere, so the publishing flow can be tried now.
   ========================================================================== */
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
  const [accounts, setAccounts] = useState<SocialAccount[] | null>(null)
  const [err, setErr] = useState('')
  const [banner, setBanner] = useState<{ ok: boolean; text: string } | null>(null)
  const [busy, setBusy] = useState('')
  const [setupOpen, setSetupOpen] = useState<string | null>(null)

  const load = () => {
    api.socialPlatforms().then(setSt).catch(e => setErr(e.message))
    api.socialAccounts().then(setAccounts).catch(e => setErr(e.message))
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

  async function connect(id: string) {
    setErr(''); setBusy(id)
    try { const { url } = await api.socialConnect(id); window.location.assign(url) }
    catch (e: any) { setErr(e.message); setBusy('') }
  }
  async function sandbox(id: string) {
    setErr(''); setBusy(`sb-${id}`)
    try { await api.socialSandbox(id); load() } catch (e: any) { setErr(e.message) } finally { setBusy('') }
  }

  return (
    <>
      <PageHead title="Social accounts" sub="The channels, Pages and accounts clips can be published to. Each is linked by signing in on the platform; Volt never sees the password, and keeps only an access token, encrypted." />
      {banner && <div className={`nt-banner ${banner.ok ? 'ok' : 'bad'}`} role="status">{banner.text}<button className="xbtn" onClick={() => setBanner(null)} aria-label="Dismiss">✕</button></div>}
      {err && <div className="err">{err}</div>}
      {st && !st.tokenKeyConfigured && (
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
                  {p.configured ? `Publishes to a ${p.accountNoun}.` : `Needs ${p.label} app credentials on this deployment.`}
                  {' '}{p.limits.title != null ? `Title up to ${p.limits.title} characters, description up to ${p.limits.description}.` : `Caption up to ${p.limits.description} characters, hashtags included.`}
                </div>
              </div>
              {!p.configured && <button className="btn ghost" onClick={() => setSetupOpen(o => o === p.id ? null : p.id)}>How to set up</button>}
              <button className="btn ghost" disabled={busy === `sb-${p.id}`} onClick={() => sandbox(p.id)}>Add sandbox account</button>
              {p.configured && <button className="btn primary" disabled={busy === p.id} onClick={() => connect(p.id)}>{busy === p.id ? 'Opening…' : `Connect ${p.label}`}</button>}
            </div>
            {setupOpen === p.id && (
              <div className="nt-setup">
                Register an app with {p.label}, add this redirect URL to it, and set the two values on the server, then restart:
                <div className="nt-kv"><span>Redirect URL</span><code>{p.callbackUrl}</code></div>
                <div className="nt-kv"><span>Settings</span><code>{p.env[0]}</code><code>{p.env[1]}</code></div>
                <div className="nt-kv"><span>Permissions</span><code>{p.scopes.join(' ')}</code></div>
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
                        </div>
                        <div className="hintxt" style={{ marginTop: 2 }}>
                          {a.published} published{a.last_published_at ? `, last ${fmt(a.last_published_at)}` : ''}
                          {a.linked_at ? ` · linked ${fmt(a.linked_at)}${a.linked_by_email ? ` by ${a.linked_by_email}` : ''}` : ''}
                        </div>
                        {a.link_detail && <div className="hintxt" style={{ marginTop: 2, color: 'var(--warn)' }}>{a.link_detail}</div>}
                      </div>
                      {a.link_status === 'expired' && a.mode === 'live' && <button className="btn" onClick={() => connect(p.id)}>Reconnect</button>}
                      <div className={`sw ${a.enabled ? '' : 'off'}`} title={a.enabled ? 'Enabled: can be published to' : 'Disabled'}
                        {...pressable(() => { api.socialSetEnabled(a.id, !a.enabled).then(load).catch(e => setErr(e.message)) }, { label: a.enabled ? 'Disable account' : 'Enable account' })}><i /></div>
                      <button className="btn ghost" onClick={() => {
                        if (window.confirm(`Disconnect ${a.account_label ?? a.name}? Posts already published stay on ${p.label}; Volt stops publishing to it and forgets its token.`))
                          api.socialDisconnect(a.id).then(load).catch(e => setErr(e.message))
                      }}>Disconnect</button>
                    </div>
                  )
                })}
              </div>
            )}
          </div>
        )
      })}
      <div className="hintxt" style={{ marginTop: 12 }}>A sandbox account goes through every step of publishing, with progress and a post page, without sending anything to the platform. Put "[fail]" in a post's title to see how a rejected post looks.</div>
    </>
  )
}
