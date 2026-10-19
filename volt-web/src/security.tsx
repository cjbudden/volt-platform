/**
 * SIGN-IN SECURITY in the console (ACCESS_CONTROL.md section 12):
 *
 *   <SignInSecondStep>   after the password, when the account asks for a code
 *   <MfaSetup>           set up one method: authenticator app, email codes,
 *                        text-message codes. Used from My account (with the
 *                        password) and during sign-in when the account requires
 *                        two-step sign-in and the person has none yet (with the
 *                        challenge).
 *   <BackupCodes>        shown once, with copy and download
 *   <QrCode>             drawn here from the otpauth URI (qr.ts), so the seed
 *                        never leaves this page as an image
 *
 * Every rule is enforced by the API; these screens only walk people through it.
 */
import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { api, type MfaMethod, type MfaStep, type Session } from './api'
import { qrMatrix } from './qr'
import { Notice } from './notices'

/* ---- icons: each method has one, used beside its name ---------------------------- */
const ic = (d: ReactNode) => <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{d}</svg>
export const METHOD_ICON: Record<MfaMethod, ReactNode> = {
  totp: ic(<><rect x="6" y="2" width="12" height="20" rx="2.5" /><path d="M12 7v5l3 2" /></>),
  email: ic(<><rect x="3" y="5" width="18" height="14" rx="2" /><path d="m3 7 9 6 9-6" /></>),
  sms: ic(<><path d="M21 12a8 8 0 0 1-11.6 7.2L4 21l1.8-5.4A8 8 0 1 1 21 12z" /><path d="M8.5 12h.01M12 12h.01M15.5 12h.01" /></>),
  backup: ic(<><rect x="4" y="10" width="16" height="11" rx="2" /><path d="M8 10V7a4 4 0 0 1 8 0v3" /></>),
}
export const METHOD_LABEL: Record<MfaMethod, string> = {
  totp: 'Authenticator app', email: 'Code by email', sms: 'Code by text message', backup: 'Backup code',
}
const METHOD_HINT: Record<MfaMethod, string> = {
  totp: 'Google Authenticator, Microsoft Authenticator, 1Password and similar. Works offline. The most secure choice.',
  email: 'A 6-digit code is sent to your email address each time you sign in.',
  sms: 'A 6-digit code is texted to your mobile each time you sign in.',
  backup: 'One-time codes for when you cannot use your usual method.',
}

/* ---- QR code ------------------------------------------------------------------------- */
export function QrCode({ text, size = 176 }: { text: string; size?: number }) {
  const path = useMemo(() => {
    let m: boolean[][]
    try { m = qrMatrix(text, 'M') } catch { m = qrMatrix(text, 'L') }
    let d = ''
    m.forEach((row, r) => row.forEach((on, c) => { if (on) d += `M${c + 4} ${r + 4}h1v1h-1z` }))
    return { d, n: m.length + 8 }
  }, [text])
  return (
    <svg width={size} height={size} viewBox={`0 0 ${path.n} ${path.n}`} shapeRendering="crispEdges" role="img" aria-label="QR code for your authenticator app"
      style={{ borderRadius: 8, background: '#fff', display: 'block' }}>
      <path d={path.d} fill="#111" />
    </svg>
  )
}

/* ---- a 6-digit code field --------------------------------------------------------------- */
export function CodeField({ value, onChange, autoFocus, label = '6-digit code', backup }: {
  value: string; onChange: (v: string) => void; autoFocus?: boolean; label?: string; backup?: boolean
}) {
  return (
    <div className="field">
      <label htmlFor="sec-code">{label}</label>
      <input id="sec-code" className="inp" autoFocus={autoFocus} value={value}
        inputMode={backup ? 'text' : 'numeric'} autoComplete="one-time-code" spellCheck={false}
        maxLength={backup ? 12 : 6} placeholder={backup ? 'xxxx-xxxx' : '123456'}
        style={{ fontFamily: 'var(--mono, ui-monospace, monospace)', letterSpacing: backup ? 1 : 6, fontSize: 18, maxWidth: 260 }}
        onChange={e => onChange(backup ? e.target.value.trim() : e.target.value.replace(/\D/g, ''))} />
    </div>
  )
}

/** In development the API can echo codes (SECURITY_CODE_ECHO=1). Shown so a tester is not stuck without SMTP. */
function DevCode({ code }: { code?: string }) {
  if (!code) return null
  return <div className="hintxt" style={{ marginTop: 6 }}>Test server: the code is <b style={{ fontFamily: 'ui-monospace, monospace' }}>{code}</b> (shown only when SECURITY_CODE_ECHO is on outside production).</div>
}

/* ---- backup codes --------------------------------------------------------------------------- */
export function BackupCodes({ codes, onDone }: { codes: string[]; onDone: () => void }) {
  const [copied, setCopied] = useState(false)
  const text = `Volt backup codes (each works once)\n\n${codes.join('\n')}\n`
  return (
    <div>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', fontWeight: 700, marginBottom: 4 }}>{METHOD_ICON.backup}Save your backup codes</div>
      <div className="hintxt" style={{ marginBottom: 10 }}>
        If you lose your phone or cannot get a code, each of these signs you in once. They are shown only now. Keep them somewhere safe, such as a password manager.
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 6, padding: 12, border: '1px solid var(--border)', borderRadius: 8, fontFamily: 'ui-monospace, monospace', fontSize: 15 }}>
        {codes.map(c => <div key={c}>{c}</div>)}
      </div>
      <div style={{ display: 'flex', gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
        <button type="button" className="btn ghost" onClick={() => { navigator.clipboard?.writeText(text).then(() => setCopied(true)).catch(() => {}) }}>{copied ? 'Copied' : 'Copy'}</button>
        <a className="btn ghost" download="volt-backup-codes.txt" href={`data:text/plain;charset=utf-8,${encodeURIComponent(text)}`}>Download</a>
        <div style={{ flex: 1 }} />
        <button type="button" className="btn primary" onClick={onDone}>I have saved them</button>
      </div>
    </div>
  )
}

/* ---- set up one method -------------------------------------------------------------------------- */
type SetupResult = { methods: MfaMethod[]; backupCodes?: string[]; session?: Session }

export function MfaSetup({ method, password, challenge, emailHint, onCancel, onDone }: {
  method: 'totp' | 'email' | 'sms'
  /** signed in: the current password (asked for by the caller) */
  password?: string
  /** during sign-in: the setup challenge */
  challenge?: string
  emailHint?: string | null
  onCancel: () => void
  onDone: (r: SetupResult) => void
}) {
  const [phase, setPhase] = useState<'intro' | 'code'>(method === 'totp' ? 'code' : 'intro')
  const [totp, setTotp] = useState<{ secret: string; otpauthUri: string } | null>(null)
  const [phone, setPhone] = useState('+')
  const [sentTo, setSentTo] = useState('')
  const [devCode, setDevCode] = useState<string | undefined>()
  const [code, setCode] = useState('')
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  const auth = challenge ? { challenge } : { password }

  // The authenticator secret is created as soon as this opens.
  useEffect(() => {
    if (method !== 'totp') return
    api.mfaStart('totp', auth).then(r => setTotp({ secret: r.secret!, otpauthUri: r.otpauthUri! })).catch(e => setErr(e.message))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  async function send() {
    setErr(''); setBusy(true)
    try {
      const r = await api.mfaStart(method, { ...auth, ...(method === 'sms' ? { phone: phone.replace(/[\s()-]/g, '') } : {}) })
      setSentTo(r.sentTo ?? ''); setDevCode(r.devCode); setPhase('code')
    } catch (e: any) { setErr(e.message) } finally { setBusy(false) }
  }
  async function confirm(e?: React.FormEvent) {
    e?.preventDefault(); setErr(''); setBusy(true)
    try {
      const r = await api.mfaConfirm(method, { code, ...(challenge ? { challenge } : {}) })
      onDone({ methods: r.methods, backupCodes: r.backupCodes, session: r.access ? { access: r.access, refresh: r.refresh, expiresIn: r.expiresIn } : undefined })
    } catch (e: any) { setErr(e.message); setCode('') } finally { setBusy(false) }
  }

  return (
    <form onSubmit={confirm}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', fontWeight: 700, marginBottom: 6 }}>{METHOD_ICON[method]}{METHOD_LABEL[method]}</div>
      {method === 'totp' && (
        totp ? (
          <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', alignItems: 'flex-start', marginBottom: 10 }}>
            <QrCode text={totp.otpauthUri} />
            <div style={{ flex: 1, minWidth: 200 }}>
              <div className="hintxt">1. Open your authenticator app and scan this code.</div>
              <div className="hintxt" style={{ marginTop: 6 }}>Cannot scan? Enter this key instead:</div>
              <div style={{ fontFamily: 'ui-monospace, monospace', fontSize: 13, wordBreak: 'break-all', margin: '4px 0 8px', userSelect: 'all' }}>{totp.secret.replace(/(.{4})/g, '$1 ').trim()}</div>
              <div className="hintxt">2. Enter the 6-digit code the app shows.</div>
            </div>
          </div>
        ) : !err && <div className="loading">Preparing…</div>
      )}
      {method === 'email' && phase === 'intro' && (
        <div className="hintxt" style={{ marginBottom: 10 }}>We will send a code to {emailHint ?? 'your email address'} to check it reaches you.</div>
      )}
      {method === 'sms' && phase === 'intro' && (
        <div className="field">
          <label htmlFor="sec-phone">Mobile number, international format</label>
          <input id="sec-phone" className="inp" type="tel" autoComplete="tel" value={phone} placeholder="+61412345678" onChange={e => setPhone(e.target.value)} />
          <div className="hintxt" style={{ marginTop: 4 }}>Start with + and the country code. Standard text message rates may apply.</div>
        </div>
      )}
      {phase === 'code' && method !== 'totp' && <div className="hintxt" style={{ marginBottom: 8 }}>We sent a code to {sentTo}. It expires in 10 minutes.</div>}
      <DevCode code={devCode} />
      {(phase === 'code') && <CodeField value={code} onChange={setCode} autoFocus />}
      {err && <Notice kind="error" variant="compact" message={err} />}
      <div style={{ display: 'flex', gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
        <button type="button" className="btn ghost" onClick={onCancel}>Cancel</button>
        <div style={{ flex: 1 }} />
        {phase === 'code' && method !== 'totp' && <button type="button" className="btn ghost" disabled={busy} onClick={send}>Send again</button>}
        {phase === 'intro'
          ? <button type="button" className="btn primary" disabled={busy || (method === 'sms' && phone.replace(/\D/g, '').length < 7)} onClick={send}>{busy ? 'Sending…' : 'Send code'}</button>
          : <button className="btn primary" disabled={busy || code.length !== 6}>{busy ? 'Checking…' : 'Turn on'}</button>}
      </div>
    </form>
  )
}

/* ---- method picker ------------------------------------------------------------------------------------ */
export function MethodChoice({ methods, onPick, current }: { methods: MfaMethod[]; onPick: (m: MfaMethod) => void; current?: MfaMethod }) {
  return (
    <div style={{ display: 'grid', gap: 6 }}>
      {methods.map(m => (
        <button key={m} type="button" className={`btn ${current === m ? 'primary' : 'ghost'}`}
          style={{ justifyContent: 'flex-start', gap: 10, textAlign: 'left', padding: '10px 12px', height: 'auto' }} onClick={() => onPick(m)}>
          {METHOD_ICON[m]}
          <span><span style={{ fontWeight: 600 }}>{METHOD_LABEL[m]}</span><br /><span style={{ fontSize: 'var(--fs-sm)', opacity: 0.75, fontWeight: 400 }}>{METHOD_HINT[m]}</span></span>
        </button>
      ))}
    </div>
  )
}

/* ---- the second step of sign-in ---------------------------------------------------------------------------- */
export function SignInSecondStep({ step, onSession, onCancel }: { step: MfaStep; onSession: (s: Session) => void; onCancel: () => void }) {
  if (step.mfaSetupRequired) return <SetupDuringSignIn step={step} onSession={onSession} onCancel={onCancel} />
  return <VerifyDuringSignIn step={step} onSession={onSession} onCancel={onCancel} />
}

function VerifyDuringSignIn({ step, onSession, onCancel }: { step: MfaStep; onSession: (s: Session) => void; onCancel: () => void }) {
  const methods = step.methods ?? []
  const [method, setMethod] = useState<MfaMethod>(methods.includes('totp') ? 'totp' : methods[0])
  const [code, setCode] = useState('')
  const [sent, setSent] = useState<{ to: string; dev?: string } | null>(null)
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  const needsSend = method === 'email' || method === 'sms'

  async function send(m: 'email' | 'sms') {
    setErr(''); setBusy(true)
    try { const r = await api.mfaSend(step.challenge, m); setSent({ to: r.sentTo ?? '', dev: r.devCode }) }
    catch (e: any) { setErr(e.message) } finally { setBusy(false) }
  }
  function pick(m: MfaMethod) {
    setMethod(m); setCode(''); setSent(null); setErr('')
    if (m === 'email' || m === 'sms') void send(m)
  }
  // An emailed or texted code is sent straight away when that is the only method.
  useEffect(() => { if (needsSend && !sent) void send(method as 'email' | 'sms') /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [])

  async function verify(e: React.FormEvent) {
    e.preventDefault(); setErr(''); setBusy(true)
    try { onSession(await api.mfaVerify(step.challenge, method, code)) }
    catch (e: any) { setErr(e.message); setCode('') } finally { setBusy(false) }
  }
  const others = methods.filter(m => m !== method)
  return (
    <form onSubmit={verify}>
      <div style={{ fontWeight: 700, marginBottom: 4 }}>Two-step sign-in</div>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 8, color: 'var(--muted)' }}>
        {METHOD_ICON[method]}
        <span style={{ fontSize: 'var(--fs-sm)' }}>
          {method === 'totp' ? 'Enter the code from your authenticator app.'
            : method === 'backup' ? 'Enter one of your backup codes. Each works once.'
            : sent ? `We sent a code to ${sent.to}.` : 'Sending a code…'}
        </span>
      </div>
      <DevCode code={sent?.dev} />
      <CodeField value={code} onChange={setCode} autoFocus backup={method === 'backup'} label={method === 'backup' ? 'Backup code' : '6-digit code'} />
      {err && <Notice kind="error" variant="compact" message={err} />}
      <button className="btn primary" style={{ width: '100%', justifyContent: 'center', marginTop: 6 }}
        disabled={busy || (method === 'backup' ? code.replace(/[^a-z0-9]/gi, '').length < 8 : code.length !== 6)}>{busy ? 'Checking…' : 'Verify'}</button>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 12, fontSize: 'var(--fs-sm)' }}>
        {needsSend && <button type="button" className="btn ghost" disabled={busy} onClick={() => send(method as 'email' | 'sms')}>Send a new code</button>}
        {others.map(m => (
          <button key={m} type="button" className="btn ghost" onClick={() => pick(m)} style={{ gap: 6 }}>{METHOD_ICON[m]}Use {METHOD_LABEL[m].toLowerCase()}</button>
        ))}
        <div style={{ flex: 1 }} />
        <button type="button" className="btn ghost" onClick={onCancel}>Back</button>
      </div>
      {!others.includes('backup') && method !== 'backup' && (
        <div className="hintxt" style={{ marginTop: 10 }}>Lost access to your codes? Ask an administrator to reset your two-step sign-in.</div>
      )}
    </form>
  )
}

function SetupDuringSignIn({ step, onSession, onCancel }: { step: MfaStep; onSession: (s: Session) => void; onCancel: () => void }) {
  const [method, setMethod] = useState<'totp' | 'email' | 'sms' | null>(null)
  const [codes, setCodes] = useState<{ codes: string[]; session: Session } | null>(null)
  if (codes) return <BackupCodes codes={codes.codes} onDone={() => onSession(codes.session)} />
  return (
    <div>
      <div style={{ fontWeight: 700, marginBottom: 4 }}>Set up two-step sign-in</div>
      <div className="hintxt" style={{ marginBottom: 12 }}>Your organisation requires a second step when you sign in. Choose how you want to get your codes. You can add more methods later in My account.</div>
      {method
        ? <MfaSetup method={method} challenge={step.challenge} emailHint={step.email} onCancel={() => setMethod(null)}
            onDone={r => { if (r.session) { if (r.backupCodes?.length) setCodes({ codes: r.backupCodes, session: r.session }); else onSession(r.session) } }} />
        : <>
            <MethodChoice methods={(step.available ?? ['totp']).filter((m): m is 'totp' | 'email' | 'sms' => m !== 'backup')} onPick={m => setMethod(m as any)} />
            <button type="button" className="btn ghost" style={{ marginTop: 12 }} onClick={onCancel}>Back</button>
          </>}
    </div>
  )
}
