import { useState, useEffect, useRef, type ReactElement } from 'react'
import { api, setToken, type SearchHit, type Me } from './api'
import Channels from './pages/Channels'
import ChannelDetail from './pages/ChannelDetail'
import ImageLibrary from './pages/ImageLibrary'
import Recordings from './pages/Recordings'
import RecordingDetail from './pages/RecordingDetail'
import Events from './pages/Events'
import Epg from './pages/Epg'
import EpgDetail from './pages/EpgDetail'
import ApiKeys from './pages/ApiKeys'
import Users from './pages/Users'
import SystemAdmin from './pages/SystemAdmin'
import { useRoute, navigate, hrefFor } from './router'
import { UploadIndicator } from './uploads'

const BOLT = <svg viewBox="0 0 24 24" fill="currentColor"><path d="M13 2 4 14h6l-1 8 9-12h-6z" /></svg>

const I = {
  dash: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="3" width="7" height="7" rx="1" /><rect x="14" y="3" width="7" height="7" rx="1" /><rect x="3" y="14" width="7" height="7" rx="1" /><rect x="14" y="14" width="7" height="7" rx="1" /></svg>,
  live: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="2" /><path d="M4.9 4.9a10 10 0 000 14.2M19.1 4.9a10 10 0 010 14.2M7.8 7.8a6 6 0 000 8.4M16.2 7.8a6 6 0 010 8.4" /></svg>,
  monitor: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="2" y="4" width="20" height="14" rx="2" /><path d="M8 21h8M12 18v3" /></svg>,
  channels: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="2" y="7" width="20" height="13" rx="2" /><path d="m17 2-5 5-5-5" /></svg>,
  events: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="4" width="18" height="18" rx="2" /><path d="M16 2v4M8 2v4M3 10h18" /></svg>,
  loops: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M17 2l4 4-4 4" /><path d="M3 11v-1a4 4 0 014-4h14M7 22l-4-4 4-4" /><path d="M21 13v1a4 4 0 01-4 4H3" /></svg>,
  rec: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="9" /><circle cx="12" cy="12" r="3" /></svg>,
  vod: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="m22 8-6 4 6 4V8z" /><rect x="2" y="6" width="14" height="12" rx="2" /></svg>,
  images: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="3" width="18" height="18" rx="2" /><circle cx="9" cy="9" r="2" /><path d="m21 15-5-5L5 21" /></svg>,
  multiview: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="3" width="7" height="7" rx="1" /><rect x="14" y="3" width="7" height="7" rx="1" /><rect x="3" y="14" width="7" height="7" rx="1" /><rect x="14" y="14" width="7" height="7" rx="1" /></svg>,
  analytics: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 3v18h18" /><path d="m7 14 4-4 3 3 5-6" /></svg>,
  epg: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M3 9h18M8 4v16M3 14h18" /></svg>,
  key: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 2l-2 2m-7.6 7.6a5.5 5.5 0 11-7.8 7.8 5.5 5.5 0 017.8-7.8zm0 0L15 8m-2 2 4-4m0 0 3 3 3-3-3-3" /></svg>,
  users: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2" /><circle cx="9" cy="7" r="4" /><path d="M23 21v-2a4 4 0 00-3-3.87M16 3.13a4 4 0 010 7.75" /></svg>,
  shield: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" /></svg>,
}

/** Which FEATURE (from /auth/me) each content nav item belongs to; items whose
 *  feature the user's group sets to 'none' are hidden so the nav matches the API. */
const NAV_FEATURE: Record<string, string> = {
  channels: 'channels', events: 'events', epg: 'epg', loops: 'media',
  recordings: 'recordings', vod: 'vod', images: 'media', analytics: 'analytics',
}

const NAV: { group: string; items: { key: string; label: string; icon: ReactElement; badge?: string }[] }[] = [
  { group: 'Overview', items: [
    { key: 'dashboard', label: 'Dashboard', icon: I.dash },
    { key: 'live', label: 'Live Streams', icon: I.live },
    { key: 'monitoring', label: 'Monitoring', icon: I.monitor },
  ] },
  { group: 'Broadcast', items: [
    { key: 'channels', label: 'Channels', icon: I.channels },
    { key: 'events', label: 'Events', icon: I.events },
    { key: 'epg', label: 'EPG', icon: I.epg },
    { key: 'loops', label: 'Loops & Fillers', icon: I.loops },
  ] },
  { group: 'Media', items: [
    { key: 'recordings', label: 'Recordings', icon: I.rec },
    { key: 'vod', label: 'VOD Library', icon: I.vod },
    { key: 'images', label: 'Image Library', icon: I.images },
    { key: 'multiview', label: 'Multiview', icon: I.multiview },
  ] },
  { group: 'Insight', items: [
    { key: 'analytics', label: 'Analytics', icon: I.analytics },
  ] },
]

export default function App() {
  const [authed, setAuthed] = useState(false)
  const [email, setEmail] = useState('admin@rtm.example')
  const [pw, setPw] = useState('volt1234')
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  const [me, setMe] = useState<Me | null>(null)

  // URL is the source of truth for section / open channel / create drawer
  const route = useRoute()
  const section = route.section
  const channelId = route.channelId
  const createOpen = route.create
  const setCreateOpen = (open: boolean) => navigate(open ? '/channels/new' : '/channels', { replace: true })
  const openChannel = (id: string) => navigate(`/channels/${id}`)

  const account = email.split('@')[1]?.split('.')[0]?.toUpperCase() || 'RTM'
  const EXTRA_LABEL: Record<string, string> = { apikeys: 'API Keys & Apps', users: 'User Management', system: 'System Admin' }
  const label = NAV.flatMap(g => g.items).find(i => i.key === section)?.label
    || EXTRA_LABEL[section]
    || (section ? section.charAt(0).toUpperCase() + section.slice(1) : 'Channels')

  useEffect(() => {
    document.title = channelId ? `VOLT · Channel` : `VOLT · ${label}`
  }, [channelId, label])

  async function login(e: React.FormEvent) {
    e.preventDefault(); setErr(''); setBusy(true)
    try {
      const r = await api.login(email, pw); setToken(r.access); setAuthed(true)
      api.me().then(setMe).catch(() => {})   // access map for nav/button gating
    }
    catch (e: any) { setErr('Sign in failed: ' + e.message) } finally { setBusy(false) }
  }

  const isAdmin = !me || me.role === 'admin' || me.role === 'owner'
  const featureLevel = (key: string): string => {
    if (!me) return 'manage'                     // before /me resolves, show all
    const f = NAV_FEATURE[key]
    if (!f) return 'view'                        // unmapped items stay visible
    return me.features?.[f] ?? 'manage'
  }
  const nav = [
    ...NAV.map(g => ({ ...g, items: g.items.filter(it => featureLevel(it.key) !== 'none') }))
      .filter(g => g.items.length > 0),
    ...(isAdmin ? [{ group: 'Admin', items: [
      { key: 'apikeys', label: 'API Keys & Apps', icon: I.key },
      { key: 'users', label: 'User Management', icon: I.users },
    ] }] : []),
    ...(me?.platformRole ? [{ group: 'System', items: [
      { key: 'system', label: 'System Admin', icon: I.shield },
    ] }] : []),
  ]

  if (!authed) {
    return (
      <div style={{ minHeight: '100vh', display: 'grid', placeItems: 'center' }}>
        <form onSubmit={login} className="card" style={{ width: 360, padding: 28 }}>
          <div className="brand" style={{ padding: '0 0 14px' }}>
            <div className="logo">{BOLT}</div>
            <div><div className="n">VOLT Stream</div><div className="s">OTT Streaming Platform</div></div>
          </div>
          <div className="field"><label>Email</label><input className="inp" value={email} onChange={e => setEmail(e.target.value)} /></div>
          <div className="field"><label>Password</label><input className="inp" type="password" value={pw} onChange={e => setPw(e.target.value)} /></div>
          {err && <div className="err">{err}</div>}
          <button className="btn primary" style={{ width: '100%', justifyContent: 'center', marginTop: 6 }} disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}</button>
        </form>
      </div>
    )
  }

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">
          <div className="logo">{BOLT}</div>
          <div><div className="n">VOLT Stream</div><div className="s">OTT Streaming Platform</div></div>
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
        <div className="side-foot">
          <div className="avatar">{account.slice(0, 2)}</div>
          <div><div className="nm">{email.split('@')[0]}</div><div className="rl">
            {(me?.account?.name || account)} · {me ? (me.role.charAt(0).toUpperCase() + me.role.slice(1)) : 'Admin'}
            {me?.userGroupName ? ` · ${me.userGroupName}` : ''}
          </div></div>
        </div>
      </aside>

      <div className="main">
        <div className="topbar">
          <div className="crumb"><b>{label}</b></div>
          <GlobalSearch />
          <div className="top-actions">
            <UploadIndicator />
            <div className="icon-btn"><span className="dot"></span><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 8a6 6 0 00-12 0c0 7-3 9-3 9h18s-3-2-3-9M13.7 21a2 2 0 01-3.4 0" /></svg></div>
            <button className="btn primary" onClick={() => navigate('/channels/new')}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4"><path d="M12 5v14M5 12h14" /></svg>New Stream
            </button>
            <div className="icon-btn" title="Sign out" onClick={() => { setAuthed(false); setToken(''); setMe(null) }}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4M16 17l5-5-5-5M21 12H9" /></svg>
            </div>
          </div>
        </div>
        <div className="content">
          {section === 'channels'
            ? (channelId
                ? <ChannelDetail key={channelId} id={channelId} onBack={() => navigate('/channels')} />
                : <Channels createOpen={createOpen} setCreateOpen={setCreateOpen} onOpen={openChannel} />)
            : section === 'images'
            ? <ImageLibrary />
            : section === 'recordings'
            ? (route.recordingId
                ? <RecordingDetail key={route.recordingId} id={route.recordingId} onBack={() => navigate('/recordings')} />
                : <Recordings />)
            : section === 'events'
            ? <Events />
            : section === 'epg'
            ? (route.epgOwner
                ? <EpgDetail key={route.epgOwner.kind + route.epgOwner.id} owner={route.epgOwner} onBack={() => navigate('/epg')} />
                : <Epg />)
            : section === 'apikeys'
            ? <ApiKeys />
            : section === 'users'
            ? <Users />
            : section === 'system'
            ? <SystemAdmin />
            : <Placeholder title={label} />}
        </div>
      </div>
    </div>
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
  const KIND: Record<string, string> = { channel: 'Channel', event: 'Event', recording: 'Recording' }
  return (
    <div className="search" ref={boxRef} style={{ position: 'relative' }}>
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="11" cy="11" r="7" /><path d="m21 21-4-4" /></svg>
      <input placeholder="Search channels, events, recordings…" value={q}
        onChange={e => { setQ(e.target.value); setOpen(true) }} onFocus={() => setOpen(true)} />
      {open && q.trim() && (
        <div style={{ position: 'absolute', top: 'calc(100% + 6px)', left: 0, right: 0, background: 'var(--panel,#0e1420)', border: '1px solid var(--border)', borderRadius: 10, boxShadow: '0 10px 30px rgba(0,0,0,.45)', zIndex: 70, overflow: 'hidden', maxHeight: 360, overflowY: 'auto' }}>
          {hits === null ? <div style={{ padding: '10px 12px', color: 'var(--faint)', fontSize: 13 }}>Searching…</div>
            : hits.length === 0 ? <div style={{ padding: '10px 12px', color: 'var(--faint)', fontSize: 13 }}>No matches for “{q.trim()}”.</div>
            : hits.map(h => (
              <div key={h.kind + h.id} onClick={() => go(h)} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '9px 12px', cursor: 'pointer', borderTop: '1px solid var(--border)' }}
                onMouseDown={e => e.preventDefault()}>
                <span style={{ fontSize: 10, fontWeight: 700, color: 'var(--brand)', width: 68, flex: 'none', textTransform: 'uppercase' }}>{KIND[h.kind] || h.kind}</span>
                <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{h.name}</span>
                {h.sub && <span style={{ fontSize: 11, color: 'var(--faint)' }}>{h.sub}</span>}
              </div>
            ))}
        </div>
      )}
    </div>
  )
}
