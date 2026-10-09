import { useEffect, useRef, useState } from 'react'
import { api, type InboxItem } from './api'
import { navigate } from './router'
import { pressable } from './a11y'

/* ============================================================================
   THE BELL. It used to be a drawing with a red dot that was always on and
   meant nothing. It is now the signed-in user's inbox: the dot and the count
   are real unread messages (auto connect giving up, an import that failed, a
   post that could not be published), and opening one marks it read.

   Polled once a minute and whenever the tab comes back into view, which is
   enough for alerts that are about minutes, not milliseconds.
   ========================================================================== */
const when = (iso: string) => {
  const d = new Date(iso); const mins = Math.round((Date.now() - d.getTime()) / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins} min ago`
  if (mins < 24 * 60) return `${Math.round(mins / 60)} h ago`
  return d.toLocaleDateString([], { day: '2-digit', month: 'short' })
}

export default function NotificationBell({ canManage }: { canManage: boolean }) {
  const [items, setItems] = useState<InboxItem[]>([])
  const [unread, setUnread] = useState(0)
  const [open, setOpen] = useState(false)
  const [expanded, setExpanded] = useState<string | null>(null)
  const box = useRef<HTMLDivElement>(null)

  const load = () => api.inbox().then(r => { setItems(r.items.slice(0, 30)); setUnread(r.unread) }).catch(() => { /* bell stays quiet */ })
  useEffect(() => {
    load()
    const t = setInterval(load, 60_000)
    const vis = () => { if (document.visibilityState === 'visible') load() }
    document.addEventListener('visibilitychange', vis)
    return () => { clearInterval(t); document.removeEventListener('visibilitychange', vis) }
  }, [])
  useEffect(() => {
    if (!open) return
    const out = (e: MouseEvent) => { if (box.current && !box.current.contains(e.target as Node)) setOpen(false) }
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', out); document.addEventListener('keydown', esc)
    return () => { document.removeEventListener('mousedown', out); document.removeEventListener('keydown', esc) }
  }, [open])

  async function openItem(it: InboxItem) {
    setExpanded(x => (x === it.id ? null : it.id))
    if (!it.read_at) {
      setItems(xs => xs.map(x => x.id === it.id ? { ...x, read_at: new Date().toISOString() } : x))
      setUnread(n => Math.max(0, n - 1))
      api.markRead(it.id).catch(() => load())
    }
  }

  return (
    <div ref={box} style={{ position: 'relative' }}>
      <div className="icon-btn" {...pressable(() => { setOpen(o => !o); if (!open) load() }, { label: unread ? `Notifications, ${unread} unread` : 'Notifications' })}>
        {unread > 0 && <span className="bell-count">{unread > 99 ? '99+' : unread}</span>}
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 8a6 6 0 00-12 0c0 7-3 9-3 9h18s-3-2-3-9M13.7 21a2 2 0 01-3.4 0" /></svg>
      </div>
      {open && (
        <div className="bell-pop" role="dialog" aria-label="Notifications">
          <div className="bell-head">
            <b>Notifications</b>
            <div style={{ flex: 1 }} />
            {unread > 0 && <button className="btn ghost" onClick={() => { api.markAllRead().then(load) }}>Mark all read</button>}
          </div>
          <div className="bell-list">
            {items.length === 0 ? <div className="bell-empty">Nothing yet. Alerts about your channels, imports and publishing land here.</div>
              : items.map(it => (
                <div key={it.id} className={`bell-item ${it.read_at ? '' : 'unread'}`} {...pressable(() => openItem(it), { label: it.subject })}>
                  <div className="bell-row">
                    {!it.read_at && <span className="bell-dot" aria-hidden="true" />}
                    <span className="bell-subj">{it.subject}</span>
                    <span className="bell-when">{when(it.created_at)}</span>
                  </div>
                  {expanded === it.id && it.body && <div className="bell-body">{it.body}</div>}
                </div>
              ))}
          </div>
          {canManage && (
            <div className="bell-foot">
              <button className="btn ghost" onClick={() => { setOpen(false); navigate('/notifications') }}>Notification settings and log</button>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
