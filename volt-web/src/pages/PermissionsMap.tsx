// ============================================================================
//  PERMISSIONS MAP (Admin > Permissions map, docs/PERMISSIONS_MAP.md).
//
//  Every default user type against every area of the system, built from the
//  live access catalogue and this account's roles, so it cannot drift from
//  what the API enforces. Below the areas: the account controls that are not
//  a per-area level (the plan, groups, removing channels, the audit log).
// ============================================================================
import { Fragment, useEffect, useMemo, useState } from 'react'
import { api, type AccessLevel, type PlanView, type UserGroupRow } from '../api'
import { PageHead } from '../scaffold'
import { usePageNotice } from '../notices'

type Cat = { key: string; label: string; area: 'content' | 'insight' | 'admin'; operate: string | null }
interface Col { key: string; name: string; kind: 'platform' | 'tier' | 'role'; tier: string; desc: string; perms?: Record<string, AccessLevel>; custom?: boolean }

const AREA: Record<string, string> = { content: 'Content and operations', insight: 'Insight', admin: 'Administration' }
const LEVEL_LABEL: Record<AccessLevel, string> = { none: 'None', view: 'View', operate: 'Operate', manage: 'Manage' }
const RANK: Record<AccessLevel, number> = { none: 0, view: 1, operate: 2, manage: 3 }

function Lvl({ l }: { l: AccessLevel }) {
  return <span className={`lvl lvl-${l}`}>{l === 'none' ? '—' : LEVEL_LABEL[l]}</span>
}
function Yes({ v }: { v: string | boolean }) {
  if (v === true) return <span className="lvl lvl-manage">Yes</span>
  if (v === false || v === '') return <span className="lvl lvl-none">—</span>
  return <span className="lvl lvl-view">{v}</span>
}

export default function PermissionsMap() {
  const [cat, setCat] = useState<Cat[] | null>(null)
  const [roles, setRoles] = useState<UserGroupRow[]>([])
  const [plan, setPlan] = useState<PlanView | null>(null)
  const [showCustom, setShowCustom] = useState(true)
  const [err, setErr] = useState('')
  useEffect(() => {
    api.accessCatalogue().then(c => setCat(c.catalogue)).catch((e: any) => setErr(e?.message || 'Could not load the access catalogue'))
    api.userGroups().then(setRoles).catch(() => {})
    api.plan().then(setPlan).catch(() => {})
  }, [])
  usePageNotice('load', err ? { kind: 'error', title: "Couldn't load the permissions map.", message: err } : null)

  const single = (plan?.deployment ?? 'single') === 'single'
  const cols: Col[] = useMemo(() => {
    const sys = roles.filter(r => r.system && r.tier !== 'admin')
    const custom = roles.filter(r => !r.system)
    return [
      { key: 'platform', name: 'System administrator', kind: 'platform', tier: 'platform', desc: 'Platform staff. Every account, from System Admin; signs in with a second step.' },
      { key: 'owner', name: 'Owner', kind: 'tier', tier: 'owner', desc: single ? 'The super user of this deployment. Everything, including the plan.' : 'Everything in the account; the plan is set by the platform.' },
      { key: 'admin', name: 'Administrator', kind: 'tier', tier: 'admin', desc: 'Everything in the account except changing the plan.' },
      ...sys.map(r => ({ key: r.id, name: r.name, kind: 'role' as const, tier: r.tier ?? 'operator', desc: r.description ?? '', perms: r.permissions })),
      ...(showCustom ? custom.map(r => ({ key: r.id, name: r.name, kind: 'role' as const, tier: r.tier ?? 'operator', desc: `${r.description ?? 'Custom role'} (custom)`, perms: r.permissions, custom: true })) : []),
    ]
  }, [roles, showCustom, single])
  const customCount = roles.filter(r => !r.system).length

  const level = (c: Col, f: string): AccessLevel => {
    if (c.kind !== 'role') return 'manage'
    const l = (c.perms?.[f] ?? 'none') as AccessLevel
    return c.tier === 'viewer' && RANK[l] > RANK.view ? 'view' : l
  }
  const settings = (c: Col) => level(c, 'settings')

  // ACCOUNT CONTROLS: rules that are not a per-area level (see docs/PERMISSIONS_MAP.md).
  const controls: { label: string; hint: string; cell: (c: Col) => string | boolean }[] = [
    { label: 'Change the plan', hint: 'Plan & limits: channels and stations allowed, running at once',
      cell: c => c.kind === 'platform' ? true : c.tier === 'owner' ? (single ? true : 'View') : c.tier === 'admin' ? 'View' : settings(c) !== 'none' ? 'View' : false },
    { label: 'Create groups, share out the plan, set the default, remove groups', hint: 'Channel groups (never the default group, never while in use)',
      cell: c => c.kind !== 'role' ? true : settings(c) === 'manage' ? 'Rename, profile' : settings(c) !== 'none' ? 'View' : false },
    { label: 'Set the account logo and colours', hint: 'Account settings: used by the share page',
      cell: c => c.kind !== 'role' ? true : settings(c) !== 'none' ? 'View' : false },
    { label: 'Remove channels and radio stations', hint: 'Shows what goes with it; type the name to confirm',
      cell: c => c.kind !== 'role' },
    { label: 'Remove events', hint: 'Events manage',
      cell: c => c.kind !== 'role' || level(c, 'events') === 'manage' },
    { label: 'Read the audit log', hint: 'Insight > Audit log, CSV export',
      cell: c => c.kind !== 'role' },
    { label: 'Add users and give roles', hint: 'Only access you hold yourself can be given',
      cell: c => c.kind !== 'role' ? true : level(c, 'users') === 'manage' ? 'Within own access' : false },
    { label: 'Other accounts, suspend an account', hint: 'System Admin (platform)',
      cell: c => c.kind === 'platform' },
  ]

  if (!cat) return <><PageHead title="Permissions map" sub="What each default user type can do, area by area." />{!err && <div className="loading">Loading…</div>}</>
  const areas = ['content', 'insight', 'admin'] as const

  return (
    <>
      <PageHead title="Permissions map" sub="What each user type can do, area by area, including this account's custom roles. Built from the live access rules, so it always matches what the system enforces." />
      <div className="pm-legend">
        <span><Lvl l="view" /> see lists and pages</span>
        <span><Lvl l="operate" /> run: start and stop, on air, publish</span>
        <span><Lvl l="manage" /> create, edit, remove</span>
        <span><Lvl l="none" /> no access</span>
        {customCount > 0 && <label className="chk-row" style={{ margin: '0 0 0 auto' }}><input type="checkbox" checked={showCustom} onChange={e => setShowCustom(e.target.checked)} /><span>Show this account's custom roles ({customCount})</span></label>}
      </div>
      <div className="card pm-wrap">
        <table className="pm">
          <thead>
            <tr>
              <th className="pm-area">Area</th>
              {cols.map(c => (
                <th key={c.key} title={c.desc}>
                  <div className="pm-col">{c.name}</div>
                  <div className="pm-tier">{c.kind === 'platform' ? 'Platform' : c.kind === 'tier' ? 'Account tier' : `${c.custom ? 'Custom, ' : ''}${c.tier === 'viewer' ? 'viewer' : 'operator'} tier`}</div>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {areas.map(a => (
              <Fragment key={a}>
                <tr className="pm-sec"><td colSpan={cols.length + 1}>{AREA[a]}</td></tr>
                {cat.filter(f => f.area === a).map(f => (
                  <tr key={f.key}>
                    <td className="pm-area"><b>{f.label}</b>{f.operate && <div className="hintxt">Operate: {f.operate}</div>}</td>
                    {cols.map(c => <td key={c.key}><Lvl l={level(c, f.key)} /></td>)}
                  </tr>
                ))}
              </Fragment>
            ))}
            <tr className="pm-sec"><td colSpan={cols.length + 1}>Account controls</td></tr>
            {controls.map(r => (
              <tr key={r.label}>
                <td className="pm-area"><b>{r.label}</b><div className="hintxt">{r.hint}</div></td>
                {cols.map(c => <td key={c.key}><Yes v={r.cell(c)} /></td>)}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="pm-notes">
        <div className="sec-label">How access works</div>
        <ul>
          <li><b>Tiers.</b> Owners and administrators have full access to the account. Operators and viewers get access from their roles; a viewer-tier role is capped at View.</li>
          <li><b>Roles add up.</b> A user with several roles holds the highest level any of them gives for each area.</li>
          <li><b>No escalation.</b> Nobody can give a user or a role more than they hold themselves.</li>
          <li><b>The plan.</b> {single ? 'This is a single-client deployment, so the owner is the super user and sets the plan.' : 'The plan is set by the platform; owners and administrators see it.'} Administrators share it out between channel groups.</li>
          <li><b>Public users</b> (viewers of your apps and players) are a separate kind of account and never reach this console.</li>
        </ul>
      </div>
    </>
  )
}
