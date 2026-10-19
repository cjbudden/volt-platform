/**
 * MY ACCOUNT: every admin user's own profile and sign-in security, whatever
 * their role (it is not part of Users & Roles, which needs the users feature).
 * Opened from the name at the bottom of the menu, or /account.
 *
 *   Profile         display name (shown in the menu and on records you change)
 *   Email           change it (a code goes to the NEW address first), or verify it
 *   Password        change it (other sessions are signed out)
 *   Mobile number   add, change or remove, verified by text message
 *   Two-step        authenticator app, email codes, text codes, backup codes
 */
import { useEffect, useState } from 'react'
import { api, type Me, type SecuritySummary } from '../api'
import { MfaSetup, BackupCodes, CodeField, METHOD_ICON, METHOD_LABEL } from '../security'
import { usePageNotice } from '../notices'

const card: React.CSSProperties = { padding: 18, marginBottom: 14 }
const row: React.CSSProperties = { display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }

function Pill({ on, children }: { on: boolean; children: React.ReactNode }) {
  return <span className={`badge ${on ? 'live' : ''}`} style={{ fontSize: 'var(--fs-label)' }}>{children}</span>
}

/** Asks for the current password before a sensitive change. */
function PasswordAsk({ label, busy, onGo, onCancel }: { label: string; busy?: boolean; onGo: (pw: string) => void; onCancel: () => void }) {
  const [pw, setPw] = useState('')
  return (
    <form onSubmit={e => { e.preventDefault(); if (pw) onGo(pw) }} style={{ ...row, marginTop: 8 }}>
      <input className="inp" type="password" autoComplete="current-password" autoFocus placeholder="Your current password"
        value={pw} onChange={e => setPw(e.target.value)} style={{ flex: 1, minWidth: 200 }} />
      <button className="btn primary" disabled={!pw || busy}>{label}</button>
      <button type="button" className="btn ghost" onClick={onCancel}>Cancel</button>
    </form>
  )
}

export default function Account({ me, onChanged }: { me: Me; onChanged: () => void }) {
  const [sec, setSec] = useState<SecuritySummary | null>(null)
  const [err, setErr] = useState('')
  const load = () => api.security().then(s => { setSec(s); setErr('') }).catch(e => setErr(e.message))
  useEffect(() => { load() }, [])
  usePageNotice('load', err ? { kind: 'error', title: "Couldn't load your sign-in settings.", message: err, actions: [{ label: 'Retry', onClick: () => { load() } }] } : null)
  const refresh = () => { load(); onChanged() }

  return (
    <>
      <div className="page-head"><div><h1>My account</h1><p>Your profile and how you sign in. Only you can change these.</p></div></div>
      <Profile me={me} onChanged={refresh} />
      {sec && <EmailCard sec={sec} onChanged={refresh} />}
      <PasswordCard />
      {sec && <PhoneCard sec={sec} onChanged={refresh} />}
      {sec && <TwoStepCard sec={sec} onChanged={refresh} />}
      <div className="hintxt" style={{ marginTop: 4 }}>
        Your access: {me.roles?.length ? me.roles.map(r => r.name).join(', ') : me.role}. Roles are given by an administrator in Users &amp; Roles.
      </div>
    </>
  )
}

function Profile({ me, onChanged }: { me: Me; onChanged: () => void }) {
  const [name, setName] = useState(me.displayName ?? '')
  const [msg, setMsg] = useState('')
  const dirty = (me.displayName ?? '') !== name.trim()
  async function save() {
    setMsg('')
    try { await api.patchMe({ displayName: name.trim() || null }); setMsg('Saved.'); onChanged() } catch (e: any) { setMsg(e.message) }
  }
  return (
    <div className="card" style={card}>
      <div className="sec-label">Profile</div>
      <div className="field"><label htmlFor="acc-name">Display name</label>
        <div style={row}>
          <input id="acc-name" className="inp" value={name} maxLength={120} placeholder="How your name appears in the console"
            onChange={e => setName(e.target.value)} style={{ flex: 1, minWidth: 220 }} />
          <button className="btn ghost" disabled={!dirty} onClick={save}>Save</button>
        </div>
      </div>
      {msg && <div className="hintxt">{msg}</div>}
    </div>
  )
}

function EmailCard({ sec, onChanged }: { sec: SecuritySummary; onChanged: () => void }) {
  const [mode, setMode] = useState<'idle' | 'change' | 'code' | 'verify'>('idle')
  const [next, setNext] = useState('')
  const [pw, setPw] = useState('')
  const [code, setCode] = useState('')
  const [sent, setSent] = useState<{ to: string; dev?: string } | null>(null)
  const [msg, setMsg] = useState('')
  const [busy, setBusy] = useState(false)
  const reset = () => { setMode('idle'); setNext(''); setPw(''); setCode(''); setSent(null) }

  async function start(e: React.FormEvent) {
    e.preventDefault(); setMsg(''); setBusy(true)
    try { const r = await api.emailChange(next.trim(), pw); setSent({ to: r.sentTo ?? next, dev: r.devCode }); setMode('code') }
    catch (e: any) { setMsg(e.message) } finally { setBusy(false) }
  }
  async function verifyStart() {
    setMsg(''); setBusy(true)
    try { const r = await api.emailVerify(); if (r.alreadyVerified) { onChanged(); return } setSent({ to: r.sentTo ?? '', dev: r.devCode }); setMode('verify') }
    catch (e: any) { setMsg(e.message) } finally { setBusy(false) }
  }
  async function confirm(e: React.FormEvent) {
    e.preventDefault(); setMsg(''); setBusy(true)
    try {
      if (mode === 'code') { const r = await api.emailChangeConfirm(code); setMsg(`Your email is now ${r.email}. Use it to sign in. A notice went to your old address.`) }
      else { await api.emailVerifyConfirm(code); setMsg('Email address verified.') }
      reset(); onChanged()
    } catch (e: any) { setMsg(e.message); setCode('') } finally { setBusy(false) }
  }

  return (
    <div className="card" style={card}>
      <div className="sec-label">Email</div>
      <div style={row}>
        {METHOD_ICON.email}<b>{sec.email}</b>
        <Pill on={sec.emailVerified}>{sec.emailVerified ? 'Verified' : 'Not verified'}</Pill>
        <div style={{ flex: 1 }} />
        {mode === 'idle' && !sec.emailVerified && <button className="btn ghost" disabled={busy} onClick={verifyStart}>Verify</button>}
        {mode === 'idle' && <button className="btn ghost" onClick={() => setMode('change')}>Change email</button>}
      </div>
      {mode === 'change' && (
        <form onSubmit={start} style={{ marginTop: 10 }}>
          <div className="hintxt" style={{ marginBottom: 8 }}>We send a code to the new address. Your email only changes once you enter it, and we tell your old address.</div>
          <div style={row}>
            <input className="inp" type="email" autoComplete="email" placeholder="New email address" value={next} onChange={e => setNext(e.target.value)} style={{ flex: 2, minWidth: 220 }} />
            <input className="inp" type="password" autoComplete="current-password" placeholder="Current password" value={pw} onChange={e => setPw(e.target.value)} style={{ flex: 1, minWidth: 180 }} />
            <button className="btn primary" disabled={busy || !next.includes('@') || !pw}>{busy ? 'Sending…' : 'Send code'}</button>
            <button type="button" className="btn ghost" onClick={reset}>Cancel</button>
          </div>
        </form>
      )}
      {(mode === 'code' || mode === 'verify') && sent && (
        <form onSubmit={confirm} style={{ marginTop: 10, maxWidth: 360 }}>
          <div className="hintxt">We sent a code to {sent.to}. It expires in 10 minutes.</div>
          {sent.dev && <div className="hintxt">Test server code: <b>{sent.dev}</b></div>}
          <CodeField value={code} onChange={setCode} autoFocus />
          <div style={row}>
            <button className="btn primary" disabled={busy || code.length !== 6}>{mode === 'code' ? 'Change email' : 'Verify'}</button>
            <button type="button" className="btn ghost" onClick={reset}>Cancel</button>
          </div>
        </form>
      )}
      {msg && <div className="hintxt" style={{ marginTop: 8 }}>{msg}</div>}
    </div>
  )
}

function PasswordCard() {
  const [cur, setCur] = useState('')
  const [next, setNext] = useState('')
  const [msg, setMsg] = useState('')
  async function change(e: React.FormEvent) {
    e.preventDefault(); setMsg('')
    try { await api.changeMyPassword(cur, next); setCur(''); setNext(''); setMsg('Password changed. Your other sessions have been signed out.') }
    catch (e: any) { setMsg(e.message) }
  }
  return (
    <form className="card" style={card} onSubmit={change}>
      <div className="sec-label">Password</div>
      <div style={row}>
        <input className="inp" type="password" autoComplete="current-password" placeholder="Current password" value={cur} onChange={e => setCur(e.target.value)} style={{ flex: 1, minWidth: 180 }} />
        <input className="inp" type="password" autoComplete="new-password" placeholder="New password (10+ characters)" value={next} onChange={e => setNext(e.target.value)} style={{ flex: 1, minWidth: 180 }} />
        <button className="btn ghost" disabled={!cur || next.length < 10}>Change password</button>
      </div>
      {msg && <div className="hintxt" style={{ marginTop: 8 }}>{msg}</div>}
    </form>
  )
}

function PhoneCard({ sec, onChanged }: { sec: SecuritySummary; onChanged: () => void }) {
  const [mode, setMode] = useState<'idle' | 'add' | 'code' | 'remove'>('idle')
  const [phone, setPhone] = useState('+')
  const [pw, setPw] = useState('')
  const [code, setCode] = useState('')
  const [sent, setSent] = useState<{ to: string; dev?: string } | null>(null)
  const [msg, setMsg] = useState('')
  const [busy, setBusy] = useState(false)
  const reset = () => { setMode('idle'); setPhone('+'); setPw(''); setCode(''); setSent(null) }

  async function send(e: React.FormEvent) {
    e.preventDefault(); setMsg(''); setBusy(true)
    try { const r = await api.phoneSet(phone.replace(/[\s()-]/g, ''), pw); setSent({ to: r.sentTo ?? phone, dev: r.devCode }); setMode('code') }
    catch (e: any) { setMsg(e.message) } finally { setBusy(false) }
  }
  async function confirm(e: React.FormEvent) {
    e.preventDefault(); setMsg(''); setBusy(true)
    try { await api.phoneConfirm(code); setMsg('Mobile number verified.'); reset(); onChanged() }
    catch (e: any) { setMsg(e.message); setCode('') } finally { setBusy(false) }
  }
  async function remove(p: string) {
    setMsg(''); setBusy(true)
    try { await api.phoneRemove(p); setMsg('Mobile number removed.'); reset(); onChanged() }
    catch (e: any) { setMsg(e.message) } finally { setBusy(false) }
  }
  return (
    <div className="card" style={card}>
      <div className="sec-label">Mobile number</div>
      <div style={row}>
        {METHOD_ICON.sms}
        {sec.phone ? <><b>{sec.phone}</b><Pill on={sec.phoneVerified}>{sec.phoneVerified ? 'Verified' : 'Not verified'}</Pill></> : <span className="hintxt">No mobile number. Add one to get sign-in codes by text.</span>}
        <div style={{ flex: 1 }} />
        {mode === 'idle' && <button className="btn ghost" disabled={!sec.smsCodes.available} title={sec.smsCodes.available ? '' : 'Text messages are not set up on this server'} onClick={() => setMode('add')}>{sec.phone ? 'Change' : 'Add number'}</button>}
        {mode === 'idle' && sec.phone && <button className="btn ghost" onClick={() => setMode('remove')}>Remove</button>}
      </div>
      {mode === 'add' && (
        <form onSubmit={send} style={{ ...row, marginTop: 10 }}>
          <input className="inp" type="tel" autoComplete="tel" placeholder="+61412345678" value={phone} onChange={e => setPhone(e.target.value)} style={{ flex: 1, minWidth: 180 }} />
          <input className="inp" type="password" autoComplete="current-password" placeholder="Current password" value={pw} onChange={e => setPw(e.target.value)} style={{ flex: 1, minWidth: 180 }} />
          <button className="btn primary" disabled={busy || phone.replace(/\D/g, '').length < 7 || !pw}>{busy ? 'Sending…' : 'Send code'}</button>
          <button type="button" className="btn ghost" onClick={reset}>Cancel</button>
        </form>
      )}
      {mode === 'code' && sent && (
        <form onSubmit={confirm} style={{ marginTop: 10, maxWidth: 360 }}>
          <div className="hintxt">We texted a code to {sent.to}.</div>
          {sent.dev && <div className="hintxt">Test server code: <b>{sent.dev}</b></div>}
          <CodeField value={code} onChange={setCode} autoFocus />
          <div style={row}><button className="btn primary" disabled={busy || code.length !== 6}>Verify number</button><button type="button" className="btn ghost" onClick={reset}>Cancel</button></div>
        </form>
      )}
      {mode === 'remove' && <PasswordAsk label="Remove number" busy={busy} onGo={remove} onCancel={reset} />}
      {msg && <div className="hintxt" style={{ marginTop: 8 }}>{msg}</div>}
    </div>
  )
}

function TwoStepCard({ sec, onChanged }: { sec: SecuritySummary; onChanged: () => void }) {
  const [setup, setSetup] = useState<{ method: 'totp' | 'email' | 'sms'; password?: string } | null>(null)
  const [ask, setAsk] = useState<{ kind: 'setup' | 'remove' | 'codes'; method?: 'totp' | 'email' | 'sms' } | null>(null)
  const [codes, setCodes] = useState<string[] | null>(null)
  const [msg, setMsg] = useState('')
  const [busy, setBusy] = useState(false)
  const on = { totp: sec.totp.enabled, email: sec.emailCodes.enabled, sms: sec.smsCodes.enabled }
  const available = { totp: true, email: sec.emailCodes.available, sms: sec.smsCodes.available }
  const count = Object.values(on).filter(Boolean).length

  async function withPassword(pw: string) {
    if (!ask) return
    setMsg(''); setBusy(true)
    try {
      if (ask.kind === 'setup') { setSetup({ method: ask.method!, password: pw }); setAsk(null) }
      else if (ask.kind === 'remove') { await api.mfaRemove(ask.method!, pw); setAsk(null); setMsg(`${METHOD_LABEL[ask.method!]} removed.`); onChanged() }
      else { const r = await api.mfaBackupCodes(pw); setAsk(null); setCodes(r.backupCodes) }
    } catch (e: any) { setMsg(e.message) } finally { setBusy(false) }
  }

  if (codes) return <div className="card" style={card}><BackupCodes codes={codes} onDone={() => { setCodes(null); onChanged() }} /></div>
  if (setup) {
    return (
      <div className="card" style={card}>
        <MfaSetup method={setup.method} password={setup.password} emailHint={sec.email} onCancel={() => setSetup(null)}
          onDone={r => { setSetup(null); if (r.backupCodes?.length) setCodes(r.backupCodes); else onChanged(); setMsg(`${METHOD_LABEL[setup.method]} is on.`) }} />
      </div>
    )
  }
  return (
    <div className="card" style={card}>
      <div className="sec-label" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        Two-step sign-in <Pill on={count > 0}>{count > 0 ? 'On' : 'Off'}</Pill>
      </div>
      <div className="hintxt" style={{ marginBottom: 10 }}>
        {sec.required ? 'Your organisation requires a second step when you sign in. Keep at least one method on.' : 'After your password, ask for a code too. This stops someone who learns your password from signing in.'}
      </div>
      <div style={{ display: 'grid', gap: 8 }}>
        {(['totp', 'email', 'sms'] as const).map(m => (
          <div key={m} style={{ ...row, padding: '10px 12px', border: '1px solid var(--border)', borderRadius: 8 }}>
            {METHOD_ICON[m]}<span style={{ fontWeight: 600 }}>{METHOD_LABEL[m]}</span>
            <Pill on={on[m]}>{on[m] ? 'On' : 'Off'}</Pill>
            {m === 'sms' && on.sms && sec.phone && <span className="hintxt">{sec.phone}</span>}
            {!available[m] && <span className="hintxt">Not available on this server</span>}
            <div style={{ flex: 1 }} />
            {on[m]
              ? <button className="btn ghost" onClick={() => setAsk({ kind: 'remove', method: m })}>Remove</button>
              : <button className="btn ghost" disabled={!available[m]} onClick={() => setAsk({ kind: 'setup', method: m })}>Set up</button>}
          </div>
        ))}
        {count > 0 && (
          <div style={{ ...row, padding: '10px 12px', border: '1px solid var(--border)', borderRadius: 8 }}>
            {METHOD_ICON.backup}<span style={{ fontWeight: 600 }}>Backup codes</span>
            <span className="hintxt">{sec.backupCodesRemaining} of 10 left</span>
            <div style={{ flex: 1 }} />
            <button className="btn ghost" onClick={() => setAsk({ kind: 'codes' })}>Make new codes</button>
          </div>
        )}
      </div>
      {ask && (
        <div style={{ marginTop: 10 }}>
          <div className="hintxt">
            {ask.kind === 'setup' ? `Enter your password to set up ${METHOD_LABEL[ask.method!].toLowerCase()}.`
              : ask.kind === 'remove' ? `Enter your password to remove ${METHOD_LABEL[ask.method!].toLowerCase()}.`
              : 'Enter your password. Your old backup codes stop working.'}
          </div>
          <PasswordAsk label={ask.kind === 'setup' ? 'Continue' : ask.kind === 'remove' ? 'Remove' : 'Make new codes'} busy={busy} onGo={withPassword} onCancel={() => setAsk(null)} />
        </div>
      )}
      {msg && <div className="hintxt" style={{ marginTop: 8 }}>{msg}</div>}
    </div>
  )
}
