// ============================================================================
//  REMOVE A CHANNEL OR STATION, ONE OR MANY (administrators).
//
//  Deleting a channel takes its recordings, clips, guide and schedules with it
//  (the database cascades), so before anything goes the dialog shows exactly
//  what will, refuses up front when the channel is live or its encoder is
//  still running, and asks for the name to be typed (one) or "remove N"
//  (several). In bulk, the ones that cannot go are listed and skipped. The server checks all of
//  this again, and the attempt (done or refused) is in the audit log.
// ============================================================================
import { useEffect, useMemo, useState } from 'react'
import { api, type DeleteImpact } from './api'
import { runBulk } from './listActions'
import { FormStatus, Notice } from './notices'

const plural = (n: number, one: string, many = one + 's') => `${n} ${n === 1 ? one : many}`

export default function DeleteChannelDialog({ id, onClose, onDeleted }: { id: string; onClose: () => void; onDeleted: (name: string) => void }) {
  const [impact, setImpact] = useState<DeleteImpact | null>(null)
  const [typed, setTyped] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')

  useEffect(() => {
    api.channelDeleteImpact(id).then(setImpact).catch((e: any) =>
      setErr(e?.forbidden ? 'Only administrators can remove channels and stations.' : (e?.message || 'Could not check what this would remove')))
  }, [id])

  const what = impact?.kind === 'radio' ? 'station' : 'channel'
  const matches = !!impact && typed.trim() === impact.name.trim()

  async function go() {
    if (!impact || !matches || impact.blocker) return
    setBusy(true); setErr('')
    try { await api.deleteChannel(id); onDeleted(impact.name) }
    catch (e: any) {
      setErr(e?.forbidden ? 'Only administrators can remove channels and stations.' : (e?.message || 'The removal failed'))
      // the state may have moved on (someone started it): show the current blocker
      api.channelDeleteImpact(id).then(setImpact).catch(() => {})
    } finally { setBusy(false) }
  }

  const c = impact?.counts
  const lines = c ? [
    c.recordings ? plural(c.recordings, 'recording') : null,
    c.clips ? `${plural(c.clips, 'clip')}${c.published_clips ? ` (${c.published_clips} published or scheduled to publish)` : ''}` : null,
    c.programmes ? plural(c.programmes, 'guide programme') : null,
    c.scheduled_clips ? plural(c.scheduled_clips, 'scheduled clip') : null,
    c.sources ? plural(c.sources, 'source') : null,
  ].filter(Boolean) as string[] : []

  return (
    // Plain click handlers, not pressable(): the dialog holds a text input, and
    // a button role on its parents would turn Space into "close" while typing.
    <div className="drawer-scrim" onClick={e => { if (e.target === e.currentTarget && !busy) onClose() }} style={{ alignItems: 'center', justifyContent: 'center' }}>
      <div className="card" role="dialog" aria-modal="true" aria-labelledby="delch-t"
        onKeyDown={e => { if (e.key === 'Escape' && !busy) onClose() }}
        style={{ width: 460, maxWidth: 'calc(100vw - 32px)', padding: 20 }}>
        <h3 id="delch-t" style={{ margin: '0 0 8px' }}>Remove {impact ? `${what} ${impact.name}` : what}?</h3>
        {!impact && !err && <div className="loading">Checking what this would remove…</div>}
        {impact && (
          <>
            <p style={{ color: 'var(--muted)', fontSize: 'var(--fs-body)', margin: '0 0 10px' }}>
              In group <b>{impact.group}</b>. This cannot be undone.
              {lines.length ? <> These go with it:</> : <> Nothing else is attached to it.</>}
            </p>
            {lines.length > 0 && (
              <ul style={{ margin: '0 0 12px', paddingLeft: 18, fontSize: 'var(--fs-body)' }}>
                {lines.map(l => <li key={l}>{l}</li>)}
              </ul>
            )}
            {impact.blocker ? null : (
              <div className="field" style={{ marginBottom: 0 }}>
                <label htmlFor="delch-name">Type <b>{impact.name}</b> to confirm</label>
                <input id="delch-name" className="inp" autoFocus value={typed} onChange={e => setTyped(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter') go() }} autoComplete="off" spellCheck={false} />
              </div>
            )}
            <p style={{ color: 'var(--faint)', fontSize: 'var(--fs-sm)', margin: '10px 0 0' }}>The removal is recorded in the audit log with your name.</p>
          </>
        )}
        {/* FORM status in the footer (notices.tsx): the failure, else why Remove is unavailable */}
        <div className="modal-f">
          <FormStatus error={err} blocked={impact?.blocker} />
          <button className="btn ghost" onClick={onClose} disabled={busy}>Cancel</button>
          <button className="btn primary danger" disabled={busy || !matches || !!impact?.blocker} onClick={go}>
            {busy ? 'Removing…' : `Remove ${what}`}
          </button>
        </div>
      </div>
    </div>
  )
}

type Counts = DeleteImpact['counts']
const ZERO: Counts = { recordings: 0, clips: 0, published_clips: 0, programmes: 0, scheduled_clips: 0, sources: 0 }

/** What `counts` adds up to, as list lines. */
function countLines(c: Counts): string[] {
  return [
    c.recordings ? plural(c.recordings, 'recording') : null,
    c.clips ? `${plural(c.clips, 'clip')}${c.published_clips ? ` (${c.published_clips} published or scheduled to publish)` : ''}` : null,
    c.programmes ? plural(c.programmes, 'guide programme') : null,
    c.scheduled_clips ? plural(c.scheduled_clips, 'scheduled clip') : null,
    c.sources ? plural(c.sources, 'source') : null,
  ].filter(Boolean) as string[]
}

/**
 * BULK REMOVE. Checks every selected channel first: what each takes with it
 * (added up), and which cannot go now (live, encoder running) and will be
 * skipped. Confirming takes typing "remove N", N being how many will go, so
 * the number is read, not clicked past. Each removal is its own request, and
 * its own audit row.
 */
export function BulkRemoveDialog({ rows, what, onClose, onDone }: {
  rows: { id: string; name: string }[]; what: 'channel' | 'station'
  onClose: () => void; onDone: (summary: string) => void
}) {
  const [impacts, setImpacts] = useState<Record<string, DeleteImpact | { error: string }>>({})
  const [typed, setTyped] = useState('')
  const [progress, setProgress] = useState<number | null>(null)
  const [result, setResult] = useState<{ ok: number; failed: { name: string; reason: string }[] } | null>(null)

  useEffect(() => {
    let gone = false
    runBulk(rows, async r => {
      try { const i = await api.channelDeleteImpact(r.id); if (!gone) setImpacts(m => ({ ...m, [r.id]: i })) }
      catch (e: any) { if (!gone) setImpacts(m => ({ ...m, [r.id]: { error: e?.forbidden ? 'not permitted' : (e?.message || 'could not be checked') } })) }
    }, undefined, 6)
    return () => { gone = true }
    // eslint-disable-next-line
  }, [])

  const checked = rows.every(r => impacts[r.id])
  const { go, skip, total } = useMemo(() => {
    const go: { id: string; name: string }[] = []; const skip: { name: string; why: string }[] = []
    const total: Counts = { ...ZERO }
    for (const r of rows) {
      const i = impacts[r.id]
      if (!i) continue
      if ('error' in i) { skip.push({ name: r.name, why: i.error }); continue }
      if (i.blocker) { skip.push({ name: i.name, why: i.blocker }); continue }
      go.push({ id: r.id, name: i.name })
      for (const k of Object.keys(total) as (keyof Counts)[]) total[k] += i.counts[k] ?? 0
    }
    return { go, skip, total }
  }, [rows, impacts])

  const phrase = `remove ${go.length}`
  const matches = typed.trim().toLowerCase() === phrase
  const busy = progress !== null && !result
  const nouns = what === 'station' ? ['station', 'stations'] : ['channel', 'channels']
  const noun = (n: number) => (n === 1 ? nouns[0] : nouns[1])

  async function run() {
    if (!matches || !go.length || busy) return
    setProgress(0)
    const res = await runBulk(go, r => api.deleteChannel(r.id), d => setProgress(d))
    setResult({ ok: res.ok.length, failed: res.failed.map(f => ({ name: f.row.name, reason: f.reason })) })
  }
  const finish = () => {
    if (!result) return onClose()
    const parts = [`Removed ${result.ok} ${noun(result.ok)}.`]
    for (const f of result.failed.slice(0, 5)) parts.push(`${f.name}: ${f.reason}.`)
    if (skip.length) parts.push(`Skipped ${skip.length} that could not be removed now.`)
    onDone(parts.join(' '))
  }
  const lines = countLines(total)

  return (
    <div className="drawer-scrim" onClick={e => { if (e.target === e.currentTarget && !busy) finish() }} style={{ alignItems: 'center', justifyContent: 'center' }}>
      <div className="card" role="dialog" aria-modal="true" aria-labelledby="bulkrm-t"
        onKeyDown={e => { if (e.key === 'Escape' && !busy) finish() }}
        style={{ width: 520, maxWidth: 'calc(100vw - 32px)', maxHeight: 'calc(100vh - 48px)', overflow: 'auto', padding: 20 }}>
        <h3 id="bulkrm-t" style={{ margin: '0 0 8px' }}>{result ? 'Removal finished' : `Remove ${rows.length} ${noun(rows.length)}?`}</h3>
        {!checked && !result && <div className="loading">Checking what this would remove… {Object.keys(impacts).length} of {rows.length}</div>}
        {checked && !result && (
          <>
            {go.length > 0 ? (
              <>
                <p style={{ color: 'var(--muted)', fontSize: 'var(--fs-body)', margin: '0 0 6px' }}>
                  These {go.length} {noun(go.length)} will be removed. This cannot be undone.
                </p>
                <ul className="bulk-list">{go.map(r => <li key={r.id}>{r.name}</li>)}</ul>
                <p style={{ color: 'var(--muted)', fontSize: 'var(--fs-body)', margin: '10px 0 6px' }}>
                  {lines.length ? 'Together they take with them:' : 'Nothing else is attached to them.'}
                </p>
                {lines.length > 0 && <ul style={{ margin: '0 0 10px', paddingLeft: 18, fontSize: 'var(--fs-body)' }}>{lines.map(l => <li key={l}>{l}</li>)}</ul>}
              </>
            ) : null}
            {skip.length > 0 && (
              <Notice kind="warn" variant="compact" title={`${skip.length} will be skipped.`}>
                <ul className="bulk-list" style={{ marginTop: 4 }}>{skip.map(s => <li key={s.name}>{s.name}: {s.why}</li>)}</ul>
              </Notice>
            )}
            {go.length > 0 && (
              <div className="field" style={{ margin: '12px 0 0' }}>
                <label htmlFor="bulkrm-name">Type <b>{phrase}</b> to confirm</label>
                <input id="bulkrm-name" className="inp" autoFocus value={typed} onChange={e => setTyped(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter') run() }} autoComplete="off" spellCheck={false} />
              </div>
            )}
            <p style={{ color: 'var(--faint)', fontSize: 'var(--fs-sm)', margin: '10px 0 0' }}>Each removal is recorded in the audit log with your name.</p>
          </>
        )}
        {busy && <div className="loading" role="status">Removing… {progress} of {go.length}</div>}
        {result && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <Notice kind={result.failed.length ? 'warn' : 'ok'} variant="compact"
              message={`Removed ${result.ok} ${noun(result.ok)}.${skip.length ? ` Skipped ${skip.length}.` : ''}`} />
            {result.failed.length > 0 && (
              <Notice kind="error" variant="compact" title={`${result.failed.length} failed.`}>
                <ul className="bulk-list" style={{ marginTop: 4 }}>{result.failed.map(f => <li key={f.name}>{f.name}: {f.reason}</li>)}</ul>
              </Notice>
            )}
          </div>
        )}
        <div className="modal-f">
          <FormStatus blocked={checked && !result && !go.length ? `None of the selected ${noun(rows.length)} can be removed right now.` : null} />
          {result ? <button className="btn primary" onClick={finish} autoFocus>Done</button> : (
            <>
              <button className="btn ghost" onClick={onClose} disabled={busy}>Cancel</button>
              <button className="btn primary danger" disabled={busy || !checked || !matches || !go.length} onClick={run}>
                {busy ? 'Removing…' : `Remove ${go.length} ${noun(go.length)}`}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
