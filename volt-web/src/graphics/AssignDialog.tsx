// Assign a setup to a channel or an event, and say how it runs there.
// Channels: always, by rule, on a trigger, or by hand. Events: usually by hand
// from the rundown, so an event assignment defaults to manual.
import { useEffect, useState } from 'react'
import { api } from '../api'
import { Notice } from '../notices'
import { gfx, type Assignment, type RunMode, type Rule, type Setup } from './gfxApi'

export function RunModeFields({ mode, setMode, rule, setRule, clearInAds, setClearInAds, isEvent }: {
  mode: RunMode; setMode: (m: RunMode) => void; rule: Rule; setRule: (r: Rule) => void
  clearInAds: boolean; setClearInAds: (b: boolean) => void; isEvent: boolean
}) {
  const modes: { k: RunMode; t: string; d: string }[] = [
    { k: 'always', t: 'Always', d: 'On whenever it is on air. Logos, bugs, sponsors.' },
    { k: 'rule', t: 'By rule', d: 'While the programme matches: a genre, a title, a time of day.' },
    { k: 'trigger', t: 'On a trigger', d: 'For a set time at the start or end of each programme.' },
    { k: 'manual', t: 'By hand', d: isEvent ? 'Taken from live control or the rundown.' : 'Taken from live control, for breaking news and the like.' },
  ]
  const days = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
  const genres = Array.isArray(rule.genre) ? rule.genre.join(', ') : rule.genre ?? ''
  return (
    <>
      <div className="sec-label">How it runs</div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(190px,1fr))', gap: 8 }}>
        {modes.map((m) => <button type="button" key={m.k} className={`gfx-opt ${mode === m.k ? 'on' : ''}`} onClick={() => setMode(m.k)}>
          <span className="r" /><span><b>{m.t}</b><small>{m.d}</small></span></button>)}
      </div>
      {mode === 'rule' && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(160px,1fr))', gap: 10, marginTop: 12 }}>
          <div className="field"><label htmlFor="r-genre">Genre is</label>
            <input id="r-genre" className="inp" placeholder="News, Sport" value={genres}
              onChange={(e) => setRule({ ...rule, genre: e.target.value.split(',').map((s) => s.trim()).filter(Boolean) })} /></div>
          <div className="field"><label htmlFor="r-title">Title contains</label>
            <input id="r-title" className="inp" value={rule.titleContains ?? ''} onChange={(e) => setRule({ ...rule, titleContains: e.target.value || undefined })} /></div>
          <div className="field"><label htmlFor="r-from">From</label>
            <input id="r-from" className="inp" type="time" value={rule.from ?? ''} onChange={(e) => setRule({ ...rule, from: e.target.value || undefined })} /></div>
          <div className="field"><label htmlFor="r-to">To</label>
            <input id="r-to" className="inp" type="time" value={rule.to ?? ''} onChange={(e) => setRule({ ...rule, to: e.target.value || undefined })} /></div>
          <div className="field" style={{ gridColumn: '1 / -1' }}><label>Days</label>
            <div className="chipset">{days.map((d, i) => {
              const on = (rule.days ?? []).includes(i + 1)
              return <button type="button" key={d} className={`selchip ${on ? 'sel' : ''}`}
                onClick={() => setRule({ ...rule, days: on ? (rule.days ?? []).filter((x) => x !== i + 1) : [...(rule.days ?? []), i + 1].sort() })}>{d}</button>
            })}</div>
            <div className="gfx-meta" style={{ marginTop: 6 }}>None chosen means every day. Times are in {rule.tz ?? Intl.DateTimeFormat().resolvedOptions().timeZone}.</div>
          </div>
        </div>
      )}
      {mode === 'trigger' && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(160px,1fr))', gap: 10, marginTop: 12 }}>
          <div className="field"><label htmlFor="t-at">When</label>
            <select id="t-at" className="inp" value={rule.at ?? 'programme_start'} onChange={(e) => setRule({ ...rule, at: e.target.value as any })}>
              <option value="programme_start">After each programme starts</option><option value="programme_end">Before each programme ends</option></select></div>
          <div className="field"><label htmlFor="t-off">{(rule.at ?? 'programme_start') === 'programme_end' ? 'Seconds before the end' : 'Seconds after the start'}</label>
            <input id="t-off" className="inp" type="number" min={0} value={rule.offsetSec ?? 10} onChange={(e) => setRule({ ...rule, offsetSec: Number(e.target.value) })} /></div>
          <div className="field"><label htmlFor="t-dur">Stays for (seconds)</label>
            <input id="t-dur" className="inp" type="number" min={1} value={rule.durationSec ?? 8} onChange={(e) => setRule({ ...rule, durationSec: Number(e.target.value) })} /></div>
        </div>
      )}
      <label className="toggle-row" style={{ marginTop: 12, cursor: 'pointer' }}>
        <div><div className="tt">Clear for ad breaks</div><div className="td">Off during ad items in the guide.</div></div>
        <input type="checkbox" checked={clearInAds} onChange={(e) => setClearInAds(e.target.checked)} style={{ marginLeft: 'auto', width: 20, height: 20 }} />
      </label>
    </>
  )
}

export function TargetsField({ targets, setTargets }: { targets: string; setTargets: (t: string) => void }) {
  const opts = [
    { k: 'player', t: 'Player overlay', d: 'Drawn by Volt players. Not in downloads or partner feeds.' },
    { k: 'burn', t: 'Burned into output', d: 'In every rendition, recording and clip. Transcode workflow only.' },
    { k: 'both', t: 'Both', d: 'Burned for partners, the player copy for Volt apps.' },
  ]
  return (
    <>
      <div className="sec-label">Shown in</div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(180px,1fr))', gap: 8 }}>
        {opts.map((o) => <button type="button" key={o.k} className={`gfx-opt ${targets === o.k ? 'on' : ''}`} onClick={() => setTargets(o.k)}>
          <span className="r" /><span><b>{o.t}</b><small>{o.d}</small></span></button>)}
      </div>
    </>
  )
}

export function AssignDialog({ setup, onClose, onDone, edit, fixed }: {
  setup: Pick<Setup, 'id' | 'name'>; onClose: () => void; onDone: (a: Assignment) => void
  edit?: Assignment; fixed?: { channelId?: string; eventId?: string }
}) {
  const [channels, setChannels] = useState<{ id: string; name: string }[]>([])
  const [events, setEvents] = useState<{ id: string; name: string }[]>([])
  const [target, setTarget] = useState<string>(edit ? (edit.channelId ? `c:${edit.channelId}` : `e:${edit.eventId}`) : fixed?.channelId ? `c:${fixed.channelId}` : fixed?.eventId ? `e:${fixed.eventId}` : '')
  const [targets, setTargets] = useState<string>(edit?.targets ?? 'burn')
  const [mode, setMode] = useState<RunMode>(edit?.runMode ?? (fixed?.eventId ? 'manual' : 'always'))
  const [rule, setRule] = useState<Rule>(edit?.rule ?? { tz: Intl.DateTimeFormat().resolvedOptions().timeZone })
  const [clearInAds, setClearInAds] = useState(edit?.clearInAds ?? true)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  useEffect(() => {
    api.channels('tv').then((r) => setChannels(r.map((c) => ({ id: c.id, name: c.name })))).catch(() => {})
    api.events().then((r: any) => setEvents((Array.isArray(r) ? r : r.items ?? []).map((e: any) => ({ id: e.id, name: e.name })))).catch(() => {})
  }, [])
  const isEvent = target.startsWith('e:')
  const save = async () => {
    setErr('')
    if (!target) { setErr('Choose a channel or event.'); return }
    const clean: Rule = mode === 'rule' ? { genre: rule.genre, titleContains: rule.titleContains, days: rule.days, from: rule.from, to: rule.to, tz: rule.tz }
      : mode === 'trigger' ? { at: rule.at ?? 'programme_start', offsetSec: rule.offsetSec ?? 10, durationSec: rule.durationSec ?? 8 } : {}
    for (const k of Object.keys(clean) as (keyof Rule)[]) if (clean[k] === undefined || (Array.isArray(clean[k]) && !(clean[k] as any[]).length)) delete clean[k]
    setBusy(true)
    try {
      const a = edit ? await gfx.patchAssignment(edit.id, { targets, runMode: mode, rule: clean, clearInAds })
        : await gfx.assign({ setupId: setup.id, channelId: isEvent ? null : target.slice(2), eventId: isEvent ? target.slice(2) : null, targets, runMode: mode, rule: clean, clearInAds })
      onDone(a)
    } catch (e: any) { setErr(e.message) } finally { setBusy(false) }
  }
  return (
    <div className="drawer-scrim" onClick={onClose}>
      <div className="drawer" style={{ width: 560 }} onClick={(e) => e.stopPropagation()} role="dialog" aria-label={`Assign ${setup.name}`}>
        <div className="drawer-h"><div className="t">{edit ? 'How it runs' : `Assign ${setup.name}`}</div><button className="xbtn" aria-label="Close" onClick={onClose}>✕</button></div>
        <div className="drawer-b">
          {!edit && !fixed && (
            <div className="field"><label htmlFor="as-target">Channel or event</label>
              <select id="as-target" className="inp" value={target} onChange={(e) => { setTarget(e.target.value); if (e.target.value.startsWith('e:')) setMode('manual') }}>
                <option value="">Choose…</option>
                <optgroup label="Channels">{channels.map((c) => <option key={c.id} value={`c:${c.id}`}>{c.name}</option>)}</optgroup>
                <optgroup label="Events">{events.map((e) => <option key={e.id} value={`e:${e.id}`}>{e.name}</option>)}</optgroup>
              </select>
              <div className="gfx-meta" style={{ marginTop: 6 }}>Radio stations are not listed: they have no picture to draw on.</div>
            </div>
          )}
          <TargetsField targets={targets} setTargets={setTargets} />
          <RunModeFields mode={mode} setMode={setMode} rule={rule} setRule={setRule} clearInAds={clearInAds} setClearInAds={setClearInAds} isEvent={isEvent} />
        </div>
        <div className="drawer-f">
          {err && <div className="drawer-f-err"><Notice kind="error" variant="compact" message={err} /></div>}
          <button className="btn ghost" onClick={onClose}>Cancel</button>
          <button className="btn primary" disabled={busy} onClick={save}>{busy ? 'Saving…' : edit ? 'Save' : 'Assign'}</button>
        </div>
      </div>
    </div>
  )
}
