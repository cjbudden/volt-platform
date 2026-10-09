import { useEffect, useRef, useState } from 'react'
import { api, type ImportSource, type ImportAlias, type ImportRun, type GuideChannel, type ImportCounts } from '../api'
import { pressable } from '../a11y'

/* ============================================================================
   XMLTV IMPORT drawer, opened from the EPG list.

   A SOURCE is one guide we take in: a URL Volt fetches on a schedule (a
   provider's nightly file) or files uploaded by hand. Each run reads the file,
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
const MAPPED_BY: Record<string, string> = { 'auto:xmltv_id': 'matched by XMLTV id', 'auto:name': 'matched by name', user: 'mapped by you' }

function summary(c: Partial<ImportCounts> | undefined): string {
  if (!c) return ''
  const parts = [
    c.inserted ? `${c.inserted} new` : '', c.updated ? `${c.updated} changed` : '', c.removed ? `${c.removed} removed` : '',
    c.unchanged ? `${c.unchanged} unchanged` : '',
  ].filter(Boolean)
  return parts.length ? parts.join(' · ') : 'no changes'
}

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
  const [form, setForm] = useState<{ id?: string; name: string; kind: 'url' | 'upload'; url: string; refreshHours: number; fallbackTz: string; keepPastDays: number; autoMap: boolean } | null>(null)
  const [panel, setPanel] = useState<Record<string, 'channels' | 'runs' | null>>({})
  const [aliases, setAliases] = useState<Record<string, ImportAlias[]>>({})
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
    const body = {
      name: form.name.trim(), url: form.kind === 'url' ? form.url.trim() : null, refreshHours: form.kind === 'url' ? form.refreshHours : null,
      fallbackTz: form.fallbackTz || null, keepPastDays: form.keepPastDays, autoMap: form.autoMap,
    }
    try {
      if (form.id) await api.updateImportSource(form.id, body)
      else await api.createImportSource({ ...body, kind: form.kind })
      setForm(null); load()
    } catch (e: any) { setErr(e.message) }
  }

  function showResult(id: string, r: { status: string; counts: ImportCounts; warnings: string[]; error?: string }) {
    setResult(m => ({ ...m, [id]: { status: r.status, text: r.error ?? summary(r.counts), warnings: r.warnings ?? [] } }))
    load()
    if (panel[id] === 'channels') api.importChannels(id).then(a => setAliases(m => ({ ...m, [id]: a })))
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
  async function togglePanel(id: string, which: 'channels' | 'runs') {
    const next = panel[id] === which ? null : which
    setPanel(p => ({ ...p, [id]: next }))
    if (next === 'channels') api.importChannels(id).then(a => setAliases(m => ({ ...m, [id]: a }))).catch(e => setErr(e.message))
    if (next === 'runs') api.importRuns(id).then(r => setRuns(m => ({ ...m, [id]: r }))).catch(e => setErr(e.message))
  }
  async function map(sourceId: string, a: ImportAlias, channelId: string | null) {
    try {
      await api.mapImportChannel(a.id, channelId)
      setAliases(m => ({ ...m, [sourceId]: (m[sourceId] ?? []).map(x => x.id === a.id ? { ...x, channelId, channelName: channels.find(c => c.id === channelId)?.name ?? null, mappedBy: channelId ? 'user' : null } : x) }))
      load()
    } catch (e: any) { setErr(e.message) }
  }
  async function remove(s: ImportSource) {
    if (!window.confirm(`Remove "${s.name}"? Its programmes that have not aired yet are removed from the guide with it. Programmes that already aired stay.`)) return
    try { await api.deleteImportSource(s.id); load(); onImported?.() } catch (e: any) { setErr(e.message) }
  }

  return (
    <div className="drawer-scrim" {...pressable((e: any) => { ((onClose) as any)(e) })} data-a11y-click="">
      <div className="drawer" style={{ width: 680, maxWidth: '100vw' }} {...pressable((e: any) => { (((e: any) => e.stopPropagation()) as any)(e) })} data-a11y-click="">
        <div className="drawer-h"><div className="t">XMLTV import</div><button className="xbtn" onClick={onClose} aria-label="Close">✕</button></div>
        <div className="drawer-b">
          {err && <div className="err">{err}</div>}
          <input ref={fileRef} type="file" accept=".xml,.gz,.xmltv,application/xml,text/xml,application/gzip" style={{ display: 'none' }}
            onChange={e => { const f = e.target.files?.[0]; e.target.value = ''; if (f) upload(f) }} />

          <div className="sec-label" style={{ display: 'flex', alignItems: 'center' }}>
            <span>Guide sources</span><div style={{ flex: 1 }} />
            {!form && <button className="btn ghost" onClick={() => setForm({ name: '', kind: 'url', url: '', refreshHours: 24, fallbackTz: '', keepPastDays: 1, autoMap: true })}>New source</button>}
          </div>
          <div className="hintxt" style={{ marginBottom: 10 }}>Bring in a guide your customer or a provider already has. Each run updates what changed and removes what the file no longer lists, so a nightly refresh never piles up duplicates.</div>

          {form && (
            <div className="card" style={{ padding: 14, marginBottom: 12 }}>
              <div className="field"><label>Name</label>
                <input className="inp" value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} placeholder="e.g. Provider X nightly guide" />
              </div>
              {!form.id && (
                <div className="field"><label>How the guide arrives</label>
                  <select className="inp" value={form.kind} onChange={e => setForm({ ...form, kind: e.target.value as any })}>
                    <option value="url">From a URL, fetched on a schedule</option>
                    <option value="upload">Uploaded by hand</option>
                  </select>
                </div>
              )}
              {form.kind === 'url' && (
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 140px', gap: 10 }}>
                  <div className="field"><label>Guide URL</label>
                    <input className="inp" value={form.url} onChange={e => setForm({ ...form, url: e.target.value })} placeholder="https://provider.example/guide.xml.gz" style={{ fontFamily: 'ui-monospace,monospace', fontSize: 'var(--fs-sm)' }} />
                  </div>
                  <div className="field"><label>Refresh every</label>
                    <select className="inp" value={form.refreshHours} onChange={e => setForm({ ...form, refreshHours: +e.target.value })}>
                      {[1, 3, 6, 12, 24, 48, 168].map(h => <option key={h} value={h}>{h === 168 ? 'week' : h === 1 ? 'hour' : `${h} hours`}</option>)}
                    </select>
                  </div>
                </div>
              )}
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 140px', gap: 10 }}>
                <div className="field"><label>Times with no offset are in</label>
                  <select className="inp" value={form.fallbackTz} onChange={e => setForm({ ...form, fallbackTz: e.target.value })}>
                    <option value="">Each channel's own time zone</option>
                    {zones().map(z => <option key={z} value={z}>{z}</option>)}
                  </select>
                </div>
                <div className="field"><label>Keep past days</label>
                  <input className="inp" type="number" min={0} max={365} value={form.keepPastDays} onChange={e => setForm({ ...form, keepPastDays: Math.max(0, Math.min(365, +e.target.value || 0)) })} />
                </div>
              </div>
              <label style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 'var(--fs-sm)', color: 'var(--muted)' }}>
                <input type="checkbox" checked={form.autoMap} onChange={e => setForm({ ...form, autoMap: e.target.checked })} />
                Map channels automatically when the match is unambiguous (same XMLTV id, or exactly one channel with the same name)
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
                      {s.kind === 'url' ? <><span style={{ fontFamily: 'ui-monospace,monospace' }}>{s.url}</span> · every {s.refreshHours} h · next {fmt(s.nextRunAt)}</> : 'Uploaded files'}
                    </div>
                    <div className="hintxt" style={{ marginTop: 2 }}>
                      Last run {fmt(s.lastRunAt)}{last ? ` · ${summary(last.counts)}` : ''} · {s.mapped ?? 0} channel{s.mapped === 1 ? '' : 's'} mapped
                      {(s.unmapped ?? 0) > 0 && <span style={{ color: 'var(--warn)' }}> · {s.unmapped} waiting to be mapped</span>}
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
                      ? <button className="btn" disabled={!!busy[s.id] || s.running} onClick={() => run(s)}>Import now</button>
                      : <button className="btn" disabled={!!busy[s.id] || s.running} onClick={() => { uploadFor.current = s.id; fileRef.current?.click() }}>Upload file</button>}
                    <button className="btn ghost" onClick={() => togglePanel(s.id, 'channels')}>Channels</button>
                    <button className="btn ghost" onClick={() => togglePanel(s.id, 'runs')}>Runs</button>
                    <button className="btn ghost" onClick={() => setForm({ id: s.id, name: s.name, kind: s.kind, url: s.url ?? '', refreshHours: s.refreshHours ?? 24, fallbackTz: s.fallbackTz ?? '', keepPastDays: s.keepPastDays, autoMap: s.autoMap })}>Edit</button>
                    <button className="btn ghost" onClick={() => remove(s)}>Remove</button>
                  </div>
                </div>

                {panel[s.id] === 'channels' && (
                  <div style={{ borderTop: '1px solid var(--border)', padding: '10px 14px' }}>
                    {!aliases[s.id] ? <div className="loading">Loading…</div> : aliases[s.id].length === 0 ? (
                      <div className="hintxt">No channels yet: they appear here after the first run.</div>
                    ) : (
                      <table>
                        <thead><tr><th>Their channel</th><th>Programmes</th><th>Volt channel</th></tr></thead>
                        <tbody>
                          {aliases[s.id].map(a => (
                            <tr key={a.id}>
                              <td>
                                <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                                  {a.icon && <img src={a.icon} alt="" style={{ width: 28, height: 20, objectFit: 'contain', flex: 'none' }} onError={e => { (e.currentTarget as HTMLImageElement).style.display = 'none' }} />}
                                  <div style={{ minWidth: 0 }}>
                                    <div style={{ fontWeight: 600 }}>{a.displayName ?? a.externalId}</div>
                                    <div className="hintxt" style={{ marginTop: 0, fontFamily: 'ui-monospace,monospace' }}>{a.externalId}</div>
                                  </div>
                                </div>
                              </td>
                              <td style={{ color: 'var(--muted)' }}>{a.channelId ? a.lastProgrammes : '–'}</td>
                              <td style={{ minWidth: 220 }}>
                                <select className="inp" value={a.channelId ?? ''} onChange={e => map(s.id, a, e.target.value || null)}>
                                  <option value="">Not mapped (skipped)</option>
                                  {channels.map(c => <option key={c.id} value={c.id}>{c.name}{c.medium === 'radio' ? ' (radio)' : ''}</option>)}
                                </select>
                                {a.mappedBy && <div className="hintxt" style={{ marginTop: 2 }}>{MAPPED_BY[a.mappedBy] ?? a.mappedBy}</div>}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    )}
                    <div className="hintxt" style={{ marginTop: 8 }}>Changes apply on the next run. Moving a channel takes this source's programmes that have not aired yet off the old channel.</div>
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
