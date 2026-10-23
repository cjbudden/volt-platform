import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { api } from '../api'
import { PageHead, NewButton, EntityCell, StatusTag } from '../scaffold'
import { navigate } from '../router'
import { Notice, usePageNotice, useNotify } from '../notices'
import {
  fastApi, type FastChannelRow, type FastMedia, type ChannelLibrary, type LibAsset, type LibSeries, type Lineup, type Slot, type SeriesSlot,
  type LineupSettings, type Preview, type PlannedProgramme, type ChannelAds, type AdServer, type AdTest, type AdReport, type Playout, type ReadinessRow,
} from '../fast/fastApi'
import '../fast/fast.css'
import VoltPlayerView from '../VoltPlayerView'
import { pressable } from '../a11y'

/* ============================================================================
   FAST channels: a live channel built from the library.

   The builder is a RUN ORDER, not a day: a list of slots that loops. A slot is
   a title (with optional alternates that take turns, one per pass, and an
   "every Nth pass" to rest it) or a series (the next N episodes, in order or
   shuffled, carrying on where the last pass stopped). Because the run order
   is not a day long, every pass starts at a different clock time, which is
   what spreads a movie across the week without anyone scheduling it twice.

   The repeat helper says what the run order does to a week before it airs:
   how long a pass is, how often each slot comes round, and at which times.
   The week view and the repeat report come from the server's own planner,
   the same computation that writes the guide, so what you see is what airs.
   ========================================================================== */

const fmtDur = (sec: number) => {
  const s = Math.round(sec)
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), ss = s % 60
  return h ? `${h}h ${String(m).padStart(2, '0')}m` : m ? `${m}m${ss ? ` ${String(ss).padStart(2, '0')}s` : ''}` : `${ss}s`
}
const tzNow = () => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC' } catch { return 'UTC' } }
const ZONES = (() => { try { return (Intl as any).supportedValuesOf('timeZone') as string[] } catch { return ['UTC', 'Australia/Brisbane', 'Australia/Sydney', 'Europe/London', 'America/New_York'] } })()
const localParts = (iso: string, zone: string) => {
  const p: Record<string, string> = {}
  for (const x of new Intl.DateTimeFormat('en-GB', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', weekday: 'short', hourCycle: 'h23' }).formatToParts(new Date(iso))) p[x.type] = x.value
  return { date: `${p.year}-${p.month}-${p.day}`, hm: `${p.hour}:${p.minute}`, min: Number(p.hour) * 60 + Number(p.minute), wd: p.weekday }
}
const sid = () => Math.random().toString(36).slice(2, 8)
const EVERY = [1, 2, 3, 4, 5, 6, 7, 10, 14]
const everyLabel = (n: number) => (n === 1 ? 'Every pass' : `Every ${n === 2 ? '2nd' : n === 3 ? '3rd' : `${n}th`} pass`)
const Ico = {
  up: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"><path d="m6 15 6-6 6 6" /></svg>,
  down: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"><path d="m6 9 6 6 6-6" /></svg>,
  x: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"><path d="M6 6l12 12M18 6 6 18" /></svg>,
  dup: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="8" y="8" width="12" height="12" rx="2" /><path d="M16 8V5a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h3" /></svg>,
  film: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="14" height="14"><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M7 4v16M17 4v16M3 9h4M17 9h4M3 15h4M17 15h4" /></svg>,
  series: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="14" height="14"><rect x="3" y="6" width="14" height="12" rx="2" /><path d="M7 3h12a2 2 0 0 1 2 2v10" /></svg>,
  audio: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="14" height="14"><path d="M9 18V5l12-2v13" /><circle cx="6" cy="18" r="3" /><circle cx="18" cy="16" r="3" /></svg>,
}
const MEDIA: Record<FastMedia, { label: string; icon: ReactNode; hint: string }> = {
  video: { label: 'Video', icon: Ico.film, hint: 'Films, shows and series. The library offers video assets only.' },
  audio: { label: 'Audio', icon: Ico.audio, hint: 'Music, podcasts and audio programmes. The library offers audio assets only.' },
}

export default function FastPage({ path }: { path: string }) {
  const id = path.replace(/^\/+|\/+$/g, '').split('/')[1]
  return id ? <FastBuilder key={id} id={decodeURIComponent(id)} /> : <FastList />
}

// ============================================================================ list

function FastList() {
  const [rows, setRows] = useState<FastChannelRow[] | null>(null)
  const [err, setErr] = useState('')
  const [creating, setCreating] = useState(() => new URLSearchParams(window.location.search).has('new'))
  const load = () => fastApi.channels().then(r => { setRows(r.items); setErr('') }).catch((e: any) => setErr(e.message))
  useEffect(() => { load() }, [])
  usePageNotice('fast-load', err ? { kind: 'error', title: "Couldn't load FAST channels.", message: err, actions: [{ label: 'Retry', onClick: load }] } : null)
  const MODE: Record<string, string> = { off: 'No ads', markers: 'Ad markers', stitched: 'Stitched ads' }
  return (
    <>
      <PageHead title="FAST channels" sub="Live channels built from the library: a run order of films and series that loops, with the guide written for you and ad breaks signalled for any ad platform. No encoder runs: the channel is played out from media that is already packaged."
        action={<NewButton label="New FAST channel" onClick={() => setCreating(true)} />} />
      {creating && <CreateDialog onClose={() => setCreating(false)} onCreated={(id) => navigate(`/fast/${id}`)} />}
      {rows === null ? <div className="loading">Loading FAST channels…</div> : rows.length === 0 ? (
        <div className="card card-b" style={{ textAlign: 'center', padding: 40 }}>
          <h3 style={{ margin: '0 0 6px' }}>No FAST channels yet</h3>
          <p style={{ color: 'var(--muted)', margin: '0 0 16px' }}>Pick a few films or a series from the library, set how often each repeats, and the channel is on air with a week of guide.</p>
          <button className="btn primary" onClick={() => setCreating(true)}>New FAST channel</button>
        </div>
      ) : (
        <div className="card">
          <table>
            <thead><tr><th>Channel</th><th>Lineup</th><th>On air now</th><th>Guide written to</th><th>Ads</th><th></th></tr></thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={r.id} onClick={() => navigate(`/fast/${r.id}`)} style={{ cursor: 'pointer' }}>
                  <td><EntityCell name={r.name} sub={[MEDIA[r.media ?? 'video'].label, r.zone].filter(Boolean).join(' · ')} index={i} /></td>
                  <td style={{ color: 'var(--muted)' }}>{r.lineup_id ? `${r.lineup_name} · v${r.version} · ${r.slot_count} slot${r.slot_count === 1 ? '' : 's'}` : 'No active lineup'}</td>
                  <td>{r.on_air ? <StatusTag label={r.on_air} cls="live" /> : <span style={{ color: 'var(--faint)' }}>—</span>}</td>
                  <td style={{ color: 'var(--muted)' }}>{r.applied_until ? new Date(r.applied_until).toLocaleString([], { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—'}</td>
                  <td><span className="tag type">{MODE[r.ads_mode] ?? r.ads_mode}</span></td>
                  <td style={{ textAlign: 'right' }}><button className="btn primary" onClick={(e) => { e.stopPropagation(); navigate(`/fast/${r.id}`) }}>Open</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  )
}

function CreateDialog({ onClose, onCreated }: { onClose: () => void; onCreated: (id: string) => void }) {
  const [name, setName] = useState('')
  const [groups, setGroups] = useState<{ id: string; name: string }[]>([])
  const [groupId, setGroupId] = useState('')
  const [zone, setZone] = useState(tzNow())
  const [media, setMedia] = useState<FastMedia>('video')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  useEffect(() => { api.groups().then((g: any[]) => { setGroups(g); const d = g.find((x: any) => x.is_default) ?? g[0]; if (d) setGroupId(d.id) }).catch(() => {}) }, [])
  const go = async () => {
    if (!name.trim()) { setErr('Give the channel a name'); return }
    setBusy(true); setErr('')
    try { const r = await fastApi.createChannel({ name: name.trim(), groupId, zone, media }); onCreated(r.channel.id) } catch (e: any) { setErr(e.message) } finally { setBusy(false) }
  }
  return (
    <div className="drawer-scrim" onClick={onClose} style={{ alignItems: 'center', justifyContent: 'center' }}>
      <div className="card" onClick={e => e.stopPropagation()} role="dialog" aria-label="New FAST channel" style={{ width: 460, maxWidth: '95vw', padding: 20 }}>
        <h3 style={{ margin: '0 0 12px' }}>New FAST channel</h3>
        <div className="field"><label htmlFor="fn">Name</label><input id="fn" className="inp" value={name} onChange={e => setName(e.target.value)} placeholder="Movies Plus" autoFocus /></div>
        <div className="field"><label id="fm">Channel type</label>
          <div className="fast-seg" role="radiogroup" aria-labelledby="fm">
            {(['video', 'audio'] as FastMedia[]).map(m => (
              <button key={m} type="button" role="radio" aria-checked={media === m} className={`chip${media === m ? ' active' : ''}`}
                style={{ padding: '6px 12px', display: 'inline-flex', alignItems: 'center', gap: 6 }} onClick={() => setMedia(m)}>{MEDIA[m].icon}{MEDIA[m].label}</button>
            ))}
          </div>
          <div className="hintxt">{MEDIA[media].hint} It cannot be changed later.</div></div>
        <div className="field"><label htmlFor="fg">Group</label>
          <select id="fg" className="inp" value={groupId} onChange={e => setGroupId(e.target.value)}>{groups.map(g => <option key={g.id} value={g.id}>{g.name}</option>)}</select>
          <div className="hintxt">Counts towards the group's share of the plan, like any channel.</div></div>
        <div className="field"><label htmlFor="fz">Time zone</label>
          <select id="fz" className="inp" value={zone} onChange={e => setZone(e.target.value)}>{ZONES.map(z => <option key={z}>{z}</option>)}</select>
          <div className="hintxt">The guide's clock: grid rounding, the daily restart and prime time are worked out in it.</div></div>
        {err && <Notice kind="error" message={err} variant="compact" />}
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 12 }}>
          <button className="btn ghost" onClick={onClose}>Cancel</button>
          <button className="btn primary" onClick={go} disabled={busy}>{busy ? 'Creating…' : 'Create and build lineup'}</button>
        </div>
      </div>
    </div>
  )
}

// ============================================================================ builder

type Tab = 'order' | 'week' | 'repeats' | 'ads' | 'air'

function FastBuilder({ id }: { id: string }) {
  const notify = useNotify()
  const [ch, setCh] = useState<{ id: string; name: string; status: string; onAir: boolean; media: FastMedia } | null>(null)
  const [urls, setUrls] = useState<{ hls: string; dash: string } | null>(null)
  const [lineups, setLineups] = useState<Lineup[]>([])
  const [work, setWork] = useState<Lineup | null>(null)   // the lineup being edited (a draft, or the active one read-only)
  const [slots, setSlots] = useState<Slot[]>([])
  const [settings, setSettings] = useState<LineupSettings>({})
  const [zone, setZone] = useState('UTC')
  const [dirty, setDirty] = useState(false)
  const [lib, setLib] = useState<ChannelLibrary>({ media: null, hidden: { otherMedia: 0, noSource: 0 }, inUse: [], assets: [], series: [] })
  const [preview, setPreview] = useState<Preview | null>(null)
  const [previewErr, setPreviewErr] = useState('')
  const [tab, setTab] = useState<Tab>('order')
  const [picking, setPicking] = useState<string | null>(null) // slot id taking an alternate
  const [busy, setBusy] = useState('')
  const [err, setErr] = useState('')

  const active = lineups.find(l => l.status === 'active') ?? null
  const draft = lineups.find(l => l.status === 'draft') ?? null
  const readOnly = !!work && work.status !== 'draft'
  // the run order names titles it already uses even when the library filter leaves them out
  const assetById = useMemo(() => new Map([...lib.inUse, ...lib.assets].map(a => [a.id, a])), [lib])

  const load = async (keep?: string) => {
    try {
      const r = await fastApi.channel(id)
      setCh(r.channel); setLineups(r.lineups); setUrls(r.urls ?? null)
      const w = (keep && r.lineups.find(l => l.id === keep)) || r.lineups.find(l => l.status === 'draft') || r.lineups.find(l => l.status === 'active') || r.lineups[0] || null
      setWork(w); setSlots(w?.slots ?? []); setSettings(w?.settings ?? {}); setZone(w?.zone ?? 'UTC'); setDirty(false); setErr('')
    } catch (e: any) { setErr(e.message) }
  }
  useEffect(() => { load(); fastApi.library(id).then(setLib).catch(() => {}) }, [id])
  usePageNotice('fast-builder', err ? { kind: 'error', title: "Couldn't load this channel.", message: err, actions: [{ label: 'Retry', onClick: () => load() }] } : null)

  // PREVIEW follows every edit (debounced), from the unsaved run order
  const timer = useRef<number | null>(null)
  useEffect(() => {
    if (!work) return
    if (timer.current) window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => {
      fastApi.preview(work.id, { days: 7, slots, settings, zone })
        .then(p => { setPreview(p); setPreviewErr('') })
        .catch((e: any) => setPreviewErr(e.message))
    }, 350)
    return () => { if (timer.current) window.clearTimeout(timer.current) }
  }, [work?.id, JSON.stringify(slots), JSON.stringify(settings), zone])

  /** Editing the active lineup makes a draft first: the channel keeps playing the active version until it is activated. */
  const ensureDraft = async (): Promise<Lineup | null> => {
    if (work && work.status === 'draft') return work
    if (draft) { setWork(draft); return draft }
    try {
      const d = await fastApi.newDraft(id, work?.id)
      setLineups(ls => [d, ...ls]); setWork(d)
      notify({ kind: 'info', title: 'Editing a draft.', message: 'The channel keeps playing the active lineup until you activate this one.' })
      return d
    } catch (e: any) { setErr(e.message); return null }
  }
  const edit = async (fn: (s: Slot[]) => Slot[]) => {
    if (readOnly && !(await ensureDraft())) return
    setSlots(s => fn(s)); setDirty(true)
  }
  const editSettings = async (patch: Partial<LineupSettings>) => {
    if (readOnly && !(await ensureDraft())) return
    setSettings(s => ({ ...s, ...patch })); setDirty(true)
  }

  const save = async () => {
    const w = await ensureDraft(); if (!w) return
    setBusy('save')
    try { const r = await fastApi.saveLineup(w.id, { slots, settings, zone }); setWork(r); setLineups(ls => ls.map(l => l.id === r.id ? r : l)); setDirty(false); notify({ kind: 'ok', title: 'Draft saved.' }) }
    catch (e: any) { notify({ kind: 'error', title: "Couldn't save.", message: e.message }) } finally { setBusy('') }
  }
  const activate = async () => {
    const w = await ensureDraft(); if (!w) return
    setBusy('activate')
    try {
      if (dirty) await fastApi.saveLineup(w.id, { slots, settings, zone })
      const r = await fastApi.activate(w.id)
      notify({ kind: 'ok', title: 'On air.', message: `${r.applied.inserted} programmes and ${r.applied.breaks} ad breaks written to the guide${r.applied.conflicts.length ? `; ${r.applied.conflicts.length} programme(s) entered by hand overlap it` : ''}. Series and the run order carry on from where they were.${(r as any).prepared?.queued?.length ? ` ${(r as any).prepared.queued.length} title(s) are being prepared for air.` : ''}` })
      await load(w.id)
    } catch (e: any) { notify({ kind: 'error', title: "Couldn't activate.", message: e.message }) } finally { setBusy('') }
  }
  const writeAhead = async () => {
    if (!active) return
    setBusy('apply')
    try { const r = await fastApi.apply(active.id); notify({ kind: 'ok', title: 'Guide rewritten.', message: `${r.inserted} programmes to ${new Date(r.until).toLocaleDateString()}.` }); await load(active.id) }
    catch (e: any) { notify({ kind: 'error', title: "Couldn't write the guide.", message: e.message }) } finally { setBusy('') }
  }

  // ---- library clicks: append a slot, or add an alternate to the slot picking
  const addTitle = (a: LibAsset) => {
    if (picking) {
      edit(s => s.map(x => x.id === picking && x.kind === 'title' && !x.pool.some(p => 'assetId' in p && p.assetId === a.id) ? { ...x, pool: [...x.pool, { assetId: a.id }] } : x))
      return
    }
    edit(s => [...s, { id: `t-${sid()}`, kind: 'title', pool: [{ assetId: a.id }] }])
  }
  const addSeries = (se: LibSeries) => edit(s => [...s, { id: `s-${sid()}`, kind: 'series', series: se.name, count: 1, order: 'sequential', atEnd: 'loop' }])

  const passWeek = preview?.rotation.passesPerWeek ?? 0
  // Plays a week: counted from the planned week when there is one (exact, and
  // right with a daily restart, which cuts the end of the pass), else worked
  // out from the pass length.
  const planned = useMemo(() => {
    const m = new Map<string, number>()
    for (const pr of preview?.programmes ?? []) m.set(pr.slotId, (m.get(pr.slotId) ?? 0) + 1)
    return m
  }, [preview])
  const playsPerWeek = (sl: Slot) => {
    if (preview && !dirty) { const n = planned.get(sl.id) ?? 0; return sl.kind === 'title' ? n / Math.max(1, sl.pool.filter(p => 'assetId' in p).length) : n }
    const every = Math.max(1, sl.every ?? 1)
    if (sl.kind === 'title') {
      const titles = sl.pool.filter(p => 'assetId' in p).length || 1
      return passWeek / every / sl.pool.length * (titles ? 1 : 0)
    }
    return (passWeek / every) * sl.count
  }

  if (!ch) return <div className="loading">Loading…</div>
  const statusLine = work
    ? work.status === 'draft' ? `Draft${active ? ` of v${active.version + 1}` : ''}: not on air until activated`
      : work.status === 'active' ? `v${work.version} on air · guide written to ${work.applied_until ? new Date(work.applied_until).toLocaleString([], { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—'}`
      : `v${work.version} (archived)`
    : 'No lineup'

  return (
    <>
      <div className="page-head">
        <div>
          <div style={{ fontSize: 'var(--fs-sm)', color: 'var(--muted)', marginBottom: 4 }}><a href="/fast" onClick={e => { e.preventDefault(); navigate('/fast') }} style={{ color: 'inherit' }}>FAST channels</a> /</div>
          <h1>{ch.name} <span className="tag type" style={{ verticalAlign: 'middle', display: 'inline-flex', alignItems: 'center', gap: 4 }}>{MEDIA[ch.media ?? 'video'].icon}{MEDIA[ch.media ?? 'video'].label}</span></h1>
          <p>{statusLine}{dirty ? ' · unsaved changes' : ''}
            {active && urls && <> · output <a href={urls.hls} target="_blank" rel="noreferrer" style={{ color: 'var(--muted)' }}>HLS</a> / <a href={urls.dash} target="_blank" rel="noreferrer" style={{ color: 'var(--muted)' }}>DASH</a></>}</p>
        </div>
        <div className="spacer" />
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {active && work?.status === 'active' && <button className="btn ghost" onClick={writeAhead} disabled={!!busy}>{busy === 'apply' ? 'Writing…' : 'Rewrite guide'}</button>}
          {(work?.status === 'draft' || dirty) && <button className="btn ghost" onClick={save} disabled={!!busy || !dirty}>{busy === 'save' ? 'Saving…' : 'Save draft'}</button>}
          {(work?.status === 'draft' || dirty) && <button className="btn primary" onClick={activate} disabled={!!busy || !slots.length}>{busy === 'activate' ? 'Activating…' : active ? 'Activate (carry on from now)' : 'Activate and go on air'}</button>}
        </div>
      </div>

      <div className="filters" role="tablist" aria-label="Builder sections">
        {([['order', 'Run order'], ['week', 'Week'], ['repeats', 'Repeats'], ['ads', 'Ads'], ['air', 'On air']] as [Tab, string][]).map(([k, l]) => (
          <button key={k} role="tab" aria-selected={tab === k} className={`chip${tab === k ? ' active' : ''}`} onClick={() => setTab(k)}>{l}</button>
        ))}
      </div>

      {previewErr && <Notice kind="warn" title="The preview could not be worked out." message={previewErr} />}

      {tab === 'order' && (
        <div className="fast-cols">
          <Library lib={lib} picking={picking ? slots.find(s => s.id === picking) : null} onTitle={addTitle} onSeries={addSeries} onDonePicking={() => setPicking(null)} assetById={assetById} />
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16, minWidth: 0 }}>
            {preview && <RepeatHelper p={preview} firstSlot={slots[0]?.id ?? null} anchor={settings.anchor ?? null} />}
            {preview?.notices.length ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {preview.notices.slice(0, 6).map((n, i) => <Notice key={i} kind="warn" variant="compact" message={n.message} />)}
              </div>
            ) : null}
            <div className="card">
              <div className="card-h"><h3>Run order</h3><span className="sub">loops pass after pass; each pass starts where the last one ended</span><span className="spacer" />
                {preview && <span className="fast-plays">one pass ≈ <b>{fmtDur(preview.rotation.lengthSec)}</b></span>}</div>
              {slots.length === 0 ? (
                <div className="card-b" style={{ color: 'var(--muted)' }}>Add films or series from the library on the left. Each one becomes a slot in the run order.</div>
              ) : slots.map((s, i) => (
                <SlotRow key={s.id} slot={s} i={i} n={slots.length} all={slots} assetById={assetById} picking={picking === s.id}
                  plays={playsPerWeek(s)} passWeek={passWeek}
                  onPick={() => setPicking(picking === s.id ? null : s.id)}
                  onChange={(ns) => edit(list => list.map(x => x.id === s.id ? ns : x))}
                  onMove={(d) => edit(list => { const a = [...list]; const j = i + d; if (j < 0 || j >= a.length) return a; [a[i], a[j]] = [a[j], a[i]]; return a })}
                  onDuplicate={() => edit(list => { const a = [...list]; a.splice(i + 1, 0, { ...s, id: `${s.kind[0]}-${sid()}` }); return a })}
                  onRemove={() => edit(list => list.filter(x => x.id !== s.id).map(x => x.kind === 'series' && x.encoreOf === s.id ? { ...x, encoreOf: null } : x))} />
              ))}
            </div>
            <SettingsCard settings={settings} zone={zone} lib={lib} nSlots={slots.length}
              onZone={(z) => { if (readOnly) ensureDraft(); setZone(z); setDirty(true) }} onChange={editSettings} />
          </div>
        </div>
      )}
      {tab === 'week' && <WeekView p={preview} />}
      {tab === 'repeats' && <Repeats p={preview} />}
      {tab === 'ads' && <AdsTab channelId={id} lib={lib} />}
      {tab === 'air' && <AirTab channelId={id} hasActive={!!active} onAirChange={(on) => setCh(c => c ? { ...c, onAir: on } : c)} />}
    </>
  )
}

// ---------------------------------------------------------------- library panel

function Library({ lib, picking, onTitle, onSeries, onDonePicking, assetById }: {
  lib: ChannelLibrary; picking: Slot | null | undefined; onTitle: (a: LibAsset) => void; onSeries: (s: LibSeries) => void
  onDonePicking: () => void; assetById: Map<string, LibAsset>
}) {
  const [q, setQ] = useState('')
  const [kind, setKind] = useState<'titles' | 'series'>('titles')
  const k = q.trim().toLowerCase()
  const titles = lib.assets.filter(a => !k || a.title.toLowerCase().includes(k) || (a.series ?? '').toLowerCase().includes(k))
  const series = lib.series.filter(s => !k || s.name.toLowerCase().includes(k))
  const media: FastMedia = lib.media ?? 'video'
  const noun = media === 'audio' ? 'audio' : 'video'
  const hiddenNote = [
    lib.hidden.otherMedia ? `${lib.hidden.otherMedia} ${media === 'audio' ? 'video' : 'audio'} asset${lib.hidden.otherMedia === 1 ? '' : 's'}` : '',
    lib.hidden.noSource ? `${lib.hidden.noSource} ${noun} asset${lib.hidden.noSource === 1 ? '' : 's'} with no usable source` : '',
  ].filter(Boolean).join(' and ')
  const pickName = picking && picking.kind === 'title' ? assetById.get((picking.pool.find(p => 'assetId' in p) as any)?.assetId)?.title ?? 'this slot' : null
  return (
    <div className="card fast-lib">
      <div className="card-h"><h3>Library</h3><span className="spacer" />
        <div className="fast-seg">
          <button className={`chip${kind === 'titles' ? ' active' : ''}`} style={{ padding: '4px 10px' }} onClick={() => setKind('titles')}>Titles</button>
          <button className={`chip${kind === 'series' ? ' active' : ''}`} style={{ padding: '4px 10px' }} onClick={() => setKind('series')}>Series</button>
        </div>
      </div>
      <div style={{ padding: '10px 14px' }}>
        <input className="inp" placeholder={`Search ${noun} in the library`} value={q} onChange={e => setQ(e.target.value)} aria-label="Search the library" />
        <div className="hintxt" style={{ marginTop: 6 }} title="A title can air when it is packaged for splicing, or its source file is still here to prepare it from.">
          {media === 'audio' ? 'Audio channel: audio assets that can air.' : 'Video channel: video assets that can air.'}{hiddenNote ? ` Not shown: ${hiddenNote}.` : ''}
        </div>
      </div>
      {pickName && <div className="mode">Click titles to add them as alternates to “{pickName}”.<span className="spacer" style={{ flex: 1 }} /><button className="btn ghost sm" onClick={onDonePicking}>Done</button></div>}
      <div className="list">
        {kind === 'titles' ? titles.map(a => (
          <div key={a.id} className="row" onClick={() => onTitle(a)} role="button" tabIndex={0} onKeyDown={e => { if (e.key === 'Enter') onTitle(a) }}
            title={a.ready ? 'Add to the run order' : 'Not packaged yet: it can be planned, and is prepared before it airs'}>
            {MEDIA[a.media ?? media].icon}
            <span className="nm">{a.title}</span>
            <span className="meta">{a.series ? `S${a.season ?? '?'}E${a.episode ?? '?'} · ` : ''}{fmtDur(a.durationSec)}{a.availableUntil ? ` · until ${new Date(a.availableUntil).toLocaleDateString([], { day: '2-digit', month: 'short' })}` : ''}</span>
          </div>
        )) : series.map(s => (
          <div key={s.name} className="row" onClick={() => onSeries(s)} role="button" tabIndex={0} onKeyDown={e => { if (e.key === 'Enter') onSeries(s) }} title="Add the series as a slot: the next episodes each time it comes round">
            {Ico.series}
            <span className="nm">{s.name}</span>
            <span className="meta">{s.episodes} ep{s.episodes === 1 ? '' : 's'}{s.seasons.length ? ` · ${s.seasons.length} season${s.seasons.length === 1 ? '' : 's'}` : ''}</span>
          </div>
        ))}
        {kind === 'titles' && !titles.length && <div className="hintxt" style={{ padding: 14 }}>{k ? 'No titles match.' : `No ${noun} assets can air yet.`} Upload {noun} in the Media Library; anything packaged there, or with its source still here, can go on this channel.</div>}
        {kind === 'series' && !series.length && <div className="hintxt" style={{ padding: 14 }}>No series yet. Give episodes a Series, Season and Episode number in their metadata and they group here.</div>}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------- one slot

function SlotRow({ slot, i, n, all, assetById, picking, plays, passWeek, onPick, onChange, onMove, onDuplicate, onRemove }: {
  slot: Slot; i: number; n: number; all: Slot[]; assetById: Map<string, LibAsset>; picking: boolean; plays: number; passWeek: number
  onPick: () => void; onChange: (s: Slot) => void; onMove: (d: number) => void; onDuplicate: () => void; onRemove: () => void
}) {
  const every = slot.every ?? 1
  const [target, setTarget] = useState('')
  const applyTarget = () => {
    const t = Number(target); if (!t || !passWeek) return
    const per = slot.kind === 'title' ? passWeek / slot.pool.length : passWeek * slot.count
    onChange({ ...slot, every: Math.max(1, Math.min(14, Math.round(per / t))) }); setTarget('')
  }
  return (
    <div className={`fast-slot${picking ? ' picking' : ''}`}>
      <div className="n">{i + 1}</div>
      <div className="what">
        {slot.kind === 'title' ? (
          <div className="line">
            {slot.pool.map((p, k) => 'skip' in p ? (
              <span key={k} className="fast-pill skip" title="On this turn the slot is left out of the pass">Skip this turn<button aria-label="Remove skip" onClick={() => onChange({ ...slot, pool: slot.pool.filter((_, j) => j !== k) })}>×</button></span>
            ) : (
              <span key={k} className={`fast-pill${k === 0 ? ' first' : ''}`} title={k === 0 ? 'Plays on the first pass' : `Takes turn ${k + 1}`}>
                <span className="t">{assetById.get(p.assetId)?.title ?? 'Missing title'}</span>
                <span className="d">{assetById.get(p.assetId) ? fmtDur(assetById.get(p.assetId)!.durationSec) : ''}</span>
                {slot.pool.length > 1 && <button aria-label="Remove from the slot" onClick={() => onChange({ ...slot, pool: slot.pool.filter((_, j) => j !== k) })}>×</button>}
              </span>
            ))}
            <button className="btn ghost sm" onClick={onPick}>{picking ? 'Done adding' : slot.pool.length > 1 ? '+ Alternate' : '+ Alternates (take turns)'}</button>
            {!slot.pool.some(p => 'skip' in p) && <button className="btn ghost sm" onClick={() => onChange({ ...slot, pool: [...slot.pool, { skip: true }] })} title="Add a turn where the slot drops out of the pass">+ Drop a turn</button>}
          </div>
        ) : (
          <>
            <div className="line"><span className="fast-pill first">{Ico.series}<span className="t">{slot.series}</span></span>
              {slot.encoreOf && <span className="tag type">Repeat of slot {all.findIndex(x => x.id === slot.encoreOf) + 1}</span>}</div>
            <div className="line">
              {!slot.encoreOf && <label className="fast-mini">Episodes each time <input type="number" min={1} max={24} value={slot.count} onChange={e => onChange({ ...slot, count: Math.max(1, Math.min(24, Number(e.target.value) || 1)) })} /></label>}
              {!slot.encoreOf && <label className="fast-mini">Order
                <select value={slot.order} onChange={e => onChange({ ...slot, order: e.target.value as SeriesSlot['order'] })}>
                  <option value="sequential">In episode order</option><option value="shuffle">Shuffled, no repeats</option>
                </select></label>}
              {!slot.encoreOf && <label className="fast-mini">At the end
                <select value={slot.atEnd ?? 'loop'} onChange={e => onChange({ ...slot, atEnd: e.target.value as 'loop' | 'stop' })}>
                  <option value="loop">Start again from episode 1</option><option value="stop">Drop out</option>
                </select></label>}
              <label className="fast-mini">Repeat of
                <select value={slot.encoreOf ?? ''} onChange={e => onChange({ ...slot, encoreOf: e.target.value || null })}>
                  <option value="">No (new episodes)</option>
                  {all.filter(x => x.kind === 'series' && x.id !== slot.id && !x.encoreOf && (x as SeriesSlot).series === slot.series).map(x => <option key={x.id} value={x.id}>Slot {all.findIndex(y => y.id === x.id) + 1} (encore)</option>)}
                </select></label>
            </div>
          </>
        )}
        <div className="line">
          <label className="fast-mini">
            <select value={every} onChange={e => onChange({ ...slot, every: Number(e.target.value), phase: Math.min(slot.phase ?? 0, Number(e.target.value) - 1) })} aria-label="How often the slot plays">
              {EVERY.map(v => <option key={v} value={v}>{everyLabel(v)}</option>)}
            </select>
          </label>
          {every > 1 && <label className="fast-mini">starting on pass
            <select value={(slot.phase ?? 0) + 1} onChange={e => onChange({ ...slot, phase: Number(e.target.value) - 1 })}>
              {Array.from({ length: every }, (_, k) => <option key={k} value={k + 1}>{k + 1}</option>)}
            </select></label>}
          <span className="fast-plays" title="From the pass length and how often the slot comes round">≈ <b>{plays >= 10 ? Math.round(plays) : plays.toFixed(1)}</b> play{Math.round(plays) === 1 ? '' : 's'} a week{slot.kind === 'title' && slot.pool.length > 1 ? ' each' : ''}</span>
          <label className="fast-mini" title="Type how many plays a week you want; the slot's frequency is set to the nearest">want <input value={target} onChange={e => setTarget(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') applyTarget() }} placeholder="#" aria-label="Plays a week wanted" /> / week</label>
          {target && <button className="btn ghost sm" onClick={applyTarget}>Set</button>}
        </div>
      </div>
      <div className="ctl">
        <button className="fast-ico" onClick={() => onMove(-1)} disabled={i === 0} aria-label="Move up">{Ico.up}</button>
        <button className="fast-ico" onClick={() => onMove(1)} disabled={i === n - 1} aria-label="Move down">{Ico.down}</button>
        <button className="fast-ico" onClick={onDuplicate} aria-label="Duplicate slot" title="Duplicate (a second showing in the same pass)">{Ico.dup}</button>
        <button className="fast-ico" onClick={onRemove} aria-label="Remove slot">{Ico.x}</button>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------- repeat helper

function RepeatHelper({ p, firstSlot, anchor }: { p: Preview; firstSlot: string | null; anchor: string | null }) {
  const r = p.rotation
  // the clock times the first slot actually gets in the planned week
  // (the start of each of its plays, not every episode inside a block)
  const starts = p.programmes.filter((x, i, a) => x.slotId === firstSlot && !(i > 0 && a[i - 1].slotId === x.slotId && a[i - 1].cycle === x.cycle))
  const times = [...new Set(starts.map(x => localParts(x.start, p.zone).hm))].sort()
  const passes = new Set(p.programmes.map(x => x.cycle)).size
  const drift = r.dailyShiftMin
  // A pass of 14 h means a title's next airing is 14 h later: 10 h EARLIER on the clock.
  const driftTxt = drift === 0 ? 'at the same clock time' : `${fmtDur(Math.abs(drift) * 60)} ${drift < 0 ? 'earlier' : 'later'} on the clock`
  return (
    <div className="card">
      <div className="card-h"><h3>What this run order does to a week</h3><span className="sub">{anchor ? `restarting daily at ${anchor}` : 'free-running'}</span></div>
      <div className="card-b">
        <div className="fast-math">
          <div><div className="k">One pass</div><div className="v">{fmtDur(r.lengthSec)}</div></div>
          <div><div className="k">Passes this week</div><div className="v">{anchor ? passes : r.passesPerWeek}</div></div>
          {anchor
            ? <div><div className="k">Each day</div><div className="v" style={{ fontSize: 'var(--fs-body)' }}>starts the run order at {anchor}</div></div>
            : <div><div className="k">Next pass starts</div><div className="v" style={{ fontSize: 'var(--fs-body)' }}>{driftTxt}</div></div>}
          <div><div className="k">Ads</div><div className="v">{p.ads.minutesPerHour} <span style={{ fontSize: 'var(--fs-sm)', color: 'var(--faint)' }}>min/hour</span></div></div>
        </div>
        {times.length > 0 && <>
          <div className="hintxt" style={{ marginTop: 12 }}>{times.length === 1 ? `The first slot airs at ${times[0]} every time.` : `The first slot airs at these ${times.length} clock times across the week:`}</div>
          {times.length > 1 && <div className="fast-clock">{times.slice(0, 24).map(t => <span key={t}>{t}</span>)}{times.length > 24 && <span>+{times.length - 24}</span>}</div>}
        </>}
        {!anchor && r.warnings.map((w, i) => <div key={i} style={{ marginTop: 10 }}><Notice kind="info" variant="compact" message={w} /></div>)}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------- settings

function SettingsCard({ settings, zone, lib, nSlots, onZone, onChange }: {
  settings: LineupSettings; zone: string; lib: { assets: LibAsset[] }; nSlots: number
  onZone: (z: string) => void; onChange: (p: Partial<LineupSettings>) => void
}) {
  const backfill = settings.backfill ?? []
  return (
    <div className="card">
      <div className="card-h"><h3>Channel clock</h3></div>
      <div className="card-b" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(220px,1fr))', gap: '0 18px' }}>
        <div className="field"><label htmlFor="fz2">Time zone</label>
          <select id="fz2" className="inp" value={zone} onChange={e => onZone(e.target.value)}>{ZONES.map(z => <option key={z}>{z}</option>)}</select></div>
        <div className="field"><label htmlFor="fanc">Restart the run order daily</label>
          <div style={{ display: 'flex', gap: 8 }}>
            <select id="fanc" className="inp" value={settings.anchor ? 'yes' : 'no'} onChange={e => onChange({ anchor: e.target.value === 'yes' ? '06:00' : null })}>
              <option value="no">No, free-running (spreads titles round the clock)</option><option value="yes">Yes, at a fixed time</option>
            </select>
            {settings.anchor && <input className="inp" type="time" value={settings.anchor} onChange={e => onChange({ anchor: e.target.value })} style={{ width: 120 }} aria-label="Restart time" />}
          </div>
          <div className="hintxt">A restart pads the last programme before it, so the first slot always opens the day.</div></div>
        <div className="field"><label htmlFor="fgrid">Round programmes up to</label>
          <select id="fgrid" className="inp" value={settings.gridMin ?? 0} onChange={e => onChange({ gridMin: Number(e.target.value) as any })}>
            <option value={0}>No rounding (back to back)</option><option value={5}>5 minutes</option><option value={15}>15 minutes</option><option value={30}>30 minutes</option><option value={60}>The hour</option>
          </select>
          <div className="hintxt">The gap is filled with promos or the slate, so the guide reads like a traditional grid.</div></div>
        <div className="field"><label htmlFor="fshift">Rotate the run order each pass</label>
          <select id="fshift" className="inp" value={settings.cycleShift ?? 0} onChange={e => onChange({ cycleShift: Number(e.target.value) })}>
            <option value={0}>No</option>{Array.from({ length: Math.max(0, nSlots - 1) }, (_, k) => <option key={k + 1} value={k + 1}>By {k + 1} slot{k ? 's' : ''}</option>)}
          </select>
          <div className="hintxt">Each pass opens further down the list, so the same title does not keep landing in the same part of the pass.</div></div>
        <div className="field"><label htmlFor="fhz">Keep the guide written ahead</label>
          <select id="fhz" className="inp" value={settings.horizonDays ?? 7} onChange={e => onChange({ horizonDays: Number(e.target.value) })}>
            {[3, 7, 10, 14].map(d => <option key={d} value={d}>{d} days</option>)}
          </select></div>
        <div className="field" style={{ gridColumn: '1 / -1' }}><label>When a title is outside its rights window, play instead</label>
          <div className="line" style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {backfill.map(id => <span key={id} className="fast-pill">{lib.assets.find(a => a.id === id)?.title ?? 'Missing'}<button aria-label="Remove" onClick={() => onChange({ backfill: backfill.filter(x => x !== id) })}>×</button></span>)}
            <select className="inp" style={{ width: 260 }} value="" onChange={e => { if (e.target.value) onChange({ backfill: [...backfill, e.target.value] }) }} aria-label="Add a backfill title">
              <option value="">+ Add a backfill title</option>
              {lib.assets.filter(a => !backfill.includes(a.id)).map(a => <option key={a.id} value={a.id}>{a.title} · {fmtDur(a.durationSec)}</option>)}
            </select>
          </div>
          <div className="hintxt">The closest in length is used. Without one, the slot is skipped for that pass and the notice above says so.</div></div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------- week view

const SLOT_BG = ['#2b4a8f', '#2f6b5a', '#6b4a8f', '#8f5a2b', '#2b6b8f', '#7a3a4f', '#4f6b2b', '#5a5a7a']

function WeekView({ p }: { p: Preview | null }) {
  const [sel, setSel] = useState<PlannedProgramme | null>(null)
  if (!p) return <div className="loading">Working out the week…</div>
  const zone = p.zone
  const days: string[] = []
  for (const pr of p.programmes) { const d = localParts(pr.start, zone).date; if (!days.includes(d)) days.push(d) }
  const shown = days.slice(0, 7)
  const slotIdx = new Map<string, number>()
  for (const pr of p.programmes) if (!slotIdx.has(pr.slotId)) slotIdx.set(pr.slotId, slotIdx.size)
  const PX = 1.1 // px per minute
  const H = 24 * 60 * PX
  return (
    <div style={{ display: 'grid', gridTemplateColumns: sel ? 'minmax(0,1fr) 300px' : '1fr', gap: 16 }}>
      <div className="card" style={{ overflow: 'hidden' }}>
        <div className="fast-week" style={{ maxHeight: '72vh', overflowY: 'auto' }}>
          <div className="hdr" />
          {shown.map(d => { const lp = localParts(`${d}T12:00:00Z`, 'UTC'); return <div key={d} className="hdr">{lp.wd}<small>{d.slice(8)}/{d.slice(5, 7)}</small></div> })}
          <div className="hours" style={{ height: H }}>{Array.from({ length: 24 }, (_, h) => <span key={h} style={{ top: h * 60 * PX }}>{String(h).padStart(2, '0')}:00</span>)}</div>
          {shown.map(d => (
            <div key={d} className="day" style={{ height: H }}>
              {Array.from({ length: 24 }, (_, h) => <div key={h} className="hl" style={{ top: h * 60 * PX }} />)}
              {p.programmes.filter(pr => localParts(pr.start, zone).date === d).map(pr => {
                const st = localParts(pr.start, zone)
                const mins = (Date.parse(pr.end) - Date.parse(pr.start)) / 60000
                const h = Math.max(6, Math.min(mins, 24 * 60 - st.min) * PX)
                return (
                  <div key={pr.key} className={`blk${sel?.key === pr.key ? ' sel' : ''}`} style={{ top: st.min * PX, height: h, background: SLOT_BG[(slotIdx.get(pr.slotId) ?? 0) % SLOT_BG.length] }}
                    onClick={() => setSel(pr)} title={`${st.hm} ${pr.title}`}>
                    {pr.breaks.map((b, k) => { const off = (Date.parse(b.start) - Date.parse(pr.start)) / 60000; return <div key={k} className="brk" title={`Ad break ${fmtDur(b.durationSec)}`} style={{ top: off * PX, height: Math.max(2, (b.durationSec / 60) * PX) }} /> })}
                    {h >= 14 && <div className="tm">{st.hm}{pr.note === 'encore' ? ' · encore' : pr.note === 'backfill' ? ' · backfill' : ''}</div>}
                    {h >= 24 && <div className="tl">{pr.title}</div>}
                  </div>
                )
              })}
            </div>
          ))}
        </div>
      </div>
      {sel && (
        <div className="card" style={{ alignSelf: 'start', position: 'sticky', top: 12 }}>
          <div className="card-h"><h3 style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{sel.title}</h3><span className="spacer" /><button className="fast-ico" onClick={() => setSel(null)} aria-label="Close">{Ico.x}</button></div>
          <div className="card-b fast-detail">
            <span className="k">Airs</span><span>{localParts(sel.start, zone).wd} {localParts(sel.start, zone).hm} to {localParts(sel.end, zone).hm}</span>
            <span className="k">Content</span><span>{fmtDur(sel.contentSec)}</span>
            {sel.series && <><span className="k">Episode</span><span>{sel.series.name} S{sel.series.season ?? '?'}E{sel.series.episode ?? '?'}{sel.series.pass ? ` · time ${sel.series.pass + 1} through` : ''}</span></>}
            <span className="k">Pass</span><span>{sel.cycle + 1}{sel.note ? ` · ${sel.note === 'rotation' ? 'rotation pick' : sel.note}` : ''}</span>
            <span className="k">Ad breaks</span><span>{sel.breaks.length ? sel.breaks.map(b => `${localParts(b.start, zone).hm} (${fmtDur(b.durationSec)}${b.position === 'end' ? ', after' : ''})`).join(', ') : 'none'}</span>
            {sel.padSec > 0 && <><span className="k">Pad</span><span>{fmtDur(sel.padSec)} of promos/slate</span></>}
            {sel.warnings.map((w, i) => <span key={i} style={{ gridColumn: '1 / -1' }}><Notice kind="warn" variant="compact" message={w} /></span>)}
          </div>
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------- repeats report

function Repeats({ p }: { p: Preview | null }) {
  if (!p) return <div className="loading">Working out the week…</div>
  return (
    <div className="card">
      <div className="card-h"><h3>How often each title airs this week</h3><span className="sub">from the planned guide, {p.repeats.reduce((s, r) => s + r.plays, 0)} airings</span></div>
      <table>
        <thead><tr><th>Title</th><th>Plays</th><th>Prime time</th><th>Closest repeat</th><th>Same clock time twice</th><th>When</th></tr></thead>
        <tbody>
          {p.repeats.map(r => (
            <tr key={r.assetId}>
              <td style={{ fontWeight: 600 }}>{r.title}</td>
              <td>{r.plays}</td>
              <td style={{ color: 'var(--muted)' }}>{r.primetime}</td>
              <td style={{ color: r.minGapHours != null && r.minGapHours < 3 ? 'var(--warn)' : 'var(--muted)' }}>{r.minGapHours == null ? '—' : `${r.minGapHours} h`}</td>
              <td style={{ color: r.sameTimeRepeats ? 'var(--warn)' : 'var(--muted)' }}>{r.sameTimeRepeats || '—'}</td>
              <td style={{ color: 'var(--muted)', fontSize: 'var(--fs-xs)', maxWidth: 420 }}>{r.times.slice(0, 10).map(t => t.slice(5)).join(' · ')}{r.times.length > 10 ? ` · +${r.times.length - 10}` : ''}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

// ---------------------------------------------------------------- ads

function AdsTab({ channelId, lib }: { channelId: string; lib: { assets: LibAsset[] } }) {
  const notify = useNotify()
  const [ads, setAds] = useState<ChannelAds | null>(null)
  const [servers, setServers] = useState<AdServer[]>([])
  const [report, setReport] = useState<AdReport | null>(null)
  const [test, setTest] = useState<AdTest | null>(null)
  const [adding, setAdding] = useState(false)
  const [srv, setSrv] = useState({ name: '', vendor: 'gam', tagTemplate: '', timeoutMs: 1500 })
  const load = () => { fastApi.ads(channelId).then(setAds).catch(() => {}); fastApi.adServers().then(r => setServers(r.items)).catch(() => {}); fastApi.adReport(channelId).then(setReport).catch(() => {}) }
  useEffect(load, [channelId])
  if (!ads) return <div className="loading">Loading ads…</div>
  const save = async (b: Parameters<typeof fastApi.saveAds>[1]) => {
    try { setAds(await fastApi.saveAds(channelId, b)); notify({ kind: 'ok', title: 'Saved.', message: 'Activate or rewrite the guide for new break lengths to reach the schedule.' }) }
    catch (e: any) { notify({ kind: 'error', title: "Couldn't save.", message: e.message }) }
  }
  const pol = ads.policy
  const num = (k: keyof typeof pol, label: string, unit: string, hint?: string, step = 1) => (
    <div className="field"><label>{label}</label>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <input className="inp" type="number" step={step} defaultValue={String(pol[k] ?? '')} style={{ width: 88 }}
          onBlur={e => { const v = Number(e.target.value); if (Number.isFinite(v) && v !== pol[k]) save({ policy: { ...pol, [k]: v } }) }} aria-label={label} />
        <span style={{ color: 'var(--muted)', fontSize: 'var(--fs-sm)', whiteSpace: 'nowrap' }}>{unit}</span>
      </div>{hint && <div className="hintxt">{hint}</div>}</div>
  )
  const MODES: [ChannelAds['mode'], string, string][] = [
    ['off', 'No ads', 'No breaks. Programmes run back to back.'],
    ['markers', 'Ad markers for a FAST platform', 'Breaks are signalled with SCTE-35 and filled with your house spots. Samsung TV Plus, Roku, Pluto, LG and others replace them with their own ads.'],
    ['stitched', 'Stitched ads from your ad server', 'Volt asks your ad server for each break and stitches the ads in for each viewer. House spots fill whatever the ad server does not, or if it is slow or down.'],
  ]
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(360px,1fr))', gap: 16, alignItems: 'start' }}>
      <div className="card">
        <div className="card-h"><h3>Ad breaks</h3></div>
        <div className="card-b">
          {MODES.map(([m, t, d]) => (
            <label key={m} className="toggle-row" style={{ cursor: 'pointer', alignItems: 'flex-start' }}>
              <input type="radio" name="admode" checked={ads.mode === m} onChange={() => save({ mode: m })} style={{ marginTop: 3 }} />
              <div><div className="tt">{t}</div><div className="td">{d}</div></div>
            </label>
          ))}
          {ads.mode !== 'off' && <>
            <div className="sec-label">How much and where</div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0 14px' }}>
              {num('loadMinPerHour', 'Ad load', 'min per hour', 'FAST channels typically run 8 to 12.', 0.5)}
              {num('breakSec', 'Mid-programme break', 'seconds')}
              {num('betweenSec', 'Break between programmes', 'seconds', '0 for none.')}
              {num('firstAfterMin', 'No break before', 'min in')}
              {num('minGapMin', 'At least', 'min between breaks')}
              {num('endGuardMin', 'None in the last', 'minutes')}
              {num('minProgrammeMin', 'Mid breaks only in titles over', 'minutes')}
            </div>
            <label className="toggle-row" style={{ cursor: 'pointer' }}>
              <input type="checkbox" checked={pol.useCues} onChange={e => save({ policy: { ...pol, useCues: e.target.checked } })} />
              <div><div className="tt">Use the title's own break points</div><div className="td">Act breaks marked on the asset are used first; otherwise breaks are spread evenly, always on a segment boundary.</div></div>
            </label>
          </>}
        </div>
      </div>

      {ads.mode !== 'off' && <div className="card">
        <div className="card-h"><h3>House spots and slate</h3><span className="sub">what fills a break nobody has sold</span></div>
        <div className="card-b">
          <div className="field"><label>House spots, in rotation</label>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {ads.houseRefs.map((h, i) => {
                const a = lib.assets.find(x => x.id === h.assetId)
                return (
                  <div key={h.assetId} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span className="fast-pill" style={{ flex: 1 }}><span className="t">{a?.title ?? 'Missing'}</span><span className="d">{a ? fmtDur(a.durationSec) : ''}</span></span>
                    <label className="fast-mini">weight <input type="number" min={1} max={10} value={h.weight ?? 1} onChange={e => save({ houseAds: ads.houseRefs.map((x, j) => j === i ? { ...x, weight: Math.max(1, Math.min(10, Number(e.target.value) || 1)) } : x) })} /></label>
                    <button className="fast-ico" aria-label="Remove" onClick={() => save({ houseAds: ads.houseRefs.filter((_, j) => j !== i) })}>{Ico.x}</button>
                  </div>
                )
              })}
              <select className="inp" value="" onChange={e => { if (e.target.value) save({ houseAds: [...ads.houseRefs, { assetId: e.target.value }] }) }} aria-label="Add a house spot">
                <option value="">+ Add a promo or sponsor spot</option>
                {lib.assets.filter(a => a.durationSec <= 120 && !ads.houseRefs.some(h => h.assetId === a.id)).map(a => <option key={a.id} value={a.id}>{a.title} · {fmtDur(a.durationSec)}</option>)}
              </select>
            </div>
            <div className="hintxt">Also what plays in stitched breaks the ad server leaves short, and in every break if it is slow or down. Weight 3 comes round three times as often.</div></div>
          <div className="field"><label>Slate</label>
            <select className="inp" value={pol.slateAssetId ?? ''} onChange={e => save({ policy: { ...pol, slateAssetId: e.target.value || null } })}>
              <option value="">None</option>{lib.assets.filter(a => a.durationSec <= 60).map(a => <option key={a.id} value={a.id}>{a.title} · {fmtDur(a.durationSec)}</option>)}
            </select>
            <div className="hintxt">Loops for the last seconds of a break and in grid pads. Packaged in 1 second segments it lands every break to the second.</div></div>
        </div>
      </div>}

      {ads.mode === 'stitched' && <div className="card">
        <div className="card-h"><h3>Ad server</h3><span className="spacer" /><button className="btn ghost sm" onClick={() => setAdding(a => !a)}>{adding ? 'Cancel' : '+ Add ad server'}</button></div>
        <div className="card-b">
          {adding ? (
            <>
              <div className="field"><label>Name</label><input className="inp" value={srv.name} onChange={e => setSrv({ ...srv, name: e.target.value })} placeholder="Google Ad Manager" /></div>
              <div className="field"><label>Vendor</label><select className="inp" value={srv.vendor} onChange={e => setSrv({ ...srv, vendor: e.target.value })}>
                {[['gam', 'Google Ad Manager'], ['freewheel', 'FreeWheel'], ['springserve', 'SpringServe'], ['magnite', 'Magnite'], ['publica', 'Publica'], ['beachfront', 'Beachfront'], ['vast', 'Any VAST 2/3/4 server']].map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></div>
              <div className="field"><label>VAST tag URL</label><textarea className="inp" rows={3} value={srv.tagTemplate} onChange={e => setSrv({ ...srv, tagTemplate: e.target.value })} placeholder="https://pubads.g.doubleclick.net/gampad/ads?iu=/1234/fast&pmxd=[BREAK_DURATION_MS]&correlator=[CACHEBUSTING]" />
                <div className="hintxt">Paste the vendor's tag. Volt fills [BREAK_DURATION], [BREAK_DURATION_MS], [POD_INDEX], [SESSION_ID], [CHANNEL_ID], [CONTENT_ID], [CONTENT_TITLE], [SERIES], [GENRE], [IP], [USER_AGENT], [COUNTRY], [CACHEBUSTING]; anything else is passed through untouched.</div></div>
              <div className="field"><label>Time budget</label><input className="inp" type="number" value={srv.timeoutMs} onChange={e => setSrv({ ...srv, timeoutMs: Number(e.target.value) })} style={{ width: 120 }} />
                <div className="hintxt">Milliseconds for the whole answer, wrappers included. Past it, the break is house spots.</div></div>
              <button className="btn primary" onClick={async () => { try { const s = await fastApi.addAdServer(srv); setAdding(false); setServers(x => [...x, s]); await save({ adServerId: s.id }) } catch (e: any) { notify({ kind: 'error', title: "Couldn't add it.", message: e.message }) } }}>Add and use</button>
            </>
          ) : (
            <>
              <div className="field"><label>Ask</label>
                <select className="inp" value={ads.adServerId ?? ''} onChange={e => save({ adServerId: e.target.value || null })}>
                  <option value="">Choose an ad server</option>{servers.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
                </select></div>
              <div className="field"><label>Decide</label>
                <select className="inp" value={ads.scope} onChange={e => save({ scope: e.target.value })}>
                  <option value="session">For each viewer (targeted, one request per viewer per break)</option>
                  <option value="channel">Once per break for everyone (cheapest, no targeting)</option>
                </select></div>
              {ads.adServerId && <button className="btn ghost" onClick={async () => { try { setTest(await fastApi.testAdServer(ads.adServerId!, pol.breakSec)) } catch (e: any) { notify({ kind: 'error', title: 'The test failed.', message: e.message }) } }}>Test: what would it send for a {pol.breakSec} s break?</button>}
              {test && <div style={{ marginTop: 12 }}>
                <Notice kind={test.ads.length ? 'ok' : 'warn'} variant="compact" title={test.ads.length ? `${test.ads.length} ad${test.ads.length === 1 ? '' : 's'}, ${fmtDur(test.adSec)}, in ${test.elapsedMs} ms` : `No ads (${test.elapsedMs} ms)`}
                  message={test.problems.map(p => `${p.code}: ${p.message}`).join('; ') || undefined} />
                {test.ads.map(a => <div key={a.id} className="hintxt" style={{ marginTop: 4 }}>{a.sequence ?? '·'} {a.title ?? a.id} · {fmtDur(a.durationSec)} · {a.adSystem ?? ''} · {a.creativeKey}</div>)}
              </div>}
            </>
          )}
        </div>
      </div>}

      {ads.mode === 'stitched' && report && <div className="card">
        <div className="card-h"><h3>Last 7 days</h3></div>
        <div className="card-b">
          <div className="fast-math">
            <div><div className="k">Decisions</div><div className="v">{report.decisions}</div></div>
            <div><div className="k">Paid fill</div><div className="v">{report.fillRate == null ? '—' : `${Math.round(report.fillRate * 100)}%`}</div></div>
            <div><div className="k">House spots</div><div className="v">{report.houseShare == null ? '—' : `${Math.round(report.houseShare * 100)}%`}</div></div>
            <div><div className="k">Ad server p95</div><div className="v">{report.p95Ms == null ? '—' : `${report.p95Ms} ms`}</div></div>
          </div>
          {(report.timeouts + report.errors) > 0 && <div style={{ marginTop: 10 }}><Notice kind="warn" variant="compact" message={`${report.timeouts} timed out and ${report.errors} failed; those breaks played house spots.`} /></div>}
          {report.beacons && <>
            <div className="sec-label">Reported to the ad server</div>
            {report.beacons.impressions > 0 ? <>
              <div className="fast-math">
                <div><div className="k">Impressions</div><div className="v">{report.beacons.impressions}</div></div>
                <div><div className="k">Reached halfway</div><div className="v">{report.beacons.events.midpoint?.ads ?? 0}</div></div>
                <div><div className="k">Played to the end</div><div className="v">{report.beacons.completes}</div></div>
                <div><div className="k">Completion</div><div className="v">{report.beacons.completionRate == null ? '—' : `${Math.round(report.beacons.completionRate * 100)}%`}</div></div>
              </div>
              {report.beacons.failed > 0 && <div style={{ marginTop: 10 }}><Notice kind="warn" variant="compact" message={`${report.beacons.failed} tracking ${report.beacons.failed === 1 ? 'pixel' : 'pixels'} got no good answer from the ad server's tracker. A failed pixel is not sent again.`} /></div>}
            </> : <div className="hintxt">Nothing yet. Volt sends each ad's impression and quartiles itself as viewers' players reach them, so they appear here once a stitched break has played.</div>}
          </>}
          {report.creatives.length > 0 && <>
            <div className="sec-label">Creatives</div>
            {report.creatives.slice(0, 8).map(c => <div key={c.creative_key} className="hintxt" style={{ display: 'flex', gap: 8 }}><span style={{ flex: 1 }}>{c.title ?? c.creative_key}</span><span>{c.status === 'ready' ? `${c.plays} plays` : 'packaging, plays from its next request'}</span></div>)}
          </>}
        </div>
      </div>}
    </div>
  )
}

// ---------------------------------------------------------------- on air

const ROLE: Record<ReadinessRow['role'], string> = { content: 'Programme', house: 'House spot', slate: 'Slate' }
const READY: Record<ReadinessRow['state'], { label: string; cls: string }> = {
  ready: { label: 'Ready', cls: 'live' }, preparing: { label: 'Preparing', cls: 'sched' },
  'needs-prepare': { label: 'Needs preparing', cls: 'warn' }, 'no-source': { label: 'No source', cls: 'down' },
}
const ago = (iso: string | null) => {
  if (!iso) return 'never'
  const s = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000))
  return s < 60 ? `${s}s ago` : s < 3600 ? `${Math.round(s / 60)} min ago` : new Date(iso).toLocaleString([], { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })
}

/**
 * What the channel is doing now: the playout (is it writing the channel, how
 * often has it been restarted, what could it not read), a preview of its own
 * playlists, the public switch, and whether every title it uses is ready to air.
 */
function AirTab({ channelId, hasActive, onAirChange }: { channelId: string; hasActive: boolean; onAirChange: (on: boolean) => void }) {
  const notify = useNotify()
  const [playout, setPlayout] = useState<Playout | null>(null)
  const [onAir, setOnAir] = useState(false)
  const [hls, setHls] = useState<string | null>(null)
  const [stitched, setStitched] = useState(false)
  const [ready, setReady] = useState<ReadinessRow[] | null>(null)
  const [busy, setBusy] = useState('')
  const [err, setErr] = useState('')

  const load = async () => {
    try {
      const [c, r] = await Promise.all([fastApi.channel(channelId), fastApi.readiness(channelId)])
      setPlayout(c.playout); setOnAir(c.channel.onAir); setHls(c.urls?.hls ?? null); setStitched(c.ads.mode === 'stitched'); setReady(r.items); setErr('')
    } catch (e: any) { setErr(e.message) }
  }
  useEffect(() => { load(); const t = window.setInterval(load, 10_000); return () => window.clearInterval(t) }, [channelId])

  const toggle = async () => {
    setBusy('air')
    try {
      const r = await fastApi.setOnAir(channelId, !onAir)
      setOnAir(r.onAir); onAirChange(r.onAir)
      notify({ kind: 'ok', title: r.onAir ? 'The channel is public.' : 'The channel is private.', message: r.onAir ? 'Viewers can play it from its public URL and the player.' : 'The playout keeps running; only the console can preview it.' })
    } catch (e: any) { notify({ kind: 'error', title: "Couldn't change it.", message: e.message }) } finally { setBusy('') }
  }
  const prepare = async () => {
    setBusy('prep')
    try {
      const r = await fastApi.prepare(channelId)
      notify({ kind: r.queued.length ? 'ok' : 'info', title: r.queued.length ? `Preparing ${r.queued.length} title(s).` : 'Nothing to prepare.',
        message: r.skipped.length ? `${r.skipped.length} title(s) cannot be prepared: their source file is no longer here. Upload them again.` : undefined })
      await load()
    } catch (e: any) { notify({ kind: 'error', title: "Couldn't prepare.", message: e.message }) } finally { setBusy('') }
  }

  if (err) return <Notice kind="error" title="Couldn't load the channel's status." message={err} />
  if (!ready) return <div className="loading">Loading…</div>
  const healthy = !!playout?.fresh && playout.status === 'running'
  const state = !hasActive ? { label: 'No active lineup', cls: 'idle' }
    : healthy ? { label: 'Playing', cls: 'live' }
    : playout?.status === 'failed' ? { label: 'Failed to start', cls: 'down' }
    : playout?.status === 'starting' || !playout ? { label: 'Starting', cls: 'sched' }
    : { label: 'Not responding', cls: 'warn' }
  const toFix = ready.filter(r => r.state === 'needs-prepare').length

  return (
    <div className="grid-2">
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16, minWidth: 0 }}>
        <div className="card">
          <div className="card-h"><h3>Preview</h3><span className="sub">{stitched ? "the channel's own feed, with house spots in its breaks; viewers get their own ads" : "the channel's own feed"}</span></div>
          <div className="card-b">
            {healthy && hls ? <VoltPlayerView src={hls} live autoplay={false} skin="admin" />
              : <div style={{ color: 'var(--muted)', fontSize: 'var(--fs-sm)' }}>{hasActive ? 'The preview starts once the playout is writing the channel.' : 'Activate a lineup to start the channel.'}</div>}
          </div>
        </div>
        <div className={`big-toggle${onAir ? '' : ' offair'}`}>
          <div className="txt">
            <div className="t">{onAir ? 'Public' : 'Private'}</div>
            <div className="d">{onAir ? 'Viewers can play the channel from its public URL and the player.' : 'Only the console can preview it. Turn it on to give viewers the channel.'}</div>
          </div>
          {/* The spread first, so this control's own switch semantics win over
              pressable's generic button role and label. */}
          <div {...pressable(() => { if (!busy) toggle() })}
            className={`switch${onAir ? '' : ' off'}`} role="switch" aria-checked={onAir} aria-label="Public" aria-disabled={!!busy}><i /></div>
        </div>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 16, minWidth: 0 }}>
        <div className="card">
          <div className="card-h"><h3>Playout</h3><span className="spacer" /><span className={`tag ${state.cls}`}>{state.label}</span></div>
          <div className="card-b">
            {playout?.error && <Notice kind="error" variant="compact" message={playout.error} />}
            <div className="kv"><span className="k">Runs on</span><span className="v">{playout ? (playout.launcher === 'ecs' ? 'Its own task (ECS)' : playout.launcher === 'local' ? 'This server' : playout.launcher) : '—'}</span></div>
            <div className="kv"><span className="k">Last heard from</span><span className="v">{ago(playout?.last_seen_at ?? null)}</span></div>
            <div className="kv"><span className="k">Running since</span><span className="v">{ago(playout?.started_at ?? null)}</span></div>
            <div className="kv"><span className="k">Restarts</span><span className="v">{playout?.restarts ?? 0}</span></div>
            <div className="kv"><span className="k">Segments published</span><span className="v">{playout?.media_sequence != null ? playout.media_sequence.toLocaleString() : '—'}</span></div>
            {!!playout?.unreadable?.length && (
              <Notice kind="warn" variant="compact" message={`${playout.unreadable.length} title(s) could not be read and are being skipped. Check the Media list below.`} />
            )}
          </div>
        </div>
        <div className="card">
          <div className="card-h"><h3>Media</h3><span className="sub">every title, house spot and slate the channel uses</span><span className="spacer" />
            {toFix > 0 && <button className="btn ghost" onClick={prepare} disabled={!!busy}>{busy === 'prep' ? 'Queuing…' : `Prepare ${toFix}`}</button>}</div>
          {ready.length === 0 ? <div className="card-b" style={{ color: 'var(--muted)' }}>The lineup uses no titles yet.</div>
            : ready.map(r => (
              <div key={r.assetId} className="fast-ready">
                <div style={{ minWidth: 0 }}>
                  <div className="nm">{r.title}</div>
                  <div className="meta">{ROLE[r.role]}{r.why ? ` · ${r.why}` : ''}</div>
                </div>
                <span className={`tag ${READY[r.state].cls}`}>{READY[r.state].label}</span>
              </div>
            ))}
        </div>
      </div>
    </div>
  )
}
