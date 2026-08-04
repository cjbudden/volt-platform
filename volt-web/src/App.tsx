import { useState } from 'react'
import { api, setToken } from './api'
import Channels from './pages/Channels'

const NAV = [
  { key: 'overview', label: 'Overview', icon: '◧' },
  { key: 'channels', label: 'Channels', icon: '▤' },
  { key: 'events', label: 'Events', icon: '◈' },
  { key: 'epg', label: 'EPG', icon: '▦' },
  { key: 'vod', label: 'VOD library', icon: '▷' },
  { key: 'media', label: 'Media & files', icon: '❐' },
  { key: 'analytics', label: 'Analytics', icon: '◔' },
  { key: 'settings', label: 'Settings', icon: '⚙' },
]

export default function App() {
  const [authed, setAuthed] = useState(false)
  const [account, setAccount] = useState('')
  const [email, setEmail] = useState('admin@rtm.example')
  const [pw, setPw] = useState('volt1234')
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  const [section, setSection] = useState('channels')

  async function login(e: React.FormEvent) {
    e.preventDefault(); setErr(''); setBusy(true)
    try {
      const r = await api.login(email, pw)
      setToken(r.access)
      setAccount(email.split('@')[1]?.split('.')[0]?.toUpperCase() || 'Account')
      setAuthed(true)
    } catch (e: any) { setErr('Sign in failed: ' + e.message) }
    finally { setBusy(false) }
  }

  if (!authed) {
    return (
      <div className="h-full grid place-items-center">
        <form onSubmit={login} className="w-[360px] rounded-2xl border border-[#242833] bg-[#14161d] p-7">
          <div className="flex items-center gap-2 text-xl font-extrabold mb-1"><span className="text-indigo-400">⚡</span> Volt</div>
          <div className="text-[#98a0ad] text-xs mb-6">Sign in to the control plane</div>
          <label className="block text-[11px] uppercase tracking-wide text-[#98a0ad] mb-1">Email</label>
          <input value={email} onChange={e => setEmail(e.target.value)} className="w-full mb-3 rounded-lg bg-[#0e1017] border border-[#242833] px-3 py-2.5 outline-none focus:border-indigo-500" />
          <label className="block text-[11px] uppercase tracking-wide text-[#98a0ad] mb-1">Password</label>
          <input type="password" value={pw} onChange={e => setPw(e.target.value)} className="w-full mb-5 rounded-lg bg-[#0e1017] border border-[#242833] px-3 py-2.5 outline-none focus:border-indigo-500" />
          {err && <div className="text-red-400 text-xs mb-3">{err}</div>}
          <button disabled={busy} className="w-full rounded-lg bg-blue-600 hover:bg-blue-500 py-2.5 font-semibold disabled:opacity-50">{busy ? 'Signing in…' : 'Sign in'}</button>
        </form>
      </div>
    )
  }

  return (
    <div className="h-full flex">
      <aside className="w-60 shrink-0 border-r border-[#242833] bg-[#0e1017] flex flex-col">
        <div className="px-5 py-4 flex items-center gap-2 text-lg font-extrabold border-b border-[#242833]">
          <span className="text-indigo-400">⚡</span> Volt
        </div>
        <nav className="p-3 flex-1">
          {NAV.map(n => (
            <button key={n.key} onClick={() => setSection(n.key)}
              className={`w-full flex items-center gap-3 rounded-lg px-3 py-2 text-sm mb-0.5 text-left ${section === n.key ? 'bg-blue-600/15 text-white border border-blue-600/40' : 'text-[#9aa3b2] hover:bg-white/5 border border-transparent'}`}>
              <span className="w-4 text-center opacity-80">{n.icon}</span>{n.label}
            </button>
          ))}
        </nav>
        <div className="p-3 text-[11px] text-[#6b7280] border-t border-[#242833]">v0.1 · control plane</div>
      </aside>

      <div className="flex-1 flex flex-col min-w-0">
        <header className="h-14 shrink-0 border-b border-[#242833] flex items-center justify-between px-6">
          <div className="text-sm text-[#98a0ad] capitalize">{section}</div>
          <div className="flex items-center gap-3 text-sm">
            <span className="text-[#98a0ad]">{account} · {email}</span>
            <button onClick={() => { setAuthed(false); setToken('') }} className="rounded-lg border border-[#242833] px-3 py-1.5 hover:bg-white/5">Sign out</button>
          </div>
        </header>
        <main className="flex-1 overflow-auto p-6">
          {section === 'channels' ? <Channels /> : <Placeholder title={NAV.find(n => n.key === section)?.label || ''} />}
        </main>
      </div>
    </div>
  )
}

function Placeholder({ title }: { title: string }) {
  return (
    <div className="h-full grid place-items-center text-center">
      <div>
        <div className="text-2xl font-bold mb-1">{title}</div>
        <div className="text-[#98a0ad] text-sm">Coming next. We're building the app section by section, starting with Channels.</div>
      </div>
    </div>
  )
}
