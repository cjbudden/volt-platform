import { useEffect, useMemo, useState } from 'react'
import { api, type EpgOwner, type EpgOwnerRow, type ProgrammeRow, type ProgrammeConflict, type ProgrammeBody, type ProgrammeVod, type VodState } from '../api'
import { ImagePicker } from '../ImagePicker'
import { pressable } from '../a11y'

/* ============================================================================
   EPG builder — the guide for ONE channel or event, edited a day at a time in
   the list format. Add/edit/remove programmes, copy a whole day onto other
   days, clear a day. Every slot carries the full control set:
   - GEO access for the period (worldwide / allow-list / block-list)
   - slot REPLACEMENT: play a slate, loop, or VOD instead of the live feed
   - AUTO CLIP: when the slot finishes airing, the scheduler cuts a clip/VOD of
     exactly that period from the recording, named from the programme with its
     metadata carried onto the asset. The status of that automation shows here.
   Overlaps are allowed but surfaced (soft conflicts), matching broadcast
   practice where handovers overlap by seconds.
   ========================================================================== */

const p2 = (n: number) => String(n).padStart(2, '0')
const fmtT = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
const toDateInput = (d: Date) => `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`
function fmtDur(ms: number) {
  const m = Math.round(ms / 60000)
  return m >= 60 ? `${Math.floor(m / 60)}h${m % 60 ? ` ${m % 60}m` : ''}` : `${m}m`
}
const GEO_LABEL = { worldwide: 'Worldwide', allow: 'Allow-list', block: 'Block-list' } as const
const REPL_LABEL = { none: '—', slate: 'Slate', loop: 'Loop', vod: 'VOD' } as const

/* ---------------------------------------------------------------------------
   THE VOD LIFECYCLE, as the schedule shows it.

   The guide used to render one of four things in an "Auto clip" column: a
   dash, "on end", "created", or "failed". Three separate situations shared
   that dash, and the most important one was invisible:

     - a slot that WILL auto-convert when it ends,
     - a slot that HAS been converted, and
     - a slot that AIRED, IS STILL ON DISK, and that nothing is going to
       convert unless somebody does it.

   The third is the one with a deadline on it. The material is there today and
   gone once retention sweeps, and the only way to notice used to be to
   remember. It now has its own state, its own colour, its own coverage
   figure, and a button.

   COLOUR IS NEVER THE ONLY CUE. Every state carries a word, because the
   distinction between "converted" and "convertible" has to survive a
   colourblind reader and a greyscale print of the schedule.
   ------------------------------------------------------------------------ */
const VOD_UI: Record<VodState, { label: string; color: string; hint: string }> = {
  manual:      { label: 'Manual',      color: 'var(--faint)',        hint: 'No automatic conversion. It can still be converted after it airs.' },
  scheduled:   { label: 'Auto on end', color: 'var(--brand,#7c9cff)',hint: 'Will be converted to a VOD asset when the slot finishes airing.' },
  converting:  { label: 'Converting',  color: 'var(--warn,#e2b64f)', hint: 'The conversion is running now.' },
  converted:   { label: 'VOD ready',   color: 'var(--ok,#3fbf6f)',   hint: 'A VOD asset exists for this slot.' },
  failed:      { label: 'Failed',      color: 'var(--down,#f87171)', hint: 'The automatic conversion errored. It can be retried.' },
  convertible: { label: 'Recorded',    color: 'var(--warn,#e2b64f)', hint: 'Aired and still on disk. Convert it before retention removes it.' },
  unavailable: { label: 'Not on disk', color: 'var(--faint)',        hint: 'Aired, but no recording covers this slot any more.' },
}

/** Days until a date, floored. Negative means it has already passed. */
function daysUntil(iso: string): number {
  return Math.floor((Date.parse(iso) - Date.now()) / 86_400_000)
}

export default function EpgDetail({ owner, onBack }: { owner: EpgOwner; onBack: () => void }) {
  const [ownerRow, setOwnerRow] = useState<EpgOwnerRow | null>(null)
  const [day, setDay] = useState(() => { const d = new Date(); d.setHours(0, 0, 0, 0); return d })
  const [progs, setProgs] = useState<ProgrammeRow[] | null>(null)
  const [vod, setVod] = useState<Record<string, ProgrammeVod>>({})
  const [converting, setConverting] = useState<string | null>(null)
  const [conflicts, setConflicts] = useState<ProgrammeConflict[]>([])
  const [err, setErr] = useState('')
  const [editing, setEditing] = useState<ProgrammeRow | 'new' | null>(null)
  const [copyOpen, setCopyOpen] = useState(false)
  const [toast, setToast] = useState('')

  /* Which programmes take part in an overlap, and who they overlap with.
     The banner only counts them: the rows themselves carry the highlight, so
     an operator scanning the day sees the problem where it is rather than
     having to match titles from a sentence at the top. */
  const overlapsById = useMemo(() => {
    const m = new Map<string, string[]>()
    for (const c of conflicts) {
      m.set(c.a_id, [...(m.get(c.a_id) ?? []), c.b_title])
      m.set(c.b_id, [...(m.get(c.b_id) ?? []), c.a_title])
    }
    return m
  }, [conflicts])

  const dayStart = day
  const dayEnd = useMemo(() => new Date(day.getTime() + 86_400_000), [day])

  async function load() {
    try {
      setErr('')
      // The lifecycle read measures the archive on disk, so it is allowed to
      // fail on its own without taking the schedule down with it: a guide that
      // will not render because a coverage scan errored is a worse outcome
      // than a guide with an unknown conversion column.
      const [p, c, v] = await Promise.all([
        api.epgProgrammes(owner, dayStart.toISOString(), dayEnd.toISOString()),
        api.epgConflicts(owner, dayStart.toISOString(), dayEnd.toISOString()),
        api.epgVodStatus(owner, dayStart.toISOString(), dayEnd.toISOString())
          .then(r => r.programmes).catch(() => ({} as Record<string, ProgrammeVod>)),
      ])
      setProgs(p); setConflicts(c); setVod(v)
    } catch (e: any) { setErr(e.message) }
  }

  /** Convert one aired slot now. The same conversion the scheduler runs. */
  async function convert(p: ProgrammeRow) {
    setConverting(p.id); setErr('')
    try {
      await api.convertProgramme(p.id)
      flash(`"${p.title}" is being converted to a VOD asset`)
      await load()
    } catch (e: any) { setErr(e.message) } finally { setConverting(null) }
  }
  useEffect(() => { load() /* eslint-disable-next-line */ }, [owner.kind, owner.id, day.getTime()])
  useEffect(() => {
    api.epgOwners().then(rs => setOwnerRow(rs.find(r => r.kind === owner.kind && r.id === owner.id) ?? null)).catch(() => {})
  }, [owner.kind, owner.id])

  function flash(m: string) { setToast(m); setTimeout(() => setToast(''), 2500) }
  async function remove(p: ProgrammeRow) {
    if (!window.confirm(`Remove "${p.title}"?`)) return
    try { await api.deleteProgramme(p.id); load() } catch (e: any) { setErr(e.message) }
  }
  async function clearDay() {
    if (!window.confirm(`Clear all programmes on ${day.toDateString()}?`)) return
    try { const r = await api.epgClearDay(owner, dayStart.toISOString(), dayEnd.toISOString()); flash(`${r.deleted} programme(s) removed`); load() }
    catch (e: any) { setErr(e.message) }
  }

  const shiftDay = (n: number) => setDay(d => { const x = new Date(d); x.setDate(x.getDate() + n); return x })

  return (
    <>
      <div style={{ marginBottom: 10 }}>
        <button className="btn ghost" onClick={onBack}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ width: 14 }}><path d="M19 12H5M12 19l-7-7 7-7" /></svg>
          EPG
        </button>
      </div>
      <div className="page-head" style={{ marginBottom: 10 }}>
        <div>
          <h1>{ownerRow?.name ?? 'Guide'} <span style={{ fontSize: 'var(--fs-body)', fontWeight: 400, color: 'var(--faint)' }}>{owner.kind === 'channel' ? 'channel guide' : 'event schedule'}</span></h1>
          <p>Add programmes, copy days, and control each slot: geo access, replacement, and post-airing clip automation.</p>
        </div>
        <div className="spacer" />
        <button className="btn ghost" onClick={() => setCopyOpen(true)}>Copy day…</button>
        <button className="btn ghost" onClick={clearDay}>Clear day</button>
        <button className="btn primary" onClick={() => setEditing('new')}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" style={{ width: 15 }}><path d="M12 5v14M5 12h14" /></svg>Add programme
        </button>
      </div>

      {/* day navigation */}
      <div className="filters" style={{ alignItems: 'center' }}>
        <button className="btn ghost" onClick={() => shiftDay(-1)}>← Prev</button>
        <input className="inp" type="date" value={toDateInput(day)}
          onChange={e => { const [y, m, d] = e.target.value.split('-').map(Number); if (y) setDay(new Date(y, m - 1, d)) }}
          style={{ width: 160 }} />
        <button className="btn ghost" onClick={() => shiftDay(1)}>Next →</button>
        <button className="btn ghost" onClick={() => { const d = new Date(); d.setHours(0, 0, 0, 0); setDay(d) }}>Today</button>
        <span style={{ color: 'var(--faint)', fontSize: 'var(--fs-sm)', marginLeft: 'auto' }}>{day.toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}</span>
      </div>

      {err && <div className="err">{err}</div>}
      {conflicts.length > 0 && (
        <div className="err" style={{ background: 'rgba(220,170,60,.12)', borderColor: 'rgba(220,170,60,.4)', color: 'var(--warn,#e2b64f)' }}>
          {conflicts.length} overlap{conflicts.length === 1 ? '' : 's'} today. Overlaps are allowed, but the highlighted rows should be checked.
        </div>
      )}

      {progs === null ? (
        <div className="loading">Loading day…</div>
      ) : progs.length === 0 ? (
        <div className="empty">
          <h3>Nothing scheduled on this day</h3>
          <p>Add the first programme, or use Copy day to repeat another day's schedule here.</p>
          <button className="btn primary" onClick={() => setEditing('new')} style={{ margin: '0 auto' }}>Add programme</button>
        </div>
      ) : (
        <>
        <VodSummary vod={vod} />
        <div className="card">
          <table>
            <thead><tr><th>Start</th><th>End</th><th>Dur</th><th>Programme</th><th>Geo</th><th>Replacement</th><th>VOD</th><th></th></tr></thead>
            <tbody>
              {progs.map(p => {
                const live = Date.parse(p.starts_at) <= Date.now() && Date.now() < Date.parse(p.ends_at)
                const v = vod[p.id]
                const overlaps = overlapsById.get(p.id)
                return (
                  <tr key={p.id} onClick={() => setEditing(p)}
                    title={overlaps ? `Overlaps ${overlaps.map(t => `"${t}"`).join(', ')}` : undefined}
                    style={{
                      cursor: 'pointer',
                      background: overlaps ? 'rgba(220,170,60,.10)' : live ? 'rgba(120,140,255,.06)' : undefined,
                      boxShadow: overlaps ? 'inset 3px 0 0 var(--warn,#e2b64f)' : undefined,
                    }}>
                    <td style={{ fontFamily: 'ui-monospace,monospace', color: overlaps ? 'var(--warn,#e2b64f)' : undefined }}>{fmtT(p.starts_at)}</td>
                    <td style={{ fontFamily: 'ui-monospace,monospace', color: overlaps ? 'var(--warn,#e2b64f)' : 'var(--muted)' }}>{fmtT(p.ends_at)}</td>
                    <td style={{ color: 'var(--muted)' }}>{fmtDur(Date.parse(p.ends_at) - Date.parse(p.starts_at))}</td>
                    <td><b>{p.title}</b>{live && <span className="badge live" style={{ marginLeft: 8 }}>ON NOW</span>}
                      {overlaps && (
                        <span className="badge" style={{ marginLeft: 8, color: 'var(--warn,#e2b64f)', borderColor: 'rgba(220,170,60,.5)', background: 'rgba(220,170,60,.12)' }}>
                          Overlaps {overlaps.length === 1 ? `"${overlaps[0]}"` : `${overlaps.length} programmes`}
                        </span>
                      )}
                      {p.metadata?.description && <div style={{ fontSize: 'var(--fs-xs)', color: 'var(--faint)', maxWidth: 320, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.metadata.description}</div>}
                    </td>
                    <td style={{ color: p.geo_mode === 'worldwide' ? 'var(--faint)' : 'var(--warn,#e2b64f)', fontSize: 'var(--fs-sm)' }}>
                      {GEO_LABEL[p.geo_mode]}{p.geo_mode !== 'worldwide' && p.geo_countries.length ? ` (${p.geo_countries.slice(0, 3).join(',')}${p.geo_countries.length > 3 ? '…' : ''})` : ''}
                    </td>
                    <td style={{ color: p.replacement_kind === 'none' ? 'var(--faint)' : 'var(--brand)', fontSize: 'var(--fs-sm)' }}>{REPL_LABEL[p.replacement_kind]}</td>
                    <td style={{ fontSize: 'var(--fs-sm)' }}><VodCell v={v} p={p} /></td>
                    <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }} onClick={e => e.stopPropagation()}>
                      {/* The action belongs on the row, not buried in the
                          drawer: the whole point of surfacing `convertible` is
                          that an operator scanning the day can act on it
                          without opening anything. */}
                      {v && (v.state === 'convertible' || v.state === 'failed') && (
                        <button className="btn" disabled={converting === p.id}
                          {...pressable(() => convert(p))} style={{ marginRight: 6 }}>
                          {converting === p.id ? 'Converting…' : v.state === 'failed' ? 'Retry' : 'Convert'}
                        </button>
                      )}
                      <button className="btn ghost" onClick={() => setEditing(p)}>Edit</button>
                      <button className="btn ghost" style={{ marginLeft: 6 }} onClick={() => remove(p)}>✕</button>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
        </>
      )}

      {editing && <ProgrammeDrawer owner={owner} day={day} programme={editing === 'new' ? null : editing}
        vod={editing === 'new' ? undefined : vod[editing.id]}
        converting={editing !== 'new' && converting === editing.id}
        onConvert={editing === 'new' ? undefined : () => convert(editing)}
        onClose={() => setEditing(null)} onDone={() => { setEditing(null); load() }} />}
      {copyOpen && <CopyDayModal owner={owner} day={day} count={progs?.length ?? 0}
        onClose={() => setCopyOpen(false)} onDone={(msg) => { setCopyOpen(false); flash(msg); load() }} />}
      {toast && (
        <div style={{ position: 'fixed', left: '50%', bottom: 26, transform: 'translateX(-50%)', zIndex: 60, background: 'var(--panel-3,#161b26)', border: '1px solid var(--border)', padding: '10px 16px', borderRadius: 10, fontSize: 'var(--fs-body)' }}>{toast}</div>
      )}
    </>
  )
}

/* ------------------------------------------------- the VOD state of a slot */
/**
 * One cell, and the reason it is a component rather than a ternary.
 *
 * Each state needs a different second line: a converted slot names its asset,
 * a convertible one shows how much of the slot the media actually covers and
 * when that material goes away, a failed one shows why. Written inline that is
 * a nest of conditionals nobody can read; written here each state says its own
 * piece.
 *
 * `v` may be undefined when the lifecycle read failed. That renders as a dash
 * with a title explaining it, NOT as "manual" — guessing a state from
 * `auto_vod` alone is exactly the conflation this whole change removes.
 */
function VodCell({ v, p }: { v: ProgrammeVod | undefined; p: ProgrammeRow }) {
  if (!v) {
    return <span style={{ color: 'var(--faint)' }} title="The conversion status could not be read.">—</span>
  }
  const ui = VOD_UI[v.state]
  const days = v.expiresAt ? daysUntil(v.expiresAt) : null
  return (
    <div title={ui.hint}>
      <span style={{ color: ui.color, fontWeight: 600 }}>{ui.label}</span>
      {v.state === 'converted' && v.assetTitle && (
        <div style={{ fontSize: 'var(--fs-xs)', color: 'var(--faint)', maxWidth: 190, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {v.assetTitle}{v.assetState && v.assetState !== 'ready' ? ` · ${v.assetState}` : ''}
        </div>
      )}
      {v.state === 'convertible' && (
        <div style={{ fontSize: 'var(--fs-xs)', color: 'var(--faint)' }}>
          {/* Coverage below 100% is worth saying out loud BEFORE the button is
              pressed. A slot the encoder restarted through converts to an
              asset with a hole in it, and finding that out afterwards is the
              expensive way. */}
          {v.coveragePct >= 99.9 ? 'fully recorded' : `${v.coveragePct}% recorded`}
          {days != null && (days <= 0
            ? ' · due for deletion'
            : days <= 7 ? ` · ${days}d left` : ` · kept ${days}d`)}
        </div>
      )}
      {v.state === 'failed' && v.error && (
        <div style={{ fontSize: 'var(--fs-xs)', color: 'var(--faint)', maxWidth: 190, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
             title={v.error}>{v.error}</div>
      )}
      {v.state === 'unavailable' && (
        <div style={{ fontSize: 'var(--fs-xs)', color: 'var(--faint)' }}>retention or never recorded</div>
      )}
      {v.state === 'manual' && p.auto_vod === false && (
        <div style={{ fontSize: 'var(--fs-xs)', color: 'var(--faint)' }}>auto-VOD off</div>
      )}
    </div>
  )
}

/**
 * The day at a glance.
 *
 * A row-by-row column answers "what about this slot". This answers "is there
 * anything I should do today", which is a different question and the one an
 * operator opens the page with. It is deliberately quiet when there is nothing
 * convertible and nothing failed: a strip that always shows counts trains
 * people to stop reading it.
 */
function VodSummary({ vod }: { vod: Record<string, ProgrammeVod> }) {
  const all = Object.values(vod)
  if (!all.length) return null
  const n = (st: VodState) => all.filter(v => v.state === st).length
  const convertible = n('convertible'), failed = n('failed')
  const parts: Array<{ label: string; color: string }> = []
  if (n('scheduled')) parts.push({ label: `${n('scheduled')} set to auto-convert`, color: 'var(--brand,#7c9cff)' })
  if (n('converted')) parts.push({ label: `${n('converted')} already a VOD`, color: 'var(--ok,#3fbf6f)' })
  if (convertible) parts.push({ label: `${convertible} recorded and still convertible`, color: 'var(--warn,#e2b64f)' })
  if (failed) parts.push({ label: `${failed} failed`, color: 'var(--down,#f87171)' })
  if (n('unavailable')) parts.push({ label: `${n('unavailable')} no longer on disk`, color: 'var(--faint)' })
  if (!parts.length) return null

  // The soonest deadline among the convertible slots, which is the only number
  // here that is time-critical.
  const soonest = all
    .filter(v => v.state === 'convertible' && v.expiresAt)
    .map(v => daysUntil(v.expiresAt!))
    .sort((a, b) => a - b)[0]

  return (
    <div className="card p-3" style={{ marginBottom: 10, display: 'flex', gap: 18, flexWrap: 'wrap', alignItems: 'center' }}>
      {parts.map(part => (
        <span key={part.label} className="flex items-center" style={{ gap: 6, fontSize: 'var(--fs-sm)' }}>
          <span style={{ width: 8, height: 8, borderRadius: 4, background: part.color, display: 'inline-block' }} />
          {part.label}
        </span>
      ))}
      {convertible > 0 && soonest != null && soonest <= 7 && (
        <span style={{ fontSize: 'var(--fs-sm)', color: 'var(--warn,#e2b64f)', marginLeft: 'auto' }}>
          {soonest <= 0 ? 'Some material is already due for deletion.' : `Soonest deletion in ${soonest} day${soonest === 1 ? '' : 's'}.`}
        </span>
      )}
    </div>
  )
}

/* ---------------------------------------------------- programme drawer */
function ProgrammeDrawer({ owner, day, programme: p, vod, converting, onConvert, onClose, onDone }: {
  owner: EpgOwner; day: Date; programme: ProgrammeRow | null
  vod?: ProgrammeVod; converting?: boolean; onConvert?: () => void
  onClose: () => void; onDone: () => void
}) {
  const isEdit = !!p
  const [title, setTitle] = useState(p?.title ?? '')
  const [desc, setDesc] = useState(p?.metadata?.description ?? '')
  // The vocabulary here is not invented: description / genre / tags / rating
  // are the exact keys services/schemaOrg.ts already reads when it builds the
  // structured data for a published asset. Anything else typed into a slot
  // would be carried onto the asset and then read by nothing.
  const [genre, setGenre] = useState(p?.metadata?.genre ?? '')
  const [tags, setTags] = useState(Array.isArray(p?.metadata?.tags) ? p!.metadata!.tags.join(', ') : (p?.metadata?.tags ?? ''))
  const [rating, setRating] = useState(p?.metadata?.rating ?? '')
  const timeOf = (iso: string) => { const d = new Date(iso); return `${p2(d.getHours())}:${p2(d.getMinutes())}` }
  const [startT, setStartT] = useState(p ? timeOf(p.starts_at) : '09:00')
  const [endT, setEndT] = useState(p ? timeOf(p.ends_at) : '')
  const [autoVod, setAutoVod] = useState(p?.auto_vod ?? false)
  const [geoMode, setGeoMode] = useState<'worldwide' | 'allow' | 'block'>(p?.geo_mode ?? 'worldwide')
  const [geoCountries, setGeoCountries] = useState((p?.geo_countries ?? []).join(', '))
  const [replKind, setReplKind] = useState<'none' | 'slate' | 'loop' | 'vod'>(p?.replacement_kind ?? 'none')
  const [replRef, setReplRef] = useState(p?.replacement_ref ?? '')
  const [pickerOpen, setPickerOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [conflictNote, setConflictNote] = useState('')

  const isoAt = (t: string) => {
    const m = t.match(/^(\d{1,2}):(\d{2})$/)
    if (!m) return null
    const d = new Date(day); d.setHours(+m[1], +m[2], 0, 0)
    return d.toISOString()
  }

  async function submit() {
    setErr(''); setConflictNote('')
    if (!title.trim()) { setErr('Give the programme a title'); return }
    const startsAt = isoAt(startT)
    if (!startsAt) { setErr('Start time must be HH:MM'); return }
    const endsAt = endT.trim() ? isoAt(endT) : undefined
    if (endT.trim() && !endsAt) { setErr('End time must be HH:MM'); return }
    if (endsAt && Date.parse(endsAt) <= Date.parse(startsAt)) { setErr('End must be after start'); return }
    if (replKind !== 'none' && !replRef.trim()) { setErr('Pick the replacement asset'); return }
    const body: ProgrammeBody = {
      title: title.trim(), startsAt, ...(endsAt ? { endsAt } : {}),
      autoVod,
      geoMode,
      geoCountries: geoMode === 'worldwide' ? [] : geoCountries.split(',').map(s => s.trim().toUpperCase()).filter(s => s.length === 2),
      replacementKind: replKind,
      replacementRef: replKind === 'none' ? null : replRef.trim(),
      metadata: {
        ...(p?.metadata ?? {}),
        // Cleared fields are written as undefined-free deletions rather than
        // empty strings: an empty `genre` on the asset renders as an empty
        // genre chip downstream, which is worse than no genre at all.
        ...(desc.trim() ? { description: desc.trim() } : { description: undefined }),
        ...(genre.trim() ? { genre: genre.trim() } : { genre: undefined }),
        ...(rating.trim() ? { rating: rating.trim() } : { rating: undefined }),
        ...(tags.trim()
          ? { tags: tags.split(',').map((t: string) => t.trim()).filter(Boolean) }
          : { tags: undefined }),
      },
    }
    setBusy(true)
    try {
      if (isEdit) await api.patchProgramme(p!.id, body)
      else {
        const created = await api.createProgramme(owner, body)
        if (created.conflicts?.length) setConflictNote(`Note: overlaps ${created.conflicts.map(c => `"${c.title}"`).join(', ')}`)
      }
      onDone()
    } catch (e: any) { setErr(e.message) } finally { setBusy(false) }
  }

  return (
    <div className="drawer-scrim" {...pressable((e: any) => { ((onClose) as any)(e) })} data-a11y-click="">
      <div className="drawer" {...pressable((e: any) => { (((e: any) => e.stopPropagation()) as any)(e) })} data-a11y-click="">
        <div className="drawer-h"><div className="t">{isEdit ? 'Edit programme' : 'Add programme'}</div><button className="xbtn" onClick={onClose}>✕</button></div>
        <div className="drawer-b">
          <div className="field"><label>Title <span style={{ color: 'var(--faint)' }}>— also names the auto-clip asset</span></label>
            <input className="inp" value={title} onChange={e => setTitle(e.target.value)} placeholder="e.g. Berita Utama" />
          </div>
          <div className="field"><label>Description <span style={{ color: 'var(--faint)' }}>— carried onto the clip/VOD metadata</span></label>
            <input className="inp" value={desc} onChange={e => setDesc(e.target.value)} placeholder="optional synopsis" />
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
            <div className="field"><label>Genre <span style={{ color: 'var(--faint)' }}>— carried onto the asset</span></label>
              <input className="inp" value={genre} onChange={e => setGenre(e.target.value)} placeholder="e.g. News" />
            </div>
            <div className="field"><label>Rating</label>
              <input className="inp" value={rating} onChange={e => setRating(e.target.value)} placeholder="e.g. PG" />
            </div>
          </div>
          <div className="field"><label>Tags <span style={{ color: 'var(--faint)' }}>— comma separated, become the asset's keywords</span></label>
            <input className="inp" value={tags} onChange={e => setTags(e.target.value)} placeholder="politics, bulletin" />
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
            <div className="field"><label>Start</label>
              <input className="inp" value={startT} onChange={e => setStartT(e.target.value)} placeholder="HH:MM" style={{ fontFamily: 'ui-monospace,monospace' }} />
            </div>
            <div className="field"><label>End <span style={{ color: 'var(--faint)' }}>— blank = runs to the next programme</span></label>
              <input className="inp" value={endT} onChange={e => setEndT(e.target.value)} placeholder="HH:MM" style={{ fontFamily: 'ui-monospace,monospace' }} />
            </div>
          </div>

          <div className="sec-label">Slot controls</div>
          <div className="field"><label>Geo access for this period</label>
            <select className="inp" value={geoMode} onChange={e => setGeoMode(e.target.value as any)}>
              <option value="worldwide">Worldwide</option>
              <option value="allow">Allow only listed countries</option>
              <option value="block">Block listed countries</option>
            </select>
          </div>
          {geoMode !== 'worldwide' && (
            <div className="field"><label>Countries <span style={{ color: 'var(--faint)' }}>— 2-letter codes, comma separated</span></label>
              <input className="inp" value={geoCountries} onChange={e => setGeoCountries(e.target.value)} placeholder="MY, SG, ID" />
            </div>
          )}
          <div className="field"><label>Replacement for this period <span style={{ color: 'var(--faint)' }}>— play this instead of the live feed</span></label>
            <select className="inp" value={replKind} onChange={e => setReplKind(e.target.value as any)}>
              <option value="none">None — air the live feed</option>
              <option value="slate">Slate image</option>
              <option value="loop">Loop video</option>
              <option value="vod">VOD asset</option>
            </select>
          </div>
          {replKind !== 'none' && (
            <div className="field"><label>{replKind === 'vod' ? 'VOD reference' : replKind === 'loop' ? 'Loop video' : 'Slate image'}</label>
              <div style={{ display: 'flex', gap: 8 }}>
                <input className="inp" value={replRef} onChange={e => setReplRef(e.target.value)} placeholder={replKind === 'vod' ? 'vod asset URL or id' : 'Pick from library or paste a URL'} />
                {replKind !== 'vod' && <button type="button" className="btn ghost" onClick={() => setPickerOpen(true)}>Browse…</button>}
              </div>
            </div>
          )}
          <ImagePicker open={pickerOpen} kinds={replKind === 'loop' ? ['loop', 'clip', 'vod', 'other'] : ['slate', 'brand', 'other']}
            title={replKind === 'loop' ? 'Choose a loop video' : 'Choose or upload a slate image'}
            uploadKind="slate" uploadFolder="slates" allowUpload={replKind !== 'loop'}
            onClose={() => setPickerOpen(false)} onPick={(url) => { setReplRef(url); setPickerOpen(false) }} />

          <div className="sec-label">Post-broadcast VOD</div>
          <div className="toggle-row">
            <div><div className="tt">Convert to a VOD automatically</div><div className="td">When this slot finishes airing, cut a VOD asset of exactly this period from the recording. The asset is named from the title above and carries the genre, tags and rating set here.</div></div>
            <div className={`sw ${autoVod ? '' : 'off'}`} {...pressable((e: any) => { ((() => setAutoVod(v => !v)) as any)(e) })} data-a11y-click=""><i /></div>
          </div>
          {/* Turning the switch off on a slot that has ALREADY aired changes
              nothing, and saying so beats letting an operator think they have
              undone something. The conversion decision for an aired slot is
              the button below, not the switch above. */}
          {isEdit && vod && !vod.future && (
            <div className="hintxt" style={{ color: 'var(--faint)' }}>
              This slot has already finished airing, so the switch above only affects it if the times are changed.
            </div>
          )}

          {/* WHERE THIS SLOT ACTUALLY IS, rather than what was configured for
              it. The two diverge constantly: auto-VOD on and the conversion
              failed, auto-VOD off and the material is still sitting on disk.
              The row column says the same thing at a glance; this says it with
              the numbers and the action. */}
          {isEdit && vod && (
            <div style={{
              border: '1px solid var(--border)', borderRadius: 10, padding: 12, marginTop: 10,
              borderLeft: `3px solid ${VOD_UI[vod.state].color}`,
            }}>
              <div className="flex items-center" style={{ gap: 10 }}>
                <strong style={{ color: VOD_UI[vod.state].color }}>{VOD_UI[vod.state].label}</strong>
                <span className="spacer" />
                {(vod.state === 'convertible' || vod.state === 'failed') && onConvert && (
                  <button type="button" className="btn" disabled={!!converting} onClick={onConvert}>
                    {converting ? 'Converting…' : vod.state === 'failed' ? 'Retry conversion' : 'Convert now'}
                  </button>
                )}
              </div>
              <div style={{ fontSize: 'var(--fs-sm)', color: 'var(--muted)', marginTop: 4 }}>
                {VOD_UI[vod.state].hint}
              </div>
              {vod.state === 'convertible' && (
                <div style={{ fontSize: 'var(--fs-sm)', color: 'var(--faint)', marginTop: 6 }}>
                  {vod.coveragePct >= 99.9
                    ? 'The recording covers the whole slot.'
                    : `The recording covers ${vod.coveragePct}% of the slot; the asset will have a gap.`}
                  {vod.expiresAt && (() => {
                    const d = daysUntil(vod.expiresAt!)
                    return d <= 0
                      ? ' The material is already due for deletion.'
                      : ` The material is kept for another ${d} day${d === 1 ? '' : 's'}.`
                  })()}
                </div>
              )}
              {vod.state === 'converted' && vod.assetTitle && (
                <div style={{ fontSize: 'var(--fs-sm)', color: 'var(--faint)', marginTop: 6 }}>
                  Asset: {vod.assetTitle}{vod.assetState ? ` (${vod.assetState})` : ''} — find it in the Media Library.
                </div>
              )}
              {vod.state === 'failed' && vod.error && <div className="err" style={{ marginTop: 8 }}>{vod.error}</div>}
            </div>
          )}

          {conflictNote && <div className="hintxt" style={{ color: 'var(--warn)' }}>{conflictNote}</div>}
          {err && <div className="err">{err}</div>}
        </div>
        <div className="drawer-f">
          <button className="btn ghost" onClick={onClose}>Cancel</button>
          <button className="btn primary" disabled={busy} onClick={submit}>{busy ? 'Saving…' : isEdit ? 'Save changes' : 'Add programme'}</button>
        </div>
      </div>
    </div>
  )
}

/* ---------------------------------------------------- copy day modal */
function CopyDayModal({ owner, day, count, onClose, onDone }: {
  owner: EpgOwner; day: Date; count: number; onClose: () => void; onDone: (msg: string) => void
}) {
  const [mode, setMode] = useState<'tomorrow' | 'week' | 'custom'>('tomorrow')
  const [customDates, setCustomDates] = useState<string[]>([toDateInput(new Date(day.getTime() + 86_400_000))])
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')

  async function run() {
    setErr('')
    let offsets: number[] = []
    if (mode === 'tomorrow') offsets = [1]
    else if (mode === 'week') offsets = [1, 2, 3, 4, 5, 6, 7]
    else {
      offsets = customDates.filter(Boolean).map(ds => {
        const [y, m, d] = ds.split('-').map(Number)
        return Math.round((new Date(y, m - 1, d).getTime() - day.getTime()) / 86_400_000)
      }).filter(o => o !== 0)
      if (!offsets.length) { setErr('Pick at least one target date (not the source day)'); return }
    }
    setBusy(true)
    try {
      const dayEnd = new Date(day.getTime() + 86_400_000)
      const r = await api.epgCopyDay(owner, day.toISOString(), dayEnd.toISOString(), offsets)
      onDone(`Copied ${r.copied} programme(s) onto ${offsets.length} day(s) — ${r.created} created`)
    } catch (e: any) { setErr(e.message) } finally { setBusy(false) }
  }

  return (
    <div className="drawer-scrim" {...pressable((e: any) => { ((onClose) as any)(e) })} data-a11y-click="" style={{ alignItems: 'center', justifyContent: 'center' }}>
      <div className="card" {...pressable((e: any) => { (((e: any) => e.stopPropagation()) as any)(e) })} data-a11y-click="" style={{ width: 460, maxWidth: '95vw', padding: 20 }}>
        <h3 style={{ margin: '0 0 4px' }}>Copy day</h3>
        <p style={{ color: 'var(--muted)', fontSize: 'var(--fs-sm)', margin: '0 0 12px' }}>
          Copy the {count} programme(s) of {day.toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'short' })} onto other days (same times, independent copies).
        </p>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 'var(--fs-body)', cursor: 'pointer' }}>
            <input type="radio" checked={mode === 'tomorrow'} onChange={() => setMode('tomorrow')} /> Tomorrow
          </label>
          <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 'var(--fs-body)', cursor: 'pointer' }}>
            <input type="radio" checked={mode === 'week'} onChange={() => setMode('week')} /> Each of the next 7 days
          </label>
          <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 'var(--fs-body)', cursor: 'pointer' }}>
            <input type="radio" checked={mode === 'custom'} onChange={() => setMode('custom')} /> Specific dates
          </label>
          {mode === 'custom' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6, paddingLeft: 24 }}>
              {customDates.map((d, i) => (
                <div key={i} style={{ display: 'flex', gap: 6 }}>
                  <input className="inp" type="date" value={d} onChange={e => setCustomDates(ds => ds.map((x, j) => j === i ? e.target.value : x))} />
                  <button className="xbtn" onClick={() => setCustomDates(ds => ds.filter((_, j) => j !== i))}>✕</button>
                </div>
              ))}
              <button className="btn ghost" style={{ alignSelf: 'flex-start', padding: '4px 10px', fontSize: 'var(--fs-sm)' }}
                onClick={() => setCustomDates(ds => [...ds, toDateInput(new Date(day.getTime() + 86_400_000))])}>+ Add date</button>
            </div>
          )}
        </div>
        {err && <div className="err" style={{ marginTop: 10 }}>{err}</div>}
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 16 }}>
          <button className="btn ghost" onClick={onClose}>Cancel</button>
          <button className="btn primary" disabled={busy || count === 0} onClick={run}>{busy ? 'Copying…' : 'Copy'}</button>
        </div>
      </div>
    </div>
  )
}
