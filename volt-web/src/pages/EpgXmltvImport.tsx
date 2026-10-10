import { useEffect, useRef, useState } from 'react'
import { api, type ImportSource, type ImportRun, type GuideChannel, type ImportCounts, type ImportTestResult, type ImportSourceBody } from '../api'
import { pressable } from '../a11y'
import XmltvLineup from './EpgXmltvLineup'

/* ============================================================================
   XMLTV IMPORT drawer, opened from the EPG list.

   A SOURCE is one guide we take in: a URL Volt fetches on a schedule (a
   provider's nightly file, or a hosted guide API with the dates in the URL)
   or files uploaded by hand.

   A URL source KEEPS THE GUIDE N DAYS AHEAD: each run asks for today through
   today + days ahead (one request, or one per day with {date}), programmes
   beyond that are not imported, and when any mapped channel's guide ends
   sooner than the minimum, the run warns and owners are alerted once. A
   failed run retries sooner than the refresh (15 min, 30, 60 ...). "Try it"
   fetches the first request and shows what is in it without importing. Each run reads the file,
   records the channels it names, maps them to ours, and writes the programmes
   as a diff: unchanged rows are left alone, changed ones updated, and what the
   file no longer lists inside the window it covers is removed.

   The CHANNELS panel is the part that needs a person. Their channel ids are
   theirs: Volt maps one on its own only when the match is unambiguous (our
   XMLTV id equals theirs, or exactly one channel has the same name), and every
   other channel waits here, skipped and counted, until somebody picks ours.
   ========================================================================== */
const fmt = (iso: string | null) => iso ? new Date(iso).toLocaleString([], { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : 'never'
const STATUS: Record<string, { label: string; cls: string }> = {
  ok: { label: 'Imported', cls: 'ok' }, warnings: { label: 'Imported with warnings', cls: 'warn' },
  failed: { label: 'Failed', cls: 'bad' }, running: { label: 'Running', cls: 'muted' },
}
const MODE_LABEL = { single: 'one request for the window', per_day: 'one request per day' }
const inZone = (iso: string, zone: string) => {
  try { return new Date(iso).toLocaleString([], { timeZone: zone, weekday: 'short', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', timeZoneName: 'short' }) }
  catch { return new Date(iso).toISOString().slice(0, 16).replace('T', ' ') + ' UTC' }
}
const fmtDay = (iso: string | null) => iso ? new Date(iso).toLocaleString([], { weekday: 'short', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : ''
const PLACEHOLDERS: { t: string; mode: 'single' | 'per_day' | 'both'; hint: string }[] = [
  { t: '{date}', mode: 'per_day', hint: 'the day being fetched' },
  { t: '{from}', mode: 'both', hint: 'today' },
  { t: '{to}', mode: 'both', hint: 'today + days ahead' },
  { t: '{days}', mode: 'both', hint: 'days ahead, as a number' },
  { t: '{from_unix}', mode: 'both', hint: 'today 00:00, unix seconds' },
  { t: '{to_unix}', mode: 'both', hint: 'end of the window, unix seconds' },
]

type Form = {
  id?: string; name: string; kind: 'url' | 'upload'; url: string; refreshHours: number; fallbackTz: string; keepPastDays: number; autoMap: boolean
  requestMode: 'single' | 'per_day'; daysAhead: number; minDaysAhead: number; dateFormat: ImportSourceBody['dateFormat']
  headerNames: string[]; headerChanges: Record<string, string | null>; newHeader: { name: string; value: string }
  newChannels: 'review' | 'ignore'; timeMode: 'offsets' | 'local'
}
const blankForm = (): Form => ({ name: '', kind: 'url', url: '', refreshHours: 6, fallbackTz: '', keepPastDays: 1, autoMap: true,
  requestMode: 'single', daysAhead: 7, minDaysAhead: 5, dateFormat: 'YYYY-MM-DD', headerNames: [], headerChanges: {}, newHeader: { name: '', value: '' }, newChannels: 'review', timeMode: 'offsets' })
const clampInt = (v: string, lo: number, hi: number) => Math.max(lo, Math.min(hi, Math.round(+v || 0)))

function Coverage({ s }: { s: ImportSource }) {
  if (s.kind !== 'url') return null
  if (s.coverageDaysAhead == null) return <div className="hintxt" style={{ marginTop: 2 }}>Keeps {s.daysAhead} days ahead{s.minDaysAhead ? `, alerts below ${s.minDaysAhead}` : ''}. Coverage shows after the first run with a mapped channel.</div>
  return (
    <div className="hintxt" style={{ marginTop: 2, color: s.coverageLow ? 'var(--warn)' : undefined }}>
      Guide reaches {s.coverageDaysAhead} days ahead ({fmtDay(s.coverageUntil)}) · keeps {s.daysAhead}{s.minDaysAhead ? `, alerts below ${s.minDaysAhead}` : ''}
      {s.coverageLow && ' · running short: check the provider'}
    </div>
  )
}


function summary(c: Partial<ImportCounts> | undefined): string {
  if (!c) return ''
  if (c.notModified) return 'guide unchanged since the last run'
  const parts = [
    c.inserted ? `${c.inserted} new` : '', c.updated ? `${c.updated} changed` : '', c.removed ? `${c.removed} removed` : '',
    c.unchanged ? `${c.unchanged} unchanged` : '',
  ].filter(Boolean)
  return parts.length ? parts.join(' · ') : 'no changes'
}

const myZone = (() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone } catch { return '' } })()
let zonesCache: string[] | null = null
function zones(): string[] {
  if (zonesCache) return zonesCache
  try { zonesCache = (Intl as any).supportedValuesOf('timeZone') as string[] } catch { zonesCache = ['UTC', 'Europe/London', 'Australia/Sydney', 'Australia/Brisbane', 'Asia/Singapore', 'Asia/Kuala_Lumpur', 'Pacific/Auckland', 'America/New_York'] }
  return zonesCache
}

export default function XmltvImportDrawer({ onClose, onImported }: { onClose: () => void; onImported?: () => void }) {
  const [sources, setSources] = useState<ImportSource[] | null>(null)
  const [channels, setChannels] = useState<GuideChannel[]>([])
  const [err, setErr] = useState('')
  const [form, setForm] = useState<Form | null>(null)
  const [panel, setPanel] = useState<Record<string, 'channels' | 'runs' | 'test' | null>>({})
  const [tests, setTests] = useState<Record<string, ImportTestResult | null>>({})
  const urlRef = useRef<HTMLInputElement>(null)
  const [runs, setRuns] = useState<Record<string, ImportRun[]>>({})
  const [busy, setBusy] = useState<Record<string, string>>({})
  const [result, setResult] = useState<Record<string, { status: string; text: string; warnings: string[] }>>({})
  const fileRef = useRef<HTMLInputElement>(null)
  const uploadFor = useRef<string | null>(null)

  const load = () => api.importSources().then(setSources).catch(e => setErr(e.message))
  useEffect(() => { load(); api.guideChannels().then(setChannels).catch(() => setChannels([])) }, [])

  async function save() {
    if (!form) return
    setErr('')
    if (!form.name.trim()) { setErr('Name the source after where the guide comes from'); return }
    if (form.kind === 'url' && !/^https?:\/\//i.test(form.url.trim())) { setErr('Enter the guide URL, starting with https://'); return }
    if (form.kind === 'url' && form.requestMode === 'per_day' && !form.url.includes('{date}')) { setErr('One request per day needs {date} in the URL, where the day goes'); return }
    if (form.kind === 'url' && form.requestMode === 'single' && form.url.includes('{date}')) { setErr('{date} is for one request per day. For one request covering the window, use {from} and {to}'); return }
    if (form.minDaysAhead > form.daysAhead) { setErr('The alert threshold cannot be more than the days kept ahead'); return }
    if (form.timeMode === 'local' && !form.fallbackTz && !window.confirm("Ignoring the feed's offsets with no source time zone reads every time in each channel's own zone. Continue?")) return
    const before = form.id ? sources?.find(x => x.id === form.id) : null
    const timesChanged = !!before && ((before.fallbackTz ?? '') !== form.fallbackTz || (before.timeMode ?? 'offsets') !== form.timeMode)
    if (timesChanged && !window.confirm("The time zone or how times are read changed. This source's programmes that have not aired yet are cleared and the guide is read again at the corrected times. Continue?")) return
    const headers = Object.fromEntries(Object.entries(form.headerChanges).filter(([, v]) => v !== '')) as Record<string, string | null>
    if (form.newHeader.name.trim() && form.newHeader.value) headers[form.newHeader.name.trim()] = form.newHeader.value
    const body: Partial<ImportSourceBody> = {
      name: form.name.trim(), url: form.kind === 'url' ? form.url.trim() : null, refreshHours: form.kind === 'url' ? form.refreshHours : null,
      fallbackTz: form.fallbackTz || null, keepPastDays: form.keepPastDays, autoMap: form.autoMap, newChannels: form.newChannels, timeMode: form.timeMode,
      ...(form.kind === 'url' ? { requestMode: form.requestMode, daysAhead: form.daysAhead, minDaysAhead: form.minDaysAhead, dateFormat: form.dateFormat,
        ...(Object.keys(headers).length ? { headers } : {}) } : {}),
    }
    try {
      if (form.id) {
        const saved = await api.updateImportSource(form.id, body)
        setForm(null); load()
        if (saved.reread) {
          setResult(m => ({ ...m, [saved.id]: { status: 'ok', text: `Times changed: ${saved.reread!.removedProgrammes} programme(s) at the old times cleared${saved.reread!.reimporting ? ', reading the guide again' : '. Upload the file again to re-import'}.`, warnings: [] } }))
          if (saved.reread.reimporting) run(saved).catch(() => {})
        }
        return
      }
      await api.createImportSource({ ...body, name: body.name!, kind: form.kind })
      setForm(null); load()
    } catch (e: any) { setErr(e.message) }
  }

  function showResult(id: string, r: { status: string; counts: ImportCounts; warnings: string[]; error?: string }) {
    setResult(m => ({ ...m, [id]: { status: r.status, text: r.error ?? summary(r.counts), warnings: r.warnings ?? [] } }))
    load()
    if (r.status !== 'failed') onImported?.()
  }
  async function run(s: ImportSource) {
    setBusy(b => ({ ...b, [s.id]: 'Importing…' })); setErr('')
    try { showResult(s.id, await api.runImportSource(s.id)) } catch (e: any) { setErr(e.message) } finally { setBusy(b => ({ ...b, [s.id]: '' })) }
  }
  async function upload(file: File) {
    const id = uploadFor.current
    if (!id) return
    setBusy(b => ({ ...b, [id]: `Uploading ${file.name}…` })); setErr('')
    try { showResult(id, await api.uploadImportFile(id, file)) } catch (e: any) { setErr(e.message) } finally { setBusy(b => ({ ...b, [id]: '' })) }
  }
  async function tryIt(s: ImportSource) {
    setPanel(p => ({ ...p, [s.id]: 'test' })); setTests(t => ({ ...t, [s.id]: null })); setErr('')
    try { const r = await api.testImportSource(s.id); setTests(t => ({ ...t, [s.id]: r })) }
    catch (e: any) { setErr(e.message); setPanel(p => ({ ...p, [s.id]: null })) }
  }
  function insertToken(t: string) {
    if (!form) return
    const el = urlRef.current
    const at = el?.selectionStart ?? form.url.length
    const url = form.url.slice(0, at) + t + form.url.slice(el?.selectionEnd ?? at)
    setForm({ ...form, url })
    requestAnimationFrame(() => { el?.focus(); el?.setSelectionRange(at + t.length, at + t.length) })
  }
  const editForm = (s: ImportSource): Form => ({ id: s.id, name: s.name, kind: s.kind, url: s.url ?? '', refreshHours: s.refreshHours ?? 6, fallbackTz: s.fallbackTz ?? '',
    keepPastDays: s.keepPastDays, autoMap: s.autoMap, requestMode: s.requestMode ?? 'single', daysAhead: s.daysAhead ?? 7, minDaysAhead: s.minDaysAhead ?? 5,
    dateFormat: s.dateFormat ?? 'YYYY-MM-DD', headerNames: s.headerNames ?? [], headerChanges: {}, newHeader: { name: '', value: '' }, newChannels: s.newChannels ?? 'review', timeMode: s.timeMode ?? 'offsets' })
  async function togglePanel(id: string, which: 'channels' | 'runs') {
    const next = panel[id] === which ? null : which
    setPanel(p => ({ ...p, [id]: next }))
    if (next === 'runs') api.importRuns(id).then(r => setRuns(m => ({ ...m, [id]: r }))).catch(e => setErr(e.message))
  }
  async function remove(s: ImportSource) {
    if (!window.confirm(`Remove "${s.name}"? Its programmes that have not aired yet are removed from the guide with it. Programmes that already aired stay.`)) return
    try { await api.deleteImportSource(s.id); load(); onImported?.() } catch (e: any) { setErr(e.message) }
  }

  return (
    <div className="drawer-scrim" {...pressable((e: any) => { ((onClose) as any)(e) })} data-a11y-click="">
      <div className="drawer" style={{ width: 860, maxWidth: '100vw' }} {...pressable((e: any) => { (((e: any) => e.stopPropagation()) as any)(e) })} data-a11y-click="">
        <div className="drawer-h"><div className="t">XMLTV import</div><button className="xbtn" onClick={onClose} aria-label="Close">✕</button></div>
        <div className="drawer-b">
          {err && <div className="err">{err}</div>}
          <input ref={fileRef} type="file" accept=".xml,.gz,.xmltv,application/xml,text/xml,application/gzip" style={{ display: 'none' }}
            onChange={e => { const f = e.target.files?.[0]; e.target.value = ''; if (f) upload(f) }} />

          <div className="sec-label" style={{ display: 'flex', alignItems: 'center' }}>
            <span>Guide sources</span><div style={{ flex: 1 }} />
            {!form && <button className="btn ghost" onClick={() => setForm(blankForm())}>New source</button>}
          </div>
          <div className="hintxt" style={{ marginBottom: 10 }}>Bring in a guide your customer or a provider already has, as a file or from a hosted guide API. A URL source is fetched on a schedule and keeps the guide a set number of days ahead. Each run updates what changed and removes what the guide no longer lists, so refreshes never pile up duplicates.</div>

          {form && (
            <div className="card" style={{ padding: 14, marginBottom: 12 }}>
              <div className="field"><label>Name</label>
                <input className="inp" value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} placeholder="e.g. Provider X nightly guide" />
              </div>
              {!form.id && (
                <div className="field"><label>How the guide arrives</label>
                  <select className="inp" value={form.kind} onChange={e => setForm({ ...form, kind: e.target.value as any })}>
                    <option value="url">From a URL or hosted guide API, kept up to date</option>
                    <option value="upload">Uploaded by hand</option>
                  </select>
                </div>
              )}
              {form.kind === 'url' && (
                <>
                  <div className="field"><label>Requests</label>
                    <select className="inp" value={form.requestMode} onChange={e => setForm({ ...form, requestMode: e.target.value as Form['requestMode'] })}>
                      <option value="single">One request for the whole window (a file, or an API taking a date range)</option>
                      <option value="per_day">One request per day (an API serving a day at a time)</option>
                    </select>
                  </div>
                  <div className="field"><label>Guide URL</label>
                    <input ref={urlRef} className="inp" value={form.url} onChange={e => setForm({ ...form, url: e.target.value })}
                      placeholder={form.requestMode === 'per_day' ? 'https://api.provider.example/epg/{date}.xml?apikey=…' : 'https://provider.example/guide.xml.gz  or  …/epg?from={from}&to={to}'}
                      style={{ fontFamily: 'ui-monospace,monospace', fontSize: 'var(--fs-sm)' }} />
                    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 6, alignItems: 'center' }}>
                      <span className="hintxt" style={{ marginTop: 0 }}>Insert:</span>
                      {PLACEHOLDERS.filter(p => p.mode === 'both' || p.mode === form.requestMode).map(p => (
                        <button key={p.t} type="button" className="btn ghost" style={{ padding: '2px 8px', fontFamily: 'ui-monospace,monospace', fontSize: 'var(--fs-sm)' }} title={p.hint} onClick={() => insertToken(p.t)}>{p.t}</button>
                      ))}
                    </div>
                    <div className="hintxt" style={{ marginTop: 4 }}>
                      {form.requestMode === 'per_day'
                        ? 'Volt asks for today and each day up to the days ahead, putting the day where {date} is. A day that fails is retried on the next run and its part of the guide is left as it was.'
                        : 'A static file needs no placeholders. For an API that takes a range, {from} and {to} are filled with today and today + days ahead.'}
                      {' '}Dates are in the zone below, or UTC.
                    </div>
                  </div>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr 1fr', gap: 10 }}>
                    <div className="field"><label>Keep days ahead</label>
                      <input className="inp" type="number" min={1} max={21} value={form.daysAhead} onChange={e => { const d = clampInt(e.target.value, 1, 21); setForm({ ...form, daysAhead: d, minDaysAhead: Math.min(form.minDaysAhead, d) }) }} />
                    </div>
                    <div className="field"><label>Alert below (days)</label>
                      <input className="inp" type="number" min={0} max={form.daysAhead} value={form.minDaysAhead} onChange={e => setForm({ ...form, minDaysAhead: clampInt(e.target.value, 0, form.daysAhead) })} />
                    </div>
                    <div className="field"><label>Refresh every</label>
                      <select className="inp" value={form.refreshHours} onChange={e => setForm({ ...form, refreshHours: +e.target.value })}>
                        {[1, 3, 6, 12, 24, 48, 168].map(h => <option key={h} value={h}>{h === 168 ? 'week' : h === 1 ? 'hour' : `${h} hours`}</option>)}
                      </select>
                    </div>
                    <div className="field"><label>Date format</label>
                      <select className="inp" value={form.dateFormat} onChange={e => setForm({ ...form, dateFormat: e.target.value as Form['dateFormat'] })}>
                        <option value="YYYY-MM-DD">2026-10-17</option>
                        <option value="YYYYMMDD">20261017</option>
                        <option value="DD/MM/YYYY">17/10/2026</option>
                        <option value="unix">Unix seconds</option>
                      </select>
                    </div>
                  </div>
                  <div className="hintxt" style={{ marginTop: -4, marginBottom: 10 }}>
                    Programmes further out than {form.daysAhead} days are not imported. {form.minDaysAhead ? `If any mapped channel's guide ends sooner than ${form.minDaysAhead} days ahead, the run says so and owners and admins are alerted.` : 'No alert when the guide runs short.'}
                  </div>
                  <div className="field"><label>Request headers (an API key, say)</label>
                    {form.headerNames.filter(n => form.headerChanges[n] !== null).map(n => (
                      <div key={n} style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 6 }}>
                        <code style={{ flex: '0 0 180px', overflow: 'hidden', textOverflow: 'ellipsis' }}>{n}</code>
                        <input className="inp" type="password" autoComplete="new-password" placeholder="Saved, hidden. Type to replace" value={form.headerChanges[n] ?? ''}
                          onChange={e => setForm({ ...form, headerChanges: { ...form.headerChanges, [n]: e.target.value } })} />
                        <button type="button" className="btn ghost" onClick={() => setForm({ ...form, headerChanges: { ...form.headerChanges, [n]: null } })}>Remove</button>
                      </div>
                    ))}
                    <div style={{ display: 'flex', gap: 8 }}>
                      <input className="inp" style={{ flex: '0 0 180px' }} placeholder="x-api-key" value={form.newHeader.name} onChange={e => setForm({ ...form, newHeader: { ...form.newHeader, name: e.target.value } })} />
                      <input className="inp" type="password" autoComplete="new-password" placeholder="Value" value={form.newHeader.value} onChange={e => setForm({ ...form, newHeader: { ...form.newHeader, value: e.target.value } })} />
                    </div>
                    <div className="hintxt" style={{ marginTop: 4 }}>Stored encrypted and never shown again. A key that goes in the URL can stay in the URL.</div>
                  </div>
                </>
              )}
              <div className="tz-box">
                <div className="sec-label" style={{ margin: '0 0 6px' }}>Time zone</div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                  <div className="field" style={{ marginBottom: 0 }}><label>Source time zone (the zone the guide is for)</label>
                    <select className="inp" value={form.fallbackTz} onChange={e => setForm({ ...form, fallbackTz: e.target.value })}>
                      <option value="">Not set: each channel's own zone</option>
                      {zones().map(z => <option key={z} value={z}>{z}</option>)}
                    </select>
                    {myZone && form.fallbackTz !== myZone && (
                      <button type="button" className="lineup-suggest" onClick={() => setForm({ ...form, fallbackTz: myZone })}>Use my zone: {myZone}</button>
                    )}
                  </div>
                  <div className="field" style={{ marginBottom: 0 }}><label>Times in the feed</label>
                    <select className="inp" value={form.timeMode} onChange={e => setForm({ ...form, timeMode: e.target.value as Form['timeMode'] })}>
                      <option value="offsets">Read as stamped (+0000, +1100 …)</option>
                      <option value="local">Ignore the offsets: they are local times</option>
                    </select>
                  </div>
                </div>
                <div className="hintxt" style={{ marginTop: 6 }}>
                  {form.timeMode === 'offsets'
                    ? <>Times with an offset are exact, whatever zone is set. The source zone reads times that have no offset{form.kind === 'url' ? ', decides which day is today for the URL dates and days ahead,' : ''} and is the zone of channels created from this feed.</>
                    : <>Every time is read as local time in {form.fallbackTz || "each channel's own zone"}, whatever offset it carries. Use this only for a feed whose offsets are wrong: Try it shows sample programmes so you can check a slot you know, such as the evening news.</>}
                </div>
              </div>
              <div className="field"><label>Keep past days</label>
                <input className="inp" type="number" min={0} max={365} style={{ width: 120 }} value={form.keepPastDays} onChange={e => setForm({ ...form, keepPastDays: Math.max(0, Math.min(365, +e.target.value || 0)) })} />
              </div>
              <div className="field"><label>Channels the feed adds later</label>
                <select className="inp" value={form.newChannels} onChange={e => setForm({ ...form, newChannels: e.target.value as Form['newChannels'] })}>
                  <option value="review">Wait for me to choose (listed as waiting, named on each run)</option>
                  <option value="ignore">Not used unless I choose them (for big feeds where only a few matter)</option>
                </select>
              </div>
              <label style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 'var(--fs-sm)', color: 'var(--muted)' }}>
                <input type="checkbox" checked={form.autoMap} onChange={e => setForm({ ...form, autoMap: e.target.checked })} />
                Use channels automatically when the match is certain: our channel has their XMLTV id, or the name is unique on both sides
              </label>
              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 12 }}>
                <button className="btn ghost" onClick={() => setForm(null)}>Cancel</button>
                <button className="btn primary" onClick={save}>{form.id ? 'Save' : 'Add source'}</button>
              </div>
            </div>
          )}

          {sources === null ? <div className="loading">Loading…</div> : sources.length === 0 && !form ? (
            <div className="hintxt">No guide sources yet.</div>
          ) : sources.map(s => {
            const st = STATUS[s.running ? 'running' : (s.lastStatus ?? '')]
            const r = result[s.id]
            const last = s.lastRun
            return (
              <div key={s.id} className="card" style={{ padding: 0, marginBottom: 10 }}>
                <div style={{ padding: '12px 14px' }}>
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontWeight: 600 }}>{s.name}{st && <span className={`nt-pill ${st.cls}`}>{st.label}</span>}</div>
                    <div className="hintxt" style={{ marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {s.kind === 'url' ? <><span style={{ fontFamily: 'ui-monospace,monospace' }}>{s.url}</span></> : 'Uploaded files'}
                    </div>
                    {s.kind === 'url' && (
                      <div className="hintxt" style={{ marginTop: 2 }}>
                        {MODE_LABEL[s.requestMode ?? 'single']}{s.requestMode === 'per_day' ? ` (${s.plannedRequests.length} a run)` : ''} · every {s.refreshHours} h · next {fmt(s.nextRunAt)}
                        {s.headerNames.length > 0 && <> · sends {s.headerNames.join(', ')}</>}
                        {s.consecutiveFailures > 0 && <span style={{ color: 'var(--warn)' }}> · failed {s.consecutiveFailures} time{s.consecutiveFailures === 1 ? '' : 's'} in a row, retrying sooner</span>}
                      </div>
                    )}
                    <div className="hintxt" style={{ marginTop: 2 }}>
                      Time zone {s.fallbackTz ?? "not set (each channel's own)"} · {s.timeMode === 'local' ? <span style={{ color: 'var(--warn)' }}>feed offsets ignored, times read as local</span> : 'times read as stamped'}
                    </div>
                    <Coverage s={s} />
                    <div className="hintxt" style={{ marginTop: 2 }}>
                      Last run {fmt(s.lastRunAt)}{last ? ` · ${summary(last.counts)}` : ''} · {s.mapped ?? 0} channel{s.mapped === 1 ? '' : 's'} used
                      {(s.notUsed ?? 0) > 0 && <> · {s.notUsed} not used</>}
                      {(s.unmapped ?? 0) > 0 && <span style={{ color: 'var(--warn)' }}> · {s.unmapped} waiting for you to choose</span>}
                    </div>
                    {s.lastError && !r && <div className="err" style={{ marginTop: 4 }}>{s.lastError}</div>}
                    {busy[s.id] && <div className="hintxt" style={{ marginTop: 4, color: 'var(--text)' }}>{busy[s.id]}</div>}
                    {r && (
                      <div style={{ marginTop: 6 }}>
                        <div className={r.status === 'failed' ? 'err' : 'hintxt'} style={{ marginTop: 0, color: r.status === 'failed' ? undefined : 'var(--text)' }}>{r.status === 'failed' ? r.text : `Done: ${r.text}`}</div>
                        {r.warnings.map((w, i) => <div key={i} className="hintxt" style={{ color: 'var(--warn)', marginTop: 2 }}>{w}</div>)}
                      </div>
                    )}
                  </div>
                  <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 10 }}>
                    {s.kind === 'url'
                      ? <><button className="btn" disabled={!!busy[s.id] || s.running} onClick={() => run(s)}>Import now</button>
                        <button className="btn ghost" onClick={() => panel[s.id] === 'test' ? setPanel(p => ({ ...p, [s.id]: null })) : tryIt(s)}>Try it</button></>
                      : <button className="btn" disabled={!!busy[s.id] || s.running} onClick={() => { uploadFor.current = s.id; fileRef.current?.click() }}>Upload file</button>}
                    <button className="btn ghost" onClick={() => togglePanel(s.id, 'channels')}>Channels{(s.unmapped ?? 0) > 0 ? ` (${s.unmapped} waiting)` : ''}</button>
                    <button className="btn ghost" onClick={() => togglePanel(s.id, 'runs')}>Runs</button>
                    <button className="btn ghost" onClick={() => setForm(editForm(s))}>Edit</button>
                    <button className="btn ghost" onClick={() => remove(s)}>Remove</button>
                  </div>
                </div>

                {panel[s.id] === 'test' && (
                  <div style={{ borderTop: '1px solid var(--border)', padding: '10px 14px' }}>
                    {!tests[s.id] ? <div className="loading">Fetching the first request…</div> : (() => {
                      const t = tests[s.id]!
                      return (
                        <>
                          <div className="hintxt" style={{ marginTop: 0 }}>Fetched <span style={{ fontFamily: 'ui-monospace,monospace', wordBreak: 'break-all' }}>{t.tried}</span>. No programmes were imported.</div>
                          {t.status === 'failed' ? <div className="err" style={{ marginTop: 6 }}>{t.error}</div> : (
                            <div style={{ marginTop: 6 }}>
                              <div style={{ fontWeight: 600 }}>{t.channels} channel{t.channels === 1 ? '' : 's'}, {t.programmes} programme{t.programmes === 1 ? '' : 's'} · {Math.round((t.bytes ?? 0) / 1024)} KB</div>
                              {t.firstStart && <div className="hintxt" style={{ marginTop: 2 }}>From {inZone(t.firstStart, t.timeReading?.zone ?? 'UTC')} to {t.lastEnd ? inZone(t.lastEnd, t.timeReading?.zone ?? 'UTC') : ''}{t.daysAhead != null ? `, ${t.daysAhead} days ahead` : ''}{s.requestMode === 'per_day' ? ' (this is one day: a run fetches every day)' : ''}</div>}
                              {!!t.offsets?.length && (
                                <div className="hintxt" style={{ marginTop: 4 }}>
                                  Times in the feed carry {t.offsets.map(o => `${o.offset === 'none' ? 'no offset' : o.offset === 'Z' ? 'Z (UTC)' : o.offset} (${o.count})`).join(', ')}.
                                  {t.offsets.some(o => o.offset === 'none') && !s.fallbackTz && <span style={{ color: 'var(--warn)' }}> Some have no offset: set the source time zone so they are read in the right zone.</span>}
                                </div>
                              )}
                              {!!t.samples?.length && (
                                <div className="tz-samples">
                                  <div className="hintxt" style={{ marginTop: 0 }}>
                                    As they will land in {t.timeReading?.zone ?? 'UTC (no source zone set)'}, {t.timeReading?.mode === 'local' ? 'offsets ignored' : 'read as stamped'}. Check one you know, such as the evening news.
                                  </div>
                                  <table>
                                    <tbody>
                                      {t.samples.map((x, i) => (
                                        <tr key={i}>
                                          <td style={{ whiteSpace: 'nowrap', fontWeight: 600 }}>{inZone(x.startsAt, t.timeReading?.zone ?? 'UTC')}</td>
                                          <td>{x.title}<div className="hintxt" style={{ marginTop: 0 }}>{x.channel}</div></td>
                                          <td className="hintxt mono" style={{ whiteSpace: 'nowrap' }}>{x.raw}</td>
                                        </tr>
                                      ))}
                                    </tbody>
                                  </table>
                                  <div className="hintxt" style={{ marginTop: 4 }}>If every time is out by the same few hours, the feed's offsets are wrong: Edit, then Times in the feed: Ignore the offsets.</div>
                                </div>
                              )}
                              {t.lineup && (
                                <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginTop: 6, flexWrap: 'wrap' }}>
                                  <span className="hintxt" style={{ marginTop: 0 }}>Lineup loaded: {t.lineup.used} used, {t.lineup.notUsed} not used, {t.lineup.waiting} waiting for you to choose.</span>
                                  <button className="btn" onClick={() => togglePanel(s.id, 'channels')}>Choose channels</button>
                                </div>
                              )}
                            </div>
                          )}
                          {t.requests.length > 1 && (
                            <details style={{ marginTop: 8 }}>
                              <summary className="hintxt" style={{ cursor: 'pointer' }}>The {t.requests.length} requests a run makes today</summary>
                              {t.requests.map(r => <div key={r.url} className="hintxt" style={{ fontFamily: 'ui-monospace,monospace', marginTop: 2, wordBreak: 'break-all' }}>{r.url}</div>)}
                            </details>
                          )}
                        </>
                      )
                    })()}
                  </div>
                )}

                {panel[s.id] === 'channels' && (
                  <div style={{ borderTop: '1px solid var(--border)', padding: '10px 14px' }}>
                    <XmltvLineup key={s.lastRunAt ?? 'new'} source={s} channels={channels} onChanged={load} />
                  </div>
                )}

                {panel[s.id] === 'runs' && (
                  <div style={{ borderTop: '1px solid var(--border)', padding: '10px 14px' }}>
                    {!runs[s.id] ? <div className="loading">Loading…</div> : runs[s.id].length === 0 ? <div className="hintxt">No runs yet.</div> : (
                      <table>
                        <thead><tr><th>When</th><th>How</th><th>Result</th></tr></thead>
                        <tbody>
                          {runs[s.id].map(x => (
                            <tr key={x.id}>
                              <td style={{ whiteSpace: 'nowrap', color: 'var(--muted)' }}>{fmt(x.started_at)}</td>
                              <td style={{ color: 'var(--muted)' }}>{x.trigger === 'schedule' ? 'Scheduled' : x.trigger === 'upload' ? 'Upload' : 'By hand'}</td>
                              <td>
                                <span className={`nt-pill ${STATUS[x.status]?.cls ?? 'muted'}`} style={{ marginLeft: 0 }}>{STATUS[x.status]?.label ?? x.status}</span>
                                <div className="hintxt" style={{ marginTop: 2 }}>{x.error ?? `${summary(x.counts)}${x.counts.programmesInFile != null ? ` · ${x.counts.programmesInFile} in file` : ''}`}</div>
                                {(x.warnings ?? []).map((w, i) => <div key={i} className="hintxt" style={{ marginTop: 2, color: 'var(--warn)' }}>{w}</div>)}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    )}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}
