import { useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { ConfirmDialog } from '../listActions'
import { ROLE_TEMPLATES } from '../roleTemplates'
import {
  api, apiRequest, type Me, type UserRow, type UserGroupRow, type TenantRole, type AccessLevel, type AccessFeature,
  type ViewerRow, type ViewerDetail, type SecurityBrief,
} from '../api'
import { navigate } from '../router'
import { METHOD_ICON, METHOD_LABEL } from '../security'
import { PageHead, NewButton, FChip, EntityCell, StatusTag } from '../scaffold'
import { pressable } from '../a11y'
import { useAccess } from '../access'
import { FormStatus, Notice, useNotify, usePageNotice } from '../notices'

/* ============================================================================
   Users & Roles. Three tabs, each shown only to roles that include it:

     Admin users   (feature `users`)    the account's staff and their roles
     Roles         (feature `access`)   named access sets: a level per feature
     Public users  (feature `viewers`)  the audience: viewer accounts

   The rules are enforced by the API (ACCESS_CONTROL.md). This page mirrors
   them so nobody is offered a change they will be refused:
     - a role can only be given if it is within your own access;
     - a role can only be created or edited with levels you hold;
     - you cannot change users whose access you do not cover, or yourself.
   ========================================================================== */

const LEVELS: AccessLevel[] = ['none', 'view', 'operate', 'manage']
const RANK: Record<AccessLevel, number> = { none: 0, view: 1, operate: 2, manage: 3 }
const TIER_LABEL: Record<string, string> = { owner: 'Owner', admin: 'Admin', operator: 'Operator', viewer: 'Viewer' }
const AREA_LABEL: Record<string, string> = { content: 'Content', insight: 'Insight', admin: 'Administration' }
interface InviteState { sentAt: string; expiresAt: string; expired: boolean; verified: boolean }
const fmtDate = (iso?: string | null) => (iso ? new Date(iso).toLocaleDateString([], { day: '2-digit', month: 'short', year: 'numeric' }) : '—')

/** The access a role gives its members (viewer-tier roles are capped at view). */
function roleGrant(r: UserGroupRow): Record<string, AccessLevel> {
  const cap = r.tier === 'viewer'
  if (r.tier === 'admin' || r.tier === 'owner') return Object.fromEntries(Object.keys(r.permissions).map(k => [k, 'manage' as AccessLevel]))
  return Object.fromEntries(Object.entries(r.permissions).map(([k, v]) => [k, cap && RANK[v] > 1 ? 'view' : v]))
}
/** Features where `want` is above `have`. */
function above(have: Record<string, AccessLevel>, want: Record<string, AccessLevel>): string[] {
  return Object.keys(want).filter(f => RANK[want[f] ?? 'none'] > RANK[have[f] ?? 'none'])
}

export default function Users() {
  const { can, me } = useAccess()
  const tabs = ([['users', 'Admin users'], ['roles', 'Roles'], ['public', 'Public users']] as const)
    .filter(([k]) => can(k === 'users' ? 'users' : k === 'roles' ? 'access' : 'viewers', 'view'))
  const [tab, setTab] = useState<'users' | 'roles' | 'public'>(tabs[0]?.[0] ?? 'users')
  const [users, setUsers] = useState<UserRow[] | null>(null)
  const [roles, setRoles] = useState<UserGroupRow[] | null>(null)
  const [err, setErr] = useState('')
  const [userOpen, setUserOpen] = useState<UserRow | 'new' | null>(null)
  const [roleOpen, setRoleOpen] = useState<UserGroupRow | 'new' | null>(null)

  async function load() {
    setErr('')
    try {
      const [u, r] = await Promise.all([
        can('users', 'view') ? api.users() : Promise.resolve([] as UserRow[]),
        can('access', 'view') || can('users', 'view') ? api.userGroups().catch(() => [] as UserGroupRow[]) : Promise.resolve([] as UserGroupRow[]),
      ])
      setUsers(u); setRoles(r)
    } catch (e: any) { setErr(e.message) }
  }
  useEffect(() => { load() }, [])
  usePageNotice('load', err ? { kind: 'error', title: "Couldn't load users and roles.", message: err, actions: [{ label: 'Retry', onClick: () => { load() } }] } : null)

  if (!me) return null
  const action = tab === 'users' && can('users', 'manage') ? <NewButton label="Invite user" onClick={() => setUserOpen('new')} />
    : tab === 'roles' && can('access', 'manage') ? <NewButton label="New role" onClick={() => setRoleOpen('new')} />
    : undefined

  return (
    <>
      <PageHead title="Users & Roles" sub="Who can sign in to the admin, what their roles let them see and do, and the public users who watch." action={action} />
      <div className="filters">
        {tabs.map(([k, label]) => (
          <FChip key={k} label={label} n={k === 'users' ? users?.length ?? 0 : k === 'roles' ? roles?.length ?? 0 : 0} on={tab === k} onClick={() => setTab(k)} />
        ))}
      </div>

      {tab === 'users' && can('users', 'view') && <SecurityPolicy users={users} />}
      {tab === 'users' && <UsersTable users={users} me={me} onOpen={u => setUserOpen(u)} />}
      {tab === 'roles' && <RolesTable roles={roles} model={me.model.features} onOpen={r => setRoleOpen(r)} />}
      {tab === 'public' && <PublicUsers />}

      <div className="hintxt" style={{ marginTop: 14 }}>
        Your own name, email, password and two-step sign-in are in <a href="/account" onClick={e => { e.preventDefault(); navigate('/account') }}>My account</a>.
      </div>

      {userOpen && roles && (
        <UserDrawer me={me} roles={roles} user={userOpen === 'new' ? undefined : userOpen}
          onClose={() => setUserOpen(null)} onDone={() => { setUserOpen(null); load() }} />
      )}
      {roleOpen && (
        <RoleDrawer me={me} role={roleOpen === 'new' ? undefined : roleOpen}
          onClose={() => setRoleOpen(null)} onDone={() => { setRoleOpen(null); load() }} />
      )}
    </>
  )
}

/* ------------------------------------------------------------------ admin users */
function UsersTable({ users, me, onOpen }: { users: UserRow[] | null; me: Me; onOpen: (u: UserRow) => void }) {
  if (users === null) return <div className="loading">Loading users…</div>
  return (
    <div className="card">
      <table>
        <thead><tr><th>User</th><th>Roles</th><th>Tier</th><th>Two-step</th><th>Status</th><th>Added</th><th></th></tr></thead>
        <tbody>
          {users.map((u, i) => (
            <tr key={u.id} onClick={() => onOpen(u)} style={{ cursor: 'pointer' }}>
              <td><EntityCell name={u.displayName || u.email} sub={u.id === me.id ? `${u.email} · you` : u.displayName ? u.email : (u.isPlatform || u.is_platform) ? 'platform staff' : undefined} index={i} /></td>
              <td style={{ color: 'var(--muted)' }}>{u.roles?.length ? u.roles.map(r => r.name).join(', ') : <span style={{ color: 'var(--faint)' }}>tier default</span>}</td>
              <td><span className={`tag type ${u.role === 'owner' || u.role === 'admin' ? 'event' : 'chan'}`}>{TIER_LABEL[u.role] || u.role}</span></td>
              <td>{u.mfa ? <StatusTag label="On" cls="live" /> : <StatusTag label="Off" cls="idle" />}</td>
              <td>{u.status === 'active' ? <StatusTag label="Active" cls="live" /> : <StatusTag label={u.status === 'disabled' ? 'Disabled' : 'Invited'} cls="idle" />}</td>
              <td style={{ color: 'var(--muted)' }}>{fmtDate(u.created_at)}</td>
              <td style={{ textAlign: 'right' }} onClick={e => e.stopPropagation()}><button className="btn primary" onClick={() => onOpen(u)}>Open</button></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function UserDrawer({ me, roles, user, onClose, onDone }: {
  me: Me; roles: UserGroupRow[]; user?: UserRow; onClose: () => void; onDone: () => void
}) {
  const { can } = useAccess()
  const isEdit = !!user
  const myAccess = me.permissions ?? me.features
  const [detail, setDetail] = useState<(UserRow & { manageable: boolean; access: Record<string, AccessLevel>; security?: SecurityBrief | null; invite?: InviteState | null }) | null>(null)
  // A new user is invited by email by default: they confirm the address with a
  // code and choose their own password (docs/ONBOARDING.md). Setting one here is
  // the fallback for an address that cannot receive mail.
  const [how, setHow] = useState<'invite' | 'password'>('invite')
  const notify = useNotify()
  const [email, setEmail] = useState(user?.email ?? '')
  const [displayName, setDisplayName] = useState(user?.displayName ?? '')
  const [password, setPassword] = useState('')
  const [picked, setPicked] = useState<string[]>(user?.roles?.map(r => r.id) ?? [])
  const [status, setStatus] = useState<'active' | 'disabled'>(user?.status === 'disabled' ? 'disabled' : 'active')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')

  useEffect(() => { if (user) api.user(user.id).then(setDetail).catch(e => setErr(e.message)) }, [user?.id])

  const editable = can('users', 'manage') && (!isEdit || (detail?.manageable ?? false))
  const isSelf = user?.id === me.id

  async function submit() {
    setErr(''); setBusy(true)
    try {
      if (isEdit) {
        await api.patchUser(user!.id, {
          roleIds: picked,
          displayName: displayName.trim() || null,
          ...(status !== (user!.status === 'disabled' ? 'disabled' : 'active') ? { status } : {}),
        })
      } else if (how === 'invite') {
        if (!email.trim()) throw new Error('Enter an email')
        const r = await apiRequest('/users/invite', { method: 'POST', body: JSON.stringify({ email: email.trim(), roleIds: picked, displayName: displayName.trim() || undefined }) })
        notify(r.invite?.sent
          ? { kind: 'ok', title: 'Invitation sent.', message: `${r.invite.sentTo} gets a link to confirm their email and choose a password. It expires ${fmtDate(r.invite.expiresAt)}.` }
          : { kind: 'warn', title: 'User added, but the email did not send.', message: `${r.invite?.error ?? 'The mail server refused it.'} Open the user and choose Send again.` })
      } else {
        if (!email.trim()) throw new Error('Enter an email')
        if (password.length < 10) throw new Error('Password must be at least 10 characters')
        await api.createUser({ email: email.trim(), password, roleIds: picked, displayName: displayName.trim() || undefined })
      }
      onDone()
    } catch (e: any) { setErr(e.message) } finally { setBusy(false) }
  }

  async function resetPassword() {
    const pw = window.prompt('New password for this user (at least 10 characters). Their sessions end.')
    if (!pw) return
    setBusy(true); setErr('')
    try { await api.setUserPassword(user!.id, pw); window.alert('Password changed.') }
    catch (e: any) { setErr(e.message) } finally { setBusy(false) }
  }

  async function resendInvite() {
    setBusy(true); setErr('')
    try {
      const r = await apiRequest(`/users/${user!.id}/invite`, { method: 'POST' })
      if (!r.sent) throw new Error(r.error ?? 'The email could not be sent')
      notify({ kind: 'ok', title: 'Invitation sent again.', message: `The earlier link no longer works. The new one expires ${fmtDate(r.expiresAt)}.` })
      setDetail(await api.user(user!.id))
    } catch (e: any) { setErr(e.message) } finally { setBusy(false) }
  }

  async function withdrawInvite() {
    if (!window.confirm(`Withdraw the invitation for ${user!.email}? The link in their email stops working. You can send a new one later, or delete the user.`)) return
    setBusy(true); setErr('')
    try { await apiRequest(`/users/${user!.id}/invite`, { method: 'DELETE' }); setDetail(await api.user(user!.id)) }
    catch (e: any) { setErr(e.message) } finally { setBusy(false) }
  }

  async function resetMfa() {
    if (!window.confirm(`Turn off two-step sign-in for ${user!.email}? Use this when they have lost their phone or codes. Their sessions end and, if the account requires it, they set it up again at next sign-in.`)) return
    setBusy(true); setErr('')
    try { await api.resetUserMfa(user!.id); setDetail(await api.user(user!.id)) } catch (e: any) { setErr(e.message) } finally { setBusy(false) }
  }

  async function remove() {
    if (!window.confirm(`Delete ${user!.email}? This cannot be undone. Disable the user instead to keep their history.`)) return
    setBusy(true); setErr('')
    try { await api.deleteUser(user!.id); onDone() } catch (e: any) { setErr(e.message); setBusy(false) }
  }

  return (
    <div className="drawer-scrim" {...pressable((e: any) => { ((onClose) as any)(e) })} data-a11y-click="">
      <div className="drawer" {...pressable((e: any) => { (((e: any) => e.stopPropagation()) as any)(e) })} data-a11y-click="">
        <div className="drawer-h"><div className="t">{isEdit ? 'Admin user' : 'Invite admin user'}</div><button className="xbtn" onClick={onClose}>✕</button></div>
        <div className="drawer-b">
          {isEdit && !editable && detail && (
            <div className="hintxt" style={{ marginBottom: 10, color: 'var(--warn,#fbbf24)' }}>
              {isSelf ? 'This is you. Change your own password and name under My account; your access is set by another administrator.'
                : 'This user has access you do not hold (or a higher tier), so you can view but not change them.'}
            </div>
          )}
          <div className="field"><label>Email</label>
            <input className="inp" value={email} disabled={isEdit} onChange={e => setEmail(e.target.value)} placeholder="person@company.com" />
          </div>
          <div className="field"><label>Name <span style={{ color: 'var(--faint)' }}>optional</span></label>
            <input className="inp" value={displayName} disabled={!editable} onChange={e => setDisplayName(e.target.value)} />
          </div>
          {!isEdit && (
            <div className="field"><label>How they get in</label>
              <div role="radiogroup" style={{ display: 'grid', gap: 6 }}>
                {([['invite', 'Email an invitation', 'They get a link, confirm their address with a 6-digit code and choose their own password. Recommended.'],
                   ['password', 'Set a password now', 'For an address that cannot receive email. You share the password with them.']] as const).map(([k, t, d]) => (
                  <label key={k} style={{ display: 'flex', gap: 10, alignItems: 'flex-start', padding: '8px 10px', border: '1px solid var(--border)', borderRadius: 8, cursor: 'pointer', background: how === k ? 'var(--accent-soft, rgba(85,105,242,.10))' : undefined }}>
                    <input type="radio" name="user-how" checked={how === k} onChange={() => setHow(k)} style={{ marginTop: 3 }} />
                    <span><b>{t}</b><div className="hintxt" style={{ marginTop: 2 }}>{d}</div></span>
                  </label>
                ))}
              </div>
            </div>
          )}
          {!isEdit && how === 'password' && (
            <div className="field"><label>Password</label>
              <input className="inp" type="password" value={password} onChange={e => setPassword(e.target.value)} placeholder="At least 10 characters" />
              <div className="hintxt">Share it securely; they can change it after signing in.</div>
            </div>
          )}

          {isEdit && detail?.status === 'invited' && (
            <>
              <div className="sec-label">Invitation</div>
              <div style={{ fontSize: 'var(--fs-sm)', color: 'var(--muted)', lineHeight: 1.6, marginBottom: 8 }}>
                {detail.invite
                  ? detail.invite.expired
                    ? <>The invitation sent {fmtDate(detail.invite.sentAt)} has expired. They have not set up their account.</>
                    : <>Sent {fmtDate(detail.invite.sentAt)}, expires {fmtDate(detail.invite.expiresAt)}. {detail.invite.verified ? 'They have confirmed their email but not yet chosen a password.' : 'They have not opened it yet.'}</>
                  : <>No open invitation. They cannot sign in until you send one.</>}
              </div>
              {editable && (
                <div style={{ display: 'flex', gap: 8, marginBottom: 6 }}>
                  <button type="button" className="btn ghost" disabled={busy} onClick={resendInvite}>{detail.invite ? 'Send again' : 'Send invitation'}</button>
                  {detail.invite && !detail.invite.expired && <button type="button" className="btn ghost" disabled={busy} onClick={withdrawInvite}>Withdraw</button>}
                </div>
              )}
            </>
          )}

          <div className="sec-label">Roles</div>
          <div className="hintxt" style={{ marginBottom: 8 }}>The user gets the highest level any of their roles grants. Roles above your own access cannot be given.</div>
          {roles.map(r => {
            const over = above(myAccess, roleGrant(r))
            const on = picked.includes(r.id)
            const blocked = !editable || (!on && over.length > 0)
            return (
              <label key={r.id} style={{ display: 'flex', gap: 10, alignItems: 'flex-start', padding: '8px 0', borderBottom: '1px solid var(--border)', opacity: blocked && !on ? 0.55 : 1 }}>
                <input type="checkbox" checked={on} disabled={blocked}
                  onChange={e => setPicked(p => e.target.checked ? [...p, r.id] : p.filter(x => x !== r.id))} />
                <span style={{ flex: 1 }}>
                  <b>{r.name}</b>{r.system && <span className="tag type chan" style={{ marginLeft: 6 }}>default</span>}
                  <span style={{ color: 'var(--faint)', marginLeft: 6 }}>{TIER_LABEL[r.tier ?? 'operator']}</span>
                  {r.description && <div className="hintxt" style={{ marginTop: 2 }}>{r.description}</div>}
                  {over.length > 0 && !on && <div className="hintxt" style={{ color: 'var(--warn,#fbbf24)' }}>Above your access</div>}
                </span>
              </label>
            )
          })}

          {isEdit && detail?.security && (
            <>
              <div className="sec-label">Sign-in security</div>
              <SecurityBriefView s={detail.security} canReset={editable && !isSelf} busy={busy} onReset={resetMfa} />
            </>
          )}

          {isEdit && detail && (
            <>
              <div className="sec-label">Effective access</div>
              <AccessSummary perms={detail.access} model={me.model.features} />
            </>
          )}

          {isEdit && editable && !isSelf && (
            <div className="toggle-row">
              <div><div className="tt">Account active</div><div className="td">Disabling ends the user's sessions at once and blocks sign-in until re-enabled.</div></div>
              <div className={`sw ${status === 'active' ? '' : 'off'}`} {...pressable((e: any) => { ((() => setStatus(s => (s === 'active' ? 'disabled' : 'active'))) as any)(e) })} data-a11y-click=""><i /></div>
            </div>
          )}
        </div>
        <div className="drawer-f">
          {isEdit && editable && !isSelf && <button className="btn ghost" style={{ color: 'var(--down,#f87171)', marginRight: 'auto' }} disabled={busy} onClick={remove}>Delete</button>}
          <FormStatus error={err} />
          {isEdit && editable && !isSelf && detail?.status !== 'invited' && <button className="btn ghost" disabled={busy} onClick={resetPassword}>Set password</button>}
          <button className="btn ghost" onClick={onClose}>{editable ? 'Cancel' : 'Close'}</button>
          {editable && <button className="btn primary" disabled={busy} onClick={submit}>{busy ? 'Saving…' : isEdit ? 'Save changes' : how === 'invite' ? 'Send invitation' : 'Add user'}</button>}
        </div>
      </div>
    </div>
  )
}

function AccessSummary({ perms, model }: { perms: Record<string, AccessLevel>; model: AccessFeature[] }) {
  const by = (l: AccessLevel) => model.filter(f => perms[f.key] === l).map(f => f.label)
  return (
    <div style={{ fontSize: 'var(--fs-sm)', color: 'var(--muted)', lineHeight: 1.6 }}>
      {(['manage', 'operate', 'view'] as AccessLevel[]).map(l => by(l).length > 0 && (
        <div key={l}><b style={{ color: 'var(--text)', textTransform: 'capitalize' }}>{l}:</b> {by(l).join(', ')}</div>
      ))}
      {by('none').length > 0 && <div style={{ color: 'var(--faint)' }}>No access: {by('none').join(', ')}</div>}
    </div>
  )
}

/* ------------------------------------------------------------------ roles */
function RolesTable({ roles, model, onOpen }: { roles: UserGroupRow[] | null; model: AccessFeature[]; onOpen: (r: UserGroupRow) => void }) {
  if (roles === null) return <div className="loading">Loading roles…</div>
  const summary = (r: UserGroupRow) => {
    const g = roleGrant(r)
    const m = model.filter(f => g[f.key] === 'manage').length
    const o = model.filter(f => g[f.key] === 'operate').length
    const v = model.filter(f => g[f.key] === 'view').length
    if (r.tier === 'admin') return 'everything'
    return [m && `${m} manage`, o && `${o} operate`, v && `${v} view`].filter(Boolean).join(' · ') || 'no access'
  }
  return (
    <div className="card">
      <table>
        <thead><tr><th>Role</th><th>Access</th><th>Tier</th><th>Members</th><th></th></tr></thead>
        <tbody>
          {roles.map((r, i) => (
            <tr key={r.id} onClick={() => onOpen(r)} style={{ cursor: 'pointer' }}>
              <td><EntityCell name={r.name} sub={r.description || undefined} index={i} /></td>
              <td style={{ color: 'var(--muted)', fontSize: 'var(--fs-sm)' }}>{summary(r)}</td>
              <td>{r.system ? <span className="tag type event">default</span> : <span className="tag type chan">custom</span>} <span style={{ color: 'var(--faint)' }}>{TIER_LABEL[r.tier ?? 'operator']}</span></td>
              <td style={{ color: 'var(--muted)' }}>{r.memberCount ?? r.member_count ?? 0}</td>
              <td style={{ textAlign: 'right' }} onClick={e => e.stopPropagation()}><button className="btn primary" onClick={() => onOpen(r)}>Open</button></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function RoleDrawer({ me, role, onClose, onDone }: { me: Me; role?: UserGroupRow; onClose: () => void; onDone: () => void }) {
  const { can } = useAccess()
  const isEdit = !!role
  const model = me.model.features
  const mine = me.permissions ?? me.features
  const [name, setName] = useState(role?.name ?? '')
  const [desc, setDesc] = useState(role?.description ?? '')
  const [tier, setTier] = useState<'operator' | 'viewer'>(role?.tier === 'viewer' ? 'viewer' : 'operator')
  const [perms, setPerms] = useState<Record<string, AccessLevel>>(() =>
    Object.fromEntries(model.map(f => [f.key, (role ? roleGrant(role)[f.key] : 'none') ?? 'none'])))
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')

  // START FROM A TEMPLATE (roleTemplates.ts): fills the form, lowered to what you hold.
  const [tpl, setTpl] = useState('')
  const [lowered, setLowered] = useState<string[]>([])
  const [confirmDelete, setConfirmDelete] = useState(false)
  function applyTemplate(key: string) {
    setTpl(key)
    const t = ROLE_TEMPLATES.find(x => x.key === key)
    if (!t) { setName(''); setDesc(''); setTier('operator'); setLowered([]); setPerms(Object.fromEntries(model.map(f => [f.key, 'none' as AccessLevel]))); return }
    const low: string[] = []
    const next = Object.fromEntries(model.map(f => {
      let l: AccessLevel = t.permissions[f.key] ?? 'none'
      if (RANK[l] > RANK[mine[f.key] ?? 'none']) { low.push(f.label); l = mine[f.key] ?? 'none' }
      return [f.key, l]
    }))
    setName(t.name); setDesc(t.description); setTier(t.tier); setPerms(next); setLowered(low)
  }
  const over = role ? above(mine, roleGrant(role)) : []
  const editable = can('access', 'manage') && !role?.system && over.length === 0
  const grouped = useMemo(() => ['content', 'insight', 'admin'].map(a => ({ area: a, items: model.filter(f => f.area === a) })), [model])

  async function submit() {
    setErr('')
    if (!name.trim()) { setErr('Give the role a name'); return }
    setBusy(true)
    try {
      const body = { name: name.trim(), description: desc.trim() || null, tier, permissions: perms }
      if (isEdit) await api.patchUserGroup(role!.id, body)
      else await api.createUserGroup({ ...body, description: body.description ?? undefined })
      onDone()
    } catch (e: any) { setErr(e.message) } finally { setBusy(false) }
  }
  async function copy() {
    setBusy(true); setErr('')
    try { await api.copyAccessRole(role!.id); onDone() } catch (e: any) { setErr(e.message); setBusy(false) }
  }
  async function remove() {
    setConfirmDelete(false)
    setBusy(true); setErr('')
    try { await api.deleteUserGroup(role!.id); onDone() } catch (e: any) { setErr(e.message); setBusy(false) }
  }

  return (
    <div className="drawer-scrim" {...pressable((e: any) => { ((onClose) as any)(e) })} data-a11y-click="">
      <div className="drawer" {...pressable((e: any) => { (((e: any) => e.stopPropagation()) as any)(e) })} data-a11y-click="">
        <div className="drawer-h"><div className="t">{isEdit ? role!.name : 'New role'}</div><button className="xbtn" onClick={onClose}>✕</button></div>
        <div className="drawer-b">
          {!isEdit && (
            <div className="field"><label>Start from</label>
              <div className="tpl-row" role="radiogroup" aria-label="Start from a template">
                <button type="button" role="radio" aria-checked={tpl === ''} className={`chip ${tpl === '' ? 'active' : ''}`} onClick={() => applyTemplate('')}>Blank</button>
                {ROLE_TEMPLATES.map(t => (
                  <button key={t.key} type="button" role="radio" aria-checked={tpl === t.key} title={t.description}
                    className={`chip ${tpl === t.key ? 'active' : ''}`} onClick={() => applyTemplate(t.key)}>{t.name}</button>
                ))}
              </div>
              <div className="hintxt">A template fills the form below; change anything before creating the role.</div>
              {lowered.length > 0 && <div style={{ marginTop: 8 }}><Notice kind="info" variant="compact" message={`Lowered to your own access: ${lowered.join(', ')}.`} /></div>}
            </div>
          )}
          {role?.system && <div className="hintxt" style={{ marginBottom: 10 }}>A default role: the same in every account and read-only. Copy it to make a variation.</div>}
          {!role?.system && over.length > 0 && <div className="hintxt" style={{ marginBottom: 10, color: 'var(--warn,#fbbf24)' }}>This role grants access you do not hold, so you cannot change it.</div>}
          <div className="field"><label>Name</label>
            <input className="inp" value={name} disabled={!editable} onChange={e => setName(e.target.value)} placeholder="e.g. Clip editor, News desk" />
          </div>
          <div className="field"><label>Description <span style={{ color: 'var(--faint)' }}>optional</span></label>
            <input className="inp" value={desc} disabled={!editable} onChange={e => setDesc(e.target.value)} />
          </div>
          <div className="field"><label>Tier</label>
            <select className="inp" value={tier} disabled={!editable} onChange={e => setTier(e.target.value as 'operator' | 'viewer')}>
              <option value="operator">Operator: levels apply as set</option>
              <option value="viewer">Viewer: every level is capped at view</option>
            </select>
          </div>

          {grouped.map(g => g.items.length > 0 && (
            <div key={g.area}>
              <div className="sec-label">{AREA_LABEL[g.area]}</div>
              {g.items.map(f => (
                <div key={f.key} style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '7px 0', borderBottom: '1px solid var(--border)' }}>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: 'var(--fs-body)' }}>{f.label}</div>
                    {f.operate && <div className="hintxt" style={{ margin: 0 }}>operate: {f.operate}</div>}
                  </div>
                  {LEVELS.filter(l => l !== 'operate' || f.operate).map(l => {
                    const capped = tier === 'viewer' && RANK[l] > 1
                    const beyond = RANK[l] > RANK[mine[f.key] ?? 'none']
                    return (
                      <button key={l} type="button" disabled={!editable || beyond || capped}
                        title={beyond ? 'Above your own access' : capped ? 'Viewer-tier roles are capped at view' : undefined}
                        className={`chip ${perms[f.key] === l ? 'active' : ''}`} style={{ padding: '4px 10px', fontSize: 'var(--fs-sm)' }}
                        onClick={() => setPerms(p => ({ ...p, [f.key]: l }))}>{l}</button>
                    )
                  })}
                </div>
              ))}
            </div>
          ))}
          <div className="hintxt" style={{ marginTop: 10 }}>none hides the section · view is read-only · operate runs things (start/stop, on air, publish) · manage creates, edits and deletes.</div>
        </div>
        <div className="drawer-f">
          {isEdit && editable && <button className="btn ghost" style={{ color: 'var(--down,#f87171)', marginRight: 'auto' }} disabled={busy} onClick={() => setConfirmDelete(true)}>Delete role</button>}
          <FormStatus error={err} />
          {isEdit && can('access', 'manage') && <button className="btn ghost" disabled={busy || over.length > 0} onClick={copy}>Copy</button>}
          <button className="btn ghost" onClick={onClose}>{editable ? 'Cancel' : 'Close'}</button>
          {editable && <button className="btn primary" disabled={busy} onClick={submit}>{busy ? 'Saving…' : isEdit ? 'Save changes' : 'Create role'}</button>}
        </div>
      </div>
      {/* In a portal: the drawer's backdrop closes on click and on Space, which
          would close it while typing the role's name. */}
      {confirmDelete && createPortal(
        <ConfirmDialog title={`Delete role ${role!.name}?`} confirmLabel="Delete role" danger typeToConfirm={role!.name}
          body={<p style={{ margin: 0 }}>Its {role!.member_count ?? role!.memberCount ?? 0} member(s) lose the access it gave them. This cannot be undone.</p>}
          onCancel={() => setConfirmDelete(false)} onConfirm={remove} />, document.body
      )}
    </div>
  )
}

/* ------------------------------------------------------------------ public users */
function PublicUsers() {
  const { can } = useAccess()
  const [q, setQ] = useState('')
  const [status, setStatus] = useState('')
  const [rows, setRows] = useState<{ total: number; items: ViewerRow[] } | null>(null)
  const [open, setOpen] = useState<ViewerDetail | null>(null)
  const [err, setErr] = useState('')
  const [actErr, setActErr] = useState('')
  const notify = useNotify()

  const load = () => api.viewers(q.trim(), status).then(r => { setRows(r); setErr('') }).catch(e => setErr(e.message))
  useEffect(() => { const t = setTimeout(load, 250); return () => clearTimeout(t) }, [q, status])
  usePageNotice('viewers-load', err ? { kind: 'error', title: "Couldn't load public users.", message: err, actions: [{ label: 'Retry', onClick: () => { load() } }] } : null)

  async function act(fn: () => Promise<unknown>) {
    setActErr('')
    try { await fn(); await load(); if (open) setOpen(await api.viewer(open.id).catch(() => null)) } catch (e: any) { setActErr(e.message) }
  }

  return (
    <>
      <div style={{ display: 'flex', gap: 8, marginBottom: 10 }}>
        <input className="inp" style={{ flex: 1 }} placeholder="Search email, name or external id" value={q} onChange={e => setQ(e.target.value)} />
        <select className="inp" style={{ width: 160 }} value={status} onChange={e => setStatus(e.target.value)}>
          <option value="">Any status</option><option value="active">Active</option><option value="disabled">Disabled</option><option value="deleted">Deleted</option>
        </select>
      </div>
      {rows === null ? <div className="loading">Loading public users…</div> : rows.items.length === 0 ? (
        <div className="empty"><h3>No public users</h3><p>Viewers appear here when they register or sign in through one of your apps, or when your own sign-in system exchanges a token.</p></div>
      ) : (
        <div className="card">
          <table>
            <thead><tr><th>Viewer</th><th>Sign-in</th><th>Groups</th><th>Status</th><th>Last seen</th><th></th></tr></thead>
            <tbody>
              {rows.items.map((v, i) => (
                <tr key={v.id} onClick={() => api.viewer(v.id).then(d => { setActErr(''); setOpen(d) }).catch(e => notify({ kind: 'error', message: e.message }))} style={{ cursor: 'pointer' }}>
                  <td><EntityCell name={v.displayName || v.email || v.externalId} sub={v.displayName ? v.email ?? undefined : undefined} index={i} /></td>
                  <td style={{ color: 'var(--muted)' }}>{v.source === 'hosted' ? `Volt account${v.mfa ? ' · two-step' : ''}` : 'Your sign-in (token exchange)'}</td>
                  <td style={{ color: 'var(--muted)' }}>{v.groups.join(', ') || '—'}</td>
                  <td>{v.status === 'active' ? <StatusTag label="Active" cls="live" /> : <StatusTag label={v.status === 'disabled' ? 'Disabled' : 'Deleted'} cls="idle" />}</td>
                  <td style={{ color: 'var(--muted)' }}>{fmtDate(v.lastSeenAt)}</td>
                  <td style={{ textAlign: 'right' }}><button className="btn primary">Open</button></td>
                </tr>
              ))}
            </tbody>
          </table>
          {rows.total > rows.items.length && <div className="hintxt" style={{ padding: 10 }}>Showing {rows.items.length} of {rows.total}. Search to narrow.</div>}
        </div>
      )}

      {open && (
        <div className="drawer-scrim" {...pressable((e: any) => { ((() => setOpen(null)) as any)(e) })} data-a11y-click="">
          <div className="drawer" {...pressable((e: any) => { (((e: any) => e.stopPropagation()) as any)(e) })} data-a11y-click="">
            <div className="drawer-h"><div className="t">{open.displayName || open.email || 'Public user'}</div><button className="xbtn" onClick={() => setOpen(null)}>✕</button></div>
            <div className="drawer-b">
              <div className="field"><label>Email</label><div>{open.email ?? '—'}</div></div>
              <div className="field"><label>Sign-in</label><div>{open.source === 'hosted' ? 'Volt account (email and password)' : `Your sign-in system: ${open.externalId}`}</div></div>
              <div className="field"><label>Groups</label><div>{open.groups.join(', ') || '—'}</div></div>
              <div className="field"><label>Active sessions</label><div>{open.activeSessions}</div></div>
              {open.source === 'hosted' && open.security && (
                <>
                  <div className="sec-label">Sign-in security</div>
                  <SecurityBriefView s={open.security} canReset={can('viewers', 'manage') && open.status !== 'deleted'}
                    onReset={() => window.confirm('Turn off two-step sign-in for this public user? Their sessions end.') && act(() => api.resetViewerMfa(open.id))} />
                </>
              )}
              <div className="sec-label">Access held</div>
              {open.entitlements.length === 0 ? <div className="hintxt">No entitlements.</div> : open.entitlements.map((e, i) => (
                <div key={i} style={{ fontSize: 'var(--fs-sm)', padding: '4px 0' }}>{e.productKey ?? 'grant'} · until {e.validUntil ? fmtDate(e.validUntil) : 'revoked'}</div>
              ))}
              <div className="sec-label">Purchases</div>
              {open.purchases.length === 0 ? <div className="hintxt">None.</div> : open.purchases.map(p => (
                <div key={p.id} style={{ fontSize: 'var(--fs-sm)', padding: '4px 0' }}>{fmtDate(p.purchased_at)} · {p.product ?? 'product'} · {p.status}{p.amount_cents != null ? ` · ${(p.amount_cents / 100).toFixed(2)} ${p.currency ?? ''}` : ''}</div>
              ))}
            </div>
            <div className="drawer-f">
              {can('viewers', 'manage') && open.status !== 'deleted' && (
                <button className="btn ghost" style={{ color: 'var(--down,#f87171)', marginRight: 'auto' }}
                  onClick={() => window.confirm('Delete this public user? Their personal data is removed; purchases are kept for your records.') && act(async () => { await api.deleteViewer(open.id); setOpen(null) })}>Delete</button>
              )}
              <FormStatus error={actErr} />
              {can('viewers', 'operate') && open.status === 'active' && <button className="btn ghost" onClick={() => act(() => api.signOutViewer(open.id))}>Sign out everywhere</button>}
              {can('viewers', 'manage') && open.status !== 'deleted' && (
                <button className="btn ghost" onClick={() => act(() => api.patchViewer(open.id, { status: open.status === 'active' ? 'disabled' : 'active' }))}>
                  {open.status === 'active' ? 'Disable' : 'Enable'}
                </button>
              )}
              <button className="btn primary" onClick={() => setOpen(null)}>Close</button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}

/* ------------------------------------------------------------------ sign-in security */
function SecurityBriefView({ s, canReset, busy, onReset }: { s: SecurityBrief; canReset: boolean; busy?: boolean; onReset: () => void }) {
  return (
    <div style={{ fontSize: 'var(--fs-sm)' }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginBottom: 6 }}>
        {s.methods.length
          ? s.methods.map(m => <span key={m} className="tag type chan" style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>{METHOD_ICON[m]}{METHOD_LABEL[m]}</span>)
          : <span className="hintxt">Two-step sign-in is off.</span>}
      </div>
      <div className="hintxt">
        Email {s.emailVerified ? 'verified' : 'not verified'}{s.phone ? ` · mobile ${s.phone}${s.phoneVerified ? ' (verified)' : ''}` : ''}{s.methods.length ? ` · ${s.backupCodesRemaining} backup codes left` : ''}
      </div>
      {canReset && s.methods.length > 0 && (
        <button className="btn ghost" style={{ marginTop: 8 }} disabled={busy} onClick={onReset}>Reset two-step sign-in</button>
      )}
    </div>
  )
}

/** Account policy: two-step sign-in compulsory for every admin user. */
function SecurityPolicy({ users }: { users: UserRow[] | null }) {
  const { can, me } = useAccess()
  const [p, setP] = useState<{ requireAdminMfa: boolean; activeUsers: number; usersWithMfa: number } | null>(null)
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  const notify = useNotify()
  useEffect(() => { api.securityPolicy().then(setP).catch(e => setErr(e.message)) }, [users])
  const canChange = can('users', 'manage') && (me?.role === 'owner' || me?.role === 'admin')
  async function toggle() {
    if (!p) return
    const next = !p.requireAdminMfa
    if (next && !window.confirm(`Require two-step sign-in for every admin user? ${p.activeUsers - p.usersWithMfa} of ${p.activeUsers} have not set it up yet: they will be asked to at their next sign-in, and sessions that did not use it end within a few minutes.`)) return
    setBusy(true)
    try { const r = await api.setSecurityPolicy(next); setP({ ...p, requireAdminMfa: r.requireAdminMfa }) } catch (e: any) { notify({ kind: 'error', message: e.message }) } finally { setBusy(false) }
  }
  if (!p) return err ? <div style={{ marginBottom: 12 }}><Notice kind="error" variant="compact" title="Couldn't load the sign-in policy." message={err} /></div> : null
  return (
    <div className="card toggle-row" style={{ padding: '12px 16px', marginBottom: 12 }}>
      <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
        {METHOD_ICON.totp}
        <div>
          <div className="tt">Require two-step sign-in for all admin users</div>
          <div className="td">{p.usersWithMfa} of {p.activeUsers} active users have it on. {p.requireAdminMfa ? 'Required: anyone without it is asked to set it up when they sign in.' : 'Optional: each person decides in My account.'}</div>
        </div>
      </div>
      {canChange
        ? <div className={`sw ${p.requireAdminMfa ? '' : 'off'}`} {...pressable(() => { if (!busy) toggle() }, { label: 'Require two-step sign-in', disabled: busy })}><i /></div>
        : <StatusTag label={p.requireAdminMfa ? 'Required' : 'Optional'} cls={p.requireAdminMfa ? 'live' : 'idle'} />}
    </div>
  )
}

export type { TenantRole }
