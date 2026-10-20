import { useState, useEffect, useRef, type ReactElement } from 'react'
import { api, setSession, clearSession, noteActivity, setUnauthorizedHandler, isMfaStep, ensureImageSigning, type SearchHit, type Me, type MfaStep, type Session } from './api'
import { useImageSigning } from './imageSigning'
import { SignInSecondStep } from './security'
import AccountPage from './pages/Account'
import ChannelGroupsPage from './pages/ChannelGroups'
import Channels from './pages/Channels'
import ChannelDetail from './pages/ChannelDetail'
import ImageLibrary from './pages/ImageLibrary'
import Watchfolders from './pages/Watchfolders'
import EncodingProfiles from './pages/EncodingProfiles'
import Recordings from './pages/Recordings'
import RecordingDetail from './pages/RecordingDetail'
import RecordingSourceView from './pages/RecordingSource'
import StoragePage from './pages/Storage'
import LoopsPage from './pages/Loops'
import VodPage from './pages/Vod'
import ReviewPage from './pages/Review'
import AnalyticsPage from './pages/Analytics'
import AuditLogPage from './pages/AuditLog'
import NewStreamChooser from './NewStreamChooser'
import UiSamplesPage from './pages/UiSamples'
import PlanLimitsPage from './pages/PlanLimits'
import AccountSettingsPage from './pages/AccountSettings'
import PermissionsMapPage from './pages/PermissionsMap'
import { GlobalNotices, PageNoticesProvider, usePageNotice, Notice } from './notices'
import LivePage from './pages/Live'
import MonitoringPage from './pages/Monitoring'
import FleetPage from './pages/Fleet'
import PlayerSetup from './pages/PlayerSetup'
import DashboardPage from './pages/Dashboard'
import MultiviewPage from './pages/Multiview'
import Events from './pages/Events'
import Epg from './pages/Epg'
import EpgDetail from './pages/EpgDetail'
import FastPage from './pages/Fast'
import ApiKeys from './pages/ApiKeys'
import Users from './pages/Users'
import SystemAdmin from './pages/SystemAdmin'
import Radio from './pages/Radio'
import RadioDetail from './pages/RadioDetail'
import ContentTypesPage from './pages/ContentTypes'
import PublishingPage from './pages/Publishing'
import IngestRulesPage from './pages/IngestRules'
import PaymentsPage from './pages/Payments'
import { useRoute, navigate, hrefFor } from './router'
import { pressable, openable } from './a11y'
import { resetLiveBackoff } from './liveStatus'
import { UploadIndicator } from './uploads'
import { DocsButton } from './docsLink'
import { IngestQueue } from './IngestQueue'
import { ErrorBoundary } from './ErrorBoundary'
import { AccessProvider, makeAccess } from './access'
import NotificationBell from './NotificationBell'
import NotificationsPage from './pages/Notifications'
import SocialAccountsPage from './pages/SocialAccounts'
import WorkflowsPage from './pages/Workflows'

const BOLT = <svg viewBox="0 0 24 24" fill="currentColor"><path d="M14 1 3.5 14H11zM10 23 20.5 10H13z" /></svg>

const I = {
  dash: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="3" width="7" height="7" rx="1" /><rect x="14" y="3" width="7" height="7" rx="1" /><rect x="3" y="14" width="7" height="7" rx="1" /><rect x="14" y="14" width="7" height="7" rx="1" /></svg>,
  live: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="2" /><path d="M4.9 4.9a10 10 0 000 14.2M19.1 4.9a10 10 0 010 14.2M7.8 7.8a6 6 0 000 8.4M16.2 7.8a6 6 0 010 8.4" /></svg>,
  monitor: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="2" y="4" width="20" height="14" rx="2" /><path d="M8 21h8M12 18v3" /></svg>,
  // Stacked servers: the fleet is machines, not screens, and the icon says so.
  fleet: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="4" width="18" height="6" rx="1.5" /><rect x="3" y="14" width="18" height="6" rx="1.5" /><path d="M7 7h.01M7 17h.01" /></svg>,
  channels: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="2" y="7" width="20" height="13" rx="2" /><path d="m17 2-5 5-5-5" /></svg>,
  palette: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 3a9 9 0 1 0 0 18c1.1 0 1.8-.8 1.8-1.7 0-.5-.2-.9-.5-1.2-.3-.3-.5-.7-.5-1.2 0-.9.8-1.7 1.7-1.7H16a5 5 0 0 0 5-5c0-4-4-7.2-9-7.2z" /><circle cx="7.5" cy="11" r="1" /><circle cx="10" cy="7" r="1" /><circle cx="14.5" cy="7" r="1" /><circle cx="17" cy="11" r="1" /></svg>,
  events: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="4" width="18" height="18" rx="2" /><path d="M16 2v4M8 2v4M3 10h18" /></svg>,
  loops: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M17 2l4 4-4 4" /><path d="M3 11v-1a4 4 0 014-4h14M7 22l-4-4 4-4" /><path d="M21 13v1a4 4 0 01-4 4H3" /></svg>,
  rec: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="9" /><circle cx="12" cy="12" r="3" /></svg>,
  vod: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="m22 8-6 4 6 4V8z" /><rect x="2" y="6" width="14" height="12" rx="2" /></svg>,
  images: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="3" width="18" height="18" rx="2" /><circle cx="9" cy="9" r="2" /><path d="m21 15-5-5L5 21" /></svg>,
  multiview: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="3" width="7" height="7" rx="1" /><rect x="14" y="3" width="7" height="7" rx="1" /><rect x="3" y="14" width="7" height="7" rx="1" /><rect x="14" y="14" width="7" height="7" rx="1" /></svg>,
  analytics: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 3v18h18" /><path d="m7 14 4-4 3 3 5-6" /></svg>,
  epg: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M3 9h18M8 4v16M3 14h18" /></svg>,
  fast: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="2" y="5" width="20" height="14" rx="2" /><path d="M7 9h4M7 12h7M7 15h5M17 9v6" /></svg>,
  radio: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M4 11h16a1 1 0 0 1 1 1v7a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-7a1 1 0 0 1 1-1z" /><circle cx="8" cy="15.5" r="2.5" /><path d="M17 14h2M17 17h2M18 3 7 8" /></svg>,
  key: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 2l-2 2m-7.6 7.6a5.5 5.5 0 11-7.8 7.8 5.5 5.5 0 017.8-7.8zm0 0L15 8m-2 2 4-4m0 0 3 3 3-3-3-3" /></svg>,
  bell: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 8a6 6 0 00-12 0c0 7-3 9-3 9h18s-3-2-3-9M13.7 21a2 2 0 01-3.4 0" /></svg>,
  users: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2" /><circle cx="9" cy="7" r="4" /><path d="M23 21v-2a4 4 0 00-3-3.87M16 3.13a4 4 0 010 7.75" /></svg>,
  shield: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" /></svg>,
  review: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M9 11l3 3L22 4" /><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" /></svg>,
  // Branching flow: the base path with an add-on stepping off it.
  workflows: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="5" cy="6" r="2" /><circle cx="19" cy="6" r="2" /><circle cx="19" cy="18" r="2" /><path d="M7 6h10M12 6v8a4 4 0 004 4h1" /></svg>,
  storage: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><ellipse cx="12" cy="5" rx="9" ry="3" /><path d="M3 5v6c0 1.7 4 3 9 3s9-1.3 9-3V5" /><path d="M3 11v6c0 1.7 4 3 9 3s9-1.3 9-3v-6" /></svg>,
}

/** Which FEATURE (from /auth/me) each content nav item belongs to; items whose
 *  feature the user's group sets to 'none' are hidden so the nav matches the API. */
const NAV_FEATURE: Record<string, string> = {
  dashboard: 'monitoring', live: 'monitoring', monitoring: 'monitoring', multiview: 'monitoring',
  fleet: 'fleet', workflows: 'settings',
  channels: 'channels', radio: 'radio', events: 'events', epg: 'epg', loops: 'media', fast: 'channels',
  recordings: 'recordings', vod: 'vod', images: 'media', analytics: 'analytics',
  review: 'vod', watchfolders: 'media', storage: 'media',
  encoding: 'settings', groups: 'settings', plan: 'settings', 'account-settings': 'settings', permissions: 'access',
  // Admin sections
  'content-types': 'settings', publishing: 'settings', ingest: 'settings', social: 'settings',
  payments: 'payments', apikeys: 'apps',
}
/** Sections open to any signed-in admin user (their own inbox). */
const OPEN_SECTIONS = new Set(['notifications', 'account'])
/** User Management is shown when ANY of its tabs is available. */
const USERS_FEATURES = ['users', 'access', 'viewers']

interface NavItem { key: string; label: string; icon: ReactElement; badge?: string }
interface NavGroup { group: string; items: NavItem[] }

const NAV: NavGroup[] = [
  { group: 'Overview', items: [
    { key: 'dashboard', label: 'Dashboard', icon: I.dash },
    { key: 'live', label: 'Live Streams', icon: I.live },
    { key: 'monitoring', label: 'Monitoring', icon: I.monitor },
    { key: 'fleet', label: 'Fleet & Usage', icon: I.fleet },
    { key: 'workflows', label: 'Workflows', icon: I.workflows },
  ] },
  { group: 'Broadcast', items: [
    { key: 'channels', label: 'Channels', icon: I.channels },
    { key: 'radio', label: 'Radio', icon: I.radio },
    { key: 'events', label: 'Events', icon: I.events },
    { key: 'fast', label: 'FAST', icon: I.fast },
    { key: 'epg', label: 'EPG', icon: I.epg },
    { key: 'loops', label: 'Loops & Fillers', icon: I.loops },
  ] },
  { group: 'Media', items: [
    { key: 'recordings', label: 'Recordings', icon: I.rec },
    { key: 'vod', label: 'Media Library', icon: I.vod },
    { key: 'images', label: 'Image Library', icon: I.images },
    { key: 'multiview', label: 'Multiview', icon: I.multiview },
    { key: 'review', label: 'Review', icon: I.review },
    { key: 'watchfolders', label: 'Watchfolders', icon: I.storage },
    { key: 'encoding', label: 'Encoding Profiles', icon: I.fleet },
    { key: 'storage', label: 'Storage', icon: I.storage },
  ] },
  { group: 'Insight', items: [
    { key: 'analytics', label: 'Analytics', icon: I.analytics },
    { key: 'audit', label: 'Audit log', icon: I.shield },
  ] },
]

export default function App() {
  const [authed, setAuthed] = useState(false)
  const [email, setEmail] = useState('admin@rtm.example')
  const [pw, setPw] = useState('volt1234')
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  const [me, setMe] = useState<Me | null>(null)
  // Whether /auth/me has ANSWERED, separate from what it said. Absent this,
  // "the access map has not arrived" and "the access map says nothing" were
  // the same state, and the gating below treated both as full access.
  const [meLoaded, setMeLoaded] = useState(false)
  // Re-render once the image signing key arrives, so thumbnails switch from the
  // original bytes to signed, resized derivatives (imageSigning.ts).
  useImageSigning()

  // The session ending is the API's news to deliver, not something a page can
  // work out. An expired token used to leave every screen showing the bare
  // string "401" and the status stream reconnecting every three seconds with
  // the same dead credential for as long as the tab stayed open.
  useEffect(() => {
    setUnauthorizedHandler(() => {
      setAuthed(false); setMe(null); setMeLoaded(false)
      setErr('Your session expired. Please sign in again.')
    })
    return () => setUnauthorizedHandler(null)
  }, [])

  // WHAT COUNTS AS "STILL HERE". Only real input, never API traffic: this
  // console polls levels every four seconds and the live board continuously, so
  // treating requests as presence would keep an abandoned tab signed in until
  // the fourteen-day cap. Passive listeners on the capture phase, so a handler
  // that stops propagation cannot hide the fact that somebody clicked.
  useEffect(() => {
    const opts = { capture: true, passive: true } as const
    const seen = () => noteActivity()
    for (const ev of ['pointerdown', 'keydown', 'wheel', 'touchstart'] as const) {
      window.addEventListener(ev, seen, opts)
    }
    // Coming back to the tab is the moment a lapsed token is about to be
    // noticed, so it counts as input and lets the next request renew quietly.
    const wake = () => { if (document.visibilityState === 'visible') noteActivity() }
    document.addEventListener('visibilitychange', wake)
    return () => {
      for (const ev of ['pointerdown', 'keydown', 'wheel', 'touchstart'] as const) {
        window.removeEventListener(ev, seen, opts)
      }
      document.removeEventListener('visibilitychange', wake)
    }
  }, [])

  // URL is the source of truth for section / open channel / create drawer
  const route = useRoute()
  const section = route.section
  const channelId = route.channelId
  const createOpen = route.create
  const [chooserOpen, setChooserOpen] = useState(false)
  const setCreateOpen = (open: boolean) => navigate(open ? '/channels/new' : '/channels', { replace: true })
  const openChannel = (id: string) => navigate(`/channels/${id}`)

  // THE BADGE at the foot of the menu: who is signed in and to which account.
  // Everything comes from /auth/me (the server), never from the email domain.
  const who = me?.displayName?.trim() || me?.email || email
  const initials = (who.includes('@') ? who.split('@')[0] : who).split(/[\s._-]+/).filter(Boolean).slice(0, 2).map(w => w[0]).join('').toUpperCase() || '·'
  const EXTRA_LABEL: Record<string, string> = { plan: 'Plan & limits', 'account-settings': 'Account settings', permissions: 'Permissions map', 'ui-samples': 'Notices and errors: samples', account: 'My account', groups: 'Channel Groups', apikeys: 'API Keys & Apps', users: 'Users & Roles', system: 'System Admin', 'content-types': 'Content Types', publishing: 'Publishing Rules', ingest: 'Ingest Rules', payments: 'Payments', notifications: 'Notifications', social: 'Social accounts' }
  const label = NAV.flatMap(g => g.items).find(i => i.key === section)?.label
    || EXTRA_LABEL[section]
    || (section ? section.charAt(0).toUpperCase() + section.slice(1) : 'Channels')

  useEffect(() => {
    document.title = channelId ? `VOLT · Channel` : `VOLT · ${label}`
  }, [channelId, label])

  // Two-step sign-in: the password answer may be a challenge instead of a session.
  const [step, setStep] = useState<MfaStep | null>(null)

  async function login(e: React.FormEvent) {
    e.preventDefault(); setErr(''); setBusy(true)
    try {
      const r = await api.login(email, pw)
      if (isMfaStep(r)) { setStep(r); setPw(''); return }
      finishSignIn(r)
    }
    catch (e: any) { setErr('Sign in failed: ' + e.message) } finally { setBusy(false) }
  }

  function finishSignIn(r: Session) {
    // THE WHOLE LOGIN RESPONSE, not just the access token. `r.refresh` used
    // to be dropped here, which is what capped every session at ACCESS_TTL of
    // wall clock however hard somebody was working. See api.ts.
    setSession(r); setStep(null); setAuthed(true)
    void ensureImageSigning()
    // The access map gates the nav and the buttons. If it cannot be read we
    // must know that, because the gating below now fails CLOSED: swallowing
    // the error used to show every user the full admin navigation, including
    // API Keys and User Management, and each of those pages then sat on
    // "Loading…" forever behind a 403.
    resetLiveBackoff()   // a fresh credential deserves a fresh attempt
    reloadMe()
  }
  function reloadMe() {
    api.me()
      .then((m) => { setMe(m); setMeLoaded(true) })
      .catch(() => { setMe(null); setMeLoaded(true) })
  }

  // FAIL CLOSED once the answer is in. Before /auth/me resolves we still show
  // everything, because hiding the whole app for the half-second it takes is
  // worse than briefly offering a link. Once it has answered and said nothing
  // — a 403, a timeout, a broken account — the admin surfaces are hidden
  // rather than offered and then refused.
  // ACCESS: one map from /auth/me drives the menu, the deep-link guard and
  // every button (access.tsx). FAIL CLOSED: nothing is shown until it answers.
  const access = makeAccess(me, meLoaded)
  const isAdmin = access.isAdminTier
  const sectionAllowed = (key: string): boolean => {
    if (!me) return false
    if (OPEN_SECTIONS.has(key)) return true
    if (key === 'users') return USERS_FEATURES.some(f => access.can(f, 'view'))
    if (key === 'system') return !!me.platformRole
    // The audit log is for account administrators (owner, admin).
    if (key === 'audit') return access.isAdminTier
    // The notices and errors reference page: anyone signed in (it calls no API).
    if (key === 'ui-samples') return true
    const f = NAV_FEATURE[key]
    return f ? access.can(f, 'view') : false
  }
  const ADMIN_ITEMS: NavItem[] = [
    { key: 'account-settings', label: 'Account settings', icon: I.palette },
    { key: 'plan', label: 'Plan & limits', icon: I.fleet },
    { key: 'groups', label: 'Channel Groups', icon: I.channels },
    { key: 'content-types', label: 'Content Types', icon: I.epg },
    { key: 'publishing', label: 'Publishing Rules', icon: I.vod },
    { key: 'ingest', label: 'Ingest Rules', icon: I.vod },
    { key: 'payments', label: 'Payments', icon: I.fleet },
    { key: 'social', label: 'Social accounts', icon: I.vod },
    { key: 'notifications', label: 'Notifications', icon: I.bell },
    { key: 'apikeys', label: 'API Keys & Apps', icon: I.key },
    { key: 'users', label: 'Users & Roles', icon: I.users },
    { key: 'permissions', label: 'Permissions map', icon: I.shield },
  ]
  const nav: NavGroup[] = [
    ...NAV.map(g => ({ ...g, items: g.items.filter(it => sectionAllowed(it.key)) }))
      .filter(g => g.items.length > 0),
    ...[{ group: 'Admin', items: ADMIN_ITEMS.filter(it => sectionAllowed(it.key)) }].filter(g => g.items.length > 0),
    ...(me?.platformRole ? [{ group: 'System', items: [
      { key: 'system', label: 'System Admin', icon: I.shield },
    ] }] : []),
  ]
  // A deep link to a section the role does not include gets a clear answer
  // rather than a page of failed requests.
  const blocked = !!me && !!section && !sectionAllowed(section)
  // Landing on "/" (Channels) with a role that has no TV: go to the first
  // section the role does include instead of a "no access" page.
  const firstAllowed = nav[0]?.items[0]?.key
  useEffect(() => {
    if (blocked && window.location.pathname === '/' && firstAllowed) navigate('/' + firstAllowed, { replace: true })
  }, [blocked, firstAllowed])

  if (!authed) {
    return (
      <div style={{ minHeight: '100vh', display: 'grid', placeItems: 'center' }}>
        {step ? (
          <div className="card" style={{ width: 380, padding: 28 }}>
            <div className="brand" style={{ padding: '0 0 14px' }}>
              <div className="logo">{BOLT}</div>
              <div><div className="n">Volt Streaming</div><div className="s">{email}</div></div>
            </div>
            <SignInSecondStep step={step} onSession={finishSignIn} onCancel={() => { setStep(null); setErr('') }} />
          </div>
        ) : (
        <form onSubmit={login} className="card" style={{ width: 360, padding: 28 }}>
          <div className="brand" style={{ padding: '0 0 14px' }}>
            <div className="logo">{BOLT}</div>
            <div><div className="n">Volt Streaming</div><div className="s">Live streaming platform</div></div>
          </div>
          {/* type and autoComplete are not decoration on a sign-in form: they
              are what makes a phone offer the right keyboard, what lets a
              password manager fill the pair, and what lets anything driving
              the page find the fields by role instead of by position. */}
          <div className="field"><label htmlFor="signin-email">Email</label>
            <input id="signin-email" name="email" className="inp" type="email"
              autoComplete="username" autoCapitalize="none" spellCheck={false}
              value={email} onChange={e => setEmail(e.target.value)} /></div>
          <div className="field"><label htmlFor="signin-pw">Password</label>
            <input id="signin-pw" name="password" className="inp" type="password"
              autoComplete="current-password"
              value={pw} onChange={e => setPw(e.target.value)} /></div>
          {/* outside the shell (no page region): a compact notice in the form */}
          {err && <div style={{ marginBottom: 10 }}><Notice kind="error" variant="compact" message={err} /></div>}
          <button className="btn primary" style={{ width: '100%', justifyContent: 'center', marginTop: 6 }} disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}</button>
        </form>
        )}
      </div>
    )
  }

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">
          <div className="logo">{BOLT}</div>
          <div><div className="n">Volt Streaming</div><div className="s">Live streaming platform</div></div>
        </div>
        <nav className="nav">
          {nav.map(g => (
            <div key={g.group}>
              <div className="nav-group">{g.group}</div>
              {g.items.map(it => {
                const href = hrefFor({ section: it.key })
                return (
                  <a key={it.key} href={href} className={`nav-item ${section === it.key ? 'active' : ''}`}
                    style={{ textDecoration: 'none', color: 'inherit' }}
                    onClick={e => { if (e.metaKey || e.ctrlKey || e.button === 1) return; e.preventDefault(); navigate(href) }}>
                    {it.icon}{it.label}{it.badge && <span className="badge live">{it.badge}</span>}
                  </a>
                )
              })}
            </div>
          ))}
        </nav>
        <a className="side-foot" href="/account" title="My account: profile, email, password and two-step sign-in"
          style={{ textDecoration: 'none', color: 'inherit' }}
          onClick={e => { if (e.metaKey || e.ctrlKey || e.button === 1) return; e.preventDefault(); navigate('/account') }}>
          <div className="avatar">{initials}</div>
          <div style={{ minWidth: 0 }}><div className="nm" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{who}</div><div className="rl">
            {me?.account?.name ?? ''}{me ? ` · ${me.roles?.length ? me.roles.map(r => r.name).join(', ') : me.role.charAt(0).toUpperCase() + me.role.slice(1)}` : ''}
          </div></div>
        </a>
      </aside>

      <div className="main">
        <IngestQueue />
        <div className="topbar">
          {/* THE TOP BAR IS FOR GLOBAL ACTIONS ONLY: search, uploads, notices, New
              Stream, sign out. The page names itself in its own title. */}
          <GlobalSearch />
          <div className="top-actions">
            <UploadIndicator />
            <NotificationBell canManage={isAdmin} />
            {/* NEW STREAM asks which kind first (NewStreamChooser), then opens that form. */}
            {(access.can('channels', 'manage') || access.can('events', 'manage') || access.can('radio', 'manage')) && (
              <button className="btn primary" onClick={() => setChooserOpen(true)} aria-haspopup="dialog">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4"><path d="M12 5v14M5 12h14" /></svg>New Stream
              </button>
            )}
            <DocsButton />
            <div className="icon-btn" title="Sign out"
              {...pressable(() => {
                // Revoke the refresh token server-side before dropping it, or
                // signing out would leave a fourteen-day credential live.
                api.logout().catch(() => { /* local sign-out proceeds regardless */ })
                setAuthed(false); clearSession(); setMe(null)
              }, { label: 'Sign out' })}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4M16 17l5-5-5-5M21 12H9" /></svg>
            </div>
          </div>
        </div>
        {/* GLOBAL notices (notices.tsx): app-wide states, under the top bar. */}
        <GlobalNotices />
        <div className="content">
          {/* One broken section stays one broken section. Keyed on the route so
              navigating away clears it rather than trapping the operator. */}
          <AccessProvider value={access}>
          {/* PAGE notices: one region at the top of the content, cleared per route. */}
          <PageNoticesProvider key={`${route.path}`}>
          <ErrorBoundary resetKey={`${section}:${channelId ?? ''}`} label={label}>
          <RoleHint text={(() => {
            // Pages not individually gated yet still say what the role allows;
            // the API refuses the rest with a message naming the feature.
            const f = NAV_FEATURE[section]
            const gated = ['channels', 'radio', 'events', 'users', 'groups'].includes(section)
            if (!me || !f || gated || blocked || access.can(f, 'manage')) return null
            return access.can(f, 'operate') ? 'Your role lets you run items here but not change their settings.' : 'Your role lets you view this section but not change anything in it.'
          })()} />
          {!meLoaded ? <div className="loading">Loading…</div>
            : blocked ? <NoAccess title={label} />
            : section === 'channels'
            ? (channelId
                ? <ChannelDetail key={channelId} id={channelId} onBack={() => navigate('/channels')} />
                : <Channels createOpen={createOpen} setCreateOpen={setCreateOpen} onOpen={openChannel} />)
            : section === 'images'
            ? <ImageLibrary />
            : section === 'watchfolders'
            ? <Watchfolders />
            : section === 'encoding'
            ? <EncodingProfiles />
            : section === 'recordings'
            ? (route.recordingId
                ? <RecordingDetail key={route.recordingId} id={route.recordingId} onBack={() => navigate('/recordings')} />
                : route.recordingSource
                ? <RecordingSourceView key={route.recordingSource.id} id={route.recordingSource.id} onBack={() => navigate('/recordings')} />
                : <Recordings />)
            : section === 'review'
            ? <ReviewPage />
            : section === 'vod'
            ? <VodPage />
            : section === 'loops'
            ? <LoopsPage />
            : section === 'storage'
            ? <StoragePage />
            : section === 'analytics'
            ? <AnalyticsPage />
            : section === 'audit'
            ? <AuditLogPage />
            : section === 'live'
            ? <LivePage />
            : section === 'monitoring'
            ? <MonitoringPage />
            : section === 'fleet'
            ? <FleetPage />
            : section === 'workflows'
            ? <WorkflowsPage canManage={access.can('settings', 'manage')} />
            : section === 'dashboard'
            ? <DashboardPage />
            : section === 'multiview'
            ? <MultiviewPage />
            : section === 'events'
            ? <Events />
            : section === 'fast'
            ? <FastPage path={route.path} />
            : section === 'epg'
            ? (route.epgOwner
                ? <EpgDetail key={route.epgOwner.kind + route.epgOwner.id} owner={route.epgOwner} onBack={() => navigate('/epg')} />
                : <Epg />)
            : section === 'radio'
            ? (route.radioPlayerId
                ? <PlayerSetup key={route.radioPlayerId} id={route.radioPlayerId}
                    onBack={() => navigate(`/radio/${route.radioPlayerId}`)} />
                : route.radioId
                ? <RadioDetail key={route.radioId} id={route.radioId} onBack={() => navigate('/radio')} />
                : <Radio />)
            : section === 'content-types'
            ? <ContentTypesPage />
            : section === 'publishing'
            ? <PublishingPage />
            : section === 'ingest'
            ? <IngestRulesPage />
            : section === 'payments'
            ? <PaymentsPage />
            : section === 'notifications'
            ? <NotificationsPage />
            : section === 'social'
            ? <SocialAccountsPage />
            : section === 'apikeys'
            ? <ApiKeys />
            : section === 'users'
            ? <Users />
            : section === 'account' && me
            ? <AccountPage me={me} onChanged={reloadMe} />
            : section === 'groups'
            ? <ChannelGroupsPage />
            : section === 'plan'
            ? <PlanLimitsPage />
            : section === 'account-settings'
            ? <AccountSettingsPage />
            : section === 'permissions'
            ? <PermissionsMapPage />
            : section === 'system'
            ? <SystemAdmin />
            : section === 'ui-samples'
            ? <UiSamplesPage />
            : <Placeholder title={label} />}
          </ErrorBoundary>
          </PageNoticesProvider>
          {chooserOpen && <NewStreamChooser onClose={() => setChooserOpen(false)} />}
          </AccessProvider>
        </div>
      </div>
    </div>
  )
}

function NoAccess({ title }: { title: string }) {
  return (
    <>
      <div className="page-head"><div><h1>{title}</h1><p>Your role does not include this section.</p></div></div>
      <div className="empty"><div className="ic">{I.shield}</div><h3>No access</h3><p>Ask an administrator for a role that includes it.</p></div>
    </>
  )
}

function Placeholder({ title }: { title: string }) {
  return (
    <>
      <div className="page-head"><div><h1>{title}</h1><p>Coming next — we're building the app section by section.</p></div></div>
      <div className="empty"><div className="ic">{I.live}</div><h3>{title}</h3><p>This section is on the roadmap. Channels is wired to the live control plane today.</p></div>
    </>
  )
}

/* Site-wide search (top panel): account-scoped match across channels, events and
   recordings, with a results dropdown that navigates on click. Debounced. */
function GlobalSearch() {
  const [q, setQ] = useState('')
  const [hits, setHits] = useState<SearchHit[] | null>(null)
  const [open, setOpen] = useState(false)
  const boxRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    if (!q.trim()) { setHits(null); return }
    const t = setTimeout(async () => {
      try { setHits((await api.search(q.trim())).results) } catch { setHits([]) }
    }, 220)
    return () => clearTimeout(t)
  }, [q])
  useEffect(() => {
    const onDoc = (e: MouseEvent) => { if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false) }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [])
  function go(h: SearchHit) { setOpen(false); setQ(''); setHits(null); navigate(h.href) }
  // WHAT THE THING IS, and the label has to be right because the row is also a
  // LINK. A radio station used to come back labelled "Channel" and href'd to
  // /channels/<id>, so searching for a station opened the television control
  // page: a 16:9 video surface, no audio visualiser, no now-playing log, no
  // station settings. The label was a symptom; the href was the fault.
  //
  // Both came from search.ts hardcoding `kind: 'channel'` for every row in the
  // channels table. `channels.kind` has said 'tv' | 'radio' since the first
  // migration; nothing was wrong with the data.
  const KIND: Record<string, string> = {
    channel: 'Channel', radio: 'Radio', event: 'Event', recording: 'Recording',
  }
  // Colour the kind the way the rest of the console does, so a station reads as
  // a station at a glance rather than only on the words.
  const KIND_COLOR: Record<string, string> = {
    channel: '#7dd3fc', radio: '#6ee7b7', event: '#fca5a5', recording: 'var(--brand)',
  }
  return (
    <div className="search" ref={boxRef} style={{ position: 'relative' }}>
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="11" cy="11" r="7" /><path d="m21 21-4-4" /></svg>
      <input placeholder="Search channels, stations, events, recordings…" value={q}
        onChange={e => { setQ(e.target.value); setOpen(true) }} onFocus={() => setOpen(true)} />
      {open && q.trim() && (
        <div style={{ position: 'absolute', top: 'calc(100% + 6px)', left: 0, right: 0, background: 'var(--panel,#0e1420)', border: '1px solid var(--border)', borderRadius: 10, boxShadow: '0 10px 30px rgba(0,0,0,.45)', zIndex: 70, overflow: 'hidden', maxHeight: 360, overflowY: 'auto' }}>
          {hits === null ? <div style={{ padding: '10px 12px', color: 'var(--faint)', fontSize: 'var(--fs-body)' }}>Searching…</div>
            : hits.length === 0 ? <div style={{ padding: '10px 12px', color: 'var(--faint)', fontSize: 'var(--fs-body)' }}>No matches for “{q.trim()}”.</div>
            : hits.map(h => (
              <div key={h.kind + h.id} {...openable(() => go(h), h.name)} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '9px 12px', cursor: 'pointer', borderTop: '1px solid var(--border)' }}
                onMouseDown={e => e.preventDefault()}>
                <span style={{ fontSize: 'var(--fs-micro)', fontWeight: 700, color: KIND_COLOR[h.kind] ?? 'var(--brand)', width: 68, flex: 'none', textTransform: 'uppercase' }}>{KIND[h.kind] || h.kind}</span>
                <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{h.name}</span>
                {h.sub && <span style={{ fontSize: 'var(--fs-label)', color: 'var(--faint)' }}>{h.sub}</span>}
              </div>
            ))}
        </div>
      )}
    </div>
  )
}

/** What the role allows on this page, as an info notice in the page region. */
function RoleHint({ text }: { text: string | null }) {
  usePageNotice('role', text ? { kind: 'info', message: text } : null)
  return null
}
