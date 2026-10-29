// SINGLE SIGN-ON on the sign-in page (ACCESS_CONTROL.md section 14).
//
//  * As the email is typed, its domain is looked up (GET /api/auth/sso/discover):
//    the organisation's provider is offered as "Continue with <name>".
//  * When the organisation makes SSO compulsory, the password is hidden (an
//    owner can still open it: the way back in if the provider is down).
//  * The provider sends the person back to the console with ?sso=<one-time code>
//    (or ?sso_error=...); the code is exchanged for a session here, and the
//    address bar is cleaned so the code is never left in history.
import { useEffect, useState } from 'react'

export interface SsoOffer { connections: { id: string; name: string; protocol: 'oidc' | 'saml' }[]; required: boolean }

const EMAILISH = /^[^@\s]+@[^@\s]+\.[^@\s]{2,}$/

export function useSsoDiscovery(email: string): SsoOffer | null {
  const [offer, setOffer] = useState<SsoOffer | null>(null)
  useEffect(() => {
    const e = email.trim()
    if (!EMAILISH.test(e)) { setOffer(null); return }
    const ctl = new AbortController()
    const t = window.setTimeout(() => {
      fetch(`/api/auth/sso/discover?email=${encodeURIComponent(e)}`, { signal: ctl.signal })
        .then((r) => (r.ok ? r.json() : null)).then((o) => setOffer(o?.connections?.length ? o : null)).catch(() => { /* typing on */ })
    }, 350)
    return () => { window.clearTimeout(t); ctl.abort() }
  }, [email])
  return offer
}

/** Off to the provider: a full page navigation (the provider's page, then back to Volt). */
export function startSso(connectionId: string, email?: string, returnTo?: string) {
  const q = new URLSearchParams()
  if (email) q.set('login_hint', email)
  const ret = returnTo ?? (window.location.pathname !== '/' ? window.location.pathname + window.location.search : '')
  if (ret) q.set('return', ret)
  window.location.assign(`/api/auth/sso/start/${encodeURIComponent(connectionId)}${q.toString() ? `?${q}` : ''}`)
}

/** The provider's return, read once and removed from the address bar. */
export function takeSsoReturn(): { code?: string; error?: string } | null {
  const u = new URL(window.location.href)
  const code = u.searchParams.get('sso'), error = u.searchParams.get('sso_error')
  if (!code && !error) return null
  u.searchParams.delete('sso'); u.searchParams.delete('sso_error')
  window.history.replaceState(null, '', u.pathname + (u.searchParams.toString() ? `?${u.searchParams}` : '') + u.hash)
  return code ? { code } : { error: error ?? 'Single sign-on failed' }
}

/** One-time code for a session (or a two-step challenge, like a password sign-in). */
export async function finishSso(code: string): Promise<any> {
  const r = await fetch('/api/auth/sso/finish', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code }) })
  const j = await r.json().catch(() => ({}))
  if (!r.ok) throw new Error(j.error || `Single sign-on failed (${r.status})`)
  return j
}

const KEY_ICON = (
  <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <rect x="3" y="11" width="18" height="10" rx="2" /><path d="M7 11V7a5 5 0 0110 0v4" />
  </svg>
)

/** "Continue with <provider>" for each connection the email's domain has. */
export function SsoButtons({ offer, email, primary }: { offer: SsoOffer | null; email: string; primary?: boolean }) {
  if (!offer?.connections.length) return null
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, margin: '4px 0 12px' }}>
      {offer.connections.map((c) => (
        <button key={c.id} type="button" className={`btn ${primary ? 'primary' : ''}`} style={{ width: '100%', justifyContent: 'center', gap: 8 }}
          onClick={() => startSso(c.id, email.trim())}>
          {KEY_ICON}Continue with {c.name}
        </button>
      ))}
    </div>
  )
}
