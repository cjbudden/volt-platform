import { useEffect, useMemo, useState } from 'react'
import { api, type Me, type UserRow, type UserGroupRow, type TenantRole, type AccessLevel } from '../api'
import { PageHead, NewButton, FChip, EntityCell, StatusTag, SEC } from '../scaffold'

/* ============================================================================
   User Management — the account's users and USER GROUPS.
   - Users have a ROLE (owner > admin > operator > viewer): admins+ always have
     full access; user management / API keys / account config are admin-only.
   - Operators and viewers can be assigned to a USER GROUP, which sets a level
     PER FEATURE (none / view / manage) and decides which sections and
     functions the member can use. No group = the role's default access.
   ========================================================================== */

const ROLE_LABEL: Record<string, string> = { owner: 'Owner', admin: 'Admin', operator: 'Operator', viewer: 'Viewer' }
const ROLE_DESC: Record<TenantRole, string> = {
  owner: 'Everything, including managing other owners. Every account keeps at least one.',
  admin: 'Full access to all features plus user management, apps and API keys.',
  operator: 'Runs content day to day. A user group can narrow which features.',
  viewer: 'Read-only. A user group can narrow (never widen) what is visible.',
}
const FEATURE_LABEL: Record<string, string> = {
  channels: 'Channels', events: 'Events', epg: 'EPG', recordings: 'Recordings',
  vod: 'VOD Library', media: 'Image Library', sharing: 'Share links', analytics: 'Analytics',
}
const fmtDate = (iso?: string | null) => (iso ? new Date(iso).toLocaleDateString([], { day: '2-digit', month: 'short', year: 'numeric' }) : '—')

export default function Users() {
  const [tab, setTab] = useState<'users' | 'groups'>('users')
  const [me, setMe] = useState<Me | null>(null)
  const [users, setUsers] = useState<UserRow[] | null>(null)
  const [groups, setGroups] = useState<UserGroupRow[] | null>(null)
  const [err, setErr] = useState('')
  const [addUser, setAddUser] = useState(false)
  const [editUser, setEditUser] = useState<UserRow | null>(null)
  const [addGroup, setAddGroup] = useState(false)
  const [editGroup, setEditGroup] = useState<UserGroupRow | null>(null)

  async function load() {
    try {
      const [m, u, g] = await Promise.all([api.me(), api.users(), api.userGroups()])
      setMe(m); setUsers(u); setGroups(g)
    } catch (e: any) { setErr(e.message) }
  }
  useEffect(() => { load() }, [])

  const activeN = useMemo(() => (users || []).filter(u => u.status === 'active').length, [users])

  return (
    <>
      <PageHead title="User Management" sub="Who can sign in, their role, and the user group that decides which features they can access."
        action={tab === 'users'
          ? <NewButton label="Add user" onClick={() => setAddUser(true)} />
          : <NewButton label="New group" onClick={() => setAddGroup(true)} />} />
      {err && <div className="err">{err}</div>}

      <div className="filters">
        <FChip label="Users" n={users?.length ?? 0} on={tab === 'users'} onClick={() => setTab('users')} />
        <FChip label="User groups" n={groups?.length ?? 0} on={tab === 'groups'} onClick={() => setTab('groups')} />
        {tab === 'users' && <span style={{ marginLeft: 'auto', fontSize: 'var(--fs-sm)', color: 'var(--faint)', alignSelf: 'center' }}>{activeN} active</span>}
      </div>

      {tab === 'users' ? (
        users === null ? <div className="loading">Loading users…</div> : (
          <div className="card">
            <table>
              <thead><tr><th>User</th><th>Role</th><th>User group</th><th>Status</th><th>Added</th><th></th></tr></thead>
              <tbody>
                {users.map((u, i) => (
                  <tr key={u.id} onClick={() => setEditUser(u)} style={{ cursor: 'pointer' }}>
                    <td><EntityCell name={u.email} sub={u.id === me?.id ? 'you' : u.is_platform ? 'platform staff' : undefined} index={i} /></td>
                    <td><span className={`tag type ${u.role === 'owner' || u.role === 'admin' ? 'event' : 'chan'}`}>{ROLE_LABEL[u.role] || u.role}</span></td>
                    <td style={{ color: 'var(--muted)' }}>
                      {u.role === 'owner' || u.role === 'admin' ? <span style={{ color: 'var(--faint)' }}>full access</span> : (u.user_group_name || <span style={{ color: 'var(--faint)' }}>role default</span>)}
                    </td>
                    <td>{u.status === 'active' ? <StatusTag label="Active" cls="live" /> : <StatusTag label={u.status === 'disabled' ? 'Disabled' : 'Invited'} cls="idle" />}</td>
                    <td style={{ color: 'var(--muted)' }}>{fmtDate(u.created_at)}</td>
                    <td style={{ textAlign: 'right' }} onClick={e => e.stopPropagation()}>
                      <button className="btn primary" onClick={() => setEditUser(u)}>Open</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )
      ) : groups === null ? <div className="loading">Loading groups…</div> : groups.length === 0 ? (
        <div className="empty">
          <div className="ic"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2" /><circle cx="9" cy="7" r="4" /><path d="M23 21v-2a4 4 0 00-3-3.87M16 3.13a4 4 0 010 7.75" /></svg></div>
          <h3>No user groups yet</h3>
          <p>A user group sets a level per feature (none, view or manage) for its members. Assign operators and viewers to a group to control exactly which sections they can use.</p>
          <button className="btn primary" onClick={() => setAddGroup(true)} style={{ margin: '0 auto' }}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4"><path d="M12 5v14M5 12h14" /></svg>
            Create your first group
          </button>
        </div>
      ) : (
        <div className="card">
          <table>
            <thead><tr><th>Group</th><th>Access</th><th>Members</th><th>Created</th><th></th></tr></thead>
            <tbody>
              {groups.map((g, i) => (
                <tr key={g.id} onClick={() => setEditGroup(g)} style={{ cursor: 'pointer' }}>
                  <td><EntityCell name={g.name} sub={g.description || undefined} index={i} /></td>
                  <td style={{ color: 'var(--muted)', fontSize: 'var(--fs-sm)' }}>{permSummary(g.permissions, me)}</td>
                  <td style={{ color: 'var(--muted)' }}>{g.member_count ?? 0}</td>
                  <td style={{ color: 'var(--muted)' }}>{fmtDate(g.created_at)}</td>
                  <td style={{ textAlign: 'right' }} onClick={e => e.stopPropagation()}>
                    <button className="btn primary" onClick={() => setEditGroup(g)}>Open</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {me && (
        <div className="card" style={{ marginTop: 18, padding: 18 }}>
          <div style={{ fontWeight: 700, marginBottom: 6 }}>How access works</div>
          {(me.model?.notes || []).map((n, i) => (
            <div key={i} style={{ fontSize: 'var(--fs-sm)', color: 'var(--faint)', marginTop: 4 }}>· {n}</div>
          ))}
        </div>
      )}

      {addUser && me && <UserDrawer me={me} groups={groups || []} onClose={() => setAddUser(false)} onDone={() => { setAddUser(false); load() }} />}
      {editUser && me && <UserDrawer me={me} groups={groups || []} user={editUser} onClose={() => setEditUser(null)} onDone={() => { setEditUser(null); load() }} />}
      {addGroup && me && <GroupDrawer me={me} onClose={() => setAddGroup(false)} onDone={() => { setAddGroup(false); load() }} />}
      {editGroup && me && <GroupDrawer me={me} group={editGroup} onClose={() => setEditGroup(null)} onDone={() => { setEditGroup(null); load() }} />}
    </>
  )
}

function permSummary(p: Record<string, AccessLevel>, me: Me | null): string {
  const feats = me?.model?.features || Object.keys(FEATURE_LABEL)
  const manage = feats.filter(f => p[f] === 'manage')
  const view = feats.filter(f => p[f] === 'view')
  const none = feats.filter(f => !p[f] || p[f] === 'none')
  const bits: string[] = []
  if (manage.length) bits.push(`manage: ${manage.map(f => FEATURE_LABEL[f] || f).join(', ')}`)
  if (view.length) bits.push(`view: ${view.map(f => FEATURE_LABEL[f] || f).join(', ')}`)
  if (!bits.length) return 'no access'
  if (none.length && none.length < feats.length) bits.push(`${none.length} hidden`)
  return bits.join(' · ')
}

/* ------------------------------------------------ user add / settings drawer */
function UserDrawer({ me, groups, user, onClose, onDone }: {
  me: Me; groups: UserGroupRow[]; user?: UserRow; onClose: () => void; onDone: () => void
}) {
  const isEdit = !!user
  const meOwner = me.role === 'owner'
  const isSelf = user?.id === me.id
  const [email, setEmail] = useState(user?.email ?? '')
  const [password, setPassword] = useState('')
  const [role, setRole] = useState<TenantRole>(user?.role ?? 'operator')
  const [groupId, setGroupId] = useState<string>(user?.user_group_id ?? '')
  const [status, setStatus] = useState<'active' | 'disabled'>(user?.status === 'disabled' ? 'disabled' : 'active')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')

  const roleLocked = isEdit && user!.role === 'owner' && !meOwner
  const grouped = role === 'operator' || role === 'viewer'

  async function submit() {
    setErr('')
    setBusy(true)
    try {
      if (isEdit) {
        await api.patchUser(user!.id, {
          ...(role !== user!.role ? { role } : {}),
          ...(status !== (user!.status === 'disabled' ? 'disabled' : 'active') ? { status } : {}),
          userGroupId: grouped && groupId ? groupId : null,
        })
      } else {
        if (!email.trim()) { setErr('Enter an email'); setBusy(false); return }
        if (password.length < 8) { setErr('Password must be at least 8 characters'); setBusy(false); return }
        await api.createUser({ email: email.trim(), password, role, userGroupId: grouped && groupId ? groupId : null })
      }
      onDone()
    } catch (e: any) { setErr(e.message) } finally { setBusy(false) }
  }

  return (
    <div className="drawer-scrim" onClick={onClose}>
      <div className="drawer" onClick={e => e.stopPropagation()}>
        <div className="drawer-h"><div className="t">{isEdit ? 'User settings' : 'Add user'}</div><button className="xbtn" onClick={onClose}>✕</button></div>
        <div className="drawer-b">
          <div className="field"><label>Email</label>
            <input className="inp" value={email} disabled={isEdit} onChange={e => setEmail(e.target.value)} placeholder="person@company.com" />
          </div>
          {!isEdit && (
            <div className="field"><label>Password</label>
              <input className="inp" type="password" value={password} onChange={e => setPassword(e.target.value)} placeholder="At least 8 characters" />
              <div className="hintxt">Share it with the person securely; they can change it after signing in.</div>
            </div>
          )}

          <div style={SEC}>Role</div>
          <div className="field">
            <select className="inp" value={role} disabled={roleLocked || isSelf} onChange={e => setRole(e.target.value as TenantRole)}>
              <option value="viewer">Viewer</option>
              <option value="operator">Operator</option>
              <option value="admin">Admin</option>
              {(meOwner || role === 'owner') && <option value="owner">Owner</option>}
            </select>
            <div className="hintxt">{ROLE_DESC[role]}</div>
            {roleLocked && <div className="hintxt" style={{ color: 'var(--warn,#fbbf24)' }}>Only an owner can change another owner's role.</div>}
            {isSelf && <div className="hintxt">You cannot change your own role.</div>}
          </div>

          {grouped && (
            <>
              <div style={SEC}>User group</div>
              <div className="field"><label>Feature access <span style={{ color: 'var(--faint)' }}>— the group decides which features this user can use</span></label>
                <select className="inp" value={groupId} onChange={e => setGroupId(e.target.value)}>
                  <option value="">No group (role default: {role === 'viewer' ? 'view everything' : 'manage everything'})</option>
                  {groups.map(g => <option key={g.id} value={g.id}>{g.name}</option>)}
                </select>
                {groups.length === 0 && <div className="hintxt">No groups yet. Create one under the User groups tab to narrow feature access.</div>}
              </div>
            </>
          )}
          {!grouped && <div className="hintxt" style={{ marginTop: 8 }}>Admins and owners always have full access; user groups do not apply to them.</div>}

          {isEdit && !isSelf && (
            <div className="toggle-row">
              <div><div className="tt">Account active</div><div className="td">Disabling signs the user out (at the next token refresh) and blocks sign-in until re-enabled.</div></div>
              <div className={`sw ${status === 'active' ? '' : 'off'}`} onClick={() => setStatus(s => (s === 'active' ? 'disabled' : 'active'))}><i /></div>
            </div>
          )}

          {err && <div className="err">{err}</div>}
        </div>
        <div className="drawer-f">
          <button className="btn ghost" onClick={onClose}>Cancel</button>
          <button className="btn primary" disabled={busy} onClick={submit}>{busy ? 'Saving…' : isEdit ? 'Save changes' : 'Add user'}</button>
        </div>
      </div>
    </div>
  )
}

/* ------------------------------------------------ group create / edit drawer */
function GroupDrawer({ me, group, onClose, onDone }: {
  me: Me; group?: UserGroupRow; onClose: () => void; onDone: () => void
}) {
  const isEdit = !!group
  const feats = me.model?.features || Object.keys(FEATURE_LABEL)
  const [name, setName] = useState(group?.name ?? '')
  const [desc, setDesc] = useState(group?.description ?? '')
  const [perms, setPerms] = useState<Record<string, AccessLevel>>(() => {
    const p: Record<string, AccessLevel> = {}
    for (const f of feats) p[f] = (group?.permissions?.[f] as AccessLevel) || (isEdit ? 'none' : 'view')
    return p
  })
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')

  const setAll = (lvl: AccessLevel) => setPerms(Object.fromEntries(feats.map(f => [f, lvl])))

  async function submit() {
    setErr('')
    if (!name.trim()) { setErr('Give the group a name'); return }
    setBusy(true)
    try {
      if (isEdit) await api.patchUserGroup(group!.id, { name: name.trim(), description: desc.trim() || null, permissions: perms })
      else await api.createUserGroup({ name: name.trim(), description: desc.trim() || undefined, permissions: perms })
      onDone()
    } catch (e: any) { setErr(e.message) } finally { setBusy(false) }
  }

  async function remove() {
    if (!group) return
    if (!window.confirm(`Delete group "${group.name}"? Its ${group.member_count ?? 0} member(s) fall back to their role's default access.`)) return
    setBusy(true); setErr('')
    try { await api.deleteUserGroup(group.id); onDone() }
    catch (e: any) { setErr(e.message); setBusy(false) }
  }

  return (
    <div className="drawer-scrim" onClick={onClose}>
      <div className="drawer" onClick={e => e.stopPropagation()}>
        <div className="drawer-h"><div className="t">{isEdit ? 'Group settings' : 'New user group'}</div><button className="xbtn" onClick={onClose}>✕</button></div>
        <div className="drawer-b">
          <div className="field"><label>Group name</label>
            <input className="inp" value={name} onChange={e => setName(e.target.value)} placeholder="e.g. News desk, Clip editors" />
          </div>
          <div className="field"><label>Description <span style={{ color: 'var(--faint)' }}>— optional</span></label>
            <input className="inp" value={desc} onChange={e => setDesc(e.target.value)} placeholder="What this group is for" />
          </div>

          <div style={SEC}>Feature access</div>
          <div style={{ display: 'flex', gap: 8, marginBottom: 10 }}>
            <button type="button" className="btn ghost" onClick={() => setAll('manage')}>All manage</button>
            <button type="button" className="btn ghost" onClick={() => setAll('view')}>All view</button>
            <button type="button" className="btn ghost" onClick={() => setAll('none')}>All none</button>
          </div>
          {feats.map(f => (
            <div key={f} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '7px 0', borderBottom: '1px solid var(--border)' }}>
              <div style={{ flex: 1, fontSize: 'var(--fs-body)' }}>{FEATURE_LABEL[f] || f}</div>
              {(['none', 'view', 'manage'] as AccessLevel[]).map(lvl => (
                <button key={lvl} type="button"
                  className={`chip ${perms[f] === lvl ? 'active' : ''}`}
                  style={{ padding: '4px 12px', fontSize: 'var(--fs-sm)' }}
                  onClick={() => setPerms(p => ({ ...p, [f]: lvl }))}>
                  {lvl}
                </button>
              ))}
            </div>
          ))}
          <div className="hintxt" style={{ marginTop: 10 }}>
            none hides the section entirely · view is read-only · manage allows changes. For viewers the role still caps everything at view.
          </div>

          {err && <div className="err">{err}</div>}
        </div>
        <div className="drawer-f">
          {isEdit && (
            <button className="btn ghost" style={{ color: 'var(--down,#f87171)', marginRight: 'auto' }} disabled={busy} onClick={remove}>Delete group</button>
          )}
          <button className="btn ghost" onClick={onClose}>Cancel</button>
          <button className="btn primary" disabled={busy} onClick={submit}>{busy ? 'Saving…' : isEdit ? 'Save changes' : 'Create group'}</button>
        </div>
      </div>
    </div>
  )
}
