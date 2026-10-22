/**
 * ONBOARDING SCREENS, shown before sign-in (docs/ONBOARDING.md):
 *
 *   /welcome#t=…          an invitation (from an admin, or a new account from the promo site)
 *   /reset-password#t=…   a reset link
 *   /forgot-password      ask for a reset link
 *
 * Three steps: confirm who the link is for and email a code, enter the code,
 * choose a password. The token is read from the URL fragment (never sent to the
 * server with the page), moved into this tab's session storage and wiped from
 * the address bar, so it does not sit in history or get copied with the URL.
 *
 * Every rule is the API's; these screens walk people through it.
 */
import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { apiRequest, type MfaStep, type Session } from './api'
import { CodeField } from './security'
import { Notice } from './notices'

export type OnboardingKind = 'welcome' | 'reset' | 'forgot'

export function onboardingKindFor(pathname: string): OnboardingKind | null {
  const p = pathname.replace(/\/+$/, '')
  if (p === '/welcome') return 'welcome'
  if (p === '/reset-password') return 'reset'
  if (p === '/forgot-password') return 'forgot'
  return null
}

const KEY = (k: OnboardingKind) => `volt-onboard-${k}`

/** The token from #t=…, kept for this tab only, and removed from the address bar. */
function takeToken(kind: OnboardingKind): string {
  const m = /[#&]t=([A-Za-z0-9_-]{30,100})/.exec(window.location.hash)
  if (m) {
    try { sessionStorage.setItem(KEY(kind), m[1]) } catch { /* private mode: keep it in memory only */ }
    try { history.replaceState(null, '', window.location.pathname) } catch { /* ignore */ }
    return m[1]
  }
  try { return sessionStorage.getItem(KEY(kind)) ?? '' } catch { return '' }
}
const forgetToken = (kind: OnboardingKind) => { try { sessionStorage.removeItem(KEY(kind)) } catch { /* ignore */ } }

const post = (path: string, body: unknown) => apiRequest(path, { method: 'POST', body: JSON.stringify(body) })

interface LinkInfo { kind: 'invite' | 'password_reset'; email: string; displayName: string | null; accountName: string; invitedBy: string | null; expiresAt: string; founder?: boolean }

const ic = (d: ReactNode) => <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{d}</svg>
const MAIL = ic(<><rect x="3" y="5" width="18" height="14" rx="2" /><path d="m3 7 9 6 9-6" /></>)
const LOCK = ic(<><rect x="4" y="10" width="16" height="11" rx="2" /><path d="M8 10V7a4 4 0 0 1 8 0v3" /></>)
const TICK = ic(<path d="M20 6 9 17l-5-5" />)
const DOT = ic(<circle cx="12" cy="12" r="1.5" />)
const EYE = ic(<><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z" /><circle cx="12" cy="12" r="3" /></>)
const EYE_OFF = ic(<><path d="M3 3l18 18M10.6 10.6a3 3 0 0 0 4.2 4.2M9.9 5.1A10 10 0 0 1 12 5c6.5 0 10 7 10 7a17 17 0 0 1-3.2 4.2M6.6 6.6A17 17 0 0 0 2 12s3.5 7 10 7a9.7 9.7 0 0 0 4-.9" /></>)

/** Two steps, shown as a quiet progress line above the form. */
function Steps({ at }: { at: 1 | 2 }) {
  const item = (n: 1 | 2, label: string, icon: ReactNode) => (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6, color: at === n ? 'var(--text)' : at > n ? 'var(--live, #34d399)' : 'var(--faint)', fontSize: 'var(--fs-sm)', fontWeight: at === n ? 600 : 500 }}>
      {at > n ? TICK : icon}{label}
    </div>
  )
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, margin: '2px 0 16px' }} aria-label={`Step ${at} of 2`}>
      {item(1, 'Confirm your email', MAIL)}
      <div style={{ flex: 1, height: 1, background: 'var(--border)' }} />
      {item(2, 'Choose a password', LOCK)}
    </div>
  )
}

function Rule({ ok, children }: { ok: boolean; children: ReactNode }) {
  return <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 'var(--fs-sm)', color: ok ? 'var(--live, #34d399)' : 'var(--muted)' }}>{ok ? TICK : DOT}{children}</div>
}

export function OnboardingFlow({ kind, onSession, onMfaStep, onSignIn }: {
  kind: OnboardingKind
  /** `next` is 'invite_team' for the founder of a newly registered client. */
  onSession: (s: Session, next?: string | null) => void
  onMfaStep: (s: MfaStep, email: string, next?: string | null) => void
  onSignIn: () => void
}) {
  if (kind === 'forgot') return <ForgotPassword onSignIn={onSignIn} />
  return <LinkFlow kind={kind} onSession={onSession} onMfaStep={onMfaStep} onSignIn={onSignIn} />
}

function LinkFlow({ kind, onSession, onMfaStep, onSignIn }: { kind: 'welcome' | 'reset'; onSession: (s: Session, next?: string | null) => void; onMfaStep: (s: MfaStep, email: string, next?: string | null) => void; onSignIn: () => void }) {
  const [token] = useState(() => takeToken(kind))
  const [info, setInfo] = useState<LinkInfo | null>(null)
  const [dead, setDead] = useState(!token)
  const [phase, setPhase] = useState<'intro' | 'code' | 'password'>('intro')
  const [sentTo, setSentTo] = useState('')
  const [devCode, setDevCode] = useState<string | undefined>()
  const [cooldown, setCooldown] = useState(0)
  const [code, setCode] = useState('')
  const [setupToken, setSetupToken] = useState('')
  const [name, setName] = useState('')
  const [org, setOrg] = useState('')
  const [pw, setPw] = useState('')
  const [pw2, setPw2] = useState('')
  const [show, setShow] = useState(false)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')

  useEffect(() => {
    if (!token) return
    post('/onboarding/link', { token })
      .then((r: LinkInfo) => { setInfo(r); setName(r.displayName ?? ''); setOrg(r.accountName ?? '') })
      .catch((e: any) => { if (e?.status === 410 || e?.status === 400) setDead(true); else setErr(e.message) })
  }, [token])

  useEffect(() => {
    if (cooldown <= 0) return
    const t = setTimeout(() => setCooldown(c => c - 1), 1000)
    return () => clearTimeout(t)
  }, [cooldown])

  async function sendCode() {
    setErr(''); setBusy(true)
    try {
      const r = await post('/onboarding/code', { token })
      setSentTo(r.sentTo ?? ''); setDevCode(r.devCode); setPhase('code'); setCode(''); setCooldown(30)
    } catch (e: any) { if (e?.status === 410) setDead(true); else setErr(e.message) } finally { setBusy(false) }
  }

  async function verify(e: React.FormEvent) {
    e.preventDefault(); setErr(''); setBusy(true)
    try {
      const r = await post('/onboarding/verify', { token, code })
      setSetupToken(r.setupToken); setPhase('password')
    } catch (e: any) { if (e?.status === 410) setDead(true); else { setErr(e.message); setCode('') } } finally { setBusy(false) }
  }

  // The same rules the server applies, so the button only lights when it will work.
  const emailName = (info?.email ?? '').split('@')[0].replace(/•/g, '').toLowerCase()
  const rules = useMemo(() => ({
    length: pw.length >= 10,
    notEmail: !(emailName.length >= 4 && pw.toLowerCase().includes(emailName)),
    match: pw.length > 0 && pw === pw2,
  }), [pw, pw2, emailName])
  const ready = rules.length && rules.notEmail && rules.match

  async function finish(e: React.FormEvent) {
    e.preventDefault(); setErr(''); setBusy(true)
    try {
      const r = await post('/onboarding/complete', { setupToken, password: pw, ...(kind === 'welcome' ? { displayName: name.trim() || null } : {}), ...(info?.founder && org.trim().length >= 2 ? { accountName: org.trim() } : {}) })
      forgetToken(kind)
      const email = r.account?.email ?? ''
      if ('challenge' in r) onMfaStep(r as MfaStep, email, r.next)
      else onSession(r as Session, r.next)
    } catch (e: any) {
      if (e?.status === 410) setDead(true)
      else if (e?.status === 401) { setErr('That took longer than 15 minutes. Send a new code to continue.'); setPhase('intro') }
      else setErr(e.message)
    } finally { setBusy(false) }
  }

  const title = kind === 'welcome' ? (info ? (info.founder ? 'Set up your account' : `Join ${info.accountName}`) : 'Set up your account') : 'Reset your password'

  if (dead) {
    return (
      <Shell title={kind === 'welcome' ? 'This invitation link no longer works' : 'This reset link no longer works'}>
        <p className="hintxt" style={{ margin: '0 0 14px', lineHeight: 1.55 }}>
          {kind === 'welcome'
            ? 'Invitation links work once and expire after a few days. Ask the person who invited you to send a new one. If you already finished setting up, just sign in.'
            : 'Reset links work once and expire after an hour. Ask for a new one below.'}
        </p>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button type="button" className="btn ghost" onClick={onSignIn}>Go to sign in</button>
          <div style={{ flex: 1 }} />
          <a className="btn primary" href="/forgot-password">{kind === 'welcome' ? 'Forgot password' : 'Send a new link'}</a>
        </div>
      </Shell>
    )
  }

  if (!info) return <Shell title={title}>{err ? <Notice kind="error" variant="compact" message={err} /> : <div className="loading">Checking your link…</div>}</Shell>

  return (
    <Shell title={title} sub={info.email}>
      <Steps at={phase === 'password' ? 2 : 1} />

      {phase === 'intro' && (
        <>
          <p style={{ margin: '0 0 8px', lineHeight: 1.55 }}>
            {kind === 'welcome'
              ? info.invitedBy ? <><b>{info.invitedBy}</b> invited you to <b>{info.accountName}</b> on Volt Streaming.</> : <>Your Volt Streaming account for <b>{info.accountName}</b> is ready.</>
              : <>Choose a new password for <b>{info.email}</b>.</>}
          </p>
          <p className="hintxt" style={{ margin: '0 0 14px', lineHeight: 1.55 }}>
            First we email a 6-digit code to <b>{info.email}</b> to confirm it is you. {kind === 'reset' && 'Your current password keeps working until you set a new one.'}
          </p>
          {err && <div style={{ marginBottom: 10 }}><Notice kind="error" variant="compact" message={err} /></div>}
          <button type="button" className="btn primary" style={{ width: '100%', justifyContent: 'center' }} disabled={busy} onClick={sendCode}>
            {busy ? 'Sending…' : 'Email me a code'}
          </button>
        </>
      )}

      {phase === 'code' && (
        <form onSubmit={verify}>
          <p className="hintxt" style={{ margin: '0 0 10px' }}>We sent a code to <b>{sentTo}</b>. It expires in 10 minutes. Check your junk folder if it has not arrived.</p>
          {devCode && <div className="hintxt" style={{ marginBottom: 6 }}>Test server: the code is <b style={{ fontFamily: 'var(--mono, ui-monospace, monospace)' }}>{devCode}</b>.</div>}
          <CodeField value={code} onChange={setCode} autoFocus />
          {err && <div style={{ marginBottom: 10 }}><Notice kind="error" variant="compact" message={err} /></div>}
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <button type="button" className="btn ghost" disabled={busy || cooldown > 0} onClick={sendCode}>{cooldown > 0 ? `Send again in ${cooldown}s` : 'Send again'}</button>
            <div style={{ flex: 1 }} />
            <button className="btn primary" disabled={busy || code.length !== 6}>{busy ? 'Checking…' : 'Continue'}</button>
          </div>
        </form>
      )}

      {phase === 'password' && (
        <form onSubmit={finish}>
          {/* a hidden username field lets a password manager save the pair */}
          <input type="text" name="username" autoComplete="username" value={info.email} readOnly hidden />
          {kind === 'welcome' && info.founder && (
            <div className="field"><label htmlFor="onb-org">Organisation name</label>
              <input id="onb-org" className="inp" autoComplete="organization" value={org} onChange={e => setOrg(e.target.value)} />
              <div className="hintxt" style={{ marginTop: 4 }}>Your client account in Volt. Everyone you invite joins it. You can change it later in Account settings.</div></div>
          )}
          {kind === 'welcome' && (
            <div className="field"><label htmlFor="onb-name">Your name</label>
              <input id="onb-name" className="inp" autoComplete="name" value={name} onChange={e => setName(e.target.value)} placeholder="As your colleagues know you" /></div>
          )}
          <div className="field"><label htmlFor="onb-pw">{kind === 'welcome' ? 'Password' : 'New password'}</label>
            <div style={{ position: 'relative' }}>
              <input id="onb-pw" className="inp" type={show ? 'text' : 'password'} autoComplete="new-password" autoFocus value={pw} onChange={e => setPw(e.target.value)} style={{ paddingRight: 36 }} />
              <button type="button" className="xbtn" aria-label={show ? 'Hide password' : 'Show password'} onClick={() => setShow(s => !s)}
                style={{ position: 'absolute', right: 6, top: '50%', transform: 'translateY(-50%)', background: 'none', border: 0, color: 'var(--muted)', cursor: 'pointer', padding: 4, display: 'flex' }}>{show ? EYE_OFF : EYE}</button>
            </div>
          </div>
          <div className="field"><label htmlFor="onb-pw2">Type it again</label>
            <input id="onb-pw2" className="inp" type={show ? 'text' : 'password'} autoComplete="new-password" value={pw2} onChange={e => setPw2(e.target.value)} /></div>
          <div style={{ display: 'grid', gap: 3, margin: '-2px 0 12px' }}>
            <Rule ok={rules.length}>At least 10 characters</Rule>
            <Rule ok={rules.notEmail}>Not your email address</Rule>
            <Rule ok={rules.match}>Both entries match</Rule>
          </div>
          {err && <div style={{ marginBottom: 10 }}><Notice kind="error" variant="compact" message={err} /></div>}
          <button className="btn primary" style={{ width: '100%', justifyContent: 'center' }} disabled={busy || !ready}>
            {busy ? 'Saving…' : kind === 'welcome' ? (info.founder ? 'Create account and sign in' : 'Finish and sign in') : 'Set password and sign in'}
          </button>
          <div className="hintxt" style={{ marginTop: 10 }}>A long phrase is easier to remember and harder to guess than a short mix of symbols. Signing in ends any other sessions.</div>
        </form>
      )}
    </Shell>
  )
}

function ForgotPassword({ onSignIn }: { onSignIn: () => void }) {
  const [email, setEmail] = useState('')
  const [done, setDone] = useState<string | null>(null)
  const [dev, setDev] = useState<string | undefined>()
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  async function submit(e: React.FormEvent) {
    e.preventDefault(); setErr(''); setBusy(true)
    try { const r = await post('/onboarding/forgot', { email: email.trim() }); setDone(r.message); setDev(r.devLink) }
    catch (e: any) { setErr(e.message) } finally { setBusy(false) }
  }
  return (
    <Shell title="Forgot your password?">
      {done ? (
        <>
          <p style={{ margin: '0 0 8px', lineHeight: 1.55 }}>{done}</p>
          <p className="hintxt" style={{ margin: '0 0 14px', lineHeight: 1.55 }}>The link works for an hour. If nothing arrives in a few minutes, check your junk folder or ask your administrator.</p>
          {dev && <div className="hintxt" style={{ marginBottom: 10, wordBreak: 'break-all' }}>Test server: <a href={dev}>open the link</a>.</div>}
          <button type="button" className="btn ghost" onClick={onSignIn}>Back to sign in</button>
        </>
      ) : (
        <form onSubmit={submit}>
          <p className="hintxt" style={{ margin: '0 0 12px', lineHeight: 1.55 }}>Enter the email you sign in with. We will send you a link to choose a new password.</p>
          <div className="field"><label htmlFor="fp-email">Email</label>
            <input id="fp-email" className="inp" type="email" autoComplete="username" autoCapitalize="none" spellCheck={false} autoFocus value={email} onChange={e => setEmail(e.target.value)} /></div>
          {err && <div style={{ marginBottom: 10 }}><Notice kind="error" variant="compact" message={err} /></div>}
          <div style={{ display: 'flex', gap: 8 }}>
            <button type="button" className="btn ghost" onClick={onSignIn}>Back</button>
            <div style={{ flex: 1 }} />
            <button className="btn primary" disabled={busy || !/^\S+@\S+\.\S+$/.test(email.trim())}>{busy ? 'Sending…' : 'Send reset link'}</button>
          </div>
        </form>
      )}
    </Shell>
  )
}

const BOLT = <svg viewBox="0 0 24 24" fill="currentColor"><path d="M14 1 3.5 14H11zM10 23 20.5 10H13z" /></svg>

function Shell({ title, sub, children }: { title: string; sub?: string; children: ReactNode }) {
  return (
    <div className="card" style={{ width: 400, maxWidth: 'calc(100vw - 32px)', padding: 28 }}>
      <div className="brand" style={{ padding: '0 0 14px' }}>
        <div className="logo">{BOLT}</div>
        <div><div className="n">Volt Streaming</div><div className="s">{sub ?? 'Live streaming platform'}</div></div>
      </div>
      <h1 style={{ fontSize: 'var(--fs-h2, 17px)', margin: '0 0 12px', fontWeight: 700 }}>{title}</h1>
      {children}
    </div>
  )
}
