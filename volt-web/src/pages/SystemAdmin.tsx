import { useEffect, useMemo, useState } from 'react'
import { api, type PlatformAccountRow } from '../api'
import { PageHead, NewButton, FChip, EntityCell, StatusTag, SEC } from '../scaffold'

/* ============================================================================
   System Admin — SaaS-provider controls, visible ONLY to platform staff
   (users with a platform_role). Create client accounts (the account + its
   primary owner user in one step, credentials shown once), set plan and
   quotas, suspend or reactivate a tenant.
   ========================================================================== */

const fmtDate = (iso?: string | null) => (iso ? new Date(iso).toLocaleDateString([], { day: '2-digit', month: 'short', year: 'numeric' }) : '—')

function genPassword(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789'
  const buf = new Uint32Array(14)
  crypto.getRandomValues(buf)
  return Array.from(buf, n => chars[n % chars.length]).join('')
}

export default function SystemAdmin() {
  const [rows, setRows] = useState<PlatformAccountRow[] | null>(null)
  const [err, setErr] = useState('')
  const [denied, setDenied] = useState(false)
  const [filter, setFilter] = useState<'all' | 'active' | 'suspended'>('all')
  const [createOpen, setCreateOpen] = useState(false)
  const [editing, setEditing] = useState<PlatformAccountRow | null>(null)
  const [creds, setCreds] = useState<{ account: string; email: string; password: string } | null>(null)

  async function load() {
    try { setRows(await api.platformAccounts()); setDenied(false) }
    catch (e: any) {
      if (/403|platform access/i.test(String(e.message))) setDenied(true)
      else setErr(e.message)
    }
  }
  useEffect(() => { load() }, [])

  const counts = useMemo(() => {
    const c = rows || []
    return { all: c.length, active: c.filter(r => r.status !== 'suspended').length, suspended: c.filter(r => r.status === 'suspended').length }
  }, [rows])
  const shown = useMemo(() => {
    if (!rows) return []
    if (filter === 'all') return rows
    return rows.filter(r => (filter === 'suspended' ? r.status === 'suspended' : r.status !== 'suspended'))
  }, [rows, filter])

  if (denied) {
    return (
      <>
        <PageHead title="System Admin" sub="SaaS-provider controls for client accounts." />
        <div className="empty">
          <div className="ic"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="11" width="18" height="11" rx="2" /><path d="M7 11V7a5 5 0 0110 0v4" /></svg></div>
          <h3>Platform access required</h3>
          <p>This area is only available to VOLT platform staff (system admin users). Your sign-in does not carry a platform role.</p>
        </div>
      </>
    )
  }

  return (
    <>
      <PageHead title="System Admin" sub="Client accounts across the whole platform: create accounts with their primary admin user, set plans and quotas, suspend access."
        action={<NewButton label="New client account" onClick={() => setCreateOpen(true)} />} />
      {err && <div className="err">{err}</div>}
      {rows === null ? (
        <div className="loading">Loading accounts…</div>
      ) : (
        <>
          <div className="filters">
            <FChip label="All" n={counts.all} on={filter === 'all'} onClick={() => setFilter('all')} />
            <FChip label="Active" n={counts.active} on={filter === 'active'} onClick={() => setFilter('active')} />
            <FChip label="Suspended" n={counts.suspended} on={filter === 'suspended'} onClick={() => setFilter('suspended')} />
          </div>
          <div className="card">
            <table>
              <thead><tr><th>Account</th><th>Plan</th><th>Channels</th><th>Users</th><th>Quotas</th><th>Status</th><th></th></tr></thead>
              <tbody>
                {shown.map((a, i) => (
                  <tr key={a.id} onClick={() => setEditing(a)} style={{ cursor: 'pointer' }}>
                    <td><EntityCell name={a.name} sub={fmtDate(a.created_at)} index={i} /></td>
                    <td><span className="tag type chan" style={{ textTransform: 'capitalize' }}>{a.plan_tier}</span></td>
                    <td style={{ color: 'var(--muted)' }}>{a.channels ?? '—'}</td>
                    <td style={{ color: 'var(--muted)' }}>{a.users ?? '—'}</td>
                    <td style={{ color: 'var(--muted)', fontSize: 12 }}>{a.max_channels} ch · {a.max_concurrent_sources ?? '—'} src</td>
                    <td>{a.status === 'suspended' ? <StatusTag label="Suspended" cls="down" /> : <StatusTag label="Active" cls="live" />}</td>
                    <td style={{ textAlign: 'right' }} onClick={e => e.stopPropagation()}>
                      <button className="btn primary" onClick={() => setEditing(a)}>Open</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      {createOpen && <AccountDrawer onClose={() => setCreateOpen(false)}
        onDone={(c) => { setCreateOpen(false); if (c) setCreds(c); load() }} />}
      {editing && <AccountDrawer account={editing} onClose={() => setEditing(null)}
        onDone={() => { setEditing(null); load() }} />}
      {creds && <CredsOnceModal creds={creds} onClose={() => setCreds(null)} />}
    </>
  )
}

/* --------------------------------------------- credentials shown once modal */
function CredsOnceModal({ creds, onClose }: { creds: { account: string; email: string; password: string }; onClose: () => void }) {
  const [copied, setCopied] = useState(false)
  const text = `VOLT Stream account: ${creds.account}\nSign-in email: ${creds.email}\nTemporary password: ${creds.password}`
  return (
    <div className="drawer-scrim" onClick={onClose} style={{ display: 'grid', placeItems: 'center' }}>
      <div className="card" onClick={e => e.stopPropagation()} style={{ width: 520, padding: 22 }}>
        <div style={{ fontWeight: 700, fontSize: 16 }}>Client account created</div>
        <div style={{ fontSize: 12.5, color: 'var(--warn,#fbbf24)', margin: '8px 0 12px' }}>
          Share these sign-in details with the client now. The password is not retrievable later.
        </div>
        <div className="field"><label>Account</label><input className="inp" readOnly value={creds.account} /></div>
        <div className="field"><label>Primary admin (owner) email</label><input className="inp" readOnly value={creds.email} /></div>
        <div className="field"><label>Temporary password</label>
          <input className="inp" readOnly value={creds.password} style={{ fontFamily: 'ui-monospace,monospace' }} onFocus={e => e.currentTarget.select()} />
        </div>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 8 }}>
          <button className="btn ghost" onClick={async () => { try { await navigator.clipboard.writeText(text) } catch {} setCopied(true); setTimeout(() => setCopied(false), 1500) }}>
            {copied ? 'Copied ✓' : 'Copy all'}
          </button>
          <button className="btn primary" onClick={onClose}>Done, I saved it</button>
        </div>
      </div>
    </div>
  )
}

/* --------------------------------------------- account create / manage drawer */
function AccountDrawer({ account, onClose, onDone }: {
  account?: PlatformAccountRow; onClose: () => void
  onDone: (creds?: { account: string; email: string; password: string }) => void
}) {
  const isEdit = !!account
  const [name, setName] = useState(account?.name ?? '')
  const [plan, setPlan] = useState<'standard' | 'pro' | 'enterprise'>((account?.plan_tier as any) || 'standard')
  const [maxCh, setMaxCh] = useState(String(account?.max_channels ?? 5))
  const [maxSrc, setMaxSrc] = useState(String(account?.max_concurrent_sources ?? 3))
  const [ownerEmail, setOwnerEmail] = useState('')
  const [ownerPassword, setOwnerPassword] = useState(genPassword())
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const suspended = account?.status === 'suspended'

  async function submit() {
    setErr('')
    if (!name.trim()) { setErr('Give the account a name'); return }
    setBusy(true)
    try {
      if (isEdit) {
        await api.platformPatchAccount(account!.id, {
          name: name.trim(), planTier: plan,
          maxChannels: Number(maxCh) || undefined, maxConcurrentSources: Number(maxSrc) || undefined,
        })
        onDone()
      } else {
        if (!ownerEmail.trim()) { setErr('Enter the primary admin email'); setBusy(false); return }
        if (ownerPassword.length < 8) { setErr('Password must be at least 8 characters'); setBusy(false); return }
        const r = await api.platformCreateAccount({
          name: name.trim(), planTier: plan,
          maxChannels: Number(maxCh) || undefined, maxConcurrentSources: Number(maxSrc) || undefined,
          ownerEmail: ownerEmail.trim(), ownerPassword,
        })
        onDone({ account: r.account.name, email: r.credentials.email, password: r.credentials.password })
      }
    } catch (e: any) { setErr(e.message); setBusy(false) }
  }

  async function setSuspended(next: boolean) {
    if (!account) return
    const msg = next
      ? `Suspend "${account.name}"? All of the account's users are signed out, sign-in is blocked, and its API keys stop working.`
      : `Reactivate "${account.name}"? Users can sign in and API keys work again.`
    if (!window.confirm(msg)) return
    setBusy(true); setErr('')
    try { await api.platformPatchAccount(account.id, { status: next ? 'suspended' : 'active' }); onDone() }
    catch (e: any) { setErr(e.message); setBusy(false) }
  }

  return (
    <div className="drawer-scrim" onClick={onClose}>
      <div className="drawer" onClick={e => e.stopPropagation()}>
        <div className="drawer-h"><div className="t">{isEdit ? 'Client account' : 'New client account'}</div><button className="xbtn" onClick={onClose}>✕</button></div>
        <div className="drawer-b">
          <div className="field"><label>Account name</label>
            <input className="inp" value={name} onChange={e => setName(e.target.value)} placeholder="e.g. RTM Broadcasting" />
          </div>

          <div style={SEC}>Plan & quotas</div>
          <div className="field"><label>Plan</label>
            <select className="inp" value={plan} onChange={e => setPlan(e.target.value as any)}>
              <option value="standard">Standard</option>
              <option value="pro">Pro</option>
              <option value="enterprise">Enterprise</option>
            </select>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
            <div className="field"><label>Max channels</label>
              <input className="inp" inputMode="numeric" value={maxCh} onChange={e => setMaxCh(e.target.value.replace(/[^0-9]/g, ''))} />
            </div>
            <div className="field"><label>Max concurrent sources</label>
              <input className="inp" inputMode="numeric" value={maxSrc} onChange={e => setMaxSrc(e.target.value.replace(/[^0-9]/g, ''))} />
            </div>
          </div>

          {!isEdit && (
            <>
              <div style={SEC}>Primary admin user</div>
              <div className="field"><label>Email</label>
                <input className="inp" value={ownerEmail} onChange={e => setOwnerEmail(e.target.value)} placeholder="admin@client.com" />
                <div className="hintxt">Created as the account's OWNER: full access, including managing the client's own users.</div>
              </div>
              <div className="field"><label>Temporary password</label>
                <div style={{ display: 'flex', gap: 8 }}>
                  <input className="inp" value={ownerPassword} onChange={e => setOwnerPassword(e.target.value)} style={{ fontFamily: 'ui-monospace,monospace' }} />
                  <button type="button" className="btn ghost" onClick={() => setOwnerPassword(genPassword())}>Regenerate</button>
                </div>
                <div className="hintxt">Shown once after creation so you can hand it to the client.</div>
              </div>
              <div className="hintxt">The account also gets a Default group and an HD output profile so the client can create channels immediately.</div>
            </>
          )}

          {isEdit && (
            <>
              <div style={SEC}>Access</div>
              <div className="toggle-row">
                <div>
                  <div className="tt">{suspended ? 'Account suspended' : 'Account active'}</div>
                  <div className="td">{suspended
                    ? 'Sign-in is blocked and API keys are rejected. Reactivate to restore access.'
                    : 'Suspending blocks sign-in, revokes sessions, and rejects all of the account\'s API keys.'}</div>
                </div>
                <div className={`sw ${suspended ? 'off' : ''}`} onClick={() => setSuspended(!suspended)}><i /></div>
              </div>
            </>
          )}

          {err && <div className="err">{err}</div>}
        </div>
        <div className="drawer-f">
          <button className="btn ghost" onClick={onClose}>Cancel</button>
          <button className="btn primary" disabled={busy} onClick={submit}>{busy ? 'Saving…' : isEdit ? 'Save changes' : 'Create account'}</button>
        </div>
      </div>
    </div>
  )
}
