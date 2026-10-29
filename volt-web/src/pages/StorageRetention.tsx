import { useEffect, useMemo, useState } from 'react'
import { apiRequest as req } from '../api'
import { Notice } from '../notices'

/* ============================================================================
   Storage > Retention list and Recently removed. docs/RETENTION.md.

   RETENTION LIST: every recording still holding media, ordered by the date it
   will be deleted: a date set by hand, else the rule's delete stage from when the
   recording ended. Change the date (earlier or later), go back to the rule, or keep
   it (a hold, which retention never touches). A recording retention has already
   pruned to what clips use shows "kept for clips" and has no date.

   RECENTLY REMOVED: the restore bin. What retention, the cleanup script and library
   deletes removed, restorable until the bin purges it.
   Server: volt-app/src/modules/storage.ts.
   ========================================================================== */

interface Expiring {
  id: string; title: string | null; owner: string | null; startMs: number; endMs: number | null; recording: boolean
  bytes: number; clips: number; held: boolean; keptForClips: string | null
  expiresAt: string | null; expirySource: 'manual' | 'rule' | 'legacy' | 'none' | 'kept_for_clips'
  rule: { name: string; deleteAfterDays: number | null } | null; manual: { at: string; by: string; note: string | null } | null
}
interface BinRow {
  id: string; kind: 'recording_media' | 'vod_asset' | 'media_file'; label: string; reason: string | null; bytes: number; files: number; images: number; rows: number
  state: 'held' | 'restored' | 'purged'; purgeAfter: string; createdAt: string; createdBy: string | null; restoredAt: string | null; restoredBy: string | null
}

const J = (b: unknown) => ({ body: JSON.stringify(b), headers: { 'content-type': 'application/json' } })
const size = (n: number) => n >= 1e9 ? `${(n / 1e9).toFixed(1)} GB` : n >= 1e6 ? `${Math.round(n / 1e6)} MB` : n > 0 ? `${Math.max(1, Math.round(n / 1e3))} KB` : '0'
const dateTime = (v: string | number) => new Date(v).toLocaleString([], { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })
const dayOnly = (v: string | number) => new Date(v).toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' })
function rel(iso: string | null): { text: string; tone: 'over' | 'soon' | 'later' | 'none' } {
  if (!iso) return { text: '', tone: 'none' }
  const d = (new Date(iso).getTime() - Date.now()) / 86_400_000
  if (d < 0) return { text: 'due now, at the next sweep', tone: 'over' }
  if (d < 1) return { text: `in ${Math.max(1, Math.round(d * 24))} h`, tone: 'soon' }
  return { text: `in ${Math.round(d)} day${Math.round(d) === 1 ? '' : 's'}`, tone: d < 3 ? 'soon' : 'later' }
}
const len = (a: number, b: number | null) => {
  if (b == null) return 'recording now'
  const m = Math.round((b - a) / 60000)
  return m >= 60 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${m} min`
}
const toLocalInput = (iso: string | null) => {
  const d = iso ? new Date(iso) : new Date(Date.now() + 7 * 86_400_000)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`
}

export function RetentionList() {
  const [items, setItems] = useState<Expiring[] | null>(null)
  const [within, setWithin] = useState<number | null>(30)
  const [q, setQ] = useState('')
  const [edit, setEdit] = useState<{ id: string; at: string; note: string } | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [err, setErr] = useState('')
  const load = () => req('/storage/expiring').then((r: any) => { setItems(r.items); setErr('') }).catch((e: any) => setErr(e.message))
  useEffect(() => { load() }, [])
  const run = async (id: string, fn: () => Promise<unknown>) => {
    setBusy(id); setErr('')
    try { await fn(); setEdit(null); await load() } catch (e: any) { setErr(e.message) } finally { setBusy(null) }
  }
  const shown = useMemo(() => (items ?? []).filter((x) =>
    (!within || (x.expiresAt && new Date(x.expiresAt).getTime() < Date.now() + within * 86_400_000)) &&
    (!q || `${x.owner ?? ''} ${x.title ?? ''}`.toLowerCase().includes(q.toLowerCase()))), [items, within, q])
  const total = shown.reduce((a, x) => a + (x.expiresAt ? x.bytes : 0), 0)

  return (
    <div className="card" style={{ marginBottom: 16 }}>
      <div style={{ padding: '14px 14px 0' }}>
        <div className="sec-label" style={{ marginTop: 0 }}>Retention list</div>
        <div style={{ color: 'var(--muted)', fontSize: 'var(--fs-sm)', marginBottom: 10 }}>
          Recordings in the order they will be deleted. What clips were cut from is kept when the rest goes, and anything deleted
          can be restored from Recently removed for a few days.
        </div>
        <div className="flex flex-wrap items-center gap-2" style={{ marginBottom: 10 }}>
          <div className="chipset">
            {[7, 30, 90].map((d) => <button key={d} className={`selchip ${within === d ? 'sel' : ''}`} onClick={() => setWithin(d)}>Next {d} days</button>)}
            <button className={`selchip ${within === null ? 'sel' : ''}`} onClick={() => setWithin(null)}>Everything</button>
          </div>
          <input className="inp" style={{ width: 240 }} placeholder="Channel, event or title" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Filter recordings" />
          <div className="flex-1" />
          {items && <span style={{ color: 'var(--faint)', fontSize: 'var(--fs-sm)' }}>{shown.filter((x) => x.expiresAt).length} to be deleted, {size(total)}</span>}
        </div>
        {err && <div style={{ marginBottom: 10 }}><Notice kind="error" variant="compact" message={err} /></div>}
      </div>
      {!items ? <div className="loading">Loading…</div> : (
        <table>
          <thead><tr><th>Deleted</th><th>Recording</th><th>Size</th><th>Clips</th><th>Date from</th><th /></tr></thead>
          <tbody>
            {shown.map((x) => {
              const r = rel(x.expiresAt)
              return (
                <tr key={x.id}>
                  <td style={{ whiteSpace: 'nowrap' }}>
                    {x.expiresAt ? <>
                      <div>{dayOnly(x.expiresAt)}</div>
                      <div style={{ fontSize: 'var(--fs-sm)', color: r.tone === 'over' ? 'var(--danger,#f87171)' : r.tone === 'soon' ? 'var(--warn,#fbbf24)' : 'var(--faint)' }}>{r.text}</div>
                    </> : <span style={{ color: 'var(--faint)' }}>{x.expirySource === 'kept_for_clips' ? 'Kept for clips' : 'Never'}</span>}
                    {x.held && <div style={{ fontSize: 'var(--fs-sm)', color: 'var(--warn,#fbbf24)' }}>On hold</div>}
                  </td>
                  <td>
                    <div style={{ fontWeight: 600 }}>{x.owner ?? 'Recording'}{x.title && x.title !== x.owner ? <span style={{ color: 'var(--muted)', fontWeight: 400 }}> · {x.title}</span> : null}</div>
                    <div style={{ color: 'var(--faint)', fontSize: 'var(--fs-sm)' }}>{dateTime(x.startMs)} · {len(x.startMs, x.endMs)}</div>
                  </td>
                  <td style={{ color: 'var(--muted)' }}>{size(x.bytes)}</td>
                  <td style={{ color: 'var(--muted)', fontSize: 'var(--fs-sm)' }}>
                    {x.clips ? `${x.clips} clip${x.clips === 1 ? '' : 's'}` : '–'}
                    {x.keptForClips && <div style={{ color: 'var(--faint)' }}>{x.keptForClips}</div>}
                  </td>
                  <td style={{ fontSize: 'var(--fs-sm)', color: 'var(--muted)' }}>
                    {x.expirySource === 'manual' ? <>Set by {x.manual?.by}{x.manual?.note ? <div style={{ color: 'var(--faint)' }}>{x.manual.note}</div> : null}</>
                      : x.expirySource === 'rule' ? `Rule "${x.rule?.name}", ${x.rule?.deleteAfterDays} days after it ended`
                      : x.expirySource === 'legacy' ? 'Expiry set when it was recorded'
                      : x.expirySource === 'kept_for_clips' ? 'The rest was removed by retention'
                      : 'No rule deletes it'}
                  </td>
                  <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                    {edit?.id === x.id ? (
                      <div style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
                        <input className="inp" type="datetime-local" value={edit.at} onChange={(e) => setEdit({ ...edit, at: e.target.value })} aria-label="Delete on" />
                        <input className="inp" style={{ width: 150 }} placeholder="Why (optional)" value={edit.note} onChange={(e) => setEdit({ ...edit, note: e.target.value })} aria-label="Reason" />
                        <button className="btn primary sm" disabled={busy === x.id || !edit.at}
                          onClick={() => run(x.id, () => req(`/storage/recordings/${x.id}/expiry`, { method: 'PATCH', ...J({ deleteAfter: new Date(edit.at).toISOString(), note: edit.note || undefined }) }))}>Save</button>
                        <button className="btn ghost sm" onClick={() => setEdit(null)}>Cancel</button>
                      </div>
                    ) : <>
                      {!x.recording && <button className="btn ghost sm" onClick={() => setEdit({ id: x.id, at: toLocalInput(x.expiresAt), note: '' })}>Change date</button>}
                      {x.expirySource === 'manual' && <button className="btn ghost sm" disabled={busy === x.id}
                        onClick={() => run(x.id, () => req(`/storage/recordings/${x.id}/expiry`, { method: 'PATCH', ...J({ deleteAfter: null }) }))}>Use the rule</button>}
                      <button className="btn ghost sm" disabled={busy === x.id}
                        onClick={() => run(x.id, () => req(`/storage/recordings/${x.id}/hold`, { method: 'POST', ...J(x.held ? { hold: false } : { hold: true, reason: 'kept from the retention list' }) }))}>
                        {x.held ? 'Release' : 'Keep'}</button>
                    </>}
                  </td>
                </tr>
              )
            })}
            {shown.length === 0 && <tr><td colSpan={6} style={{ color: 'var(--faint)' }}>Nothing is due to be deleted {within ? `in the next ${within} days` : ''}.</td></tr>}
          </tbody>
        </table>
      )}
    </div>
  )
}

export function RestoreBin() {
  const [items, setItems] = useState<BinRow[] | null>(null)
  const [days, setDays] = useState(7)
  const [busy, setBusy] = useState<string | null>(null)
  const [err, setErr] = useState('')
  const [done, setDone] = useState('')
  const load = () => req('/storage/bin').then((r: any) => { setItems(r.items); setDays(r.days); setErr('') }).catch((e: any) => setErr(e.message))
  useEffect(() => { load() }, [])
  const run = async (id: string, fn: () => Promise<any>, msg: (r: any) => string) => {
    setBusy(id); setErr(''); setDone('')
    try { const r = await fn(); setDone(msg(r)); await load() } catch (e: any) { setErr(e.message) } finally { setBusy(null) }
  }
  const held = (items ?? []).filter((i) => i.state === 'held')
  return (
    <div className="card" style={{ marginBottom: 16 }}>
      <div style={{ padding: '14px 14px 0' }}>
        <div className="sec-label" style={{ marginTop: 0 }}>Recently removed</div>
        <div style={{ color: 'var(--muted)', fontSize: 'var(--fs-sm)', marginBottom: 10 }}>
          What retention and deletes removed stays here for {days} days, then it is gone for good. Restoring puts the files, images and
          records back; a restored recording is put on hold so retention does not take it again until you set a date.
          {held.length > 0 && ` ${held.length} item${held.length === 1 ? '' : 's'}, ${size(held.reduce((a, i) => a + i.bytes, 0))}.`}
        </div>
        {err && <div style={{ marginBottom: 10 }}><Notice kind="error" variant="compact" message={err} /></div>}
        {done && <div style={{ marginBottom: 10 }}><Notice kind="ok" variant="compact" message={done} /></div>}
      </div>
      {!items ? <div className="loading">Loading…</div> : (
        <table>
          <thead><tr><th>Removed</th><th>What</th><th>Why</th><th>Size</th><th>Gone for good</th><th /></tr></thead>
          <tbody>
            {items.map((i) => (
              <tr key={i.id} style={i.state !== 'held' ? { opacity: .55 } : undefined}>
                <td style={{ whiteSpace: 'nowrap' }}>{dateTime(i.createdAt)}</td>
                <td>
                  <div style={{ fontWeight: 600 }}>{i.label}</div>
                  <div style={{ color: 'var(--faint)', fontSize: 'var(--fs-sm)' }}>{i.kind === 'vod_asset' ? 'Media Library asset' : i.kind === 'media_file' ? 'Image Library image' : 'Recorded media'}
                    {` · ${i.files} file${i.files === 1 ? '' : 's'}`}{i.images ? ` · ${i.images} image${i.images === 1 ? '' : 's'}` : ''}</div>
                </td>
                <td style={{ fontSize: 'var(--fs-sm)', color: 'var(--muted)' }}>{i.reason}{i.createdBy ? <div style={{ color: 'var(--faint)' }}>{i.createdBy}</div> : null}</td>
                <td style={{ color: 'var(--muted)' }}>{size(i.bytes)}</td>
                <td style={{ fontSize: 'var(--fs-sm)', whiteSpace: 'nowrap' }}>
                  {i.state === 'held' ? <>{dayOnly(i.purgeAfter)}<div style={{ color: 'var(--faint)' }}>{rel(i.purgeAfter).text}</div></>
                    : i.state === 'restored' ? <span style={{ color: 'var(--ok,#4ade80)' }}>Restored{i.restoredBy ? ` by ${i.restoredBy}` : ''}</span>
                    : <span style={{ color: 'var(--faint)' }}>Purged</span>}
                </td>
                <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                  {i.state === 'held' && <>
                    <button className="btn primary sm" disabled={busy === i.id}
                      onClick={() => run(i.id, () => req(`/storage/bin/${i.id}/restore`, { method: 'POST', ...J({}) }),
                        (r) => `Restored ${i.label}: ${r.files} file${r.files === 1 ? '' : 's'}${r.images ? `, ${r.images} image${r.images === 1 ? '' : 's'}` : ''}${r.skipped ? ` (${r.skipped} already back in place, left as they were)` : ''}.`)}>Restore</button>
                    <button className="btn ghost sm" disabled={busy === i.id}
                      onClick={() => window.confirm(`Delete "${i.label}" for good now? This cannot be undone.`)
                        && run(i.id, () => req(`/storage/bin/${i.id}`, { method: 'DELETE' }), () => `${i.label} deleted for good.`)}>Delete now</button>
                  </>}
                </td>
              </tr>
            ))}
            {items.length === 0 && <tr><td colSpan={6} style={{ color: 'var(--faint)' }}>Nothing has been removed recently.</td></tr>}
          </tbody>
        </table>
      )}
    </div>
  )
}
