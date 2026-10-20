// ============================================================================
//  NEW STREAM: the top bar's one "create" button asks what kind of stream,
//  then opens that kind's own form.
//
//    24x7 channel   -> /channels/new   (the New channel drawer)
//    Event          -> /events?new     (the New event drawer)
//    Radio station  -> /radio?new      (the New station drawer)
//    FAST channel   -> coming soon (shown, not selectable)
//
//  A kind the role cannot create, or that has no room (every group full), is
//  shown disabled with the reason, so the choice explains itself rather than
//  hiding options.
// ============================================================================
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { api, type Group, type PlanView } from './api'
import { useAccess } from './access'
import { navigate } from './router'
import { noRoomReason, planFullReason } from './lib/capacity'

interface Kind {
  key: string; title: string; desc: string; icon: ReactNode; to?: string
  disabledReason?: string | null; badge?: string
}

const I = {
  channel: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="2" y="7" width="20" height="13" rx="2" /><path d="m17 2-5 5-5-5" /></svg>,
  event: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="4" width="18" height="18" rx="2" /><path d="M16 2v4M8 2v4M3 10h18M8 14h3v3H8z" /></svg>,
  radio: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M4 11h16a1 1 0 0 1 1 1v7a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-7a1 1 0 0 1 1-1z" /><circle cx="8" cy="15.5" r="2.5" /><path d="M17 14h2M17 17h2M18 3 7 8" /></svg>,
  fast: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="2" y="5" width="20" height="14" rx="2" /><path d="M7 9h4M7 12h7M7 15h5M17 9v6" /></svg>,
}

export default function NewStreamChooser({ onClose }: { onClose: () => void }) {
  const { can } = useAccess()
  const [groups, setGroups] = useState<Group[] | null>(null)
  const box = useRef<HTMLDivElement>(null)
  useEffect(() => { api.groups().then(setGroups).catch(() => setGroups([])) }, [])
  const [plan, setPlan] = useState<PlanView | null>(null)
  useEffect(() => { api.plan().then(setPlan).catch(() => {}) }, [])
  useEffect(() => { requestAnimationFrame(() => box.current?.querySelector<HTMLButtonElement>('button.ns-kind:not([disabled])')?.focus()) }, [groups])

  const tvGroups = (groups ?? []).filter(g => g.workflow_type === 'transcode' || g.workflow_type === 'package_only')
  const role = (f: string, what: string) => can(f, 'manage') ? null : `Your role does not allow creating ${what}.`
  const kinds: Kind[] = [
    { key: 'channel', title: '24x7 channel', icon: I.channel, to: '/channels/new',
      desc: 'Always on. Transcode builds the ladder from one source, or package a ladder you send.',
      disabledReason: role('channels', 'channels') ?? planFullReason(plan, 'channel') ?? (groups ? noRoomReason(tvGroups, 'channel') : null) },
    { key: 'event', title: 'Event', icon: I.event, to: '/events?new',
      desc: 'A scheduled broadcast. The server starts for its window, records it and can publish the VOD.',
      disabledReason: role('events', 'events') },
    { key: 'radio', title: 'Radio station', icon: I.radio, to: '/radio?new',
      desc: 'Audio only: Icecast, HLS or SRT in; MP3, HLS and DASH out, with a now-playing log.',
      disabledReason: role('radio', 'stations') ?? planFullReason(plan, 'station') ?? (groups ? noRoomReason(groups, 'station') : null) },
    { key: 'fast', title: 'FAST channel', icon: I.fast, to: '/fast?new',
      desc: 'A linear channel built from your library: a run order of films and series that loops, with the guide written for you and ad breaks.',
      disabledReason: role('channels', 'channels') ?? planFullReason(plan, 'channel') ?? (groups ? noRoomReason(groups, 'channel') : null) },
  ]

  function go(k: Kind) { if (!k.to || k.disabledReason) return; onClose(); navigate(k.to) }

  return (
    <div className="drawer-scrim" onClick={e => { if (e.target === e.currentTarget) onClose() }} style={{ alignItems: 'center', justifyContent: 'center' }}>
      <div ref={box} className="card ns" role="dialog" aria-modal="true" aria-labelledby="ns-t"
        onKeyDown={e => {
          if (e.key === 'Escape') onClose()
          if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            e.preventDefault()
            const all = Array.from(box.current?.querySelectorAll<HTMLButtonElement>('button.ns-kind:not([disabled])') ?? [])
            const i = all.indexOf(document.activeElement as HTMLButtonElement)
            all[(i + (e.key === 'ArrowDown' ? 1 : -1) + all.length) % all.length]?.focus()
          }
        }}>
        <div className="ns-h">
          <h3 id="ns-t">New stream</h3>
          <button type="button" className="xbtn" onClick={onClose} aria-label="Close">✕</button>
        </div>
        <p className="ns-sub">What are you setting up?</p>
        <div className="ns-list">
          {kinds.map(k => (
            <button key={k.key} type="button" className="ns-kind" disabled={!!k.disabledReason} onClick={() => go(k)}
              aria-describedby={`ns-d-${k.key}`}>
              <span className="ns-ic">{k.icon}</span>
              <span className="ns-txt">
                <span className="ns-title">{k.title}{k.badge && <em>{k.badge}</em>}</span>
                <span className="ns-desc" id={`ns-d-${k.key}`}>{k.disabledReason && !k.badge ? k.disabledReason : k.desc}</span>
              </span>
              {!k.disabledReason && <svg className="ns-go" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="m9 6 6 6-6 6" /></svg>}
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}
