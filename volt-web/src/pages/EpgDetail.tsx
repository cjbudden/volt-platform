import { useEffect, useMemo, useState } from 'react'
import { api, type EpgOwner, type EpgOwnerRow, type ProgrammeRow, type ProgrammeConflict, type ProgrammeBody } from '../api'
import { ImagePicker } from '../ImagePicker'

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

export default function EpgDetail({ owner, onBack }: { owner: EpgOwner; onBack: () => void }) {
  const [ownerRow, setOwnerRow] = useState<EpgOwnerRow | null>(null)
  const [day, setDay] = useState(() => { const d = new Date(); d.setHours(0, 0, 0, 0); return d })
  const [progs, setProgs] = useState<ProgrammeRow[] | null>(null)
  const [conflicts, setConflicts] = useState<ProgrammeConflict[]>([])
  const [err, setErr] = useState('')
  const [editing, setEditing] = useState<ProgrammeRow | 'new' | null>(null)
  const [copyOpen, setCopyOpen] = useState(false)
  const [toast, setToast] = useState('')

  const dayStart = day
  const dayEnd = useMemo(() => new Date(day.getTime() + 86_400_000), [day])

  async function load() {
    try {
      setErr('')
      const [p, c] = await Promise.all([
        api.epgProgrammes(owner, dayStart.toISOString(), dayEnd.toISOString()),
        api.epgConflicts(owner, dayStart.toISOString(), dayEnd.toISOString()),
      ])
      setProgs(p); setConflicts(c)
    } catch (e: any) { setErr(e.message) }
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
          {conflicts.length} overlap(s) today: {conflicts.slice(0, 3).map(c => `"${c.a_title}" ↔ "${c.b_title}"`).join(', ')}{conflicts.length > 3 ? '…' : ''} — overlaps are allowed but check they are intended.
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
        <div className="card">
          <table>
            <thead><tr><th>Start</th><th>End</th><th>Dur</th><th>Programme</th><th>Geo</th><th>Replacement</th><th>Auto clip</th><th></th></tr></thead>
            <tbody>
              {progs.map(p => {
                const live = Date.parse(p.starts_at) <= Date.now() && Date.now() < Date.parse(p.ends_at)
                return (
                  <tr key={p.id} onClick={() => setEditing(p)} style={{ cursor: 'pointer', background: live ? 'rgba(120,140,255,.06)' : undefined }}>
                    <td style={{ fontFamily: 'ui-monospace,monospace' }}>{fmtT(p.starts_at)}</td>
                    <td style={{ fontFamily: 'ui-monospace,monospace', color: 'var(--muted)' }}>{fmtT(p.ends_at)}</td>
                    <td style={{ color: 'var(--muted)' }}>{fmtDur(Date.parse(p.ends_at) - Date.parse(p.starts_at))}</td>
                    <td><b>{p.title}</b>{live && <span className="badge live" style={{ marginLeft: 8 }}>ON NOW</span>}
                      {p.metadata?.description && <div style={{ fontSize: 'var(--fs-xs)', color: 'var(--faint)', maxWidth: 320, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.metadata.description}</div>}
                    </td>
                    <td style={{ color: p.geo_mode === 'worldwide' ? 'var(--faint)' : 'var(--warn,#e2b64f)', fontSize: 'var(--fs-sm)' }}>
                      {GEO_LABEL[p.geo_mode]}{p.geo_mode !== 'worldwide' && p.geo_countries.length ? ` (${p.geo_countries.slice(0, 3).join(',')}${p.geo_countries.length > 3 ? '…' : ''})` : ''}
                    </td>
                    <td style={{ color: p.replacement_kind === 'none' ? 'var(--faint)' : 'var(--brand)', fontSize: 'var(--fs-sm)' }}>{REPL_LABEL[p.replacement_kind]}</td>
                    <td style={{ fontSize: 'var(--fs-sm)' }}>
                      {!p.auto_vod ? <span style={{ color: 'var(--faint)' }}>—</span>
                        : p.clip_status === 'created' ? <span style={{ color: 'var(--ok,#3fbf6f)' }}>created</span>
                        : p.clip_status === 'error' ? <span style={{ color: 'var(--down,#f87171)' }} title={p.clip_error || ''}>failed</span>
                        : <span style={{ color: 'var(--muted)' }}>on end</span>}
                    </td>
                    <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }} onClick={e => e.stopPropagation()}>
                      <button className="btn ghost" onClick={() => setEditing(p)}>Edit</button>
                      <button className="btn ghost" style={{ marginLeft: 6 }} onClick={() => remove(p)}>✕</button>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      {editing && <ProgrammeDrawer owner={owner} day={day} programme={editing === 'new' ? null : editing}
        onClose={() => setEditing(null)} onDone={() => { setEditing(null); load() }} />}
      {copyOpen && <CopyDayModal owner={owner} day={day} count={progs?.length ?? 0}
        onClose={() => setCopyOpen(false)} onDone={(msg) => { setCopyOpen(false); flash(msg); load() }} />}
      {toast && (
        <div style={{ position: 'fixed', left: '50%', bottom: 26, transform: 'translateX(-50%)', zIndex: 60, background: 'var(--panel-3,#161b26)', border: '1px solid var(--border)', padding: '10px 16px', borderRadius: 10, fontSize: 'var(--fs-body)' }}>{toast}</div>
      )}
    </>
  )
}

/* ---------------------------------------------------- programme drawer */
function ProgrammeDrawer({ owner, day, programme: p, onClose, onDone }: {
  owner: EpgOwner; day: Date; programme: ProgrammeRow | null; onClose: () => void; onDone: () => void
}) {
  const isEdit = !!p
  const [title, setTitle] = useState(p?.title ?? '')
  const [desc, setDesc] = useState(p?.metadata?.description ?? '')
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
      metadata: { ...(p?.metadata ?? {}), ...(desc.trim() ? { description: desc.trim() } : {}) },
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
    <div className="drawer-scrim" onClick={onClose}>
      <div className="drawer" onClick={e => e.stopPropagation()}>
        <div className="drawer-h"><div className="t">{isEdit ? 'Edit programme' : 'Add programme'}</div><button className="xbtn" onClick={onClose}>✕</button></div>
        <div className="drawer-b">
          <div className="field"><label>Title <span style={{ color: 'var(--faint)' }}>— also names the auto-clip asset</span></label>
            <input className="inp" value={title} onChange={e => setTitle(e.target.value)} placeholder="e.g. Berita Utama" />
          </div>
          <div className="field"><label>Description <span style={{ color: 'var(--faint)' }}>— carried onto the clip/VOD metadata</span></label>
            <input className="inp" value={desc} onChange={e => setDesc(e.target.value)} placeholder="optional synopsis" />
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

          <div className="toggle-row">
            <div><div className="tt">Auto clip after airing</div><div className="td">When this slot ends, cut a clip/VOD of exactly this period from the recording. The asset is named from the title above and carries this programme's metadata.</div></div>
            <div className={`sw ${autoVod ? '' : 'off'}`} onClick={() => setAutoVod(v => !v)}><i /></div>
          </div>
          {isEdit && p!.clip_status === 'error' && <div className="err">Last auto-clip failed: {p!.clip_error}</div>}
          {isEdit && p!.clip_status === 'created' && <div style={{ color: 'var(--ok,#3fbf6f)', fontSize: 'var(--fs-sm)' }}>Auto-clip created — see the VOD library.</div>}

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
    <div className="drawer-scrim" onClick={onClose} style={{ alignItems: 'center', justifyContent: 'center' }}>
      <div className="card" onClick={e => e.stopPropagation()} style={{ width: 460, maxWidth: '95vw', padding: 20 }}>
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
