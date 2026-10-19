import { useEffect, useMemo, useState } from 'react'
import { api, thumbUrl, type ImportAlias, type ImportSource, type GuideChannel, type Group } from '../api'
import { useAccess } from '../access'

/* ============================================================================
   CHANNEL LINEUP of one XMLTV import source: which of the feed's channels are
   used, and which Volt channel each one feeds.

   A real feed is a lineup, not one channel: xmltv.net's Sydney guide has 47,
   "7 Sydney" on three numbers, SD and HD simulcasts, radio beside TV. Each of
   their channels is

     Used       on one Volt channel (one feed channel per Volt channel)
     Not used   skipped quietly, no warning on every run
     Waiting    new and undecided; the run names it until somebody chooses

   Rows are in channel-number order with the number up front, because the
   number is what tells same-named channels apart. A SUGGESTION (one to one,
   never applied on its own) sits beside each undecided row; many rows can be
   chosen at once to accept suggestions, mark not used, or create Volt
   channels named after them.
   ========================================================================== */
type Filter = 'waiting' | 'used' | 'not_used' | 'all'
const FILTERS: { id: Filter; label: string }[] = [
  { id: 'waiting', label: 'Waiting' }, { id: 'used', label: 'Used' }, { id: 'not_used', label: 'Not used' }, { id: 'all', label: 'All' },
]
const MAPPED_BY: Record<string, string> = {
  'auto:xmltv_id': 'matched by XMLTV id', 'auto:name': 'matched by name', user: 'chosen by you', suggestion: 'suggestion you accepted', created: 'created from this feed',
}
const day = (iso: string | null) => iso ? new Date(iso).toLocaleDateString([], { weekday: 'short', day: '2-digit', month: 'short' }) : ''

export default function XmltvLineup({ source, channels, onChanged }: { source: ImportSource; channels: GuideChannel[]; onChanged: () => void }) {
  const canMakeChannels = useAccess().can('channels', 'manage')
  const [rows, setRows] = useState<ImportAlias[] | null>(null)
  const [filter, setFilter] = useState<Filter | null>(null)
  const [search, setSearch] = useState('')
  const [sel, setSel] = useState<Set<string>>(new Set())
  const [groups, setGroups] = useState<Group[]>([])
  const [create, setCreate] = useState<{ groupId: string; kind: 'tv' | 'radio' } | null>(null)
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null)

  const load = () => api.importChannels(source.id).then(r => {
    setRows(r)
    setFilter(f => f ?? (r.some(x => x.state === 'waiting') ? 'waiting' : 'all'))
    setSel(s => new Set([...s].filter(id => r.some(x => x.id === id))))
  }).catch(e => setNote({ ok: false, text: e.message }))
  useEffect(() => { load(); api.groups().then(setGroups).catch(() => setGroups([])) }, [source.id])

  const counts = useMemo(() => {
    const c = { waiting: 0, used: 0, not_used: 0, all: rows?.length ?? 0 }
    for (const r of rows ?? []) c[r.state]++
    return c
  }, [rows])
  const shown = useMemo(() => {
    const q = search.trim().toLowerCase()
    return (rows ?? []).filter(r => (filter === 'all' || !filter || r.state === filter) &&
      (!q || [r.displayName, r.externalId, r.lcn, r.channelName].some(v => (v ?? '').toLowerCase().includes(q))))
  }, [rows, filter, search])
  // Volt channels this source already feeds, and from which of their channels.
  const takenBy = useMemo(() => new Map((rows ?? []).filter(r => r.channelId).map(r => [r.channelId!, r])), [rows])
  const allShownSelected = shown.length > 0 && shown.every(r => sel.has(r.id))
  const selected = (rows ?? []).filter(r => sel.has(r.id))
  const selectedSuggestions = selected.filter(r => r.state !== 'used' && r.suggestion).length

  async function choose(r: ImportAlias, value: string) {
    setNote(null)
    try {
      if (value === '__not_used') await api.setImportChannel(r.id, { channelId: null, ignored: true })
      else if (value === '__waiting') await api.setImportChannel(r.id, { channelId: null, ignored: false })
      else {
        const res = await api.setImportChannel(r.id, { channelId: value })
        if (res.removedFromPrevious) setNote({ ok: true, text: `${res.removedFromPrevious} programme(s) that had not aired came off ${r.channelName}.` })
      }
      await load(); onChanged()
    } catch (e: any) { setNote({ ok: false, text: e.message }) }
  }
  async function adoptTheirIcon(r: ImportAlias) {
    setNote(null)
    try {
      await api.useImportIcon(source.id, r.id)
      setNote({ ok: true, text: `${r.channelName} now uses their logo. Change it any time in the channel's Settings.` })
      load(); onChanged()
    } catch (e: any) { setNote({ ok: false, text: e.message }) }
  }

  async function bulk(action: 'not_used' | 'waiting' | 'accept_suggestions' | 'create') {
    if (!selected.length) return
    if (action === 'create' && !create?.groupId) { setNote({ ok: false, text: 'Choose the group the new channels go in.' }); return }
    if ((action === 'not_used' || action === 'waiting') && selected.some(r => r.state === 'used') &&
      !window.confirm(`${selected.filter(r => r.state === 'used').length} of these are in use. Their programmes that have not aired yet come off their Volt channels. Continue?`)) return
    setBusy(true); setNote(null)
    try {
      const r = await api.bulkImportChannels(source.id, { aliasIds: selected.map(x => x.id), action, ...(action === 'create' ? { groupId: create!.groupId, kind: create!.kind } : {}) })
      const verb = { not_used: 'marked not used', waiting: 'set back to waiting', accept_suggestions: 'put on their suggested channel', create: 'given a new Volt channel' }[action]
      setNote({ ok: true, text: `${r.done} ${verb}.${r.skipped.length ? ` ${r.skipped.length} skipped (${[...new Set(r.skipped.map(s => s.reason))].join(', ')}).` : ''}${action === 'create' || action === 'accept_suggestions' ? ' Their programmes come in on the next import.' : ''}` })
      setSel(new Set()); setCreate(null)
      await load(); onChanged()
    } catch (e: any) { setNote({ ok: false, text: e.message }) } finally { setBusy(false) }
  }
  const toggle = (id: string) => setSel(s => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n })

  if (!rows) return <div className="loading">Loading the lineup…</div>
  if (!rows.length) return <div className="hintxt">No channels yet. Use Try it to load the feed's lineup without importing, or run an import.</div>

  return (
    <div className="lineup">
      <div className="hintxt" style={{ marginTop: 0, marginBottom: 8 }}>
        Choose which of this feed's channels you use, and the Volt channel each one goes to. Not used channels are skipped without warnings.
        {' '}New channels the feed adds later {source.newChannels === 'ignore' ? 'start as not used' : 'wait for you here'} (change it under Edit).
      </div>
      <div className="lineup-bar">
        {FILTERS.map(f => (
          <button key={f.id} type="button" className={`chip${filter === f.id ? ' active' : ''}`} onClick={() => setFilter(f.id)}>
            {f.label} <span className="ct">{counts[f.id]}</span>
          </button>
        ))}
        <div style={{ flex: 1 }} />
        <input className="inp" style={{ width: 200 }} placeholder="Search name, number or id" value={search} onChange={e => setSearch(e.target.value)} aria-label="Search the lineup" />
      </div>

      {selected.length > 0 && (
        <div className="lineup-bulk" role="region" aria-label="Selected channels">
          <strong>{selected.length} selected</strong>
          <button type="button" className="btn" disabled={busy || !selectedSuggestions} onClick={() => bulk('accept_suggestions')} title={selectedSuggestions ? '' : 'None of the selected has a suggestion'}>
            Use suggestions{selectedSuggestions ? ` (${selectedSuggestions})` : ''}
          </button>
          <button type="button" className="btn ghost" disabled={busy} onClick={() => bulk('not_used')}>Don't use</button>
          <button type="button" className="btn ghost" disabled={busy} onClick={() => bulk('waiting')}>Back to waiting</button>
          {!create ? (
            /* Creating channels is channel work, not EPG work: an EPG-only role sees why it cannot. */
            <button type="button" className="btn ghost" disabled={busy || !canMakeChannels}
              title={canMakeChannels ? undefined : 'Creating channels needs permission to manage channels'}
              onClick={() => setCreate({ groupId: (groups.find(g => g.is_default) ?? groups[0])?.id ?? '', kind: 'tv' })}>Create Volt channels…</button>
          ) : (
            <span className="lineup-create">
              <select className="inp" value={create.groupId} onChange={e => setCreate({ ...create, groupId: e.target.value })} aria-label="Group for the new channels">
                <option value="">Group…</option>
                {groups.map(g => <option key={g.id} value={g.id}>{g.name} ({g.channel_count}/{g.max_channels})</option>)}
              </select>
              <select className="inp" value={create.kind} onChange={e => setCreate({ ...create, kind: e.target.value as 'tv' | 'radio' })} aria-label="TV or radio">
                <option value="tv">TV</option><option value="radio">Radio</option>
              </select>
              <button type="button" className="btn primary" disabled={busy || !create.groupId} onClick={() => bulk('create')}>Create {selected.filter(r => r.state !== 'used').length}</button>
              <button type="button" className="btn ghost" onClick={() => setCreate(null)}>Cancel</button>
            </span>
          )}
          <div style={{ flex: 1 }} />
          <button type="button" className="btn ghost" onClick={() => setSel(new Set())}>Clear</button>
        </div>
      )}
      {create && selected.length > 0 && (
        <div className="hintxt" style={{ marginTop: 4 }}>Each new channel is named after the feed channel and takes its id as its XMLTV id, with no stream source yet: add the source on the channel when it is ready to go live.</div>
      )}
      {note && <div className={note.ok ? 'hintxt' : 'err'} style={{ marginTop: 6, color: note.ok ? 'var(--text)' : undefined }} role="status">{note.text}</div>}

      {shown.length === 0 ? <div className="hintxt" style={{ marginTop: 10 }}>Nothing here{search ? ' matches the search' : ''}.</div> : (
        <table className="lineup-table">
          <thead>
            <tr>
              <th style={{ width: 28 }}>
                <input type="checkbox" aria-label="Select all shown" checked={allShownSelected}
                  onChange={() => setSel(s => { const n = new Set(s); if (allShownSelected) shown.forEach(r => n.delete(r.id)); else shown.forEach(r => n.add(r.id)); return n })} />
              </th>
              <th style={{ width: 44 }}>No.</th>
              <th>Their channel</th>
              <th>In the feed</th>
              <th style={{ minWidth: 230 }}>Volt channel</th>
            </tr>
          </thead>
          <tbody>
            {shown.map(r => (
              <tr key={r.id} className={`st-${r.state}`}>
                <td><input type="checkbox" aria-label={`Select ${r.displayName ?? r.externalId}`} checked={sel.has(r.id)} onChange={() => toggle(r.id)} /></td>
                <td className="lcn">{r.lcn ?? '–'}</td>
                <td>
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center', minWidth: 0 }}>
                    {r.icon ? <img src={r.icon} alt="" className="lineup-logo" onError={e => { (e.currentTarget as HTMLImageElement).style.visibility = 'hidden' }} /> : <span className="lineup-logo" />}
                    <div style={{ minWidth: 0 }}>
                      <div style={{ fontWeight: 600 }}>{r.displayName ?? r.externalId}</div>
                      <div className="hintxt mono" style={{ marginTop: 0 }}>{r.externalId}</div>
                      {r.sameNameAs.length > 0 && <div className="hintxt" style={{ marginTop: 0, color: 'var(--warn)' }}>Same name as {r.sameNameAs.join(', ')}: check the number</div>}
                    </div>
                  </div>
                </td>
                <td style={{ color: 'var(--muted)', whiteSpace: 'nowrap' }}>
                  {r.programmesInFeed ? <>{r.programmesInFeed} programmes<div className="hintxt" style={{ marginTop: 0 }}>to {day(r.feedTo)}</div></> : <span style={{ color: 'var(--warn)' }}>No programmes</span>}
                  {r.state === 'used' && source.kind === 'url' && r.guideDaysAhead != null && (
                    <div className="hintxt" style={{ marginTop: 0, color: source.minDaysAhead && r.guideDaysAhead < source.minDaysAhead ? 'var(--warn)' : undefined }}>guide {r.guideDaysAhead} days ahead</div>
                  )}
                </td>
                <td>
                  <select className="inp" value={r.state === 'used' ? r.channelId! : r.state === 'not_used' ? '__not_used' : '__waiting'} onChange={e => choose(r, e.target.value)} aria-label={`Volt channel for ${r.displayName ?? r.externalId}`}>
                    <option value="__waiting">Waiting: choose…</option>
                    <option value="__not_used">Not used</option>
                    <optgroup label="Use on">
                      {channels.map(c => {
                        const by = takenBy.get(c.id)
                        const other = by && by.id !== r.id
                        return <option key={c.id} value={c.id} disabled={!!other}>{c.name}{c.medium === 'radio' ? ' (radio)' : ''}{other ? ` · takes ${by!.lcn ?? by!.externalId}` : ''}</option>
                      })}
                    </optgroup>
                  </select>
                  {r.state !== 'used' && r.suggestion && (
                    <button type="button" className="lineup-suggest" onClick={() => choose(r, r.suggestion!.channelId)}>Use suggested: {r.suggestion.channelName}</button>
                  )}
                  {r.state === 'used' && r.mappedBy && <div className="hintxt" style={{ marginTop: 2 }}>{MAPPED_BY[r.mappedBy] ?? r.mappedBy}</div>}
                  {r.state === 'used' && (
                    <div className="guide-icon-cell" style={{ marginTop: 4 }}>
                      {r.channelIconRef
                        ? <><img src={thumbUrl(r.channelIconRef, 68, 44, 'inside')} alt="" className="lineup-logo" /><span className="hintxt" style={{ marginTop: 0 }}>Guide shows {r.channelName}'s image</span></>
                        : r.icon && /^https?:/i.test(r.icon)
                          ? <><span className="hintxt" style={{ marginTop: 0 }}>{r.channelName} has no image, so the guide uses theirs.</span>
                              <button type="button" className="lineup-suggest" onClick={() => adoptTheirIcon(r)}>Keep it as the logo</button></>
                          : <span className="hintxt" style={{ marginTop: 0 }}>{r.channelName} has no image yet</span>}
                    </div>
                  )}
                  {r.alsoFedBy.length > 0 && <div className="hintxt" style={{ marginTop: 2, color: 'var(--warn)' }}>Also fed by {r.alsoFedBy.join(', ')}: expect overlaps</div>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <div className="hintxt" style={{ marginTop: 8 }}>Changes apply on the next import. Taking a channel out of use, or moving it, removes this source's programmes that have not aired yet from the Volt channel it was on.</div>
    </div>
  )
}
