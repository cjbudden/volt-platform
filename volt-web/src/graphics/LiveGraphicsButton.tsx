// ============================================================================
//  LIVE GRAPHICS QUICK LINK on a channel's or event's page header.
//
//  Shown only when graphics are ENABLED for this user (Graphics access) and
//  IN USE on this stream (at least one enabled assignment). It opens live
//  control in its own window (openLiveControl, falling back to this tab when
//  pop-ups are blocked), so an operator does not go Graphics > Assignments >
//  Live control mid-show. It follows on-air changes from the live status
//  stream: the icon turns the live colour and its tip counts what is on air.
// ============================================================================
import { useEffect, useState } from 'react'
import { useAccess } from '../access'
import { subscribeLive } from '../liveStatus'
import { gfx, type Assignment } from './gfxApi'
import { openLiveControl } from './Graphics'

export function LiveGraphicsButton({ channelId, eventId }: { channelId?: string; eventId?: string }) {
  const { can } = useAccess()
  const allowed = can('graphics', 'view')
  const [items, setItems] = useState<Assignment[] | null>(null)
  const kind = eventId ? 'event' : 'channel'
  const id = eventId ?? channelId ?? ''

  useEffect(() => {
    if (!allowed || !id) return
    let live = true
    const load = () => gfx.assignments(eventId ? { event_id: eventId } : { channel_id: channelId })
      .then((r) => { if (live) setItems(r.items) })
      .catch(() => { /* no button rather than an error in the header */ })
    load()
    // A take, a clear or a new assignment arrives as a 'gfx' frame; a slow
    // poll covers rule-driven changes and a dropped status stream.
    const off = subscribeLive(`gfx:${kind}:${id}`, () => { load() })
    const h = setInterval(load, 60_000)
    return () => { live = false; off(); clearInterval(h) }
  }, [allowed, id, kind]) // eslint-disable-line react-hooks/exhaustive-deps

  const inUse = (items ?? []).filter((a) => a.enabled)
  if (!allowed || inUse.length === 0) return null
  const onAir = inUse.filter((a) => a.onAir).length
  const canOperate = can('graphics', 'operate')
  const tip = `${canOperate ? 'Open live graphics control' : 'View live graphics'} in its own window: ` +
    `${inUse.length} graphic${inUse.length === 1 ? '' : 's'} on this ${kind}${onAir ? `, ${onAir} on air` : ''}`

  // Icon only, the same `btn ghost icon-btn` as the header's other actions so it
  // is the same size; named on hover (data-tip) and to screen readers. On air,
  // the icon takes the live colour.
  return (
    <button className="btn ghost icon-btn" onClick={() => openLiveControl({ channelId, eventId })}
      data-tip={tip} aria-label={tip} style={onAir ? { color: 'var(--live)' } : undefined}>
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M6 15h8M6 12h5" /></svg>
    </button>
  )
}
