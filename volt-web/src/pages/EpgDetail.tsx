import { useEffect, useMemo, useRef, useState } from 'react'
import { api, ApiError, type EpgOwner, type EpgOwnerRow, type ProgrammeRow, type ProgrammeConflict, type ProgrammeBody, type ProgrammeVod, type VodState, type EpgScope, type EpgSeriesInfo, type RepeatPolicy } from '../api'
import { FillerField } from '../FillerField'
import { pressable } from '../a11y'
import { navigate } from '../router'
import { FormStatus, useNotify, usePageNotice, useSaveResult } from '../notices'
import { Segmented } from '../listFilters'
import { EpgTimeline } from './EpgTimeline'
import { CopyDayModal, RepeatEditor, PolicyPicker, PlacePreview, usePreview, defaultRepeat, toRule, browserTz, toDateInput as ymd, type RepeatValue } from './EpgRepeat'
import { assetHref, recordingHref, ProgrammeFlagMark } from '../programmeMedia'

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
// `tone` is the status pill's state class (.tag / .dot-s): state is carried by
// the pill's dot and word, on a neutral card, never by a coloured edge bar.
const VOD_UI: Record<VodState, { label: string; color: string; tone: 'idle' | 'sched' | 'warn' | 'live' | 'down'; hint: string }> = {
  manual:      { label: 'Manual',      color: 'var(--faint)',        tone: 'idle',  hint: 'No automatic conversion. It can still be converted after it airs.' },
  scheduled:   { label: 'Auto on end', color: 'var(--brand,#7c9cff)',tone: 'sched', hint: 'Will be converted to a VOD asset when the slot finishes airing.' },
  converting:  { label: 'Converting',  color: 'var(--warn,#e2b64f)', tone: 'warn',  hint: 'The conversion is running now.' },
  converted:   { label: 'VOD ready',   color: 'var(--ok,#3fbf6f)',   tone: 'live',  hint: 'A VOD asset exists for this slot.' },
  failed:      { label: 'Failed',      color: 'var(--down,#f87171)', tone: 'down',  hint: 'The automatic conversion errored. It can be retried.' },
  convertible: { label: 'Recorded',    color: 'var(--warn,#e2b64f)', tone: 'warn',  hint: 'Aired and still on disk. Convert it before retention removes it.' },
  unavailable: { label: 'Not on disk', color: 'var(--faint)',        tone: 'idle',  hint: 'Aired, but no recording covers this slot any more.' },
}

/** Days until a date, floored. Negative means it has already passed. */
function daysUntil(iso: string): number {
  return Math.floor((Date.parse(iso) - Date.now()) / 86_400_000)
}

export default function EpgDetail({ owner, onBack }: { owner: EpgOwner; onBack: () => void }) {
  const [ownerRow, setOwnerRow] = useState<EpgOwnerRow | null>(null)
  // ?day=YYYY-MM-DD opens on that day, ?p=<id> marks that programme: the
  // guide strip's double click lands here (ChannelDetail EpgStrip).
  const linkQ = useMemo(() => new URLSearchParams(window.location.search), [])
  const [day, setDay] = useState(() => {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(linkQ.get('day') ?? '')
    const d = m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : new Date()
    d.setHours(0, 0, 0, 0); return d
  })
  const [marked, setMarked] = useState<string | null>(() => linkQ.get('p'))
  useEffect(() => {
    if (!marked) return
    const el = document.querySelector(`[data-prog="${CSS.escape(marked)}"]`)
    if (el) { el.scrollIntoView({ block: 'center', behavior: 'smooth' }); const t = window.setTimeout(() => setMarked(null), 4000); return () => window.clearTimeout(t) }
  })
  const [progs, setProgs] = useState<ProgrammeRow[] | null>(null)
  const [vod, setVod] = useState<Record<string, ProgrammeVod>>({})
  const [converting, setConverting] = useState<string | null>(null)
  const [conflicts, setConflicts] = useState<ProgrammeConflict[]>([])
  const [err, setErr] = useState('')
  const [errStatus, setErrStatus] = useState(0)
  const notify = useNotify()
  const [editing, setEditing] = useState<ProgrammeRow | 'new' | null>(null)
  // "Add programme" from the timeline opens at the clicked time.
  const [newAt, setNewAt] = useState<string | undefined>(undefined)
  // List or timeline: the same day, two readings of it. Remembered per viewer.
  const [view, setView] = useState<'list' | 'timeline'>(() => {
    try { return localStorage.getItem('volt.epg.view') === 'timeline' ? 'timeline' : 'list' } catch { return 'list' }
  })
  useEffect(() => { try { localStorage.setItem('volt.epg.view', view) } catch { /* per-viewer nicety only */ } }, [view])
  const addAt = (hhmm?: string) => { setNewAt(hhmm); setEditing('new') }
  const [copyOpen, setCopyOpen] = useState(false)
  // A toast can carry an Undo: copy, repeat and clear record a batch the
  // server can reverse, which is a better safety net than a confirm dialog.
  const [toast, setToast] = useState<{ msg: string; batchId?: string | null } | null>(null)
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

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
      setErr(''); setErrStatus(0)
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
    } catch (e: any) { setErr(e.message); setErrStatus(e instanceof ApiError ? e.status : 0) }
  }

  /** Convert one aired slot now. The same conversion the scheduler runs. */
  async function convert(p: ProgrammeRow) {
    setConverting(p.id)
    try {
      await api.convertProgramme(p.id)
      flash(`"${p.title}" is being converted to a VOD asset`)
      await load()
    } catch (e: any) { notify({ kind: 'error', message: e.message }) } finally { setConverting(null) }
  }
  useEffect(() => { load() /* eslint-disable-next-line */ }, [owner.kind, owner.id, day.getTime()])
  useEffect(() => {
    api.epgOwners().then(rs => setOwnerRow(rs.find(r => r.kind === owner.kind && r.id === owner.id) ?? null)).catch(() => {})
  }, [owner.kind, owner.id])

  function flash(m: string, batchId?: string | null) {
    if (toastTimer.current) clearTimeout(toastTimer.current)
    setToast({ msg: m, batchId })
    toastTimer.current = setTimeout(() => setToast(null), batchId ? 12000 : 3000)
  }
  async function undo(batchId: string) {
    try {
      const r = await api.epgUndo(batchId)
      flash(`Undone: ${r.removed} removed${r.restored ? `, ${r.restored} restored` : ''}${r.keptStarted ? `. ${r.keptStarted} already started and were kept` : ''}`)
      load()
    } catch (e: any) { notify({ kind: 'error', message: e.message }) }
  }
  async function remove(p: ProgrammeRow) {
    if (!window.confirm(p.series_id
      ? `Remove this "${p.title}" only? Its other repeats stay. To change or remove the repeat, open the programme.`
      : `Remove "${p.title}"?`)) return
    try { await api.deleteProgramme(p.id); load() } catch (e: any) { notify({ kind: 'error', message: e.message }) }
  }
  async function clearDay() {
    if (!window.confirm(`Clear all programmes on ${day.toDateString()}? You can undo this straight after.`)) return
    try { const r = await api.epgClearDay(owner, dayStart.toISOString(), dayEnd.toISOString()); flash(`${r.deleted} programme(s) removed`, r.batchId); load() }
    catch (e: any) { notify({ kind: 'error', message: e.message }) }
  }

  /* SAY WHY, AND OFFER THE WAY OUT. A bare "Owner not found" under "Couldn't
     load this day" read as a broken guide when the real cause is that the guide's
     owner is not in this account (deleted, a stale bookmark, a mistyped link, or
     another tenant's id). A guide needs nothing created first: programmes hang off
     the channel or event itself, so the fix is to pick an owner that exists or
     create one. Anything else (403, 5xx, network) keeps its own message + Retry. */
  const what = owner.kind === 'event' ? 'event' : owner.kind === 'radio' ? 'station' : 'channel'
  const createPath = owner.kind === 'event' ? '/events?new' : owner.kind === 'radio' ? '/radio/new' : '/channels/new'
  const loadNotice = !err ? null
    : errStatus === 404 ? {
        kind: 'error' as const,
        title: `This ${what} isn't in your account, so it has no guide to show.`,
        message: `No ${what} with id ${owner.id} was found. It may have been deleted, or the link is out of date. ` +
          `A guide needs nothing set up first: open a ${what} that exists and add programmes, or create a new ${what}.`,
        actions: [
          { label: 'Choose from the EPG list', onClick: () => navigate('/epg') },
          { label: `Create a new ${what}`, onClick: () => navigate(createPath) },
          { label: 'Retry', onClick: () => { load() } },
        ],
      }
    : errStatus === 403 ? {
        kind: 'error' as const,
        title: `You don't have access to this ${what}'s guide.`,
        message: `${err}. Ask an account admin for EPG access, or choose a guide you can edit.`,
        actions: [{ label: 'Choose from the EPG list', onClick: () => navigate('/epg') }],
      }
    : { kind: 'error' as const, title: "Couldn't load this day.", message: err, actions: [{ label: 'Retry', onClick: () => { load() } }] }
  usePageNotice('load', loadNotice)
  usePageNotice('overlaps', conflicts.length > 0 ? {
    kind: 'warn', message: `${conflicts.length} overlap${conflicts.length === 1 ? '' : 's'} today. Overlaps are allowed, but the highlighted rows should be checked.`,
  } : null)

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
        {/* No owner, no guide: these would only fail with the same 404. */}
        {errStatus !== 404 && <>
        <button className="btn ghost" onClick={() => setCopyOpen(true)}>Copy or repeat day…</button>
        <button className="btn ghost" onClick={clearDay}>Clear day</button>
        <button className="btn primary" onClick={() => addAt()}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" style={{ width: 15 }}><path d="M12 5v14M5 12h14" /></svg>Add programme
        </button>
        </>}
      </div>

      {/* day navigation */}
      <div className="filters" style={{ alignItems: 'center' }}>
        <button className="btn ghost" onClick={() => shiftDay(-1)}>← Prev</button>
        <input className="inp" type="date" value={toDateInput(day)}
          onChange={e => { const [y, m, d] = e.target.value.split('-').map(Number); if (y) setDay(new Date(y, m - 1, d)) }}
          style={{ width: 160 }} />
        <button className="btn ghost" onClick={() => shiftDay(1)}>Next →</button>
        <button className="btn ghost" onClick={() => { const d = new Date(); d.setHours(0, 0, 0, 0); setDay(d) }}>Today</button>
        <Segmented label="View" value={view} onChange={setView} options={[
          { value: 'list', label: 'List', icon: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01" /></svg> },
          { value: 'timeline', label: 'Timeline', icon: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 4v16M7 5h10v5H7zM7 13h13v6H7z" /></svg> },
        ]} />
        <span style={{ color: 'var(--faint)', fontSize: 'var(--fs-sm)', marginLeft: 'auto' }}>{day.toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}</span>
      </div>


      {progs === null ? (
        err ? null : <div className="loading">Loading day…</div>
      ) : view === 'timeline' ? (
        <>
        <VodSummary vod={vod} />
        <EpgTimeline day={day} progs={progs} vod={vod} overlapsById={overlapsById} ownerWord={what}
          onEdit={p => setEditing(p)} onAdd={hhmm => addAt(hhmm)} />
        </>
      ) : progs.length === 0 ? (
        <div className="empty">
          <h3>Nothing scheduled on this day</h3>
          <p>Add the first programme, or use Copy day to repeat another day's schedule here.</p>
          <button className="btn primary" onClick={() => addAt()} style={{ margin: '0 auto' }}>Add programme</button>
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
                  <tr key={p.id} data-prog={p.id} className={marked === p.id ? 'row-marked' : undefined} onClick={() => setEditing(p)}
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
                      {p.series_id && <span className="badge" style={{ marginLeft: 8 }} title={p.series_detached ? 'Part of a repeat, changed on its own' : 'Part of a repeat'}>{p.series_detached ? 'Repeat, edited' : 'Repeats'}</span>}
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

      {editing && <ProgrammeDrawer owner={owner} day={day} programme={editing === 'new' ? null : editing} initialStart={newAt}
        vod={editing === 'new' ? undefined : vod[editing.id]}
        converting={editing !== 'new' && converting === editing.id}
        onConvert={editing === 'new' ? undefined : () => convert(editing)}
        onClose={() => setEditing(null)} onDone={(msg, batchId) => { setEditing(null); if (msg) flash(msg, batchId); load() }} />}
      {copyOpen && <CopyDayModal owner={owner} day={day} count={progs?.length ?? 0}
        onClose={() => setCopyOpen(false)} onDone={(msg, batchId) => { setCopyOpen(false); flash(msg, batchId); load() }} />}
      {toast && (
        <div className="epg-toast" role="status">
          <span>{toast.msg}</span>
          {toast.batchId && <button className="btn ghost sm" onClick={() => { const b = toast.batchId!; setToast(null); undo(b) }}>Undo</button>}
        </div>
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
  // THE PROGRAMME FLAG (programmeMedia.tsx) is the column now: the same flag
  // as every other surface, a link to what exists, the details on hover. An
  // entry with no flag (upcoming, not set to Auto VOD) shows a quiet dash.
  if ('flag' in v) {
    return v.flag
      ? <div className="flex items-center gap-2"><ProgrammeFlagMark flag={v.flag} />
          {v.state === 'convertible' && v.coveragePct < 99.9 && <span style={{ fontSize: 'var(--fs-xs)', color: 'var(--faint)' }}>{v.coveragePct}% recorded</span>}</div>
      : <span style={{ color: 'var(--faint)' }} title="Will be recorded. Not set to become VOD.">—</span>
  }
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
/** Exported so the Live Streams timeline opens the same drawer for a future slot. */
export function ProgrammeDrawer({ owner, day, programme: p, initialStart, initialEnd, vod, converting, onConvert, onClose, onDone }: {
  owner: EpgOwner; day: Date; programme: ProgrammeRow | null; initialStart?: string; initialEnd?: string
  vod?: ProgrammeVod; converting?: boolean; onConvert?: () => void
  onClose: () => void; onDone: (msg?: string, batchId?: string | null) => void
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
  const [startT, setStartT] = useState(p ? timeOf(p.starts_at) : (initialStart ?? '09:00'))
  const [endT, setEndT] = useState(p ? timeOf(p.ends_at) : (initialEnd ?? ''))
  const [autoVod, setAutoVod] = useState(p?.auto_vod ?? false)
  const saved = useSaveResult()
  const [geoMode, setGeoMode] = useState<'worldwide' | 'allow' | 'block'>(p?.geo_mode ?? 'worldwide')
  const [geoCountries, setGeoCountries] = useState((p?.geo_countries ?? []).join(', '))
  const [replKind, setReplKind] = useState<'none' | 'slate' | 'loop' | 'vod'>(p?.replacement_kind ?? 'none')
  const [replRef, setReplRef] = useState(p?.replacement_ref ?? '')
  // A slate or loop replacement comes from Loops & Fillers, the same picker as
  // a stream's Filler on total loss, so a loop uploaded there can be chosen
  // here. It is stored as that asset's id; a programme saved before keeps its
  // Image Library address, shown as such with a copy into Loops & Fillers.
  const fillerId = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(replRef) ? replRef : null
  // Closing by hand while "Saved" is held still reloads the guide behind.
  const close = () => { if (!saved.flush()) onClose() }
  // A VOD REPLACEMENT IS PICKED FROM READY ASSETS ONLY: what a blocked viewer
  // gets must play (volt-app services/assetReadiness.ts; the API refuses others).
  const [readyVods, setReadyVods] = useState<{ id: string; title: string | null; duration_ms: any }[] | null>(null)
  useEffect(() => {
    if (replKind !== 'vod' || readyVods) return
    api.vodAssets().then(rows => setReadyVods(rows.filter(r => r.usage_status === 'ready'))).catch(() => setReadyVods([]))
  }, [replKind, readyVods])
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [conflictNote, setConflictNote] = useState('')

  const isoAt = (t: string) => {
    const m = t.match(/^(\d{1,2}):(\d{2})$/)
    if (!m) return null
    const d = new Date(day); d.setHours(+m[1], +m[2], 0, 0)
    return d.toISOString()
  }

  /* REPEAT. A programme that is not yet part of a repeat can be set to repeat
     here; one that is shows which repeat, and asks which occurrences a change
     or delete applies to. A programme from an imported feed repeats when the
     feed says so and is not offered a repeat of its own. */
  const tz = browserTz()
  const isSeries = !!(p?.series_id && p?.series_key)
  const isImported = !!(p?.source_ref && !p.source_ref.startsWith('series:'))
  const [repeat, setRepeat] = useState<RepeatValue>(() => defaultRepeat(day))
  const [policy, setPolicy] = useState<RepeatPolicy>('replace')
  const [scope, setScope] = useState<EpgScope>('this')
  const [series, setSeries] = useState<EpgSeriesInfo | null>(null)
  useEffect(() => { if (p?.series_id) api.epgSeries(p.series_id).then(setSeries).catch(() => setSeries(null)) }, [p?.series_id])
  const startIso = isoAt(startT)
  // An end at or before the start is the next day (23:30 to 00:30), not an error.
  const endSameDay = endT.trim() ? isoAt(endT) : null
  const endIso = endSameDay && startIso && Date.parse(endSameDay) <= Date.parse(startIso)
    ? new Date(Date.parse(endSameDay) + 86_400_000).toISOString() : endSameDay
  const repeatRule = !isSeries && !isImported ? toRule(repeat, day) : null
  const repeatErr = repeatRule && 'error' in repeatRule ? repeatRule.error
    : repeatRule && !endIso ? 'Set an end time so every repeat has a length' : ''
  const previewBody = repeatRule && !('error' in repeatRule) && !repeatErr && startIso && endIso && Date.parse(endIso) > Date.parse(startIso) && title.trim()
    ? { title: title.trim(), startsAt: startIso, endsAt: endIso, ...repeatRule, policy } : null
  const pv = usePreview(JSON.stringify(previewBody), previewBody ? () => api.epgRepeat({ owner, ...previewBody, tz, dryRun: true }) : null)
  const scopeWord = scope === 'this' ? 'this one' : scope === 'following' ? 'this and following' : 'all repeats'

  async function stopAfterThis() {
    if (!p || !series) return
    const from = ymd(new Date(new Date(p.starts_at).getTime() + 86_400_000))
    if (!window.confirm(`Stop repeating after ${new Date(p.starts_at).toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' })}? Later repeats that have not aired are removed.`)) return
    setBusy(true)
    try { const r = await api.epgEndSeries(series.id, from); onDone(`Repeat stopped: ${r.deleted} later programme(s) removed`) }
    catch (e: any) { setErr(e.message) } finally { setBusy(false) }
  }

  async function del() {
    if (!p) return
    const sc: EpgScope = isSeries ? scope : 'this'
    const msg = sc === 'this' ? `Delete "${p.title}"${isSeries ? ' (this one only)' : ''}?`
      : sc === 'following' ? `Delete "${p.title}" on this day and every later repeat?` : `Delete "${p.title}" from every repeat that has not aired?`
    if (!window.confirm(msg)) return
    setBusy(true)
    try { await api.deleteProgramme(p.id, sc); onDone(sc === 'this' ? `"${p.title}" deleted` : `"${p.title}" deleted from ${scopeWord}`) }
    catch (e: any) { setErr(e.message) } finally { setBusy(false) }
  }

  async function submit() {
    setErr(''); setConflictNote('')
    if (!title.trim()) { setErr('Give the programme a title'); return }
    const startsAt = isoAt(startT)
    if (!startsAt) { setErr('Start time must be HH:MM'); return }
    if (endT.trim() && !endSameDay) { setErr('End time must be HH:MM'); return }
    const endsAt = endIso ?? undefined
    if (endsAt && Date.parse(endsAt) - Date.parse(startsAt) > 24 * 3_600_000) { setErr('A programme is at most 24 hours'); return }
    if (replKind !== 'none' && !replRef.trim()) { setErr('Pick the replacement asset'); return }
    if (repeatErr) { setErr(repeatErr); return }
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
    setBusy(true); saved.clear()
    try {
      let id = p?.id
      let note: string | undefined
      let overlap: string | null = null
      if (isEdit) {
        const r: any = await api.patchProgramme(p!.id, isSeries ? { ...body, scope } : body)
        if (r?.repeat) note = `Changed ${r.repeat.updated} repeat(s)${r.repeat.keptEdited ? `. ${r.repeat.keptEdited} changed on their own were left as they are` : ''}`
      } else {
        const created = await api.createProgramme(owner, body)
        id = created.id
        if (created.conflicts?.length) { overlap = `It overlaps ${created.conflicts.map(c => `"${c.title}"`).join(', ')}.`; setConflictNote(`Note: ${overlap}`) }
      }
      if (repeatRule && !('error' in repeatRule) && id) {
        const r = await api.epgRepeat({ programmeId: id, ...repeatRule, policy, tz })
        const msg = `"${title.trim()}" now repeats (${r.describe ?? 'repeat'}): ${r.summary.added} added${r.summary.replaced ? `, ${r.summary.replaced} replaced` : ''}${r.summary.skipped ? `, ${r.summary.skipped} skipped` : ''}`
        if (r.summary.skipped || overlap) saved.warn(`${msg}${overlap ? `. ${overlap}` : ''}`, () => onDone(msg, r.batchId))
        else saved.show(isEdit ? 'Programme saved' : 'Programme added', () => onDone(msg, r.batchId))
        return
      }
      if (overlap) saved.warn(overlap, () => onDone(note))
      else saved.show(isEdit ? 'Programme saved' : 'Programme added', () => onDone(note))
    } catch (e: any) { setErr(e.message) } finally { setBusy(false) }
  }

  return (
    <div className="drawer-scrim" {...pressable(() => close())} data-a11y-click="">
      <div className="drawer" {...pressable((e: any) => { (((e: any) => e.stopPropagation()) as any)(e) })} data-a11y-click="">
        <div className="drawer-h"><div className="t">{isEdit ? 'Edit programme' : 'Add programme'}</div><button className="xbtn" onClick={close}>✕</button></div>
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

          <div className="sec-label">Repeat</div>
          {isSeries ? (
            <div className="rp-scope">
              <div>
                <span className="t">{series?.description ?? 'Part of a repeat'}</span>
                {series && <span className="hintxt"> · {series.kind === 'day' ? 'part of a repeated day' : 'this programme repeats'} · {series.upcoming} upcoming</span>}
              </div>
              {p?.series_detached && <div className="hintxt">This one was changed on its own, so changes to all repeats leave it as it is.</div>}
              <div>
                <div className="hintxt" style={{ marginBottom: 6 }}>Save and Delete apply to</div>
                <Segmented label="Apply to" value={scope} onChange={setScope} options={[
                  { value: 'this', label: 'This one' }, { value: 'following', label: 'This and following' }, { value: 'series', label: 'All repeats' },
                ]} />
              </div>
              {series && <button type="button" className="btn ghost sm" style={{ alignSelf: 'flex-start' }} disabled={busy} onClick={stopAfterThis}>Stop repeating after this</button>}
            </div>
          ) : isImported ? (
            <div className="hintxt">This programme comes from an imported guide feed, so it repeats when the feed says so. Use Copy or repeat day to place it on other days.</div>
          ) : (
            <>
              <RepeatEditor value={repeat} onChange={setRepeat} allowNone />
              {repeat.freq !== 'none' && (
                <>
                  <div className="field" style={{ marginTop: 10 }}><label>If a slot is already taken</label>
                    <PolicyPicker compact value={policy} onChange={setPolicy} />
                  </div>
                  {repeatErr ? <div className="err">{repeatErr}</div>
                    : <PlacePreview compact verb="Repeats add" loading={pv.loading} result={pv.result} error={pv.error} />}
                </>
              )}
            </>
          )}

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
            <select className="inp" value={replKind} onChange={e => {
              const v = e.target.value as typeof replKind
              // a VOD id is not a filler and the other way round
              if ((v === 'vod') !== (replKind === 'vod') && replKind !== 'none') setReplRef('')
              setReplKind(v)
            }}>
              <option value="none">None — air the live feed</option>
              <option value="slate">Slate image</option>
              <option value="loop">Loop video</option>
              <option value="vod">VOD asset</option>
            </select>
          </div>
          {replKind === 'vod' && (
            <div className="field"><label>VOD reference</label>
              <div style={{ display: 'flex', gap: 8 }}>
                  <select className="inp" value={replRef} onChange={e => setReplRef(e.target.value)} aria-label="Replacement asset">
                    <option value="">{readyVods == null ? 'Loading ready assets…' : readyVods.length ? 'Choose a ready asset' : 'No assets are ready to use'}</option>
                    {replRef && readyVods && !readyVods.some(v => v.id === replRef) && <option value={replRef}>Current: {replRef} (not ready)</option>}
                    {(readyVods ?? []).map(v => <option key={v.id} value={v.id}>{v.title || 'Untitled'}{v.duration_ms ? ` · ${Math.round(Number(v.duration_ms) / 60000)} min` : ''}</option>)}
                  </select>
              </div>
            </div>
          )}
          {(replKind === 'slate' || replKind === 'loop') && (
            <FillerField behavior={replKind === 'slate' ? 'slate' : 'vod_loop'}
              assetId={fillerId} onAssetId={(id) => setReplRef(id ?? '')}
              legacyRef={fillerId ? '' : replRef}
              // FillerField clears the old address right after choosing an
              // asset; with one field here that would undo the choice.
              onLegacyRef={(r) => { if (r) setReplRef(r) }} />
          )}

          <div className="sec-label">Post-broadcast VOD</div>
          <div className="toggle-row">
            <div><div className="tt">Auto VOD</div><div className="td">Every slot is recorded and kept for the channel's keep period. With Auto VOD on, the guide shows an <b>Auto VOD</b> flag until it airs, and when it finishes airing a VOD asset is cut of exactly this period from the recording. The asset is named from the title above and carries the genre, tags and rating set here.</div></div>
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
              background: 'var(--panel-2)',
            }}>
              <div className="flex items-center" style={{ gap: 10 }}>
                {vod.flag
                  ? <ProgrammeFlagMark flag={vod.flag} link={false} />
                  : <span className={`tag ${VOD_UI[vod.state].tone}`}><span className={`dot-s ${VOD_UI[vod.state].tone}`} />{VOD_UI[vod.state].label}</span>}
                <span className="spacer" />
                {/* Open what exists: the VOD, else the recording playing from this slot. */}
                {vod.state === 'converted' && vod.assetId && (
                  <button type="button" className="btn ghost" onClick={() => navigate(assetHref(vod.assetId!))}>Open VOD asset</button>
                )}
                {vod.state !== 'converted' && vod.recording && (
                  <button type="button" className="btn ghost" onClick={() => navigate(recordingHref(vod.recording!))}>Play recording</button>
                )}
                {(vod.state === 'convertible' || vod.state === 'failed') && onConvert && (
                  <button type="button" className="btn" disabled={!!converting} onClick={onConvert}>
                    {converting ? 'Converting…' : vod.state === 'failed' ? 'Retry conversion' : 'Convert now'}
                  </button>
                )}
              </div>
              <div style={{ fontSize: 'var(--fs-sm)', color: 'var(--muted)', marginTop: 4 }}>
                {vod.flag?.note || VOD_UI[vod.state].hint}
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
                  Asset: {vod.assetTitle}{vod.assetState ? ` (${vod.assetState})` : ''}, in the Media Library.
                </div>
              )}
              {vod.state === 'failed' && vod.error && <div className="err" style={{ marginTop: 8 }}>{vod.error}</div>}
            </div>
          )}

          {conflictNote && <div className="hintxt" style={{ color: 'var(--warn)' }}>{conflictNote}</div>}
        </div>
        <div className="drawer-f">
          <FormStatus error={err} success={saved.message} warning={saved.warning} onDismiss={err ? () => setErr('') : undefined} />
          {isEdit && <button className="btn ghost" style={{ color: 'var(--down,#f87171)' }} disabled={busy || saved.saving} onClick={del}>{isSeries && scope !== 'this' ? `Delete ${scopeWord}` : 'Delete'}</button>}
          <button className="btn ghost" onClick={close}>Cancel</button>
          <button className="btn primary" disabled={busy || saved.saving} onClick={submit}>
            {busy ? 'Saving…' : saved.saving ? 'Saved' : isEdit ? (isSeries ? `Save ${scopeWord}` : repeatRule && !('error' in repeatRule) ? 'Save and repeat' : 'Save changes') : repeatRule && !('error' in repeatRule) ? 'Add and repeat' : 'Add programme'}
          </button>
        </div>
      </div>
    </div>
  )
}
